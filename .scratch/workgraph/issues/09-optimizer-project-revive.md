# 09 — topology optimizer and cross-session project revive

**What to build:** Two closing mechanisms. The topology optimizer runs at plan boundaries only (after initial planning, then piggybacked on replan boundaries), never mid-execution: an optimizer child issues restricted edit ops (`remove_dep`, `reorder`, `merge`, `split`) over pending nodes only; `gn-final` cannot merge, split, or be a merge party; post-op invariants re-derive pending status in both directions, rebuild the final gate, keep non-pending nodes identical, and re-verify acyclicity and size; the applied pass bumps the plan version, consumes a shared replan-cap slot, and freezes a new baseline; an empty op list is a respected no-op; any failure degrades with a warning. Cross-session revive: `.dsh/graph.jsonl` at the repo root (header minus nodes, then one node per line, atomic writes) with an exclusive sidecar lock held for the graph's lifetime; a second holder gets read-only status and refused resume; a fresh session revives the graph sanitized and demoted to paused; clear removes the file and releases the lock; a malformed file is a loud error.

**Blocked by:** 06 — discovery and capped replan

**Status:** resolved

- [x] A false dependency removed by the optimizer unlocks a real parallel batch (held-reply gate proves it); plan version bumps; the shared cap slot is consumed; disabled or cap-exhausted states never spawn a pass.
- [x] Every restricted op upholds its invariants: merge/split rewiring, final-gate rebuild, bidirectional status re-derivation, non-pending nodes byte-identical.
- [x] The project file round-trips the orchestration; the lock is exclusive across sessions; revive demotes to paused with Running→Ready; a foreign or malformed projection never clobbers silently; clear removes file and lock.

## Resolution

**The topology optimizer** (`optimizer.ts`) runs at plan boundaries only — after initial planning and piggybacked on every replan boundary, never mid-execution: `maybeOptimize` (scheduler) gates on the `optimizer` toggle, an active graph, and a free slot of the SHARED replan cap; the optimizer child (same spawn seam as planning, own `OPTIMIZER_OUTPUT_SCHEMA`) issues the restricted ops (`remove_dep`, `reorder`, `merge`, `split`) over Waiting/Ready nodes only. `applyOptimization` enforces the per-op rules (pending-only targets, known ids, no self/dupe, `gn-final` never merges/splits/is a merge party, no non-pending dependents, split 2–3 replacements with hygienic slugs and live deps) and the final invariants: the final gate rebuilds over all surviving non-final nodes, pending status re-derives in BOTH directions (a grafted dep demotes a Ready node — a promote-only pass would silently violate ordering), non-pending nodes stay byte-identical, and acyclicity plus the node cap re-verify. An applied pass bumps the plan version, consumes the shared slot, records `optimized`, and freezes a new baseline; an empty op list is a respected no-op; ANY failure (rejected ops, child error, baseline collision) degrades with a warning — an enhancement pass never pauses a working graph.

**Cross-session revive** (`project.ts`): `.dsh/graph.jsonl` at the repo root projects the orchestration — line 1 the header (snapshot minus nodes), then one node per line, atomic writes (tmp + rename), line-mergeable via content-hash ids. `set` claims the repository lock (create-exclusive sidecar) BEFORE anything commits — a refused second holder leaves no trace; every checkpoint commit re-projects while the lock is held (write failures degrade with a warning — the session log is the source of truth); `resume` refuses when another session holds the lock (the refusal precedes `requireGraph`, so a revived graph is refused by the lock, never NOT_FOUND); a fresh session's `status` revives the projection sanitized and demoted (Running→Ready, Active→user_paused with the restart message); `clear` removes the file and releases the lock; a malformed file is a loud error, never "no graph". The engine's `status` became async to host the revive path.

Coverage: 284 workgraph + 20 client tests green (14 optimizer + 12 project + wiring) at per-file 100%; host and client typechecks and staged lint clean.

## Notes

- The optimizer fires once after planning and once per boundary (jxca semantics), gated on the toggle/cap/status; the shared cap means optimizer and replan passes draw from the same budget.
- `WORKGRAPH_INVALID_OPTIMIZATION`, `WORKGRAPH_MALFORMED_PROJECTION`, and `WORKGRAPH_LOCKED` join the domain error codes.
- Phase 2 issues 02–09 are complete; the final self-validation runs the full repository suite.
