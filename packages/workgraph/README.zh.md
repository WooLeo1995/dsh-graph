# workgraph/ — 确定性工作图能力族

[English](README.md) | 中文

本能力族把一个目标变成由确定性调度器驱动的、自主且自验证的 agent 工作 DAG。契约移植自 jxca-cli 的 `/graph`，文件:行号溯源见第二阶段设计笔记（`.scratch/research/2026-08-14-graph-dag-phase2-design.zh.md`）；接缝决策由 [ADR 0003](../../docs/adr/0003-workgraph-episodes-drive-the-subagent-seam.md) 持有。

| Package | Role | ctx key |
|---|---|---|
| [`workgraph/`](workgraph/README.md) | 词汇、`workgraph/change` 会话事件、解码/fold、引擎接缝 | `ctx.workGraph` |
| [`workgraph-scheduler/`](workgraph-scheduler/README.md) | tracker 核心：规范化 id、计划门、纯状态机 | 实现 `ctx.workGraph`（执行类 issue） |

[Spec](../../.scratch/workgraph/spec.md) 与 [issues](../../.scratch/workgraph/issues/) 位于 `.scratch/workgraph/`；issue 02–09 依次加入规划器、串行执行与预算、对抗 verifier 与轮次、并行 worktree 批次、发现与重规划、`/graph` 命令面、GUI DAG 视图，以及优化器与跨会话复活。
