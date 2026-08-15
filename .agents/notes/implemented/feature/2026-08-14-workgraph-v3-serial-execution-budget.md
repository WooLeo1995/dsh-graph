# Agent Note: Work graph v3 — serial execution, budget cascade, usage charging

Status: implemented

English | [中文](2026-08-14-workgraph-v3-serial-execution-budget.zh.md)

## Problem

Issue 02 left the graph installed with ready roots and nothing to run them. The serial episode had to turn a `done`/`blocked` worker report into a tracker settlement, charge each child's real token usage into the graph budget, and keep the pause/clear semantics honest — an interrupted episode is a resource stop, never a verdict. The budget also had to fail loud when a composition cannot record usage at all.

## Decision

**The worker episode is a spawn + report pipeline with an injected seam.** `worker.ts` renders the ported jxca worker contract (position line, node spec, the whole graph objective, complete-only-this-scope, the discovered-work contract, and the prior-round gaps section that issue 04 will fill) and parses the structured report `{ status: done | blocked, summary, discovered }` against the `WORKER_OUTPUT_SCHEMA` capture schema. The report replaces jxca's line-anchored `NODE_RESULT:` marker, so the summary is schema-field data and cannot spoof the status; a missing or malformed report is unparseable and fails the node fail-closed, and an errored child fails closed. The `workerSpawn` config seam scripts reports without a model; the production default calls `ctx.subagents.start('spawn', …)` and exposes `run.id` as the child session id for usage charging.

**The serial drive is deterministic and checkpoint-everything.** `serial.ts` loops over Ready nodes in storage order — spawn, markRunning (with the child session id durably recorded), settle from the parsed report with the child's token charge, queue reported discoveries for the replan boundary — gating dispatch on the budget and stopping on completion, wedge, budget trip, or interruption. Pause/clear semantics are honest by construction: the abort signal is checked before the markRunning commit (the paused snapshot stands as-is), after the usage read (the node demotes on the authoritative snapshot), and the provider's latest committed view is authoritative when the drive returns — a mid-episode pause can never be clobbered by the drive's local chain. A spawn transport failure propagates when no pause intervened, and demotes the in-flight node when one did.

**The budget is charged from the children's durable usage records.** `usage.ts` folds the child sessions' `assistant/message` usage events keyed by the child session ids the scheduler started (input + output + cache reads/writes). `settleAchieved`/`settleFailed` take an optional token charge: spent-so-far is always charged (failed nodes included), a crossing settlement trips `budget_limited` and demotes other running nodes to Ready (a resource stop, never a verdict), the wedge pause loses to the budget stop, and a completed graph wins over a trip. The dispatch gate trips at zero remaining (defensive: foreign restored data can fold into an at-zero active graph). `resumeGraph` takes an optional top-up from spent-so-far — the only way out of `budget_limited`; a plain resume refuses with the hint. A budget configured in a composition with no usage-recording evidence fails loud: at `set` when the parent log shows messages without usage, or infra-paused at the first child (node demoted, resume re-runs) when the parent had no evidence either way.

## Alternatives considered

**Charge the budget only at node boundaries without per-child reads.** Rejected: the spec's accounting is per-child from the durable usage records, so the charge reflects what the composition's adapters actually reported — and the `recorded` flag is what makes a silent no-usage composition fail loud instead of "spending" nothing.

**Let the drive return its local chain.** Rejected: a pause landing mid-episode would then return an active snapshot that clobbers the committed `user_paused` (found by the mid-node tests). The provider's latest committed view is authoritative; the drive reconciles through it.

**Treat an aborted worker as a failed node.** Rejected: an interrupted episode is a resource stop, never a verdict — the in-flight node demotes to Ready (matching the restore semantics) and resume re-runs it through the verifier-gated path.

## Consequences

- `set`/`resume`/`retry` now drive the graph serially to completion, pause, wedge, or budget stop; every transition checkpoints through the commit funnel.
- 138 vitest tests green (34 new) at per-file 100% coverage: serial order and prompt contract, blocked/unparseable/fail-closed settlements, discovery queueing, mid-node pause demotion on the authoritative snapshot (spawn-throw and usage-read races), budget trips at settle and dispatch, top-up resume, and no-recording fail-loud at set and first child.
- The worker prompt carries the gaps section from day one; issue 04 fills it with verifier rejections and adds the adversarial check between `done` and achievement.
- Issue 05 reuses the worker mechanics for parallel batches; serial nodes stay in the main workspace (jxca's G0/G1 split).
