# DiCode VS Code UI 设计文档

> 状态：UI 团队交付，已入仓供实现对照（未改动代码）
> 分支：`feat/skill-market`
> 来源：UI 团队提供的 `DiCode-VSCode.html` 与 `DiCode Webview UI` 组件库 README
> 日期：2026-11-18

本目录存放 UI 侧的设计产出，作为扩展 Webview 实现的对齐依据。**以本目录为设计的事实来源**，代码实现与设计不一致时先在此确认口径，再改代码。

产品需求文档不在本仓库中，由产品线单独维护；实现时按需求文档核对功能范围，按本目录核对视觉与交互形态。

## 文件

| 文件 | 说明 |
| --- | --- |
| `dicode-vscode-ui-prototype.html` | 单文件交互原型，覆盖主界面、历史对话、消息提醒、Skill 市场、设置、用户中心与升权弹窗。样式与 SVG 图标全部内联，无外部依赖，双击即可在浏览器打开 |
| `dicode-webview-ui.md` | `@dicode/webview-ui` 4.0.1 组件库 README：组件清单、宿主接入约定、输入区与打包方式 |

## 原型怎么看

直接用浏览器打开 `dicode-vscode-ui-prototype.html`。`body` 上的 class 切换三种外观：

- 默认：VS Code 深色
- `light`：VS Code 浅色
- `jb`：JetBrains 深色

配色全部走 CSS 变量（`--editor`、`--chrome`、`--accent` 等），变量定义在文件头部的 `:root` 与 `.light` / `.jb` 块里，可直接对照取色。

页面骨架分四层，与组件库命名一一对应：

| 原型区块 | 组件 |
| --- | --- |
| `.native-rail` | VS Code 原生活动栏（非扩展实现） |
| `.product-rail` | `NavigationRail` |
| `.workspace` / `.main` / `.rightstripe` | `WorkspaceLayout` + `LayoutToggle` |
| `.plugin`、`.history`、`.panel`、`.toast` | `ConversationPanel`、`ConversationList`、`AccountPanel`/`SettingsPanel`、`NotificationToast` |
| `.decision-card`、`.process`、`.term` | `DecisionCard`/`FullAccessDialog`、`TaskProgress`/`TaskResult`、终端组件 |

## 已知缺口

原型与产品需求之间存在以下差异，实现时以需求为准，并等待 UI 补齐：

- Skill 市场卡片没有版本、简介与兼容状态展示；
- 没有 Skill 详情页（需求要求展示用途、来源、版本、声明能力与示例）；
- 市场使用演示数据，安装只记录本地状态，不含安装失败与重试的完整表现；
- **【已安装】在原型里是市场列表的本地过滤**（`installed.has(id)`），而实施口径是两个页签、两套独立数据源（【已安装】只读本机索引与工作区登记、不请求远程），照原型实现会串数据源；
- 原型与实施口径的其余差异集中登记在 `docs/dicode-skill-market.md` 第 14 节「偏离登记」，含市场页最大化时的布局取舍。

> 组件库 `@dicode/webview-ui` 提供的 `SkillMarket` 组件暂不接入，扩展侧按原型自行实现（决策见 `docs/dicode-skill-market.md` 第 13 节），原型仅作为视觉与交互参照。

## 对照修改时的注意点

- 原型管「长什么样」，`docs/dicode-skill-market.md` 管 Skill 市场的实施范围与步骤。
- 原型里的交互是静态演示，不含真实状态机；任务调度与状态流转以产品需求为准。
- 修改原型请保留单文件自包含特性，不要引入 CDN 资源——VS Code Webview 的 CSP 默认不允许外链。
- 文档不区分「已设计」与「已实现」；某项交互是否已落地，需回到 `apps/dicode-vscode/webview/` 核对。
