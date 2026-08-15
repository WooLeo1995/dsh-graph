# workgraph/ — deterministic work-graph capability family

English | [中文](README.zh.md)

This family turns one objective into a dependency DAG of autonomous, self-verifying agent work driven by a deterministic scheduler. Contracts are transplanted from jxca-cli's `/graph` with file:line provenance in the phase-two design note (`.scratch/research/2026-08-14-graph-dag-phase2-design.zh.md`); [ADR 0003](../../docs/adr/0003-workgraph-episodes-drive-the-subagent-seam.md) owns the seam decision.

| Package | Role | ctx key |
|---|---|---|
| [`workgraph/`](workgraph/README.md) | Vocabulary, `workgraph/change` session event, decode/fold, and the engine seam | `ctx.workGraph` |
| [`workgraph-scheduler/`](workgraph-scheduler/README.md) | Tracker core: canonical ids, plan gate, pure state machine | implements `ctx.workGraph` (execution issues) |

The [spec](../../.scratch/workgraph/spec.md) and [issues](../../.scratch/workgraph/issues/) live under `.scratch/workgraph/`; issues 02–09 add the planner, serial execution and budget, the adversarial verifier and rounds, parallel worktree batches, discovery and replan, the `/graph` command surface, the GUI DAG view, and the optimizer with cross-session revive.
