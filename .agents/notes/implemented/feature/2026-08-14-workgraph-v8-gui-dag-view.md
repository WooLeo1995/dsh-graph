# Agent Note: Work graph v8 — Web Client live DAG view

Status: implemented

English | [中文](2026-08-14-workgraph-v8-gui-dag-view.zh.md)

## Problem

Through issue 07 the graph had a command surface but no live picture: `/graph status` prints a tree on demand, yet nobody could watch the DAG evolve, inspect a node's failure, or see the budget line while the graph ran. The Web Client already renders durable workflow-run and goal nodes from session events; the work graph needed the same treatment — a display-only view that reconstructs identically after reload because it is a pure function of the logged state.

## Decision

**`packages/client/ui-workgraph` ships a node half, an invariant companion, and a browser half.** The browser half registers one durable `workgraph` Chat node through `conversationEvents` and the `conversation.chat.node` seat. `workgraph-definition.ts` owns the pure fold: `decodeGraphChange` decodes raw `workgraph/change` payloads defensively (foreign or malformed data is `null`, never a crash; clears decode as tombstones); `isGraphStartChange` recognizes the unique start of a graph — the set commit carries exactly one `created` history entry, and the conversation engine requires exactly one `start` match per context, so the whole lifecycle folds into one node per graph identity; `update` replaces the whole snapshot and tombstones on clear; `buildViewNode` projects `WorkGraphChatData` with deterministic longest-path `layerNodes` (stable by construction order; cyclic foreign data degrades every member to layer 0 rather than looping).

**`WorkGraphNode.tsx` renders the layered DAG**: per-layer node cards with ledger-dot states, waiting-on captions for unblocked deps, failure origins on failed/blocked cards, achieved rounds badges, a double-bordered final node, the header (objective, status pill, plan version, spend/budget line, pending discoveries, pause reason), the glyph legend, and a selectable detail pane (objective, spec, rounds, dependencies, discovery origins, failure). Theme tokens (CSS variables with fallbacks) drive every color — no hardcoded palette.

**The event union is per-program.** The client's `SessionEvent` union only includes `workgraph/change` when the workgraph package's SessionEventMap augmentation is in the program; the definition imports the domain types so the merge applies in the client build.

## Alternatives considered

**A projection service instead of a chat node.** Rejected: the conversation event engine already folds session events into durable nodes with replay and live-append support; a projection would duplicate that machinery and need its own reload path.

**Reuse the terminal renderer's box-drawing DAG.** Rejected: browser layout is CSS-native; the layered flex rows with card captions render crisply at any width, and full edge routing stays with the terminal renderer.

**Render controls in the view.** Rejected: the view is display-only by design (issue 08 checklist); `/graph` commands (issue 07) own every mutation.

## Consequences

- The live DAG appears in the conversation wherever `workgraph/change` events exist, and reloads reconstruct the identical view (replay ≡ live append, proven by the fold tests).
- Node selection exposes spec, rounds, dependencies, discovery origins, and failures; the final node is visually distinct; blocked chains carry their origin.
- The view is display-only and composes without the scheduler provider.
- 20 client tests green (definition fold, panel, browser plugin) at per-file 100% coverage; the client aggregate typecheck and staged lint are clean.
- Issue 09 lands the topology optimizer and the `.dsh/graph.jsonl` project revive.
