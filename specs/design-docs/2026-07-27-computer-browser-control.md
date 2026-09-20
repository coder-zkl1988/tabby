# 桌面端 Computer Use 与浏览器控制方案

## 目标

Nexu 桌面端增加两项本地自动化能力：

- 浏览器控制让 agent 操作应用内嵌的浏览器面板，即对话右侧用户能看见的那个视图。
- Computer Use 使用平台适配层：macOS 复用签名并 notarize 的 Peekaboo MCP，Windows 使用 TryCua `cua-driver mcp`。

两项能力默认关闭。启用是用户对本机自动化权限的明确授权，不随历史配置迁移自动打开。

## 边界与决策

### 浏览器

**决策变更（2026-07-28）**：放弃控制用户的真实 Chrome，改为只控制内嵌浏览器。原方案用 OpenClaw 内置 `browser` plugin 加 MV3 扩展的 `chrome.debugger` 接管用户主动连接的标签页，功能可用但装扩展、复制配对串、把标签页拖进专用 tab group 三步缺一不可，任何一步做错都表现为“连上了但看不到标签页”。内嵌浏览器不需要其中任何一步。OpenClaw 的 `browser` plugin、`browser` 工具和顶层 `browser` 配置块因此完全不再编译，相关的配对 API、扩展目录入口和 `OpenClawConfig["browser"]` 类型一并删除。

执行链路是 plugin → controller → SSE → 桌面主进程 → WebContentsView，工具为 `browser_open` / `browser_snapshot` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_press` / `browser_select` / `browser_hover` / `browser_scroll` / `browser_navigate`。三处声明（插件 `BROWSER_TOOL_NAMES`、manifest `contracts.tools`、编译器 `EMBEDDED_BROWSER_TOOLS`）由 `apps/controller/tests/nexu-browser-render.test.ts` 钉住一致；守卫 `nexu-toolcall-guard` 的独立副本由 `local-automation-allowlist-parity.test.ts` 钉住。

**执行者在主进程，因为浏览器视图在主进程。** 初版把面板组件当执行者，想让”面板关着就无法操作”成为结构约束；实际后果是收起侧栏会连同视图一起销毁、任务中途丢页面和登录态，而且在 workspace 路由之外的会话（webchat 就是一例）根本没有执行者。现在可见性由 `open` 拉起面板承担，而不是由执行者的生命周期承担。

**但点击必须由面板托管视图。** 实测：主进程自行摆放的视图，第一次合成点击会被吞掉；面板托管过的视图每次都命中。排除过的假设包括 `setVisible(false)`、把视图停到窗口外、视图不在屏内、首次显示后的重排、焦点与 `buttons` 位缺失、导航未及时提交——坐标与视口在失败与成功两次之间完全一致（`156,235` / `576x720`），因此不是坐标问题。结论是合成输入需要面板真正托管过的视图。所以 `click` / `type` / `scroll` 先请求拉起面板并等待托管（`PANEL_WAIT_MS`），**等不到就带解释失败**。

**主进程绝不自己把视图摆上屏。** 曾经有过一版"等不到面板就自摆放"的兜底，结果是一张没有地址栏、没有标签页、没有面板头的网页盖住整个应用界面，用户既不能导航也不能关闭——而且那次点击照样被吞掉，兜底毫无收益。现在唯一能让视图可见的路径是面板的 `show`（带真实 bounds），由 `tests/desktop/embedded-browser-visibility.test.ts` 钉住。读类操作（`open` / `snapshot`）不需要命中测试，因此无面板时照常工作。

**但主进程必须能把视图收下来。** "只让面板控制可见性"这条一度被理解成主进程完全不碰 `setVisible`，于是三处 `hide` 全部挂在渲染进程的 React effect 上（面板卸载、布局 effect 清理、无活动标签页）。渲染进程只要以不跑清理的方式消失——重载、Vite 全量热更新、渲染进程崩溃——最后显示的那张页面就继续合成在应用之上，而包住它的面板外壳没了，恰好复刻了上面那段明令禁止的形态：没有地址栏、没有标签页、没有关闭按钮。开发期改一次 `apps/web` 源码就会撞上一次，打包版则是渲染进程崩溃后必现。现在主窗口的 `did-start-navigation`（仅主框架、跨文档）与 `render-process-gone` 调用 `embeddedBrowserManager.hideViewsForWindow(window)`，与面板自己的 `hide` 共用同一段实现以免漂移。只隐藏不销毁，页面、登录态和 ref 照旧存活，面板重新挂载后自己 `show` 回来。同文档导航（应用内路由）被显式排除，否则每次换路由都会掐掉 agent 任务中的页面。

由 agent 打开的面板带 `openedByAgent` 标记，路由切换不会关掉它（工作台默认属于对话视图，离开就关）——否则任务中途换页不只是把工作藏起来，而是直接让点击失效。用户显式关闭仍然有效。

CDP 走 Electron 的进程内 `webContents.debugger`，**不使用** `--remote-debugging-port`：后者会开一个真实 TCP 监听，把 app 内每一个 WebContents（包括携带用户登录态的 nexu renderer）暴露给任意本地进程，过滤代理无法兜底，因为任何进程都能绕过代理直连端口。

#### 已解决：controller 重启后 relay 不恢复（僵尸 controller）

**症状曾是**：`pnpm dev restart controller` 之后，桌面 relay 不再收到命令，agent 调用任何浏览器工具都得到 `no desktop browser panel is listening`，模型退回 Computer Use 去操作用户的真实浏览器。日志诡异：`connected` 之后一片死寂，连空闲看门狗都不触发。

**根因（socket 表实测定位）**：controller 收到 SIGTERM 后走优雅退出，`server.close()` 要等所有连接排完才回调——SSE 是无限流永远排不完，于是进程卡死在 shutdown：监听 socket 已关（端口空出，新实例正常绑定），进程本体却活着，**每 15 秒继续给 relay 的旧流发 ping**。relay 看到的是一条完全健康的流，空闲看门狗被持续喂食，毫无重连理由；而 `/act` 打到新实例的 bridge，那里没有订阅者，永远 503。启动器旧的 stop 只按"谁在监听端口"找 worker，此时僵尸已不监听，被漏杀。

**三层修复**：
1. controller shutdown 在 `server.close()` 后立即 `closeAllConnections()`，SSE 连接被摧毁而不是排水（`apps/controller/src/index.ts`；回归测试 `apps/controller/tests/agent-browser-stream-shutdown.test.ts` 同时钉住机制与接线）。
2. 启动器 stop 显式按 snapshot 记录的 `workerPid` 强杀（SIGKILL 升级），不只依赖端口查询——对旧版 controller 的排水僵尸同样有效。
3. relay 空闲看门狗改为单一可重置计时器 + `reader.cancel()`（规范保证把挂起的 read 以 done 解决），替换原来每轮 `Promise.race` 一个必然 reject 的 deadline——那个实现输掉竞速的 Promise 会成为 unhandled rejection 且计时器泄漏。重连行为由 `tests/desktop/agent-browser-relay.test.ts` 用真实 HTTP 假 controller 钉住（含同端口复活、静默卡死流两个场景）。

**修复后实测**：连续两轮 `pnpm dev restart controller`，agent 浏览器工具均在 **8 秒内自动恢复**（重连日志 `terminated` → 2 秒后 `connected`），socket 表单监听、无僵尸。

排查日志在 `<userData>/logs/agent-browser.log`（开发环境为 `.tmp/desktop/electron/user-data/logs/`），记录 connect / end / fail 全过程。

元素引用（`ref`）建立在 `backendDOMNodeId` 上，它比产出它的 AX 树活得久，因此 ref 在页面生命周期内稳定，只在**主框架**的跨文档导航（`did-start-navigation` 且 `isInPlace === false && isMainFrame`）时重置——子框架（广告 iframe）自行导航曾经会清掉主页面的 ref，现在不再计入。每个成功动作都返回证据而非空回执：`open`/`snapshot` 返回页面元素，`click`/`type`/`select`/`press`/`hover` 返回被操作元素**之后**的状态（用 `Accessibility.getPartialAXTree` 单点读回，不再重走整棵树，长页面上也不会把仍在页面上的元素误报为消失）。浏览器可以读回（桌面点击不能），所以"成功了"和"这是操作后的元素"花同样一次往返，而只有后者可核对。

**证据的时序不再是固定延迟。** 早期实现动作后固定等 700ms 取证，实测两头都错：点进慢站读回的是半加载页面（title 还是 URL 字符串），而什么都没触发的点击也白等 700ms。现在主进程的 `watchAction` 在动作前记下导航纪元，动作后先给导航 `quietMs`（300ms）时间**开始**，若已在加载则等 `did-stop-loading`（上限 `loadTimeoutMs` 8s），再留 `renderMs` 让框架渲染，最后按事件而不是按 URL 字符串判断结果：`navigated` 只在主框架换了文档时为真（同 URL 的 reload、表单重复提交都算，ref 已失效）；`changedInPlace` 覆盖 pushState 路由、同页搜索、只改标题这类文档未换但内容已变的情况（ref 仍有效，但值得重新 snapshot）；URL 变了却没有任何导航事件，视为观察窗口错过的导航，按 `navigated` 处理，因为多做一次 snapshot 便宜，用已死文档的 ref 继续操作则昂贵。仍在加载时回执带 `loading: true`。

**对话框不能挂住 agent。** agent 标签页以 `disableDialogs: true` 创建：Chromium 立即关掉每个 JS 对话框（alert 视为已确认，confirm 取消），同时 `Page.enable` 之后 CDP 会先于 Electron 收到 `Page.javascriptDialogOpening`，`watchAction` 把动作期间出现的对话框（alert / confirm / beforeunload）作为证据回给 agent，插件渲染成"某对话框已自动关闭，若它需要真实回答请告诉用户"。`beforeunload` 由 `will-prevent-unload` 放行（否则导航会被静默取消，agent 看到"点击没反应"），记录只取 CDP 那一份以免重复。用户自己的标签页不受影响，仍显示真实对话框。

**页面未捕获异常也是证据。** `Page.enable` 之外还开 `Runtime.enable`，动作窗口内的 `Runtime.exceptionThrown` 按 `pageErrors` 随回执返回。起因是 `prompt()`：Electron 根本没有实现 `window.prompt()`，它同步抛 `Error: prompt() is not supported.`，不弹框也不返回 null，因此没有任何 `Page.javascriptDialogOpening` 可上报（实测与 `disableDialogs` 无关——未设该项的 Nexu 应用渲染进程抛同一个错误，字符串编译在 Electron Framework 二进制里）。后果是调用 `prompt()` 的事件处理函数从该行起中断，页面本身不卡死（定时器继续走、其他按钮仍可点、刷新即恢复），但 agent 只看到"元素没有变化"，分不清是处理函数半路死了还是点歪了。现在这两种情况有了区别，而且覆盖面不止 `prompt()`：任何页面 JS 报错都同路返回。取 `exception.description` 的首行加 `文件名:行号`（CDP 行号从 0 起算），同一条消息只留一次，每个动作最多 5 条——渲染循环里抛错的页面一次动作能抛几十遍。插件对 `prompt()` 额外说明这是浏览器的限制而不是站点坏了，否则模型会把站点报成故障并重复点击。

**改 `packages/shared` 的 schema 后必须重启 controller。** 这条链路上 `/api/v1/browser/agent/result` 用 `c.req.valid("json")` 解析桌面回传的 outcome，Zod 默认剥掉 schema 里没有的键。加 `pageErrors` 时只重启了 desktop，桌面侧日志显示证据齐全、agent 收到的却是空——字段在 controller 的旧 schema 上被静默剥掉。桌面与 controller 都要重启。

**快照面向长页面。** `browser_snapshot` 接受 `maxNodes`（默认 400，上限 1000）与 `visibleOnly`；后者用一次 `DOMSnapshot.captureSnapshot` 拿到全页几何，只保留与视口相交的节点，配合 `browser_scroll`（回执带 `y/maxY`，到底会明说）分段读长页。DOMSnapshot 的 bounds 是设备像素，视口必须按 `contentWidth / cssContentSize.width` 换算到同一坐标系，否则 2x 屏上滚到页底会一个节点都不剩（已实测并钉在单测里）。降噪规则：父节点（link / button / heading）的可访问名已经包含的 `StaticText` 不再单独列出，深度按已输出的祖先计数而不是原始树深度；link 附带解析成绝对地址的 `href`，checkbox / radio 附带 `checked`。截断提示指向 `maxNodes` 与 `visibleOnly`——旧提示让 agent "scroll 看后面"，但 AX 树与视口无关，滚动改变不了前 N 个节点。

**点击前会重新测量。** `clickRef` 先 `mouseMoved` 到元素中心（悬停依赖的菜单要先收到指针），再重新 `DOM.getBoxModel`：指针离开悬停菜单会让菜单收起、下方元素回弹，实测按旧坐标按下会落到空白处，按钮的 handler 根本不跑。`browser_type` 默认替换字段已有内容（先选中再 `Input.insertText`），`append: true` 才追加。`browser_screenshot` 走 `capturePage` 并缩到最长边 1200px 的 JPEG，与 OpenClaw 自身图片工具的上限一致，作为 `{type:"image"}` 内容块回给模型。

### Computer Use

使用固定版本的独立 sidecar，由桌面打包阶段下载并校验 SHA-256。macOS 采用 Peekaboo 3.9.8，原因是其原生 Accessibility 覆盖、稳定签名身份、Apple notarization、后台定向输入及菜单/Dock/系统对话框能力均优于当前仍为 prerelease 的 CUA 0.12.6；Windows 使用 CUA 0.12.6。Peekaboo 发布包中的 `peekaboo`、`libswiftCompatibilitySpan.dylib` 与 MIT `LICENSE` 必须作为一个完整分发单元保留并校验，不能只复制主二进制。`vendor.json` 记录压缩包摘要及解压后逐文件摘要；运行时缓存命中也必须重新校验，缺失或损坏时原子替换。运行时通过绝对路径写入 OpenClaw MCP registry。

Peekaboo 3.9.8 的最低系统要求是 macOS 15。Controller 通过 Darwin kernel major（24 及以上）做能力门控；macOS 13/14 可以继续运行 Nexu，但设置页会明确显示版本不支持且禁止开启 Computer Use。

```json
{
  "mcp": {
    "servers": {
      "cua-driver": {
        "command": "/absolute/path/to/platform-backend",
        "args": ["mcp", "--embedded", "--socket", "\\\\.\\pipe\\nexu-cua-driver-<instance>"],
        "enabled": true
      }
    }
  }
}
```

打包应用不得使用 `npx`、包管理器或用户 PATH。打包资源会按 vendor metadata 指纹原子复制到 `NEXU_HOME/runtime/computer-use/`，launchd 与普通 desktop runtime 都只引用该外部路径，避免 sidecar 锁住可替换的 `.app`。Nexu Electron 不是 Swift 版 OpenClaw.app，因此不声称直接托管 `PeekabooBridgeHostCoordinator`。首版显式启动已签名 Peekaboo CLI 的专用 daemon；socket 默认使用 `NEXU_HOME/runtime/peekaboo/daemon.sock`，若 UTF-8 字节长度超过 macOS Unix socket 上限，则切换到用户 home 下按 `NEXU_HOME` 哈希隔离的 `~/.nexu-run/peekaboo-<instance>/daemon.sock`。该目录拒绝符号链接和非当前用户所有权，并在启动前强制为 `0700`；若这个私有路径仍超过上限则将 Computer Use 标记为 unavailable，仅在尝试启用时明确拒绝，不影响默认关闭状态下的 Controller 启动，也不回退到共享 `/tmp`。MCP 与 daemon 始终使用同一个解析结果；关闭功能时只停止这个 Nexu 专用 daemon。macOS TCC 对 Peekaboo 的稳定签名身份授权。后续若产品要求权限面板只显示 Tabby，再引入 Nexu 自有签名的 Swift helper 托管 Bridge。

首次授权时，Controller 从 Peekaboo bridge 读取 Screen Recording、Accessibility 与 Event Synthesizing 状态。虽然 Peekaboo 将 Event Synthesizing 标为 optional，但当前 allowlist 暴露了后台 `type`、`hotkey` 等输入工具，因此 Nexu 将它提升为就绪前置条件。设置页逐项显示缺失权限；Screen Recording 通过 bridge 请求，Accessibility 与 Event Synthesizing 由实际签名的 Peekaboo 进程使用 `agent permission request-* --no-remote` 请求，然后打开对应系统设置页。授权状态仍以 bridge 的再次探测为准，不把“已打开设置页”当成成功。

Windows 的 `cua-driver mcp` 只是 stdio proxy，不会代为启动 daemon。Controller 使用与 `NEXU_HOME` 绑定的独立 named pipe 启动 `cua-driver serve --embedded --parent-liveness-stdio --socket <pipe>`，保留 stdin 与子进程句柄，等待 `status` 成功后才持久化开关；Controller 退出时 pipe EOF 会终止 daemon，正常关闭还会发送幂等 `stop`。启动时若发现并非当前 Controller 管理的旧 daemon，会先停止再创建新实例，避免跨升级复用。MCP 以 `--embedded` 连接同一 pipe。Daemon 显式使用 CUA 的 `standard` 授权模式，不传 `--dangerously-bypass-approvals`；Nexu 还通过进程环境关闭 CUA 默认开启的产品 telemetry。Windows 本地开发不直接把 `.cmd` 交给无 shell 的 `execFile`，而是显式注入当前 Node executable，由既有 command spec 以 `node.exe + openclaw.mjs` 执行 OpenClaw 命令。

### Orca 实现对比

Orca 的 Computer Use 值得复用的是“动作结果必须显式区分 verified/unverified”的语义，而不是直接复用它的进程架构。Orca 在 macOS 14 及以上优先选择自带的 Swift 原生 provider，并把调用隔离到 IPC sidecar；`AXSetValue` 会读取实际值进行回验，合成键盘、快捷键和剪贴板输入则先校验窗口焦点，并明确标为 `unverified`。Linux 与 Windows 使用脚本 provider。Nexu 当前继续采用 macOS Peekaboo、Windows CUA 的平台组合，但在 OpenClaw plugin 与 Controller SSE 两层补同类完成证据约束。

Orca 的浏览器控制当初被判为“不满足控制用户现有浏览器的定义”——它控制的是 Orca 内嵌 Electron `<webview>` 或主进程 offscreen `WebContents`，登录态位于 Electron partition；`agent-browser` bridge 通过 CDP 连接这些 Orca 自有页面，并主动剥离调用方传入的任意 `--cdp`/`--session` 目标。随着上面的决策变更，这恰好就是 Nexu 现在采用的形态：目标不再是“接管用户现有浏览器”，而是“给 agent 一个用户看得见的浏览器”。差异在于 Nexu 用面板本身做执行者，把可见性变成结构约束，而不是仅靠 bridge 侧剥离外部目标。

## 配置模型

`config.json` 增加：

```json
{
  "localAutomation": {
    "browser": { "enabled": false },
    "computerUse": { "enabled": false }
  }
}
```

Controller 的 `GET /api/v1/runtime-config` 返回配置、当前安装状态和 `previewEnabled`；`PATCH /api/v1/runtime-config/local-automation` 更新开关并触发 OpenClaw 同步。开发环境默认允许 Preview；生产环境默认 fail-closed，仅在运行环境或打包时的 `build-config.json` 显式设置 `NEXU_LOCAL_AUTOMATION_PREVIEW_ENABLED=true` 时允许启用。Computer Use 在二进制不存在时保持不可启用并返回明确状态。

## 安全策略

- 默认关闭，用户必须在桌面设置中显式开启；未启用 Preview 的生产构建不会编译内嵌浏览器工具、agent tool allowlist 或 Computer Use MCP，API 也拒绝开启和权限请求。
- 启用时必须先确认 daemon 就绪，再写入 MCP；禁用时先撤销 MCP 并重启 OpenClaw，再尽力停止 daemon。后端停止失败不能让已授权工具继续暴露。
- Controller 将 bootstrap、配置更新、系统权限请求和关闭动作串行化；禁用操作完成后不能有较早启动的权限请求重新拉起 daemon。
- 浏览器工具只作用于对话面板里的内嵌浏览器视图，不接触用户自己的浏览器，也不开放任何本地调试端口。
- CUA 与 Peekaboo MCP 使用工具 include allowlist，仅开放观察、应用/窗口枚举、点击、拖拽、输入、滚动和按键等基础工具。`nexu-toolcall-guard` 在调用入口维护同一份独立白名单并对未知 backend 工具 fail-closed，防止配置漂移意外开放 Peekaboo 的内置 `agent`、远程调试 `browser`、剪贴板或其他未审核能力。
- 编译器不生成 `commands.ownerAllowFrom: ["*"]`，并关闭渠道 `/restart`。OpenClaw 2026.7.1 会把 wildcard command owner 解释为任意发送者都是 owner，进而暴露 `nodes`、`gateway` 与 `cron` 等 owner-only 工具，因此不能依赖文档中“wildcard 不足以成为 owner”的描述。
- `nexu-toolcall-guard` 在 `before_tool_call` 按运行时会话来源阻断外部渠道和子会话对 `browser_*`、`peekaboo__*`、`cua-driver__*` 的调用，并继续隔离 `nodes`、`gateway`、`cron` 控制面。Controller 的 `/api/v1/browser/agent/act` 用同一套会话 key 形状再校验一次。`exec`/`process` 则按产品默认开放：所有来源均使用 `tools.exec.security="full"`、`tools.exec.ask="off"`，不在 plugin 层二次阻断；非沙箱运行使用本地 gateway，启用沙箱时改由 sandbox 执行。这意味着 Browser/Computer Use 专用开关不是通用主机命令的安全边界，部署方需要通过 sandbox 和渠道信任策略控制整体风险。
- Computer Use 动作回执只证明事件已投递。守卫只接受三类完成证据：固定的 CUA 0.12.6 在可信结构化结果中返回顶层 `verified: true`，或增强 provider 的 verification 与本次 property/expected/element 参数一致；输入/赋值后从同一元素引用和 app/window/snapshot 读回实际 value；启动应用后观察到对应进程或窗口。任意文本中形似 `verified` 的 JSON 不作为证据。`set_value` 必须在 NFKC/case 归一后与完整 value 字段精确相等，`hello` 不能匹配 `hello world`，`default_value` 等近似字段名也不能伪装实际 value；清空字段只接受同元素的结构化空值或显式 `value=""`/`value=''`，非结构化文本还必须在行首或显式 ID 字段中精确绑定元素引用，`field`/`other-field`、`B1`/`B10` 之类的前缀碰撞不能作为证据；空字符串 `type` 不能证明动作，普通合成 `type` 可按输入片段验证。普通的同目标截图或状态读取不能证明 click、hotkey、scroll、drag、menu、dialog、Dock 或 window 动作达成意图，这些动作在 provider 提供动作专属后置条件前保持未验证。元素标签、标题或界面其他位置的同名文本不能充当 value；Peekaboo 使用真实 `on`/`snapshot` 参数，CUA 同时支持 `element_index`/`element_token`。失败动作只有完全相同的工具与参数重试成功后才可替换，其他成功动作不能掩盖它；同一应用的不同窗口分别跟踪。没有显式 app/window/snapshot 的 frontmost 动作保持未验证。Windows 的 `launch_app` 可以使用工具结果返回的 PID/窗口作为后续验证别名。CUA 的 `start_session`、`end_session`、`escalate_session` 属于 provider 生命周期，不作为用户界面变更。OpenClaw plugin 在写入终态消息前替换不实完成文本，Controller 对桌面 SSE 再独立把 `final` 降级为 `local_automation_unverified` 并冻结该 run 的失败判定，确保并发订阅者得到一致结论；`final`、`error`、`aborted` 只锁定对应 `runId`，Controller 与首次会话 UI 均丢弃该 run 晚到或重放的 delta/final，但会继续转发同一会话后续 run。会话发现轮询失败只影响页面提示，不占用 SSE 终态，因此随后合法 final 仍可完成跳转。该链路避免失败状态被重新覆盖为成功且不破坏长期 SSE 连接，并覆盖原始会话中“输入返回 `[ok]`、最终 `see` 超时、Bot 仍称完成”的故障。
- 打包版 embedded web server 不反射 CORS Origin，并在 HTTP、OPTIONS 与 WebSocket upgrade 上拒绝非 loopback Host、外部 Origin 和 `Sec-Fetch-Site: cross-site`。Controller 直连端口执行同一类全局校验，防止恶意网页通过端口扫描或 DNS rebinding 调用写接口或建立设备控制 WebSocket。
- 任何支付、发布、删除、发送消息、上传、账号或权限修改都属于高影响动作。运行中心承接 OpenClaw 与 Team 的结构化待审批队列、reviewer 决策和持久化审计历史；仍不能把模型提示描述成安全边界。插件自定义的高风险能力必须继续通过自身审批契约发出可审计事件。
- 不记录页面内容、截图、输入文本或用户凭据。

## 发布阶段

1. 内嵌浏览器完整闭环：开关、命令链路、ref 稳定性、面板可见性门。
2. CUA sidecar：固定版本下载、校验、签名/TCC 验证、MCP probe。
3. 审批与来源隔离：外部渠道 Browser/Computer Use 仍按来源隔离，桌面完成声明已有独立证据门；运行中心展示结构化审批队列、reviewer 和持久化历史。继续补不可伪造的 desktop capability、语义级结果验证和工具风险分级。
4. 稳定性：崩溃恢复、超时、取消、审计事件和 Windows 验证。

## 验收

- 关闭两项能力时，不编译浏览器/Computer Use 专用工具；所有来源的通用 `exec`/`process` 默认保持可用且无需二次确认，`nodes`/`gateway`/`cron` 仍由来源守卫隔离。
- 开启浏览器控制后，编译配置包含 `nexu-browser` plugin 和 `browser_*` agent tool allowlist；顶层 `browser` 块、`browser` 工具和 OpenClaw 内置 browser plugin 在任何开关状态下都不出现。
- 冷启动后无需用户先打开侧栏：`open` 直接返回真实快照，`click` 首次即命中（跨两次冷重启验证）。
- 收起侧栏只隐藏不销毁：页面、登录态与元素引用存活，重开面板按固定 tab id 认领回来。
- 渲染进程重载或崩溃后，屏幕上不残留任何没有面板外壳的网页；该窗口的页面仍然存活，面板重新挂载后照常认领。应用内同文档路由跳转不受影响，agent 任务中的页面不会被掐掉。
- 导航之后不再把新页面上同名 ref 当作"你操作的那个元素"报回。
- 点击慢站后回执等到 `did-stop-loading`（上限 8s）再取证，title 不再是 URL 字符串；同 URL 的 reload 报 `navigated: true`；pushState、同页搜索、只改标题报 `changedInPlace: true` 且元素仍能读回；子框架导航不重置 ref。
- agent 标签页里的 `alert` / `confirm` / `beforeunload` 不会挂住动作，且出现在回执的 `dialogs` 里各一次。
- 页面未捕获异常出现在回执的 `pageErrors` 里，带文件名与行号；`prompt()` 报 `Error: prompt() is not supported.` 并附"这是浏览器限制，重复点击同样会失败"的说明；重复抛出的同一条消息只出现一次；没有报错的点击不带该字段。
- `browser_snapshot visibleOnly=true` 在 2x 屏滚到页底后仍只列出视口内元素（含 RootWebArea），`browser_scroll` 回执的 `y` 是滚动停稳后的位置。
- 悬停展开菜单后紧接着点击下方按钮，按钮的 handler 必须执行（点击前重新测量）。
- `browser_type` 默认替换字段原有内容，`append: true` 追加；`browser_select` 未命中时列出可选项；`browser_screenshot` 返回最长边不超过 1200px 的 JPEG 图片内容块。
- 开启 Computer Use 后，仅在有效绝对路径存在时写入 `mcp.servers.cua-driver`；缺失时 UI 明确显示未安装。
- 已启用的 Peekaboo 在 controller 重启时自动恢复 Nexu 专用 daemon，关闭开关、回滚或退出 controller 时停止该 daemon。
- macOS 15 以下即使持久化配置残留 `enabled=true`，也不会启动 Peekaboo 或编译 MCP，并且设置页仍允许关闭残留开关。
- 新装 macOS 机器能在设置页分别完成 Screen Recording、Accessibility 与 Event Synthesizing 授权，刷新后由 bridge 状态显示为 ready。
- 外部渠道和子会话对 `browser_*`、Computer Use、`nodes`、`gateway` 与 `cron` 的调用被工具守卫拒绝；专用浏览器/Computer Use 工具仍需显式启用。`exec`/`process` 不受来源守卫阻断，默认 `security="full"`、`ask="off"`。
- Computer Use 连续动作中任一动作没有 provider `verified` 或动作专属后置证据、输入/赋值缺少稳定元素引用、同元素实际 value 没有期望值、最终观察超时/失败，或失败动作只被不同成功动作掩盖时，桌面 SSE 返回 `local_automation_unverified`，持久化会话不得包含“已完成”声明；精确重试成功且取得上述强证据时仍允许正常完成。
- embedded web server 和 Controller 直连端口对恶意 Host/Origin 的 HTTP、预检与 WebSocket 请求返回拒绝，响应中不包含反射的 credentialed CORS 头。
- 权限请求与关闭操作并发时保持线性一致；关闭完成后的最终配置和 daemon 状态均为关闭。
- `pnpm generate-types`、`pnpm typecheck`、`pnpm lint`、相关 Vitest 和桌面 smoke test 通过。
