# 工作图

[English](workgraph.md) | 中文

工作图能力 seam：目标变成由确定性调度器驱动的自主、自验证节点的依赖 DAG。[work-graph spec](../../.scratch/workgraph/spec.md) 持有 phase-2 契约；本页记录服务面与持久事件范围。

## `ctx.workGraph` 服务

每个上下文一个引擎，拥有每个会话的持久工作图。变更在任何会话事件提交前校验；每个转换都检查点整个快照；恢复的图绝不会自我驱动复活。

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

节点状态为 `waiting | ready | running | achieved | failed | blocked`；图状态为 `active | user_paused | infra_paused | blocked | budget_limited | complete`。harness 追加 `gn-final`——依赖每个规划节点的固定全目标复核门。

## `workgraph/*` 事件范围

会话日志是真源：每个被接受的转换追加一条全量 `workgraph/change` 事件（完整的转换后快照或 clear tombstone），活代理范围的 `workgraph/changed` 通知镜像之。Web 客户端作为这些事件的纯函数渲染活 DAG，重载后重建；DAG 聊天节点在 set 提交处物化——首个变更，以创建事实判别（`createdAt === updatedAt` 只在那里成立，与 history cap 无关）——之后每个变更就地更新它。新会话在排他锁下复活仓库投影（`.dsh/graph.jsonl`）并净化降级为暂停。

### 活活动面板

浮动活动监视器（模式移植自 dsh-agent-teams，MIT）轮询调度器的快照路由 `GET /plugins/dsh-workgraph/state`（在 `ctx.webServer`/`ctx.httpServer` 上懒绑定注册，`cache-control: no-store`），渲染当前会话的图：状态胶囊、计划版本、消耗/预算、发现数与按 depth 分层的 DAG，含悬停链高亮与点击固定。路由从每个活跃 agent 已提交的 `current()` 快照装配 `WorkGraphPanelSnapshot` 行（共享类型在 `@deepseek-ai/dsh-workgraph`）；面板只读，绝不改动会话状态。

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
