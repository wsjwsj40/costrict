# DiCode 技能市场完善规划

> 状态：阶段一待实施（已按确认意见修订）
> 范围：`apps/dicode-vscode`（VS Code 扩展 + Webview）
> 日期：2026-11-18

## 1. 现状

### 1.1 入口与链路

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 入口 | `webview/app.tsx` 顶栏「Skill 市场」 | 切到 `skills` 子页，并发送 `listSkills` |
| 列表 | `webview/Subpages.tsx:23` `SkillList` | 搜索、全部/已启用筛选、启用开关、空状态 |
| 导入 | `webview/app.tsx` 右上角「导入」 | 发送 `importSkill` |
| 消息处理 | `extension.js:1014-1040` | `importSkill` / `listSkills` / `setSkillEnabled` |
| 导入实现 | `extension.js:30-60` `importLocalSkill` | 校验 `SKILL.md`，复制到 `<workspace>/.agents/skills/<目录名>` |
| 测试 | `test/skill-import.test.js` | 覆盖导入成功、同名不覆盖、导入后刷新 |

### 1.2 当前能力

- 技能来源：Codex app-server 的 `skills/list`（`cwds: [workspace]`, `forceReload: true`）。
- 技能启停：Codex `skills/config/write`（`{ path, enabled }`），写入用户级 `[[skills.config]]`。
- 技能导入：仅支持选择本地文件夹，要求 `SKILL.md` frontmatter 含 `name` 和 `description`，拒绝符号链接与同名目录。
- 展示字段：`name`、`description`、`path`、`scope`、`enabled`、`pluginId`。

**结论：当前页面本质是「本地已安装技能管理器」，缺少详情、删除、更新、压缩包导入和远程市场能力。**

### 1.3 现存问题

1. **未登录时本地技能不可用**：`listSkills` / `setSkillEnabled` 都经过 `ensureClient()` → `accessToken()`，未登录直接抛「请先登录」。
2. **加载与错误反馈不完整**：无真正的加载态；`skillsError` 只覆盖列表失败，启停失败走通用 `error` 消息而技能页不展示；分条 `errors` 被压缩成一句「部分技能加载失败」。
3. **无详情页**：看不到 `SKILL.md` 内容、来源、完整路径和文件列表。
4. **无删除/卸载/更新**：导入后只能启停，目录需要手动清理；重复导入只提示「目录已存在」。
5. **启停不可靠**：非乐观更新、无逐项 pending、无失败回滚，快速点击可能并发写入。
6. **导入能力有限**：仅支持文件夹，不支持 zip；无覆盖、重命名、进度和体积限制。
7. **可发现性弱**：只有「全部/已启用」筛选，没有来源分组、排序和分类。
8. **刷新时机少**：仅打开页面、导入、启停后刷新；外部变更不可见。
9. **数据模型未定义**：前端以 `any` 处理，以 `path` 作为 key。
10. **命名不符**：入口叫「Skill 市场」，实际是本地管理。

### 1.4 登录、API Key 与本地技能链路分析

**当前代码逻辑与目标不一致：未登录时不能正常使用本地技能。**

- `listSkills` → `ensureClient()` → `accessToken()`，没有 OIDC token 时直接抛错。
- `setSkillEnabled` 同样依赖登录后的 Codex client。
- `importSkill` 本身只做文件复制，不依赖登录；但导入后调用 `listSkills` 刷新，未登录时会被拒绝，表现为「文件已复制但页面报错、列表不显示」。
- 技能页虽然能在未登录时渲染，但拿不到任何数据。

**当前不支持用户自带 API Key：**

- 扩展只有 OIDC 登录一种鉴权方式，token 存放于 SecretStorage。
- Codex 启动参数固定使用 `model_providers.dicode.env_key="DICODE_ACCESS_TOKEN"`，没有 API Key 配置项，也不会读取 `OPENAI_API_KEY` 或 `~/.codex/auth.json`。
- 模型列表 `${serverUrl}/ai-gateway/api/v1/models` 同样使用 OIDC token。
- 若要支持自带 API Key，需要新增配置项、SecretStorage、模型列表与 `/codex/v1` 的鉴权分支，**不属于阶段一**。

**可行性判断：**

- Codex app-server 的 `skills/list`、`skills/config/write` 是本地 RPC；官方文档未要求启动或调用这些方法前必须登录/提供 API Key。
- 因此可以新增一个**独立的本地技能 client**：不要求 OIDC token，只启动 app-server 用于技能扫描与启停；会话 client 仍保持现有登录逻辑。
- 实现前需用仓库实际使用的 Codex CLI 做一次小验证：确认空 token 启动 app-server 后 `skills/list`、`skills/config/write` 可正常调用。若该版本仍强制校验，则退化为自行扫描技能目录 + 写入用户级配置的方案（成本更高，作为后备）。

## 2. 本轮范围与产品结构

### 2.1 已确认

- **本轮只做阶段一：本地技能管理。**
- 远程技能市场暂停；内网服务端不在本仓库，待可访问后再做。
- 本地页面名称：**技能管理**；未来远程页面名称：**Skill Hub**。
- 允许删除用户级技能；系统/组织来源只读。
- 导入支持文件夹和 **zip**。
- 未登录也能使用本地技能；未登录时不能访问远程市场。

### 2.2 页面结构

| 页面 | 本轮 | 说明 |
| --- | --- | --- |
| 技能管理 | 实现 | 顶栏入口，管理本地已安装技能 |
| Skill Hub | 不实现 | 未来远程市场入口，本轮仅在代码/文档中预留命名，不放置不可用的死入口 |

## 3. 阶段一：本地技能管理实施计划

### 3.1 数据模型与消息协议

Webview 侧新增 `webview/skills.ts`，统一技能模型：

```ts
type SkillScope = 'user' | 'repo' | 'system' | 'admin' | 'unknown'

type Skill = {
  id: string          // 稳定标识，优先 path，其次 scope + name
  name: string
  description: string
  path?: string       // Codex 返回的技能路径（通常是 SKILL.md）
  dir?: string        // 技能目录
  scope?: SkillScope
  enabled: boolean
  pluginId?: string
  source?: 'local' | 'imported'
}
```

不同 Codex 版本可能让 `path` 指向 `SKILL.md` 文件，也可能指向技能目录；实现时统一归一化：目录则拼接 `SKILL.md`，文件则直接使用，删除时取所在目录。

消息约定：

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| Webview → 扩展 | `listSkills` | 拉取列表 |
| | `importSkill` | 支持文件夹 / zip，参数 `{ mode?: 'folder' | 'zip' }` |
| | `setSkillEnabled` | `{ path, enabled }` |
| | `getSkillDetail` | `{ path }`，返回元数据 + `SKILL.md` + 文件列表 |
| | `openSkillFile` / `revealSkill` | 打开 `SKILL.md` / 在资源管理器中显示 |
| | `deleteSkill` | `{ path }`，仅允许可管理来源 |
| 扩展 → Webview | `skills` | `{ skills, errors, loading }` |
| | `skillsDetail` | `{ skill, content, files }` |
| | `skillsError` | `{ message, path? }` |
| | `skillsNotice` | 导入/删除/启停成功的轻提示 |

保持对旧消息兼容。

### 3.2 未登录可用的本地技能

核心改造：把「本地技能操作」与「登录会话」解耦。

1. 新增 `ensureSkillClient()`：
   - 不调用 `accessToken()`；启动独立的 Codex app-server 实例。
   - 模型目录使用 CLI 自带模型构造，不依赖 `/ai-gateway` 返回的模型列表。
   - 仅用于 `skills/list` 和 `skills/config/write`，不复用会话 client。
2. `importSkill`、`getSkillDetail`、`deleteSkill`、`openSkillFile`、`revealSkill` 使用纯文件系统操作，不依赖 client 和登录。
3. `listSkills` / `setSkillEnabled` 使用 `ensureSkillClient()`。
4. 用户登录后，会话 client 与技能 client 相互独立；退出登录只清理会话 client，不影响技能页。
5. 若 Codex CLI 尚未安装，沿用 `ensureBinary()` 的下载/配置逻辑；失败时给出「设置 `dicodeCodex.codexPath` 或登录后安装」的提示。
6. 实现前先验证空 token 启动 app-server 的行为；若不可行，改为本地扫描技能目录 + 用户配置写入，并在文档中记录差异。

### 3.3 列表页

- 页面标题与入口文案改为「技能管理」。
- 增加手动刷新按钮；刷新期间禁用并显示加载态。
- 增加加载骨架、错误状态与「重试」。
- 筛选：全部 / 已启用 / 已禁用；按来源（工作区 / 个人 / 组织 / 系统）筛选或分组。
- 显示各来源数量与启用数量；按启用状态、名称稳定排序。
- 搜索范围覆盖名称、描述、来源文案与路径。
- 点击列表行进入详情页；开关独立操作，不触发跳转。

### 3.4 详情页

- 展示名称、描述、来源、完整路径、启用状态。
- 直接读取并渲染本地 `SKILL.md`（复用现有 Markdown 渲染和安全链接处理）。
- 展示技能目录下的文件列表（限制深度、数量和单文件体积）。
- 操作：启用/禁用、打开 `SKILL.md`、在资源管理器中显示、删除。
- 路径安全：只允许读取已知技能根目录内的文件，拒绝 `..`、绝对路径和符号链接逃逸。

### 3.5 导入（文件夹 + zip）

- 导入按钮先让用户选择「从文件夹导入」或「从 ZIP 导入」。
- 文件夹与 zip 共用同一套校验：
  - 必须包含 `SKILL.md`，frontmatter 含 `name`、`description`；
  - 限制压缩包体积、解压后总体积、文件数量；
  - 拒绝符号链接、加密条目、绝对路径和 `..` 路径。
- zip 解压到临时目录，校验通过后再移动到 `<workspace>/.agents/skills/<目录名>`；失败清理临时目录。
- 兼容 zip 内只有一层根目录的常见结构（自动剥离）。
- 同名目录提供「覆盖 / 重命名 / 取消」；覆盖前备份，失败回滚。
- 导入过程显示进度；成功后刷新列表并提示，可选择跳转详情。
- zip 解析建议在仓库内实现一个精简读取器（仅支持 store/deflate，校验 CRC 与大小），避免给扩展宿主新增运行时依赖和 VSIX 打包负担；测试中用 Node `zlib` 生成测试包。

### 3.6 启停可靠性

- 乐观更新：点击后立即切换 UI。
- 逐项 pending：写入期间禁用该行开关，避免并发。
- 失败回滚并显示具体原因；成功静默或轻提示。
- 刷新失败时保留上一次有效数据。

### 3.7 删除/卸载

- 删除前弹出模态确认，明确显示将删除的目录。
- **允许删除用户级与工作区级技能**；`system` / `admin` 来源只读。
- 使用 VS Code 回收站能力（`workspace.fs.delete(..., { useTrash: true })`），失败时提示可手动处理。
- 删除后刷新列表并回到列表页。

### 3.8 状态、文案与可访问性

- 页面/入口统一为「技能管理」。
- 列表行使用可聚焦的按钮/链接语义；开关保留 `role="switch"` 与 `aria-checked`。
- 统一空状态、加载态、错误态和成功提示样式。
- 窄宽度下标题、描述与开关不重叠。

### 3.9 测试与验收

扩展侧测试：

- 未登录时 `listSkills` 可返回本地技能，不触发 `accessToken`；
- 未登录时启停可用；
- 列表失败、分条错误展示；
- 启停失败回滚；
- 文件夹/zip 导入成功、同名覆盖/重命名/取消；
- zip 路径穿越、符号链接、超大包被拒绝；
- 删除权限保护（system/admin 不可删）；
- 详情读取的路径安全。

Webview 测试（沿用 `test/webview.test.js` 的 jsdom 方式）：

- 搜索与筛选；
- 点击行进入详情、返回；
- 开关乐观更新与失败恢复；
- 加载/错误/空状态；
- 未登录时技能管理页可用。

验证命令：`npm run check`、`npm test`、`npm run build`。

## 4. 阶段二：Skill Hub（暂不实施）

### 4.1 已确认的远程接口形态

- 接口在内网，当前不可访问；服务端不在本仓库。
- 远程列表按接口返回的数据**分页展示**。
- 远程详情接口直接返回**概览文档和部分结构化数据**，无需下载 zip 即可查看技能概览。
- 本地技能详情直接读取本地 `SKILL.md`。

### 4.2 后续实现要点

- 新增独立入口/页面「Skill Hub」，与「技能管理」分开。
- 未登录：只能使用技能管理，不能访问 Skill Hub。
- 列表：搜索、分类、分页，完全以接口返回为准。
- 详情：展示接口返回的概览文档和结构化字段；安装/更新/卸载另行设计。
- 若后续需要安装远程技能，再设计 zip 下载、哈希校验、安全解压与版本记录。
- Codex 本身存在 `skills/remote/read` / `skills/remote/write`（官方标注开发中），是否复用需结合内网接口再评估。

## 5. 阶段三（可选）

- 组织内发布、审核与可见范围。
- 收藏、推荐、使用统计。
- 自动检查更新、批量更新、版本回滚。
- 多语言文案。

## 6. 文件与模块影响

| 文件/模块 | 变更 |
| --- | --- |
| `apps/dicode-vscode/extension.js` | 技能消息处理、未登录技能 client、详情、删除、zip 导入、路径校验 |
| 新增 `apps/dicode-vscode/skills.js` | 技能归一化、zip 读取、安装/删除/详情与安全检查，便于单测 |
| `apps/dicode-vscode/webview/skills.ts`（建议） | 技能类型与纯函数（过滤/排序/搜索） |
| `apps/dicode-vscode/webview/app.tsx` | 页面路由、技能状态、消息处理、提示 |
| `apps/dicode-vscode/webview/Subpages.tsx` | `SkillList` 增强、技能详情页 |
| `apps/dicode-vscode/webview/style.css` | 列表、详情、加载/错误/提示样式 |
| `apps/dicode-vscode/test/skill-import.test.js` | 扩充导入、删除、启停、未登录、zip 测试 |
| 新增 `apps/dicode-vscode/test/skills.test.js` | zip 解析与路径安全测试 |
| `apps/dicode-vscode/README.md` / `docs/` | 使用说明 |

## 7. 验收标准

- [ ] 未登录可打开「技能管理」，查看、导入、启停、删除本地技能。
- [ ] 未登录时访问远程能力被明确限制（本轮无远程入口）。
- [ ] 技能页有加载/错误/空状态与手动刷新，可重试。
- [ ] 列表支持来源筛选/分组与完整搜索。
- [ ] 点击技能可查看详情与本地 `SKILL.md`。
- [ ] 导入支持文件夹与 zip；同名可覆盖/重命名/取消，失败不破坏已有技能。
- [ ] zip 导入拒绝路径穿越、符号链接、超限包。
- [ ] 启停为乐观更新，失败自动回滚并提示原因。
- [ ] 可删除用户级/工作区级技能；系统/组织技能不可删。
- [ ] 详情读取和删除有路径安全校验。
- [ ] `npm run check`、`npm test`、`npm run build` 全部通过。

## 8. 已确认决策

1. 本轮只做阶段一（本地技能管理）。
2. 远程市场暂不实施，服务端在内网其他仓库。
3. 允许删除用户级技能。
4. 导入支持文件夹和 zip。
5. 未登录可使用本地技能，不能访问远程市场。
6. 本地页面叫「技能管理」，远程页面叫「Skill Hub」。

## 9. 待确认的实施细节

1. **zip 限制**：建议压缩包 ≤ 20 MB、解压后 ≤ 100 MB、文件数 ≤ 500；是否接受？
2. **Skill Hub 入口**：本轮不放入口（推荐），还是放一个「即将上线」占位？
3. **技能来源展示**：按 Codex 返回的 scope 展示为「个人 / 工作区 / 组织 / 系统」；若实际 scope 只有 `user/repo/public`，按实际映射，未知来源显示「其他」。
4. **版本发布**：阶段一完成后是否递增扩展版本并打 VSIX？

## 10. 建议执行顺序

1. 验证未登录启动 Codex app-server 并调用技能 RPC。
2. 数据模型与扩展侧技能模块（含 zip 读取、路径安全）。
3. 列表页与未登录链路。
4. 详情页。
5. 导入（文件夹 + zip）与删除。
6. 启停可靠性与提示。
7. 测试、`npm run check`、构建，提交。
