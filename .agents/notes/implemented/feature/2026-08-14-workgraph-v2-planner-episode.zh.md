# Agent Note: 工作图 v2 —— 规划执行幕、校验重试、冻结基线

Status: implemented

[English](2026-08-14-workgraph-v2-planner-episode.md) | 中文

## Problem

issue 01 交付了确定性的一半——词汇、tracker、计划门、持久化——但没有任何东西能启动一张图：`set` 需要一条把目标变成已校验、可持久计划的规划执行幕，被拒绝的产物恰好重试一次并带回门禁的反馈，规划失败时以 infra 暂停，并在任何节点运行前冻结该计划版本的节点全集。引擎表面（`set`/`status`/`pause`/`resume`/`retry`/`clear`）也需要第一个真实实现，因为 issue 03 的串行执行要建立在已经拥有会话图的 provider 之上。

## Decision

**规划执行幕是一条"spawn + 门禁"流水线，带注入 seam。** `planner.ts` 渲染移植自 jxca 的规划契约（2–8 个聚焦节点、只有真实排序依赖、保留目标 must-have 措辞的结果契约 spec、显式"永不写 `gn-final`"规则），并端到端执行一次尝试：渲染 → spawn → `parsePlanArtifact`。结果三分且响亮：`planned`（门禁通过、追加最终节点）、`invalid`（精确的门禁原因，调用方可重试一次）、`fail-closed`（子代理错误、产物缺失或 schema 无效捕获——infra 路径）。门禁抛出的非领域错误会重新抛出，绝不掩盖。`PlannerSpawn` seam 经 provider 配置注入，单元测试无需模型即可编写产物；生产默认走 `ctx.subagents.start('spawn', …)` + `PLAN_OUTPUT_SCHEMA` 捕获 schema，并在所有路径上 dispose run。

**tracker 以真实转换承载规划窗口。** `createPendingGraph` 提交一个活跃的零节点快照，历史带 `created` + `planning-started`（图在规划器运行前就已持久——规划中途崩溃留下的是可恢复、不会自行驱动的图）。`installPlanIntoGraph` 安装已校验节点集（根提升、`gn-final` 殿后、计划版本保持 1）并记录 `planning-completed`。`pausePlanningFailed` 以 `planning-failed` 历史条目 infra 暂停。通用 `pauseGraph`/`resumeGraph` 转换支撑引擎命令；`resumeGraph` 接受 user/infra 暂停与 blocked，丢弃暂停原因并重新激活——pending 图的调用方随后重规划。

**基线是 harness home 下 create-new 的文件。** `baselines.ts` 以 `wx` 语义把每版完整节点集冻结到 `workgraph/baselines/<graphId>/v<N>.json`；重复冻结以新增的 `WORKGRAPH_BASELINE_EXISTS` 码响亮失败，非 EEXIST 失败重新抛出（只有领域错误会让图暂停）。冻结发生在安装提交之后、任何节点运行之前——jxca 的"审计基线是基础设施失败，不可忽略"——因此冻结失败暂停 infra 而不是污染会话日志。

**`WorkGraphScheduler` 是拥有完整引擎表面的 provider。** `set` 做校验（空目标、非正预算）、在已有图（含暂停态）时拒绝第二张图、提交 pending 图、以恰好一次反馈重试运行执行幕、提交安装并冻结基线 v1。`status` 提供进程内最新快照，会话日志折叠是重载/外部数据的路径。`pause`/`resume`/`retry`/`clear` 现阶段在 tracker 层运作；执行幕取消、预算充值、项目投影分别随 issue 03 与 09 落地。从外部数据恢复的无暂停原因快照也能干净恢复（`withoutPauseReason` 早期返回）。

## Alternatives considered

**只在成功时持久化计划（无规划窗口快照）。** 否决：规划中途崩溃会丢失目标，"resume 重规划"（用户故事 18）需要一个可恢复的持久图。零节点 pending 快照是诚实的——fold 接受它、恢复会降级它、`resume` 检测空节点集并重规划。

**保留 jxca 的一次性标记契约（规划器写 JSON 文件）。** 否决（依 ADR 0003）：结构化输出 seam 已经捕获 schema 形状的产物，规划器直接报告 `{ nodes }`，门禁是唯一校验者；文件产物管道及其大小上限不再需要。

**基线作为会话事件。** 否决：基线是调度器拥有的审计工件，不是会话事实；harness home 下的文件遵守写隔离（除 `.dsh/graph.jsonl` 及其锁外，仓库里什么都不进）。

## Consequences

- `set` 现在端到端运行：合法计划安装且基线 v1 在任何节点运行前冻结；被拒计划恰好重试一次并带回反馈，第二次失败 infra 暂停；`resume` 重规划 pending 图。
- provider 的实时视图是最新已提交快照，fold 是重载路径；每次转换仍经由 `commitWorkGraphChange`（持久日志与实时流不会分叉）。
- 104 个 vitest 测试全绿（新增 39 个），scheduler 源码逐文件 100% 覆盖；lint 干净。`plannerSpawn` seam 让测试保持无模型；真实栈无钥集成（llm-mock-server）自 issue 03 开始。
- `WORKGRAPH_BASELINE_EXISTS` 加入稳定错误码联合；`pauseGraph`/`resumeGraph` 是 issue 07（命令面）与 09（复活）将基于的通用转换。
