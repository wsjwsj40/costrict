package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponsesAuthorizationAndStreaming(t *testing.T) {
	modelCalls, upstreamCalls := 0, 0
	models := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		modelCalls++
		if r.Header.Get("Authorization") != "Bearer valid" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "allowed"}}})
	}))
	defer models.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if r.Header.Get("Authorization") != "Bearer valid" {
			t.Error("bearer token not forwarded")
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
	s, err := newServer(models.URL, upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		token, model string
		want         int
	}{
		{"", "allowed", 401}, {"Bearer invalid", "allowed", 401}, {"Bearer valid", "denied", 403}, {"Bearer valid", "allowed", 200},
	} {
		request := httptest.NewRequest(http.MethodPost, "/codex/v1/responses", strings.NewReader(`{"model":"`+tc.model+`","stream":true}`))
		if tc.token != "" {
			request.Header.Set("Authorization", tc.token)
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
	if modelCalls != 3 || upstreamCalls != 1 {
		t.Errorf("calls: model=%d upstream=%d", modelCalls, upstreamCalls)
	}
}
