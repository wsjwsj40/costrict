package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/costrict/model-access-service/internal/config"
)

func TestEmailVerifiesJWTAndReadsNestedClaim(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyID := "test-key"
	jwks := map[string]any{"keys": []map[string]any{{
		"kty": "RSA",
		"kid": keyID,
		"use": "sig",
		"alg": "RS256",
		"n":   base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes()),
	}}}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	defer jwksServer.Close()

	cfg := config.Config{}
	cfg.JWT.JWKSURL = jwksServer.URL
	cfg.JWT.EmailField = []string{"properties", "email"}
	authenticator, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}

	claims := jwt.MapClaims{
		"exp": time.Now().Add(time.Hour).Unix(),
		"properties": map[string]any{
			"email": "User@Example.com",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = keyID
	signed, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer "+signed)
	email, err := authenticator.Email(request)
	if err != nil {
		t.Fatal(err)
	}
	if email != "user@example.com" {
		t.Fatalf("got %q, want user@example.com", email)
	}
}

func TestEmailRejectsUnsignedToken(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": "real-key", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes()),
		}}})
	}))
	defer jwksServer.Close()

	cfg := config.Config{}
	cfg.JWT.JWKSURL = jwksServer.URL
	cfg.JWT.EmailField = []string{"email"}
	authenticator, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}

	token := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"email": "admin@example.com",
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	token.Header["kid"] = "real-key"
	raw, err := token.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer "+raw)
	if _, err := authenticator.Email(request); err == nil {
		t.Fatal("expected unsigned token to be rejected")
	}
}
