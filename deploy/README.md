# Internal deployment

The deployment repository is separate from this clean source tree. Apply `costrict-deploy-docker.patch` to a new branch based on `costrict-deploy-docker` main:

```sh
git switch -c agent/dicode-codex-mvp
git am /path/to/costrict-deploy-docker.patch
```

The patch adds the bridge Deployment/Service template, APISIX route, image setting, CLI asset deployment script, and detailed `docs/dicode-codex-mvp.md`. Follow that document after applying the patch. The current GitHub account cannot push to the deployment repository, so the patch is also attached to the release.

Before cluster deployment, set `IMAGE_DICODE_CODEX_BRIDGE` to your internal registry image, `CODEX_GATEWAY_RESPONSES_URL` to the gateway's exact Responses endpoint, and `CODEX_TOKEN_EXCHANGE_URL` to chat-rag's current `newTokenAuth.endpoint`. Create Kubernetes Secret `dicode-codex-token-exchange` with key `open-token` containing the same `NEW-OPEN-TOKEN` credential chat-rag uses. The bridge validates the DiCode JWT through model-access, reads the user's email, reuses chat-rag's Redis hash cache, and exchanges the email for a gateway key on a cache miss. Upload the CLI asset archive to the existing portal volume with `scripts/deploy-dicode-codex-cli-assets.sh`; the VSIX downloads it automatically when activated.
