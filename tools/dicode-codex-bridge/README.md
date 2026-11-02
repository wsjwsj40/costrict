# DiCode Codex bridge

Standalone Responses endpoint for the unmodified Codex CLI. Set `MODEL_ACCESS_URL` to the internal model-access service's `/ai-gateway/api/v1/models` URL, `GATEWAY_RESPONSES_URL` to the exact upstream `/v1/responses` endpoint, `TOKEN_EXCHANGE_URL` to chat-rag's `newTokenAuth.endpoint`, and `TOKEN_EXCHANGE_OPEN_TOKEN` to the same `NEW-OPEN-TOKEN` credential from a Secret. `REDIS_ADDR` defaults to `redis:6379`. The bridge validates the user's DiCode bearer token and selected model through model-access on every request, reads the verified JWT's email, reuses chat-rag's `chat_rag:new_token_auth` Redis hash, and on a cache miss exchanges the email for a key. It then sets `originator: codex_cli_rs`, forwards or generates `session-id` and `thread-id`, and streams the original Responses body and events without translation.

`GET /health` is unauthenticated. `POST /codex/v1/responses` requires a DiCode bearer token. It does not hold Codex sessions or run Codex itself; the VS Code extension starts `codex app-server` on the user's extension host.

Build: `docker build -t dicode-codex-bridge:dev tools/dicode-codex-bridge` from the repository root.
