package httpapi

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/costrict/model-access-service/internal/auth"
	"github.com/costrict/model-access-service/internal/store"
)

//go:embed web/*
var webFiles embed.FS

type Server struct {
	store      *store.Store
	auth       *auth.Authenticator
	adminToken string
	handler    http.Handler
	gateway    gatewayPermissions
}

type gatewayPermissions interface {
	UpdateModels(ctx context.Context, email string, modelIDs []string) error
	ValidateSupported(ctx context.Context, modelIDs []string) error
}

func New(data *store.Store, authenticator *auth.Authenticator, adminToken string, gateways ...gatewayPermissions) *Server {
	s := &Server{store: data, auth: authenticator, adminToken: adminToken}
	if len(gateways) > 0 {
		s.gateway = gateways[0]
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /ai-gateway/api/v1/models", s.models)
	mux.HandleFunc("GET /admin/api/state", s.admin(s.state))
	mux.HandleFunc("PUT /admin/api/models/{id}", s.admin(s.putModel))
	mux.HandleFunc("DELETE /admin/api/models/{id}", s.admin(s.deleteModel))
	mux.HandleFunc("PUT /admin/api/plans/{code}/models", s.admin(s.putPlanModels))
	mux.HandleFunc("PUT /admin/api/users/{email}", s.admin(s.putUser))
	mux.HandleFunc("DELETE /admin/api/users/{email}", s.admin(s.deleteUser))
	mux.HandleFunc("POST /admin/api/users/batch", s.admin(s.batchUsers))
	sub, _ := fs.Sub(webFiles, "web")
	mux.Handle("/admin/", http.StripPrefix("/admin/", http.FileServer(http.FS(sub))))
	mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin/", http.StatusTemporaryRedirect)
	})
	s.handler = requestLog(mux)
	return s
}

func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) models(w http.ResponseWriter, r *http.Request) {
	email, err := s.auth.Email(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	models, err := s.store.VisibleModels(r.Context(), email)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", "failed to load models")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": 0, "message": "success", "data": models})
}

func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.adminToken)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid admin token")
			return
		}
		next(w, r)
	}
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	state, err := s.store.AdminState(r.Context())
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, state)
}

func (s *Server) putModel(w http.ResponseWriter, r *http.Request) {
	var model store.Model
	if err := readJSON(r, &model); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	model.ID = r.PathValue("id")
	oldEnabled, existed, err := s.store.ModelEnabled(r.Context(), model.ID)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	if model.Enabled && s.gateway != nil {
		if err := s.gateway.ValidateSupported(r.Context(), []string{model.ID}); err != nil {
			writeError(w, 400, "unsupported_model", err.Error())
			return
		}
	}
	plans, err := s.store.PlansForModel(r.Context(), model.ID)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	if err := s.store.UpsertModel(r.Context(), model); err != nil {
		writeError(w, 400, "invalid_model", err.Error())
		return
	}
	tasks := []int64{}
	if existed && oldEnabled != model.Enabled {
		tasks, err = s.enqueuePlans(r.Context(), "model enabled state changed: "+model.ID, plans)
	}
	if err != nil {
		writeError(w, 500, "task_error", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"taskIds": tasks})
}

func (s *Server) deleteModel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	plans, err := s.store.PlansForModel(r.Context(), id)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	if err := s.store.DeleteModel(r.Context(), id); err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	tasks, err := s.enqueuePlans(r.Context(), "model deleted: "+id, plans)
	if err != nil {
		writeError(w, 500, "task_error", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"taskIds": tasks})
}

func (s *Server) putPlanModels(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ModelIDs []string `json:"modelIds"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if s.gateway != nil {
		if err := s.gateway.ValidateSupported(r.Context(), body.ModelIDs); err != nil {
			writeError(w, 400, "unsupported_model", err.Error())
			return
		}
	}
	code := r.PathValue("code")
	if err := s.store.SetPlanModels(r.Context(), code, body.ModelIDs); err != nil {
		writeError(w, 400, "invalid_plan", err.Error())
		return
	}
	tasks, err := s.enqueuePlans(r.Context(), "plan models changed: "+code, []string{code})
	if err != nil {
		writeError(w, 500, "task_error", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"taskIds": tasks})
}

func (s *Server) putUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PlanCode string `json:"planCode"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	email := r.PathValue("email")
	if err := s.validatePlan(r.Context(), body.PlanCode); err != nil {
		writeError(w, 400, "unsupported_model", err.Error())
		return
	}
	if err := s.store.SetUserPlan(r.Context(), email, body.PlanCode); err != nil {
		writeError(w, 400, "invalid_user", err.Error())
		return
	}
	taskID, err := s.enqueueUsers(r.Context(), "user plan changed", []string{email}, body.PlanCode)
	if err != nil {
		writeError(w, 500, "task_error", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"taskId": taskID})
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	email := r.PathValue("email")
	code, err := s.store.DefaultPlanCode(r.Context())
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	if err := s.validatePlan(r.Context(), code); err != nil {
		writeError(w, 400, "unsupported_model", err.Error())
		return
	}
	if err := s.store.DeleteUser(r.Context(), email); err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	taskID, err := s.enqueueUsers(r.Context(), "user restored to default plan", []string{email}, code)
	if err != nil {
		writeError(w, 500, "task_error", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"taskId": taskID})
}

func (s *Server) batchUsers(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action   string   `json:"action"`
		Emails   []string `json:"emails"`
		PlanCode string   `json:"planCode"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}

	var (
		count int
		err   error
	)
	switch body.Action {
	case "set":
		if err = s.validatePlan(r.Context(), body.PlanCode); err != nil {
			writeError(w, 400, "unsupported_model", err.Error())
			return
		}
		count, err = s.store.SetUsersPlan(r.Context(), body.Emails, body.PlanCode)
	case "delete":
		var defaultCode string
		defaultCode, err = s.store.DefaultPlanCode(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		if err = s.validatePlan(r.Context(), defaultCode); err != nil {
			writeError(w, 400, "unsupported_model", err.Error())
			return
		}
		count, err = s.store.DeleteUsers(r.Context(), body.Emails)
	default:
		writeError(w, 400, "invalid_action", "action must be set or delete")
		return
	}
	if err != nil {
		writeError(w, 400, "invalid_users", err.Error())
		return
	}
	planCode := body.PlanCode
	if body.Action == "delete" {
		planCode, err = s.store.DefaultPlanCode(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
	}
	taskID, err := s.enqueueUsers(r.Context(), "batch user permissions changed", body.Emails, planCode)
	if err != nil {
		writeError(w, 500, "task_error", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"count": count, "taskId": taskID})
}

func (s *Server) enqueueUsers(ctx context.Context, reason string, emails []string, planCode string) (int64, error) {
	modelIDs, err := s.store.EnabledModelIDsForPlan(ctx, planCode)
	if err != nil {
		return 0, err
	}
	return s.store.CreateSyncTask(ctx, reason, emails, modelIDs)
}

func (s *Server) validatePlan(ctx context.Context, planCode string) error {
	modelIDs, err := s.store.EnabledModelIDsForPlan(ctx, planCode)
	if err != nil {
		return err
	}
	if s.gateway != nil {
		return s.gateway.ValidateSupported(ctx, modelIDs)
	}
	return nil
}

func (s *Server) enqueuePlans(ctx context.Context, reason string, plans []string) ([]int64, error) {
	ids := []int64{}
	for _, code := range plans {
		emails, err := s.store.UsersForPlan(ctx, code)
		if err != nil {
			return nil, err
		}
		id, err := s.enqueueUsers(ctx, fmt.Sprintf("%s (%s)", reason, code), emails, code)
		if err != nil {
			return nil, err
		}
		if id != 0 {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func readJSON(r *http.Request, value any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"code": code, "message": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
	})
}
