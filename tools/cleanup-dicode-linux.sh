#!/usr/bin/env bash

set -eu

extension_id="${DICODE_EXTENSION_ID:-atad-apts.dicode}"
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_root="${DICODE_BACKUP_ROOT:-$HOME/dicode-cleanup-backup-$timestamp}"
skip_extension_uninstall="${DICODE_SKIP_EXTENSION_UNINSTALL:-0}"

if pgrep -u "$(id -u)" -f '(^|/)(code|code-insiders|codium)( |$)|\.vscode-server/.*/node.*extensionHost' >/dev/null 2>&1; then
    echo "VS Code or a VS Code extension host is still running." >&2
    echo "Close every local/remote VS Code window, wait a few seconds, and run this script again." >&2
    exit 1
fi

move_to_backup() {
    source_path="$1"
    destination_directory="$2"

    if [ ! -e "$source_path" ]; then
        return
    fi

    mkdir -p "$destination_directory"
    echo "Backing up: $source_path -> $destination_directory/"
    mv -- "$source_path" "$destination_directory/"
}

echo "Stopping DiCode runtime processes..."
pkill -u "$(id -u)" -x costrict 2>/dev/null || true
pkill -u "$(id -u)" -x completion-agent 2>/dev/null || true
pkill -u "$(id -u)" -x codebase-indexer 2>/dev/null || true
pkill -u "$(id -u)" -x cotun 2>/dev/null || true
pkill -u "$(id -u)" -x dicode 2>/dev/null || true

if [ "$skip_extension_uninstall" != "1" ]; then
    if command -v code >/dev/null 2>&1; then
        echo "Uninstalling extension: $extension_id"
        code --uninstall-extension "$extension_id" || {
            echo "Warning: the extension CLI failed; continuing with the recoverable cleanup." >&2
        }
    else
        echo "Warning: the 'code' command was not found. Uninstall $extension_id manually before reinstalling the VSIX." >&2
    fi
fi

runtime_backup="$backup_root/runtime"
move_to_backup "$HOME/.costrict" "$runtime_backup"
move_to_backup "$HOME/.dicode" "$runtime_backup"

extension_backup="$backup_root/extensions"
for extension_root in \
    "$HOME/.vscode/extensions" \
    "$HOME/.vscode-insiders/extensions" \
    "$HOME/.vscode-server/extensions" \
    "$HOME/.vscode-server-insiders/extensions"
do
    if [ ! -d "$extension_root" ]; then
        continue
    fi

    find "$extension_root" -mindepth 1 -maxdepth 1 -type d -name "$extension_id-*" -print0 |
        while IFS= read -r -d '' extension_path; do
            move_to_backup "$extension_path" "$extension_backup"
        done
done

echo
echo "DiCode cleanup completed."
echo "Backup directory: $backup_root"
echo "Next: install the current VSIX with 'code --install-extension <path-to-vsix> --force', start VS Code, and log in again."

