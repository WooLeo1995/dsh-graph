# Agent Note: workgraph 交互 UI 移植 AgentTeams 模式 —— 浮动活动面板 + 快照端点

Status: implemented

English | [中文](2026-08-15-workgraph-agentteams-live-panel.zh.md)

## Problem

The work-graph DAG view existed only as an in-chat card driven by `workgraph/change` event folding. There was no always-available live monitor: status changes were visible only inside the owning conversation, there was no host-side read API for the current graph, and the card offered no dependency-chain interaction. The user asked to adopt the interaction UI of the [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) plugin (MIT, 程序员阿江/Relakkes) for the work-graph UI.

## Decision

Port the AgentTeams activity-panel pattern, keeping the two-plane split that pattern uses — "anchoring goes through events, content goes through polling":

- **Host snapshot route** (`workgraph-scheduler`): `GET /plugins/dsh-workgraph/state` registered lazily on `ctx.webServer`/`ctx.httpServer` (`WEB_SERVER_KEYS` compatibility array, silent headless degradation, `internal/service` rebind). Each request assembles `WorkGraphPanelSnapshot` rows (shared types added to `@deepseek-ai/dsh-workgraph`) from every live agent's committed `current()` snapshot; node `depth` is the longest dependency chain (same semantics as the client's `layerNodes`, cyclic data degrades to 0). Response `cache-control: no-store`; per-agent try/catch isolates a bad session.
- **Floating activity panel** (`ui-workgraph`): `ActivityPanel.tsx` mounted through a body portal (the web shell has no top-right slot), polling the route every second with an `inFlight` guard, filtered to the current session's graph, showing the graph header and the depth-layered DAG with hover-chain highlight and click-to-pin (Esc clears). A collapsed badge auto-expands once after the 4 s page-settle window and auto-collapses 2 s after the graph disappears; polling pauses while the current session has no graph. All side effects ride `ctx.effect` disposers.
- **Card interaction** (`WorkGraphNode.tsx`): hover highlights the full upstream/downstream chain (`data-focused`/`data-dimmed` via the ported `relatedNodeIds`), click pins, and the header's "activity panel" button dispatches the `OPEN_WORKGRAPH_PANEL_EVENT` window event. Interaction is purely local component state — no session events, no fold changes (`workgraph-definition.ts` untouched, the start-detection invariants stay intact).
- **Shared types** live in `@deepseek-ai/dsh-workgraph`; the client imports and re-exports them (single declaration source, no mirror types).

## Provenance

Pattern ported from [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) (MIT, © 2026 程序员阿江/Relakkes): `src/snapshot.ts`/`src/index.ts` (route + assembly), `src/client/ActivityPanel.tsx` + `activity-model.ts` + `index.tsx` (panel, projections, body-portal mount), `src/client/AgentTeamsCard.tsx` (open-panel window event). The work-graph adaptation differs in data source (scheduler's in-memory `current()` instead of disk `team.json`), per-session graph identity (no captain/team/workspace concepts), and node semantics (`blocks` edges, `gn-final`, rounds/failure).

## Verification

workgraph 300/300 and ui-workgraph 57/57 tests green; per-file coverage 100% on all touched files; `tsc -b` clean; client bundle rebuilt containing the panel code (`workgraph:open-panel`, `relatedNodeIds`, `/plugins/dsh-workgraph/state`). Reviewer PASS on both planes (lifecycle disposers, read-only interaction, type single-source, field-level contract match).

## Alternatives considered

**Rely on the session-event fold alone and skip the snapshot route.** Rejected: the panel needs a host read face anyway (the user explicitly wanted the AgentTeams-style live monitor), and the route also covers the revive-visibility gap noted in the earlier start-detection note (a revived graph commits no events, so an event-only UI stays blind).

**Copy the AgentTeams package as a dependency.** Rejected: workgraph lives inside the deepseek-harness fork (workspace deps, per-file coverage gate, i18n triples); the pattern is ported instead, with provenance recorded.
