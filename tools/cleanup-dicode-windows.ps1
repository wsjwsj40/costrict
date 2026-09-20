[CmdletBinding()]
param(
    [string]$ExtensionId = "atad-apts.dicode",
    [string]$BackupRoot = "",
    [switch]$SkipExtensionUninstall
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $BackupRoot = Join-Path $HOME "dicode-cleanup-backup-$timestamp"
}

function Move-ToBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    $destination = Join-Path $DestinationDirectory (Split-Path -Leaf $Path)
    Write-Host "Backing up: $Path -> $destination"
    Move-Item -LiteralPath $Path -Destination $destination
}

$codeProcesses = Get-Process -Name "Code", "Code - Insiders", "VSCodium" -ErrorAction SilentlyContinue
if ($codeProcesses) {
    Write-Error "VS Code is still running. Close every VS Code window, wait a few seconds, and run this script again."
}

Write-Host "Stopping DiCode runtime processes..."
Get-Process -Name "costrict", "completion-agent", "codebase-indexer", "cotun", "dicode" -ErrorAction SilentlyContinue |
    Stop-Process -Force

if (-not $SkipExtensionUninstall) {
    $codeCommand = Get-Command code -ErrorAction SilentlyContinue
    if ($codeCommand) {
        Write-Host "Uninstalling extension: $ExtensionId"
        & $codeCommand.Source --uninstall-extension $ExtensionId
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "The extension CLI returned exit code $LASTEXITCODE. Continuing with the recoverable cleanup."
        }
    }
    else {
        Write-Warning "The 'code' command was not found. Uninstall $ExtensionId manually before reinstalling the VSIX."
    }
}

$runtimeBackup = Join-Path $BackupRoot "runtime"
Move-ToBackup -Path (Join-Path $HOME ".costrict") -DestinationDirectory $runtimeBackup
Move-ToBackup -Path (Join-Path $HOME ".dicode") -DestinationDirectory $runtimeBackup

$extensionBackup = Join-Path $BackupRoot "extensions"
$extensionRoots = @(
    (Join-Path $HOME ".vscode\extensions"),
    (Join-Path $HOME ".vscode-insiders\extensions")
)

foreach ($extensionRoot in $extensionRoots) {
    if (-not (Test-Path -LiteralPath $extensionRoot)) {
        continue
    }

    Get-ChildItem -LiteralPath $extensionRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$ExtensionId-*" } |
        ForEach-Object {
            Move-ToBackup -Path $_.FullName -DestinationDirectory $extensionBackup
        }
}

Write-Host ""
Write-Host "DiCode cleanup completed."
Write-Host "Backup directory: $BackupRoot"
Write-Host "Next: install the current VSIX with 'code --install-extension <path-to-vsix> --force', start VS Code, and log in again."

