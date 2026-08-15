# Agent Note: Work graph v9 — topology optimizer and cross-session project revive

Status: implemented

English | [中文](2026-08-14-workgraph-v9-optimizer-project-revive.zh.md)

## Problem

Two closing mechanisms remained. First, the graph ran whatever the planner produced: false dependencies sat in the DAG, tiny and oversized nodes never merged or split, and the only improvement path was the discovery-driven replan. Second, the graph lived entirely in the session log: a teammate in a fresh session could see nothing, and a second session could not be stopped from resuming work the owner was already executing. jxca closes both with the plan-boundary topology optimizer and the repo-root `.dsh/graph.jsonl` projection under an exclusive lock.

## Decision

**The topology optimizer** (`optimizer.ts`) runs at plan boundaries only — after initial planning and piggybacked on every replan boundary, never mid-execution. `maybeOptimize` gates on the `optimizer` toggle, an active graph, and a free slot of the SHARED replan cap; the optimizer child (same spawn seam as planning, own `OPTIMIZER_OUTPUT_SCHEMA`) issues the restricted ops — `remove_dep`, `reorder`, `merge`, `split` — over Waiting/Ready nodes only. `applyOptimization` enforces the per-op rules (pending-only targets, known ids, no self/dupe, `gn-final` never merges/splits/is a merge party, no non-pending dependents, split 2–3 replacements with hygienic slugs and live deps, no dead deps) and the final invariants: the final gate rebuilds over all surviving non-final nodes, pending status re-derives in BOTH directions (a grafted dep demotes a Ready node — a promote-only pass would silently violate ordering at dispatch), non-pending nodes stay byte-identical, and acyclicity plus the node cap re-verify. An applied pass bumps the plan version, consumes the shared replan slot, records `optimized`, and freezes a new baseline; an empty op list is a respected no-op; ANY failure (rejected ops, child error, baseline collision) degrades with a warning — an enhancement pass never pauses a working graph.

**Cross-session revive** (`project.ts`): `.dsh/graph.jsonl` at the repo root projects the orchestration — line 1 the header (the snapshot minus nodes), then one node per line, atomic writes (tmp + rename), line-mergeable via content-hash ids. `set` claims the repository lock (create-exclusive sidecar) BEFORE anything commits — a refused second holder leaves no trace in the session log; every checkpoint commit re-projects while the lock is held (write failures degrade with a warning — the session log is the source of truth); `resume` refuses when another session holds the lock, and the refusal precedes `requireGraph` so a revived graph is refused by the lock, never by NOT_FOUND; a fresh session's `status` revives the projection sanitized and demoted (Running→Ready, Active→user_paused with the restart message); `clear` removes the file and releases the lock; a malformed file is a loud error, never "no graph". The engine's `status` became async to host the revive path. `WORKGRAPH_INVALID_OPTIMIZATION`, `WORKGRAPH_MALFORMED_PROJECTION`, and `WORKGRAPH_LOCKED` join the domain error codes.

## Alternatives considered

**Optimizer only when a replan applied.** Rejected: the resume boundary of a restored graph would never see a pass; jxca fires the optimizer at every replan boundary, and the shared-cap gate already bounds the cost.

**flock-style advisory lock.** Rejected for the node runtime: a create-exclusive sidecar is portable, testable across sessions in one process, and released on clear (a stale file is a loud locked state, matching the "second holder is read-only" contract).

**Keep `status` synchronous with a separate revive entry.** Rejected: every caller would need two paths; the async status makes the revive the single observation surface.

## Consequences

- False dependencies unlock real parallel batches; merge/split reshape the DAG under a shared cap with frozen baselines; every optimizer failure degrades without pausing.
- The graph is team-visible at `.dsh/graph.jsonl` with an exclusive writer; a second session reads it and cannot resume; a fresh session revives sanitized and paused; clear removes the projection and the lock.
- 284 workgraph + 20 client tests green at per-file 100% coverage; host and client typechecks and staged lint clean.
- Phase 2 issues 02–09 are complete; the final self-validation runs the full repository suite.
