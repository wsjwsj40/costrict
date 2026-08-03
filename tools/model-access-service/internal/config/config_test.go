package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAppliesEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	err := os.WriteFile(path, []byte(`
database:
  password: file-password
jwtSettings:
  enable: true
  jwksUrl: http://jwks
admin:
  token: file-token
gateway:
  permissionUrl: http://file-gateway/permissions
  token: file-gateway-token
  completionModel: file-completion
`), 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_PASSWORD", "env-password")
	t.Setenv("JWT_EMAIL_FIELD", "properties.email")
	t.Setenv("MODEL_GATEWAY_PERMISSION_URL", "http://env-gateway/permissions")
	t.Setenv("MODEL_GATEWAY_TOKEN", "env-gateway-token")
	t.Setenv("MODEL_GATEWAY_COMPLETION_MODEL", "env-completion")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Database.Password != "env-password" {
		t.Fatalf("unexpected database password")
	}
	if len(cfg.JWT.EmailField) != 2 || cfg.JWT.EmailField[1] != "email" {
		t.Fatalf("unexpected email field: %#v", cfg.JWT.EmailField)
	}
	if cfg.Gateway.PermissionURL != "http://env-gateway/permissions" || cfg.Gateway.CompletionModel != "env-completion" {
		t.Fatalf("unexpected gateway config: %#v", cfg.Gateway)
	}
}
