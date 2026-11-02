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
	"os"
	"strings"
	"time"
)

const maxRequestBytes = 16 << 20

type server struct {
	modelsURL    string
	responsesURL string
	client       *http.Client
}

func newServer(modelsURL, responsesURL string) (*server, error) {
	for _, raw := range []string{modelsURL, responsesURL} {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("invalid upstream URL: %q", raw)
		}
	}
	return &server{modelsURL: modelsURL, responsesURL: responsesURL,
		client: &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConnsPerHost: 32, ResponseHeaderTimeout: 180 * time.Second}}}, nil
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	mux.HandleFunc("POST /codex/v1/responses", s.responses)
	return mux
}

func (s *server) responses(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(auth), "bearer ") || strings.TrimSpace(auth[7:]) == "" {
		http.Error(w, "missing bearer token", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		http.Error(w, "invalid request body", http.StatusRequestEntityTooLarge)
		return
	}
	var request struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &request); err != nil || strings.TrimSpace(request.Model) == "" {
		http.Error(w, "model is required", http.StatusBadRequest)
		return
	}
	allowed, status, err := s.allowedModel(r.Context(), auth, request.Model)
	if err != nil {
		http.Error(w, "model authorization unavailable", status)
		return
	}
	if !allowed {
		http.Error(w, "model is not available for this user", http.StatusForbidden)
		return
	}
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.responsesURL, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "invalid upstream", http.StatusInternalServerError)
		return
	}
	upstream.Header.Set("Authorization", auth)
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "text/event-stream")
	if id := r.Header.Get("X-Request-Id"); id != "" {
		upstream.Header.Set("X-Request-Id", id)
	}
	response, err := s.client.Do(upstream)
	if err != nil {
		log.Printf("responses upstream failed: %v", err)
		http.Error(w, "responses upstream unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	for _, key := range []string{"Content-Type", "Cache-Control", "X-Request-Id"} {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			if _, err := w.Write(buffer[:n]); err != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}

func (s *server) allowedModel(ctx context.Context, auth, model string) (bool, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.modelsURL, nil)
	if err != nil {
		return false, http.StatusBadGateway, err
	}
	request.Header.Set("Authorization", auth)
	response, err := s.client.Do(request)
	if err != nil {
		return false, http.StatusBadGateway, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return false, http.StatusUnauthorized, errors.New("invalid token")
	}
	if response.StatusCode != http.StatusOK {
		return false, http.StatusBadGateway, fmt.Errorf("models returned %d", response.StatusCode)
	}
	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&result); err != nil {
		return false, http.StatusBadGateway, err
	}
	for _, item := range result.Data {
		if item.ID == model {
			return true, 0, nil
		}
	}
	return false, 0, nil
}

func main() {
	modelsURL := os.Getenv("MODEL_ACCESS_URL")
	responsesURL := os.Getenv("GATEWAY_RESPONSES_URL")
	if modelsURL == "" || responsesURL == "" {
		log.Fatal("MODEL_ACCESS_URL and GATEWAY_RESPONSES_URL are required")
	}
	s, err := newServer(modelsURL, responsesURL)
	if err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, s.handler()))
}
