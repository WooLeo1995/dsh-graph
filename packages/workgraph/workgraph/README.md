# `@deepseek-ai/dsh-workgraph`

English | [中文](README.zh.md)

The work-graph Service Definition: durable DAG vocabulary over agent work, the `workgraph/change` session event, the strict decode/fold of that event, and the abstract `ctx.workGraph` engine seam a scheduler provider implements. Issue 01 of the [work-graph spec](../../../.scratch/workgraph/spec.md) ships this package plus the tracker core in `dsh-workgraph-scheduler`; episodic execution (planner, workers, verifiers) lands with the later issues.

## Vocabulary

`WorkGraphSnapshot` is the complete durable orchestration state; every change carries it whole (the whole-value rule), so the replay fold is last-wins after strict decode. Nodes hold canonical `gn-` ids, `blocks` edges, a six-state lifecycle (`waiting`, `ready`, `running`, `achieved`, `failed`, `blocked`; `verifying` is display-only and never persists), settled round counts, and optional failure, worker-session, and discovery provenance fields. Graph status is `active`, `user_paused`, `infra_paused`, `blocked`, `budget_limited`, or `complete`; a capped history with an `unknown` sink records every transition kind.

## Session event

`workgraph/change` carries a whole snapshot or a clear tombstone. The decoder is strict: another value kind decodes to `undefined`; a malformed or unsupported-version change fails replay loudly; an unknown persisted node state restores as `ready` (restored work is re-runnable, never silently done or stuck); an unknown history kind decodes as `unknown` with the raw kind retained in the entry detail; blocks and provenance edges must resolve within the node set. `foldWorkGraph(events)` reconstructs the current graph and validates identity and monotonicity continuity across changes.

## Engine seam

`ctx.workGraph` is one abstract engine per context. `set` plans and starts a graph, `status` reads it, `pause` cancels the live episode with bounded child settlement, `resume` continues (optionally topping up a token budget from spent-so-far), `retry` resets one terminal node plus its transitively blocked chain (refusing while an upstream dependency is neither achieved nor in the same batch), and `clear` removes the graph and its projection. `dsh-workgraph-scheduler` is the provider; its tracker core ships now and its episode execution arrives with the execution issues.

## Events

`workgraph/changed` (emit, agent-scoped) fires after the matching session event commits, carrying the fresh snapshot or clear tombstone. Listener failures are contained; the payload never exposes graph control.

## Extension points

Implement `WorkGraphEngine` to provide the scheduler; listen on `workgraph/changed` for UI projections; fold `workgraph/change` from the session log to rebuild durable state.

## Model Experience

None, as the Service Definition contributes no prompt, tool, or model-visible input; worker and verifier prompts are owned by the scheduler provider and its consumers.

#### KV Cache effect

No direct effect. Graph state reaches a model only through the scheduler's worker and verifier prompts, which that provider owns.

## Known Limitations and Deferred Work

- **Provider mid-flight** — `dsh-workgraph-scheduler` ships `set` (planning episode, frozen baselines) plus tracker-level `status`/`pause`/`resume`/`retry`/`clear`; serial and parallel node episodes land with issues 03–05.
- **No projection key** — a `SessionProjectionMap` entry for the work graph is deferred to the GUI issue, which is its first consumer.
- **No stream invariant** — a goal-style committed-stream invariant package is deferred until episodes write changes outside tests.
