package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

type fakeGatewayTokens struct{ emails []string }

func (f *fakeGatewayTokens) Authorization(_ context.Context, email string) (string, error) {
	f.emails = append(f.emails, email)
	return "Bearer gateway-secret", nil
}

func testJWT(email string) string {
	payload, _ := json.Marshal(map[string]string{"email": email})
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func TestResponsesAuthorizationAndStreaming(t *testing.T) {
	modelCalls, upstreamCalls := 0, 0
	validJWT := testJWT(" USER@example.com ")
	noEmailJWT := testJWT("")
	models := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		modelCalls++
		if r.Header.Get("Authorization") != "Bearer "+validJWT && r.Header.Get("Authorization") != "Bearer "+noEmailJWT {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "allowed"}}})
	}))
	defer models.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if r.Header.Get("Authorization") != "Bearer gateway-secret" {
			t.Error("gateway token was not used")
		}
		if r.Header.Get("originator") != "codex_cli_rs" || r.Header.Get("Accept") != "text/event-stream" {
			t.Error("gateway headers missing")
		}
		if upstreamCalls == 1 {
			if r.Header.Get("session-id") != "client-session" || r.Header.Get("thread-id") != "client-thread" {
				t.Error("client IDs not forwarded")
			}
		} else {
			uuid := regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
			if !uuid.MatchString(r.Header.Get("session-id")) || !uuid.MatchString(r.Header.Get("thread-id")) {
				t.Error("fallback UUID headers missing")
			}
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"model":"allowed"`) {
			t.Error("request body not forwarded")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.created\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "event: response.completed\ndata: {}\n\n")
	}))
	defer upstream.Close()
	tokens := &fakeGatewayTokens{}
	s, err := newServer(models.URL, upstream.URL, tokens)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		token, model, sessionID, threadID string
		want                              int
	}{
		{"", "allowed", "", "", 401},
		{"Bearer invalid", "allowed", "", "", 401},
		{"Bearer " + validJWT, "denied", "", "", 403},
		{"Bearer " + noEmailJWT, "allowed", "", "", 401},
		{"Bearer " + validJWT, "allowed", "client-session", "client-thread", 200},
		{"Bearer " + validJWT, "allowed", "", "", 200},
	} {
		request := httptest.NewRequest(http.MethodPost, "/codex/v1/responses", strings.NewReader(`{"model":"`+tc.model+`","stream":true}`))
		if tc.token != "" {
			request.Header.Set("Authorization", tc.token)
		}
		if tc.sessionID != "" {
			request.Header.Set("session-id", tc.sessionID)
			request.Header.Set("thread-id", tc.threadID)
		}
		response := httptest.NewRecorder()
		s.handler().ServeHTTP(response, request)
		if response.Code != tc.want {
			t.Errorf("%q/%q: got %d, want %d", tc.token, tc.model, response.Code, tc.want)
		}
		if tc.want == 200 && (!strings.Contains(response.Body.String(), "response.created") || !strings.Contains(response.Body.String(), "response.completed")) {
			t.Error("stream events missing")
		}
	}
	if modelCalls != 5 || upstreamCalls != 2 {
		t.Errorf("calls: model=%d upstream=%d", modelCalls, upstreamCalls)
	}
	if len(tokens.emails) != 2 || tokens.emails[0] != "user@example.com" || tokens.emails[1] != "user@example.com" {
		t.Errorf("unexpected verified user emails: %v", tokens.emails)
	}
}

func TestRequiresTokenProvider(t *testing.T) {
	if _, err := newServer("https://example.com/models", "https://example.com/responses", nil); err == nil {
		t.Fatal("missing token provider was accepted")
	}
}

func TestResponsesRequestSummaryHidesContent(t *testing.T) {
	const native = "You are Codex, native instructions"
	const identity = "你是 DiCode"
	body := []byte(`{"model":"dicode-model","stream":true,"tool_choice":"auto","input":[{"role":"developer","type":"message","content":[{"type":"input_text","text":"You are Codex, native instructions"}]},{"role":"developer","type":"message","content":[{"type":"input_text","text":"你是 DiCode"}]},{"role":"user","type":"message","content":[{"type":"input_text","text":"private user request"}]}],"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"update_plan"}]}`)
	summary := responsesRequestSummary(body)
	if strings.Contains(summary, native) || strings.Contains(summary, identity) || strings.Contains(summary, "private user request") {
		t.Fatalf("request content leaked into diagnostic: %s", summary)
	}
	var parsed struct {
		Model string `json:"model"`
		Input []struct {
			SHA256         string `json:"sha256"`
			CodexPrompt    bool   `json:"codex_prompt"`
			DiCodeIdentity bool   `json:"dicode_identity"`
		} `json:"input"`
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal([]byte(summary), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Model != "dicode-model" || len(parsed.Input) != 3 || len(parsed.Tools) != 2 || parsed.Tools[0].Name != "apply_patch" {
		t.Fatalf("request shape missing: %s", summary)
	}
	if parsed.Input[0].SHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(native))) || !parsed.Input[0].CodexPrompt || !parsed.Input[1].DiCodeIdentity || parsed.Input[2].SHA256 != "" {
		t.Fatalf("instruction diagnostics incorrect: %s", summary)
	}
}

func TestGatewayErrorsAreLoggedWithoutChangingResponse(t *testing.T) {
	validJWT := testJWT("user@example.com")
	models := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":[{"id":"allowed"}]}`)
	}))
	defer models.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Request-Id", "upstream-request")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error","code":"quota_exceeded","message":"limit reached"}}`)
	}))
	defer upstream.Close()
	s, err := newServer(models.URL, upstream.URL, &fakeGatewayTokens{})
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previous)
	request := httptest.NewRequest(http.MethodPost, "/codex/v1/responses", strings.NewReader(`{"model":"allowed","stream":true}`))
	request.Header.Set("Authorization", "Bearer "+validJWT)
	request.Header.Set("session-id", "session-1")
	request.Header.Set("thread-id", "thread-1")
	response := httptest.NewRecorder()
	s.handler().ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), "limit reached") || response.Header().Get("X-Request-Id") != "upstream-request" {
		t.Fatalf("upstream error was not forwarded: status=%d body=%q", response.Code, response.Body.String())
	}
	for _, expected := range []string{"responses request:", "gateway_response:", "status=429", "gateway_error:", "quota_exceeded", "limit reached", "upstream-request"} {
		if !strings.Contains(logs.String(), expected) {
			t.Errorf("missing %q in logs: %s", expected, logs.String())
		}
	}
}

func TestGatewaySSEErrorAcrossChunks(t *testing.T) {
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previous)
	logger := newGatewayEventLogger(`session="s" thread="t"`)
	logger.write([]byte("event: response.failed\ndata: {\"response\":{\"error\":{\"code\":\"bad_tool\","))
	logger.write([]byte("\"message\":\"invalid patch\"}}}\n\n"))
	logger.finish()
	if !logger.loggedError || !strings.Contains(logs.String(), "bad_tool") || !strings.Contains(logs.String(), "invalid patch") {
		t.Fatalf("SSE error not logged: %s", logs.String())
	}
	if strings.Count(logs.String(), "gateway_error:") != 1 {
		t.Fatalf("SSE error logged more than once: %s", logs.String())
	}
}
