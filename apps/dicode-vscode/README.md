# DiCode VS Code extension

DiCode runs the unmodified Codex CLI 0.164 app-server as its agent. The extension supplies DiCode credentials, the model catalog, workspace integration, and a React + TypeScript webview built with Vite. The webview bundle is packaged in the VSIX and uses VS Code theme variables.

## File editing

Each new Codex thread registers three dynamic tools through `thread/start`: `write_file`, `replace_file_text`, and `delete_file`. Codex calls them through `item/tool/call`; the extension checks that the target stays inside the workspace, performs the edit, returns the tool result, and emits a `fileChange` item with an inline unified diff. In request permission mode, the extension asks before an edit. The developer prompt asks the model to use these tools for text file changes.

The extension does not scan the workspace to infer edits made by shell commands. A shell command that writes a file remains a command event in the conversation. Native Codex `fileChange` events also render as file edits. A saved thread from an older DiCode version is archived when the next task starts, then a new thread is created with dynamic tools. Its previous conversation remains available in recent threads.

The UI renders command and file rows from Codex item events, folds command output, and hides the portable PowerShell launcher from displayed commands while keeping the working directory visible. File names in text open the current file; edit events open the historical diff, including for files subsequently deleted. The final file summary opens a separate panel with a collapsible diff for each changed file. It shows up to three files by default and uses the turn's cumulative diff to omit intermediate changes. Process activity shows elapsed time while running and folds after a turn completes; the final answer stays visible.

The composer offers low, medium and high reasoning effort. The context indicator uses the current thread's latest `thread/tokenUsage/updated` value and the selected model's `contextWindow` from the model endpoint; the details also show the CLI's usable window and the model's `maxTokens`. Model catalog entries pass the real context window to Codex, which controls automatic compaction using its own threshold. Manual compaction sends `thread/compact/start`; both paths display Codex's `contextCompaction` items in the conversation. Until the CLI reports usage, the indicator shows an unknown value rather than an estimate.

## Build and test

```text
npm ci
npm run check
npm test
npx vsce package --no-dependencies
```

Set `dicodeCodex.serverUrl` to the DiCode APISIX entry. The extension downloads a verified Codex CLI package from the portal on first activation, or uses `dicodeCodex.codexPath` if configured. Windows also uses a verified portable PowerShell package. The installed Codex CLI must support the experimental app-server dynamic tools protocol used by version 0.164.

### 本地附件

输入框左侧的“添加文件”可选择任意类型的普通文件（单个不超过 50 MB）。附件副本保存在当前工作区的 `.dicode/attachments`，历史消息保留文件卡片；如不希望提交附件，可将该目录加入项目忽略规则。

PNG、JPEG、WebP、GIF 图片作为图片输入提交给模型；小于 64 KB 的 UTF-8 文本会同时提供内容，其他文件通过副本路径供 Agent 工具读取。PDF、Office、压缩包及其他二进制格式的解析取决于环境中的工具，不等同于 Responses API 的原生文件上传。图片可点击放大，其他附件点击后使用 VS Code 打开。
