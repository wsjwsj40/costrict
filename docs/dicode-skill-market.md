# DiCode Skill 市场开发规划

> 状态：规划定稿，分阶段实施（代码未改动）
> 分支：`feat/skill-market`
> 范围：`apps/dicode-vscode`（VS Code 扩展 + Webview）
> 需求依据：产品需求文档 V4.0.1【P0】Skill 市场与一键安装，以及跨会话异步执行、IDE 布局、事件恢复中与 Skill 安装相关的条款
> 设计参考：`docs/design/dicode-vscode-ui-prototype.html`、`docs/design/dicode-webview-ui.md`
> 日期：2026-11-18

需求文档与截图含内部信息，不纳入本仓库，仅在本地维护。本文档是唯一入库的实施依据，需求变更时同步更新此处。

## 1. 范围与环境约束

### 1.1 实施范围

全部纳入，不裁剪：

- **市场浏览**：入口与布局、搜索与筛选、卡片字段、详情、缺省与异常状态。
- **安装**：五态状态机、安装链路、去重、后台继续、失败与重试、索引刷新。
- **持久化与恢复**：按工作区的安装登记、离线可用、安装事件与重连。
- **本地能力**：未登录可用、文件夹与 zip 导入、技能详情、删除、启停。

### 1.2 环境约束与应对

| 约束 | 影响 | 应对 |
| --- | --- | --- |
| 市场接口在内网，当前不可达 | 无法联调真实目录与下载 | 阶段 0–3 用桩数据与本地桩包打通全链路，数据源单独隔离，阶段 4 只替换实现 |
| 内网账户与真实技能包不可得 | 无法验证真实兼容性与组织策略 | 兼容状态、组织限制、来源校验在桩数据中构造用例，逻辑先落地，阶段 4 校准 |
| Codex CLI 行为未验证 | 未登录能否调用技能 RPC 未知 | 阶段 1 首项即做验证，并备好退化方案 |
| 本地无 VSIX 发布链路验证 | 版本递增与打包未定 | 归入阶段 5，不影响功能开发 |

### 1.3 其他模块边界

- 终端/CLI 的 Skill 安装：终端组件不在本仓库，阶段 5 只保证扩展侧安装入口可被复用。
- 消息提醒中的安装失败：需求的消息提醒只覆盖任务待决策与任务动态，本模块不扩展提醒。
- 跨会话记忆、待决策强提醒：属 V4.0.2，由对应模块负责。

## 2. 分步实施路线

### 2.1 划分原则

按环境依赖切分：先做不依赖外部条件的部分，再做依赖本地可验证条件的部分，最后做必须依赖内网的接入。每个阶段可单独交付、单独验收，中断后可从下一阶段继续。

### 2.2 阶段总览

| 阶段 | 主题 | 外部依赖 | 主要产出 |
| --- | --- | --- | --- |
| 0 | 数据底座 | 无 | 模型、状态推导、登记读写 |
| 1 | 本地能力 | Codex CLI | 导入（文件夹 + zip）、详情、删除、启停、技能 client |
| 2 | 市场浏览 | 无（桩数据） | 列表、详情、布局、缓存与离线 |
| 3 | 安装链路 | 无（本地桩包） | 安装管道、去重、回滚、中断恢复、索引刷新 |
| 4 | 真实接口接入 | 内网接口 | 契约校准、联调、错误码映射 |
| 5 | 收尾与增强 | 内网 + 发布链路 | 版本升级入口、CLI 复用、打包发布 |

阶段 0–3 完全可在本地完成。阶段 4 是唯一硬依赖内网的阶段。

### 2.3 各阶段任务

**阶段 0：数据底座**

- 产出：`skillsModel.js`（类型、`compareVersion`、状态推导、去重键）、`skillsRegistry.js`（登记读写、原子写、短锁、损坏恢复）。
- 关键点：登记是「已安装」与离线可用的唯一真相来源，路径与格式在本阶段定死。
- 验证：`skills-registry.test.js` 覆盖原子写、并发锁、损坏恢复、跨窗口读一致性。

**阶段 1：本地能力**

- 前置验证：空 token 启动 app-server 后 `skills/list`、`skills/config/write` 是否可用。可用则走独立技能 client；不可用则退化为自行扫描技能目录 + 写用户级配置，并在本文档记录差异。
- 产出：`ensureSkillClient()`、`skillArchive.js`（zip 读取与安全解压）、导入（文件夹 + zip，含覆盖/重命名/取消）、`getSkillDetail` / `deleteSkill` / `openSkillFile` / `revealSkill`、启停乐观更新与回滚。
- 关键点：导入成功后写 `source: import` 的登记记录，使「已安装」筛选与离线可用同时覆盖本地导入项。
- 验证：未登录状态下可列举、查看详情、导入、删除、启停；`system` / `admin` 来源不可删。

**阶段 2：市场浏览**

- 产出：`marketStub.js`（覆盖五态与四类错误）、`skillMarket.js`（数据源抽象，桩与真实接口同一出口）、`webview/skills.ts`、`webview/Market.tsx`、列表与详情样式。
- 关键点：搜索、两筛选、卡片字段（含版本与兼容状态）、骨架、缓存过期标注、离线已安装；最大化态列表与详情并排。
- 验证：jsdom 覆盖筛选与五态按钮；手工走查 VS Code 深/浅与 JetBrains 深/浅四套主题。
- 风险：设计稿缺版本、简介、兼容状态与详情页，字段先按需求实现并留空态兜底。

**阶段 3：安装链路**

- 产出：`skillInstaller.js`（下载、摘要校验、解压、登记、覆盖回滚）、安装任务表与事件、事件幂等、中断恢复、索引刷新。
- 关键点：去重键 `(workspaceId, skillId, version)`；覆盖用 `.new` / `.bak` 目录切换；失败清理临时文件且旧版本可用；重连先快照后增量。
- 验证：连续点击只产生一个 `jobId`；摘要不符、来源校验失败、不兼容、组织限制四类被拦截；覆盖失败回滚；扩展重启后中间态转 `INTERRUPTED`。

**阶段 4：真实接口接入**

- 产出：`skillMarket.js` 真实实现、鉴权、分页、错误码映射、缓存 TTL、真实下载与摘要来源。
- 关键点：契约以服务端实际响应校准，字段缺失在适配层补齐，不把服务端差异泄漏到 UI。
- 验证：逐条核对 12.2 验收表；目录失败、超时、离线三条路径均能回到可用状态。

**阶段 5：收尾与增强**

- 技能版本升级与回滚的独立入口、CLI 侧复用安装、版本递增与 VSIX 打包、使用文档。
- 进入条件：阶段 0–4 验收通过。

### 2.4 需求覆盖矩阵

| 需求条款 | 阶段 |
| --- | --- |
| 入口、导航、草稿保留、窄面板与最大化并排 | 2 |
| 列表：搜索、两项筛选、卡片六字段 | 2 |
| 详情：用途、来源、版本、声明能力、示例 | 2 |
| 骨架、目录失败保留缓存并重试、已安装离线可读 | 2（离线依赖阶段 0 登记） |
| 可安装 → 安装中 → 已安装 → 可重试 → 不可安装五态 | 3（不可安装策略在 4 校准） |
| 安装链路固定 ID、版本、摘要 | 3 |
| 同工作区 + Skill + 版本去重，后台继续 | 3 |
| 安装后刷新列表与 Agent Skill 索引 | 3 |
| 失败清理临时文件、旧版本继续可用 | 3 |
| 安装事件字段与按工作区持久化 | 3（持久化底座在 0） |
| 并行请求共用安装任务 | 3 |
| 重连快照 + 增量补齐 | 3 |
| 未登录可用本地技能、导入、删除、启停 | 1 |
| 真实目录、真实包、真实兼容与组织策略 | 4 |

## 3. 产品形态

### 3.1 入口与布局

- 左上导航第 2 项【Skill 市场】进入，回到对话后保留输入中草稿。
- 窄面板：市场占据插件内容区，列表与详情为前后两级。
- 最大化态：列表与详情并排（左侧列表、右侧详情）。
- 切换导航项不重建市场状态，已发起的安装任务不受影响。

### 3.2 列表

- 顶部：搜索框 + 两个筛选项【全部】【已安装】，不做第三个筛选。
- 搜索匹配名称、简介、标签三项；本地已安装项额外匹配路径。
- 卡片展示：名称、发布者、版本、简介、兼容状态、安装操作。
- 【已安装】以当前工作区登记记录为准，不以远程目录返回为准。
- 排序按发布者 + 名称稳定排序，避免刷新跳动；已安装项不提前置顶。

### 3.3 详情

- 字段：用途、来源、版本、声明能力、示例。
- 远程详情由接口返回概览与结构化字段，不下载包即可查看。
- 本地已安装项直接读本地 `SKILL.md`。
- 详情内的安装/重试操作复用列表的状态机。

### 3.4 缺省与异常状态

| 场景 | 表现 |
| --- | --- |
| 初次加载 | 骨架屏或加载提示，不显示空态 |
| 目录请求失败 | 有缓存则展示缓存并标注已过期 + 重试；无缓存则错误态 + 重试 |
| 已安装列表 | 离线可读，来自本地登记 |
| 搜索无结果 | 空态提示，保留当前筛选条件 |
| 单条安装失败 | 该条转【重试】并保留失败原因，不影响其他条目 |

## 4. 现状

### 4.1 现有链路

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 入口 | `webview/app.tsx` 顶栏「Skill 市场」 | 切到 `skills` 子页，并发送 `listSkills` |
| 列表 | `webview/Subpages.tsx:23` `SkillList` | 搜索、全部/已启用筛选、启用开关、空状态 |
| 导入 | `webview/app.tsx` 右上角「导入」 | 发送 `importSkill` |
| 消息处理 | `extension.js:1014-1038` | `importSkill` / `listSkills` / `setSkillEnabled` |
| 导入实现 | `extension.js:30-61` `importLocalSkill` | 校验 `SKILL.md` frontmatter，复制到 `<workspace>/.agents/skills/<目录名>`，拒绝符号链接与同名覆盖 |
| 测试 | `test/skill-import.test.js` | 导入成功、同名不覆盖、导入后刷新 |

技能数据来自 Codex app-server：列表 `skills/list`（`cwds: [workspace]`, `forceReload: true`），启停 `skills/config/write`，字段为 `name`、`description`、`path`、`scope`、`enabled`、`pluginId`。

### 4.2 与目标的差距

1. 没有远程目录：无接口、无分页、无版本与兼容状态。
2. 没有安装链路：只能从本地导入。
3. 没有登记记录：「已安装」靠实时扫描，离线不可用，也无法区分来源。
4. 没有详情页：看不到 `SKILL.md`、来源、文件列表。
5. 没有删除：导入后只能启停，目录需手动清理。
6. 未登录不可用：`listSkills` / `setSkillEnabled` 经 `ensureClient()` → `accessToken()`，未登录直接抛错；`importSkill` 虽不依赖登录，但导入后刷新被拒，表现为「文件已复制但页面报错」。
7. 状态反馈不完整：无真正加载态，启停失败走通用 `error` 且技能页不展示，分条 `errors` 被压成一句话。
8. 启停不可靠：非乐观更新、无逐项 pending、无失败回滚。
9. 数据模型未定义：前端以 `any` 处理，以 `path` 作 key。
10. 导入能力有限：仅支持文件夹，无 zip、无覆盖与重命名。

## 5. 数据模型

新增 `apps/dicode-vscode/skillsModel.js`，扩展侧与 webview 共用一份字段定义；webview 侧再导出 TypeScript 类型。时间用毫秒时间戳，版本比较不引第三方依赖，自行实现 `compareVersion`。

### 5.1 市场目录项

```js
/** @typedef {Object} MarketSkill
 * @property {string} id            市场内稳定标识，安装一律以 id + version 定位
 * @property {string} name
 * @property {string} publisher
 * @property {string} version
 * @property {string} summary       列表用一句话简介，参与搜索
 * @property {string[]} tags        参与搜索
 * @property {string} digest        Skill 包摘要，安装与升级校验用
 * @property {'compatible'|'incompatible'|'restricted'} compat
 * @property {string} [minClientVersion]  incompatible 时给出最低客户端版本
 * @property {string} [compatReason]      restricted 时的组织策略说明
 * @property {number} [updatedAt]
 */
```

### 5.2 安装登记（按工作区持久化）

登记是【已安装】筛选与离线可用的唯一依据，存于 `<workspace>/.agents/skills.registry.json`。市场安装与本地导入都要写登记，区别仅在 `source`：

```js
/** @typedef {Object} InstallRecord
 * @property {string} skillId        market 安装取目录项 id；本地导入取 SKILL.md 的 name
 * @property {string} version        market 取目录项版本；本地导入为 '0.0.0-local'
 * @property {string} digest         market 取包摘要；本地导入为目录内容的 sha256
 * @property {string} dir            相对工作区的安装目录，如 .agents/skills/review
 * @property {'market'|'import'|'system'} source
 * @property {number} installedAt
 * @property {string} [publisher]
 * @property {string} [name]
 * @property {boolean} [indexStale]  登记成功但 Agent 索引未刷新
 */
```

写入要求：先写 `.registry.json.tmp` 再 `rename`；多窗口用 `.registry.json.lock` 短锁；解析失败视为空登记并把损坏文件留为 `.bak`，不阻塞页面。

### 5.3 安装任务

```js
/** @typedef {Object} InstallJob
 * @property {string} jobId
 * @property {string} skillId
 * @property {string} version
 * @property {string} digest
 * @property {'queued'|'downloading'|'verifying'|'extracting'|'registering'|'done'|'failed'} state
 * @property {number} [progress]     0-100，下载阶段有效
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {boolean} retryable
 * @property {number} startedAt
 * @property {number} [finishedAt]
 */
```

### 5.4 安装状态机

```
ready ──install──▶ installing ──ok──▶ installed
                      │
                      ├──retryable fail──▶ failed ──retry──▶ installing
                      └──non-retryable──▶ blocked（保留原因，不可重试）
```

- `installing` 细分管道阶段（downloading → verifying → extracting → registering），UI 统一显示【安装中…】。
- `installed` 判定：登记存在且 `digest` 与目录一致；仅 `skillId` 命中但版本不同，视为可升级，按钮仍为【安装】。
- `failed` 转 `retry` 的条件是 `retryable: true`，取值见 7.1；不可重试的错误直接进 `blocked` 并展示原因，不提供重试按钮。

## 6. 消息协议

扩展侧统一在 `extension.js` 的消息分支处理，实现放独立模块。旧消息保持兼容，不删不改语义。

| 方向 | 消息 | 参数 / 返回 | 说明 |
| --- | --- | --- | --- |
| Webview → 扩展 | `marketList` | `{ query?, cursor? }` | 拉远程目录，分页；筛选全在本地做 |
| | `marketDetail` | `{ skillId, version? }` | 远程详情 |
| | `marketInstall` | `{ skillId, version, digest }` | 提交安装，返回 `jobId` |
| | `marketRetry` | `{ jobId }` | 重试可重试的失败任务 |
| | `installedList` | 无 | 读工作区登记，离线可用 |
| | `listSkills` | 无 | 取 Codex 技能索引 |
| | `getSkillDetail` | `{ path }` | 本地详情：元数据 + `SKILL.md` + 文件列表 |
| | `importSkill` | `{ mode: 'folder' \| 'zip' }` | 本地导入 |
| | `setSkillEnabled` | `{ path, enabled }` | 启停 |
| | `deleteSkill` | `{ path }` | 仅可管理来源 |
| | `openSkillFile` / `revealSkill` | `{ path }` | 打开文件 / 资源管理器定位 |
| 扩展 → Webview | `marketCatalog` | `{ items, nextCursor, cachedAt, stale }` | `stale` 表示来自缓存 |
| | `marketDetail` | `{ skill, content }` | `content` 为概览文档 |
| | `marketError` | `{ code, message, retryable }` | 目录/详情失败 |
| | `installJobs` | `{ jobs }` | 全量快照，重连先收快照再收增量 |
| | `installEvent` | `{ jobId, skillId, version, digest, state, errorCode?, retryable?, progress? }` | 与需求的事件字段一致，`retryable` 由错误码推导 |
| | `installedSkills` | `{ records }` | 登记快照 |
| | `skills` / `skillsDetail` / `skillsError` / `skillsNotice` | 沿用 | 本地技能 |

事件合并：`installEvent` 按 `jobId` + `state` 幂等，重复事件忽略；已 `done` / `blocked` 的 `jobId` 不再接受后续事件。

## 7. 远程接口契约

接口在内网、当前不可达，本仓库先定契约，阶段 4 以服务端实际响应校准。鉴权复用现有 OIDC token，未登录不请求远程。

| 方法 | 路径 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| GET | `/skill-market/api/v1/skills` | `q`、`cursor`、`limit` | `{ items: MarketSkill[], nextCursor }` |
| GET | `/skill-market/api/v1/skills/{id}` | `version?` | `MarketSkill` + `usage`、`source`、`capabilities[]`、`examples[]`、`readme` |
| GET | `/skill-market/api/v1/skills/{id}/versions/{version}/download` | — | zip 流，响应头带 `digest` 与 `content-length` |

约束：

- 列表分页，客户端不一次拉全量；【已安装】筛选不传服务端，由本地登记过滤。
- `digest` 以服务端返回为准，客户端下载后重算比对，不一致即失败。
- 目录缓存写 `context.globalStorageUri` 下 `market-cache.json`，TTL 10 分钟；过期先展示缓存再后台刷新。

### 7.1 错误码

| errorCode | 触发 | 可重试 |
| --- | --- | --- |
| `NETWORK` | 请求超时、连接失败 | 是 |
| `UNAUTHORIZED` | token 失效 | 是（重新登录后） |
| `NOT_FOUND` | 技能或版本不存在 | 否 |
| `INCOMPATIBLE_CLIENT` | 客户端版本低于 `minClientVersion` | 否 |
| `ORG_RESTRICTED` | 组织策略限制 | 否 |
| `SOURCE_VERIFY_FAILED` | 来源/签名校验失败 | 否 |
| `DIGEST_MISMATCH` | 摘要比对不一致 | 是 |
| `DISK_FULL` | 磁盘空间不足 | 否 |
| `VERSION_CONFLICT` | 并发写入导致版本冲突 | 是 |
| `INTERRUPTED` | 扩展重启导致任务中断 | 是 |

### 7.2 桩数据

- `apps/dicode-vscode/marketStub.js` 内置一份目录与详情，覆盖五种安装状态：可安装、安装中（延迟返回）、已安装、可重试（首次必失败）、不可安装（一条 `incompatible`、一条 `restricted`）。
- 启用条件：配置项 `dicodeCodex.skillMarketStub` 为 `true`；默认关闭，避免误连。
- 桩数据只在扩展侧生效，webview 不感知来源，阶段 4 只替换 `skillMarket.js` 的数据源实现。
- 桩包是固定结构 zip（单层根目录 + `SKILL.md`），供阶段 3 打通下载、解压与登记。

## 8. 安装链路

### 8.1 管道

1. 校验：条目 `compat` 必须为 `compatible`，否则 `blocked`。
2. 去重：按 `(workspaceId, skillId, version)` 查在跑任务，命中则复用原 `jobId`。
3. 下载：写 `context.globalStorageUri/downloads/<jobId>.zip`，报进度。
4. 校验：重算 sha256 与 `digest` 比对。
5. 解压：复用 `skillArchive.js` 的安全解压规则（见 9.2），拒绝绝对路径、`..`、符号链接、加密条目。
6. 登记：校验 `SKILL.md` frontmatter 含 `name`、`description`；写入 `<workspace>/.agents/skills/<目录名>`；成功后原子写登记。
7. 刷新：`skills/list` 带 `forceReload: true`，让 Agent 索引立即生效。
8. 清理：无论成败删除临时 zip 与临时解压目录。

### 8.2 去重与并发

- 同一 `(workspaceId, skillId, version)` 只有一条 `InstallJob`，连续点击不产生第二条记录。
- 安装目录写入前加 `.lock` 短锁，超时 30 秒强制清理并报 `VERSION_CONFLICT`。
- 不同技能可并行；同一技能不同版本串行，避免互相覆盖。

### 8.3 覆盖与回滚

- 目标目录已存在且登记来源为 `market`：装到 `<dir>.new`，成功后 `<dir>` → `<dir>.bak`、`<dir>.new` → `<dir>`，再删 `.bak`。
- 任一步失败：删 `.new`，`.bak` 还原，登记保持旧版本，原版本继续可用。
- 目标目录存在但登记无记录（用户手工放置）：不覆盖，提示先删除或改名。

### 8.4 后台继续与重连

- 安装跑在扩展宿主侧，webview 关闭或切走继续执行；重开市场先收 `installJobs` 快照。
- 扩展重启：中间态任务标 `failed`（`INTERRUPTED`，可重试）；已 `done` 以登记为准重建。
- 多窗口同工作区：以登记文件为真相来源，第二个窗口只读并监听文件变化，不重复执行。

### 8.5 索引刷新

安装成功必须让 Codex 重新扫描，否则装完不可用。失败时登记已写入但标 `indexStale: true`，页面提示「已安装，索引待刷新」并提供重试。

## 9. 本地能力

### 9.1 未登录可用

1. 新增 `ensureSkillClient()`：不调用 `accessToken()`，启动独立 app-server 实例，仅用于 `skills/list` 与 `skills/config/write`；模型目录用 CLI 自带模型构造。
2. `importSkill`、`getSkillDetail`、`deleteSkill`、`openSkillFile`、`revealSkill` 走纯文件系统，不依赖 client 与登录。
3. 退出登录只清理会话 client，不影响技能页。
4. Codex CLI 未安装时沿用 `ensureBinary()`，失败提示「设置 `dicodeCodex.codexPath` 或登录后安装」。
5. 前置验证见阶段 1；不可行则退化为自行扫描技能目录 + 写用户级配置，并在此记录差异。

### 9.2 导入（文件夹 + zip）

导入入口先让用户选择「从文件夹导入」或「从 ZIP 导入」，两者共用同一套校验与落盘逻辑。

**共用校验**

- 必须包含 `SKILL.md`，frontmatter 含 `name`、`description`。
- 拒绝符号链接、加密条目、绝对路径、含 `..` 的路径。
- 目录名取 `SKILL.md` 的 `name` 归一化（小写、非法字符转 `-`）；重名时提供「覆盖 / 重命名 / 取消」。

**zip 专项**

- 仅支持 store 与 deflate，解析时校验 CRC 与声明大小，不信任压缩包头部的解压后体积。
- 限制：压缩包 ≤ 20 MB、解压后总量 ≤ 100 MB、文件数 ≤ 500、单文件 ≤ 10 MB，超限直接拒绝。
- 解压到临时目录，校验通过后再移动到 `<workspace>/.agents/skills/<目录名>`；失败清理临时目录，不动已安装版本。
- 兼容 zip 内只有一层根目录的结构并自动剥离；多层或直接放在根部的，按 `SKILL.md` 所在目录为技能根。
- 解析器自研，只依赖 Node `zlib`，不给扩展宿主新增运行时依赖。

**落盘与登记**

- 覆盖前先备份到 `<dir>.bak`，失败还原并保留原版本。
- 成功后写 `source: import` 的登记记录，并调用 `skills/list`（`forceReload: true`）刷新索引；刷新失败标 `indexStale`。
- 导入过程显示进度；成功后刷新列表并提示，可跳转详情。
- 本地导入项的 `version` 记为 `0.0.0-local`，`digest` 取目录内容 sha256，用于判断是否被外部改动。

### 9.3 删除

- 删除前模态确认，显示将删除的目录。
- 允许删除 `user` / `repo` 来源与 `source: market|import` 的登记项；`system` / `admin` 只读。
- 用 `workspace.fs.delete(..., { useTrash: true })`，同步移除登记记录。
- 删除后回列表并刷新。

### 9.4 启停

乐观更新 + 逐项 pending + 失败回滚并显示原因；刷新失败保留上一次有效数据。

## 10. 与其他需求的交点

| 需求 | 对市场的影响 |
| --- | --- |
| IDE 布局（最大化并排） | 最大化态列表与详情并排；窄面板前后两级；切换不重建状态 |
| 跨会话异步执行 | 安装按工作区调度，事件带 `workspaceId`、`jobId`、`digest`；并行请求共用任务 |
| 事件与重连模型 | `installEvent` 纳入统一事件体系，按 `jobId` 幂等，先快照后增量 |
| 权限模式与审批 | 安装属宿主侧受控动作，不触发工具审批；来源校验失败必须阻断 |
| 消息提醒 | 只覆盖任务与待决策，不含安装失败，本模块不扩展（见 1.3） |
| 深浅主题与 JetBrains | 卡片、状态按钮、骨架需覆盖四套主题 |

## 11. 文件与模块影响

| 文件/模块 | 阶段 | 变更 |
| --- | --- | --- |
| 新增 `apps/dicode-vscode/skillsModel.js` | 0 | 类型、`compareVersion`、状态推导、去重键 |
| 新增 `apps/dicode-vscode/skillsRegistry.js` | 0 | 登记读写、原子写、短锁、损坏恢复 |
| 新增 `apps/dicode-vscode/skillArchive.js` | 1 | zip 读取、安全解压、校验与临时目录管理 |
| 新增 `apps/dicode-vscode/skillMarket.js` | 2 | 目录/详情请求、缓存、分页、错误码映射 |
| 新增 `apps/dicode-vscode/marketStub.js` | 2 | 桩数据与模拟失败 |
| 新增 `apps/dicode-vscode/skillInstaller.js` | 3 | 下载、摘要校验、解压、覆盖回滚、任务表 |
| `apps/dicode-vscode/extension.js` | 1、2、3 | 消息路由、`ensureSkillClient()`、导入/删除/详情 |
| 新增 `apps/dicode-vscode/webview/skills.ts` | 2 | 类型与纯函数（过滤/排序/搜索/状态） |
| 新增 `apps/dicode-vscode/webview/Market.tsx` | 2 | 市场列表、详情、安装按钮与状态 |
| `apps/dicode-vscode/webview/app.tsx` | 1、2 | 路由、市场状态、消息处理、导入入口 |
| `apps/dicode-vscode/webview/Subpages.tsx` | 1 | `SkillList` 增强、本地详情 |
| `apps/dicode-vscode/webview/style.css` | 2 | 卡片、筛选、骨架、状态按钮、详情排版 |
| 新增 `apps/dicode-vscode/test/skills-registry.test.js` | 0 | 原子写、锁、损坏恢复 |
| 新增 `apps/dicode-vscode/test/skill-archive.test.js` | 1 | zip 解析、路径穿越、符号链接、超限 |
| `apps/dicode-vscode/test/skill-import.test.js` | 1 | 扩充 zip、覆盖、删除、启停、未登录 |
| 新增 `apps/dicode-vscode/test/skill-market.test.js` | 2 | 目录分页、缓存、错误码、桩数据 |
| 新增 `apps/dicode-vscode/test/skill-installer.test.js` | 3 | 去重、摘要校验、解压安全、回滚 |
| `apps/dicode-vscode/README.md` | 5 | 市场与本地技能使用说明 |

## 12. 测试与验收

### 12.1 分阶段测试清单

**阶段 0**

- 登记原子写、并发短锁、损坏文件留 `.bak` 后可继续读；
- 状态推导覆盖五态；`compareVersion` 对预发布与多位版本号正确。

**阶段 1**

- 未登录 `listSkills` 返回本地技能且不触发 `accessToken`；
- 详情读取的路径安全（拒绝 `..`、绝对路径、符号链接逃逸）；
- 文件夹导入成功、同名覆盖/重命名/取消，失败不破坏已有技能；
- zip 导入成功、单层根目录自动剥离；
- zip 路径穿越、符号链接、加密条目、超限包被拒绝且清理临时目录；
- 导入后写入 `source: import` 登记，列表与离线可用同时生效；
- 删除 `system` / `admin` 被拒；删除 `import` 项同步清登记；
- 启停失败回滚。

**阶段 2**

- 搜索命中名称/简介/标签；两筛选切换正确；
- 五态按钮文案与禁用状态；在途状态不可重复点击；
- 骨架、错误、空态、缓存过期标注、离线已安装；
- 最小化/最大化切换后市场状态保持；
- 四套主题下状态色可辨识。

**阶段 3**

- 连续三次安装同一版本只产生一个 `jobId`；
- 摘要不一致、来源校验失败、不兼容、组织限制四类均不写登记；
- 覆盖安装成功换版本；中途失败回滚且登记不变；
- 扩展重启后中间态转 `INTERRUPTED` 并可重试；
- 索引刷新失败标 `indexStale` 并可重试。

**阶段 4**

- 真实目录分页、超时、离线回退；
- 鉴权失效后引导重新登录；
- 错误码与服务端一致。

### 12.2 验收对照

| 验收点 | 阶段 / 方式 |
| --- | --- |
| 点击【安装】一次即可完成登记 | 3：8.1 全链路 |
| 连续点击只产生一条记录 | 3：8.2 去重 + 三次点击单 `jobId` |
| 模拟失败可恢复 | 3：桩数据必失败条目 + 重试用例 |
| 切换【已安装】或重开市场结果正确 | 2、3：登记为真相来源 + 快照重建 |
| 覆盖失败后重试、原版本继续可用 | 3：8.3 覆盖回滚 |
| 离线已安装项 | 2：5.2 登记 + 3.4 离线读 |
| 版本冲突、重复事件可识别 | 3：7.1 `VERSION_CONFLICT`、6 事件幂等 |
| 最大化时列表和详情并排 | 2：3.1、10 |
| 本地导入（文件夹与 zip）可用 | 1：9.2 + 12.1 阶段 1 |

### 12.3 验证命令

`npm run check`、`npm test`、`npm run build`（均在 `apps/dicode-vscode` 下）。每阶段结束跑全量，不只跑新增用例。

## 13. 待确认问题

1. **设计稿缺口**：原型卡片没有版本、简介、兼容状态，也没有详情页。按需求先实现、字段留空态兜底，还是等 UI 补齐？
2. **登记文件是否入库**：`<workspace>/.agents/skills.registry.json` 建议纳入版本控制以便团队共享已安装清单；若担心环境差异进入仓库，则加入 `.gitignore`。
3. **安装目录命名**：建议 `publisher__name`，避免不同发布者同名技能互相覆盖；本地导入沿用 `SKILL.md` 的 `name`。
4. **目录缓存位置**：建议全局 `globalStorageUri`，目录内容与工作区无关。
5. **`INTERRUPTED` 是否与服务端错误码表统一**：本仓库先按自定义码处理。
6. **版本发布节奏**：阶段 3 结束是否先发一版内测 VSIX，还是等阶段 4 一起发。
