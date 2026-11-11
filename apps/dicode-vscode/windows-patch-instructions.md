## Windows 文件编辑

在 Windows 上，用当前 `exec_command` 工具运行 PowerShell 直接创建、修改和删除文件。`cmd` 传完整脚本，`workdir` 传工作区目录。不要调用 `apply_patch`、`applypatch`、`apply-patch` 或 `codex.exe --codex-run-as-apply-patch`；这些包装路径在此环境中的多行参数传递不稳定。

先用 `rg --files` 和 `rg -n` 找到准确文件及修改位置。只编辑用户要求的文件，保留原文件编码和换行风格。创建文件时先建立父目录；写入文本优先用 `[System.IO.File]::WriteAllText` 和明确的 UTF-8 编码。修改已有文件时先读取，检查目标片段确实存在且只出现预期次数，再替换并写回。失败时让命令以非零退出，不要报告编辑成功。

创建文件示例：

```powershell
$ErrorActionPreference = 'Stop'
$file = Join-Path (Get-Location) 'src/example.js'
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($file)) | Out-Null
$content = @'
export const ready = true
'@
[System.IO.File]::WriteAllText($file, $content, [System.Text.UTF8Encoding]::new($false))
```

修改文件示例：

```powershell
$ErrorActionPreference = 'Stop'
$file = Join-Path (Get-Location) 'src/example.js'
$content = [System.IO.File]::ReadAllText($file)
$old = 'export const ready = true'
if ($content.Split([string[]]@($old), [System.StringSplitOptions]::None).Length -ne 2) { throw '目标内容不存在或不唯一' }
$updated = $content.Replace($old, 'export const ready = false')
[System.IO.File]::WriteAllText($file, $updated, [System.Text.UTF8Encoding]::new($false))
```

删除文件用 `Remove-Item -LiteralPath $file`，先确认路径属于当前工作区。完成后读取修改处并运行相关检查。文件变更会由 Codex 的 `turn/diff/updated` 或 `fileChange` 事件呈现在对话中，不需要为了生成编辑事件再次调用补丁包装器。
