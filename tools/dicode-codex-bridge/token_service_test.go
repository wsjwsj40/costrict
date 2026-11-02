package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type memoryTokenCache struct {
	values map[string]string
	ttl    time.Duration
}

func (c *memoryTokenCache) Get(_ context.Context, key, email string) (string, error) {
	return c.values[key+":"+email], nil
}

func (c *memoryTokenCache) Set(_ context.Context, key, email, token string, ttl time.Duration) error {
	c.values[key+":"+email] = token
	c.ttl = ttl
	return nil
}

func TestTokenServiceUsesSharedCacheAndPerUserExchange(t *testing.T) {
	cache := &memoryTokenCache{values: map[string]string{tokenCacheKey + ":alice@example.com": "cached-alice-key"}}
	requests := 0
	exchange := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.Header.Get("NEW-OPEN-TOKEN") != "exchange-secret" {
			t.Error("token exchange request missing authentication")
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["key"] != "bob@example.com" {
			t.Errorf("token exchange used wrong email: %v, %v", body, err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"token": "bob-key"}})
	}))
	defer exchange.Close()
	svc, err := newTokenService(exchange.URL, "exchange-secret", cache)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ email, want string }{
		{"alice@example.com", "Bearer cached-alice-key"},
		{"bob@example.com", "Bearer bob-key"},
		{"bob@example.com", "Bearer bob-key"},
	} {
		got, err := svc.Authorization(context.Background(), tc.email)
		if err != nil || got != tc.want {
			t.Errorf("%s: got %q, %v", tc.email, got, err)
		}
	}
	if requests != 1 || cache.ttl != time.Hour {
		t.Errorf("exchange requests=%d, cache TTL=%s", requests, cache.ttl)
	}
}
