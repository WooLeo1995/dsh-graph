# Agent Note: workgraph DAG 从不渲染 —— set 提交 start 检测失配

Status: implemented

English | [中文](2026-08-15-workgraph-dag-start-detection.zh.md)

## Problem

The work graph runs in the background (dispatchSet detaches the planning+drive chain), but the Web Client's live DAG view never materialized — neither in real time nor after a reload. Verified from captured session logs: all three historical graph runs committed `workgraph/change` events, yet the GUI showed nothing.

Root cause: a payload-shape mismatch at the client's start detection. The scheduler's `dispatchSet` commits the pending graph via `createPendingGraph`, whose history is `['created', 'planning-started']` — planning begins before the first checkpoint. The client's `isGraphStartChange` demanded a history of exactly `['created']` (the shape the blocking set path was assumed to produce). The first event therefore matched with role `'update'`, and the conversation fold engine (`ConversationNodeAssembler.acceptMatch`) drops updates that precede any start — the chat node never materializes, so the DAG never renders. The failure was silent: no error, no node.

The live transport itself was healthy: `dsh-host-apiproxy` pushes every committed session event to connected Web clients as a `session/event` mux frame (`cache-control: no-cache`), so once the node materializes, updates flow in real time.

## Decision

- **`isGraphStartChange` anchors on the creation fact, with a history-shape fallback**: a change is the unique start iff its snapshot's `createdAt === updatedAt` — the creation fact holds only for the set commit, because every later transition bumps `updatedAt` (verified: all 16 transition sites in `tracker.ts`), and it is independent of the history cap. Payloads without timestamps (older logs, foreign data) fall back to the exact history shapes `['created']` or `['created', 'planning-started']`. The history-shape arms are safe by construction: `created` is appended exactly once per graph, every later change appends at least one further kind, and the history cap evicts only from the head — so no later event can ever carry exactly those two arrays, and the fold engine's "more than one start" rejection can never fire.
- **Host-side contract unchanged**: no scheduler change. The alternative of splitting `planning-started` into its own checkpoint (so the first commit carries only `['created']`) was considered and rejected: it would leave every pre-existing graph (whose first event already carries both entries) permanently invisible, and it buys nothing — the client rule now covers both shapes plus the cap-truncated one.
- The creation-fact arm also covers the `historyMax = 1` configuration (a legal lower bound, `config.ts`): the first event's history is there truncated to exactly `['planning-started']` before persistence, which no history-shape rule could recognize — the timestamp test does.
- Regression tests pin the real scheduler shapes end-to-end: the fold of `[created, planning-started] → +planning-completed → +node-started` materializes the node on the first event and updates it live; the `completeEvents` fixture was reshaped to the real commit sequence; a cap-truncated first event (`['planning-started']` + creation fact) is asserted as a start.

## Known edge (recorded, not a defect)

`dispatchRetryAll` returns the input snapshot unchanged when no node is failed; a hypothetical future caller that bypasses the command layer's zero-failure guard could commit a non-first change whose snapshot still carries `createdAt === updatedAt` and re-trigger a start match (the engine would throw loudly — no silent absence). Currently unreachable in the product flow; if that entry point is ever exposed, make the no-op branch bump `updatedAt` or reuse the creation fact for idempotence.

## Verification

21/21 client tests green; `workgraph-definition.ts` at 100% statement/branch/function/line coverage; `tsc -b` clean; client bundle rebuilt and confirmed to contain the new branch. Repro-to-fix loop: the regression test (real dispatch event shapes) failed with `expected undefined to be 'active'` before the fix and passes after.

## Alternatives considered

**Split the first checkpoint on the host** (commit `['created']`, then a separate `planning-started` checkpoint). Rejected: pre-existing graphs would stay invisible (their first events already carry both entries), and the client's strict rule would remain fragile against future scheduler changes.

**History-`includes('created')` start rule.** Rejected: every event before the history cap evicts `created` would match as start, tripping the fold engine's exactly-one-start rejection.
