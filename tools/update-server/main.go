package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type releaseConfig struct {
	Version        string `json:"version"`
	MinimumVersion string `json:"minimumVersion,omitempty"`
	Mandatory      bool   `json:"mandatory,omitempty"`
	ReleaseNotes   string `json:"releaseNotes,omitempty"`
	PublishedAt    string `json:"publishedAt,omitempty"`
	VSIXPath       string `json:"vsixPath"`
}

type updateManifest struct {
	Version        string `json:"version"`
	MinimumVersion string `json:"minimumVersion,omitempty"`
	Mandatory      bool   `json:"mandatory,omitempty"`
	ReleaseNotes   string `json:"releaseNotes,omitempty"`
	SHA256         string `json:"sha256"`
	PublishedAt    string `json:"publishedAt,omitempty"`
}

type cachedRelease struct {
	configModTime time.Time
	vsixModTime   time.Time
	vsixSize      int64
	config        releaseConfig
	manifest      updateManifest
}

type releaseStore struct {
	configPath  string
	releasesDir string
	mu          sync.Mutex
	cached      *cachedRelease
}

func (s *releaseStore) load() (*cachedRelease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	configInfo, err := os.Stat(s.configPath)
	if err != nil {
		return nil, fmt.Errorf("stat release config: %w", err)
	}

	configBytes, err := os.ReadFile(s.configPath)
	if err != nil {
		return nil, fmt.Errorf("read release config: %w", err)
	}
	var cfg releaseConfig
	if err := json.Unmarshal(configBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse release config: %w", err)
	}
	if err := validateConfig(cfg); err != nil {
		return nil, err
	}

	if !filepath.IsAbs(cfg.VSIXPath) {
		cfg.VSIXPath = filepath.Join(s.releasesDir, cfg.VSIXPath)
	}
	cfg.VSIXPath = filepath.Clean(cfg.VSIXPath)
	vsixInfo, err := os.Stat(cfg.VSIXPath)
	if err != nil {
		return nil, fmt.Errorf("stat VSIX: %w", err)
	}
	if !vsixInfo.Mode().IsRegular() {
		return nil, errors.New("VSIX path must point to a regular file")
	}

	if s.cached != nil &&
		s.cached.configModTime.Equal(configInfo.ModTime()) &&
		s.cached.vsixModTime.Equal(vsixInfo.ModTime()) &&
		s.cached.vsixSize == vsixInfo.Size() {
		return s.cached, nil
	}

	checksum, err := fileSHA256(cfg.VSIXPath)
	if err != nil {
		return nil, err
	}
	manifest := updateManifest{
		Version:        cfg.Version,
		MinimumVersion: cfg.MinimumVersion,
		Mandatory:      cfg.Mandatory,
		ReleaseNotes:   cfg.ReleaseNotes,
		SHA256:         checksum,
		PublishedAt:    cfg.PublishedAt,
	}
	s.cached = &cachedRelease{
		configModTime: configInfo.ModTime(),
		vsixModTime:   vsixInfo.ModTime(),
		vsixSize:      vsixInfo.Size(),
		config:        cfg,
		manifest:      manifest,
	}
	log.Printf("loaded release version=%s file=%s sha256=%s", cfg.Version, filepath.Base(cfg.VSIXPath), checksum)
	return s.cached, nil
}

func validateConfig(cfg releaseConfig) error {
	if strings.TrimSpace(cfg.Version) == "" {
		return errors.New("version is required")
	}
	if strings.TrimSpace(cfg.VSIXPath) == "" {
		return errors.New("vsixPath is required")
	}
	if cfg.PublishedAt != "" {
		if _, err := time.Parse(time.RFC3339, cfg.PublishedAt); err != nil {
			return errors.New("publishedAt must be an RFC3339 timestamp")
		}
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open VSIX: %w", err)
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := file.WriteTo(hash); err != nil {
		return "", fmt.Errorf("hash VSIX: %w", err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (s *releaseStore) latestHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	release, err := s.load()
	if err != nil {
		log.Printf("latest release unavailable: %v", err)
		http.Error(w, "release unavailable", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	if err := json.NewEncoder(w).Encode(release.manifest); err != nil {
		log.Printf("write manifest: %v", err)
	}
}

func (s *releaseStore) downloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	release, err := s.load()
	if err != nil {
		log.Printf("download unavailable: %v", err)
		http.Error(w, "release unavailable", http.StatusServiceUnavailable)
		return
	}

	filename := filepath.Base(release.config.VSIXPath)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, release.config.VSIXPath)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func newHandler(store *releaseStore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/releases/latest", store.latestHandler)
	mux.HandleFunc("/api/v1/releases/latest/download", store.downloadHandler)
	mux.HandleFunc("/healthz", healthHandler)
	return mux
}

func main() {
	defaultAddr := os.Getenv("UPDATE_SERVER_ADDR")
	if defaultAddr == "" {
		defaultAddr = ":8080"
	}
	configDir := os.Getenv("UPDATE_SERVER_CONFIG_DIR")
	if configDir == "" {
		configDir = "/config"
	}
	releasesDir := os.Getenv("UPDATE_SERVER_RELEASES_DIR")
	if releasesDir == "" {
		releasesDir = "/releases"
	}
	defaultConfig := os.Getenv("UPDATE_SERVER_CONFIG")
	if defaultConfig == "" {
		defaultConfig = filepath.Join(configDir, "release.json")
	}

	addr := flag.String("addr", defaultAddr, "HTTP listen address")
	configPath := flag.String("config", defaultConfig, "release configuration file")
	releasesPath := flag.String("releases", releasesDir, "directory containing VSIX release files")
	flag.Parse()

	store := &releaseStore{configPath: *configPath, releasesDir: *releasesPath}
	if _, err := store.load(); err != nil {
		log.Fatalf("invalid initial release: %v", err)
	}

	server := &http.Server{
		Addr:              *addr,
		Handler:           newHandler(store),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("DiCode update server listening on %s", *addr)
	log.Fatal(server.ListenAndServe())
}
