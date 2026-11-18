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

全部纳入，不裁剪。界面分两个页签，职责不重叠：

- **【全部】远程市场**：入口与布局、搜索与筛选、卡片字段、详情、缺省与异常状态。
- **【已安装】本地技能管理**：本机索引与登记合并、来源区分、导入（文件夹与 zip）、详情、删除、启停、未登录可用。
- **安装**：五态状态机、安装链路、去重、后台继续、失败与重试、索引刷新，以及安装与删除在两页签间的同步。
- **持久化与恢复**：按工作区的安装登记、离线可用、安装事件与重连。

### 1.2 环境约束与应对

| 约束 | 影响 | 应对 |
| --- | --- | --- |
| 市场接口在内网，当前不可达 | 无法联调真实目录与下载 | 阶段 0–3 用桩数据与本地桩包打通全链路，数据源单独隔离，阶段 4 只替换实现 |
| 内网账户与真实技能包不可得 | 无法验证真实兼容性与组织策略 | 兼容状态、组织限制、来源校验在桩数据中构造用例，逻辑先落地，阶段 4 校准 |
| Codex CLI 行为未验证 | 未登录能否调用技能 RPC 未知 | 阶段 1 首项即做验证，并备好退化方案 |
| 本机未验证 VSIX 打包与分发 | 阶段 3 收尾的内测包可能受阻 | 阶段 3 开始前先跑一次 `vsce package` 验证环境，不可用则内测顺延 |

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
| 1 | 【已安装】页签 | Codex CLI | 索引与登记合并、导入（文件夹 + zip）、详情、删除、启停、技能 client |
| 2 | 【全部】市场浏览 | 无（桩数据） | 列表、详情、布局、缓存 |
| 3 | 安装链路 | 无（本地桩包） | 安装管道、去重、回滚、中断恢复、索引刷新、内测包 |
| 4 | 真实接口接入 | 内网接口 | 契约校准、联调、错误码映射 |
| 5 | 收尾与增强 | 阶段 4 之后 | 版本升级入口、CLI 复用、使用文档 |

阶段 0–3 完全可在本地完成。阶段 4 是唯一硬依赖内网的阶段。

### 2.3 各阶段任务

**阶段 0：数据底座**

- 产出：`skillsModel.js`（类型、`compareVersion`、状态推导、去重键）、`skillsRegistry.js`（登记读写、原子写、短锁、损坏恢复）。
- 关键点：登记是「已安装」与离线可用的唯一真相来源，路径与格式在本阶段定死。
- 验证：`skills-registry.test.js` 覆盖原子写、并发锁、损坏恢复、跨窗口读一致性。

**阶段 1：【已安装】页签**

- 前置验证：空 token 启动 app-server 后 `skills/list`、`skills/config/write` 是否可用。可用则走独立技能 client；不可用则退化为自行扫描技能目录 + 写用户级配置，并在本文档记录差异。
- 产出：`ensureSkillClient()`、`skillArchive.js`（zip 读取与安全解压）、`installedView`（索引与登记按 `dir` 合并、三类来源判定）、导入（文件夹 + zip，含覆盖/重命名/取消）、`getSkillDetail` / `deleteSkill` / `openSkillFile` / `revealSkill`、启停乐观更新与回滚、`webview/Installed.tsx`。
- 关键点：本页签不调用任何远程接口；导入成功后写 `source: import` 登记；手工放置项不写登记。
- 验证：未登录状态下可列举、查看详情、导入、删除、启停；三类来源都能显示；`system` / `admin` 来源不可删。

**阶段 2：【全部】市场浏览**

- 产出：`marketStub.js`（覆盖五态与四类错误）、`skillMarket.js`（数据源抽象，桩与真实接口同一出口）、`webview/skills.ts`、`webview/Market.tsx`、两页签容器与切换、列表与详情样式。
- 关键点：服务端搜索与筛选、卡片字段（含版本与兼容状态）、「已安装」标记只认 market 登记、骨架、缓存过期标注、最大化态列表与详情并排。
- 验证：jsdom 覆盖搜索、页签切换与五态按钮；手工走查 VS Code 深/浅与 JetBrains 深/浅四套主题。
- 风险：设计稿缺版本、简介、兼容状态与详情页，字段先按需求实现并留空态兜底。

**阶段 3：安装链路**

- 产出：`skillInstaller.js`（下载、摘要校验、解压、登记、覆盖回滚）、安装任务表与事件、事件幂等、中断恢复、索引刷新。
- 关键点：去重键 `(workspaceId, skillId, version)`；覆盖用 `.new` / `.bak` 目录切换；失败清理临时文件且旧版本可用；重连先快照后增量。
- 验证：连续点击只产生一个 `jobId`；摘要不符、来源校验失败、不兼容、组织限制四类被拦截；覆盖失败回滚；扩展重启后中间态转 `INTERRUPTED`。
- 收尾：递增扩展版本并打一版内测 VSIX，桩数据模式下走通真实安装流程，先收一轮问题再进阶段 4。

**阶段 4：真实接口接入**

- 产出：`skillMarket.js` 真实实现、鉴权、分页、错误码映射、缓存 TTL、真实下载与摘要来源。
- 关键点：契约以服务端实际响应校准，字段缺失在适配层补齐，不把服务端差异泄漏到 UI。
- 验证：逐条核对 12.2 验收表；目录失败、超时、离线三条路径均能回到可用状态。

**阶段 5：收尾与增强**

- 技能版本升级与回滚的独立入口、CLI 侧复用安装、使用文档。
- 进入条件：阶段 0–4 验收通过。

### 2.4 需求覆盖矩阵

| 需求条款 | 阶段 |
| --- | --- |
| 入口、导航、草稿保留、窄面板与最大化并排 | 2 |
| 【全部】列表：服务端搜索与筛选、卡片六字段 | 2 |
| 【全部】详情：用途、来源、版本、声明能力、示例 | 2 |
| 骨架、目录失败保留缓存并重试 | 2 |
| 【已安装】页签：索引与登记合并、三类来源、缺失与外部项状态 | 1 |
| 【已安装】离线可读、未登录可用 | 1（登记底座在 0） |
| 【已安装】页签：导入（文件夹与 zip）、详情、删除、启停 | 1 |
| 可安装 → 安装中 → 已安装 → 可重试 → 不可安装五态 | 3（不可安装策略在 4 校准） |
| 安装链路固定 ID、版本、摘要 | 3 |
| 同工作区 + Skill + 版本去重，后台继续 | 3 |
| 安装后刷新列表与 Agent Skill 索引 | 3 |
| 失败清理临时文件、旧版本继续可用 | 3 |
| 安装事件字段与按工作区持久化 | 3（持久化底座在 0） |
| 并行请求共用安装任务 | 3 |
| 重连快照 + 增量补齐 | 3 |
| 安装、删除在两页签间同步 | 3 |
| 真实目录、真实包、真实兼容与组织策略 | 4 |

## 3. 产品形态

### 3.1 入口与布局

- 左上导航第 2 项【Skill 市场】进入，回到对话后保留输入中草稿。
- 页内两个页签：【全部】与【已安装】。两者是两套独立数据源，不是同一份列表的过滤条件。
- 默认页签：已登录进【全部】，未登录进【已安装】，保证未登录也能管理本地技能。
- 窄面板：市场占据插件内容区，列表与详情为前后两级。
- 最大化态：列表与详情并排（左侧列表、右侧详情）。
- 切换导航项或页签不重建市场状态，已发起的安装任务不受影响。

### 3.2 两个页签

| | 【全部】 | 【已安装】 |
| --- | --- | --- |
| 定位 | 远程技能市场，检索与安装 | 本地技能管理 |
| 数据来源 | 远程目录，分页 | 本机技能索引 + 工作区登记 |
| 外部依赖 | 登录 + 内网接口 | 无（不联网、不要求登录） |
| 搜索与筛选 | 下发服务端（`q`、`filter`） | 本地内存过滤，不发任何请求 |
| 主要操作 | 一键安装、重试、查看详情 | 导入（文件夹 / zip）、启停、删除、查看详情 |

两套数据源不要混用：【已安装】不得从远程分页结果里过滤得出，否则已装技能落在第 3 页时就查不到；【全部】不得用本地索引拼装，否则看不到未安装的技能。

【已安装】的技能列表优先取 Codex CLI 的 `skills/list`，CLI 不可用时退化为直接扫描 `.agents/skills/`（见 9.1），两条路径产出的字段一致。

**【全部】**

- 卡片展示：名称、发布者、版本、简介、兼容状态、安装操作。
- 排序按发布者 + 名称稳定排序，避免刷新跳动；已安装项不提前置顶。
- 「已安装」判定只看登记中 `source: market` 且 `skillId` 命中的记录。本地导入或手工放置的同名技能不算已安装——它们不是市场分发的同一个东西。

**【已安装】**

- 数据来源是本机技能索引与工作区登记的并集，三条来源都要能显示：市场安装、本地导入、手工放置。
- 元数据**不向远程请求**：登记项取登记（`name`、`publisher`、`version`、`summary`），手工放置项取 `SKILL.md` frontmatter 的 `name` 与 `description`，缺失字段显示空态。未登录、远程不可达都不影响本页签。
- 每项展示来源标签，并区分三种异常：登记有但目录已不存在（`missing`）、目录存在但登记无记录（`external`）、已安装但 Agent 索引未刷新（`indexStale`）。
- 搜索匹配名称、简介、标签，本地导入与手工放置项额外匹配路径。
- 安装成功、导入成功、删除成功后本页签立即反映，不依赖手动刷新。

### 3.3 详情

- 字段：用途、来源、版本、声明能力、示例。
- 【全部】的详情由远程接口返回，不下载包即可查看。
- 【已安装】的详情直接读本地：元数据取登记，正文与声明能力读 `SKILL.md`，附文件列表与所在目录。
- 详情内的安装/重试操作复用列表的状态机。

### 3.4 缺省与异常状态

| 场景 | 表现 |
| --- | --- |
| 初次加载 | 骨架屏或加载提示，不显示空态 |
| 目录请求失败 | 有缓存则展示缓存并标注已过期 + 重试；无缓存则错误态 + 重试 |
| 未登录 | 【全部】显示登录引导，不是错误态；【已安装】正常可用 |
| 已安装列表 | 完全离线可读，来自本地索引与登记 |
| 登记有、目录无 | 该条标为目录缺失，提供「重新导入」与「从登记移除」 |
| 目录有、登记无 | 该条标为手工放置，可启停与查看详情，删除需二次确认 |
| 搜索无结果 | 空态提示，保留当前关键词与页签 |
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

登记是【已安装】页签的主数据源，存于 `<workspace>/.agents/skills.registry.json`。市场安装与本地导入都要写登记，区别仅在 `source`；手工放进 `.agents/skills/` 的技能不写登记，由索引侧识别为 `external`。

```js
/** @typedef {Object} InstallRecord
 * @property {string} skillId        market 安装取目录项 id；本地导入取 SKILL.md 的 name
 * @property {string} name           展示名，取自 SKILL.md
 * @property {string} version        market 取目录项版本；本地导入为 '0.0.0-local'
 * @property {string} digest         market 取包摘要；本地导入为目录内容的 sha256
 * @property {string} dir            相对工作区的安装目录，固定为 .agents/skills/<技能原名>
 * @property {'market'|'import'} source
 * @property {number} installedAt
 * @property {string} [publisher]    market 安装时随目录项落库，供离线渲染
 * @property {string} [summary]      同上
 * @property {string[]} [tags]       同上
 * @property {boolean} [indexStale]  登记成功但 Agent 索引未刷新
 */
```

- 登记自带足以离线渲染列表与详情的字段（`name`、`publisher`、`version`、`summary`、`tags`）。【已安装】页签不回远程补字段，缺什么显示空态。
- 手工放置项不自动写登记：它们多为团队共享文件或用户自行拷贝，写登记会与 git 同步互相打架。需要转为受管项时走「重新导入」。

写入要求：先写 `.registry.json.tmp` 再 `rename`；多窗口用 `.registry.json.lock` 短锁；解析失败视为空登记并把损坏文件留为 `.bak`，不阻塞页面。

该文件是机器生成的工作区状态，**加入 `.gitignore`，不入版本控制**，避免每人安装都让仓库变脏、换机换目录产生冲突。团队想共享「该项目该装哪些技能」时，另出一份只含 `skillId` 与版本的手写推荐清单，不与登记文件混用。

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
- `installed` 判定：登记中存在该 `skillId` 且 `source: market`，`digest` 与目录一致；仅 `skillId` 命中但版本不同，视为可升级，按钮仍为【安装】。`source: import` 的登记不参与本状态判定。
- `failed` 转 `retry` 的条件是 `retryable: true`，取值见 7.1；不可重试的错误直接进 `blocked` 并展示原因，不提供重试按钮。

## 6. 消息协议

扩展侧统一在 `extension.js` 的消息分支处理，实现放独立模块。旧消息保持兼容，不删不改语义。

| 方向 | 消息 | 参数 / 返回 | 说明 |
| --- | --- | --- | --- |
| Webview → 扩展 | `marketList` | `{ query?, filter?, cursor? }` | 拉远程目录，服务端搜索与筛选，分页返回；仅【全部】页签使用 |
| | `marketDetail` | `{ skillId, version? }` | 远程详情 |
| | `marketInstall` | `{ skillId, version, digest }` | 提交安装，返回 `jobId` |
| | `marketRetry` | `{ jobId }` | 重试可重试的失败任务 |
| | `installedList` | 无 | 【已安装】页签全量：本机索引 ∪ 工作区登记，纯本地，不请求远程 |
| | `listSkills` | 无 | 取 Codex 技能索引 |
| | `getSkillDetail` | `{ path }` | 本地详情：元数据 + `SKILL.md` + 文件列表 |
| | `importSkill` | `{ mode }`，`folder` 或 `zip` | 本地导入 |
| | `setSkillEnabled` | `{ path, enabled }` | 启停 |
| | `deleteSkill` | `{ path }` | 仅可管理来源 |
| | `openSkillFile` / `revealSkill` | `{ path }` | 打开文件 / 资源管理器定位 |
| 扩展 → Webview | `marketCatalog` | `{ items, nextCursor, cachedAt, stale }` | `stale` 表示来自缓存 |
| | `marketDetail` | `{ skill, content }` | `content` 为概览文档 |
| | `marketError` | `{ code, message, retryable }` | 目录/详情失败 |
| | `installJobs` | `{ jobs }` | 全量快照，重连先收快照再收增量 |
| | `installEvent` | `{ jobId, skillId, version, digest, state, errorCode?, retryable?, progress? }` | 与需求的事件字段一致，`retryable` 由错误码推导 |
| | `installedSkills` | `{ items }` | 【已安装】页签变更推送：安装、导入、删除、启停后各推一次 |
| | `skills` / `skillsDetail` / `skillsError` / `skillsNotice` | 沿用 | 本地技能 |

两个页签各自独立请求：`marketList` 只在【全部】签发，`installedList` 只在【已安装】页签发。安装成功后的 `installedSkills` 推送两页签都接收，前者据此把卡片转【已安装】，后者据此插入新项，避免两处各自轮询。

事件合并：`installEvent` 按 `jobId` + `state` 幂等，重复事件忽略；已 `done` / `blocked` 的 `jobId` 不再接受后续事件。

## 7. 远程接口契约

接口在内网、当前不可达，本仓库先定契约，阶段 4 以服务端实际响应校准。鉴权复用现有 OIDC token，未登录不请求远程。

| 方法 | 路径 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| GET | `/skill-market/api/v1/skills` | `q`、`filter`、`cursor`、`limit` | `{ items: MarketSkill[], nextCursor }` |
| GET | `/skill-market/api/v1/skills/{id}` | `version?` | `MarketSkill` + `usage`、`source`、`capabilities[]`、`examples[]`、`readme` |
| GET | `/skill-market/api/v1/skills/{id}/versions/{version}/download` | — | zip 流，响应头带 `digest` 与 `content-length` |

约束：

- 搜索与筛选由服务端执行：`q` 匹配名称、简介、标签；`filter` 为服务端筛选枚举，当前只有 `all`，后续分类、来源、发布者等条件都在此扩展，客户端不为其新增消息。
- 列表分页，客户端不一次拉全量；翻页时保留当前 `q` 与 `filter`。
- 【已安装】页签不请求任何远程接口，元数据只读登记。远程不可达、未登录都不影响它，因此接口侧不为它设计批量补齐能力。
- `digest` 以服务端返回为准，客户端下载后重算比对，不一致即失败。
- 目录缓存写 `context.globalStorageUri` 下 `market-cache.json`，全局一份、跨工作区共用，TTL 10 分钟；过期先展示缓存再后台刷新。
- 缓存按 `q` + `filter` 分组存储，切换筛选条件不互相覆盖。

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
| `DIR_CONFLICT` | 目标目录已被其他技能或手工文件占用 | 否 |
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
6. 登记：校验 `SKILL.md` frontmatter 含 `name`、`description`，且 `name` 与目录项一致（目录名由它决定，不一致按 `SOURCE_VERIFY_FAILED` 拒绝）；写入 `<workspace>/.agents/skills/<目录名>`；成功后原子写登记。
7. 刷新：`skills/list` 带 `forceReload: true`，让 Agent 索引立即生效。
8. 清理：无论成败删除临时 zip 与临时解压目录。

### 8.2 去重与并发

- 同一 `(workspaceId, skillId, version)` 只有一条 `InstallJob`，连续点击不产生第二条记录。
- 安装目录写入前加 `.lock` 短锁，超时 30 秒强制清理并报 `VERSION_CONFLICT`。
- 不同技能可并行；同一技能不同版本串行，避免互相覆盖。

### 8.3 覆盖与回滚

目录名固定取技能原名（`SKILL.md` 的 `name`），不加发布者前缀；同名冲突由用户处理，扩展不自动加后缀。

- **升级**：登记中同一 `skillId` 已存在且版本不同，装到 `<dir>.new`，成功后 `<dir>` → `<dir>.bak`、`<dir>.new` → `<dir>`，再删 `.bak`。任一步失败：删 `.new`，`.bak` 还原，登记保持旧版本，原版本继续可用。
- **目录冲突**：目标目录已存在，但登记的 `skillId` 不同（另一个技能同名）或登记里没有记录（用户手工放置），不覆盖、不改名，报 `DIR_CONFLICT` 并提示用户自行删除或改名后重试。
- **并发**：同一目录的写入按 8.2 的短锁串行，两个技能同时装到同名目录时只有一个成功，另一个报 `DIR_CONFLICT`。

### 8.4 后台继续与重连

- 安装跑在扩展宿主侧，webview 关闭或切走继续执行；重开市场先收 `installJobs` 快照。
- 扩展重启：中间态任务标 `failed`（`INTERRUPTED`，可重试）；已 `done` 以登记为准重建。
- 多窗口同工作区：以登记文件为真相来源，第二个窗口只读并监听文件变化，不重复执行。

### 8.5 索引刷新

安装成功必须让 Codex 重新扫描，否则装完不可用。失败时登记已写入但标 `indexStale: true`，页面提示「已安装，索引待刷新」并提供重试。

## 9. 【已安装】页签与本地能力

【已安装】页签就是本地技能管理，与远程市场没有数据往来。它把本机技能索引与工作区登记按 `dir` 取并集，三类来源都要展示：

| 来源 | 判定 | 可做的操作 |
| --- | --- | --- |
| 市场安装 | 登记有记录且 `source: market` | 启停、详情、删除；阶段 5 增加升级 |
| 本地导入 | 登记有记录且 `source: import` | 启停、详情、删除、重新导入 |
| 手工放置 | 索引有、登记无 | 启停、详情；删除需二次确认 |

- 两边各缺一边时不隐藏该项：登记有而索引无标 `missing`（目录被外部删除或切换分支导致），索引有而登记无标 `external`。
- 手工放置项不写登记，避免与 git 同步冲突；要转为受管项走「重新导入」。
- 按名称稳定排序，来源用标签展示，不做分组，避免安装后条目跳位。

### 9.1 未登录可用

1. 新增 `ensureSkillClient()`：不调用 `accessToken()`，启动独立 app-server 实例，仅用于 `skills/list` 与 `skills/config/write`；模型目录用 CLI 自带模型构造。
2. `importSkill`、`getSkillDetail`、`deleteSkill`、`openSkillFile`、`revealSkill` 走纯文件系统，不依赖 client 与登录。
3. 退出登录只清理会话 client，不影响技能页。【已安装】页签在未登录时是默认页签，读取与操作全部可用。
4. Codex CLI 未安装时沿用 `ensureBinary()`，失败提示「设置 `dicodeCodex.codexPath` 或登录后安装」。
5. 前置验证见阶段 1；不可行则退化为自行扫描技能目录 + 写用户级配置，并在此记录差异。

### 9.2 导入（文件夹 + zip）

导入入口只出现在【已安装】页签，市场页签不设导入。点击后先让用户选择「从文件夹导入」或「从 ZIP 导入」，两者共用同一套校验与落盘逻辑。

**共用校验**

- 必须包含 `SKILL.md`，frontmatter 含 `name`、`description`。
- 拒绝符号链接、加密条目、绝对路径、含 `..` 的路径。
- 目录名固定取 `SKILL.md` 的 `name`（小写、非法字符转 `-`），保持技能原名，不加前缀与后缀。
- 重名时由用户当场决定：覆盖 / 重命名 / 取消。市场安装是无人值守流程，同名一律阻断（见 8.3），两者策略不同是有意为之。

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

- 删除前模态确认，显示将删除的目录；手工放置项额外提示「该目录不在安装登记中，可能是团队共享文件」，需二次确认。
- 允许删除 `user` / `repo` 来源与 `source: market|import` 的登记项；`system` / `admin` 只读。
- 用 `workspace.fs.delete(..., { useTrash: true })`，同步移除登记记录，并推送一次 `installedSkills`。
- 删除市场安装项后，市场【全部】页签中该技能回到【一键安装】，不需要重新拉取远程目录。
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
| 新增 `apps/dicode-vscode/installedView.js` | 1 | 索引与登记按 `dir` 合并、三类来源判定、`missing` / `external` / `indexStale` 状态 |
| 新增 `apps/dicode-vscode/skillMarket.js` | 2 | 目录/详情请求、缓存、分页、错误码映射 |
| 新增 `apps/dicode-vscode/marketStub.js` | 2 | 桩数据与模拟失败 |
| 新增 `apps/dicode-vscode/skillInstaller.js` | 3 | 下载、摘要校验、解压、覆盖回滚、任务表 |
| `apps/dicode-vscode/extension.js` | 1、2、3 | 消息路由、`ensureSkillClient()`、导入/删除/详情、`installedList` 合并 |
| 新增 `apps/dicode-vscode/webview/skills.ts` | 1、2 | 类型与纯函数（合并、过滤、排序、搜索、状态） |
| 新增 `apps/dicode-vscode/webview/Installed.tsx` | 1 | 【已安装】页签：来源标签、导入入口、启停、删除、本地详情 |
| 新增 `apps/dicode-vscode/webview/Market.tsx` | 2 | 【全部】页签：市场列表、详情、安装按钮与状态 |
| `apps/dicode-vscode/webview/app.tsx` | 1、2 | 路由、两页签容器与切换、消息处理 |
| `apps/dicode-vscode/webview/Subpages.tsx` | 1 | `SkillList` 由 `Installed.tsx` 取代，保留历史会话等其余子页 |
| `apps/dicode-vscode/webview/style.css` | 1、2 | 来源标签、卡片、页签、骨架、状态按钮、详情排版 |
| 新增 `apps/dicode-vscode/test/skills-registry.test.js` | 0 | 原子写、锁、损坏恢复 |
| 新增 `apps/dicode-vscode/test/skill-archive.test.js` | 1 | zip 解析、路径穿越、符号链接、超限 |
| 新增 `apps/dicode-vscode/test/installed-view.test.js` | 1 | 三类来源合并、`missing` / `external` 判定、不请求远程 |
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
- 【已安装】页签按 `dir` 归并三类来源：市场安装、本地导入、手工放置各一条，标签与可操作项符合 9 节表格；
- 登记有而目录无标 `missing`，目录有而登记无标 `external`，两种项都不被隐藏；
- 本页签不发起任何远程请求（`marketList` / `marketDetail` 调用次数为 0）；
- 详情读取的路径安全（拒绝 `..`、绝对路径、符号链接逃逸）；
- 文件夹导入成功、同名覆盖/重命名/取消，失败不破坏已有技能；
- zip 导入成功、单层根目录自动剥离；
- zip 路径穿越、符号链接、加密条目、超限包被拒绝且清理临时目录；
- 导入后写入 `source: import` 登记，列表与离线可用同时生效；
- 删除 `system` / `admin` 被拒；删除 `import` 项同步清登记；删除手工放置项需二次确认且不写登记；
- 启停失败回滚。

**阶段 2**

- 搜索命中名称/简介/标签；两页签切换后各自状态保留；
- 【全部】的「已安装」标记只认 `source: market` 且 `skillId` 命中，同名本地导入项不显示为已安装；
- 未登录进入市场落到【已安装】页签，切到【全部】显示登录引导而不是错误态；
- 五态按钮文案与禁用状态；在途状态不可重复点击；
- 骨架、错误、空态、缓存过期标注、离线已安装；
- 最小化/最大化切换后市场状态保持；
- 四套主题下状态色可辨识。

**阶段 3**

- 连续三次安装同一版本只产生一个 `jobId`；
- 摘要不一致、来源校验失败、不兼容、组织限制四类均不写登记；
- 覆盖安装成功换版本；中途失败回滚且登记不变；
- 目标目录被其他 `skillId` 或手工放置的目录占用时报 `DIR_CONFLICT`，不写入、不改名；
- 扩展重启后中间态转 `INTERRUPTED` 并可重试；
- 索引刷新失败标 `indexStale` 并可重试；
- 安装成功后【已安装】页签立即出现该项、【全部】卡片转【已安装】，删除后【全部】卡片回到【一键安装】，两个方向都不需手动刷新。

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
| 安装后切到【已安装】能看到该项，重开市场状态正确 | 3：登记为真相来源 + 快照重建 |
| 覆盖失败后重试、原版本继续可用 | 3：8.3 覆盖回滚 |
| 离线或未登录时可读【已安装】 | 1：5.2 登记 + 3.4 离线读 |
| 自己导入或手工放进目录的技能在本页签可见 | 1：9 节归并表 |
| 两个页签数据源不串（已安装不请求远程、全部不用本地索引） | 1、2：12.1 阶段 1/2 断言 |
| 版本冲突、重复事件可识别 | 3：7.1 `VERSION_CONFLICT`、6 事件幂等 |
| 最大化时列表和详情并排 | 2：3.1、10 |
| 本地导入（文件夹与 zip）可用 | 1：9.2 + 12.1 阶段 1 |

### 12.3 验证命令

`npm run check`、`npm test`、`npm run build`（均在 `apps/dicode-vscode` 下）。每阶段结束跑全量，不只跑新增用例。

## 13. 已确认决策

| # | 事项 | 决策 |
| --- | --- | --- |
| 1 | 设计稿缺口 | 按需求先实现。版本、简介、兼容状态在 UI 出稿前留空态兜底；详情页按需求字段自行排版，不等稿 |
| 2 | 登记文件 | 加入 `.gitignore`，不入库。团队共享「该装哪些技能」另出只含 `skillId` 与版本的推荐清单 |
| 3 | 安装目录命名 | 保持技能原名，不加发布者前缀。同名冲突由用户自行删除或改名，扩展报 `DIR_CONFLICT`，不自动改名 |
| 4 | 目录缓存 | 全局 `globalStorageUri`，跨工作区共用，按 `q` + `filter` 分组 |
| 5 | `INTERRUPTED` | 先用本地自定义码，阶段 4 若服务端有对应码再映射 |
| 6 | 发布节奏 | 阶段 3 收尾发一版内测 VSIX（桩数据模式），阶段 4 联调通过后发正式版 |
| 7 | 市场页结构 | 【全部】与【已安装】是两个页签，不是同一列表的过滤条件。【全部】请求远程、由服务端筛选；【已安装】即本地技能管理，只读本机索引与登记，不请求远程、不依赖登录 |
| 8 | 已安装标记口径 | 只认登记中 `source: market` 且 `skillId` 命中的记录；本地导入或手工放置的同名技能不算已安装 |
| 9 | 手工放置项 | 不写登记，在【已安装】页签以 `external` 展示，可启停与查看详情，删除需二次确认 |
| 10 | 默认页签 | 已登录进【全部】，未登录进【已安装】，保证未登录也能管理本地技能 |
