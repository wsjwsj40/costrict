# DiCode Webview UI

React 18 和 TypeScript 组件库，面向 DiCode V4 的 VS Code 与 JetBrains Webview。样式以 `.dicode-ui` 主题容器和 `dicode-` 类名组织，支持两个宿主的深浅主题。宿主向组件传入数据并接收操作回调。

## 安装

```powershell
npm install ./release/dicode-webview-ui-4.0.1.tgz
```

组件包以 React 18.3 为 peer dependency。宿主使用自己的 React DOM 渲染器，通过 ESM 导入组件，并在应用入口导入样式。

```tsx
import { DicodeProvider, NavigationRail, WorkspaceLayout } from "@dicode/webview-ui";
import "@dicode/webview-ui/styles.css";
```

在具有明确高度的宿主容器内渲染 `DicodeProvider`。主题由 `host` 和 `theme` 控制。使用 `WorkspaceLayout` 的 `history`、`editor` 和内容插槽组成工作区。IDE 已提供编辑器时可省略 `editor`，由宿主处理实际编辑区和焦点恢复。提供 `onOpenEditor` 可在单列布局中显示「返回编辑器」按钮。

## 组件与宿主接入

| 组件 | 界面职责 | 宿主提供 |
|---|---|---|
| `DicodeProvider`、`WorkspaceLayout`、`LayoutToggle`、`NavigationRail` | 深浅主题、导航、单按钮并排与最大化 | 主题、当前区域、布局状态、导航和布局回调 |
| `ConversationPanel`、`Composer` | 对话标题、滚动区和固定输入区；批准模式、模型与思考深度、上下文、文件引用和发送 | 当前会话草稿、可用模型及深度、上下文预算、任务状态和提交回调 |
| `TaskProgress`、`TaskResult` | 主步骤、可展开子步骤、终态摘要、验证结果与改动文件 | 已归并的步骤与终态，文件跳转回调 |
| `DecisionCard`、`FullAccessDialog` | 审批、选择、补充输入以及升权确认 | 当前请求、可用动作、决策提交与升权结果 |
| `ConversationList`、`NotificationList`、`NotificationToast` | 历史搜索、会话状态、消息筛选与定位 | 有序历史、通知状态、待处理数量及跳转回调 |
| `AccountPanel`、`SettingsPanel` | 登录状态、主题、任务通知、新会话默认偏好 | 账户信息、工作区偏好和保存回调 |
| `SkillMarket` | 搜索、筛选、详情、安装与重试状态 | 已验证目录、兼容性、工作区安装结果及安装回调 |

### 输入区

```tsx
import { Composer, type ComposerProps } from "@dicode/webview-ui";

export function ChatInput({ composer }: { composer: ComposerProps }) {
  return <Composer {...composer} />;
}
```

- `models` 来自宿主的可用模型列表。V4 默认配置为 Qwen3.8-Flash-Next 和低思考深度，账号可用性以宿主数据为准。模型切换时，组件回传兼容的新模型与深度组合。
- `onSubmit` 提交当前输入。`onQueue` 将后续请求交给当前会话队列。`onInterruptAndSubmit` 交给宿主中止当前任务并接续请求。任务开始、排队、停止和恢复均由宿主结果更新。
- `onRequestFullAccess` 打开升权确认。确认后由宿主校验并更新 `approvalMode`。对审批卡的操作通过请求 ID 回传给宿主。
- 进度以步骤 ID 保持展开状态。跨会话保留草稿和展开状态时，宿主按会话保存对应值。用于埋点的业务事件应以宿主确认和服务状态为准。
- V4.0.2 的跨界面提醒和补充输入由宿主按功能开关展示。

## 构建和打包

在仓库根目录执行：

```powershell
New-Item -ItemType Directory -Force -Path ./release
npm pack --workspace @dicode/webview-ui --pack-destination ./release
```

tarball 包含 ESM、TypeScript 声明和 `styles.css`。输入、文件读写、模型、登录和安装的业务处理由消费方接入。命令行 TUI 使用独立的终端组件。
