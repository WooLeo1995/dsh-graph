# Agent Note: Work graph v2 — planner episode, validation retry, frozen baselines

Status: implemented

English | [中文](2026-08-14-workgraph-v2-planner-episode.zh.md)

## Problem

Issue 01 shipped the deterministic half — vocabulary, tracker, gate, persistence — but nothing could start a graph: `set` needs a planning episode that turns an objective into a validated, durable plan, retries a rejected artifact exactly once with the gate's feedback, pauses infra when planning fails, and freezes each plan version's node set before any node runs. The engine surface (`set`/`status`/`pause`/`resume`/`retry`/`clear`) also needs its first real implementation, because issue 03's serial execution builds on a provider that already owns the session's graph.

## Decision

**The planning episode is a spawn + gate pipeline with an injected seam.** `planner.ts` renders the ported jxca planner contract (2–8 focused nodes, true ordering deps only, outcome-contract specs that preserve the objective's must-have terms verbatim, and an explicit "never write `gn-final`" rule) and runs one attempt end to end: render → spawn → `parsePlanArtifact`. The outcome split is three-way and loud: `planned` (gate passed, final node appended), `invalid` (the precise gate reason, retryable once by the caller), `fail-closed` (child error, missing artifact, or schema-invalid capture — the infra path). A non-domain error from the gate rethrows rather than being papered over. The `PlannerSpawn` seam is injected through the provider config so unit tests script artifacts without a model; the production default calls `ctx.subagents.start('spawn', …)` with the `PLAN_OUTPUT_SCHEMA` capture schema and disposes the run on every path.

**The tracker gains the planning window as real transitions.** `createPendingGraph` commits an active zero-node snapshot with `created` + `planning-started` history (the graph is durable before the planner runs, so a crash mid-planning leaves a resumable, non-self-driving graph). `installPlanIntoGraph` installs the validated node set (roots promoted, `gn-final` last, plan version stays 1) and records `planning-completed`. `pausePlanningFailed` pauses infra with the `planning-failed` history entry. General `pauseGraph`/`resumeGraph` transitions back the engine commands; `resumeGraph` accepts user/infra-paused and blocked, drops the pause reason, and re-activates — a pending graph's caller re-plans.

**Baselines are create-new files under the harness home.** `baselines.ts` freezes each plan version's full node set to `workgraph/baselines/<graphId>/v<N>.json` with `wx` semantics; a re-freeze fails loudly with the new `WORKGRAPH_BASELINE_EXISTS` code, and non-EEXIST failures rethrow (only the domain error pauses the graph). The freeze happens after the install commit and before any node runs — jxca's "audit baseline is an infra failure, not ignorable" — so a freeze failure pauses infra instead of corrupting the session log.

**`WorkGraphScheduler` is the provider with the full engine surface.** `set` validates (empty objective, non-positive budget), refuses a second graph while one is set (including paused), commits the pending graph, runs the episode with exactly one feedback retry, commits the install, and freezes baseline v1. `status` serves the in-process latest snapshot with the session-log fold as the reload/foreign-data path. `pause`/`resume`/`retry`/`clear` operate at tracker level now; episode cancellation, budget top-up, and the project projection land with issues 03 and 09. A reason-less paused snapshot restored from foreign data resumes cleanly (the `withoutPauseReason` early return).

## Alternatives considered

**Persist the plan only on success (no planning-window snapshot).** Rejected: a crash mid-planning would lose the objective, and "resume re-plans" (user story 18) needs a durable graph to resume. The zero-node pending snapshot is honest — the fold accepts it, restore demotes it, and `resume` detects the empty node set and re-plans.

**Keep the one-shot jxca marker contract (planner writes a JSON file).** Rejected per ADR 0003: the structured-output seam already captures a schema-shaped artifact, so the planner reports `{ nodes }` directly and the gate is the single validator; the file-artifact plumbing and its size cap are unnecessary.

**Baselines as session events.** Rejected: baselines are audit artifacts the scheduler owns, not session facts; files under the harness home honor the write isolation (nothing but `.dsh/graph.jsonl` and its lock enters the repo).

## Consequences

- `set` now runs end to end: valid plans install with baseline v1 frozen before any node runs; rejected plans retry exactly once with feedback and pause infra on the second failure; `resume` re-plans a pending graph.
- The provider's live view is the latest committed snapshot, with the fold as the reload path; every transition still funnels through `commitWorkGraphChange` (durable log and live stream cannot diverge).
- 104 vitest tests green (39 new), per-file 100% on the scheduler sources; lint clean. The `plannerSpawn` seam keeps tests model-free; real-stack keyless integration (llm-mock-server) starts with issue 03.
- `WORKGRAPH_BASELINE_EXISTS` joins the stable error-code union; `pauseGraph`/`resumeGraph` are the general transitions issues 07 (command surface) and 09 (revive) build on.
