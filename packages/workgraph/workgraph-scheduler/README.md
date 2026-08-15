# `@deepseek-ai/dsh-workgraph-scheduler`

English | [中文](README.zh.md)

The deterministic tracker core of the work-graph scheduler: canonical node identity, the plan static gate, and the pure snapshot state machine. Every function is pure over an immutable `WorkGraphSnapshot`, throws `WORKGRAPH_INVALID_TRANSITION` on illegal moves, and takes transition timestamps explicitly — the tracker never reads the clock. The Cordis provider that drives episodes through the subagent seam lands with the execution issues (see the [work-graph spec](../../../.scratch/workgraph/spec.md)); this package ships the deterministic half first so the transition table is exhaustively testable without a model.

## Canonical ids

`canonicalNodeId(slug)` mints `gn-` plus the slug's FNV-1a 32-bit hash as eight lowercase hex characters — stable across processes, so projections are line-mergeable. `FINAL_NODE_ID` (`gn-final`) is the fixed, non-hash identity of the harness-appended final node.

## Plan gate

`parsePlanArtifact` validates the raw planner artifact (the model JSON boundary) in a fixed order, each rejection naming its precise reason: artifact shape; non-empty node list; per-row shape with dependency dedupe; the node cap; slug hygiene (1–64 of `[A-Za-z0-9_-]`); slug uniqueness; non-empty title and spec after trim; no self or unknown dependencies; planner-order-stable Kahn acyclicity (the first `ready` node in storage order inherits planner intent, and a cycle strands its members); and canonical-id collision between distinct slugs. `installPlan` canonicalizes ids, rewrites `blocks` edges, keeps every node `waiting` in topological order, rejects slugs that canonicalize onto the reserved final id, and appends the final node gated over every planner node with the fixed whole-objective verification spec.

## State machine

`createPendingGraph` commits the durable planning-window snapshot (zero nodes, `created` + `planning-started` history) so a crash mid-planning leaves a resumable graph. `installPlanIntoGraph` installs the validated node set (roots promoted, plan version stays 1) and records `planning-completed`. `initializeGraph` creates the active snapshot with promoted roots. `markRunning` starts a ready node (recording the worker child session). `settleAchieved` settles a running node, promotes dependents, and completes the graph when every node including the final node is achieved. `settleFailed` fails a running node, marks every non-achieved transitive dependent blocked with the chain attributed to the original failure, and wedges the graph (status `blocked`, retry hint) when nothing is runnable. `pauseGraph` pauses an active graph user- or infra-; `pausePlanningFailed` records the `planning-failed` history entry; `resumeGraph` re-activates a paused or blocked graph, dropping the pause reason. `retryNodes` resets one terminal node plus its transitively blocked chain — rounds retained for audit, failure and worker session cleared — refusing while an upstream dependency is neither achieved nor in the batch, and unblocking a blocked graph. `restoreSnapshot` demotes running nodes to ready and an active graph to user-paused (`RESTORE_PAUSE_REASON`), so a restored snapshot never resurrects as self-driving. `appendHistory` caps the history by dropping the oldest first.

## Planning episode

`renderPlannerPrompt`/`runPlannerEpisode` run the planning attempt (render → spawn → `parsePlanArtifact`) with the injected `PlannerSpawn` seam and the `PLAN_OUTPUT_SCHEMA` capture schema: `planned` (gate passed), `invalid` (precise gate reason, retryable once), `fail-closed` (child error or missing artifact — infra). `createBaselineStore` freezes each plan version's full node set under the harness home with create-new semantics (`WORKGRAPH_BASELINE_EXISTS` on a re-freeze).

## Worker rounds and adversarial verification

`worker.ts` renders the worker contract (position, spec, graph objective, complete-only-this-scope, discovered-work, prior gaps) and parses the structured report (`{ status: done | blocked, summary, discovered }`): a missing or malformed report is unparseable and fails the node fail-closed, an errored child fails closed, and the summary is schema data so it cannot spoof the status. After a `done` report, `verifier.ts` runs the adversarial skeptic (read-only deny-list tool filter, `bash` kept so the decisive checks re-run): `achieved` settles the node; `not_achieved` iterates the SAME worker child through the continuation transport (`continuation.ts` — `startContinuable` round 1, `followup` rounds 2+ on the same durable child, each round awaited through its `subagent/end` epoch edge, the report travelling as the strict `REPORT:` JSON envelope) with exactly the named gaps, bounded by the `nodeRounds` cap — exhaustion fails the node naming the last gaps; an errored or gap-less rejection never passes. `serial.ts` drives the graph deterministically — per Ready node in storage order — gating dispatch on the budget and demoting in-flight nodes on an interrupted episode (pause/clear) via the authoritative snapshot.

## Budget

`usage.ts` folds the child sessions' durable `assistant/message` usage records keyed by the child session ids the scheduler started. `set` accepts a token budget only with usage-recording evidence (parent log, or the first child's record — otherwise infra pause, fail loud). A crossing settlement trips `budget_limited`, demoting other running nodes to Ready (a resource stop, never a verdict); spent-so-far is always charged, failed nodes included; `resumeGraph` takes a top-up from spent-so-far and a plain resume on `budget_limited` refuses with the hint.

## Provider

`WorkGraphScheduler` implements the full `ctx.workGraph` engine surface: `set` plans, installs, freezes baseline v1, and drives the episode (one feedback retry, infra pause on planning failure); `status` reads the latest committed snapshot with the session-log fold as the reload path; `pause`/`resume`/`retry`/`clear` operate at tracker level and resume/retry drive; `resume` re-plans a pending graph. Parallel batches and worktree isolation land with issue 05; the discovery replan pass lands with issue 06.

## Configuration

The provider declares a validated cordis `Config` schema (`config.ts`): deployments tune the graph from cordis.yml instead of code. Every field resolves to its spec default and an out-of-range value fails plugin load loudly. concurrency (default 3, clamp 1–8), nodeRounds (3, 1–8), replanCap (3, 0–10), optimizer (on — consumed at plan boundaries with issue 09), maxNodes (24), historyMax (64), planBytesMax (256 KiB — the plan gate rejects larger artifacts), and childAwaitBudget (600 s, clamp 1–3600 — the bounded child-settlement wait `pause` honors before returning). Direct construction resolves the same defaults and fails loudly on out-of-range values; an explicit `limits` seam still overrides the tunable defaults.


## Parallel batches and worktree isolation

When more than one node is Ready and the concurrency cap exceeds 1, `parallel.ts` takes a batch and runs each node as an independent worker/verifier pair in its own git worktree minted under the harness home (`worktrees.ts`: detached checkout at the fan-out HEAD, changed set from git plumbing including untracked files, 3-way byte merge per file — base==ours takes theirs, ours==theirs is already present, else the node fails naming the file — and a HEAD guard that fails the node loudly if the main HEAD moved). Merge-back runs sequentially in batch order; a conflict fails only that node (siblings continue, dependents block, a wedge blocks the graph), merged worktrees are removed best-effort, failed nodes keep theirs for postmortem. The workspace override is capability-gated in the subagent seam (`SubagentStartRequest.workspace` + `SubagentCapabilities.workspace`): an incapable provider or a non-git repo degrades to serial exactly like jxca's non-git clamp. The runnable set is re-read from the authoritative snapshot after each boundary hook, so a re-gated Ready final is never dispatched stale.

## Discovery replan

`replan.ts` owns the pass: at episode boundaries `maybeReplan` (scheduler) folds pending `discovered` entries (from worker and verifier reports) into the graph through a replanner child on the same spawn seam as planning, with one feedback retry. Pre-gates: no entries → no-op; zero remaining budget → entries stay queued (a `resume --budget` top-up re-enters the pass); `gn-final` achieved → advisory drain to history; `replanCap` 0 or exhausted → quiet drain with the graph converging on the current plan. `validateAppendix` enforces the appendix row rules in fixed order (shape, slug hygiene, uniqueness, non-empty prose, string deps, no self-deps; deps may reference existing live nodes, resolved by `replanDependencyGuard` — never the reserved final, never a non-live node); `installReplan` appends in planner order, re-gates `gn-final` over the additions (a Ready final demotes to waiting; an empty appendix that leaves every dep achieved re-promotes so the terminal gate is never stranded), bumps the plan version, clears the entries, and freezes the new baseline (v1 immutable). An empty appendix is a respected answer that consumes the slot; an invalid outcome retries once with the precise reason, then degrades — entries drain, the slot is consumed, the graph keeps running, never a pause.

## Topology optimizer

`optimizer.ts` runs a plan-boundary review pass — after initial planning and piggybacked on every replan boundary, never mid-execution: `maybeOptimize` gates on the `optimizer` toggle, an active graph, and a free slot of the SHARED replan cap. The optimizer child (same spawn seam as planning, own `OPTIMIZER_OUTPUT_SCHEMA`) issues the restricted ops — `remove_dep`, `reorder`, `merge`, `split` — over Waiting/Ready nodes only; `applyOptimization` enforces the per-op rules (pending-only targets, known ids, no self/dupe, `gn-final` never merges/splits/is a merge party, no non-pending dependents, split 2–3 replacements with hygienic slugs and live deps) and the final invariants: the final gate rebuilds over all surviving non-final nodes, pending status re-derives in both directions (a grafted dep demotes a Ready node), non-pending nodes stay byte-identical, and acyclicity plus the node cap re-verify. An applied pass bumps the plan version, consumes the shared slot, records `optimized`, and freezes a new baseline; an empty op list is a respected no-op; ANY failure degrades with a warning — an enhancement pass never pauses a working graph.

## Cross-session project revive

`project.ts` projects the orchestration to `.dsh/graph.jsonl` at the repo root (line 1 the header minus nodes, then one node per line, atomic writes, line-mergeable via content-hash ids). `set` claims the repository lock (create-exclusive sidecar) BEFORE anything commits — a refused second holder leaves no trace; every checkpoint commit re-projects while the lock is held (write failures degrade with a warning — the session log is the source of truth); `resume` refuses when another session holds the lock (the refusal precedes `requireGraph`); a fresh session's `status` revives the projection sanitized and demoted (Running→Ready, Active→user_paused with the restart message); `clear` removes the file and releases the lock; a malformed file is a loud error, never "no graph".

## Model Experience

Indirectly, through the planner child's structured-output spawn: the provider renders the planning contract (`prompts.ts`) the planner child receives and captures its plan through the `PLAN_OUTPUT_SCHEMA` seam.

#### KV Cache effect

No direct effect. A model request touching graph state first passes through the scheduler provider, which owns any resulting prefix change.


## Known Limitations and Deferred Work

- **Envelope transport** — the continuation manager's composition does not carry the structured capture into later rounds, so the worker's report travels as the strict `REPORT:` JSON envelope in its final output; a real-stack integration of the capture setup is deferred with the llm-mock-server work.
- **Verifying is display-only** — the live verifier-in-flight badge stays out of the durable vocabulary until the execution issues define its rendering.
