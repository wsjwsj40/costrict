# Internal deployment

The deployment repository is separate from this source tree. Apply `costrict-deploy-docker.patch` to a new branch based on `costrict-deploy-docker` main:

```sh
git switch -c agent/dicode-codex-bridge-logs
git apply /path/to/costrict-deploy-docker.patch
```

The patch adds the bridge Deployment/Service template, APISIX route, image setting, CLI asset deployment script, Grafana Loki dashboard, and detailed `docs/dicode-codex-mvp.md`. Follow that document after applying the patch. The current GitHub account has read access but no push access to the deployment repository, so the patch is attached to the bridge release.

Before cluster deployment, set `IMAGE_DICODE_CODEX_BRIDGE` to your internal registry image, confirm `CODEX_GATEWAY_RESPONSES_URL` is the gateway's exact Responses endpoint, and confirm `CODEX_TOKEN_EXCHANGE_URL` matches chat-rag's current `newTokenAuth.endpoint`. Create Kubernetes Secret `dicode-codex-token-exchange` with key `open-token` containing the same `NEW-OPEN-TOKEN` credential chat-rag uses. The bridge validates the DiCode JWT through model-access, reads the user's email, reuses chat-rag's Redis hash cache, and exchanges the email for a gateway key on a cache miss. The existing Promtail/Loki pipeline collects bridge stdout logs, and the patch provisions a Grafana dashboard. Upload the CLI asset archive to the existing portal volume with `scripts/deploy-dicode-codex-cli-assets.sh`; the VSIX downloads it automatically when activated.
