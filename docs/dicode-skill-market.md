# DiCode Skill 市场开发规划

> 状态：规划定稿（v4，已对齐内网 SkillHub 真实接口契约），分阶段实施（代码未改动）
> 分支：`feat/skill-market`
> 范围：`apps/dicode-vscode`（VS Code 扩展 + Webview）
> 需求依据：产品需求文档 V4.0.1【P0】Skill 市场与一键安装，以及跨会话异步执行、IDE 布局、事件恢复中与 Skill 安装相关的条款
> 接口契约：`docs/skillhub-api.md`（内网 SkillHub 后端契约整理，未实测；字段级细节以该文件为准，本文档只登记插件侧口径与差异处理）
> 设计参考：`docs/design/dicode-vscode-ui-prototype.html`、`docs/design/dicode-webview-ui.md`
> 日期：2026-11-18

需求文档与截图含内部信息，不纳入本仓库（已用 `.gitignore` 排除），仅在本地维护。本文档是唯一入库的实施规划依据，接口契约以 `docs/skillhub-api.md` 为准（真实内外网地址不入库），需求或契约变更时同步更新此处。

冲突处理原则：**PRD 与设计稿冲突以 PRD 为准**，设计稿只作视觉与交互参考；**PRD 与后端契约冲突**（接口无法提供 PRD 要求的字段）时，按空态兜底等最小偏离实现并登记第 14 节，待产品确认，不静默裁剪 PRD；PRD 未定义而由本文档自定的口径，同样集中登记在第 14 节，需产品与 UI 知会后才能视为定稿。

## 1. 范围与环境约束

### 1.1 实施范围

界面分两个页签，职责不重叠：**【全部】**远程市场（入口与布局、搜索与筛选、卡片字段、详情、缺省与异常状态）；**【已安装】**本地技能管理（本机索引与登记合并、来源区分、文件夹/zip 导入、详情、删除、启停、未登录可用）。另含**安装**（五态状态机、安装链路、去重、后台继续、失败与重试、索引刷新、版本更新——详情页发起复用覆盖管道，见 5.4/8.3，安装与删除在两页签间同步）与**持久化恢复**（按工作区的安装登记、按机器保存的安装任务日志、离线可用、安装事件与重连）。

范围分三层（详见 2.4）：PRD V4.0.1 条款全部纳入不裁剪；本地管理能力 PRD 未要求，其中仅文件夹导入与「已启用」筛选是保留的既有能力，其余（详情、删除、同名覆盖、未登录可用等）为新增；zip 导入、重新导入/移出登记、任务日志与目录锁、版本更新入口为用户指定新增。

### 1.2 环境约束与应对

| 约束 | 影响 | 应对 |
| --- | --- | --- |
| 市场接口在内网，当前不可达 | 无法联调真实目录与下载 | 契约已整理为 `docs/skillhub-api.md`；阶段 0–3 桩数据按真实契约形状构造，数据源单独隔离，阶段 4 只换传输与鉴权并实测校准 |
| 外网开发基地址留空（`SKILLHUB_BASE_URL`） | 远程功能不可用 | 基地址为空时禁用远程并给出配置引导，不报错崩溃；【已安装】不受影响（见 3.4/7） |
| 内网账户与真实技能包不可得 | 无法验证真实兼容性与组织策略 | 兼容状态、组织限制、来源校验在桩数据中构造用例，逻辑先落地，阶段 4 校准；账号需平台分配 `system:skill:list/query/download` 权限，列为阶段 4 前置条件 |
| Codex CLI 行为未验证 | 未登录能否调用技能 RPC、run 是否固定技能内容均未知 | 阶段 1 首两项做验证（见 2.3），并备好退化方案 |
| 现有导航是顶栏图标，PRD 要求左上导航四项 | 不改则入口形态不符 PRD | 导航改造作为**阶段 1 前置任务**由本模块完成（见 2.3），不依赖其他需求排期 |
| 最小化/最大化开关属 IDE 布局需求，当前代码未实现 | 阶段 2 最大化验收无入口 | 登记为外部依赖：最大化验收以开关落地为前提，未落地则该部分顺延，不阻塞阶段 2 其余验收 |
| 本机未验证 VSIX 打包与分发 | 阶段 3 收尾的内测包可能受阻 | `@vscode/vsce` 已在 devDependencies；阶段 3 开始前先跑一次 `npx vsce package --no-dependencies` 验证环境，不可用则内测顺延 |
| 终端组件不在本仓库 | PRD 发布验收含「CLI 侧 Skill 安装」，本仓库无法覆盖 | 不在本模块职责范围，由终端团队负责（见 1.3） |

### 1.3 其他模块边界

- **终端/CLI 的 Skill 安装**：不在本模块职责范围。不排期、不验收、不输出复用契约，也不与终端团队做接口对齐。
- **消息提醒中的安装失败**：提醒只覆盖任务待决策与任务动态，本模块不扩展。
- **跨会话记忆、待决策强提醒**：属 V4.0.2，由对应模块负责。
- **导航栏改造**：只做「左上四项导航 + 左下用户中心/设置」的入口搬迁，不改其余页面内容，不改最小化/最大化开关（属 IDE 布局需求，见 1.2）。

## 2. 分步实施路线

### 2.1 划分原则

按环境依赖切分：先做不依赖外部条件的部分，再做依赖本地可验证条件的部分，最后做必须依赖内网的接入。每个阶段可单独交付、单独验收，中断后可从下一阶段继续。

### 2.2 阶段总览

| 阶段 | 主题 | 外部依赖 | 主要产出 |
| --- | --- | --- | --- |
| 0 | 数据底座 | 无 | 模型、状态推导、登记读写、任务日志与目录锁 |
| 1 | 导航与【已安装】页签 | Codex CLI | 导航改造、两页签容器、索引与登记合并、导入、详情、删除、启停、技能 client |
| 2 | 【全部】市场浏览 | 桩数据（按真实契约形状）；最大化开关（见 1.2） | 列表、详情、布局、缓存、登录引导 UI |
| 3 | 安装链路 | 无（本地桩包） | 安装管道、去重、回滚、中断恢复、索引刷新、更新入口、内测包 |
| 4 | 真实接口接入 | 内网环境、基地址配置、平台账号（含技能权限） | SkillHub 鉴权、真实数据源与下载、契约实测校准、联调 |
| 5 | 文档与收尾 | 阶段 4 之后 | 使用文档、最终回归 |

阶段 0–3 完全可在本地完成（阶段 2 最大化部分以 IDE 布局开关落地为前提，见 1.2）；阶段 4 是唯一硬依赖内网的阶段。文件级产出见第 11 节，验收见第 12 节。

### 2.3 各阶段任务

**阶段 0：数据底座**——产出 `skillsModel.js`、`skillsRegistry.js`、`skillsJobs.js`（职责见第 11 节）；登记与任务日志的路径、格式在本阶段定死（见 5.2/5.3）。同时把 `npm run check` 改为覆盖全部 `.js`（见 12.3），否则新增模块不在语法检查范围内。

**阶段 1：导航与【已安装】页签**

- 前置任务（先于页签开发）：把当前顶栏右侧四个图标（`webview/app.tsx` 的 `top-actions`）改为 PRD 要求的左上导航四项【对话、Skill 市场、历史对话、消息提醒】，左下固定【用户中心、设置】；进入市场子页后返回对话保留输入中草稿。产出 `webview/NavRail.tsx`，导航与页签切换不重建会话状态。
- 前置验证（两项）：① 空 token 启动 app-server 后 `skills/list`、`skills/config/write` 是否可用——可用则走独立技能 client，不可用则退化为自行扫描技能目录 + 写用户级配置，并在本文档记录差异；② Codex 是否在 run 开始时固定技能内容（决定 2.4「运行中任务沿用更新前版本」承诺是否成立）——不支持则登记偏离并与产品讨论对策。
- 产出技能 client、zip 安全解压、索引与登记合并视图、导入与本地管理消息（见第 6、11 节）、`webview/Installed.tsx`、两页签容器。本页签不调用任何远程接口；导入写 `source: import` 登记、手工放置项不写登记（见 5.2/9.2），保留「已启用」筛选。

**阶段 2：【全部】市场浏览**——产出 `marketStub.js`、`skillMarket.js`（数据源抽象 + 适配层，桩与真实接口同一出口）、`webview/skills.ts`、`webview/Market.tsx`、页签切换与选中态。桩数据按 `docs/skillhub-api.md` 的响应形状构造（success 外层、平级业务字段、page/size 分页），适配层把服务端字段映射为 UI 模型（5.1），阶段 4 只换传输与鉴权。服务端搜索筛选排序（`q`/`label`/`sort`）、「已安装」标记只认 market 登记（见 3.2）；骨架、缓存过期标注、最大化态并排（验收前提见 1.2）；登录引导 UI 先行（桩登录态，真实鉴权在阶段 4）。桩不模拟安装过程（见 7.2）。已知契约缺口：列表不返回版本、详情无结构化声明能力/示例、无兼容与包摘要字段——空态兜底并登记偏离（14 #15–#17、#20）。

**阶段 3：安装链路**——产出 `skillInstaller.js`、安装任务表与事件（含 `seq`）、事件幂等、中断恢复、索引刷新、详情页更新入口（复用 8.3 覆盖管道）。去重、覆盖回滚、后台继续与重连均按第 8 节实现。收尾：递增扩展版本并打一版内测 VSIX，桩数据模式下走通真实安装流程，先收一轮问题再进阶段 4。

**阶段 4：真实接口接入**——产出 `skillHubAuth.js`（`/login` 换 JWT、可选验证码、token 存 `context.secrets`、401 清 token 重登后原请求重试一次）、`skillMarket.js` 真实传输实现、ZIP 下载（Content-Type 分流、超时 ≥ 60s）。分页、缓存 TTL 与淘汰、错误码映射、适配层已在阶段 2 按契约建成，本阶段以实测与 Swagger（`{BASE}/docs`）校准：`has_next` 命名、`parsedMetadataJson` 内容、兼容/组织策略是否有替代字段、包内 `name` 与 `slug`/`displayName` 的对应规则。前置条件：内网可达、`SKILLHUB_BASE_URL` 已配置、账号已分配技能权限（1.2）。字段缺失在适配层补齐，不把服务端差异泄漏到 UI。

**阶段 5：文档与收尾**——使用文档（市场与本地技能操作说明）、最终全量回归。进入条件：阶段 0–4 全部验收通过；更新入口已在阶段 3 交付，不重复。

各阶段验证用例见 12.1。

### 2.4 需求覆盖矩阵

**A．PRD V4.0.1 条款（本模块职责范围内全部纳入，不裁剪；仅末行为范围外）**

| 需求条款 | 阶段 |
| --- | --- |
| 入口：左上导航第 2 项、回到对话保留草稿 | 1（导航改造为前置任务） |
| 【全部】列表：搜索、卡片六字段（名称/发布者/版本/简介/兼容状态/安装操作） | 2（列表接口不返回版本与兼容字段：版本空态 + 详情回填，兼容默认 compatible，见 14 #15/#20） |
| 【全部】详情：用途、来源、版本、声明能力、示例 | 2（概览渲染 SKILL.md 原文；声明能力/示例无结构化字段，空态兜底，见 14 #16） |
| 骨架、目录失败保留缓存并重试、已安装列表离线可读 | 2（已安装离线读在 1） |
| 可安装 → 安装中 → 已安装 → 可重试 → 不可安装五态 | 3（不可安装策略在 4 校准） |
| 安装链路固定 ID、版本、摘要 | 3（ID = namespace/slug；摘要为客户端自算，服务端不提供，见 14 #17） |
| 同工作区 + Skill + 版本去重，切走或关闭市场后继续 | 3 |
| 安装后刷新列表与 Agent 的 Skill 索引 | 3 |
| 已开始的任务继续使用其固定或更新前版本 | 3（有条件承诺：依赖阶段 1 前置验证第 2 项，不支持则登记偏离） |
| 调用：安装只让 Skill 可发现，Agent 可按意图选用、用户可在请求中指名 | 3（验收：安装后不重启，`skills/list` 即可命中） |
| 失败清理临时文件、旧版本继续可用 | 3 |
| 安装事件字段（workspaceId、skillId、version、digest、jobId、state、errorCode）与按工作区持久化 | 3（底座在 0；digest 为自算值，下载完成前缺省） |
| 并行请求共用安装任务 | 3 |
| 重连先快照后增量、忽略已应用序号 | 3 |
| 安装、删除在两页签间同步 | 3 |
| 最大化态列表与详情并排 | 2（以布局开关落地为前提，见 1.2） |
| 真实目录、真实包、真实兼容与组织策略 | 4（接口无兼容/组织策略字段，403/404 映射，见 7） |
| CLI 侧 Skill 安装 | 不在本模块职责范围，由终端团队负责（不排期、不验收） |

**B．本地管理能力（PRD 未要求；新增/保留逐项标注）**

| 能力 | 阶段 | 性质 |
| --- | --- | --- |
| 文件夹导入、「已启用」筛选 | 1 | 保留既有 |
| 启停 | 1 | 保留既有（改造为乐观更新，见 9.4） |
| 详情、删除、同名覆盖/重命名/取消 | 1 | 新增（现状缺失，见 4.2 差距 4/5/10） |
| 手工放置项展示 | 1 | 保留既有（索引扫描） |
| 手工放置项二次确认删除 | 1 | 新增 |
| 未登录可用 | 1 | 新增（现状未登录不可用，见 4.2 差距 6；登记底座在 0） |

**C．用户指定新增**

| 项 | 阶段 |
| --- | --- |
| zip 导入必做（从收尾项提前） | 1 |
| 重新导入（`reimportSkill`）、从登记移除（`unregisterSkill`） | 1 |
| 安装任务日志与目录锁（支撑中断恢复、多窗口） | 0 |
| 版本更新入口（详情页发起，复用覆盖管道） | 3 |

## 3. 产品形态

### 3.1 入口与布局

- 左上导航第 2 项【Skill 市场】进入（阶段 1 前置任务改造），回到对话保留输入中草稿。
- 页内两个页签【全部】与【已安装】，两套独立数据源（见 3.2）；默认页签：SkillHub 已登录且基地址已配置进【全部】，否则进【已安装】。市场登录态独立于 Codex 会话登录态（见 7）。
- 窄面板：市场占据插件内容区，列表与详情为前后两级。
- 最大化态：列表与详情并排（左侧列表、右侧详情），**不沿用**对话页「左侧常驻历史列表」；切回对话页恢复历史列（偏离 14 #10）。
- 切换导航项或页签不重建市场状态，已发起的安装任务不受影响。

### 3.2 两个页签

| | 【全部】 | 【已安装】 |
| --- | --- | --- |
| 定位 | 远程技能市场，检索与安装 | 本地技能管理 |
| 数据来源 | 远程目录，分页 | 本机技能索引 ∪ 工作区登记 |
| 外部依赖 | 基地址配置 + SkillHub 登录 + 内网接口 | 无（不联网、不要求登录） |
| 搜索与筛选 | 下发服务端（`q`、`label`、`sort`、`page`/`size`） | 本地内存过滤，不发任何请求 |
| 主要操作 | 安装、重试、查看详情 | 导入（文件夹 / zip）、启停、删除、查看详情 |

**两套数据源不得混用**（唯一口径）：【已安装】不得从远程分页结果或内存中的市场目录过滤得出（否则已装项落在第 3 页就查不到，目录外的本地技能永远看不到）；【全部】不得用本地索引拼装（否则看不到未安装的技能）。

**【全部】**

- 卡片展示：名称、发布者、版本、简介、兼容状态、安装操作。版本取自详情 `publishedVersion.version`（列表接口不返回）：未回填前显示空态，打开详情后回填缓存，不做逐卡预取（14 #15）；兼容状态接口无字段，默认 compatible（14 #20）。图标 `icon` 为 base64 data URL 可直接渲染；`needApiKey: true` 时附注「运行需 API Key」。
- 排序由服务端 `sort` 决定（默认 `newest`，可选 `relevance`/`downloads`/`rating`），客户端不跨页重排，已安装项不提前置顶；筛选下拉用返回的 `labelStats`（见第 7 节）。
- 「已安装」判定只看登记中 `source: market` 且 `skillId` 命中的记录；本地导入或手工放置的同名技能不算已安装（身份不同）。
- 同名本地占用：市场条目的目标目录被本地导入或手工放置目录占用时，卡片在安装操作旁附注「本地已有同名技能」（处理见 8.3），避免点了【安装】必然收到 `DIR_CONFLICT`。

**【已安装】**

- **与市场完全独立**：market 模块、远程目录接口、登录态、目录缓存都不参与；市场接口挂了、未登录、甚至没有配置市场，本页签照常工作。语义是「这台机器这个工作区里真实存在、可被 Agent 发现的技能」。元数据**不向远程请求**：登记项取登记，手工放置项取 `SKILL.md` frontmatter 的 `name` 与 `description`，缺失字段显示空态。
- 数据来源是**本机技能索引 ∪ 工作区登记**，按 `dir` 合并，两侧只提供自己有的字段：索引提供 `path`、`scope`、`enabled` 与存在性；登记提供 `skillId`、`source`、`version`、`publisher`、`summary`、`tags`。任一侧都不是唯一的列表主体，来源判定见第 9 节。索引优先取 Codex CLI 的 `skills/list`；CLI 不可用时退化为扫描 `.agents/skills/`（见 9.1），`scope` 按目录位置推断、`enabled` 显示为未知，不阻塞列表。
- 三类来源都要能显示：市场安装、本地导入、手工放置；保留「已启用」筛选。
- 每项展示来源标签，并区分四种异常：`missing`（登记有但目录已不存在）、`external`（目录存在但登记无记录）、`indexStale`（已安装但 Agent 索引未刷新）、`altered`（目录内容与登记摘要不一致，仅附注「本地已修改」，不改变已安装状态）。`altered` 不在列表渲染时重算：打开详情或主动校验时比对，结果缓存为标记供列表沿用（见 5.2）。
- 搜索匹配名称、简介、标签，本地导入与手工放置项额外匹配路径。
- 安装成功、导入成功、删除成功后本页签立即反映，不依赖手动刷新。

### 3.3 详情

- 市场详情由三个接口拼装，不下载包即可查看：`/{namespace}/{slug}` 元信息（作者/部门、标签、下载/评分统计、`needApiKey`、`publishedVersion`）、`/versions` 版本历史（版本号、changelog、发布时间、大小、`downloadReady`）、`/versions/{version}/file?path=SKILL.md` 概览原文（Markdown 渲染，复用本地详情的渲染器）。概览默认取 `publishedVersion.version`，可切换历史版本查看；仅 `PUBLISHED` 且 `downloadReady` 的版本可安装。
- PRD 字段映射：用途 ≈ `summary` + SKILL.md 概览；来源 ≈ 作者/部门/命名空间；版本 ≈ `publishedVersion` 与版本历史。**声明能力与示例接口无结构化字段**：空态兜底（与已安装详情同口径），不猜测性解析，登记偏离 14 #16。
- 【已安装】的详情直接读本地：元数据取登记，正文读 `SKILL.md` 全文，附文件列表与所在目录。本地 `SKILL.md` 只有 `name` / `description` 两个结构化字段，**声明能力与示例无法从本地解析**：显示空态，不做猜测性解析。市场接口同样不提供结构化 `capabilities` / `examples`，【全部】详情同口径空态兜底（14 #16），不再注明「由市场提供」。
- 详情内的安装/重试操作复用列表的状态机。

### 3.4 缺省与异常状态

| 场景 | 表现 |
| --- | --- |
| 初次加载 | 骨架屏或加载提示，不显示空态 |
| 目录请求失败 | 有缓存则展示缓存并标注已过期 + 重试；无缓存则错误态 + 重试，并提供「切到【已安装】」的动作 |
| 基地址未配置（`SKILLHUB_BASE_URL` 为空） | 【全部】显示配置引导并禁用远程请求，不报错崩溃；【已安装】正常可用 |
| SkillHub 未登录 | 【全部】显示登录引导（账号密码，服务端要求时展示验证码），不是错误态；【已安装】正常可用 |
| 无权限 / 资源不可见 | 403 提示「无权限」并引导到平台调整角色权限；404 提示资源不可用并刷新列表（见 7.1） |
| 已安装列表 | 完全离线可读，来自本地索引与登记 |
| 登记有、目录无 | 该条标为目录缺失，提供「重新导入」与「从登记移除」 |
| 目录有、登记无 | 该条标为手工放置，可启停与查看详情，删除需二次确认 |
| 市场条目目标目录被本地技能占用 | 卡片附注「本地已有同名技能」，安装被阻断并给出处理建议（8.3） |
| 搜索无结果 | 空态提示，保留当前关键词与页签 |
| 单条安装失败 | 该条转【重试】并保留失败原因，不影响其他条目 |

## 4. 现状

### 4.1 现有链路

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 入口 | `webview/app.tsx` 顶栏右侧 `top-actions` 的「Skill 市场」图标 | 切到 `skills` 子页并发送 `listSkills`；**不是** PRD 要求的左上导航 |
| 列表 | `webview/Subpages.tsx` `SkillList` | 搜索、全部/已启用筛选、启用开关、空状态 |
| 导入 | `webview/app.tsx` 技能子页右上角「导入」 | 发送 `importSkill`，只支持文件夹 |
| 消息处理 | `extension.js` 的 `importSkill` / `listSkills` / `setSkillEnabled` 分支 | `listSkills` 与 `setSkillEnabled` 都经 `ensureClient()` |
| 导入实现 | `extension.js` `importLocalSkill` | 校验 `SKILL.md` frontmatter，复制到 `<workspace>/.agents/skills/<源文件夹名>`（目录名取**源文件夹名**），拒绝符号链接与同名覆盖 |
| 测试 | `test/skill-import.test.js` | 导入成功、同名不覆盖、导入后刷新 |

技能数据来自 Codex app-server：列表 `skills/list`（`cwds: [workspace]`, `forceReload: true`），启停 `skills/config/write`，字段为 `name`、`description`、`path`、`scope`、`enabled`、`pluginId`。

### 4.2 与目标的差距

1. 没有远程目录：无接口、无分页、无版本与兼容状态。
2. 没有安装链路：只能从本地导入。
3. 没有登记记录：「已安装」靠实时扫描，离线不可用，也无法区分来源。
4. 没有详情页：看不到 `SKILL.md`、来源、文件列表。
5. 没有删除、没有重新导入、没有移出登记：导入后只能启停，目录需手动清理。
6. 未登录不可用：`listSkills` / `setSkillEnabled` 经 `ensureClient()` → `accessToken()`，未登录直接抛错；`importSkill` 虽不依赖登录，但导入后刷新被拒，表现为「文件已复制但页面报错」。
7. 状态反馈不完整：无真正加载态，启停失败走通用 `error` 且技能页不展示，分条 `errors` 被压成一句话。
8. 启停不可靠：非乐观更新、无逐项 pending、无失败回滚。
9. 数据模型未定义：前端以 `any` 处理，以 `path` 作 key。
10. 导入能力有限：仅支持文件夹，无 zip、无覆盖与重命名。
11. 入口形态不符：PRD 要求左上导航四项，现状是顶栏右侧图标。

## 5. 数据模型

新增 `apps/dicode-vscode/skillsModel.js`，扩展侧与 webview 共用一份字段定义；webview 侧再导出 TypeScript 类型。时间用毫秒时间戳，版本比较不引第三方依赖，自行实现 `compareVersion`。

### 5.1 市场目录项

```js
/** @typedef {Object} MarketSkill
 * @property {string} id            稳定标识 = `${namespace}/${slug}`，安装一律以 id + version 定位；响应中的数值 id 不作路径参数
 * @property {string} namespace     主命名空间 slug，取自查询结果字段，作路径参数时 URL-encode
 * @property {string} slug          技能 slug，取自查询结果字段
 * @property {string} name          ← displayName
 * @property {string} publisher     ← createdByName（createdByDept 在详情展示）
 * @property {string} version       ← 详情 publishedVersion.version；列表接口不返回，空态兜底、详情缓存回填（14 #15）
 * @property {string} summary       列表用一句话简介，参与搜索
 * @property {string[]} tags        ← labels / skillLabel，参与搜索
 * @property {string} [icon]        base64 data URL，可直接渲染
 * @property {boolean} [needApiKey] 运行是否需要 API Key，UI 附注
 * @property {'compatible'|'incompatible'|'restricted'} compat  接口无对应字段：默认 compatible；restricted 由 403/404 映射（7.1）；incompatible 仅桩构造，阶段 4 校准（14 #20）
 * @property {string} [minClientVersion]  incompatible 时给出最低客户端版本（暂无服务端来源）
 * @property {string} [compatReason]      restricted 时的说明（暂无服务端来源）
 * @property {number} [updatedAt]
 */
```

服务端字段 → UI 模型的映射在 `skillMarket.js` 适配层完成，桩与真实实现共用。目录项**不含 `digest`**：服务端不提供包摘要，下载后客户端自算（见 5.2/8.1）。

### 5.2 安装登记（按工作区持久化）

登记是【已安装】页签的主数据源，存于 `<workspace>/.agents/skills.registry.json`。市场安装与本地导入都要写登记，区别仅在 `source`；手工放进 `.agents/skills/` 的技能不写登记，由索引侧识别为 `external`。

```js
/** @typedef {Object} InstallRecord
 * @property {string} skillId        market 安装取目录项 id（namespace/slug，可拆出路径参数）；本地导入取 SKILL.md 的 name
 * @property {string} name           展示名，取自 SKILL.md
 * @property {string} version        market 取目录项版本；本地导入为 '0.0.0-local'
 * @property {string|null} digest    market：客户端下载后自算的 zip sha256（服务端不提供包摘要，见 8.1），供事件与排查；本地导入为 null
 * @property {string} dirDigest      安装完成时目录内容的 sha256，用于检测外部改动（altered）
 * @property {string} dir            相对工作区的安装目录：.agents/skills/<来源目录名>（见 5.5）
 * @property {'market'|'import'} source
 * @property {string} origin         市场包内根目录名 / 导入源文件夹名，供排查
 * @property {number} installedAt
 * @property {string} [publisher]    market 安装时随目录项落库，供离线渲染
 * @property {string} [summary]      同上
 * @property {string[]} [tags]       同上
 * @property {boolean} [indexStale]  登记成功但 Agent 索引未刷新
 * @property {boolean} [altered]     详情/主动校验发现 dirDigest 不一致后缓存的标记（见 3.2）
 */
```

- 两种摘要不能混用：`digest` 是**包**摘要（自算），`dirDigest` 才是**目录内容**摘要。已安装判定不依赖摘要比对（见 5.4），否则会出现「包摘要永远不等于目录摘要、已安装永远不成立」的死结。
- `dirDigest` 只在安装/导入完成时计算一次并落库，列表渲染**不重算**（避免每次刷新做全目录 sha256）；仅在打开详情或用户主动校验时比对，结果写入 `altered` 缓存标记供列表附注。登记自带足以离线渲染列表的字段（`name`、`publisher`、`version`、`summary`、`tags`），缺什么显示空态，不回远程补字段。
- 手工放置项不自动写登记：多为团队共享文件或用户自行拷贝，写登记会与 git 同步互相打架；需要转为受管项时走「重新导入」。

写入要求：先写 `.registry.json.tmp` 再 `rename`；多窗口用 `.registry.json.lock` 短锁；解析失败视为空登记并把损坏文件留为 `.bak`，不阻塞页面。

该文件是机器生成的工作区状态，**不入版本控制**。扩展不静默修改用户的 `.gitignore`：首次写登记时检测工作区 `.gitignore` 是否已忽略该路径，未忽略则提示一次并提供「加入 .gitignore」动作（写入工作区根 `.gitignore`，需用户确认）。团队想共享「该项目该装哪些技能」时，另出一份只含 `skillId` 与版本的手写推荐清单，不与登记文件混用。

### 5.3 安装任务

```js
/** @typedef {Object} InstallJob
 * @property {string} jobId
 * @property {string} workspaceId    工作区标识（工作区路径的短散列）；事件、去重、任务日志与锁路径统一用它
 * @property {string} skillId
 * @property {string} version
 * @property {string} [digest]       下载完成后自算的 zip sha256；downloading 阶段缺省，verifying 起携带
 * @property {'queued'|'downloading'|'verifying'|'extracting'|'registering'|'done'|'failed'} state
 * @property {number} seq            本任务的事件序号，从 0 单调递增
 * @property {number} [progress]     0-100，下载阶段有效
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {boolean} retryable
 * @property {number} startedAt
 * @property {number} [finishedAt]
 */
```

持久化：任务表写 `<globalStorageUri>/skill-jobs/<workspaceId>.json`，原子写。任务日志是机器本地状态，不写进 `.agents/`，不随仓库同步。扩展启动时读取该文件，把所有非终态任务置为 `failed` + `INTERRUPTED`（可重试）。

`blocked` 不是持久化状态，是 `failed && retryable: false` 的 UI 推导态（见 5.4）；事件合并与快照口径中按该条件等价处理。

### 5.4 安装状态机

```
ready ──install──▶ installing ──ok──▶ installed
                      │
                      ├──retryable fail──▶ failed ──retry──▶ installing
                      └──non-retryable──▶ blocked（保留原因，不可重试）
```

- `installing` 细分管道阶段（downloading → verifying → extracting → registering），UI 统一显示【安装中…】。
- `installed` 判定：登记中存在该 `skillId` 且 `source: market`，且 `<dir>/SKILL.md` 存在。**不比对 `digest`**；`dirDigest` 不一致只标 `altered`，不改变已安装状态。`source: import` 的登记不参与本状态判定。
- `failed` 转 `retry` 的条件是 `retryable: true`，取值见 7.1；不可重试的错误直接进 `blocked` 并展示原因，不提供重试按钮。
- `blocked` 是终态：再次点击安装会生成新 `jobId`（去重只看在跑任务），不复用旧 ID。

**状态 → 按钮文案（PRD 五态 + 任务级阻断的唯一口径）**

| 目录级 / 任务级 | 按钮 | 可点击 | 附注 |
| --- | --- | --- | --- |
| 无登记、`compat: compatible` | 【安装】 | 是 | 目标目录被本地同名技能占用时附注「本地已有同名技能」 |
| 任务在跑（含 `queued`） | 【安装中…】 | 否 | 显示进度或阶段文案 |
| 已安装 | 【已安装】 | 否 | 登记版本落后于目录项时附注「有 vX 可用」（目录项版本以详情 `publishedVersion` 为准，未回填时不显示附注），更新入口在详情页（阶段 3） |
| 任务失败且可重试 | 【重试】 | 是 | 保留失败原因 |
| `compat: incompatible` | 【不兼容】 | 否 | 显示最低客户端版本 |
| `compat: restricted` | 【已限制】 | 否 | 显示组织策略说明 |
| 安装中被阻断（来源校验/目录冲突/包非法） | 【无法安装】 | 否 | 显示具体原因；**不复用**【不兼容】/【已限制】（偏离 14 #12） |

PRD 五态中没有「可更新」态，列表不新增「可更新」按钮；版本更新入口放在详情页，随安装链路在阶段 3 交付，复用同一条覆盖管道（不另立管道），登记在 14 节。

### 5.5 目录命名与校验

统一规则：**安装目录名取「来源目录名」**，与现有导入行为一致，不改动存量目录。市场安装取 zip 包内技能根目录名（单层根目录自动剥离后剩下的那一层，见 8.1）；本地导入取源文件夹名（与现状 `importLocalSkill` 一致）。两者都不加发布者前缀、版本后缀、随机串；同名冲突按 8.3 处理，不自动改名。

安全校验（三种路径共用，`skillsModel.normalizeDirName`）：

- 必须是非空单层名称：拒绝 `.`、`..`、含 `/` 或 `\`、含控制字符、以 `.` 开头的隐藏名。
- 拒绝 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`）与结尾的 `.`、空格。
- 不做大小写折叠、不做非法字符替换：名字不合规就拒绝并报 `ARCHIVE_INVALID`（导入场景提示用户改文件夹名）。静默改名会让用户找不到自己的技能，也违背「保持原名」决策。
- 长度上限 64 字符。

存量兼容：既有导入目录名本来就是源文件夹名，无需迁移；若历史上手工改过目录名，登记里的 `dir` 仍是唯一依据，按 `dir` 识别，不按名称反推。

## 6. 消息协议

扩展侧统一在 `extension.js` 的消息分支处理，实现放独立模块。旧消息保持字段兼容（新增字段可选、缺省有默认值），不删不改语义。

| 方向 | 消息 | 参数 / 返回 | 说明 |
| --- | --- | --- | --- |
| Webview → 扩展 | `marketList` | `{ query?, label?, sort?, page? }` | 拉远程目录（`/search`），服务端搜索筛选排序，`page` 从 0 开始；仅【全部】页签使用 |
| | `marketDetail` | `{ skillId, version? }` | 请求远程详情（扩展侧把 skillId 拆为 namespace/slug 路径参数），一并拉版本列表与概览 |
| | `marketLogin` | `{ username, password, code?, uuid? }` | SkillHub 登录（`/login`）；服务端要求验证码时先经 `marketCaptcha` 取图再附带 `code`/`uuid` 重试 |
| | `marketCaptcha` | 无 | 取登录验证码 `{ uuid, image }`（`/captchaImage`，平台开启时） |
| | `marketLogout` | 无 | 清除 SkillHub JWT，不影响 Codex 会话 |
| | `marketInstall` | `{ skillId, version }` | 提交安装，返回 `{ jobId }`；digest 由管道下载后自算（8.1），不由前端传入；版本更新复用本条消息，传新 `version`，不另立消息 |
| | `marketRetry` | `{ jobId }` | 重试可重试的失败任务，返回新 `{ jobId }`（不复用旧 ID） |
| | `getInstallJobs` | 无 | 拉当前工作区任务快照（**在跑 + 失败**；`done` 不含，以登记重建），含其他窗口发起的任务；webview 重开或切回市场时先调用一次，之后靠 `installEvent` 增量 |
| | `installedList` | 无 | 【已安装】页签全量：本机索引 ∪ 工作区登记，纯本地，不请求远程 |
| | `listSkills` | 无 | 取 Codex 技能索引 |
| | `getSkillDetail` | `{ path }` | 本地详情：元数据 + `SKILL.md` + 文件列表 |
| | `importSkill` | `{ mode? }`，`folder` 或 `zip` | 本地导入；`mode` 缺省按 `folder`，兼容旧 webview |
| | `reimportSkill` | `{ path }` | 重新导入缺失目录项；继承原登记的 `source` 与 `skillId` |
| | `unregisterSkill` | `{ path }` | 仅移出登记、不动磁盘文件（目录已不存在时的清理入口） |
| | `setSkillEnabled` | `{ path, enabled }` | 启停 |
| | `deleteSkill` | `{ path }` | 删除目录 + 清登记，仅限可管理的 scope（见 9.3） |
| | `openSkillFile` / `revealSkill` | `{ path }` | 打开文件 / 资源管理器定位 |
| 扩展 → Webview | `marketCatalog` | `{ items, page, size, total, hasNext, labelStats, cachedAt, stale, query, label, sort }` | `items` 为**本页**条目，前端按 `hasNext`/`page` 追加；`stale` 表示来自缓存；回带查询条件供前端丢弃过期响应 |
| | `marketDetailResult` | `{ skillId, version, skill, content, versions }` | 远程详情结果：`content` 为 SKILL.md 原文，`versions` 为版本列表（与请求消息区分命名，避免双向同名） |
| | `marketAuthState` | `{ loggedIn, baseUrlConfigured }` | 登录/登出/401 失效时推送，webview 据此切登录引导或配置引导 |
| | `marketError` | `{ code, message, retryable, scope: 'catalog'\|'detail'\|'auth' }` | 目录/详情/登录失败 |
| | `installJobs` | `{ jobs }` | 全量快照，口径同 `getInstallJobs`；重连先收快照再收增量 |
| | `installEvent` | `{ seq, workspaceId, jobId, skillId, version, digest?, state, errorCode?, retryable?, progress? }` | 与需求的事件字段一致，`digest` 为自算值（下载完成前缺省），`retryable` 由错误码推导，`seq` 为任务内单调递增序号 |
| | `installedSkills` | `{ items, reason: 'install'\|'import'\|'delete'\|'unregister'\|'toggle' }` | 【已安装】页签变更推送；`toggle` 只更新该项，其余 4 种整体替换 |
| | `skills` / `skillsDetail` / `skillsError` / `skillsNotice` | 沿用 | 本地技能 |

两个页签各自独立请求：`marketList` 只在【全部】签发，`installedList` 只在【已安装】页签发；安装成功后的 `installedSkills` 推送两页签都接收（前者把卡片转【已安装】，后者插入新项），避免各自轮询。重开市场或 webview 重载时，先 `getInstallJobs` 取快照把在跑与失败任务画出来，再接 `installEvent` 增量——只依赖推送会永久丢失断开期间的事件，按钮停在【安装】而实际已在安装，或丢失失败重试态。

事件合并：`installEvent` 按 `jobId` + `seq` 幂等，且只接受 `seq` 严格递增的事件——**不能用 `(jobId, state)` 作幂等键**，否则同一 `downloading` 状态下的多次进度事件会被当成重复丢弃，进度条只会动一次。已 `done` 或 `blocked`（即 `failed && !retryable`）的 `jobId` 不再接受后续事件。

## 7. 远程接口契约

真实契约已整理为 **`docs/skillhub-api.md`**（内网 SkillHub 后端接口，未实测；阶段 4 以实测与 Swagger `{BASE}/docs` 为准）。字段级细节以该文件为准，本节只登记插件侧口径与差异处理。插件能力边界与接口文档一致：仅检索、概览、详情、版本查看、下载安装；发布/管理/审核不在插件范围。

**基地址**：读环境变量 `SKILLHUB_BASE_URL`（外网开发留空，内网部署后填入），URL 无 `/dev-api` 等前缀，扩展激活时读取、变更需重载窗口。为空时禁用远程功能并给出配置引导，不报错崩溃；【已安装】不受影响。

**鉴权**：SkillHub 独立账号体系，**不复用 Codex OIDC token**。`POST /login`（form-urlencoded 账号密码）换取 JWT，后续请求带 `Authorization: Bearer <token>`；token 存 `context.secrets`（独立 key，与现有 OIDC token 分开），不入库不落明文。401 → 清 token、引导重新登录、原请求重试一次；平台开启验证码时先 `GET /captchaImage` 取 `uuid` 与图片，登录附带 `code`/`uuid`（触发方式阶段 4 实测校准）。账号需平台分配 `system:skill:list`、`system:skill:query`、`system:skill:download` 权限。登录态经 `marketAuthState` 推送，与 Codex 会话登录互不影响。

**接口映射**（统一前缀 `{BASE}/system/skillhub/skills`）：

| 插件动作 | 接口 | 要点 |
| --- | --- | --- |
| 列表 / 搜索 | `GET /search` | `q`/`label`/`sort`/`page`/`size`；返回 `items`/`total`/`labelStats`/`has_next`；**items 不含版本、摘要、兼容字段** |
| 详情 | `GET /{namespace}/{slug}` | 业务字段平级；`publishedVersion.version` 为当前发布版本 |
| 版本历史 | `GET /{namespace}/{slug}/versions` | 分页、发布时间倒序；安装门禁 `status === "PUBLISHED" && downloadReady === true` |
| 版本详情 | `GET /{namespace}/{slug}/versions/{version}` | 另含 `parsedMetadataJson`（内容阶段 4 实测） |
| 概览 | `GET /{namespace}/{slug}/versions/{version}/file?path=SKILL.md` | UTF-8 原文（octet-stream），非 JSON；失败为 JSON 错误体 |
| 安装下载 | `GET /{namespace}/{slug}/versions/{version}/download` | ZIP 流；**固定版本下载**，不用 `/download`（最新版）入口，避免安装过程中版本漂移破坏去重与固定版本语义 |

**响应约定**：成功以 `success == true` 判定（不看 `code`）；业务字段与 `code` 平级，不在 `data` 下；字段 camelCase，但示例中 `has_next` 为 snake_case——适配层兼容 `has_next`/`hasNext` 两种写法，阶段 4 实测确认。文件/下载接口按 `Content-Type` 分流：`application/zip` 写文件，`application/json` 解析错误体映射错误码。路径参数一律 URL-encode，`namespace`/`slug` 取自查询结果字段，不用展示名拼路径。

**分页与缓存**：`page` 从 0 开始 + `size`（默认 20），翻页保留当前 `q`/`label`/`sort`，客户端不一次拉全量。目录缓存写 `context.globalStorageUri` 下 `market-cache.json`，全局一份、跨工作区共用，TTL 10 分钟；过期先展示缓存再后台刷新。缓存按 `q` + `label` + `sort` 分组（页码在组内追加），切换条件不互相覆盖；分组上限 20 个、文件总量上限 2 MB，超出按最近使用时间淘汰最旧分组。

**排序**：服务端 `sort`（`newest` 默认 / `relevance` / `downloads` / `rating`），客户端不跨页重排。原「按发布者 + 名称稳定排序」为本文档自定口径，真实接口不支持，作废（14 #18）。

**包摘要（digest）**：服务端不提供包摘要，下载响应无 `digest` 头。客户端下载后自算 zip sha256 作为 `digest`（事件字段、登记、排查用），完整性靠 zip CRC 与声明大小校验（9.2）；`DIGEST_MISMATCH` 由 `ARCHIVE_CORRUPT` 替代（7.1）。阶段 4 若实测 `parsedMetadataJson` 含校验和，再恢复服务端比对。

**兼容与组织策略**：接口无 `compat`/`minClientVersion`/组织策略字段。目录级默认 `compatible`；「已限制」语义由 403（账号无权限）/404（无权可见）承担（7.1）；「不兼容」暂无服务端依据，保留 UI 态与桩用例，阶段 4 确认是否有替代字段（14 #20）。

**下载细节**：超时 ≥ 60s（应用服务器流式传输）；`Content-Disposition` 的 `filename` 为 URL-encoded，解码后仅作排查参考——安装目录名仍按 5.5 取包内根目录名。接口文档建议安装目录 `{namespace}--{slug}`，本规划维持决策 3（来源目录名），同名冲突按 8.3 阻断，差异登记 14 #19。

**【已安装】页签不请求任何远程接口**（见 3.2），接口侧不为它设计批量补齐能力。

### 7.1 错误码

| errorCode | 触发 | 可重试 |
| --- | --- | --- |
| `NETWORK` | 请求超时、连接失败（下载超时阈值 ≥ 60s） | 是 |
| `UNAUTHORIZED` | HTTP 401 / JWT 失效 | 是（清 token 重新登录后原请求重试一次；仍失效则转登录引导） |
| `FORBIDDEN` | HTTP 403：账号缺少 `system:skill:*` 权限 | 否（提示「无权限」，引导到平台调整角色权限，不清 token） |
| `NOT_FOUND` | HTTP 404：技能/版本不存在，**或当前账号无权可见** | 否（提示资源不可用并刷新列表） |
| `INCOMPATIBLE_CLIENT` | 客户端版本低于 `minClientVersion`（暂无服务端字段，仅桩/本地判定） | 否 |
| `ORG_RESTRICTED` | 目录级组织策略限制（暂无服务端字段，桩构造；阶段 4 若确认 403 即组织限制则与 `FORBIDDEN` 合并） | 否 |
| `SOURCE_VERIFY_FAILED` | 来源/身份校验失败（8.1 步骤 7） | 否 |
| `ARCHIVE_INVALID` | 包结构非法：缺 `SKILL.md`、含符号链接、绝对路径或 `..`、目录名不合规 | 否 |
| `ARCHIVE_TOO_LARGE` | 解压后超过总量/文件数/单文件限额 | 否 |
| `ARCHIVE_CORRUPT` | zip CRC 或声明大小校验失败（服务端无摘要可比对，替代原 `DIGEST_MISMATCH`） | 是（重新下载） |
| `DISK_FULL` | 磁盘空间不足 | 是（用户清理空间后可原地重试） |
| `VERSION_CONFLICT` | 登记文件并发写导致版本冲突 | 是 |
| `LOCK_TIMEOUT` | 目标目录被其他窗口/任务长期占用，心跳失效前无法获取 | 是 |
| `DIR_CONFLICT` | 目标目录已被其他技能的登记或手工文件占用 | 否 |
| `INTERRUPTED` | 扩展重启导致任务中断 | 是 |

`LOCK_TIMEOUT` 与 `VERSION_CONFLICT` 不复用同一码：前者是锁等待超时，后者是登记内容冲突，排查路径不同。鉴权类与资源类错误在所有接口表现一致，在 HTTP 封装层统一拦截；下载接口的 JSON 错误体按 `Content-Type` 分流后映射同一套错误码（接口文档第 6 节）。

### 7.2 桩数据

- `apps/dicode-vscode/marketStub.js` 内置一份目录与详情，**响应形状与 `docs/skillhub-api.md` 一致**（success 外层、平级业务字段、page/size 分页、`labelStats`、`has_next`、`publishedVersion`、版本列表、SKILL.md 原文），适配层与真实实现共用；覆盖五态所需字段：可安装、安装中（仅渲染用，状态由外部指定）、已安装、可重试、不可安装（一条 `incompatible`、一条 `restricted`，真实接口无对应字段，仅桩构造）；可构造四类安装阻断错误（CRC 损坏、来源校验失败、不兼容、组织限制）与目录请求失败、401/403/404。
- 桩只负责「数据与状态字段」，**不模拟安装动作**；真实的下载、解压、失败与重试由阶段 3 的管道 + 本地桩包驱动，避免阶段 2、3 各有一套假安装逻辑。登录态在桩模式下可切换（供登录引导 UI 验收），真实鉴权在阶段 4。
- 启用条件：配置项 `dicodeCodex.skillMarketStub` 为 `true`，默认关闭，避免误连；在 `package.json` 的 `contributes.configuration` 中声明。桩数据只在扩展侧生效，webview 不感知来源，阶段 4 只替换 `skillMarket.js` 的传输实现并接入 `skillHubAuth.js`。
- 桩包为固定结构 zip（单层根目录 + `SKILL.md`），共四种：正常包（走通完整链路）；CRC 损坏包（触发可重试的 `ARCHIVE_CORRUPT`，重试时换用正确桩包使其成功，闭环「模拟失败可恢复」验收，见 12.2；服务端不提供摘要，原「摘要不符包」改为此形态）；缺 `SKILL.md` 包（`ARCHIVE_INVALID`，不可重试）；超限包（`ARCHIVE_TOO_LARGE`，不可重试）。

## 8. 安装链路

### 8.1 管道

1. 校验目录项：`compat` 必须为 `compatible`，目标版本 `status === "PUBLISHED" && downloadReady === true`（版本列表/详情字段）；目标目录若已被**其他 `skillId` 或未登记目录**占用，先按 8.3 判冲突，避免下载完才失败（同一 `skillId` 的既有目录属升级场景，不算冲突）。
2. 去重：按 `(workspaceId, skillId, version)` 查在跑任务（含其他窗口写入的任务日志），命中则复用原 `jobId`。
3. 下载：走指定版本 ZIP 接口（第 7 节），写 `context.globalStorageUri/downloads/<jobId>.zip`，超时 ≥ 60s；按 `Content-Type` 分流（zip 写文件 / JSON 错误体映射错误码），报进度，每阶段至少发一次带 `seq` 的事件。
4. 校验：zip CRC 与声明大小校验（解析器内置，失败报 `ARCHIVE_CORRUPT`，可重试）；自算 sha256 作为 `digest` 写入任务与登记。服务端不提供包摘要，不做远端比对（第 7 节）。
5. 解压：复用 `skillArchive.js` 的安全解压规则（见 9.2），拒绝绝对路径、`..`、符号链接、加密条目、超限包。
6. 定位技能根：单层根目录自动剥离；多层或直接放根部的，以 `SKILL.md` 所在目录为技能根；目录名按 5.5 校验。
7. 内容校验：`SKILL.md` frontmatter 必须含 `name`、`description`，且 `name` 与目录项 `slug` 或 `name`（displayName）之一一致（身份校验；真实包的命名对应规则阶段 4 实测校准；目录名不再由 `name` 决定，见 5.5），均不一致按 `SOURCE_VERIFY_FAILED` 拒绝。
8. 登记：写入 `<workspace>/.agents/skills/<来源目录名>`，`skillId` 取 `namespace/slug`、`digest` 取自算值，成功后原子写登记。
9. 刷新：`skills/list` 带 `forceReload: true`，让 Agent 索引立即生效。
10. 清理：无论成败删除临时 zip 与临时解压目录。

临时目录必须建在目标同级（`<workspace>/.agents/skills/.tmp-<jobId>`）而不是 `globalStorageUri`：跨盘时 `rename` 会因 `EXDEV` 失败，同盘同目录才能保证原子切换，且失败清理不触碰已安装版本。

### 8.2 去重与并发

- 同一 `(workspaceId, skillId, version)` 只有一条 `InstallJob`，连续点击不产生第二条记录。去重依据是**任务日志文件**而非内存表，第二个窗口也能看到在跑任务。
- 目录写入前加锁：`<globalStorageUri>/skill-locks/<workspaceId>/<dir>.lock`，内容为 `{ owner, pid, heartbeatAt }`，运行期每 5 秒心跳。
- 锁失效判定：`heartbeatAt` 超过 30 秒未更新视为持有者已死，清理后可获取；未失效的锁不能强行抢占，等待超时（默认 60 秒）报 `LOCK_TIMEOUT`（可重试）。不按「锁文件存在时长」判断失效。
- 不同技能可并行，**每工作区并发安装上限 2**；同一技能不同版本串行，避免互相覆盖。超过上限的请求进 `queued`。

### 8.3 覆盖与回滚

目录名取「来源目录名」（5.5）。市场安装是无人值守流程，同名一律阻断；本地导入是交互流程，由用户当场决定——两者策略不同是有意为之。冲突按下表统一处理：

| 场景 | 目标目录状态 | 处理 |
| --- | --- | --- |
| 市场安装 | 同一 `skillId` 已登记、版本不同（升级） | 装到 `<dir>.new`，成功后 `<dir>` → `<dir>.bak`、`<dir>.new` → `<dir>`，再删 `.bak`。任一步失败：删 `.new`，`.bak` 还原，登记保持旧版本，原版本继续可用 |
| 市场安装 | 不同 `skillId` 的登记，或未登记目录 | 不覆盖、不改名，报 `DIR_CONFLICT`（不可重试），给两条路径：「删除本地目录后重新安装」（删除后点【安装】生成新 `jobId`）或「查看本地版本」。市场卡片提前附注（3.2），不让用户白点 |
| 本地导入 | `source: import` 登记项（含同 `skillId` 同版本，均为 `0.0.0-local`） | 用户当场选：覆盖 / 重命名 / 取消。覆盖前先备份 `<dir>.bak`，失败还原保留原版本；成功后按 9.2 写登记 |
| 本地导入 | 未登记（手工放置）目录 | 同上，用户当场选：覆盖 / 重命名 / 取消 |
| 本地导入 | `source: market` 登记项 | **直接阻断，不提供覆盖**：提示「该目录由市场管理，请先删除市场版本，或换个文件夹名导入」，不写登记、不动文件——避免导入把市场项悄悄变成本地项、在【全部】退回【安装】 |

- 升级时目录名变化（市场侧改了包内根目录名）视为新目录安装，旧目录转 `missing` 并在详情提示，不自动删除。
- 并发：同一目录的写入按 8.2 的锁串行，两个技能同时装到同名目录时只有一个成功，另一个报 `DIR_CONFLICT`。

### 8.4 后台继续与重连

- 安装跑在扩展宿主侧，webview 关闭或切走继续执行；重开市场先调 `getInstallJobs` 取快照（见第 6 节），再接 `installEvent` 增量。
- 扩展重启：读取任务日志，把非终态任务标 `failed`（`INTERRUPTED`，可重试），并清理残留临时目录；已 `done` 以登记为准重建，不依赖任务日志。
- 多窗口同工作区：任务日志与锁都在 `globalStorageUri`，所有窗口共享。第二个窗口发起同名安装时命中在跑任务，接入同一条 `jobId` 订阅（只读），不重复执行；登记文件仍是最终真相来源，写入后其他窗口监听文件变化刷新。

### 8.5 索引刷新

安装成功必须让 Codex 重新扫描，否则装完不可用。失败时登记已写入但标 `indexStale: true`，页面提示「已安装，索引待刷新」并提供重试。「重试刷新索引」与安装重试是两条独立动作，不共用 `jobId`。

## 9. 【已安装】页签与本地能力

本页签把本机技能索引与工作区登记按 `dir` 取并集（独立性口径见 3.2）。扫描与合并需排除 `.tmp-*`、`*.new`、`*.bak` 残留目录，避免其被当作 `external` 项展示。三类来源都要展示：

| 来源 | 判定 | 可做的操作 |
| --- | --- | --- |
| 市场安装 | 登记有记录且 `source: market` | 启停、详情、删除、重新导入、更新（阶段 3 起） |
| 本地导入 | 登记有记录且 `source: import` | 启停、详情、删除、重新导入 |
| 手工放置 | 索引有、登记无 | 启停、详情；删除需二次确认 |

- 两边各缺一边时不隐藏该项：登记有而索引无标 `missing`（目录被外部删除或切换分支导致），索引有而登记无标 `external`。手工放置项不写登记（见 5.2），要转为受管项走「重新导入」。
- `reimportSkill` 继承原登记的 `skillId` 与 `source`：市场项重新导入后仍是 `market`，在【全部】仍显示【已安装】；若原目录已被替换为不同内容，按 `SOURCE_VERIFY_FAILED` 处理并保留旧登记。它与 `importSkill` 不同：前者只补齐缺失目录、**保持原身份**；后者是普通导入，目标若为市场安装项按 8.3 阻断，不覆盖、不改 `source`。
- `unregisterSkill` 只删登记、不动文件：用于目录已被外部删除后的清理；执行后该项转为 `external`（目录仍在）或直接消失（目录已不在）。
- 按名称稳定排序，来源用标签展示，不做分组，避免安装后条目跳位。

### 9.1 未登录可用

1. 新增 `ensureSkillClient()`：不调用 `accessToken()`，启动独立 app-server 实例，仅用于 `skills/list` 与 `skills/config/write`；模型目录用 CLI 自带模型构造；实例随 webview 释放而 dispose，不常驻；**后台安装完成时也可按需拉起（8.1 步骤 9），不受 webview 生命周期限制**。
2. `importSkill`、`reimportSkill`、`unregisterSkill`、`getSkillDetail`、`deleteSkill`、`openSkillFile`、`revealSkill` 走纯文件系统，不依赖 client 与登录。
3. Codex 退出登录只清理会话 client，SkillHub 登出只清 market JWT，两者互不影响，都不影响技能页。【已安装】页签在未登录时是默认页签，读取与操作全部可用。
4. Codex CLI 未安装时沿用 `ensureBinary()`，失败提示「设置 `dicodeCodex.codexPath` 或登录后安装」。此时列表退化为目录扫描（`scope` 按位置推断、`enabled` 未知），**启停不可用**并给出原因——启停依赖 `skills/config/write`，这是 CLI 缺失时唯一降级的能力。若前置验证第 1 项走「写用户级配置」退化，启停按该路径实现，不再受此条限制。

### 9.2 导入（文件夹 + zip）

导入入口只出现在【已安装】页签，市场页签不设导入。点击后先让用户选择「从文件夹导入」或「从 ZIP 导入」，两者共用同一套校验与落盘逻辑。

**共用校验**

- 必须包含 `SKILL.md`，frontmatter 含 `name`、`description`。
- 拒绝符号链接、加密条目、绝对路径、含 `..` 的路径。
- 目录名取源文件夹名（文件夹导入）或包内技能根目录名（zip），按 5.5 校验合法性，不做大小写折叠与字符替换。
- 同名处理按 8.3 矩阵：导入项与手工目录可由用户当场选覆盖 / 重命名 / 取消；市场安装项一律阻断。

**zip 专项**

- 仅支持 store 与 deflate，解析时校验 CRC 与声明大小，不信任压缩包头部的解压后体积。
- 限制：压缩包 ≤ 20 MB、解压后总量 ≤ 100 MB、文件数 ≤ 500、单文件 ≤ 10 MB，超限直接拒绝（`ARCHIVE_TOO_LARGE`）。
- 解压到目标同级的临时目录，校验通过后再 `rename` 到 `<workspace>/.agents/skills/<目录名>`；失败清理临时目录，不动已安装版本。zip 内单层根目录自动剥离；多层或直接放在根部的，按 `SKILL.md` 所在目录为技能根。
- 解析器自研，只依赖 Node `zlib`，不给扩展宿主新增运行时依赖。

**落盘与登记**

- 覆盖前先备份到 `<dir>.bak`，失败还原并保留原版本（8.3）；成功后写 `source: import` 的登记记录，并调用 `skills/list`（`forceReload: true`）刷新索引，刷新失败标 `indexStale`。
- 导入过程显示进度；成功后刷新列表并提示，可跳转详情。本地导入项的 `version` 记为 `0.0.0-local`，`dirDigest` 取目录内容 sha256。

### 9.3 删除

- 删除前模态确认，显示将删除的目录；手工放置项额外提示「该目录不在安装登记中，可能是团队共享文件」，需二次确认。
- 允许删除：`source: market|import` 的登记项，以及 scope 为 `user` / `repo` 的手工放置项；`system` / `admin` 只读。（此处 scope 指索引的 `scope` 字段，与 `source` 含义不同。）
- 用 `workspace.fs.delete(..., { useTrash: true })`，同步移除登记记录，并推送一次 `installedSkills`。
- 删除市场安装项后，市场【全部】页签中该技能回到【安装】，不需要重新拉取远程目录。
- 删除后回列表并刷新。

### 9.4 启停

乐观更新 + 逐项 pending + 失败回滚并显示原因；刷新失败保留上一次有效数据。CLI 不可用时开关置为禁用并显示原因（9.1）。

## 10. 与其他需求的交点

| 需求 | 对市场的影响 |
| --- | --- |
| IDE 布局（最小化/最大化） | 最大化态列表与详情并排；窄面板前后两级；切换不重建状态；市场页最大化不显示历史列（3.1）。开关本身属 IDE 布局需求，验收依赖见 1.2 |
| 导航与任务入口 | 左上导航第 2 项进入；返回保留草稿。导航改造由本模块在阶段 1 前置完成 |
| 跨会话异步执行 | 安装按工作区调度，事件带 `workspaceId`、`jobId`、`digest`、`seq`；并行请求共用任务。**安装不占用 3 个执行槽位**（槽位约束 Agent 任务），另受 8.2 的每工作区并发上限 2 约束 |
| 事件与重连模型 | `installEvent` 纳入统一事件体系：按 `jobId` + `seq` 幂等、序号递增合并、先快照后增量 |
| 权限模式与审批 | 安装属宿主侧用户主动动作，不走 Agent 工具审批；组织策略拒绝与来源校验失败必须阻断 |
| 消息提醒 | 只覆盖任务与待决策，不含安装失败，本模块不扩展（见 1.3） |
| 深浅主题与 JetBrains | 导航栏、卡片、状态按钮、骨架需覆盖四套主题 |

## 11. 文件与模块影响

| 文件/模块 | 阶段 | 变更 |
| --- | --- | --- |
| 新增 `apps/dicode-vscode/skillsModel.js` | 0 | 类型、`compareVersion`、状态推导、去重键、目录名校验 |
| 新增 `apps/dicode-vscode/skillsRegistry.js` | 0 | 登记读写、原子写、短锁、损坏恢复 |
| 新增 `apps/dicode-vscode/skillsJobs.js` | 0 | 任务日志持久化（`globalStorageUri`）、目录锁与心跳、失效清理、重启置 `INTERRUPTED` |
| 新增 `apps/dicode-vscode/skillArchive.js` | 1 | zip 读取、安全解压、校验与临时目录管理 |
| 新增 `apps/dicode-vscode/installedView.js` | 1 | 索引与登记按 `dir` 合并、三类来源判定、`missing` / `external` / `indexStale` / `altered` 状态 |
| 新增 `apps/dicode-vscode/skillMarket.js` | 2、4 | 目录/详情/版本/概览请求、适配层（服务端字段 → UI 模型）、缓存与淘汰、page 分页、错误码映射；阶段 4 换真实传输 |
| 新增 `apps/dicode-vscode/skillHubAuth.js` | 4 | `/login` 与验证码、JWT 存取（`context.secrets`）、401 重登拦截、登录态推送 |
| 新增 `apps/dicode-vscode/marketStub.js` | 2 | 桩数据、状态字段、错误构造 |
| 新增 `apps/dicode-vscode/skillInstaller.js` | 3 | 下载（Content-Type 分流）、CRC 校验与自算摘要、解压、覆盖回滚、任务表与事件 |
| `apps/dicode-vscode/package.json` | 1、2、3 | 新增配置项 `dicodeCodex.skillMarketStub`、版本号递增、必要命令与脚本 |
| 新增 `apps/dicode-vscode/webview/NavRail.tsx` | 1 | 左上导航四项 + 左下用户中心/设置，替换顶栏图标 |
| 新增 `apps/dicode-vscode/webview/skills.ts` | 1、2 | 类型与纯函数（合并、过滤、排序、搜索、状态推导、按钮文案映射） |
| 新增 `apps/dicode-vscode/webview/Installed.tsx` | 1 | 【已安装】页签：来源标签、导入入口、启停、删除、本地详情、已启用筛选 |
| 新增 `apps/dicode-vscode/webview/Market.tsx` | 2、3 | 【全部】页签：市场列表、详情（概览 Markdown 渲染、版本历史）、登录/配置引导、安装按钮与状态；详情页更新入口在阶段 3 |
| `apps/dicode-vscode/webview/app.tsx` | 1、2 | 导航改造、路由、两页签容器与切换、消息处理、草稿保留 |
| `apps/dicode-vscode/webview/Subpages.tsx` | 1 | `SkillList` 由 `Installed.tsx` 取代，保留历史会话等其余子页 |
| `apps/dicode-vscode/webview/style.css` | 1、2 | 导航栏、来源标签、卡片、页签、骨架、状态按钮、详情排版 |
| `apps/dicode-vscode/extension.js` | 1、2、3、4 | 消息路由、`ensureSkillClient()`、导入/删除/详情/重新导入/移出登记、`installedList` 合并、市场登录消息接线（阶段 4） |
| 新增 `apps/dicode-vscode/test/skills-registry.test.js` | 0 | 原子写、锁、损坏恢复、跨窗口读一致性 |
| 新增 `apps/dicode-vscode/test/skills-jobs.test.js` | 0 | 任务日志写入与重放、心跳超时、失效锁清理 |
| 新增 `apps/dicode-vscode/test/skill-archive.test.js` | 1 | zip 解析、路径穿越、符号链接、超限、目录名校验 |
| 新增 `apps/dicode-vscode/test/installed-view.test.js` | 1 | 三类来源合并、`missing` / `external` / `altered` 判定、不请求远程 |
| `apps/dicode-vscode/test/skill-import.test.js` | 1 | 扩充 zip、覆盖、重新导入、移出登记、删除、启停、未登录 |
| 新增 `apps/dicode-vscode/test/skill-market.test.js` | 2 | page 分页、缓存分组（q+label+sort）与淘汰、错误码映射、适配层字段映射、桩契约形状 |
| 新增 `apps/dicode-vscode/test/skill-hub-auth.test.js` | 4 | 登录/验证码、401 清 token 重登后重试一次、403/404 映射、token 存取 |
| 新增 `apps/dicode-vscode/test/skill-installer.test.js` | 3 | 去重（跨窗口）、CRC 校验与自算摘要、解压安全、回滚、事件 `seq` 幂等 |
| `apps/dicode-vscode/README.md` | 5 | 市场与本地技能使用说明 |

## 12. 测试与验收

### 12.1 分阶段测试清单

**阶段 0**

- 登记原子写、并发短锁、损坏文件留 `.bak` 后可继续读、跨窗口读一致性；
- 状态推导覆盖五态；`compareVersion` 对预发布与多位版本号正确；
- 目录名校验：拒绝 `..`、路径分隔符、Windows 保留名、隐藏名；
- 任务日志写入后重放，非终态置 `INTERRUPTED`；锁心跳超时判定与过期清理。

**阶段 1**

- 导航改造后四项入口可用；进入市场再回对话，输入中草稿保留；
- 未登录 `listSkills` 返回本地技能且不触发 `accessToken`；未登录可列举、查看详情、导入、删除（启停依赖 CLI，缺失时按 9.1 提示且不影响其余操作）；
- 【已安装】页签按 `dir` 归并三类来源：市场安装、本地导入、手工放置各一条，标签与可操作项符合 9 节表格；登记有而目录无标 `missing`，目录有而登记无标 `external`，两种项都不被隐藏；扫描与合并不把 `.tmp-*` / `.new` / `.bak` 当作技能项；
- `altered` 只作附注，不改变已安装状态；详情校验后缓存标记，列表沿用；
- 本页签不发起任何远程请求（`marketList` / `marketDetail` 调用次数为 0）；详情读取的路径安全（拒绝 `..`、绝对路径、符号链接逃逸）；
- 文件夹导入成功；同名覆盖/重命名/取消可选，覆盖目标含导入项与手工目录，失败不破坏已有技能（备份还原）；导入目标为市场安装项时被阻断，提示先删除市场版本，不写登记、不动文件；
- 「已启用」筛选可用；zip 导入成功、单层根目录自动剥离；zip 路径穿越、符号链接、加密条目、超限包被拒绝且清理临时目录；
- 导入后写入 `source: import` 登记，列表与离线可用同时生效；
- `reimportSkill` 保持原 `source` 与 `skillId`；`unregisterSkill` 不动文件；
- 删除 `system` / `admin` 被拒；删除 `import` 项同步清登记；删除手工放置项需二次确认且不写登记；
- 启停失败回滚；CLI 缺失时启停禁用并提示。

**阶段 2**

- jsdom 覆盖搜索（命中名称/简介/标签）、页签切换与五态按钮渲染；两页签切换后各自状态保留；
- 【全部】的「已安装」标记只认 `source: market` 且 `skillId` 命中；同名本地导入项不显示为已安装，而是附注「本地已有同名技能」；
- SkillHub 未登录或基地址未配置进入市场落到【已安装】页签，切到【全部】显示登录/配置引导而不是错误态；
- 桩响应形状与 `docs/skillhub-api.md` 一致（success 外层、平级字段、page/size）；卡片版本空态、打开详情后回填；
- 五态按钮文案与禁用状态（按 5.4 映射表逐条核对）；在途状态不可重复点击；
- 骨架、错误、空态、缓存过期标注、离线已安装；缓存按 `q` + `label` + `sort` 分组、20 组 / 2 MB LRU 淘汰；
- 最小化/最大化切换后市场状态保持、最大化态列表与详情并排（以布局开关落地为前提，见 1.2）；
- 手工走查 VS Code 深/浅与 JetBrains 深/浅四套主题，状态色可辨识。

**阶段 3**

- 连续三次安装同一版本只产生一个 `jobId`；第二个窗口在同一工作区发起同一安装，接入同一条任务、不重复写目录；每工作区并发安装上限 2，超出进 `queued`；
- CRC 损坏、来源校验失败、不兼容、组织限制四类均不写登记；CRC 损坏桩包触发可重试的 `ARCHIVE_CORRUPT`，换用正确桩包后重试成功（模拟失败可恢复）；
- 快照含失败任务：webview 重载后可重试失败恢复为【重试】并保留失败原因；同状态下连续进度事件按 `seq` 全部生效，重复 `seq` 被忽略；
- 覆盖安装成功换版本；中途失败回滚且登记不变；详情页发起更新（目录项有更高版本）：走同一覆盖管道，成功后登记版本递增、卡片附注消失，失败回滚且旧版本仍可用；
- 目标目录被其他 `skillId` 或手工放置的目录占用时报 `DIR_CONFLICT`，不写入、不改名；
- 锁心跳中断 30 秒后可被接管；锁未失效时等待超时报 `LOCK_TIMEOUT`；
- 扩展重启后中间态转 `INTERRUPTED` 并可重试，临时目录被清理；索引刷新失败标 `indexStale` 并可重试；
- 安装成功后【已安装】页签立即出现该项、【全部】卡片转【已安装】，删除后【全部】卡片回到【安装】，两个方向都不需手动刷新；
- 安装完成后不重启，`skills/list` 能命中新技能（对应 PRD「调用」）。

**阶段 4**

- 真实 `/search` 分页（page 从 0、`has_next` 翻页）、`labelStats` 筛选、`sort` 切换；超时、离线回退；
- 登录（含平台开启验证码时）、401 清 token 重登后原请求重试一次、403 无权限引导、404 刷新列表；
- 下载 Content-Type 分流（JSON 错误体 / ZIP）、≥ 60s 超时、`Content-Disposition` 文件名解码；概览 SKILL.md 原文渲染；`PUBLISHED && downloadReady` 安装门禁；
- `has_next` 命名、`parsedMetadataJson` 内容、包内 `name` 与 `slug`/`displayName` 对应规则实测校准；真实数据量下缓存分组淘汰生效。

### 12.2 PRD 验收对照

| 验收点 | 阶段 / 方式 |
| --- | --- |
| 点击【安装】一次即可完成登记 | 3：8.1 全链路 |
| 连续点击只产生一条记录 | 3：8.2 去重 + 三次点击单 `jobId` |
| 模拟失败可恢复 | 3：CRC 损坏桩包 + 换包重试成功（7.2） |
| 安装后切到【已安装】能看到该项，重开市场状态正确 | 3：登记为真相来源 + 快照重建（含失败任务） |
| 覆盖失败后重试、原版本继续可用 | 3：8.3 覆盖回滚 |
| 离线或未登录时可读【已安装】 | 1：5.2 登记 + 3.4 离线读 |
| 自己导入或手工放进目录的技能在本页签可见 | 1：9 节归并表 |
| 两个页签数据源不串（已安装不请求远程、全部不用本地索引） | 1、2：12.1 阶段 1/2 断言 |
| 版本冲突、重复事件可识别 | 3：7.1 `VERSION_CONFLICT`、6 事件 `seq` 幂等 |
| 安装后 Agent 可发现该技能 | 3：8.5 索引刷新 + `skills/list` 命中 |
| 最大化时列表和详情并排 | 2：3.1、10（以布局开关落地为前提，见 1.2） |
| 本地导入（文件夹与 zip）可用 | 1：9.2 + 12.1 阶段 1 |
| 入口在左上导航第 2 项、返回保留草稿 | 1：导航前置任务 + 12.1 阶段 1 |

### 12.3 验证命令

在 `apps/dicode-vscode` 下执行 `npm run check`、`npm test`、`npm run build`。每阶段结束跑全量，不只跑新增用例。

`check` 脚本目前只对 3 个固定 JS 文件（`extension.js`、`fileEditTools.js`、`media/conversation.js`）做语法检查，新增模块不会被覆盖。需改为通配覆盖全部 `.js`（含 `media/`，如 `node --check *.js media/*.js`）或补一条 `check:lib`，不得丢失现有覆盖。阶段 0 完成。

## 13. 已确认决策

| # | 事项 | 决策 |
| --- | --- | --- |
| 1 | 设计稿缺口 | 按需求先实现：版本、简介、兼容状态留空态兜底；详情页按需求字段自行排版，不等稿；「声明能力/示例」两侧详情均空态兜底（市场接口无结构化字段，14 #16） |
| 2 | 登记文件 | 位于用户工作区，不入库；不静默改 `.gitignore`，首次写入检测并提示一次、提供确认动作；团队共享另出只含 `skillId` 与版本的推荐清单 |
| 3 | 安装目录命名 | 取来源目录名（导入＝源文件夹名，市场＝包内技能根目录名），不加发布者前缀与版本后缀；不合规则拒绝而非静默改名；同名冲突按 8.3。接口文档建议 `{namespace}--{slug}`，不采纳（14 #19） |
| 4 | 目录缓存 | 全局 `globalStorageUri`，跨工作区共用，按 `q` + `label` + `sort` 分组，20 组 / 2 MB 上限 + LRU 淘汰 |
| 5 | `INTERRUPTED` | 先用本地自定义码，阶段 4 若服务端有对应码再映射 |
| 6 | 发布节奏 | 阶段 3 收尾发一版内测 VSIX（桩数据模式），阶段 4 联调通过后发正式版 |
| 7 | 市场页结构 | 【全部】与【已安装】是两个页签、两套独立数据源，不是同一列表的过滤条件（见 3.2） |
| 8 | 已安装标记口径 | 只认登记中 `source: market` 且 `skillId` 命中；同名本地项不算，卡片附注「本地已有同名技能」 |
| 9 | 手工放置项 | 不写登记，以 `external` 展示，可启停与查看详情，删除需二次确认 |
| 10 | 默认页签 | SkillHub 已登录且基地址已配置进【全部】，否则进【已安装】 |
| 11 | 导航入口 | 「左上导航四项 + 左下用户中心/设置」由本模块在阶段 1 前置完成，不改布局开关 |
| 12 | UI 组件库 | 不引入 `@dicode/webview-ui`，两页均自研，视觉对照原型取值；后续接入时按组件 props 形状留适配点 |
| 13 | CLI 侧安装 | 不在本模块职责范围：不排期、不验收、不做复用契约、不对齐终端团队 |
| 14 | 事件与任务持久化 | 事件按 `jobId` + `seq` 幂等；任务日志与目录锁存 `globalStorageUri`，不写进工作区 |
| 15 | 版本更新呈现 | 列表保持 PRD 五态、不加「可更新」按钮；登记版本落后时卡片附注 + 详情页更新入口，随阶段 3 交付，复用覆盖管道 |
| 16 | 既有能力保留 | 仅保留「已启用」筛选与文件夹导入；详情、删除、同名覆盖/重命名/取消、未登录可用为新增能力（见 2.4 B） |
| 17 | 市场鉴权 | 独立 SkillHub 账号登录（`/login` 换 JWT，可选验证码），token 存 `context.secrets`，与 Codex OIDC 互不影响；401 清 token 重登后原请求重试一次 |
| 18 | 包摘要 | 服务端不提供 digest；客户端下载后自算 zip sha256 作为 digest（事件/登记），完整性靠 CRC 校验；`ARCHIVE_CORRUPT` 替代 `DIGEST_MISMATCH` |
| 19 | 技能身份与安装定位 | `skillId` = `namespace/slug`（取自查询结果），安装以 id + version 定位、固定版本下载；列表无版本字段，卡片空态 + 详情回填 |
| 20 | 排序与筛选 | 服务端 `sort`（默认 `newest`）+ `label` 筛选（`labelStats` 下拉），客户端不跨页重排；原「发布者 + 名称」口径作废 |

## 14. 偏离登记（需产品 / UI 知会）

PRD 未定义、由本文档自行取舍或与设计稿不一致的项集中在此，未确认前不作为最终口径。

| # | 项 | PRD / 设计稿口径 | 本文档口径 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 【已安装】的形态 | PRD：「顶部提供搜索及【全部】【已安装】两个**筛选项**」 | 两个页签、两套独立数据源（否则已装项落在第 3 页就查不到） | 已确认（决策 7），PRD 措辞后续对齐 |
| 2 | 已安装判定范围 | PRD：「已安装筛选以当前工作区登记记录为准」 | 只认 `source: market`，导入项不算（身份不同） | 已确认（决策 8） |
| 3 | 版本更新 | PRD 五态无「可更新」态，也未定义更新动作 | 列表保持【已安装】，卡片附注 + 详情页更新入口（阶段 3，复用覆盖管道） | 按 PRD 处理，备案 |
| 4 | 原型的【已安装】 | 原型是市场列表的本地过滤（`installed.has(id)`），无独立数据源 | 独立数据源、纯本地 | 待 UI 更新原型 |
| 5 | 原型的市场卡片 | 只有名称 + 发布者/能力 + 按钮，无版本、简介、兼容状态 | 六字段齐全（按 PRD） | 待 UI 补稿 |
| 6 | 原型无详情页 | 原型未提供 | 按 PRD 字段自行排版 | 待 UI 补稿 |
| 7 | 组件库 `SkillMarket` | UI 组件库提供该组件（含详情与安装重试） | 不接入，自研（决策 12） | 需 UI 团队知会 |
| 8 | 导入 / 删除 / 启停 | PRD 全文未要求 | 作为本地管理能力纳入（2.4 B，新增/保留逐项标注） | 备案 |
| 9 | CLI 侧安装 | PRD 发布验收含「Skill 安装」 | 不在本模块职责范围，终端团队自行负责 | 已定，不跟进 |
| 10 | 市场页最大化布局 | PRD 对话页最大化「左侧常驻历史列表」；市场章节「列表和详情并排」 | 市场页最大化不显示历史列 | 待 UI 确认 |
| 11 | 安装与执行槽位 | PRD 未说明安装是否占执行槽位 | 不占，另有每工作区并发上限 2 | 待产品确认 |
| 12 | 任务级阻断态 | PRD 将来源校验失败归入「不可安装」（【不兼容】/【已限制】），未区分目录级与任务级 | 目录级 `compat` 显示【不兼容】/【已限制】；任务级阻断（来源校验、目录冲突、包非法）显示【无法安装】+ 原因，不复用文案 | 实现细化，备案 |
| 13 | 默认页签 | PRD 未定义进入市场时的默认页签 | SkillHub 已登录且基地址已配置进【全部】，否则进【已安装】 | 内部已定（决策 10），备案 |
| 14 | 导入同名处理 | PRD 未定义 | 导入不得覆盖市场项（提示先删除市场版本或改名导入）；导入项与手工目录可由用户当场选覆盖/重命名/取消；不静默改 `source` | 内部已定，备案 |
| 15 | 卡片版本字段 | PRD 六字段含版本；`/search` 不返回版本 | 卡片版本空态兜底，打开详情后以 `publishedVersion.version` 回填缓存；不做逐卡 N+1 预取 | 待产品确认（或后端补字段） |
| 16 | 详情的声明能力/示例 | PRD 要求展示；接口无结构化 `capabilities`/`examples` | 概览渲染 SKILL.md 原文；声明能力/示例空态兜底（与已安装详情同口径），不猜测性解析 | 待产品确认 |
| 17 | 包摘要语义 | PRD 安装链路固定摘要、事件含 `digest`；接口无摘要 | `digest` 为客户端自算 sha256（PRD 字段保留）；完整性靠 zip CRC 校验；`ARCHIVE_CORRUPT` 替代 `DIGEST_MISMATCH` | 备案（语义调整） |
| 18 | 列表排序 | 本文档原自定「发布者 + 名称稳定排序」；接口仅 `newest`/`relevance`/`downloads`/`rating` | 服务端 `sort`，默认 `newest`，客户端不跨页重排 | 内部已定（决策 20），备案 |
| 19 | 安装目录命名 | 接口文档建议 `{namespace}--{slug}` 防重名 | 维持决策 3 来源目录名，跨命名空间重名按 8.3 阻断 | 内部已定，备案 |
| 20 | 兼容/组织策略字段 | PRD 五态含【不兼容】【已限制】；接口无对应字段 | 目录级默认 `compatible`；【已限制】由 403/404 映射；【不兼容】仅桩构造，阶段 4 校准 | 待产品/后端确认 |
