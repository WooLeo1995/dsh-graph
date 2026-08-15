# Agent Note: 工作图 v8 —— Web 客户端活 DAG 视图

Status: implemented

[English](2026-08-14-workgraph-v8-gui-dag-view.md) | 中文

## Problem

到 issue 07 为止，图有了命令面但没有活图景：`/graph status` 按需打印树，却没人能在图运行期间观察 DAG 演化、检视节点失败或看预算行。Web 客户端已从会话事件渲染持久 workflow-run 与 goal 节点；工作图需要同样待遇——一个只读视图，因是登录状态的纯函数而能在重载后重建出完全相同的样子。

## Decision

**`packages/client/ui-workgraph` 提供节点半区、不变量伴生与浏览器半区。** 浏览器半区经 `conversationEvents` 与 `conversation.chat.node` 座位注册一个持久 `workgraph` Chat 节点。`workgraph-definition.ts` 持有纯折叠：`decodeGraphChange` 防御式解码原始 `workgraph/change` 载荷（外来或畸形数据为 `null`，绝不崩溃；clear 解码为 tombstone）；`isGraphStartChange` 识别图的唯一开始——set 提交恰好携带一条 `created` 历史，而会话引擎要求每个上下文恰好一个 `start` 匹配，因此整个生命周期折叠为每个图身份一个节点；`update` 替换整个快照并在 clear 时 tombstone；`buildViewNode` 以确定性最长路径 `layerNodes`（按构造顺序稳定；循环外来数据把每个成员降级到第 0 层而非死循环）投影 `WorkGraphChatData`。

**`WorkGraphNode.tsx` 渲染分层 DAG**：逐层节点卡带账本点状态、未达成依赖的等待说明、失败/受阻卡上的失败来源、已达成轮次徽章、双线边框的终节点、头部（目标、状态胶囊、计划版本、消耗/预算行、挂起发现、暂停原因）、字形图例与可选详情面板（目标、规格、轮次、依赖、发现来源、失败）。主题 token（带回退的 CSS 变量）驱动每种颜色——无硬编码调色板。

**事件联合是按程序计算的。** 客户端的 `SessionEvent` 联合仅在 workgraph 包的 SessionEventMap 增广进入程序时包含 `workgraph/change`；定义导入域类型使合并作用于客户端构建。

## Alternatives considered

**用投影服务而非 chat 节点。** 否决：会话事件引擎已把会话事件折叠为带重放与活追加支持的持久节点；投影会重复那套机制并需要自己的重载路径。

**复用终端渲染器的 box-drawing DAG。** 否决：浏览器布局是 CSS 原生；分层 flex 行加卡片说明在任意宽度下渲染清晰，完整边路由留在终端渲染器。

**在视图中渲染控制。** 否决：按设计视图只读（issue 08 清单）；`/graph` 命令（issue 07）拥有全部变更。

## Consequences

- 凡存在 `workgraph/change` 事件，活 DAG 即出现在会话中，重载重建完全相同视图（重放 ≡ 活追加，由折叠测试证明）。
- 节点选择暴露规格、轮次、依赖、发现来源与失败；终节点视觉区 分；受阻链携带其来源。
- 视图只读，无需调度器 provider 即可组合。
- 20 个客户端测试全绿（定义折叠、面板、浏览器插件），逐文件 100% 覆盖；客户端聚合 typecheck 与 staged lint 干净。
- issue 09 落地拓扑优化器与 `.dsh/graph.jsonl` 项目复活。
