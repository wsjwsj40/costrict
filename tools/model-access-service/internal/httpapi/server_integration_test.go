package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/costrict/model-access-service/internal/auth"
	"github.com/costrict/model-access-service/internal/config"
	"github.com/costrict/model-access-service/internal/store"
)

func TestModelListUsesEmailPlanAndNeverReturnsAuto(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	data, err := store.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	migration, err := os.ReadFile(filepath.Join("..", "..", "migrations", "001_init.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := data.Migrate(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	for _, model := range []store.Model{
		{ID: "free-model", Enabled: true, PublicInfo: map[string]any{"name": "Free Model"}},
		{ID: "pro-model", Enabled: true, PublicInfo: map[string]any{"name": "Pro Model"}},
	} {
		if err := data.UpsertModel(ctx, model); err != nil {
			t.Fatal(err)
		}
	}
	if err := data.SetPlanModels(ctx, "free", []string{"free-model"}); err != nil {
		t.Fatal(err)
	}
	if err := data.SetPlanModels(ctx, "pro", []string{"free-model", "pro-model"}); err != nil {
		t.Fatal(err)
	}
	if err := data.SetUserPlan(ctx, "pro@example.com", "pro"); err != nil {
		t.Fatal(err)
	}

	authenticator, sign := integrationAuthenticator(t)
	server := httptest.NewServer(New(data, authenticator, "admin-secret").Handler())
	defer server.Close()

	for _, test := range []struct {
		email string
		want  []string
	}{
		{email: "new@example.com", want: []string{"free-model"}},
		{email: "pro@example.com", want: []string{"free-model", "pro-model"}},
	} {
		request, _ := http.NewRequest(http.MethodGet, server.URL+"/ai-gateway/api/v1/models", nil)
		request.Header.Set("Authorization", "Bearer "+sign(test.email))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			response.Body.Close()
			t.Fatal(err)
		}
		response.Body.Close()
		got := make([]string, 0, len(body.Data))
		for _, model := range body.Data {
			got = append(got, model["id"].(string))
		}
		if len(got) != len(test.want) {
			t.Fatalf("%s got %v, want %v", test.email, got, test.want)
		}
		for index := range got {
			if got[index] != test.want[index] {
				t.Fatalf("%s got %v, want %v", test.email, got, test.want)
			}
		}
	}
}

func TestAdminBatchUsersCanSetAndDeletePlans(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	data, err := store.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	migration, err := os.ReadFile(filepath.Join("..", "..", "migrations", "001_init.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := data.Migrate(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}

	emails := []string{"batch-one@example.com", "batch-two@example.com"}
	_, _ = data.DeleteUsers(ctx, emails)
	t.Cleanup(func() { _, _ = data.DeleteUsers(context.Background(), emails) })

	server := httptest.NewServer(New(data, nil, "admin-secret").Handler())
	defer server.Close()

	request, _ := http.NewRequest(
		http.MethodPost,
		server.URL+"/admin/api/users/batch",
		strings.NewReader(`{"action":"set","emails":["BATCH-ONE@example.com","batch-two@example.com","batch-one@example.com"],"planCode":"plus"}`),
	)
	request.Header.Set("Authorization", "Bearer admin-secret")
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("set status = %d", response.StatusCode)
	}
	var result struct {
		Count int `json:"count"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Count != 2 {
		t.Fatalf("set count = %d, want 2", result.Count)
	}

	adminState, err := data.AdminState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, user := range adminState.Users {
		if (user.Email == emails[0] || user.Email == emails[1]) && user.PlanCode == "plus" {
			found++
		}
	}
	if found != 2 {
		t.Fatalf("found %d batch users in plus, want 2", found)
	}
	if len(adminState.SyncTasks) == 0 || adminState.SyncTasks[0].TotalCount != 2 {
		t.Fatalf("expected a two-user sync task, got %#v", adminState.SyncTasks)
	}

	request, _ = http.NewRequest(
		http.MethodPost,
		server.URL+"/admin/api/users/batch",
		strings.NewReader(`{"action":"delete","emails":["batch-one@example.com","batch-two@example.com"]}`),
	)
	request.Header.Set("Authorization", "Bearer admin-secret")
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("delete status = %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Count != 2 {
		t.Fatalf("delete count = %d, want 2", result.Count)
	}
}

func integrationAuthenticator(t *testing.T) (*auth.Authenticator, func(string) string) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const keyID = "integration-key"
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": keyID, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes()),
		}}})
	}))
	t.Cleanup(jwksServer.Close)
	cfg := config.Config{}
	cfg.JWT.JWKSURL = jwksServer.URL
	cfg.JWT.EmailField = []string{"email"}
	authenticator, err := auth.New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	return authenticator, func(email string) string {
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"email": email,
			"exp":   time.Now().Add(time.Hour).Unix(),
		})
		token.Header["kid"] = keyID
		raw, err := token.SignedString(privateKey)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
}
