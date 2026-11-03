# DiCode Codex MVP

Independent VS Code extension using the unmodified `codex app-server` as its local agent. The existing DiCode login and model list endpoints supply credentials and model IDs. The selected model runs through the standalone `dicode-codex-bridge` Responses endpoint.

The extension automatically downloads the platform-specific unmodified Codex CLI from the DiCode portal on first activation. The installer verifies the archive, waits for extraction handles to close, and can finish by copying the package if Windows blocks the final directory rename. The JSON-RPC handshake and ephemeral thread creation were checked against `codex-cli 0.164.0`. Set `dicodeCodex.serverUrl` to the DiCode APISIX entry. Set `dicodeCodex.codexPath` only to override automatic installation with an existing executable. Package from this directory with `vsce package --no-dependencies` or use VS Code's Extension Development Host with this folder as the extension path.

This MVP supports login, model selection, a single persisted thread, streaming replies, command/file approvals, stopping a turn, and a new thread. It requires an open workspace. The old Roo-based extension is not part of this package.
