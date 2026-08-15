# Agent Note: 工作图 v3 —— 串行执行、预算级联、usage 记账

Status: implemented

[English](2026-08-14-workgraph-v3-serial-execution-budget.md) | 中文

## Problem

issue 02 留下了一张已安装、根就绪却无人运行的图。串行执行幕必须把 `done`/`blocked` worker 报告变成 tracker 结算、把每个子代理的真实 token usage 计入图预算，并保持 pause/clear 语义诚实——被中断的回合是资源停止，绝非判定。预算还必须在组合完全无法记录 usage 时响亮失败。

## Decision

**worker 回合是"spawn + 报告"流水线，带注入 seam。** `worker.ts` 渲染移植自 jxca 的 worker 契约（位置行、节点 spec、整体图目标、仅本节点 scope、发现的工作契约，以及 issue 04 将填充的先前 gaps 段），并按 `WORKER_OUTPUT_SCHEMA` 捕获 schema 解析结构化报告 `{ status: done | blocked, summary, discovered }`。报告取代 jxca 的 `NODE_RESULT:` 行锚标记，summary 是 schema 字段数据、无法伪装 status；缺失或畸形报告不可解析并 fail-closed 令节点失败，出错子代理 fail-closed。`workerSpawn` 配置 seam 无需模型即可编写报告；生产默认调用 `ctx.subagents.start('spawn', …)` 并以 `run.id` 暴露子会话 id 供 usage 记账。

**串行驱动确定性且逐转换检查点。** `serial.ts` 按存储序循环 Ready 节点——spawn、markRunning（子会话 id 持久记录）、按解析报告并以子代理 token 计费结算、为重规划边界队列化发现——预算门控分派，止于完成、楔死、预算停止或中断。Pause/clear 语义靠构造保证诚实：abort 信号在 markRunning 提交前检查（暂停快照原样保留）、在 usage 读取后检查（节点在权威快照上降级），且驱动返回时以 provider 的最新已提交视图为权威——中途 pause 绝不会被驱动本地链覆盖。无暂停介入时 spawn 传输失败会传播；有暂停时进行中节点降级。

**预算从子代理的持久 usage 记录记账。** `usage.ts` 按调度器启动的子会话 id 折叠子会话的 `assistant/message` usage 事件（input + output + cache 读写）。`settleAchieved`/`settleFailed` 接受可选 token 计费：spent-so-far 总是入账（含失败节点），越界结算触发 `budget_limited` 并把其他 running 节点降级为 Ready（资源停止，绝非判定），楔死暂停让位于预算停止，已完成图压过触发。分派门在剩余为零时触发（防御：外部恢复数据可能折叠出零剩余 active 图）。`resumeGraph` 接受从 spent-so-far 起算的可选加补——这是走出 `budget_limited` 的唯一途径；普通 resume 以提示拒绝。在无 usage 记录证据的组合中配置预算会响亮失败：父日志显示消息无 usage 时在 `set` 拒绝，父日志无证据时在首个子代理处 infra 暂停（节点降级、resume 重跑）。

## Alternatives considered

**只在节点边界记账、不做逐子代理读取。** 否决：spec 的记账是按子代理从持久 usage 记录出发，计费反映组合适配器实际报告的值——`recorded` 标志正是让静默无 usage 组合响亮失败、而不是"零花费"的关键。

**让驱动返回本地链。** 否决：中途 pause 会返回一个覆盖已提交 `user_paused` 的 active 快照（中途节点测试发现的问题）。provider 最新已提交视图是权威；驱动经由它调和。

**把 aborted worker 当作失败节点。** 否决：被中断的回合是资源停止，绝非判定——进行中节点降级为 Ready（与恢复语义一致），resume 经验证门控路径重跑。

## Consequences

- `set`/`resume`/`retry` 现在把图串行驱动到完成、暂停、楔死或预算停止；每次转换都经提交漏斗检查点。
- 138 个 vitest 测试全绿（新增 34 个），逐文件 100% 覆盖：串行顺序与 prompt 契约、blocked/不可解析/fail-closed 结算、发现队列化、权威快照上的中途 pause 降级（spawn 抛错与 usage 读取竞态）、结算与分派处的预算触发、加补 resume、以及 set 与首个子代理处的无记录响亮失败。
- worker prompt 自第一天就带 gaps 段；issue 04 用验证器拒绝填充它，并在 `done` 与达成之间加入对抗检查。
- issue 05 复用 worker 机制做并行批次；串行节点留在主工作区（jxca 的 G0/G1 划分）。
