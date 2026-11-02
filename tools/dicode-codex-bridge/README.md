# DiCode Codex bridge

Standalone Responses endpoint for the unmodified Codex CLI. Set `MODEL_ACCESS_URL` to the internal model-access service's `/ai-gateway/api/v1/models` URL and `GATEWAY_RESPONSES_URL` to the exact upstream Responses endpoint. The bridge validates the user's bearer token and selected model through model-access on every request, then streams the request and response to/from the gateway.

`GET /health` is unauthenticated. `POST /codex/v1/responses` requires a DiCode bearer token. It does not hold Codex sessions or run Codex itself; the VS Code extension starts `codex app-server` on the user's extension host.

Build: `docker build -t dicode-codex-bridge:dev tools/dicode-codex-bridge` from the repository root.
