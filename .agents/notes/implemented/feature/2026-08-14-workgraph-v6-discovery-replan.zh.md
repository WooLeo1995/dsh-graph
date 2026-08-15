# Agent Note: 工作图 v6 —— 发现重规划、有上限的增强回合

Status: implemented

[English](2026-08-14-workgraph-v6-discovery-replan.md) | 中文

## Problem

issue 05 把计划跑到完成，但计划是快照：worker 与 verifier 报告携带的 `discovered` 条目已不再适配已安装的图。没有重规划回合，图要么忽略它们（丢失信号），要么必须失败（丢失收敛）。jxca 在回合边界用 replanner 子代理重规划，并以追加方式安装附录；图必须复刻这一纪律——有上限、滥用时响亮失败、绝不允许因增强回合失败而暂停一个运行中的图。

## Decision

**`replan.ts` 持有这一回合。** `runReplannerEpisode` 渲染 replanner 契约（目标、紧凑活图、挂起发现、先前反馈），经与规划相同的 `PlannerSpawn` seam 启动 replanner 子代理，带自己的输出 schema：`planned`（经校验的附录行规范化成 `waiting` 节点）、`invalid`（精确门原因）、`fail-closed`（子代理出错或缺 artifact）。`validateAppendix` 按固定顺序执行行规则——artifact 形状；行形状；slug 卫生；唯一性；非空正文；字符串 deps；无自依赖——并且刻意不在内部解析 deps：附录可引用现存活节点，由 `replanDependencyGuard` 对照当前图解析（永指保留终节点，永指非活节点）。`installReplan` 按规划者顺序追加，把 `gn-final` 重新门控到新增之上（Ready 终节点降级为 waiting），计划版本自增、条目清空、记录 `replanned`；新基线冻结在 harness home 下，v1 不可变。空附录是被尊重的答案且仍消耗槽位；空回合不会搁浅终节点校验——当每个依赖都已达成时，重新门控经 tracker 的 `promoteReady` 重新提升。

**调度器门控与降级。** `maybeReplan` 在回合边界运行——循环内一次、循环后一次，因此与终节点同落的 advisory 发现仍会排空。前置门：无条目 → 无操作；剩余预算为零 → 条目保持排队并持久化（`resume --budget` 补额后重新进入）；`gn-final` 已达成 → 排空到历史（advisory——此时追加会交付终节点从未复核过的工作）；`replanCap` 为 0 或耗尽 → 排空。否则一次尝试加恰好一次反馈重试，守卫在两次尝试上都执行；无效或 fail-closed 结果降级——条目排空到历史、槽位消耗（在已排空快照上 `replanRuns + 1`）、图继续运行。成功安装冻结新基线：版本冲突以基线消息 infra 暂停（resume 重新进入），非域错误直接传播。默认 replanner spawn 与规划共用 `subagentPlannerSpawn`，未配置的组合仍会重规划。

**`parallel.ts` 在边界钩子之后重读。** 批次驱动在钩子之前计算可运行集；被重新门控的 Ready 终节点随后以过期状态被分派——这是本 issue 测试抓到的真实 bug。现在可运行集在 `hooks.replan()` 之后按权威快照重读。

## Alternatives considered

**就地编辑节点重规划。** 否决：jxca 追加并在每次回合冻结新基线；突变会破坏审计轨迹与 v1 不可变不变量。

**replanner 失败时阻塞整图。** 否决：验收与 jxca 都降级为排空并继续——增强回合绝不允许暂停运行中的图。

**只做循环内重规划，无循环后钩子。** 否决：与终节点同落的发现要么被丢弃，要么在终节点校验之后交付——advisory 排空同时保全收敛与终节点校验的权威。

## Consequences

- 发现折叠为追加节点并冻结基线；回合有上限（`replanCap`），前置门保持队列诚实（预算耗尽的条目保持排队等待补额），每个失败模式都降级为排空并继续——绝不暂停。
- 空附录是被尊重的答案；重新门控会重新提升终节点，空回合不会搁浅整图。
- 并行驱动不再在边界钩子之后分派过期的可运行集。
- 227 个 vitest 测试全绿（新增 22 个），逐文件 100% 覆盖；lint（staged profile）与主机 typecheck 干净。
- issue 07 落地命令面（经校验的 `replanCap`）；issue 09 增加 `.dsh/graph.jsonl` 项目投影与排他锁。
