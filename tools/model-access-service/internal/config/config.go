package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server struct {
		Host string `yaml:"host"`
		Port int    `yaml:"port"`
	} `yaml:"server"`
	Database struct {
		Host     string `yaml:"host"`
		Port     int    `yaml:"port"`
		User     string `yaml:"user"`
		Password string `yaml:"password"`
		Database string `yaml:"database"`
		SSLMode  string `yaml:"sslMode"`
	} `yaml:"database"`
	JWT struct {
		Enable     bool     `yaml:"enable"`
		JWKSURL    string   `yaml:"jwksUrl"`
		EmailField []string `yaml:"emailField"`
		Issuer     string   `yaml:"issuer"`
		Audience   string   `yaml:"audience"`
	} `yaml:"jwtSettings"`
	Admin struct {
		Token string `yaml:"token"`
	} `yaml:"admin"`
	Models struct {
		BootstrapFile string `yaml:"bootstrapFile"`
	} `yaml:"models"`
}

func Load(path string) (Config, error) {
	cfg := Config{}
	cfg.Server.Host = "0.0.0.0"
	cfg.Server.Port = 8080
	cfg.Database.Host = "postgres"
	cfg.Database.Port = 5432
	cfg.Database.User = "zgsm"
	cfg.Database.Database = "model_access"
	cfg.Database.SSLMode = "disable"
	cfg.JWT.Enable = true
	cfg.JWT.EmailField = []string{"email"}

	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return cfg, err
	}
	if err == nil {
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("parse config: %w", err)
		}
	}

	applyEnv(&cfg)
	if cfg.Database.Password == "" {
		return cfg, fmt.Errorf("database password is required")
	}
	if cfg.JWT.Enable && cfg.JWT.JWKSURL == "" {
		return cfg, fmt.Errorf("jwtSettings.jwksUrl is required when JWT verification is enabled")
	}
	if cfg.Admin.Token == "" {
		return cfg, fmt.Errorf("admin.token is required")
	}
	return cfg, nil
}

func applyEnv(cfg *Config) {
	setString("SERVER_HOST", &cfg.Server.Host)
	setInt("SERVER_PORT", &cfg.Server.Port)
	setString("DATABASE_HOST", &cfg.Database.Host)
	setInt("DATABASE_PORT", &cfg.Database.Port)
	setString("DATABASE_USER", &cfg.Database.User)
	setString("DATABASE_PASSWORD", &cfg.Database.Password)
	setString("DATABASE_DBNAME", &cfg.Database.Database)
	setString("DATABASE_SSLMODE", &cfg.Database.SSLMode)
	setString("JWT_JWKS_URL", &cfg.JWT.JWKSURL)
	setString("JWT_ISSUER", &cfg.JWT.Issuer)
	setString("JWT_AUDIENCE", &cfg.JWT.Audience)
	setString("ADMIN_TOKEN", &cfg.Admin.Token)
	setString("MODELS_BOOTSTRAP_FILE", &cfg.Models.BootstrapFile)
	if value := os.Getenv("JWT_EMAIL_FIELD"); value != "" {
		cfg.JWT.EmailField = strings.Split(value, ".")
	}
}

func setString(key string, target *string) {
	if value := os.Getenv(key); value != "" {
		*target = value
	}
}

func setInt(key string, target *int) {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			*target = parsed
		}
	}
}

func (c Config) DatabaseURL() string {
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s",
		c.Database.User, c.Database.Password, c.Database.Host, c.Database.Port,
		c.Database.Database, c.Database.SSLMode)
}
