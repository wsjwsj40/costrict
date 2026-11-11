package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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

	"github.com/redis/go-redis/v9"
)

const maxRequestBytes = 16 << 20
const maxLoggedErrorBytes = 4096
const maxEventLineBytes = 8192

type server struct {
	modelsURL    string
	responsesURL string
	tokens       gatewayTokens
	client       *http.Client
}

type gatewayTokens interface {
	Authorization(context.Context, string) (string, error)
}

func newServer(modelsURL, responsesURL string, tokens gatewayTokens) (*server, error) {
	for _, raw := range []string{modelsURL, responsesURL} {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("invalid upstream URL: %q", raw)
		}
	}
	if tokens == nil {
		return nil, errors.New("gateway token provider is required")
	}
	return &server{modelsURL: modelsURL, responsesURL: responsesURL, tokens: tokens,
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
	// model-access has already validated the JWT signature and expiration.
	email, err := emailFromVerifiedJWT(auth)
	if err != nil {
		http.Error(w, "verified token has no user email", http.StatusUnauthorized)
		return
	}
	gatewayAuth, err := s.tokens.Authorization(r.Context(), email)
	if err != nil {
		log.Printf("gateway token exchange failed for user: %v", err)
		http.Error(w, "gateway token unavailable", http.StatusBadGateway)
		return
	}
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.responsesURL, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "invalid upstream", http.StatusInternalServerError)
		return
	}
	upstream.Header.Set("Authorization", gatewayAuth)
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "text/event-stream")
	upstream.Header.Set("originator", "codex_cli_rs")
	for _, header := range []string{"session-id", "thread-id"} {
		value := r.Header.Get(header)
		if value == "" {
			value = r.Header.Get(strings.ReplaceAll(header, "-", "_"))
		}
		if value == "" {
			value, err = randomUUID()
			if err != nil {
				http.Error(w, "could not create request ID", http.StatusInternalServerError)
				return
			}
		}
		upstream.Header.Set(header, value)
	}
	if id := r.Header.Get("X-Request-Id"); id != "" {
		upstream.Header.Set("X-Request-Id", id)
	}
	log.Printf("responses request: session=%q thread=%q request=%q %s", upstream.Header.Get("session-id"), upstream.Header.Get("thread-id"), upstream.Header.Get("X-Request-Id"), responsesRequestSummary(body))
	response, err := s.client.Do(upstream)
	if err != nil {
		log.Printf("responses upstream failed: %v", err)
		http.Error(w, "responses upstream unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	responseContext := fmt.Sprintf("session=%q thread=%q request=%q upstream_request=%q", upstream.Header.Get("session-id"), upstream.Header.Get("thread-id"), upstream.Header.Get("X-Request-Id"), response.Header.Get("X-Request-Id"))
	log.Printf("gateway_response: %s status=%d content_type=%q", responseContext, response.StatusCode, response.Header.Get("Content-Type"))
	for _, key := range []string{"Content-Type", "Cache-Control", "X-Request-Id"} {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	buffer := make([]byte, 32*1024)
	events := newGatewayEventLogger(responseContext)
	var errorBody []byte
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			events.write(buffer[:n])
			if response.StatusCode >= http.StatusBadRequest && len(errorBody) < maxLoggedErrorBytes {
				remaining := maxLoggedErrorBytes - len(errorBody)
				errorBody = append(errorBody, buffer[:min(n, remaining)]...)
			}
			if _, err := w.Write(buffer[:n]); err != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			events.finish()
			if response.StatusCode >= http.StatusBadRequest && !events.loggedError {
				log.Printf("gateway_error: %s status=%d detail=%q", responseContext, response.StatusCode, gatewayErrorDetail(errorBody))
			}
			if readErr != io.EOF {
				log.Printf("gateway_stream_error: %s error=%q", responseContext, readErr)
			}
			return
		}
	}
}

type gatewayEventLogger struct {
	context     string
	pending     []byte
	event       string
	data        []byte
	dropping    bool
	loggedError bool
}

func newGatewayEventLogger(context string) *gatewayEventLogger {
	return &gatewayEventLogger{context: context}
}

func (l *gatewayEventLogger) write(chunk []byte) {
	for len(chunk) > 0 {
		end := bytes.IndexByte(chunk, '\n')
		if end < 0 {
			if !l.dropping && len(l.pending)+len(chunk) <= maxEventLineBytes {
				l.pending = append(l.pending, chunk...)
			} else {
				l.pending = nil
				l.dropping = true
			}
			return
		}
		if !l.dropping && len(l.pending)+end <= maxEventLineBytes {
			l.pending = append(l.pending, chunk[:end]...)
			l.line(bytes.TrimSuffix(l.pending, []byte{'\r'}))
		}
		l.pending = nil
		l.dropping = false
		chunk = chunk[end+1:]
	}
}

func (l *gatewayEventLogger) line(line []byte) {
	if len(line) == 0 {
		l.finishEvent()
		return
	}
	if bytes.HasPrefix(line, []byte("event:")) {
		l.event = strings.TrimSpace(string(line[len("event:"):]))
	} else if bytes.HasPrefix(line, []byte("data:")) && len(l.data) < maxLoggedErrorBytes {
		value := bytes.TrimSpace(line[len("data:"):])
		remaining := maxLoggedErrorBytes - len(l.data)
		l.data = append(l.data, value[:min(len(value), remaining)]...)
	}
}

func (l *gatewayEventLogger) finishEvent() {
	if l.event == "error" || l.event == "response.failed" || l.event == "response.incomplete" {
		log.Printf("gateway_error: %s event=%q detail=%q", l.context, l.event, gatewayErrorDetail(l.data))
		l.loggedError = true
	}
	l.event = ""
	l.data = nil
}

func (l *gatewayEventLogger) finish() {
	if len(l.pending) > 0 && !l.dropping {
		l.line(bytes.TrimSuffix(l.pending, []byte{'\r'}))
	}
	l.finishEvent()
}

func gatewayErrorDetail(body []byte) string {
	var envelope struct {
		Error    json.RawMessage `json:"error"`
		Message  string          `json:"message"`
		Response struct {
			Status string          `json:"status"`
			Error  json.RawMessage `json:"error"`
		} `json:"response"`
	}
	if json.Unmarshal(body, &envelope) == nil {
		raw := envelope.Error
		if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
			raw = envelope.Response.Error
		}
		if len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
			var detail struct {
				Type    string          `json:"type"`
				Code    json.RawMessage `json:"code"`
				Message string          `json:"message"`
			}
			if json.Unmarshal(raw, &detail) == nil {
				return limitErrorDetail(fmt.Sprintf("type=%q code=%s message=%q", detail.Type, detail.Code, detail.Message))
			}
			var message string
			if json.Unmarshal(raw, &message) == nil {
				return limitErrorDetail(message)
			}
		}
		if envelope.Message != "" {
			return limitErrorDetail(envelope.Message)
		}
		if envelope.Response.Status != "" {
			return limitErrorDetail("response.status=" + envelope.Response.Status)
		}
	}
	if len(body) == 0 {
		return "empty error body"
	}
	return limitErrorDetail(string(body))
}

func limitErrorDetail(value string) string {
	value = strings.ToValidUTF8(value, "�")
	if len(value) > 1024 {
		value = value[:1024] + "…"
	}
	return value
}

// responsesRequestSummary records the request shape without user text, tool
// arguments, bearer tokens, or the full model instructions.
func responsesRequestSummary(body []byte) string {
	var request struct {
		Model             string            `json:"model"`
		Stream            bool              `json:"stream"`
		ParallelToolCalls bool              `json:"parallel_tool_calls"`
		ToolChoice        json.RawMessage   `json:"tool_choice"`
		Input             []json.RawMessage `json:"input"`
		Tools             []struct {
			Type string `json:"type"`
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return `{"error":"could not parse request summary"}`
	}
	input := make([]map[string]any, 0, len(request.Input))
	for index, raw := range request.Input {
		var item struct {
			Role    string          `json:"role"`
			Type    string          `json:"type"`
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(raw, &item) != nil {
			continue
		}
		entry := map[string]any{"index": index, "role": item.Role, "type": item.Type}
		if item.Role == "developer" || item.Role == "system" {
			var parts []struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(item.Content, &parts) == nil {
				var content strings.Builder
				for _, part := range parts {
					content.WriteString(part.Text)
				}
				text := content.String()
				entry["text_bytes"] = len(text)
				entry["sha256"] = fmt.Sprintf("%x", sha256.Sum256([]byte(text)))
				entry["codex_prompt"] = strings.HasPrefix(text, "You are Codex")
				entry["dicode_identity"] = strings.Contains(text, "你是 DiCode")
			}
		}
		input = append(input, entry)
	}
	tools := make([]map[string]string, 0, len(request.Tools))
	for _, tool := range request.Tools {
		tools = append(tools, map[string]string{"type": tool.Type, "name": tool.Name})
	}
	summary, _ := json.Marshal(map[string]any{
		"model": request.Model, "stream": request.Stream, "parallel_tool_calls": request.ParallelToolCalls,
		"tool_choice": request.ToolChoice, "input": input, "tools": tools, "body_bytes": len(body),
	})
	return string(summary)
}

func emailFromVerifiedJWT(auth string) (string, error) {
	parts := strings.Split(strings.TrimSpace(auth[7:]), ".")
	if len(parts) != 3 {
		return "", errors.New("invalid JWT format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("invalid JWT payload")
	}
	var claims struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", errors.New("invalid JWT claims")
	}
	email := strings.ToLower(strings.TrimSpace(claims.Email))
	if email == "" || !strings.Contains(email, "@") {
		return "", errors.New("email claim is missing")
	}
	return email, nil
}

func randomUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
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
	tokenURL := os.Getenv("TOKEN_EXCHANGE_URL")
	openToken := os.Getenv("TOKEN_EXCHANGE_OPEN_TOKEN")
	if modelsURL == "" || responsesURL == "" || tokenURL == "" || openToken == "" {
		log.Fatal("MODEL_ACCESS_URL, GATEWAY_RESPONSES_URL, TOKEN_EXCHANGE_URL, and TOKEN_EXCHANGE_OPEN_TOKEN are required")
	}
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "redis:6379"
	}
	cache := &redisTokenCache{client: redis.NewClient(&redis.Options{Addr: redisAddr, Password: os.Getenv("REDIS_PASSWORD")})}
	defer cache.client.Close()
	tokens, err := newTokenService(tokenURL, openToken, cache)
	if err != nil {
		log.Fatal(err)
	}
	s, err := newServer(modelsURL, responsesURL, tokens)
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
