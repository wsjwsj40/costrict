## Windows 文件编辑

编辑文本文件时，用当前 `exec_command` 工具：PowerShell 脚本放在字符串参数 `cmd` 中，工作目录放在 `workdir` 中。不要调用独立的 `apply_patch` 工具，也不要运行 `apply_patch`、`applypatch` 或 `apply-patch` 包装命令。

使用 PowerShell 7.3+，先检查版本，再设置 `$PSNativeCommandArgumentPassing = 'Standard'`。用 `Get-Command codex.exe -CommandType Application -ErrorAction Stop` 取得 `codex.exe` 的完整路径，再用 `&` 调用。不要直接调用 `codex`：它可能解析为 `.cmd` 或 `.bat` 包装器，损坏多行补丁参数。如果 `pwsh` 或 `codex.exe` 不可用，就停止本次编辑并说明限制；不要改用 Windows PowerShell 5.1 或 Legacy 参数模式。如果工作区沙箱拒绝写入，按 `exec_command` 的正常流程为原命令请求授权，不要换 Shell 绕过。

补丁放入 PowerShell 单引号 here-string：`@'` 后立刻换行，结束标记 `'@` 顶格独占一行。补丁正文保持原样，不要额外添加 PowerShell 转义；正文若有一行与结束标记冲突，就拆成小补丁。

补丁首行必须是 `*** Begin Patch`，末行必须是 `*** End Patch`。`*** Add File: path` 的正文每行都加 `+`，空行写成单独的 `+`。`*** Update File: path` 的新增、删除、上下文行分别以 `+`、`-`、一个空格开头，空行也要保留对应前缀。文件区块之间不要插入无前缀空行。补丁路径使用相对于 `workdir` 的路径。

`exec_command` 参数示例（替换工作目录和文件路径；JSON 只编码一次，解码后的 `cmd` 包含真实换行）：

```json
{"cmd":"$ErrorActionPreference = 'Stop'\nif ($PSVersionTable.PSVersion -lt [version]'7.3') { throw '需要 PowerShell 7.3 或更新版本。' }\n$PSNativeCommandArgumentPassing = 'Standard'\n$codexExe = (Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source\n$patch = @'\n*** Begin Patch\n*** Add File: path/to/example.js\n+const ready = true;\n*** End Patch\n'@\n& $codexExe --codex-run-as-apply-patch $patch\nexit $LASTEXITCODE","shell":"pwsh","workdir":"CURRENT_WORKSPACE"}
```

不要再套 `powershell -Command`、`cmd /c`、Bash heredoc、Base64 或 `Invoke-Expression`。修改含引号、反斜杠、正则或模板的代码后，核对落盘内容并运行合适的语法或行为检查。失败时先判断是 JSON、PowerShell、原生参数传递还是补丁语法出错，不要盲目增删转义。如果 here-string 显示有完整的 `*** End Patch`，Codex 却报“末行不是 `*** End Patch`”，先检查 `$codexExe` 是否确实指向 `codex.exe`，再用这个可执行文件重试一次。
