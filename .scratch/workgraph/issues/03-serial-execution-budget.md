# 03 — serial node execution and budget cascade

**What to build:** The execution episode for the serial path: one Ready node at a time runs as a fresh worker subagent through `ctx.subagents` (spawn, prompt built from the node objective: position, title, spec, graph objective, complete-only-this-scope, discovered-work contract; later verifier gaps appended when present). The worker's structured report (`{ status: done | blocked, summary, discovered }`) settles the node: `done` records the summary and advances; `blocked` fails the node with the reason and runs block_dependents; a missing/invalid report is unparseable and fails the node fail-closed. Optional token budget: accumulate per-child usage from the child sessions' durable usage records keyed by the child session ids the scheduler started; a composition without usage recording rejects a configured budget at `set`; dispatch gates at zero remaining, demoting in-flight nodes to Ready (a resource stop, not a verdict); spent-so-far is always charged including failed nodes; top-up sets budget to spent-plus-extra; plain resume on `budget_limited` refuses with the hint. Every transition checkpoints.

**Blocked by:** 02 — planner episode: structured plan, validation retry, frozen baselines

**Status:** resolved

- [x] A diamond-unfriendly chain (a→b→c plus final) executes serially in dependency order with checkpoints at every transition.
- [x] `done` advances the graph; `blocked` fails the node and blocks dependents; an unparseable report fails the node fail-closed.
- [x] Budget: node dispatch is armed with the remaining share; a trip demotes in-flight to Ready without a verdict; failed nodes still charge; `resume --budget N` resumes to completion (spent N₁ + extra N ⇒ budget N₁+N, remaining N).
- [x] A configured budget in a composition without usage recording fails loud at `set`.

## Resolution

`dsh-workgraph-scheduler` gains the serial episode: `worker.ts` renders the ported worker contract (position line, node spec, graph objective, complete-only-this-scope, discovered-work contract, prior gaps) and parses the structured report `{ status: done | blocked, summary, discovered }` (the `WORKER_OUTPUT_SCHEMA` capture schema; missing/malformed → unparseable → node fails fail-closed; an errored child fails closed; the summary is schema data, so it cannot spoof the status). `serial.ts` drives the graph deterministically: per Ready node in storage order — spawn (child session id recorded in the durable node), markRunning, settle from the parsed report with the child's token charge, queue reported discoveries; the budget gates dispatch at zero remaining and trips `budget_limited` on a crossing settlement, demoting other running nodes to Ready (a resource stop, never a verdict). An interrupted episode (pause/clear) demotes the in-flight node on the authoritative snapshot — the pause is never clobbered, and a spawn transport failure propagates when no pause intervened. `usage.ts` folds the child sessions' durable `assistant/message` usage records keyed by the child session ids the scheduler started; a budget configured in a composition whose log carries no usage evidence fails loud at `set` (parent-log check) or pauses infra at the first child. `budgetLimit`, `demoteRunningToReady`, `queueDiscoveries` join the tracker, and `settleAchieved`/`settleFailed` take an optional token charge (trips demote siblings, wedge loses to the budget stop, completed graphs win over trips); `resumeGraph` takes an optional top-up from spent-so-far, and a plain resume on `budget_limited` refuses with the top-up hint. `set`/`resume`/`retry` drive the serial episode and return the provider's authoritative latest view.

Coverage: 138 vitest tests green (34 new) at per-file 100% — the serial order/prompt contract, blocked/unparseable/fail-closed settlements, discovery queueing, mid-node pause demotion on the authoritative snapshot (including spawn-throw and usage-read races), budget trips at settle and dispatch, top-up resume, no-recording fail-loud at set and first child, and the new tracker transitions with their illegal moves. Lint clean.

## Notes

- The worker spawn default uses `ctx.subagents.start('spawn', …)` with the capture schema and exposes `run.id` as the child session id; the `workerSpawn`/`readChildUsage` config seams script reports and charges without a model. Real-stack keyless integration (llm-mock-server) is scheduled with issue 04's verifier rounds.
- Serial nodes work in the main workspace (no worktree) — isolation lands with issue 05's parallel batches, exactly like jxca's G0/G1 split.
- Issue 04 adds the adversarial verifier between the worker's `done` and the node's achievement; the gaps contract is already in the worker prompt.
