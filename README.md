# DiCode Codex

This repository contains only the new DiCode Codex MVP. It uses an unchanged Codex CLI as the agent running on the VS Code extension host. The DiCode service provides login and model-list APIs; the standalone bridge validates the user and model, reuses chat-rag's email-key Redis cache and key exchange service, then forwards Responses requests to the existing compatible gateway. There is no Roo Code runtime or build dependency.

## Components

| Directory | Purpose |
| --- | --- |
| `apps/dicode-vscode/` | VS Code sidebar, login, model selection, Codex app-server client, and automatic CLI installation |
| `tools/dicode-codex-bridge/` | Independent Go Responses endpoint and Docker image |
| `scripts/package-dicode-codex-cli.js` | Packages the original Codex CLI platform archives for offline hosting |
| `deploy/` | Patch and instructions for the existing Kubernetes deployment repository |

## Build

From `apps/dicode-vscode`, run `npm test`, then `vsce package --no-dependencies` to build the VSIX. The extension has no npm runtime dependencies. From the repository root, run `docker build -t costrict/dicode-codex-bridge:v0.1.2 tools/dicode-codex-bridge` to build the bridge. From `tools/dicode-codex-bridge`, run `go test ./...` for its HTTP tests.

The prebuilt image, VSIX, four-platform Codex CLI resource archive, checksums, and deployment patch are available in the [DiCode Codex MVP release](https://github.com/wsjwsj40/costrict/releases/tag/dicode-codex-mvp-v0.1.3).

See [deployment instructions](deploy/README.md) for the internal cluster. `dicodeCodex.serverUrl` must point to the APISIX entry. On first activation, the extension downloads the matching Codex CLI from the portal and verifies its SHA-256 before starting `codex app-server`. Windows and Linux x64/arm64 are supported. Installation occurs on the extension host, including a remote Linux host or WSL when VS Code runs the extension there.
