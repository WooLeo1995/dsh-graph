# 02 — planner episode: structured plan, validation retry, frozen baselines

**What to build:** The planning episode: a spawn subagent produces `{ nodes: [{ id, title, spec, deps }] }` through structured output from the planner prompt (objective plus feedback context); the artifact passes the issue-01 gate or is retried exactly once with the validation feedback embedded; a second invalid artifact pauses the graph `infra_paused` with the resume/clear guidance, and resume re-plans. Each plan version's full node set is frozen to a baseline that can never be overwritten (create-new semantics) before execution begins. The planner is told not to write `gn-final`; the harness owns it.

**Blocked by:** 01 — Service Definition, deterministic tracker, plan gate, persistence

**Status:** resolved

- [x] A valid plan installs: nodes Waiting in topological (planner-order-stable) order, `gn-final` appended, baseline v1 frozen before any node runs.
- [x] An invalid plan retries exactly once with the precise validation reason in the feedback; a second failure pauses `infra_paused`; resume re-plans and launches.
- [x] A frozen baseline for version N is never overwritten by a later write; re-freezing the same version fails loudly.
- [x] A missing or schema-invalid structured artifact is fail-closed (infra pause path), never a partial install.

## Resolution

The planning episode ships in `dsh-workgraph-scheduler`: `prompts.ts` renders the ported planner contract (2–8 focused nodes, true ordering deps only, outcome-contract specs preserving the objective's must-have terms verbatim, no `gn-final` — the harness owns it) over the structured-output seam; `planner.ts` runs one attempt end to end (render → spawn → `parsePlanArtifact` gate) with the injected `PlannerSpawn` seam, the `PLAN_OUTPUT_SCHEMA` capture schema, and a three-way outcome split — `planned` (gate passed), `invalid` (precise gate reason, retryable once), `fail-closed` (child error or missing artifact — infra). `baselines.ts` freezes each plan version's full node set under the harness home (`workgraph/baselines/<graphId>/v<N>.json`) with create-new `wx` semantics; re-freezing fails loudly with the new `WORKGRAPH_BASELINE_EXISTS` code. The tracker gains the planning-window transitions: `createPendingGraph` (active, zero nodes, `created` + `planning-started` history), `installPlanIntoGraph` (install + `planning-completed`, roots promoted, plan version stays 1), `pausePlanningFailed` (infra pause + `planning-failed`), plus the general `pauseGraph`/`resumeGraph` transitions the engine commands use. `WorkGraphScheduler` (the Cordis provider) implements `set` end to end — objective/budget validation, `WORKGRAPH_ALREADY_EXISTS` gate, pending-graph commit, one feedback retry, install commit, baseline v1 frozen before any node runs (freeze failure is an infra pause, never ignorable) — plus tracker-level `status`/`pause`/`resume`/`retry`/`clear`; `resume` on a pending graph re-plans. The live view is the in-process latest snapshot, with the session-log fold as the reload/foreign-data path (a reason-less paused snapshot folds in and resumes cleanly).

Coverage: 104 vitest tests green (39 new) with per-file 100% on the scheduler sources — planner episode outcomes and prompt rendering, baseline create-new/failure paths, the provider's set/retry/pause/resume/clear matrix including the fold-path seeds, and the new tracker transitions with their illegal moves. Lint clean.

## Notes

- The default spawn uses `ctx.subagents.start('spawn', …)` with the capture schema; the `plannerSpawn` config seam scripts artifacts without a model. Real-stack keyless integration lands with issue 03's llm-mock-server work.
- The baseline freeze happens after the install commit; a freeze failure pauses infra rather than corrupting the session log, matching jxca's "audit baseline is an infra failure, not ignorable".
- Issue 03 implements the serial episode over this provider; `resume` re-planning shares `planAndInstall` with `set`.
