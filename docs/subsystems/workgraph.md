# Work graphs

English | [中文](workgraph.zh.md)

The work-graph capability seam: an objective becomes a dependency DAG of autonomous, self-verifying nodes driven by a deterministic scheduler. The [work-graph spec](../../.scratch/workgraph/spec.md) owns the phase-2 contracts; this page records the service face and the durable event scope.

## `ctx.workGraph` service

One engine per context owns the durable work graph of each session. Mutations validate before any session event commits; every transition checkpoints the whole snapshot; a restored graph never resumes as self-driving.

```ts type-equiv
/** Service Definition contract implemented by the scheduler provider. */
interface WorkGraphEngine {
  /** Plan and start a work graph, then drive it to settlement (blocking). */
  set(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>
  /** Validate, commit the pending graph, and drive planning+execution DETACHED. */
  dispatchSet(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>
  /** Read the session's current graph; a fresh session revives the repo projection. */
  status(agent: Agent): Promise<WorkGraphSnapshot | null>
  /** Pause the graph, cancelling the live episode with bounded child settlement. */
  pause(agent: Agent, reason?: string): Promise<WorkGraphSnapshot>
  /** Resume a paused graph, optionally topping up an exhausted token budget (blocking). */
  resume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>
  /** Resume to active and re-drive DETACHED; a pending graph re-plans there. */
  dispatchResume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>
  /** Reset one terminal node and its transitively blocked chain (blocking). */
  retry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>
  /** Reset one terminal node plus its blocked chain and re-drive DETACHED. */
  dispatchRetry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>
  /** Reset every failed node plus its blocked chains as ONE union batch (blocking). */
  retryAll(agent: Agent): Promise<WorkGraphSnapshot>
  /** Reset every failed chain as ONE batch and re-drive DETACHED. */
  dispatchRetryAll(agent: Agent): Promise<WorkGraphSnapshot>
  /** Await the current episode's settlement and return the latest snapshot. */
  settled(agent: Agent): Promise<WorkGraphSnapshot>
  /** Clear the graph, its durable tombstone, and the repo projection. */
  clear(agent: Agent): Promise<void>
}
```

```ts type-equiv
/** Complete durable orchestration state; every change carries it whole. */
interface WorkGraphSnapshot {
  readonly id: WorkGraphId
  readonly objective: string
  readonly status: WorkGraphStatus
  readonly planVersion: number
  readonly nodes: readonly WorkNode[]
  readonly pendingDiscoveries: readonly WorkGraphDiscovery[]
  readonly history: readonly WorkGraphHistoryEntry[]
  readonly tokensSpent: number
  readonly replanRuns: number
}
```

Node states are `waiting | ready | running | achieved | failed | blocked`; graph status is `active | user_paused | infra_paused | blocked | budget_limited | complete`. The harness appends `gn-final`, the fixed whole-objective re-verification gate that depends on every planner node.

## `workgraph/*` event scope

The session log is the source of truth: every accepted transition appends a whole-value `workgraph/change` event (the complete post-transition snapshot, or the clear tombstone), and the live agent-scoped `workgraph/changed` notification mirrors it. The Web Client renders the live DAG as a pure function of these events, surviving reload; the DAG chat node materializes on the set commit — the first change, identified by its creation fact (`createdAt === updatedAt` holds only there, independent of the history cap) — and every later change updates it in place. A fresh session revives the repository projection (`.dsh/graph.jsonl`) sanitized and demoted to paused under an exclusive lock.

### Live activity panel

The floating activity monitor (pattern ported from dsh-agent-teams, MIT) polls the scheduler's snapshot route `GET /plugins/dsh-workgraph/state` (registered lazily on `ctx.webServer`/`ctx.httpServer`, `cache-control: no-store`) and renders the current session's graph: status pill, plan version, spend/budget, discoveries, and the depth-layered DAG with hover-chain highlight and click-to-pin. The route assembles `WorkGraphPanelSnapshot` rows (shared types in `@deepseek-ai/dsh-workgraph`) from each live agent's committed `current()` snapshot; the panel is display-only and never mutates session state.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkgraph--workgraphengine-abstract-seam"></a>

### `ctx.workGraph` — `WorkGraphEngine` (abstract seam)

Work-graph Service Definition contract. One engine per context owns the durable work graph of each session: mutations validate before any session event commits, every transition checkpoints the whole snapshot, and a restored graph never resumes as self-driving.

```ts cordis-catalog
/**
 * Plan and start a work graph for the agent's session, then drive it to
 * settlement (completion, pause, wedge, or budget trip). The returned
 * promise resolves with the settled snapshot, not the pending one — the
 * blocking form of {@link dispatchSet}.
 * @param agent - the agent whose session owns the graph.
 * @param request - the objective and an optional token budget.
 * @returns the settled snapshot.
 */
abstract set(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>

/**
 * Validate, create, and commit a pending work graph, then run planning and
 * the drive DETACHED in the background. Returns as soon as the pending
 * graph is durable — the human command surface uses this so `/graph set`
 * never blocks the command channel for the graph's whole lifetime.
 * Progress is observed through {@link status}, the `workgraph/*` events,
 * and the GUI DAG; {@link pause} still awaits the episode's bounded
 * settlement.
 * @param agent - the agent whose session owns the graph.
 * @param request - the objective and an optional token budget.
 * @returns the durable pending snapshot (planning starts in the background).
 */
abstract dispatchSet(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>

/**
 * Read the session's current work graph. A session with no durable events
 * revives the repository projection (`.dsh/graph.jsonl`) sanitized and
 * demoted to paused; a malformed projection is a loud error.
 * @param agent - the agent whose session owns the graph.
 * @returns the current snapshot, or `null` when none exists.
 */
abstract status(agent: Agent): Promise<WorkGraphSnapshot | null>

/**
 * Pause the graph, cancelling any live episode with bounded child settlement.
 * @param agent - the agent whose session owns the graph.
 * @param reason - human-readable pause cause.
 * @returns the paused snapshot.
 */
abstract pause(agent: Agent, reason?: string): Promise<WorkGraphSnapshot>

/**
 * Resume a paused graph, optionally topping up an exhausted token budget,
 * then drive it to settlement. The blocking form of {@link dispatchResume}.
 * @param agent - the agent whose session owns the graph.
 * @param request - a positive budget top-up from spent-so-far.
 * @returns the settled snapshot.
 */
abstract resume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>

/**
 * Resume a paused, blocked, or budget-limited graph to active and re-drive
 * it DETACHED in the background (a pending graph re-plans there). Returns
 * the durable resumed snapshot immediately; validation refusals (locked
 * projection, plain resume on a budget-limited graph) still throw.
 * @param agent - the agent whose session owns the graph.
 * @param request - an optional positive budget top-up from spent-so-far.
 * @returns the durable resumed snapshot.
 */
abstract dispatchResume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>

/**
 * Reset one terminal node and its transitively blocked chain to re-runnable
 * work; refuses while an upstream dependency is neither achieved nor in the
 * same reset batch. The blocking form of {@link dispatchRetry}.
 * @param agent - the agent whose session owns the graph.
 * @param node - the terminal node to retry.
 * @returns the snapshot after the reset batch.
 */
abstract retry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>

/**
 * Reset one terminal node and its transitively blocked chain, then re-drive
 * the graph DETACHED in the background. Returns the durable reset snapshot
 * immediately.
 * @param agent - the agent whose session owns the graph.
 * @param node - the terminal node to retry.
 * @returns the durable snapshot after the reset batch.
 */
abstract dispatchRetry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>

/**
 * Reset every failed node plus its transitively blocked chain as ONE batch
 * (bare `/graph retry`): a shared final blocked by sibling failures refuses
 * any single-root reset whose other dependency is still failed. The
 * blocking form of {@link dispatchRetryAll}.
 * @param agent - the agent whose session owns the graph.
 * @returns the snapshot after the union reset batch; unchanged when no
 * node is failed.
 */
abstract retryAll(agent: Agent): Promise<WorkGraphSnapshot>

/**
 * Reset every failed node plus its transitively blocked chain as ONE batch
 * and re-drive the graph DETACHED in the background. Returns the durable
 * reset snapshot immediately.
 * @param agent - the agent whose session owns the graph.
 * @returns the durable snapshot after the union reset batch; unchanged when
 * no node is failed.
 */
abstract dispatchRetryAll(agent: Agent): Promise<WorkGraphSnapshot>

/**
 * Await the current episode's settlement (the detached planning+drive chain
 * started by the last dispatch) and return the latest committed snapshot.
 * Throws `WORKGRAPH_NOT_FOUND` when the graph was cleared mid-episode.
 * @param agent - the agent whose session owns the graph.
 * @returns the settled snapshot.
 */
abstract settled(agent: Agent): Promise<WorkGraphSnapshot>

/**
 * Clear the graph and its projection; a cleared graph cannot resurrect.
 * @param agent - the agent whose session owns the graph.
 */
abstract clear(agent: Agent): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/workgraph/workgraph/src/index.ts:35`](../../packages/workgraph/workgraph/src/index.ts)

<a id="workgraph-events"></a>

### `workgraph/*` events

<a id="workgraphchanged--emit"></a>

#### `workgraph/changed` — emit

Work-graph mutation accepted by one live agent. The matching `workgraph/change` session event has already committed. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Work-graph mutation accepted by one live agent. The matching
 * `workgraph/change` session event has already committed. Listener
 * failures are contained. Scope-filtered dispatch
 * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param payload.agent - agent whose session owns the work graph.
 * @param payload.change - fresh current snapshot or clear tombstone.
 * @mode emit
 */
'workgraph/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: WorkGraphChanged }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/workgraph/workgraph/src/domain.ts:88`](../../packages/workgraph/workgraph/src/domain.ts)
<!-- END GENERATED cordis-surface -->
