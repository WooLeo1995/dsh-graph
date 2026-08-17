# @deepseek-ai/dsh-client-ui-workgraph

[English](README.md) | 中文

Web 客户端的活工作图 DAG 视图。浏览器半区注册一个持久 `workgraph` Chat 节点（经 [`ctx.conversationEvents`](../../../packages/client/runtime/README.md) 与 [`conversation.chat.node`](../ui-conversation/README.md) 座位），把会话日志的 `workgraph/change` 全量事件折叠成每个图一个键控节点，因此重载后重建出完全相同的视图。节点渲染分层 DAG（最长路径分层、层内稳定）、带依赖等待与失败来源的状态着色节点卡、预算行、暂停原因、挂起发现、节点选择详情、视觉区分的终节点与字形图例。

## Definition

`workgraph-definition.ts` 持有纯折叠：

- `decodeGraphChange` 防御式解码一条原始 `workgraph/change` 载荷——外来或畸形数据为 `null`，绝不崩溃；clear tombstone 解码为 `{ cleared, graphId }`。
- `isGraphStartChange` 识别图的唯一开始：set 提交——以创建事实判别（`createdAt === updatedAt` 只对 set 提交成立，之后每个转换都 bump `updatedAt`，与 history cap 无关）；缺时间戳的载荷回退到恰好 `['created']` / `['created','planning-started']` 的历史形状。会话引擎要求每个上下文恰好一个 `start` 匹配，因此整个生命周期折叠为每个图身份一个节点。
- `layerNodes` 确定性计算最长路径层（按构造顺序稳定；循环外来数据把每个成员降级到第 0 层而非死循环）。
- `buildViewNode` 把最新快照投影为 `WorkGraphChatData`（层、状态、预算、发现、暂停原因）——登录状态之上的纯函数。

## WorkGraphNode

键控 chat 渲染器（`WorkGraphNode.tsx`）：逐层节点卡带账本点状态（`done`/`ongoing`/`warning`/`error`）、未达成依赖的等待说明、失败/受阻卡上的失败来源、已达成轮次徽章、终节点双线边框并标注、头部（目标、状态胶囊、计划版本、消耗与预算、发现、暂停原因）、图例与可选详情面板（目标、规格、轮次、依赖、发现来源、失败）。悬停节点高亮其完整上下游依赖链（`data-focused`，其余 `data-dimmed`）；点击固定高亮（Esc 清除），头部"活动面板"按钮经 `OPEN_WORKGRAPH_PANEL_EVENT` 窗口事件唤起浮动面板。主题 token 驱动全部颜色。

## ActivityPanel

浮动活动监视器（`ActivityPanel.tsx`，模式移植自 [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) MIT，跟进其 2026-08-17 面板重构）：经 body-portal 挂载的右上角固定玻璃面板（web shell 无 top-right slot）。每秒轮询宿主快照路由 `/plugins/dsh-workgraph/state`（`cache-control: no-store`，`inFlight` 守卫防请求堆叠），按当前会话的图过滤，显示图头部（目标、状态胶囊、计划版本、消耗/预算、发现、暂停原因）、分段进度总览（每节点一段着色、图例计数、按"受阻+运行中 > 运行中 > 就绪 > 受阻"层级生成的一句话摘要）与紧凑依赖 DAG：`compactDagLayout` 布局的 92×30 小节点（depth 分列、行内稳定）以三次贝塞尔 SVG 边相连，聚焦链时边随之高亮（180ms 悬停防抖、键盘焦点、点击固定、Esc 清除；图无边时退化为整宽并行网格）。折叠 badge 在活动出现时自动展开一次（页面 4s settle 窗口后），图消失 2s 后自动收起；当前会话无图时暂停轮询。面板只读——读宿主快照，绝不改会话状态。

## 组合

生产者注入 `conversationEvents`、`slots`、`locale` 与 `sessions`。自定义应用挂载其属主与本插件；会话内 DAG 仅凭会话事件即可工作（无需调度器 provider），活动面板额外需要调度器的快照路由：

```yaml
- id: conversationEvents
  name: '@deepseek-ai/dsh-client-runtime'
- id: ui-workgraph
  name: '@deepseek-ai/dsh-client-ui-workgraph'
```

## Model Experience

### 活工作图 DAG 视图

#### 模型看到什么

渲染的 DAG、节点详情与文案不出现在模型请求中。视图只读持久 `workgraph/change` 会话事件；不执行模型可见的变更。

#### Token 影响

渲染 DAG 不增加模型 token。图的 worker/verifier 子代理花费各自 token，以图的消耗/预算行展示。

#### KV Cache 影响

视图渲染不影响缓存；图的子代理使用各自全新会话。

## Known Limitations and Deferred Work

- **无图控制** —— 视图只读；`/graph` 命令（issue 07）拥有 pause/resume/retry/clear。
- **边是说明而非路径** —— 分层行以卡片说明展示等待与连接；完整 box-drawing 边路由留在终端渲染器。
