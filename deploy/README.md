# Internal deployment

The deployment repository is separate from this clean source tree. Apply `costrict-deploy-docker.patch` to a new branch based on `costrict-deploy-docker` main:

```sh
git switch -c agent/dicode-codex-mvp
git am /path/to/costrict-deploy-docker.patch
```

The patch adds the bridge Deployment/Service template, APISIX route, image setting, CLI asset deployment script, and detailed `docs/dicode-codex-mvp.md`. Follow that document after applying the patch. The current GitHub account cannot push to the deployment repository, so the patch is also attached to the release.

Before cluster deployment, set `IMAGE_DICODE_CODEX_BRIDGE` to your internal registry image and `CODEX_GATEWAY_RESPONSES_URL` to the gateway's exact Responses endpoint. Create Kubernetes Secret `dicode-codex-gateway` with key `api-key` containing the gateway API key. The bridge consumes the existing model-access API for user/model validation and uses this separate key for Responses calls. Upload the CLI asset archive to the existing portal volume with `scripts/deploy-dicode-codex-cli-assets.sh`; the VSIX downloads it automatically when activated.
