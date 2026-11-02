# DiCode Codex bridge

Standalone Responses endpoint for the unmodified Codex CLI. Set `MODEL_ACCESS_URL` to the internal model-access service's `/ai-gateway/api/v1/models` URL, `GATEWAY_RESPONSES_URL` to the exact upstream `/v1/responses` endpoint, and `GATEWAY_API_KEY` to the gateway's API key. The bridge validates the user's DiCode bearer token and selected model through model-access on every request. It then uses the separate gateway key, sets `originator: codex_cli_rs`, forwards or generates `session-id` and `thread-id`, and streams the original Responses body and events without translation.

`GET /health` is unauthenticated. `POST /codex/v1/responses` requires a DiCode bearer token. It does not hold Codex sessions or run Codex itself; the VS Code extension starts `codex app-server` on the user's extension host.

Build: `docker build -t dicode-codex-bridge:dev tools/dicode-codex-bridge` from the repository root.
