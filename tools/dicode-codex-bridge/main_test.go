package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
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
