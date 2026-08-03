package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/costrict/model-access-service/internal/config"
)

type Client struct {
	url                string
	supportedModelsURL string
	token              string
	completionModel    string
	httpClient         *http.Client
}

func New(cfg config.Config) *Client {
	timeout := time.Duration(cfg.Gateway.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{
		url:                strings.TrimSpace(cfg.Gateway.PermissionURL),
		supportedModelsURL: strings.TrimSpace(cfg.Gateway.SupportedModelsURL),
		token:              strings.TrimSpace(cfg.Gateway.Token),
		completionModel:    strings.TrimSpace(cfg.Gateway.CompletionModel),
		httpClient:         &http.Client{Timeout: timeout},
	}
}

func (c *Client) UpdateModels(ctx context.Context, email string, modelIDs []string) error {
	if c.url == "" {
		return nil
	}
	models := appendUnique(modelIDs, c.completionModel)
	payload, err := json.Marshal(map[string]string{
		"key":    strings.ToLower(strings.TrimSpace(email)),
		"models": strings.Join(models, ","),
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("NEW-OPEN-TOKEN", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request gateway: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("gateway returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var result struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			Models []string `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("decode gateway response: %w", err)
	}
	if !result.Success {
		return fmt.Errorf("gateway rejected update: %s", result.Message)
	}
	if err := compareModelSets(models, result.Data.Models); err != nil {
		return err
	}
	return nil
}

func (c *Client) SupportedModels(ctx context.Context) ([]string, error) {
	if c.supportedModelsURL == "" {
		return nil, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.supportedModelsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("NEW-OPEN-TOKEN", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request supported models: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("supported models returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var result struct {
		Success bool     `json:"success"`
		Message string   `json:"message"`
		Data    []string `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode supported models: %w", err)
	}
	if !result.Success {
		return nil, fmt.Errorf("gateway rejected supported models request: %s", result.Message)
	}
	return appendUnique(result.Data, ""), nil
}

func (c *Client) ValidateSupported(ctx context.Context, modelIDs []string) error {
	supported, err := c.SupportedModels(ctx)
	if err != nil {
		return err
	}
	if supported == nil {
		return nil
	}
	wanted := appendUnique(modelIDs, c.completionModel)
	set := make(map[string]struct{}, len(supported))
	for _, id := range supported {
		set[id] = struct{}{}
	}
	missing := make([]string, 0)
	for _, id := range wanted {
		if _, ok := set[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("models not supported by gateway default list: %s", strings.Join(missing, ", "))
	}
	return nil
}

func compareModelSets(expected, actual []string) error {
	want, got := appendUnique(expected, ""), appendUnique(actual, "")
	wantSet, gotSet := map[string]struct{}{}, map[string]struct{}{}
	for _, id := range want {
		wantSet[id] = struct{}{}
	}
	for _, id := range got {
		gotSet[id] = struct{}{}
	}
	missing, extra := []string{}, []string{}
	for _, id := range want {
		if _, ok := gotSet[id]; !ok {
			missing = append(missing, id)
		}
	}
	for _, id := range got {
		if _, ok := wantSet[id]; !ok {
			extra = append(extra, id)
		}
	}
	if len(missing) > 0 || len(extra) > 0 {
		return fmt.Errorf("gateway models mismatch (missing: %s; extra: %s)", strings.Join(missing, ", "), strings.Join(extra, ", "))
	}
	return nil
}

func appendUnique(modelIDs []string, required string) []string {
	seen := make(map[string]struct{}, len(modelIDs)+1)
	result := make([]string, 0, len(modelIDs)+1)
	for _, raw := range append(append([]string(nil), modelIDs...), required) {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		key := id
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, id)
	}
	return result
}
