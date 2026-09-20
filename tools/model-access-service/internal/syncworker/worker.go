package syncworker

import (
	"context"
	"log/slog"
	"time"

	"github.com/costrict/model-access-service/internal/config"
	"github.com/costrict/model-access-service/internal/store"
)

type gatewayUpdater interface {
	UpdateModels(context.Context, string, []string) error
}

type Worker struct {
	store       *store.Store
	gateway     gatewayUpdater
	batchSize   int
	poll        time.Duration
	maxAttempts int
}

func New(data *store.Store, updater gatewayUpdater, cfg config.Config) *Worker {
	poll := time.Duration(cfg.Gateway.PollSeconds) * time.Second
	if poll <= 0 {
		poll = 2 * time.Second
	}
	batchSize := cfg.Gateway.BatchSize
	if batchSize <= 0 {
		batchSize = 20
	}
	maxAttempts := cfg.Gateway.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	return &Worker{store: data, gateway: updater, batchSize: batchSize, poll: poll, maxAttempts: maxAttempts}
}

func (w *Worker) Run(ctx context.Context) {
	if err := w.store.ResetInterruptedSyncItems(ctx); err != nil {
		slog.Error("reset interrupted sync items", "error", err)
	}
	ticker := time.NewTicker(w.poll)
	defer ticker.Stop()
	for {
		w.process(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (w *Worker) process(ctx context.Context) {
	items, err := w.store.ClaimSyncItems(ctx, w.batchSize)
	if err != nil {
		slog.Error("claim sync items", "error", err)
		return
	}
	for _, item := range items {
		obsolete, checkErr := w.store.IsSyncItemObsolete(ctx, item)
		if checkErr != nil {
			_ = w.store.FinishSyncItem(ctx, item, checkErr, w.maxAttempts)
			continue
		}
		if obsolete {
			_ = w.store.FinishSyncItem(ctx, item, nil, w.maxAttempts)
			continue
		}
		err := w.gateway.UpdateModels(ctx, item.Email, item.ModelIDs)
		if finishErr := w.store.FinishSyncItem(ctx, item, err, w.maxAttempts); finishErr != nil {
			slog.Error("finish sync item", "item", item.ID, "error", finishErr)
		}
	}
}
