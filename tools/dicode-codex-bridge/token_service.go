package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const tokenCacheKey = "chat_rag:new_token_auth"
const tokenCacheTTL = time.Hour

type tokenCache interface {
	Get(context.Context, string, string) (string, error)
	Set(context.Context, string, string, string, time.Duration) error
}

type redisTokenCache struct{ client *redis.Client }

func (c *redisTokenCache) Get(ctx context.Context, key, email string) (string, error) {
	token, err := c.client.HGet(ctx, key, email).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return token, err
}

func (c *redisTokenCache) Set(ctx context.Context, key, email, token string, ttl time.Duration) error {
	pipe := c.client.Pipeline()
	pipe.HSet(ctx, key, email, token)
	pipe.Expire(ctx, key, ttl)
	_, err := pipe.Exec(ctx)
	return err
}

type tokenService struct {
	endpoint  string
	openToken string
	cache     tokenCache
	client    *http.Client
}

func newTokenService(endpoint, openToken string, cache tokenCache) (*tokenService, error) {
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("invalid TOKEN_EXCHANGE_URL")
	}
	if strings.TrimSpace(openToken) == "" {
		return nil, errors.New("TOKEN_EXCHANGE_OPEN_TOKEN is required")
	}
	return &tokenService{endpoint: endpoint, openToken: strings.TrimSpace(openToken), cache: cache,
		client: &http.Client{Timeout: 3 * time.Second}}, nil
}

func (s *tokenService) Authorization(ctx context.Context, email string) (string, error) {
	if s.cache != nil {
		cached, err := s.cache.Get(ctx, tokenCacheKey, email)
		if err != nil {
			log.Printf("gateway token cache read failed: %v", err)
		} else if strings.TrimSpace(cached) != "" {
			return formatGatewayAuthorization(cached), nil
		}
	}
	token, err := s.fetch(ctx, email)
	if err != nil {
		return "", err
	}
	if s.cache != nil {
		if err := s.cache.Set(ctx, tokenCacheKey, email, token, tokenCacheTTL); err != nil {
			log.Printf("gateway token cache write failed: %v", err)
		}
	}
	return formatGatewayAuthorization(token), nil
}

func (s *tokenService) fetch(ctx context.Context, email string) (string, error) {
	body, _ := json.Marshal(map[string]string{"key": email})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("NEW-OPEN-TOKEN", s.openToken)
	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("token exchange request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("token exchange returned HTTP %d", resp.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", err
	}
	token := extractGatewayToken(payload)
	if token == "" {
		return "", errors.New("token exchange response has no token")
	}
	return token, nil
}

func extractGatewayToken(payload []byte) string {
	var value any
	if err := json.Unmarshal(payload, &value); err != nil {
		return strings.Trim(strings.TrimSpace(string(payload)), `"`)
	}
	return findGatewayToken(value)
}

func findGatewayToken(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case map[string]any:
		for _, key := range []string{"key", "token", "newToken", "new_token", "openToken", "open_token", "accessToken", "access_token", "authorization", "Authorization"} {
			if token, ok := v[key].(string); ok && strings.TrimSpace(token) != "" {
				return strings.TrimSpace(token)
			}
		}
		for _, key := range []string{"data", "result"} {
			if nested, ok := v[key]; ok {
				if token := findGatewayToken(nested); token != "" {
					return token
				}
			}
		}
	}
	return ""
}

func formatGatewayAuthorization(token string) string {
	token = strings.TrimSpace(token)
	if strings.Contains(token, " ") {
		return token
	}
	return "Bearer " + token
}
