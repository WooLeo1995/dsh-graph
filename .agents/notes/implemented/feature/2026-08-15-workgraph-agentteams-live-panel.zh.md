# Agent Note:workgraph 交互 UI 移植 AgentTeams 模式 —— 浮动活动面板 + 快照端点

Status: implemented

[English](2026-08-15-workgraph-agentteams-live-panel.md) | 中文

## 问题

workgraph 的 DAG 视图只以会话内卡片形式存在,由 `workgraph/change` 事件折叠驱动。没有常驻的实时监视器:状态变化只在归属会话内可见,宿主没有当前图的读 API,卡片也没有依赖链交互。用户要求把 [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 插件(MIT,程序员阿江/Relakkes)的交互 UI 用到 workgraph 上。

## 决议

移植 AgentTeams 活动面板模式,保留该模式的两平面分工——"锚定走事件、内容走轮询":

- **宿主快照路由**(`workgraph-scheduler`):`GET /plugins/dsh-workgraph/state` 在 `ctx.webServer`/`ctx.httpServer` 上懒绑定注册(`WEB_SERVER_KEYS` 兼容数组、headless 静默降级、`internal/service` 重绑定)。每次请求从每个活跃 agent 已提交的 `current()` 快照装配 `WorkGraphPanelSnapshot` 行(共享类型加入 `@deepseek-ai/dsh-workgraph`);节点 `depth` = 最长依赖链(与客户端 `layerNodes` 同语义,循环数据降级 0)。响应 `cache-control: no-store`;逐 agent try/catch 隔离坏会话。
- **浮动活动面板**(`ui-workgraph`):`ActivityPanel.tsx` 经 body-portal 挂载(web shell 无 top-right slot),每秒轮询路由并带 `inFlight` 守卫,按当前会话的图过滤,显示图头部与按 depth 分层的 DAG,含悬停链高亮与点击固定(Esc 清除)。折叠 badge 在页面 4s settle 窗口后自动展开一次,图消失 2s 后自动收起;当前会话无图时暂停轮询。所有副作用挂 `ctx.effect` disposer。
- **卡片交互**(`WorkGraphNode.tsx`):悬停高亮完整上下游链(`data-focused`/`data-dimmed`,经移植的 `relatedNodeIds`),点击固定,头部"活动面板"按钮 dispatch `OPEN_WORKGRAPH_PANEL_EVENT` 窗口事件。交互全部是组件本地状态——不产生会话事件、不改折叠(`workgraph-definition.ts` 未动,start 检测不变式完好)。
- **共享类型**在 `@deepseek-ai/dsh-workgraph`;客户端 import 并 re-export(单一声明源,无镜像类型)。

## 移植溯源(provenance)

模式移植自 [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)(MIT,© 2026 程序员阿江/Relakkes):`src/snapshot.ts`/`src/index.ts`(路由+装配)、`src/client/ActivityPanel.tsx` + `activity-model.ts` + `index.tsx`(面板、投影、body-portal 挂载)、`src/client/AgentTeamsCard.tsx`(打开面板的窗口事件)。workgraph 适配的差异:数据源是 scheduler 内存 `current()` 而非磁盘 `team.json`;图按会话归属(无 captain/team/workspace 概念);节点语义(`blocks` 边、`gn-final`、rounds/failure)。

## 验证

workgraph 300/300 与 ui-workgraph 57/57 测试全绿;触及文件逐文件覆盖 100%;`tsc -b` 干净;客户端 bundle 重建并含面板代码(`workgraph:open-panel`、`relatedNodeIds`、`/plugins/dsh-workgraph/state`)。评审对两个平面均 PASS(生命周期 disposer、交互只读、类型单源、字段级契约一致)。

## 备选方案

**只靠会话事件折叠、不加快照路由。**否决:面板本就需要宿主读面(用户明确要 AgentTeams 式实时监视器),而且该路由顺带覆盖了早前 start 检测笔记里的 revive 可见性缺口(复活图不提交事件,纯事件 UI 会一直失明)。

**直接把 AgentTeams 包作为依赖引入。**否决:workgraph 在 deepseek-harness fork 内维护(workspace 依赖、逐文件覆盖门禁、i18n 三件套);改为模式移植并记录溯源。
