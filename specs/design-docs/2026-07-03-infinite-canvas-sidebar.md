# 右侧边栏 → 无限画布工作台（Infinite Canvas Workbench）

> 创建：2026-07-03
> 关联：[2026-07-02-chat-first-team-operations.md](./2026-07-02-chat-first-team-operations.md)（侧边栏 = 持续状态的定位）
> 交互参考：github.com/basketikun/infinite-canvas（**只借鉴交互范式，不引入任何代码/依赖**；其渲染同为 DOM-based React 组件，验证了我们的零依赖路线）
> 许可证提示：参考工程自 2026-08-07（v0.15.1，commit `890ba95`）起由 **AGPL-3.0 改为 MIT**。原文档写的 AGPL 约束已过期——法律上现已允许署名复用。**但本仓库仍坚持重写而非照搬**：双方 store/schema/生成链路完全不同，照搬只会引入一套无人维护的外来抽象。

## 0. 目标与结论

右侧边栏从「单内容预览面板」升级为「**无限画布工作台**」：

1. **多节点并存**——现状一次只能显示一个 A2UI surface（新的顶掉旧的）；画布上每个 surface 是一个可拖动的节点卡片，运行面板、XHS 编辑器、Markdown 文稿可以同时铺开对照。
2. **平移/缩放**——滚轮以指针为中心缩放，拖拽空白处平移，一键适配全部节点。
3. **为影音创作 tab 打基础**——画布容器与"侧边栏"解耦（`lib/canvas/` 独立组件），未来图像/视频生成节点、连线编排直接复用同一容器。
4. **零新依赖**——DOM-based 自研（CSS transform），现有 React 组件（A2UIRenderer/TeamRunPanel/XHSEditor…）**原样**作为节点内容，无需改造。

## 1. 架构

```
lib/canvas/infinite-canvas.tsx     纯展示容器（受控 viewport + 节点渲染）
  - viewport {x, y, scale}，wheel=以指针为中心缩放(0.25–2)，背景拖拽=平移
  - 节点 = 绝对定位 frame（header: 标题+关闭，body: children）
  - header 拖拽移动节点；fit/reset 控件
  - 导出纯函数 zoomAtPoint / fitViewport 供单测

lib/a2ui/a2ui-sidebar-context.tsx  状态升级：单 surface → 节点集合
  - nodes: Array<{surfaceId, title, messages, onAction, position}>
  - openWith(surfaceId, messages, onAction, opts?)  ← 签名向后兼容
      已存在同 surfaceId → 更新内容并置顶；否则新增节点（级联布位）
  - closeNode(surfaceId) / close()（收起画布，节点保留在内存）
  - viewport + 各 surfaceId 位置持久化 localStorage
    （messages/onAction 含闭包，不持久化——刷新后节点内容按入口重开）

layouts/workspace-layout.tsx       右侧栏渲染 InfiniteCanvas
  - 头部「工作台」+ 节点数 + fit + 关闭
  - 显示条件从 rightSidebarOpen && isSessionRoute 放宽为 rightSidebarOpen
    （修复：团队页 openWith 后侧栏不显示的 S1 漏洞）
```

所有既有入口（sessions 自动打开 / 会话内跳转按钮 / XHSBatchTable 行点击 / 团队页运行 / TeamRunCard 查看详情）调用方式不变，各自成为画布上的一个节点。

## 2. 交互规格

| 操作 | 行为 |
|---|---|
| 滚轮 | 以指针为锚点缩放（scale 0.25–2，指数步进） |
| 拖拽空白 | 平移画布 |
| 拖拽节点头部 | 移动该节点（松手时持久化位置） |
| 「适配」按钮 | fitViewport：缩放平移到恰好包住全部节点（留边距） |
| 节点 ✕ | 移除该节点 |
| 面板 ✕ | 收起整个画布（节点保留，下次打开还原） |
| 新 surface 到来 | 作为新节点级联摆放并自动打开画布（沿用现有 auto-open 逻辑） |

## 3. 明确不做（v1 边界）

- **节点连线/工作流拖拽编排**：编辑语义此前已决策走表单/模板/compose；连线待影音创作 tab 需求明确后作为 S6 引入（画布容器已预留 children 分层）。
- **节点 resize / minimap / undo-redo**：参考项目有，v1 不做。
- **画布内容持久化**（A2UI messages 序列化）：onAction 是闭包，v1 只持久化位置与 viewport。

## 4. 落地记录（2026-07-03，v1 落地并真机验证）

- `apps/web/src/lib/canvas/infinite-canvas.tsx`（新）：零依赖 DOM 画布——`InfiniteCanvas`（wheel 指针锚点缩放 0.25–2 / 背景拖拽平移 / 节点头部拖拽移动 / 点状网格随 viewport 联动）+ 纯函数 `zoomAtPoint` / `fitViewport` / `clampScale` / `cascadePosition`（单测覆盖）+ `CanvasFitButton`。
- `a2ui-sidebar-context.tsx`：单 surface → **节点集合**。`openWith` 追加可选第 4 参 `{title}`，同 surfaceId 原地更新（全部旧调用点零改动兼容）；新增 `closeNode` / `moveNode` / `setViewport`；几何（viewport + 各 surface 位置）持久化 `nexu:canvas:sidebar`，内容（messages/onAction 含闭包）不持久化、由入口重开。
- `workspace-layout.tsx`：右侧栏渲染 `InfiniteCanvas`，头部「工作台 + 节点数 + 适配 + 关闭」；**显示条件去掉 `isSessionRoute` 限制**（修复：团队页 openWith 后侧栏不显示的 S1 漏洞），画布全工作区可用。
- 运行面板节点标题：TeamRunCard/团队页打开时传 `运行 · <标题>`；其余 surface 走 `humanizeSurfaceId` 兜底。
- 测试：`tests/infinite-canvas.test.tsx`（缩放锚点不动点/夹紧/适配/级联/渲染结构）；web 全套 109 通过。
- 真机：桌面端对话点「查看详情」→ 工作台画布展开，运行 DAG 以节点卡片呈现、状态点亮，网格/拖拽/缩放可用（截图验证）。

**后续（roadmap）：** S6 节点连线（影音创作编排需要时引入，画布已预留分层）；S7 影音创作 tab 复用同一容器挂图像/视频生成节点；节点 resize / minimap 视需求。

## 5. v2 —— 编排内核（2026-07-03，对齐参考项目画布区域）

深读本地 clone 的参考项目（`~/workspace/infinite-canvas`，AGPL，**仅提炼概念模型，零代码复用**；其画布同为手写 DOM + zustand，无画布库）后，将 v1「多节点摆放」升级为「可编排工作台」：

**架构（零新依赖）：**
- `lib/canvas/canvas-store.ts`（新）：仓库 xhs-batch-store 模式（`useSyncExternalStore`）的手写全局 store——类型化节点（`a2ui`/`text`/`image`：id/title/position/**size**/metadata）、`connections`（fromNodeId→toNodeId 自由连线）、`selectedNodeIds`/`selectedConnectionId`、viewport、`panelOpen`。**快照式 undo/redo**（400ms 防抖合并、50 条上限，对齐参考行为）。A2UI 载荷（messages+onAction 闭包）留在 store 外的 runtime Map，state 全量可 JSON 序列化。
- `infinite-canvas.tsx` 重写为 `CanvasSurface`（吃 store）：SVG 贝塞尔连线（右缘中点→左缘中点，拖蓝色手柄拉出虚线、落到目标节点创建；点击选中、双击删除）；右下角拖拽 **resize**；`⌘/Ctrl+拖拽` 框选（+Shift 追加）；快捷键 `⌘Z/⌘⇧Z/⌘Y/⌘A/Delete/Esc`；底部工具栏（撤销/重做｜文本/图片节点｜删除选中｜适配+缩放%｜清空），对齐参考项目工具栏并按 v2 范围裁剪。
- 节点内容：`text`（可编辑 textarea）、`image`（本地上传→dataURL 预览）、`a2ui`（既有全部组件经 payload map 渲染；载荷缺失显示"从原入口重开"占位）。
- `a2ui-sidebar-context.tsx` 降为**兼容桥**：`openWith` → `upsertA2UINode`（同 surfaceId 原地刷新），全部旧调用点零改动。
- 导入/导出：`nexu-canvas` v1 JSON（a2ui 节点及其连线剔除——闭包不可移植，由入口重开）。

**测试：** `tests/infinite-canvas.test.tsx` 11 例——缩放不动点/夹紧/按真实尺寸适配/贝塞尔路径；store 增删连（拒自连/重复边）/删点级联删边/undo-redo 快照/导出剔除 a2ui + 导入往返/upsert 幂等；Surface 渲染（节点/边/工具栏/选中态/过期占位）。web 全套 114 通过。

**v2 边界：** minimap、复制粘贴、多选整体拖动、素材库、外观面板、影音**生成**节点（S7，接 nexu 自有生成通道）、Agent 操控画布 op 协议（S8——参考项目的 add_node/connect_nodes/run_generation 等 8 op 面向本地 agent server；我们的对话流已天然充当 Agent 面板，op 通道未来经 A2UI action 回传承载）。HMR/刷新后画布节点为运行时态需从入口重开（几何持久化保留）。

## 6. v2.1 —— 验收反馈四项（2026-07-03）

1. **工具栏对齐参考项目**：新增 `video` / `audio` 节点类型（原生 `<video>/<audio>` 播放器渲染）+「上传素材」按钮（多选文件按 MIME 分流建 image/video/audio 节点，dataURL 内嵌）。仍未做：素材库、外观面板（记 roadmap）。
2. **一键展开 + 拖拽调宽**：工作台头部新增 Maximize/Minimize 切换——展开时右栏撑到「主区（对话流）恰好 500px」（`MAIN_MIN` 480→500），再点还原此前宽度；分割线拖拽原生支持保留，`RIGHT_SIDEBAR_MAX` 560→2400（实际上限交给 MAIN_MIN 约束）。
3. **团队运行 = 每步一个画布节点**：新增 `team-step` 节点类型（metadata 全可序列化：teamId/cardId/stepId/runId/workflowId/assigneeName/isApproval）。`pinTeamRunToCanvas(run)`（`lib/canvas/team-step-node.tsx`）把运行按拓扑 wave 展开为独立节点 + **真实画布连线**（dependsOn → connections），节点 id 派生自 cardId，重复打开幂等。节点内容轮询看板：状态徽章 / 产出预览 / 审批按钮（含审批步）。TeamRunCard「查看详情」与团队页「运行/最近运行」全部切到该入口；单面板 `buildRunPanelSurface` 移除（TeamRunPanel 组件保留供 a2ui 注册与 hooks 复用）。
4. **图片 → 小红书连线喂图**：`connection-effects.ts` —— 连线不只是视觉，携带数据流。image 节点（有内容）连入 XHS 编辑器 a2ui 节点时，从目标 surface 的 `XHSEditor` 组件 props 读取 batchId/postId，将图片推入 `xhs-batch-store` 对应帖子的 images（去重）。**生图节点（prompt→出图）需要 controller 新开生图 REST 通道（对接 openclaw image_generate），列为 S7 后端项**；届时生成节点复用同一 connection-effects 钩子。

测试：web 全套 115 通过（新增 pinTeamRunToCanvas 幂等/连线/布局断言 + 连线喂图去重断言）。

## 7. S7 —— 生图通道（2026-07-03 落地）

- **选型**：gateway 无直接图像 API（排除）；复用 §10.3 执行原语——`MediaGenerationService` 向 utility 子代理 lane（`agent:<botId>:subagent:imagegen-<uuid>`，botId=默认 agent）发一条严格合同消息（调 `image_generate` 一次、只回文件绝对路径、工具不可用则只回 `UNAVAILABLE`、禁 UI/技能/shell 变通），轮询 session 完成后提取路径。
- **安全**：路径必须落在 `<stateDir>/media` 内（防逃逸/防幻觉路径）+ 文件存在性校验；产物经既有 `GET /api/v1/media/state-file` 服务。
- **端点**：桌面端使用异步任务合同：`POST /api/v1/media/image-jobs {prompt, ...}` 立即返回 `202 + {jobId, status}`，再轮询 `GET /api/v1/media/image-jobs/{jobId}`，终态为 `succeeded + result` 或 `failed + error`。Controller 以单并发串行执行任务，进行中与排队任务合计最多 8 个，终态结果保留 30 分钟。旧 `POST /api/v1/media/generate-image {prompt} → {url, path}` 仅保留给旧客户端兼容（502 = 失败/超时/未配置后端）。
- **前端**：画布空图片节点新增「描述要生成的图片… + 生成」（与上传并列），成功后 `metadata.content = url`，可直接连线喂给 XHS 编辑器（复用 connection-effects）。
- **环境依赖与实测**：`image_generate` 工具需图像模型 provider 才注册；合入 main 的 **tabby-image 官方 skill**（走已登录 Tabby 云账号，零配置）后，生成合同更新为「优先 image_generate 工具 → 其次 tabby-image skill → 都不可用只回 UNAVAILABLE」。**真机全通**：POST 生图 108s 返回 200，产物 1536×1024 PNG 落 `media/outbound/<botId>/tabby-image/`，servable URL 直接可取（2.1MB）。超时上限 240s（skill 链路叠加 agent 开销：读 SKILL→起脚本→轮询）。弱模型可能无视 UNAVAILABLE 合同而空转至超时兜底。

## 8. v2.2 —— 交互内核重做：流畅度 + 划选文字 + 卡片对齐（2026-07-06 验收反馈）

验收反馈三项：拖动/改尺寸卡顿、拖动时鼠标划选文字、卡片样式与参考项目未对齐。逐项对齐参考项目范式（AGPL，仅借鉴范式，零代码复用）：

1. **划选文字**：画布容器永久 `select-none`（参考同款）；所有手势起点 `preventDefault()` + `setPointerCapture()`；文本节点 textarea 加 `select-text` 豁免（表单控件本身不受父级 user-select 影响，输入框选择不受损）。
2. **流畅度**（四个叠加根因一起修）：
   - **隐藏 bug**：旧 `onPointerMove` 回调身份依赖 viewport → 平移第一帧后 effect 清理把 window 监听器摘掉，平移基本冻结。重做后 window pointer 监听器**挂载期注册一次**，手势态全走 ref + `getCanvasState()` 读活值，身份零漂移。
   - **rAF 合帧**：pointermove 只记录坐标 + 调度一次 requestAnimationFrame，每帧至多一次 store 提交（参考同款）；pointerup 取消挂起帧并以松手坐标终提交。
   - **渲染隔离**：节点帧 `React.memo`（`CanvasNodeView`）+ 内容层 `NodeBody` 自定义比较（id/type/title/metadata 同一性）——拖动/缩放只重渲被拖节点的外框与连线 SVG，**A2UI 树/团队步骤内容零重渲**；节点定位从 `left/top` 改 `transform: translate3d` + `contain: layout style`（免每帧 layout）。
   - **store 侧**：`setViewport` 的 localStorage 持久化去抖 300ms（同步 I/O 出帧循环）；新增 `moveNodes()` 批量移动（多选拖动单次 emit），拖已选中节点整组移动、不再塌缩选区。
3. **卡片样式对齐参考**：`rounded-2xl border-2` + 选中蓝边升 `z-50` + `shadow-xl` + `transition-shadow 200ms`；连接点改为悬停/选中浮现的 12px 圆点（48px 隐形热区，hover scale-125）；缩放把手改角落 28px 隐形热区（光标即提示）；空媒体节点改居中图标砖 + 细字距标签（空图片/视频/音频节点）；有内容的图片/视频满铺圆角（p-0 full-bleed）、img `pointer-events-none select-none`；网格背景位置取模（数值不膨胀）。保留我们的标题栏（参考是无框卡片，但我们的节点含交互内容——A2UI 表单/文本编辑——需要专用拖拽把手与关闭钮）。

测试：新增 `moveNodes` 批量断言 + 「流畅交互契约」标记断言（容器 `select-none`、节点 `translate3d`/`contain`）；web 全套 115 通过、tsc/lint 干净。

## 9. Wave 1 —— 持久化 + 手感补全（2026-07-06 落地，SDD 流程）

执行计划 `specs/exec-plans/2026-07-06-canvas-parity-migration.md` 的 Wave 1（九项 1.1–1.9）全部落地。首次采用 superpowers **subagent-driven development** 流程：9 项编组为 6 个任务，每任务独立实现子代理 + 规格/质量双裁决评审 + 修复循环，收尾一次全波终审（最强模型），全程台账 `.superpowers/sdd/progress.md`。

**能力清单（全部真机可用）**：
1. **画布内容持久化**（IndexedDB `nexu-canvas/boards`，600ms 尾随去抖；a2ui 存框架、载荷重开重绑；水合不产生撤销步/不回存；StrictMode 安全）——刷新不再丢画布。
2. 文件拖放进画布（落点 world 坐标，多文件 +24 连续错位，读失败兜底不建节点）。
3. 系统剪贴板 Cmd+V（截图→图节点、文本→文本节点，落视口中心；输入框内不拦截）。
4. 节点复制/粘贴/副本（Cmd+C/V + 右键；选区内连线保留重映射；+36 逐次错位；`pasteClipboard(at)` 按组包围盒落点；**内部剪贴板优先、OS 粘贴兜底**单链路）。
5. 右键菜单（节点=副本/删除、连线=删除、背景=粘贴到此处；屏幕坐标钳位;任何手势起点统一关闭浮动菜单）。
6. 四角缩放 + 宽高比锁定（`canvas-geometry.ts` 纯函数:对角锚定含 min 钳位恒等式;图/视频默认锁比、头部锁钮切自由;比例=拖起时纵横比）。
7. 空格/中键平移（capture 相拦截,节点上也可平移;blur 防卡键）+ 缩放域 25%–200% → **5%–500%**（网格 <4px LOD 隐藏）。
8. 导出/导入 UI（JSON 下载/合并导入;**导入 id 全量重映射 + 端点校验 + surfaceId 剥离**——终审揪出的备份恢复损坏路径已封死）。
9. 连线落空白 → 建节点菜单（四类型,新节点左缘中点对齐落点并自动连线;`canvas-create.ts` 纯函数）。

**质量数据**：11 个 commit（6 feat + 5 修复轮）;web 测试 115 → **175**;5 个新纯模块（persistence/ingest/clipboard/create/geometry,全部 DOM-free 单测）;v2.2 交互契约终审逐条verified Held（mount-once/rAF 单帧单提交/memo 隔离/translate3d/select-none）;零新依赖零 any。

**W2 前置卫生任务（终审记录,不阻塞本波）**：内部剪贴板永久遮蔽 OS 粘贴需清空条件;FileReader→dataURL 三处重复提 `readFilesAsDataUrls()`;菜单钳位/关闭逻辑重复提共享 `FloatingMenu`;`onContextMenu` 缺 isEditableTarget 守卫;clipboard 的 genId 重复应导出 store 版;alert 换 AntD 提示;空格按住时节点上无光标反馈。`infinite-canvas.tsx` 1003→1521 行,架构仍清晰,W2 顺手抽 ~120 行重复。

## 10. Wave 2 —— 生成管线泛化（2026-07-06 落地，SDD 流程）

执行计划 Wave 2（卫生前置 + 2.1–2.7）七任务全部落地,13 个 commit（7 feat/refactor + 修复轮）,web 测试 175→**286**、controller 420→**437**。终审(opus)裁决 Ready:六条契约全部 Held、零 Critical/Important。

**能力清单**:
1. **画布卫生**(W1 终审移交):OS 文件粘贴优先于内部剪贴板、`readFilesAsDataUrls` 统一四处读取、共享 `FloatingMenu`(单一钳位实现)、右键可编辑区豁免、空格平移光标反馈(DOM 属性零渲染)、genId 收敛、toast 替代 alert。
2. **连线=生成输入**(2.1):`resource-references.ts` BFS 上游收集(直连优先层序、环安全、a2ui/team-step 透明);connection-effects 改注册表制(XHS 喂图为首个 effect)。
3. **节点异步任务状态**(2.2):`metadata.task`(缺省=idle/success 的精简态机)、生成中转圈/失败重试、**水合把中断的 generating 归一为 error**(重启无永久转圈);`canvas-generation.ts` 成为全部生成流的单一接缝(删除中途零僵尸写入)。
4. **三通道后端**(2.5/2.6):生图加 `referenceImages`(≤4,含入媒体目录校验→400)+`count`(≤4);`generate-video`/`generate-audio` UNAVAILABLE 先行(S7 剧本);响应 `url/path` 顶层向后兼容 + `items` 数组;**真机闸门:生图 200/46s(1.8MB PNG 可取)、视频 502/68s、音频 502/10s**。tabby-image 实测不支持参考图,合同"支持才用"措辞已正确覆盖,等技能升级即点亮。
5. **提示词面板**(2.3):选中媒体节点浮出世界坐标面板——@引用上游节点(自研 mention 下拉)、按类型参数、上游汇总(参考图可用数)、经接缝生成并自动附参考图。
6. **Config 节点**(2.4):聚合上游文本为提示词+上游图为参考,生成时右侧建结果节点并连线;诚实裁剪:模型/比例选择器等通道支持后再加。
7. **批量图组**(2.7):count>1 扇出为根+子(收起为堆叠幽灵卡、×N 徽章、设主图交换);删除级联/导入 id 重映射同步改写 batch 关联/复制得独立副本。

**过程记录**:mid-wave 治理事件一次——haiku 修复者产出套套逻辑测试并误提交台账,主控回退手修(`CONNECT_MENU_ITEMS` satisfies 钉住 + `.superpowers/` gitignore);fable 终审两次派发失败(watchdog/403)后降级 opus 完成。

**入档 Minor(不阻塞)**:hasUpstream 死导出、count 去重可能低于请求数、batch 双 emit 依赖历史去抖窗口、面板/Config 每帧 BFS(画布变大再上 Map 索引)、400/502 同一 toast。

**W3 前置移交**:`infinite-canvas.tsx` 已 1610 行——悬停工具栏动工前先做机械拆分(节点体 → `canvas-node-views/`)。

## 10.1 2026-07-30 媒体生成协议更新

- 默认 Tabby 图片和视频生成不再依赖 utility agent 猜测技能调用。controller 以固定脚本路径、`process.execPath` 和参数数组执行桌面内置 `tabby-image`/`tabby-video`，保留普通 agent 的 shell 权限边界。
- 视频节点参数表单按 Agnes Video V2.0 调整为：`480p/720p/1080p`、`16:9/9:16/1:1/4:3/3:4`、`81/121/241/441` 帧预设及覆盖全部合法 `8n+1` 帧数的滑杆、`1-60` 帧率、可选推理步数、反向提示词和安全整数种子。界面展示帧数及按当前帧率计算的约时长。
- API 与重试状态贯通 `numFrames`、`frameRate`、`numInferenceSteps`、`negativePrompt`、`seed`；历史 `durationSeconds` 在提交前按帧率迁移为不超过 `441` 且满足 `8n+1` 的帧数，不再出现界面时长与真实请求不一致。文档未定义的声音和水印选项不再出现在视频表单中，Tabby 模型会忽略旧画布遗留的这两个字段。
- 媒体视频节点把模型、分辨率、比例、帧数、帧率、推理步数、反向提示词和种子保存在节点 metadata 中，切换选择或重新加载已持久化画布不会恢复默认值。非法旧帧数、帧率、推理步数、seed 和超长反向提示词会在生成计划中先规范化，不把必然失败的参数发送到 controller。
- `tabby-video` 使用 `POST {relayBaseUrl}/videos` 创建任务；优先以 `video_id` 轮询中转站根路径 `/agnesapi`，只有旧 `task_id` 才轮询 `{relayBaseUrl}/videos/<id>`；完成地址读取 `metadata.url`。
- 当前画布图片引用是本地文件路径，而 Agnes 图生视频要求公网 URL，因此本轮没有暴露图生视频/关键帧表单。后续需先建立受控上传与可访问 URL 转换，不能直接把本地路径发给中转站。

## 11. Wave 3 —— 图片编辑套件 + 悬停工具栏（2026-07-06 落地，SDD 流程）

执行计划 Wave 3（拆分前置 + 3.1–3.7）七任务全部落地,16 个 commit,web 测试 286→**409**、controller 437→**448**。终审(opus)裁决 Ready:契约 1–7 全 Held、零 Critical/Important。

**能力清单**:
1. **前置拆分**:`infinite-canvas.tsx` 1610→1182 行,抽出 node-views/canvas-toolbar(纯搬移,比较器逐字节保留)。
2. **悬停工具栏**(3.1):节点上方浮动操作条,13 个按类型门控的动作(信息/下载/替换/锁比例迁入/删除 + 后续任务扩展);替换自动清除失败任务态。
3. **裁剪**(3.2):8 把手交互裁剪框(容器指针捕获,快速拖不脱手)、比例锁、实时尺寸,产出新节点;fetch→blob→createImageBitmap 规避跨域 canvas 污染。
4. **网格拆分 + 插值放大**(3.3/3.6a):整数精确瓦片(末行/列吸收余数,预览线与真实切割对齐)、R×C≤12 子节点网格排布;1K/2K/4K 三档三算法纯 canvas 放大。
5. **文本节点强化**(3.4):静态展示/双击编辑、字号 ±(10–48)、**转图片**(文本作提示词建连线生成节点)。
6. **AI 通道**(3.5/3.6b/3.7 后端+前端):生图通道扩 sourceImage+maskDataUrl(蒙版写入 media/inbound,入库前校验);enhance 通道(超分/多角度,独立 480s 超时键);describe 通道(反推提示词,120s,自由文本回复);蒙版画刷编辑器(双画布:显示层红笔/全分辨率黑底白笔)、视角对话框(CSS 3D 实时预览)、AI 超分模式、反推按钮(剪贴板+toast)。四项 AI 功能统一以「可服务源」门控(上传的 dataURL 图不可服务端编辑,如实禁用)。
7. **真机闸门**:**反推提示词 200/26s 真通**(视觉模型连图内文字都读出);**AI 超分 200/26s 真通**(1024×1536→1365×2048,agent 用系统工具自行完成——UNAVAILABLE-first 合同设计的直接兑现);坏蒙版 400 即时;蒙版重绘/多角度等生成式编辑仍走 UNAVAILABLE 兜底待技能落地。

**入档 Minor**:crop 对话框沿用内联加载器(策略同、函数未收敛)、mask drawingRef.scale 死字段、inpaint 成功覆盖对话框预设标题、describe 两类失败同一 toast。

**W4 前置移交**:crop 收敛到共享 loadImageBitmap;`CanvasDialogs` 挂载开关从 crop-dialog.tsx 提为独立文件(W4 新增对话框前)。

## 12. Wave 4 —— 工作台化 + S8 对话驱动画布（2026-07-07 落地，SDD 流程，收官波）

执行计划 Wave 4（前置收敛 + 4.1–4.4 + S8 旗舰 4.5）七任务全部落地,15 个 commit,web 测试 409→**544**、controller 448→**469**。终审(opus)裁决 Ready:契约 1–7 全 Held、零 Critical/Important。**至此 W1–W4 全 22 项对齐能力交付完毕。**

**能力清单**:
1. **前置收敛**:五个对话框统一到共享 `loadImageBitmap`(零内联 fetch 管线);`CanvasDialogs` 挂载开关独立成 `canvas-dialogs-mount.tsx`。
2. **小地图**(4.1):左下 200×132,按类型着色节点块 + 视口白框 + 点击导航(居中该世界点、缩放不变),隐藏批量子节点排除;工具栏开关(`canvas-ui-prefs` 持久化)。
3. **外观面板**(4.2):网格三模式(点/线/无,dots 输出与旧内联逐字节一致)+ 图片尺寸角标(onLoad 存 naturalWidth/Height,循环安全谓词,pref 独立订阅触发重渲);主题跟随 App(不做画布内切换)。
4. **素材库**(4.3):IDB v2(新增 assets 存储,升级只加不动 boards)+ 悬停「存为素材」+ 选择器对话框(类型筛选/搜索/8 分页/插入不关闭/删除);纯 filter/paginate 助手。
5. **命名画布**(4.4):工具栏切换器(新建/重命名/删除/切换),`switchCanvasBoard` 先 flush-save 当前板再 REPLACE-load 目标(绝不混板);**back-compat 命门:默认板 id 保持 "sidebar" 老用户内容原样呈现**;删除活动板先切换后移除。
6. **S8 对话驱动画布**(4.5,旗舰):op 协议 8 原语(add/update/delete_node、connect、delete_connection、set_viewport、select、run_generation)。链路:`nexu-canvas` runtime plugin(`canvas_read` HTTP GET 控制器镜像 / `canvas_op` 信使发 ```canvas-op``` 围栏块)→ 控制器镜像(前端去抖推送 + 插件读)→ `canvas_op` 结果经 SurfacedToolResultNames 浮现到对话 → 确认卡(应用/忽略)→ 执行器(ref 解析、结构 op 同步应用**合并为一次撤销**、run_generation 异步后置)。客户端经 `canvasOpBatchSchema` 二次校验。**这是对参考工程的差异化超越**:它外接独立 WS agent 面板,我们的 agent 就在对话里。
7. **真机闸门**:控制器+openclaw 重启载入插件(nexu-canvas 在 compiled openclaw.json 的 allow+entries、controllerUrl 已注入);镜像 POST/GET 往返真机全通(2 节点+1 连线+视口+选区精确回读)——canvas_read 数据路径端到端验证。完整「agent 发 canvas_op→确认卡→应用→一步撤销」为桌面端验收(需 bot+对话轮)。

**入档 Minor**:sessions.tsx 达 1870 行(S8 与 a2ui 并行内联);add_node 单轴给定时 cascadePosition 可能算两次(纯函数、无害);mirror warn-once 模块级。

**收官债移交(可选,分支合并前一次清理)**:sessions.tsx 抽 `chat-message-extract.ts`(a2ui + canvas-op 已是同一 enrich-by-toolCallId 的两份并行拷贝);canvas-store.ts(1001 行)板切换逻辑可移入 `canvas-board-switch.ts`。均不阻塞。

## 13. 2026-09-11 上游同步（参考工程 v0.15.0 → v0.18.0）

参考工程在 2026-08-06 之后发了 4 个版本。逐项比对后落地 7 项，全部在 `apps/web/src/lib/canvas/` 内按本仓库的 store/架构重写，零新依赖、零上游代码。

| 项 | 上游版本 | 落地位置 |
|---|---|---|
| 上游文本按【文本N】编号分块 | v0.18 | `prompt-panel-utils.ts`（`labelUpstreamTextBlocks` / `textBlockLabel`），`config-node-logic.ts` 共用同一 helper |
| 组节点作为生成输入 | v0.17 | `resource-references.ts`（`collectUpstreamRefs` 统一 BFS + 组展开），`infinite-canvas.tsx` 句柄拆分 |
| 视频节点截首帧/尾帧/当前帧 | v0.17 | `canvas-video-frame.ts` + 右键菜单 |
| 多选一键打组 / 解散组 + 整体虚线选区 | v0.18 | `canvas-groups.ts`（纯几何/门控）、`canvas-group-ops.ts`（store 动作）、工具栏 + 右键菜单 + `⌘G` / `⌘⇧G` |
| 参考内容栏 | v0.17 | `prompt-panel-utils.ts`（`buildReferenceChips`）+ `prompt-panel.tsx` |
| 1K/2K/4K × 宽高比固定尺寸表 | v0.18 | `prompt-panel-utils.ts`（`IMAGE_SIZE_TABLE` / `resolveImagePixelSize`） |
| 提示词弹窗放大编辑 | v0.15 | `prompt-editor-dialog.tsx`（复用 `prompt-drafts` 实现双向实时同步） |

**三处需要注意的行为变更（不是纯新增）：**

1. **图片 `size` 参数改发具体像素。** 档位 + 宽高比同时选中时发 `"2048x1152"` 而非 `"2K"`，两者都未选则维持原样。`buildImageGenOpts` 是共用接缝，所以**小红书生图链路**（`xhs-image-generation.ts`）一并生效——这是想要的：同一个含糊 hint 的问题在那边也存在。
2. **组节点现在可连线（只出不进）。** 原来 `connectable` 一刀切禁用两端；现在拆成 `canReceiveUpstream` / `canFeedDownstream`，组只保留 source 句柄，drop 到组上的入边在落点处被拦掉。
3. **视频/音频节点上游的图片不再隐藏，改为置灰 + 「不会作为参考图发送」。** 原设计怕误导所以整条隐藏，但那样用户在画布上看得见连线、面板里却什么都没有。参考内容栏的意义就是两个方向都说实话。

**组语义的两个刻意取舍（与上游不同）：**
- 打组后不自动清理变空的旧组：本仓库工具栏的「组」按钮可以主动创建空组容器，自动清理会把刚建的空组顺手删掉。
- 选中成员单独解散 = 该成员离开组，组和其余成员保留（与上游 `applyUngroupSelection` 一致）。

**验证：** web 105 文件 / 1105 用例通过（新增 `canvas-group-ops.test.ts`、`canvas-video-frame.test.ts`，共 +45 例）；`pnpm typecheck` 全绿；Biome 对改动文件零告警。真机（`pnpm dev` 栈）已逐项走通：提示词放大编辑双向同步、参考内容栏【文本1】chip 与 × 断连、`⌘G` 建组 / 右键解散组、组单边连线喂下游、视频尾帧截出 1280×704 PNG 图片节点。

**未纳入本轮（按价值/成本排序，供后续排期）：**
- 多次文本生成合并单节点 + 可展开备选（v0.17）——`canvas-batch.ts` 目前只支持图片。
- 多图子节点独立的失败重试 / 删除 / 副本 / 单图下载（v0.15）。
- 节点缩放期间暂停渲染提示词面板（v0.16，防高频重渲染崩溃）。
- 视频远端任务 ID 持久化 + 刷新续查（v0.18）——需要后端 job API，`canvas-store.ts` 现在一律把中断的 generating 归一为 error。

**判定为不适用（不要再重复评估）：** 本地代理页签 / WebDAV 同步、左侧元素列表树形分组（本仓库画布无元素列表侧栏）、GPT Image `response_format` / Gemini `imageConfig` / 多参考图 `image[]`（上游直连各家 API 的适配，本仓库经 `tabby-image` 技能）、Canvas Agent 凭据脱敏与权限（上游是独立 WS agent 进程）、视频 480p/720p/1080p + 4–30 秒滑杆（本仓库按 Agnes Video V2.0 用帧数/帧率，见 §10.1，回退是倒退）。

## 14. 2026-09-11 上游同步第二批（§13 未纳入项清零）

§13 结尾列的四项欠账 + 一项路线变更全部落地。这批里有三项动到了后端契约。

| 项 | 上游版本 | 落地方式 |
|---|---|---|
| 文本生成次数 + 多结果合并单节点、备选可切换 | v0.16 + v0.17 | `canvas-text-alternatives.ts`：N 条结果留在**同一个**节点（图片才扇出成兄弟节点），`content` 始终镜像 `items[activeIndex]`，编辑时写回当前条。前端并发 N 次调用 `generate-text`（后端每次本就是独立 utility lane session），一条失败不拖垮其余。配置节点文本模式新增「备选 1–4 条」，与生图张数彻底分开 |
| 多图失败项 + 逐项重试 | v0.15 | 不需要改后端：前端本就知道请求了几张。`attachBatchChildren(..., {requested, retry})` 把缺口补成 error 占位子节点，各自带**去掉 count** 的 retry，直接复用既有「重试」按钮 |
| 节点缩放期间暂停渲染提示词面板 | v0.16 | `PromptPanel` 加 `memo`；缩放手势期间 `CanvasSurface` 传入手势开始时的节点快照，props 同一性不变 → 面板整条全图 BFS 在拖拽每一帧上都不再跑 |
| 视频远端任务 ID 持久化 + 刷新续查 | v0.18 | `ImageGenerationJobService` 泛化为 `MediaGenerationJobService<TInput,TResult>`，新增 `POST/GET /api/v1/media/video-jobs`。图片与视频都**先提交拿 jobId、写进节点、再轮询**；`normalizeInterruptedTasks` 对带 job 的任务放行，`resumeGenerationJobs()` 在 hydrate 后重新挂上轮询 |
| 局部遮罩改走「画布上生成遮罩标注图」 | v0.17 | 不再用接口 mask 参数。涂抹区域合成到原图副本上（半透明蓝），经新增的 `POST /api/v1/media/inbound-image` 落盘成可服务路径，作为普通图片节点放到画布；原图与标注图两条连线喂进结果节点，提示词按「参考图1/参考图2」点名。弹窗底部拆成「导出到画布」与「立刻生成」 |

### 后端变更

- **新增** `POST /api/v1/media/inbound-image`：把画布合成的 dataURL 落到 `media/inbound` 并返回可服务路径。原 `writeMaskFile` 的解码/校验逻辑提为共用的 `writeInboundImage`。
- **新增** `POST /api/v1/media/video-jobs` + `GET /api/v1/media/video-jobs/{jobId}`。
- **重命名** `image-generation-job-service.ts` → `media-generation-job-service.ts`，类泛型化（原实现对结果类型本就无依赖，只有 `run` 回调和日志 label 是通道相关）。

### 两个刻意的取舍

- **文本多次生成放在前端扇出**，没有给 `generate-text` 加 `count`。后端每次调用本就独立开 session，扇出到前端换来的是「一条失败不影响其余」和零契约改动。
- **job 只活在控制器内存里**（30 分钟 TTL）。控制器重启后续查会拿到 404，节点落成 error 并保留 retry —— 这是诚实答案，比永远转圈好。

### 真机验证（`pnpm dev` 全栈）

- 尺寸表：面板 chip 实测显示 `3:4 · 2K（1536x2048） · 2 张`，落到 retry 里的 `size` 就是 `1536x2048`。
- **刷新续查**：生图途中 IndexedDB 里节点带 `task.job={kind:"image",jobId}`；刷新后节点**保持 generating**（旧行为是立刻「生成已中断」）；控制器上该 job 继续跑到终态，前端 resume 把真实结果（本次是 tabby-image 中转站网络失败的原文）写回节点。这条链路完整成立。
- **文本备选**：配置节点选「备选 3 条」→ 一个文本节点带 `1 2 3` 三个切换按钮，三条内容各不相同，来回切换内容正确。
- 新增的两个后端路由：坏数据 400、真 PNG 200 且落盘可服务、未知 job 404，均实测。
- 未能真机走通的两项：多图失败占位与遮罩标注流程都依赖一次**成功的**生图，而本轮 tabby-image 中转站网络不通（环境问题，非代码）。两项均有单测覆盖。

**验证数据：** web 107 文件 / 1130 用例、controller 118 文件 / 1272 用例全通过；`pnpm typecheck` 七个项目全绿；Biome 对改动文件零告警。
