# DiCode Skill 市场内网联调测试手册

> 适用扩展：`dicode-codex` 0.2.54（VSIX 见 `apps/dicode-vscode/dicode-codex-0.2.54.vsix`）
> 代码基线：`feat/skill-market`，以实际打包提交为准
> 关联文档：[Skill 市场开发规划](dicode-skill-market.md)、[SkillHub 接口契约](skillhub-api.md)、[使用说明](../apps/dicode-vscode/README.md)
> 执行方式：内网人工或 Agent 按本手册逐项执行，结果填入第 10 节模板
> 日期：2026-11-18

## 1. 目标与范围

验证 VSIX 在内网真实 SkillHub 环境下的登录、目录、详情、下载安装、本地技能管理与 UI 表现，并完成接口契约校准。

**包含**：真实鉴权、目录分页/搜索/筛选/排序、详情与概览、真实 ZIP 下载与安装、更新与回滚、权限与错误场景、多窗口与中断恢复、四主题与布局人工验收。

**不包含**：平台发布/审核/管理端、CLI 侧技能安装、IDE 布局开关本身的开发、桩数据模式验收（本地已完成）。

## 2. 前置条件

### 2.1 环境清单

| 项 | 要求 | 实际值（填写） |
| --- | --- | --- |
| VS Code | 1.93.1 及以上 |  |
| 扩展 | `atad-apts.dicode-codex@0.2.54`，或本次内测 VSIX |  |
| 操作系统 | Windows / macOS / Linux |  |
| 网络 | 可访问内网 SkillHub 与 Swagger |  |
| `SKILLHUB_BASE_URL` | SkillHub 根地址，如 `http://<IP>:9099` |  |
| Swagger | `{BASE}/docs` 可打开 |  |
| Codex CLI | 已安装，或 `dicodeCodex.codexPath` 指向可用路径 |  |
| 测试工作区 | 新建空目录，勿使用生产仓库 |  |
| 测试账号 | 具备 `system:skill:list`、`system:skill:query`、`system:skill:download` |  |
| 辅助账号 | 无技能权限账号，用于 403；可选 |  |
| 第二窗口 | 同一工作区再开一个 VS Code 窗口，用于多窗口用例；可选 |  |

### 2.2 先核对基地址与路由假设

插件当前的调用约定：

- `POST {BASE}/login`、`GET {BASE}/captchaImage`：直接拼在根地址下。
- 目录、详情、版本、概览、下载：`{BASE}/system/skillhub/skills{接口路径}`。
- `SKILLHUB_BASE_URL` 只填协议 + 主机 + 端口，不要带 `/system/skillhub/skills` 或 `/dev-api`；末尾斜杠会被去掉。

执行前先对照 Swagger 核对上述路由。若网关前缀不同，**先记录并停止相关用例**，不要在现场改代码或用错误基地址绕过。

### 2.3 测试数据

在后端准备以下测试技能，全部使用测试命名空间，禁止使用生产技能：

| 编号 | 建议标识 | 要求 | 用于用例 |
| --- | --- | --- | --- |
| S1 | `demo/basic-skill` | 已发布、`downloadReady=true`，包为标准 ZIP（单层根目录 + `SKILL.md`，`name` 等于 `slug` 或 `displayName`） | INS-01、INS-02、LOC-05 |
| S2 | `demo/update-skill` | 先安装 1.0.0，再发布 1.1.0，两个版本均可下载且包名匹配 | INS-06、INS-07 |
| S3 | `demo/unready-skill` | 版本为 `DRAFT`，或 `downloadReady=false` | INS-09 |
| S4 | `demo/bad-name-skill` | 包内 `SKILL.md` 的 `name` 与 `slug`、`displayName` 都不一致 | INS-12 |
| S5 | `demo/no-skillmd-skill` | ZIP 内缺少 `SKILL.md` | INS-11 |
| S6 | `demo/corrupt-skill` | CRC 损坏或截断的 ZIP；后端允许上传时准备 | INS-13 |
| S7 | `demo/no-permission-skill` | 测试账号不可见或返回 403 | INS-10、AUTH-09 |
| S8 | `demo/multi-ns-skill` | `namespaces` 含多个命名空间 | CAL-06 |
| S9 | 至少 25 条 | 覆盖多个 `skillLabel`，至少 2 页 | CAT-03、CAT-04、CAT-05 |
| S10 | `demo/need-key-skill` | `needApiKey=true`，可选 | 卡片附注 |
| S11 | 大包 | 压缩包 > 20 MB 或解压后 > 100 MB，可选 | INS-14 |

另外准备：

- 一个合法本地技能文件夹（含 `SKILL.md`，frontmatter 有 `name`、`description`）。
- 一个合法本地技能 ZIP。
- 一个与 S1 包内根目录同名的本地目录，用于 `DIR_CONFLICT`。

> 后端无法构造 S4–S6、S11 时，对应用例标记 `BLOCKED`，不要上传危险文件到共享测试环境；这些分支已有本地单测覆盖。

## 3. 安装与配置

### 3.1 安装 VSIX

```powershell
code --install-extension "D:\path\to\dicode-codex-0.2.54.vsix" --force
```

安装后在扩展列表确认 `atad-apts.dicode-codex@0.2.54`。若 `code` 不在 PATH，可在 VS Code 扩展视图右上角 `...` → **Install from VSIX** 选择文件。

### 3.2 配置基地址并重启

环境变量必须在 VS Code 启动前生效。Windows 用户级设置示例：

```powershell
[Environment]::SetEnvironmentVariable('SKILLHUB_BASE_URL', 'http://<IP>:9099', 'User')
```

设置后完全退出 VS Code 再启动（仅 Reload Window 不会重新读取进程环境变量）。

检查桩数据已关闭：设置中搜索 `dicodeCodex.skillMarketStub`，确认为 `false`。
检查 Codex CLI：设置中搜索 `dicodeCodex.codexPath`，或确认终端中 `codex` 可用。

### 3.3 首次检查

1. 打开测试工作区。
2. 点击左侧 DiCode 图标，进入 **Skill 市场**。
3. 默认应停在【已安装】；切到【全部】后应显示登录引导，而不是「市场服务未配置」。
4. 打开输出面板，选择 **DiCode Codex**，后续失败时在此取日志。

### 3.4 数据位置

- 技能目录：`<工作区>/.agents/skills/<目录名>`
- 安装登记：`<工作区>/.agents/skills.registry.json`
- 任务日志：`<globalStorage>/skill-jobs/<workspaceId>.json`
- 目录锁：`<globalStorage>/skill-locks/<workspaceId>/<目录名>.lock`
- 市场缓存：`<globalStorage>/market-cache.json`
- 下载临时包：`<globalStorage>/downloads/<jobId>.zip`（任务结束后应清理）

Windows 的 globalStorage 通常在：

```text
%APPDATA%\Code\User\globalStorage\atad-apts.dicode-codex
```

### 3.5 清理与重置

每个用例建议使用新的测试工作区，或执行：

1. 在【已安装】删除测试技能。
2. 退出 VS Code，删除测试工作区的 `.agents` 目录。
3. 需要清登录态时，在技能详情底部点「退出 SkillHub 登录」。
4. 测试结束后删除测试工作区，取消 `SKILLHUB_BASE_URL` 用户环境变量。

## 4. API 冒烟（先于 UI）

在 UI 测试前先用接口确认后端本身可用，避免把后端问题误判为插件问题。所有命令在 PowerShell 中执行，使用 `curl.exe`。

```powershell
$base = 'http://<IP>:9099'
$user = '<测试账号>'
$pass = '<测试密码>'

# 登录（注意：/login 不带 /system/skillhub/skills 前缀）
$login = curl.exe -s -X POST "$base/login" -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "username=$user" --data-urlencode "password=$pass" | ConvertFrom-Json
$token = $login.token

# 目录
curl.exe -s -H "Authorization: Bearer $token" "$base/system/skillhub/skills/search?page=0&size=20"

# 详情 / 版本 / 概览（替换 namespace、slug、version）
curl.exe -s -H "Authorization: Bearer $token" "$base/system/skillhub/skills/<namespace>/<slug>"
curl.exe -s -H "Authorization: Bearer $token" "$base/system/skillhub/skills/<namespace>/<slug>/versions?page=0&size=50"
curl.exe -s -H "Authorization: Bearer $token" "$base/system/skillhub/skills/<namespace>/<slug>/versions/<version>/file?path=SKILL.md"

# 下载指定版本
curl.exe -s -H "Authorization: Bearer $token" -o test-skill.zip "$base/system/skillhub/skills/<namespace>/<slug>/versions/<version>/download"
```

| 编号 | 检查 | 期望 | 结果 |
| --- | --- | --- | --- |
| API-01 | 登录 | HTTP 2xx，`success=true`，返回非空 `token` |  |
| API-02 | 目录 | HTTP 2xx，`success=true`，含 `items`、`total`、`labelStats`，分页字段为 `has_next` 或 `hasNext` |  |
| API-03 | 详情 | HTTP 2xx，`success=true`，含 `publishedVersion.version` |  |
| API-04 | 版本列表 | HTTP 2xx，按发布时间倒序，含 `status`、`downloadReady` |  |
| API-05 | 概览 | HTTP 2xx，返回 `SKILL.md` 原文（非 JSON） |  |
| API-06 | 下载 | HTTP 2xx，`Content-Type` 为 zip，文件可解压 |  |
| API-07 | 路由核对 | 登录与技能接口的实际前缀与第 2.2 节一致 |  |

> 不要把 token、密码、内网地址写入报告或截图。

## 5. UI 测试用例

优先级：P0 必须通过；P1 应通过，失败需记录影响；P2 可选或环境受限。

### 5.1 启动与鉴权

| 编号 | 优先级 | 操作步骤 | 期望结果 |
| --- | --- | --- | --- |
| AUTH-01 | P0 | 清空 `SKILLHUB_BASE_URL`，重启 VS Code，进入【全部】 | 显示「市场服务未配置」引导；【已安装】仍可用；无崩溃 |
| AUTH-02 | P0 | 配置基地址并重启，未登录进入【全部】 | 显示 SkillHub 登录表单，含用户名、密码 |
| AUTH-03 | P0 | 正确账号密码登录 | 进入目录；输出面板无异常；重启 VS Code 后仍保持登录 |
| AUTH-04 | P0 | 输入错误密码 | 显示服务端失败原因；停留在登录表单；可重试 |
| AUTH-05 | P1 | 平台开启验证码时，先不带验证码登录；出现验证码后输入正确/错误验证码，并点击图片刷新 | 登录失败消息含「验证码」时出现验证码输入与图片；点击图片可刷新；正确验证码可登录；错误验证码有提示 |
| AUTH-06 | P1 | 让服务端 token 失效（等待过期或后台踢出），再刷新目录 | 提示登录失效并回到登录引导；重新登录后自动重新加载目录 |
| AUTH-07 | P0 | 打开任一技能详情，点底部「退出 SkillHub 登录」 | 回到登录引导；【已安装】不受影响；DiCode/Codex 登录未退出 |
| AUTH-08 | P1 | 退出 SkillHub 后继续使用 DiCode 对话；再重新登录 | 两者登录态互不影响 |
| AUTH-09 | P1 | 用无 `system:skill:list` 权限账号登录并进入目录 | 显示无权限提示；不误清 token；【已安装】仍可用 |
| AUTH-10 | P1 | 将基地址改为不可达或错误端口后重试 | 显示网络/接口错误与重试入口，无崩溃 |

### 5.2 目录

| 编号 | 优先级 | 操作步骤 | 期望结果 |
| --- | --- | --- | --- |
| CAT-01 | P0 | 登录后首次进入【全部】 | 先显示骨架，再显示卡片；卡片含名称、发布者、版本/版本空态、简介、操作按钮 |
| CAT-02 | P0 | 搜索仅存在于部分技能的名称/简介/标签关键词 | 列表按服务端结果收敛；清空后恢复；快速输入不产生错乱结果 |
| CAT-03 | P1 | 选择不同分类 | 请求带 `label`；列表与计数变化；切换后回到第 0 页 |
| CAT-04 | P1 | 依次切换四种排序 | 请求带对应 `sort`；服务端返回顺序生效；切换后回到第 0 页 |
| CAT-05 | P0 | 滚动到底部点「加载更多」 | 追加下一页，不重复、不覆盖已加载项；`has_next=false` 时显示总数 |
| CAT-06 | P1 | 搜索不存在的关键词 | 显示空态与调整建议，无错误态 |
| CAT-07 | P2 | 首次加载后等待超过 10 分钟再重进 | 先显示缓存并提示后台刷新，随后更新为最新数据 |
| CAT-08 | P2 | 加载后断网或停掉后端再刷新 | 保留已有缓存/列表并提示；重试可用；【已安装】不受影响 |
| CAT-09 | P2 | 后端返回 5xx 或不可达 | 显示「市场目录暂时不可用」与重试，不崩溃 |
| CAT-10 | P1 | 本地导入一个与市场技能同名的技能 | 市场卡片不显示「已安装」，附注「本地已有同名技能」 |
| CAT-11 | P1 | 找一条列表未返回版本的技能，再打开详情 | 卡片先显示「版本待查看详情」；打开详情后版本回填 |

### 5.3 详情

| 编号 | 优先级 | 操作步骤 | 期望结果 |
| --- | --- | --- | --- |
| DET-01 | P0 | 打开任一技能详情 | 显示名称、标识、发布者/部门、下载量、评分、标签；无字段错位 |
| DET-02 | P0 | 查看版本历史 | 版本号、变更说明、日期、大小、状态正确；未安装时可选择版本安装 |
| DET-03 | P0 | 查看概览 | `SKILL.md` 原文按 Markdown 渲染，无 HTML 注入或乱码 |
| DET-04 | P1 | 用 API 或 Swagger 查看 `GET /{namespace}/{slug}/versions/{version}` | 记录 `parsedMetadataJson` 是否存在、是否含校验和/能力/示例字段（CAL-04）；插件 UI 当前不消费该字段 |
| DET-05 | P1 | 打开无权限/已删除技能详情 | 显示不可用提示，列表可刷新，不崩溃 |
| DET-06 | P1 | 关闭详情再打开另一条；切走再回来 | 状态正确，不串详情，不重复请求堆积 |

### 5.4 安装

| 编号 | 优先级 | 操作步骤 | 期望结果 |
| --- | --- | --- | --- |
| INS-01 | P0 | 安装 S1 当前发布版本；若卡片显示「版本待查看详情」，先从详情安装 | 状态依次为【安装中…】→【已安装】；目录落到 `.agents/skills/`；登记写入；无临时文件残留 |
| INS-02 | P0 | 对同一技能连续快速点击安装三次 | 只产生一个 `jobId`；不重复写目录；后续点击不重复安装 |
| INS-03 | P1 | 同时安装三个不同技能（可用较大包放慢） | 最多两个并行，第三个显示排队；完成后依次推进 |
| INS-04 | P0 | 安装中切回对话或关闭 Skill 市场，稍后再打开 | 安装继续；重开后先恢复任务快照，按钮状态正确 |
| INS-05 | P1 | 同一工作区开第二个 VS Code 窗口，发起同一安装 | 接入同一条任务，不重复下载/写目录 |
| INS-06 | P0 | 已安装 S2 1.0.0 后发布 1.1.0，刷新市场并从详情更新 | 卡片附注「有 v1.1.0 可用」；更新成功；登记版本变为 1.1.0 |
| INS-07 | P1 | 让 S2 1.1.0 包损坏或无 `SKILL.md`，再更新 | 更新失败并回滚；旧版本仍可用；登记版本不变 |
| INS-08 | P1 | 未安装状态下从版本历史安装旧版本 | 安装指定版本成功；登记版本与选择一致 |
| INS-09 | P0 | 对 S3（DRAFT 或未就绪）提交安装 | 不创建任务；提示版本不可下载/未发布；不写登记 |
| INS-10 | P1 | 对 S7 无权限技能提交安装或打开详情 | 403 显示无权限，404 显示不可用；不写登记；列表可刷新 |
| INS-11 | P1 | 安装 S5（缺 `SKILL.md`） | 失败为不可重试；不写登记；临时目录清理 |
| INS-12 | P1 | 安装 S4（名称不一致） | 失败为来源校验未通过；不写登记；旧版本不受影响 |
| INS-13 | P2 | 安装 S6（CRC 损坏），再换正确包重试 | 首次可重试失败；重试成功后登记正确；临时文件清理 |
| INS-14 | P2 | 安装超过 20 MB / 解压超限的包 | 失败为包超限；不写登记；无残留 |
| INS-15 | P0 | 先手工创建与包根目录同名的 `.agents/skills/<目录>`，再安装 S1 | 报目录冲突；不覆盖、不改名、不动原内容 |
| INS-16 | P1 | 安装大包过程中强制退出并重启 VS Code | 任务转中断且可重试；重试成功；临时下载/解压目录被清理 |
| INS-17 | P2 | 让 Codex CLI 暂不可用后安装，再恢复 | 安装本身成功；登记可能带「索引待刷新」；恢复后重新打开/刷新列表，确认索引收录与附注状态并记录 |
| INS-18 | P2 | 磁盘空间不足时安装 | 报磁盘空间不足；可重试；不写坏登记 |

安装后统一验证：

1. `.agents/skills/<目录>/SKILL.md` 存在且内容完整。
2. `.agents/skills.registry.json` 中 `source: market`、`skillId`、`version`、`digest` 正确。
3. 不重启插件，在新对话中让 Agent 使用该技能，或确认 `skills/list` 已收录。
4. `skill-jobs/*.json` 中任务终态为 `done`；失败任务保留原因与 `retryable`。
5. 下载目录和 `.tmp-*` 暂存目录无残留。

### 5.5 本地技能回归（冒烟）

| 编号 | 优先级 | 操作步骤 | 期望结果 |
| --- | --- | --- | --- |
| LOC-01 | P1 | 从文件夹导入合法技能 | 导入成功；登记 `source: import`；列表出现 |
| LOC-02 | P1 | 从 ZIP 导入合法技能 | 单层根目录自动剥离；导入成功 |
| LOC-03 | P1 | 启停一个已索引技能 | 开关生效；失败会回滚并提示 |
| LOC-04 | P1 | 重新导入、移出登记、删除 | 行为与 README 一致；删除进回收站；市场安装项删除后可在【全部】重装 |
| LOC-05 | P1 | 断网/退出 SkillHub 后打开【已安装】 | 列表、详情、导入、删除仍可用 |

### 5.6 UI 与布局

| 编号 | 优先级 | 操作步骤 | 期望结果 |
| --- | --- | --- | --- |
| UI-01 | P1 | 分别切换 VS Code 深/浅与 JetBrains 深/浅主题 | 导航、卡片、标签、按钮、错误/空态对比度可辨，无不可读文字 |
| UI-02 | P1 | 最大化面板后查看市场列表与详情 | 列表与详情并排；切换不重建状态（若 IDE 布局开关未落地，标记 BLOCKED） |
| UI-03 | P1 | 将侧栏拖到最窄 | 无横向溢出；卡片与按钮不重叠；关键操作仍可点 |
| UI-04 | P1 | 依次观察骨架、空态、错误、缓存提示、安装进度 | 样式与文案正确，不闪烁、不卡死 |
| UI-05 | P0 | 在对话输入框输入草稿，进入 Skill 市场再返回 | 草稿保留 |
| UI-06 | P0 | 对照状态表检查按钮文案与禁用态 | 【安装】【安装中…】【已安装】【重试】【无法安装】【不兼容】【已限制】一致 |

## 6. 接口契约校准（必填）

内网实测后填写，结论回写到 `docs/dicode-skill-market.md` 的偏离登记。

| 编号 | 待确认项 | 当前插件假设 | 实际结果 | 结论/是否改代码 |
| --- | --- | --- | --- | --- |
| CAL-01 | 基地址与路由 | 登录在根 `/login`，技能接口在 `/system/skillhub/skills` |  |  |
| CAL-02 | 分页字段 | `has_next` 与 `hasNext` 双兼容 |  |  |
| CAL-03 | 列表版本 | `/search` 含 `publishedVersion.version`；无则空态+详情回填 |  |  |
| CAL-04 | `parsedMetadataJson` | 当前不消费；若含校验和可恢复服务端摘要比对 |  |  |
| CAL-05 | 包内 `name` 对应 | 必须等于 `slug` 或 `displayName` |  |  |
| CAL-06 | 多命名空间 | 路径使用主 `namespace`；`namespaces` 仅展示 |  |  |
| CAL-07 | 403/404 语义 | 403=无权限；404=不存在或无权可见 |  |  |
| CAL-08 | 兼容/组织策略 | 接口无字段；默认 compatible；403/404 映射限制态 |  |  |
| CAL-09 | 验证码触发 | 登录失败文案含「验证码」后拉图；`img`/`image`、404 均兼容 |  |  |
| CAL-10 | 登录失败形态 | `success !== true` 或缺 token 即失败，透传 `msg` |  |  |
| CAL-11 | 概览响应 | `octet-stream` 或文本，body 为 UTF-8 Markdown |  |  |
| CAL-12 | 下载响应 | `application/zip`；JSON 错误体按 Content-Type 分流 |  |  |
| CAL-13 | token 失效 | HTTP 401 清 token；若服务端用 200 + `code=401` 返回，当前插件只按未授权引导重登，不主动清 token |  |  |
| CAL-14 | 搜索参数 | `q`、`label`、`sort`、`page` 从 0、`size` 默认 20 |  |  |
| CAL-15 | 真实包结构 | 单层根目录；无符号链接/加密；大小在限制内 |  |  |
| CAL-16 | 下载文件名 | `Content-Disposition` 文件名编码（插件当前不使用，仅记录） |  |  |

## 7. 证据与记录

每个失败或契约校准用例至少保留：

1. 截图：`<用例编号>_<简述>.png`，包含完整窗口与操作结果。
2. 输出面板 **DiCode Codex** 的相关日志片段。
3. 接口响应：脱敏后的 JSON 或 HTTP 状态。
4. 相关文件：登记文件片段、任务日志片段（隐藏 token/密码/内网地址）。
5. 复现步骤与环境（OS、VS Code 版本、扩展版本、账号角色）。

禁止记录：明文密码、完整 JWT、内网真实地址、生产技能内容。

## 8. 退出标准

- 所有 P0 用例通过。
- P1 失败已记录影响与临时绕行方案，且不涉及数据损坏或安全问题。
- 第 6 节契约校准全部有结论；需要改代码的项已登记。
- 安装后的技能可被 Agent 发现；失败安装不会破坏已安装版本或登记。
- 无崩溃、无登记损坏、无临时文件残留。

## 9. 已知限制与不测项

- 最大化并排依赖 IDE 布局开关；未落地时 UI-02 标记 BLOCKED，不阻塞其余验收。
- 服务端不提供包摘要，`digest` 为客户端下载后自算的 zip sha256。
- 「不兼容」「已限制」在真实接口无对应字段时只能由 403/404 推导；没有依据时保持默认 compatible。
- 发布、审核、管理端操作不在插件范围。
- CLI 侧技能安装不在本模块范围。
- 本地桩模式与本地单测已在开发环境验证，内网只做真实环境复验。

## 10. 测试报告模板

```text
测试版本：dicode-codex <版本>
VSIX SHA256：<sha256>
代码提交：<commit>
测试环境：<OS> / VS Code <版本> / Codex CLI <版本>
SkillHub：<脱敏地址> / Swagger 可访问：是/否
测试账号角色：<角色，不记录密码>
测试工作区：<路径>
开始时间：<YYYY-MM-DD HH:mm>
结束时间：<YYYY-MM-DD HH:mm>

结果汇总：
  P0：通过 __ / 失败 __ / 阻塞 __
  P1：通过 __ / 失败 __ / 阻塞 __
  P2：通过 __ / 失败 __ / 跳过 __

失败用例：
  <ID>：现象 / 期望 / 证据路径 / 初步原因

契约校准结论：
  <CAL-ID>：实际结果 / 需要改代码：是/否

最终结论：通过 / 有条件通过 / 不通过
遗留风险：
```

## 11. Agent 执行约定

内网 Agent 按本手册执行时：

1. 先核对第 2 节前置条件；缺测试数据时标记 `BLOCKED`，不要自行改用生产技能。
2. 只在一个新建的测试工作区执行安装/删除；不要操作生产仓库。
3. 先跑第 4 节 API 冒烟，通过后再做 UI 用例。
4. 每个用例记录结果与证据路径，不要只写「通过」。
5. 遇到 401/403/404、包结构、字段命名差异时，按第 6 节记录实际值，不要现场改插件代码。
6. 不输出、不提交 token、密码、内网地址和真实技能内容。
7. 失败时保留现场（日志、登记、任务文件），不要先清理再报告。
8. 全部结束后按第 8 节给出通过/有条件通过/不通过结论。
