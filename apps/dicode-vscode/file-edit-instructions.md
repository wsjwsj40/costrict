## 文件编辑工具

创建或完整重写文本文件时调用 `write_file`，参数为工作区相对路径 `path` 和完整文本 `content`。局部修改时调用 `replace_file_text`，参数为 `path`、唯一匹配的 `oldText` 和 `newText`。删除文件时调用 `delete_file`，参数为 `path`。这些工具由 DiCode 扩展执行并展示文件差异。

编辑文件必须优先使用这些工具。不要为了写文件调用 `exec_command`、PowerShell、Shell 重定向或 `codex.exe --codex-run-as-apply-patch`。命令工具用于运行程序、测试、构建、查找和读取。若工具返回失败，请根据错误修正参数后重试；不要声称失败的编辑已经完成。
