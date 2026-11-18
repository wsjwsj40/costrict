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

## Skill 市场与本地技能

左侧导航第 2 项「Skill 市场」包含【已安装】与【全部】两个页签。进入时默认停在【已安装】，返回对话时输入框草稿保留。

### 市场（【全部】）

浏览市场需要同时满足：

1. 启动 VS Code 前设置环境变量 `SKILLHUB_BASE_URL` 指向内网 SkillHub 地址；修改后需重载窗口。
2. 使用独立的 SkillHub 账号登录。该账号与 DiCode/Codex 登录互不影响，凭据只用于换取 JWT，token 保存在 VS Code SecretStorage，不写入工作区。

开发调试可把 `dicodeCodex.skillMarketStub` 设为 `true`，使用内置桩数据预览目录；未配置基地址且未开启桩时，【全部】显示配置引导而不是错误页。

- **浏览**：搜索匹配名称、简介和标签（输入防抖 400 ms），可按分类筛选，按最新发布、相关度、下载最多或评分最高排序，分页使用「加载更多」。
- **卡片**：显示名称、发布者、版本、简介、兼容状态、下载量、评分和操作按钮；需要 API Key 的技能附注「需 API Key」。列表未返回版本时显示「版本待查看详情」，打开详情后以当前发布版本为准。
- **详情**：点击技能名称打开，包含发布者、下载量、评分、标签、版本历史和 SKILL.md 概览；未安装时可从版本历史选择指定版本安装。声明能力与示例暂无结构化数据，以概览原文为准。
- **登录**：用户名 + 密码。平台开启验证码时需填写验证码，点击图片可刷新。登录失败显示服务端原因；401 会清除失效 token，重新登录后自动重新加载市场目录；403 表示账号没有该技能权限；404 时刷新列表重试。退出入口在详情抽屉底部。
- **安装状态**：
  - 【安装】：可安装；连续点击或重复提交共用同一任务。
  - 【安装中…】：排队、下载（显示百分比）、校验、解压、写登记。离开市场页面或关闭面板后安装继续，重新打开会先恢复任务快照。
  - 【已安装】：登记中已有该技能。详情页检测到更高版本时提供「更新到 vX」，复用同一条覆盖安装管道，失败回滚且旧版本继续可用。
  - 【重试】：网络、包损坏、插件重启中断等可恢复失败，失败原因保留在卡片附注。
  - 【无法安装】：不可重试的失败，如包内缺少 `SKILL.md`、来源校验失败、版本未发布或包未就绪。
  - 【不兼容】【已限制】分别表示需要更高插件版本、账号无权或技能被限制，与安装失败区分。
- **安装约束**：目标版本必须已发布（`PUBLISHED`）且安装包就绪才会创建任务；同一工作区同一技能同一版本只安装一次；每个工作区最多并行 2 个安装任务，超出进入排队；多个窗口共享任务状态。
- **安装结果**：安装到当前工作区的 `.agents/skills/<目录名>`，完成后自动刷新技能索引，无需重启即可被 Agent 发现，【已安装】与【全部】同步更新。失败会清理临时文件，已安装的旧版本不受影响。
- **缓存与离线**：市场目录缓存 10 分钟，过期先展示旧数据并在后台刷新；离线或服务不可用时仍可查看【已安装】。

### 本地技能（【已安装】）

【已安装】不依赖登录，也不发起远程请求，离线可用。列表按来源标注：

- **市场安装**：从【全部】安装，登记在市场安装记录中。
- **本地导入**：通过文件夹或 ZIP 导入，写入 `source: import` 登记，版本记为 `0.0.0-local`。
- **手工放置**：直接放进 `.agents/skills/` 的目录，不写登记，附注「未登记」。

常用操作：

- **搜索与筛选**：按名称、描述或目录搜索；可切换「全部 / 已启用」。
- **详情**：查看文件列表和 `SKILL.md` 预览，并显示来源、版本和文件数量。
- **导入**：工具栏提供「文件夹」和「ZIP」两个入口，只有【已安装】页签可以导入。
- **重新导入**：用新文件夹内容替换已登记目录，保留原 `skillId` 与来源；原目录内容与登记不一致时拒绝，不影响已安装版本。
- **移出登记**：只删除登记记录，不删除文件，随后该项显示为「手工放置」。
- **删除**：系统或组织技能只读；市场安装项和本地导入项确认后移入回收站并清理登记；手工放置项需二次确认。删除市场安装项后，可在【全部】重新安装。
- **启停**：切换技能是否启用。该操作依赖 Codex CLI 的技能索引；CLI 未就绪、目录缺失或技能未被索引收录时按钮禁用并显示原因，失败会回滚开关。
- **列表附注**：`目录已不存在`（登记有记录但目录被移走）、`未登记`（手工放置）、`索引待刷新`（安装后索引刷新失败）、`内容已变化`（目录内容与安装时摘要不一致）。附注不改变已安装状态。

导入与 ZIP 规则：

- 必须包含 `SKILL.md`，frontmatter 至少含 `name`、`description`。
- 文件夹导入以文件夹名为目录名；ZIP 内单层根目录自动剥离，含多个 `SKILL.md` 的包会被拒绝。一个包只能包含一个技能。
- ZIP 限制：压缩包不超过 20 MB、解压后总量不超过 100 MB、文件数不超过 500、单文件不超过 10 MB；只支持 store 与 deflate。
- 拒绝符号链接、加密条目、绝对路径、含 `..` 的路径和路径穿越；失败时清理临时目录，不触碰已安装版本。
- 目录名必须是单层名称、不超过 64 字符，不能以 `.` 开头，不能以点或空格结尾，不能是 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`）。名字不合规会直接拒绝，不做静默改名。
- 同名目录已存在时可选择「覆盖 / 重命名 / 取消」；被市场安装管理的目录不允许直接覆盖，需先删除市场版本。

### 数据位置

- 技能目录：`<工作区>/.agents/skills/<目录名>`。
- 安装登记：`<工作区>/.agents/skills.registry.json`，机器生成，不应提交到版本库。界面首次写入登记时会提示是否加入 `.gitignore`，也可手动处理。
- 安装任务、目录锁、下载临时包与市场缓存位于扩展的 `globalStorageUri`，不写入工作区，不随仓库同步。
- 市场安装与登记按工作区隔离；手工放置项由目录扫描发现。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 【全部】提示「市场服务未配置」 | 设置 `SKILLHUB_BASE_URL` 后重载窗口；仅做界面预览时可开启 `dicodeCodex.skillMarketStub` |
| 登录后仍提示未登录或再次要求登录 | token 可能已过期，重新登录即可；平台开启验证码时先刷新验证码图片 |
| 提示 401 / 未授权 | 重新登录 SkillHub；登录成功后会自动重新加载市场目录 |
| 提示 403 / 已限制 | 账号缺少技能权限，联系平台分配 `system:skill:list/query/download` 权限 |
| 目录请求超时或失败 | 先重试；有缓存时会继续展示上次结果，离线只影响市场，不影响【已安装】 |
| 安装失败后按钮为【重试】 | 按附注原因处理后重试；插件重启导致的中断可在重开市场后重试 |
| 安装按钮为【无法安装】 | 属于不可重试失败（包缺少 `SKILL.md`、来源校验失败、版本未就绪等），需发布方修复 |
| 安装后【已安装】没有出现 | 确认打开的是同一工作区；点击刷新或重开【已安装】页签 |
| 启停按钮灰色 | Codex CLI 未就绪或技能未被索引收录；配置 `dicodeCodex.codexPath` 或安装 CLI 后重试 |
| 导入被拒绝 | 检查 `SKILL.md` 与 frontmatter、目录名合法性、ZIP 大小与文件数；拒绝原因会显示在提示中 |
