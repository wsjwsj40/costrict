package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/costrict/model-access-service/internal/config"
)

type Client struct {
	url             string
	token           string
	completionModel string
	httpClient      *http.Client
}

func New(cfg config.Config) *Client {
	timeout := time.Duration(cfg.Gateway.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{
		url:             strings.TrimSpace(cfg.Gateway.PermissionURL),
		token:           strings.TrimSpace(cfg.Gateway.Token),
		completionModel: strings.TrimSpace(cfg.Gateway.CompletionModel),
		httpClient:      &http.Client{Timeout: timeout},
	}
}

func (c *Client) UpdateModels(ctx context.Context, email string, modelIDs []string) error {
	if c.url == "" {
		return nil
	}
	models := appendUnique(modelIDs, c.completionModel)
	payload, err := json.Marshal(map[string]string{
		"key":    strings.ToLower(strings.TrimSpace(email)),
		"models": strings.Join(models, ","),
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("NEW-OPEN-TOKEN", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request gateway: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("gateway returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var result struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("decode gateway response: %w", err)
	}
	if !result.Success {
		return fmt.Errorf("gateway rejected update: %s", result.Message)
	}
	return nil
}

func appendUnique(modelIDs []string, required string) []string {
	seen := make(map[string]struct{}, len(modelIDs)+1)
	result := make([]string, 0, len(modelIDs)+1)
	for _, raw := range append(append([]string(nil), modelIDs...), required) {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		key := strings.ToLower(id)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, id)
	}
	return result
}
