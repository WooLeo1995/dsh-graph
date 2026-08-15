# @deepseek-ai/dsh-client-ui-workgraph

English | [中文](README.zh.md)

The live work-graph DAG view for the Web Client. The browser half registers one durable `workgraph` Chat node (through [`ctx.conversationEvents`](../../../packages/client/runtime/README.md) and the [`conversation.chat.node`](../ui-conversation/README.md) seat) that folds the session log's `workgraph/change` whole-value events into one keyed node per graph, so a reload reconstructs the identical view. The node renders the layered DAG (longest-path layering, stable per layer), state-colored node cards with dependency waits and failure origins, the budget line, the pause reason, pending discoveries, node selection detail, a visually distinct final node, and the glyph legend.

## Definition

`workgraph-definition.ts` owns the pure fold:

- `decodeGraphChange` decodes one raw `workgraph/change` payload defensively — foreign or malformed data is `null`, never a crash; clear tombstones decode to `{ cleared, graphId }`.
- `isGraphStartChange` recognizes the unique start of a graph: the set commit carries exactly one `created` history entry. The conversation engine requires exactly one `start` match per context, so the whole lifecycle folds into one node per graph identity.
- `layerNodes` computes longest-path layers deterministically (stable by construction order; cyclic foreign data degrades every member to layer 0 rather than looping).
- `buildViewNode` projects the latest snapshot into `WorkGraphChatData` (layers, status, budget, discoveries, pause reason) — a pure function of the logged state.

## WorkGraphNode

The keyed chat renderer (`WorkGraphNode.tsx`): per-layer node cards with the ledger dot state (`done`/`ongoing`/`warning`/`error`), the waiting-on caption for unblocked deps, the failure origin on failed/blocked cards, the achieved rounds badge, the final node double-bordered and labeled, the header (objective, status pill, plan version, spend and budget, discoveries, pause reason), the legend, and a selectable detail pane (objective, spec, rounds, dependencies, discovery origins, failure). Theme tokens drive all colors.

## Composition

The producer injects `conversationEvents`, `slots`, and `locale`. A custom app mounts their owners plus this plugin; the view is display-only and works from session events alone (no scheduler provider required):

```yaml
- id: conversationEvents
  name: '@deepseek-ai/dsh-client-runtime'
- id: ui-workgraph
  name: '@deepseek-ai/dsh-client-ui-workgraph'
```

## Model Experience

### Live work-graph DAG view

#### What the model sees

The rendered DAG, node details, and copy are absent from model requests. The view reads only the durable `workgraph/change` session events; it performs no model-visible mutation.

#### Token effect

Rendering the DAG adds no model tokens. The graph's worker/verifier children spend their own tokens, shown as the graph's spend/budget line.

#### KV Cache effect

View rendering does not affect the cache; the graph's children use their own fresh sessions.

## Known Limitations and Deferred Work

- **No graph controls** — the view is display-only; `/graph` commands (issue 07) own pause/resume/retry/clear.
- **Edges are captions, not paths** — the layered rows show waits and connectors as card captions; full box-drawing edge routing stays with the terminal renderer.
