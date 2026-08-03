package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/costrict/model-access-service/internal/config"
)

func TestUpdateModelsAddsCompletionModelAndToken(t *testing.T) {
	var got struct {
		Key    string `json:"key"`
		Models string `json:"models"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if value := r.Header.Get("NEW-OPEN-TOKEN"); value != "gateway-secret" {
			t.Errorf("NEW-OPEN-TOKEN = %q", value)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "message": "ok"})
	}))
	defer server.Close()

	cfg := config.Config{}
	cfg.Gateway.PermissionURL = server.URL
	cfg.Gateway.Token = "gateway-secret"
	cfg.Gateway.CompletionModel = "completion-model"
	client := New(cfg)
	if err := client.UpdateModels(context.Background(), " User@Example.com ", []string{"chat-model", "completion-model"}); err != nil {
		t.Fatal(err)
	}
	if got.Key != "user@example.com" || got.Models != "chat-model,completion-model" {
		t.Fatalf("unexpected payload: %#v", got)
	}
}

func TestUpdateModelsRejectsUnsuccessfulGatewayResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "denied"})
	}))
	defer server.Close()
	cfg := config.Config{}
	cfg.Gateway.PermissionURL = server.URL
	if err := New(cfg).UpdateModels(context.Background(), "user@example.com", nil); err == nil {
		t.Fatal("expected gateway rejection")
	}
}
