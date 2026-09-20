package syncworker

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/costrict/model-access-service/internal/config"
	"github.com/costrict/model-access-service/internal/store"
)

type recordingGateway struct{ emails []string }

func (g *recordingGateway) UpdateModels(_ context.Context, email string, _ []string) error {
	g.emails = append(g.emails, email)
	return nil
}

func TestWorkerProcessesPersistedTask(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	data, err := store.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	for _, name := range []string{"001_init.sql", "002_sync_tasks.sql"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := data.Migrate(ctx, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	taskID, err := data.CreateSyncTask(ctx, "worker integration test", []string{"queue-test@example.com"}, []string{"model-a"})
	if err != nil {
		t.Fatal(err)
	}
	gateway := &recordingGateway{}
	cfg := config.Config{}
	cfg.Gateway.BatchSize = 10
	cfg.Gateway.MaxAttempts = 3
	worker := New(data, gateway, cfg)
	worker.process(ctx)
	called := false
	for _, email := range gateway.emails {
		if email == "queue-test@example.com" {
			called = true
		}
	}
	if !called {
		t.Fatalf("queue test user was not synchronized: %v", gateway.emails)
	}
	state, err := data.AdminState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, task := range state.SyncTasks {
		if task.ID == taskID {
			found = true
			if task.Status != "completed" || task.SuccessCount != 1 {
				t.Fatalf("unexpected task: %#v", task)
			}
		}
	}
	if !found {
		t.Fatalf("task %d not found", taskID)
	}
}
