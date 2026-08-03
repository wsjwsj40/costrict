package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/costrict/model-access-service/internal/auth"
	"github.com/costrict/model-access-service/internal/config"
	"github.com/costrict/model-access-service/internal/gateway"
	"github.com/costrict/model-access-service/internal/httpapi"
	"github.com/costrict/model-access-service/internal/store"
	"github.com/costrict/model-access-service/internal/syncworker"
)

//go:embed migrations/001_init.sql
var migrationSQL string

//go:embed migrations/002_sync_tasks.sql
var syncMigrationSQL string

func main() {
	configPath := "/app/config.yaml"
	if len(os.Args) == 3 && os.Args[1] == "-f" {
		configPath = os.Args[2]
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		fatal(err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	data, err := store.New(ctx, cfg.DatabaseURL())
	if err != nil {
		fatal(fmt.Errorf("connect database: %w", err))
	}
	defer data.Close()
	if err := data.Migrate(ctx, migrationSQL); err != nil {
		fatal(fmt.Errorf("migrate database: %w", err))
	}
	if err := data.Migrate(ctx, syncMigrationSQL); err != nil {
		fatal(fmt.Errorf("migrate sync tasks: %w", err))
	}
	if err := data.Bootstrap(ctx, cfg.Models.BootstrapFile); err != nil {
		fatal(fmt.Errorf("bootstrap models: %w", err))
	}

	authenticator, err := auth.New(ctx, cfg)
	if err != nil {
		fatal(err)
	}
	gatewayClient := gateway.New(cfg)
	handler := httpapi.New(data, authenticator, cfg.Admin.Token, gatewayClient)
	go syncworker.New(data, gatewayClient, cfg).Run(ctx)
	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:           handler.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		slog.Info("model access service started", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err := server.Shutdown(shutdown); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	slog.Error("fatal", "error", err)
	os.Exit(1)
}
