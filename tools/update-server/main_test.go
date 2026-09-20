package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *releaseStore {
	t.Helper()
	dir := t.TempDir()
	vsixPath := filepath.Join(dir, "dicode-3.1.0.vsix")
	if err := os.WriteFile(vsixPath, []byte("test-vsix"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := `{
		"version": "3.1.0",
		"minimumVersion": "3.0.0",
		"releaseNotes": "Test release",
		"vsixPath": "dicode-3.1.0.vsix"
	}`
	configPath := filepath.Join(dir, "release.json")
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	return &releaseStore{configPath: configPath, releasesDir: dir}
}

func TestLatestManifest(t *testing.T) {
	response := httptest.NewRecorder()
	newHandler(newTestStore(t)).ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/api/v1/releases/latest", nil),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}

	var manifest updateManifest
	if err := json.NewDecoder(response.Body).Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != "3.1.0" {
		t.Fatalf("version = %q", manifest.Version)
	}
	if len(manifest.SHA256) != 64 {
		t.Fatalf("sha256 = %q", manifest.SHA256)
	}
}

func TestLatestVSIXCanBeDownloaded(t *testing.T) {
	handler := newHandler(newTestStore(t))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/releases/latest/download", nil))
	if response.Code != http.StatusOK || response.Body.String() != "test-vsix" {
		t.Fatalf("response status=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Disposition") != `attachment; filename="dicode-3.1.0.vsix"` {
		t.Fatalf("content disposition = %q", response.Header().Get("Content-Disposition"))
	}
}

func TestRejectsMissingVSIXPath(t *testing.T) {
	err := validateConfig(releaseConfig{Version: "3.1.0"})
	if err == nil || !strings.Contains(err.Error(), "vsixPath") {
		t.Fatalf("error = %v", err)
	}
}
