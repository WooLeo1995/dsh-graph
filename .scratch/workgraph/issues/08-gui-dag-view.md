# 08 — GUI DAG view

**What to build:** The Web Client view: `packages/client/ui-workgraph` renders the live work graph as a DAG (layered layout, per-node state and progress, dependency edges, the budget line, the pause reason) from the session log's `workgraph/*` events, surviving reload. A node is selectable for its detail (objective, rounds, spend, failure reason); the final node is visually distinct; `blocked` chains render the failure origin. Presentation is a pure function of the logged state, following the workflow-run Chat node and the phase-one graph card as templates.

**Blocked by:** 07 — /graph command surface, rendering, and config

**Status:** resolved

- [x] The view renders the full DAG from session events alone and reconstructs identically after reload.
- [x] Node selection shows objective, rounds, spend, and failure reason; the final node is distinct; blocked chains show their origin.
- [x] Theme tokens drive colors; no full-graph layout beyond the planned node set.

## Resolution

**`packages/client/ui-workgraph`** is a display-only client package (node half + invariant companion + browser half). `workgraph-definition.ts` registers one durable `workgraph` Chat node through `conversationEvents`: `decodeGraphChange` decodes raw `workgraph/change` payloads defensively (foreign/malformed data is null, never a crash; clears decode as tombstones), `isGraphStartChange` recognizes the unique start (the set commit's single `created` history entry — the engine requires exactly one start per context, so one graph folds into one node), `update` replaces the whole snapshot and tombstones on clear, and `buildViewNode` projects `WorkGraphChatData` with deterministic longest-path `layerNodes` (cyclic foreign data degrades to layer 0). The presentation is a pure function of the logged state: replay and live append produce identical output, proven by the fold tests.

**`WorkGraphNode.tsx`** renders the layered DAG: per-layer node cards with ledger-dot states, waiting-on captions, failure origins on failed/blocked cards, achieved rounds badges, a double-bordered final node, the header (objective, status pill, plan version, spend/budget line, discoveries, pause reason), the legend, and a selectable detail pane (objective, spec, rounds, dependencies, discovery origins, failure). Theme tokens (CSS variables with fallbacks) drive all colors. `locales.ts` carries the zh/en copy with the standard namespace registration.

Coverage: 20 client tests green (definition fold + panel + browser plugin) at per-file 100%; the client aggregate typecheck and staged lint are clean.

## Notes

- The definition imports the workgraph domain types so the `workgraph/change` SessionEventMap augmentation reaches the client program (the event union is per-program).
- The view reads only session events — no scheduler provider is required to compose it.
- Issue 09 lands the topology optimizer and the `.dsh/graph.jsonl` project revive.
