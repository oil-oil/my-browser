# Agent Browser Lessons For My Browser

Agent Browser 的核心价值不是“会点击”，而是把浏览器自动化做成了一套适合 AI 使用的协议。

## 已查看源码

- 上游仓库：`https://github.com/vercel-labs/agent-browser`
- 本机包：全局 npm 安装目录里的 `agent-browser`
- 临时源码：`/tmp/agent-browser-src`
- 版本：`0.26.0`
- 许可证：Apache-2.0

本机 npm 包只带原生二进制和文档；真正源码在 GitHub。CLI 主体是 Rust，不是 JavaScript。

## 已吸收

- `snapshot -> @e refs -> action -> re-snapshot` 工作流
- `@e1` 这类短引用，减少上下文长度
- refs 过期原则：页面变化后重新 snapshot
- 独立任务区：My Browser 使用 Manus 风格标签组
- `snapshot --json`，方便机器解析
- `get`，用于精准读取标题、URL、文本、属性、value
- `wait`，支持毫秒、元素、文本、URL、JS 条件
- background operator：My Browser 已经从选项页轮询升级到 Chrome background service worker
- `ensure`：My Browser 已经可以自动检查并启动本机 agent

## 源码里最值得复刻的实现

### 1. Daemon/session 模型

Agent Browser 用 Rust daemon 持有浏览器状态。CLI 每次只解析命令，然后通过 socket 把 JSON 命令发给 daemon。

关键文件：

- `/tmp/agent-browser-src/cli/src/connection.rs`
- `/tmp/agent-browser-src/cli/src/native/daemon.rs`
- `/tmp/agent-browser-src/cli/src/native/actions.rs`

可迁移到 My Browser 的点：

- 每个 session 有独立状态和 sidecar 文件。
- `ensure_daemon` 负责启动和复用后台进程。
- stale pid/socket 自动清理。
- daemon 内部保存 refs、当前 tab、网络事件、错误、下载状态。

My Browser 当前对应设计：

- `local-agent.mjs` 是轻量 daemon。
- Chrome extension background operator 是浏览器执行端。
- 下一步可以把 queue/results、current tab、refs、version、health 都做成更正式的 session 状态。

### 2. 命令解析统一成 JSON protocol

Agent Browser 的 CLI 先把命令解析成 JSON，再交给 daemon 执行，错误信息也带上下文。

关键文件：

- `/tmp/agent-browser-src/cli/src/commands.rs`

可迁移到 My Browser 的点：

- 保留人类友好的 CLI 语法。
- 内部统一成 `{ id, action, ... }`。
- 对缺参数、未知子命令、非法值输出明确 usage。
- 给常用别名做一层解析，例如 `open/goto/navigate`、`press/key`。

My Browser v2 已经把命令入口统一到 `scripts/my-browser`，并在发送到本机 agent 前补充 `my-browser/v2` JSON protocol。后续可以继续细化 parser 和错误类型。

### 3. Accessibility tree refs

Agent Browser 的 snapshot 主要来自 `Accessibility.getFullAXTree`，不是简单 DOM query。refs 绑定的是 role/name/nth/backendDOMNodeId。

关键文件：

- `/tmp/agent-browser-src/cli/src/native/snapshot.rs`
- `/tmp/agent-browser-src/cli/src/native/element.rs`

核心设计：

- `@e1` 引用保存 `backend_node_id`、`role`、`name`、`nth`、`frame_id`。
- 操作时先用 `backend_node_id` 快速定位。
- 如果节点失效，用 role/name/nth 重新查询 AX tree。
- 支持 cross-origin iframe session。
- `snapshot -i` 只输出交互元素，降低 token。

My Browser 当前 snapshot 还是 DOM 选择器为主。下一步最高价值改造是：在扩展里用 CDP `Accessibility.getFullAXTree` 生成 refs，并保存 `backendDOMNodeId`。

### 4. 元素解析双通道

Agent Browser 支持 `@e` 和 CSS/XPath selector 两条路径：

- `@e`：走 ref map，优先 backend node。
- selector：走 `querySelector` 或 `xpath=...`。

关键文件：

- `/tmp/agent-browser-src/cli/src/native/element.rs`

可迁移到 My Browser 的点：

- `@e` 不应该只保存 CSS selector。
- refs 失效后应该给“重新 snapshot”的明确错误，或者自动按 role/name 复查一次。
- CSS selector 可以保留，适合隐藏 file input 和工程化页面。

### 5. 输入策略

Agent Browser 对输入分得很细：

- `fill`：focus、清空、派发 input，然后 `Input.insertText`。
- `type`：focus 后逐字符输入。
- `keyboard type`：作用于当前焦点；普通字符用 `Input.insertText`，Enter/Tab 等控制键用 `dispatchKeyEvent`。
- `keyboard inserttext`：直接 `Input.insertText`，适合长文本和中文。
- `press`：完整 keyDown/keyUp，支持 modifier bitmask。

关键文件：

- `/tmp/agent-browser-src/cli/src/native/interaction.rs`
- `/tmp/agent-browser-src/cli/src/native/actions.rs`

My Browser 已经补了这些命令，但实现还可以继续贴近：

- `keyboard type` 普通字符改用 `Input.insertText`，控制键才用 key events。
- `fill` 后验证 value 或文本内容是否真的变化。
- 支持可选 delay。
- 支持 `clear`、`selectall` 这类细粒度命令。

### 6. 上传和下载

Agent Browser 上传逻辑：

- 解析目标元素 objectId。
- `DOM.describeNode` 拿 `backendNodeId`。
- 用 `DOM.setFileInputFiles` 设置文件。

关键文件：

- `/tmp/agent-browser-src/cli/src/native/browser.rs`
- `/tmp/agent-browser-src/cli/src/native/actions.rs`

My Browser 上传已接近这个设计，并额外支持 `input[type=file] >> nth=1`。下一步可以补：

- 支持 `@e` 上传时走 backend node。
- 上传后触发校验命令，例如读取文件名、上传状态。
- 下载命令学习 Agent Browser：先设置 download behavior，再点击，再监听 download events。

### 7. policy 和确认机制

Agent Browser 有 action policy 和 `confirm/deny`：

- policy 可以热重载。
- 高风险动作返回 `confirmation_required`。
- 用户确认后重放原命令。

关键文件：

- `/tmp/agent-browser-src/cli/src/native/actions.rs`
- `/tmp/agent-browser-src/cli/src/native/policy.rs`

My Browser 现在主要靠 skill 文档约束。下一步应该把高风险动作变成工具层协议，而不是只依赖 Agent 自觉。

### 8. 事件和诊断

Agent Browser 长期监听 CDP 事件：

- console logs
- page errors
- network requests
- dialogs
- downloads
- iframe target lifecycle

关键文件：

- `/tmp/agent-browser-src/cli/src/native/actions.rs`
- `/tmp/agent-browser-src/cli/src/native/network.rs`

My Browser 下一步可以补：

- `console`、`errors`
- `requests`
- 自动处理 alert/beforeunload
- `doctor` 输出 extension background、agent、queue、last command、last error、manifest version

## 优先学习

1. 更完整的无障碍树
   - 现在的 snapshot 主要来自 DOM 选择器。
   - 下一步通过 CDP `Accessibility.getFullAXTree` 获取真实 AX tree。

2. 语义定位
   - 学 `find role/text/label/placeholder/testid`。
   - 用户不需要每次先看 `@e`，可以直接说“点提交按钮”。

3. 带编号截图
   - 学 `screenshot --annotate`。
   - 给截图元素画编号，编号和 `@e` 引用一致。

4. 等待策略
   - 补 `networkidle`、`domcontentloaded`、元素可点击、元素消失。
   - 默认避免裸等时间。

5. 诊断能力
   - 学 `doctor`。
   - 检查本机 agent、扩展连接、Chrome 权限、manifest 权限、debugger attach 状态。

6. 证据采集
   - 学 dogfood skill 的报告方法。
   - 每个问题保存截图、步骤、结果、必要时录屏。

7. 安全确认
   - 学 `confirm-actions` 和 action policy。
   - 对支付、删除、提交、发消息等动作要求用户确认。

## 是否直接基于 Agent Browser 改造

可以，但不建议把 My Browser 直接 fork 成 Agent Browser：

- Agent Browser 默认控制自己启动或连接的自动化浏览器。
- My Browser 的产品目标是控制用户现有 Chrome，通过扩展复用真实登录态和标签环境。
- 直接改 Rust CLI 的成本高，后续跟上游版本也会更重。

推荐路线：

1. 保留 My Browser 的 Chrome extension + local agent 架构。
2. 复制 Agent Browser 的协议设计、refs 模型、命令解析、确认机制。
3. 对需要高性能或复杂 session 管理的部分，再考虑把 `local-agent.mjs` 升级成 Rust/Node daemon。
4. 长期让 My Browser 的 CLI 兼容 Agent Browser 的常用命令子集。

## 不照搬

- 不默认启动新的 Chrome。
- 不把临时 profile 伪装成真实浏览器。
- 不导出真实登录态文件，除非用户明确要求。
- 不在敏感页面上无提示执行不可逆动作。
