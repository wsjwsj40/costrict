package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ db *pgxpool.Pool }

type Model struct {
	ID         string         `json:"id"`
	PublicInfo map[string]any `json:"publicInfo"`
	Enabled    bool           `json:"enabled"`
	SortOrder  int            `json:"sortOrder"`
}

type Plan struct {
	Code      string   `json:"code"`
	Name      string   `json:"name"`
	IsDefault bool     `json:"isDefault"`
	ModelIDs  []string `json:"modelIds"`
}

type UserPermission struct {
	Email    string `json:"email"`
	PlanCode string `json:"planCode"`
}

type AdminState struct {
	Models []Model          `json:"models"`
	Plans  []Plan           `json:"plans"`
	Users  []UserPermission `json:"users"`
}

func New(ctx context.Context, databaseURL string) (*Store, error) {
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() { s.db.Close() }

func (s *Store) Migrate(ctx context.Context, sql string) error {
	_, err := s.db.Exec(ctx, sql)
	return err
}

func (s *Store) Bootstrap(ctx context.Context, path string) error {
	if path == "" {
		return nil
	}
	var count int
	if err := s.db.QueryRow(ctx, "SELECT COUNT(*) FROM model_access_catalog").Scan(&count); err != nil || count > 0 {
		return err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var payload struct {
		Models []Model `json:"models"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("parse bootstrap models: %w", err)
	}
	for _, model := range payload.Models {
		if strings.EqualFold(model.ID, "auto") {
			continue
		}
		if err := s.UpsertModel(ctx, model); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) VisibleModels(ctx context.Context, email string) ([]map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		SELECT m.id, m.public_info
		FROM model_access_catalog m
		JOIN model_access_plan_model pm ON pm.model_id = m.id
		JOIN model_access_plan p ON p.code = pm.plan_code
		LEFT JOIN model_access_user u ON LOWER(u.email) = LOWER($1)
		WHERE p.code = COALESCE(u.plan_code,
			(SELECT code FROM model_access_plan WHERE is_default = TRUE LIMIT 1))
		  AND m.enabled = TRUE
		  AND LOWER(m.id) <> 'auto'
		ORDER BY m.sort_order, m.id`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]map[string]any, 0)
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		info := map[string]any{}
		if err := json.Unmarshal(raw, &info); err != nil {
			return nil, err
		}
		info["id"] = id
		result = append(result, info)
	}
	return result, rows.Err()
}

func (s *Store) AdminState(ctx context.Context) (AdminState, error) {
	state := AdminState{Models: []Model{}, Plans: []Plan{}, Users: []UserPermission{}}
	rows, err := s.db.Query(ctx, "SELECT id, public_info, enabled, sort_order FROM model_access_catalog ORDER BY sort_order, id")
	if err != nil {
		return state, err
	}
	for rows.Next() {
		var m Model
		var raw []byte
		if err := rows.Scan(&m.ID, &raw, &m.Enabled, &m.SortOrder); err != nil {
			rows.Close()
			return state, err
		}
		if err := json.Unmarshal(raw, &m.PublicInfo); err != nil {
			rows.Close()
			return state, err
		}
		state.Models = append(state.Models, m)
	}
	rows.Close()

	rows, err = s.db.Query(ctx, `
		SELECT p.code, p.name, p.is_default, COALESCE(array_agg(pm.model_id ORDER BY pm.model_id)
			FILTER (WHERE pm.model_id IS NOT NULL), '{}')
		FROM model_access_plan p LEFT JOIN model_access_plan_model pm ON pm.plan_code = p.code
		GROUP BY p.code ORDER BY p.code`)
	if err != nil {
		return state, err
	}
	for rows.Next() {
		var p Plan
		if err := rows.Scan(&p.Code, &p.Name, &p.IsDefault, &p.ModelIDs); err != nil {
			rows.Close()
			return state, err
		}
		state.Plans = append(state.Plans, p)
	}
	rows.Close()

	rows, err = s.db.Query(ctx, "SELECT email, plan_code FROM model_access_user ORDER BY email")
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var u UserPermission
		if err := rows.Scan(&u.Email, &u.PlanCode); err != nil {
			return state, err
		}
		state.Users = append(state.Users, u)
	}
	return state, rows.Err()
}

func (s *Store) UpsertModel(ctx context.Context, model Model) error {
	model.ID = strings.TrimSpace(model.ID)
	if model.ID == "" || strings.EqualFold(model.ID, "auto") {
		return errors.New("model id is invalid or reserved")
	}
	if model.PublicInfo == nil {
		model.PublicInfo = map[string]any{}
	}
	delete(model.PublicInfo, "id")
	raw, err := json.Marshal(model.PublicInfo)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO model_access_catalog(id, public_info, enabled, sort_order)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT(id) DO UPDATE SET public_info=EXCLUDED.public_info,
			enabled=EXCLUDED.enabled, sort_order=EXCLUDED.sort_order, updated_at=NOW()`,
		model.ID, raw, model.Enabled, model.SortOrder)
	return err
}

func (s *Store) DeleteModel(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, "DELETE FROM model_access_catalog WHERE id=$1", id)
	return err
}

func (s *Store) SetPlanModels(ctx context.Context, code string, modelIDs []string) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "DELETE FROM model_access_plan_model WHERE plan_code=$1", code); err != nil {
			return err
		}
		for _, id := range modelIDs {
			if strings.EqualFold(id, "auto") {
				continue
			}
			if _, err := tx.Exec(ctx,
				"INSERT INTO model_access_plan_model(plan_code, model_id) VALUES($1,$2)", code, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) SetUserPlan(ctx context.Context, email, planCode string) error {
	_, err := s.SetUsersPlan(ctx, []string{email}, planCode)
	return err
}

func (s *Store) DeleteUser(ctx context.Context, email string) error {
	_, err := s.DeleteUsers(ctx, []string{email})
	return err
}

func (s *Store) SetUsersPlan(ctx context.Context, emails []string, planCode string) (int, error) {
	normalized, err := normalizeEmails(emails)
	if err != nil {
		return 0, err
	}
	planCode = strings.ToLower(strings.TrimSpace(planCode))
	if planCode == "" {
		return 0, errors.New("plan code is required")
	}

	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var isDefault bool
		if err := tx.QueryRow(ctx, "SELECT is_default FROM model_access_plan WHERE code=$1", planCode).Scan(&isDefault); errors.Is(err, pgx.ErrNoRows) {
			return errors.New("plan does not exist")
		} else if err != nil {
			return err
		}
		// The default plan is implicit. Downgrading to it removes explicit
		// overrides instead of accumulating redundant Free user rows.
		if isDefault {
			_, err := tx.Exec(ctx, "DELETE FROM model_access_user WHERE email = ANY($1)", normalized)
			return err
		}
		for _, email := range normalized {
			if _, err := tx.Exec(ctx, `
				INSERT INTO model_access_user(email, plan_code) VALUES($1,$2)
				ON CONFLICT(email) DO UPDATE SET plan_code=EXCLUDED.plan_code, updated_at=NOW()`,
				email, planCode); err != nil {
				return err
			}
		}
		return nil
	})
	return len(normalized), err
}

func (s *Store) DeleteUsers(ctx context.Context, emails []string) (int, error) {
	normalized, err := normalizeEmails(emails)
	if err != nil {
		return 0, err
	}
	tag, err := s.db.Exec(ctx, "DELETE FROM model_access_user WHERE email = ANY($1)", normalized)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func normalizeEmails(emails []string) ([]string, error) {
	if len(emails) == 0 {
		return nil, errors.New("at least one email is required")
	}
	seen := make(map[string]struct{}, len(emails))
	normalized := make([]string, 0, len(emails))
	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		at := strings.LastIndex(email, "@")
		if at <= 0 || at == len(email)-1 || strings.ContainsAny(email, " \t\r\n") {
			return nil, fmt.Errorf("invalid email: %s", raw)
		}
		if _, exists := seen[email]; exists {
			continue
		}
		seen[email] = struct{}{}
		normalized = append(normalized, email)
	}
	return normalized, nil
}
