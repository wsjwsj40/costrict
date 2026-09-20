package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"

	"github.com/costrict/model-access-service/internal/config"
)

type Authenticator struct {
	keyfunc    keyfunc.Keyfunc
	emailField []string
	issuer     string
	audience   string
}

func New(ctx context.Context, cfg config.Config) (*Authenticator, error) {
	k, err := keyfunc.NewDefaultCtx(ctx, []string{cfg.JWT.JWKSURL})
	if err != nil {
		return nil, fmt.Errorf("initialize JWKS: %w", err)
	}
	return &Authenticator{
		keyfunc: k, emailField: cfg.JWT.EmailField,
		issuer: cfg.JWT.Issuer, audience: cfg.JWT.Audience,
	}, nil
}

func (a *Authenticator) Email(r *http.Request) (string, error) {
	raw := bearer(r.Header.Get("Authorization"))
	if raw == "" {
		return "", errors.New("missing bearer token")
	}

	options := []jwt.ParserOption{jwt.WithExpirationRequired()}
	if a.issuer != "" {
		options = append(options, jwt.WithIssuer(a.issuer))
	}
	if a.audience != "" {
		options = append(options, jwt.WithAudience(a.audience))
	}
	token, err := jwt.Parse(raw, a.keyfunc.Keyfunc, options...)
	if err != nil || !token.Valid {
		return "", errors.New("invalid token")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("invalid token claims")
	}
	value := nestedClaim(claims, a.emailField)
	email, ok := value.(string)
	email = strings.ToLower(strings.TrimSpace(email))
	if !ok || email == "" || !strings.Contains(email, "@") {
		return "", errors.New("email claim is missing")
	}
	return email, nil
}

func bearer(header string) string {
	const prefix = "Bearer "
	if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

func nestedClaim(claims jwt.MapClaims, path []string) any {
	var value any = map[string]any(claims)
	for _, key := range path {
		record, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = record[key]
	}
	return value
}
