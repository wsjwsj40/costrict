# PowerShell 7 portal assets for DiCode 0.2.3

The VSIX automatically downloads PowerShell 7 on Windows x64 and ARM64 from the existing Portal route. The bridge image and APISIX routes do not change. Place `dicode-powershell-7.6.6-assets.tar` in the deployment host, then run from the deployment repository root:

```sh
mkdir -p config/portal/static_file/costrict/powershell data/portal/costrict/powershell
tar -xf dicode-powershell-7.6.6-assets.tar -C config/portal/static_file/costrict/powershell
tar -xf dicode-powershell-7.6.6-assets.tar -C data/portal/costrict/powershell
chmod -R a+rX config/portal/static_file/costrict/powershell data/portal/costrict/powershell
bash costrict.sh up
curl -f https://dicode.byd.com:30092/costrict/powershell/win32/x64/manifest.json
curl -f https://dicode.byd.com:30092/costrict/powershell/win32/arm64/manifest.json
```

The first copy is the source for future `prepare_portal_assets` runs; the second is the source that `sync_portal_assets` sends to the live Portal PVC during `up`. If the internal deployment script has different paths, preserve this final layout under the Portal document root: `/var/www/costrict/powershell/win32/{x64,arm64}/manifest.json` and its matching `.tgz` file. Make all parent directories traversable by nginx (`a+X`).

This asset package was built from Microsoft's PowerShell 7.6.6 portable Windows ZIPs with the official SHA-256 hashes checked before repackaging. The plugin checks the SHA-256 of the repackaged archive again before extraction and runs a PowerShell version probe. The PowerShell package remains in VS Code global extension storage and is used only by the DiCode Codex child process. If the manifest is missing, the assistant shows an installation error until the assets are available.

To build the same asset package from Microsoft release files:

```sh
node scripts/package-dicode-powershell.js PowerShell-7.6.6-win-x64.zip PowerShell-7.6.6-win-arm64.zip dicode-powershell-7.6.6-assets.tar
```
