package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

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
	Models    []Model          `json:"models"`
	Plans     []Plan           `json:"plans"`
	Users     []UserPermission `json:"users"`
	SyncTasks []SyncTask       `json:"syncTasks"`
}

type SyncTask struct {
	ID             int64     `json:"id"`
	Reason         string    `json:"reason"`
	Status         string    `json:"status"`
	TotalCount     int       `json:"totalCount"`
	ProcessedCount int       `json:"processedCount"`
	SuccessCount   int       `json:"successCount"`
	FailedCount    int       `json:"failedCount"`
	LastError      string    `json:"lastError"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type SyncItem struct {
	ID       int64
	TaskID   int64
	Email    string
	ModelIDs []string
	Attempts int
}

var planCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

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

// EnsureDefaultUser records a previously unseen user in the default plan. The
// boolean result is true only for the request that created the row, allowing
// callers to enqueue one initial gateway synchronization without duplicates.
func (s *Store) EnsureDefaultUser(ctx context.Context, email string) (string, bool, error) {
	normalized, err := NormalizeEmails([]string{email})
	if err != nil {
		return "", false, err
	}
	planCode, err := s.DefaultPlanCode(ctx)
	if err != nil {
		return "", false, err
	}
	tag, err := s.db.Exec(ctx, `
		INSERT INTO model_access_user(email, plan_code)
		VALUES($1, $2)
		ON CONFLICT (email) DO NOTHING`, normalized[0], planCode)
	if err != nil {
		return "", false, err
	}
	return planCode, tag.RowsAffected() == 1, nil
}

func (s *Store) AdminState(ctx context.Context) (AdminState, error) {
	state := AdminState{Models: []Model{}, Plans: []Plan{}, Users: []UserPermission{}, SyncTasks: []SyncTask{}}
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
	if err := rows.Err(); err != nil {
		return state, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT t.id,t.reason,t.status,t.total_count,t.processed_count,t.success_count,t.failed_count,
		COALESCE((SELECT i.last_error FROM model_access_sync_item i WHERE i.task_id=t.id AND i.last_error<>'' ORDER BY i.updated_at DESC LIMIT 1),''),
		t.created_at,t.updated_at FROM model_access_sync_task t ORDER BY t.id DESC LIMIT 50`)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var t SyncTask
		if err := rows.Scan(&t.ID, &t.Reason, &t.Status, &t.TotalCount, &t.ProcessedCount, &t.SuccessCount, &t.FailedCount, &t.LastError, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return state, err
		}
		state.SyncTasks = append(state.SyncTasks, t)
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

func (s *Store) ModelEnabled(ctx context.Context, id string) (bool, bool, error) {
	var enabled bool
	err := s.db.QueryRow(ctx, "SELECT enabled FROM model_access_catalog WHERE id=$1", id).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	return enabled, err == nil, err
}

func (s *Store) SetPlanModels(ctx context.Context, code string, modelIDs []string) error {
	code = strings.ToLower(strings.TrimSpace(code))
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_access_plan WHERE code=$1)", code).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errors.New("plan does not exist")
		}
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

func normalizePlan(code, name string) (string, string, error) {
	code = strings.ToLower(strings.TrimSpace(code))
	name = strings.TrimSpace(name)
	if !planCodePattern.MatchString(code) {
		return "", "", errors.New("plan code must be 1-32 lowercase letters, numbers, underscores, or hyphens")
	}
	if name == "" || len([]rune(name)) > 64 {
		return "", "", errors.New("plan name must be 1-64 characters")
	}
	return code, name, nil
}

func (s *Store) CreatePlan(ctx context.Context, code, name string, isDefault bool) error {
	code, name, err := normalizePlan(code, name)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if isDefault {
			if _, err := tx.Exec(ctx, "UPDATE model_access_plan SET is_default=FALSE,updated_at=NOW() WHERE is_default=TRUE"); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, "INSERT INTO model_access_plan(code,name,is_default) VALUES($1,$2,$3)", code, name, isDefault)
		return err
	})
}

func (s *Store) UpdatePlan(ctx context.Context, code, name string, isDefault bool) error {
	code, name, err := normalizePlan(code, name)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_access_plan WHERE code=$1)", code).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errors.New("plan does not exist")
		}
		if !isDefault {
			var currentDefault bool
			if err := tx.QueryRow(ctx, "SELECT is_default FROM model_access_plan WHERE code=$1", code).Scan(&currentDefault); err != nil {
				return err
			}
			if currentDefault {
				return errors.New("default plan cannot be unset without selecting another default plan")
			}
		}
		if isDefault {
			if _, err := tx.Exec(ctx, "UPDATE model_access_plan SET is_default=FALSE,updated_at=NOW() WHERE is_default=TRUE AND code<>$1", code); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, "UPDATE model_access_plan SET name=$2,is_default=$3,updated_at=NOW() WHERE code=$1", code, name, isDefault)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("plan does not exist")
		}
		return nil
	})
}

// DeletePlan migrates every explicitly recorded user to replacementPlanCode
// before removing the plan. The returned emails must be synchronized to the
// gateway using the replacement plan's models.
func (s *Store) DeletePlan(ctx context.Context, code, replacementPlanCode string) ([]string, error) {
	code = strings.ToLower(strings.TrimSpace(code))
	replacementPlanCode = strings.ToLower(strings.TrimSpace(replacementPlanCode))
	if code == replacementPlanCode {
		return nil, errors.New("replacement plan must be different")
	}
	emails := []string{}
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var isDefault bool
		if err := tx.QueryRow(ctx, "SELECT is_default FROM model_access_plan WHERE code=$1", code).Scan(&isDefault); errors.Is(err, pgx.ErrNoRows) {
			return errors.New("plan does not exist")
		} else if err != nil {
			return err
		}
		if isDefault {
			return errors.New("default plan cannot be deleted")
		}
		var replacementExists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_access_plan WHERE code=$1)", replacementPlanCode).Scan(&replacementExists); err != nil {
			return err
		}
		if !replacementExists {
			return errors.New("replacement plan does not exist")
		}
		rows, err := tx.Query(ctx, "SELECT email FROM model_access_user WHERE plan_code=$1 ORDER BY email", code)
		if err != nil {
			return err
		}
		for rows.Next() {
			var email string
			if err := rows.Scan(&email); err != nil {
				rows.Close()
				return err
			}
			emails = append(emails, email)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		if _, err := tx.Exec(ctx, "UPDATE model_access_user SET plan_code=$2,updated_at=NOW() WHERE plan_code=$1", code, replacementPlanCode); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "DELETE FROM model_access_plan WHERE code=$1", code)
		return err
	})
	return emails, err
}

func (s *Store) EnabledModelIDsForPlan(ctx context.Context, code string) ([]string, error) {
	code = strings.ToLower(strings.TrimSpace(code))
	rows, err := s.db.Query(ctx, `
		SELECT m.id FROM model_access_catalog m
		JOIN model_access_plan_model pm ON pm.model_id=m.id
		WHERE pm.plan_code=$1 AND m.enabled=TRUE AND LOWER(m.id)<>'auto'
		ORDER BY m.sort_order, m.id`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []string{}
	}
	var exists bool
	if err := s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_access_plan WHERE code=$1)", code).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("plan does not exist")
	}
	return ids, nil
}

func (s *Store) DefaultPlanCode(ctx context.Context) (string, error) {
	var code string
	err := s.db.QueryRow(ctx, "SELECT code FROM model_access_plan WHERE is_default=TRUE LIMIT 1").Scan(&code)
	return code, err
}

func (s *Store) UsersForPlan(ctx context.Context, planCode string) ([]string, error) {
	rows, err := s.db.Query(ctx, "SELECT email FROM model_access_user WHERE plan_code=$1 ORDER BY email", strings.ToLower(strings.TrimSpace(planCode)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		result = append(result, email)
	}
	return result, rows.Err()
}

func (s *Store) PlansForModel(ctx context.Context, modelID string) ([]string, error) {
	rows, err := s.db.Query(ctx, "SELECT plan_code FROM model_access_plan_model WHERE model_id=$1 ORDER BY plan_code", modelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		result = append(result, code)
	}
	return result, rows.Err()
}

func (s *Store) CreateSyncTask(ctx context.Context, reason string, emails, modelIDs []string) (int64, error) {
	if len(emails) == 0 {
		return 0, nil
	}
	normalized, err := NormalizeEmails(emails)
	if err != nil {
		return 0, err
	}
	var taskID int64
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, "INSERT INTO model_access_sync_task(reason,total_count) VALUES($1,$2) RETURNING id", reason, len(normalized)).Scan(&taskID); err != nil {
			return err
		}
		for _, email := range normalized {
			if _, err := tx.Exec(ctx, "INSERT INTO model_access_sync_item(task_id,email,model_ids) VALUES($1,$2,$3)", taskID, email, modelIDs); err != nil {
				return err
			}
		}
		return nil
	})
	return taskID, err
}

func (s *Store) ResetInterruptedSyncItems(ctx context.Context) error {
	_, err := s.db.Exec(ctx, "UPDATE model_access_sync_item SET status='pending',updated_at=NOW() WHERE status='running'")
	return err
}

func (s *Store) ClaimSyncItems(ctx context.Context, limit int) ([]SyncItem, error) {
	if limit <= 0 {
		limit = 20
	}
	items := []SyncItem{}
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id,task_id,email,model_ids,attempts FROM model_access_sync_item
			WHERE status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item SyncItem
			if err := rows.Scan(&item.ID, &item.TaskID, &item.Email, &item.ModelIDs, &item.Attempts); err != nil {
				return err
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for i := range items {
			items[i].Attempts++
			if _, err := tx.Exec(ctx, "UPDATE model_access_sync_item SET status='running',attempts=attempts+1,updated_at=NOW() WHERE id=$1", items[i].ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "UPDATE model_access_sync_task SET status='running',updated_at=NOW() WHERE id=$1", items[i].TaskID); err != nil {
				return err
			}
		}
		return nil
	})
	return items, err
}

func (s *Store) FinishSyncItem(ctx context.Context, item SyncItem, syncErr error, maxAttempts int) error {
	status, message := "success", ""
	if syncErr != nil {
		status, message = "failed", syncErr.Error()
		if item.Attempts < maxAttempts {
			status = "pending"
		}
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "UPDATE model_access_sync_item SET status=$2,last_error=$3,updated_at=NOW() WHERE id=$1", item.ID, status, message); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE model_access_sync_task t SET
			processed_count=x.success_count+x.failed_count, success_count=x.success_count, failed_count=x.failed_count,
			status=CASE WHEN x.active_count>0 THEN 'running' WHEN x.failed_count=0 THEN 'completed' WHEN x.success_count=0 THEN 'failed' ELSE 'partial' END,
			updated_at=NOW(), finished_at=CASE WHEN x.active_count=0 THEN NOW() ELSE NULL END
			FROM (SELECT task_id,COUNT(*) FILTER(WHERE status='success')::int success_count,
			COUNT(*) FILTER(WHERE status='failed')::int failed_count,
			COUNT(*) FILTER(WHERE status IN ('pending','running'))::int active_count FROM model_access_sync_item WHERE task_id=$1 GROUP BY task_id) x
			WHERE t.id=x.task_id`, item.TaskID)
		return err
	})
}

func (s *Store) IsSyncItemObsolete(ctx context.Context, item SyncItem) (bool, error) {
	var obsolete bool
	err := s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_access_sync_item WHERE email=$1 AND id>$2)", item.Email, item.ID).Scan(&obsolete)
	return obsolete, err
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
	normalized, err := NormalizeEmails(emails)
	if err != nil {
		return 0, err
	}
	planCode = strings.ToLower(strings.TrimSpace(planCode))
	if planCode == "" {
		return 0, errors.New("plan code is required")
	}

	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_access_plan WHERE code=$1)", planCode).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errors.New("plan does not exist")
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
	normalized, err := NormalizeEmails(emails)
	if err != nil {
		return 0, err
	}
	tag, err := s.db.Exec(ctx, "DELETE FROM model_access_user WHERE email = ANY($1)", normalized)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func NormalizeEmails(emails []string) ([]string, error) {
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
