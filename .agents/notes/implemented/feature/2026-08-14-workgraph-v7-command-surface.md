# Agent Note: Work graph v7 — `/graph` command surface, rendering, validated config

Status: implemented

English | [中文](2026-08-14-workgraph-v7-command-surface.zh.md)

## Problem

Through issue 06 the graph existed only as an engine API: no human could start one, watch it, pause it, top up a budget, or clear it without writing code. jxca's `/graph` is the reference human surface, and the spec's config list (`concurrency`, `nodeRounds`, `replanCap`, `optimizer`, `maxNodes`, `historyMax`, `planBytesMax`, per-child await budget) had no validated home. The command had to dispatch without a model turn, never let a `resume`/`retry` typo fall through to `set`, and wait for child quiescence on pause.

## Decision

**`dsh-command-workgraph` is a pure adapter over `ctx.workGraph`.** The grammar is a faithful port of jxca's: control words are case-insensitive only as complete input; ANY input starting with `resume` or `retry` resolves to that command and NEVER falls through to set (a typo'd top-up must not silently replace a resumable budget-limited graph); only a TRAILING, own-token `--budget` with a final all-digit positive token is consumed — anything else stays in the objective. `status` renders the jxca ASCII glyph tree (`[x] [>] [ ] [.] [!] [-]`, waits, rounds, spend, budget line, discoveries, pause reason); `show` ports the box-drawing DAG renderer — longest-path layering, dummy chains for multi-layer edges, one-pass barycenter ordering, lane-packed connector buses with a merge-glyph canvas where blanks never overwrite ink, unicode glyphs (`✓ ▶ ○ · ✗ ⊘`) and legend, 120-column width budget — degrading to the status tree when the packing cannot fit or the graph cannot be layered (pending or cyclic foreign data refuses to render garbage). Domain rejections (already set, not retryable, budget hint, unknown node) become stable direct errors; non-domain failures rethrow for the adapter to report.

**Pause reaches quiescence.** The scheduler tracks each drive's settlement; `pause()` aborts the episode, awaits the in-flight drive's settlement bounded by `childAwaitBudget`, and returns the latest committed view — the drive's in-flight demote lands before the command returns (a resource stop, never a verdict). A clear landing during the wait falls back to the committed snapshot.

**Bare retry is a union batch.** `retryAllNodes` (tracker) resets every failed node plus its transitively blocked chains as ONE batch — a shared final blocked by sibling failures refuses any single-root reset (`WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED`), so `/graph retry` must carry the whole set; the engine exposes `retryAll`. Per-node retry keeps its existing semantics.

**Config is validated at load.** `config.ts` resolves the spec tunables with defaults and loud out-of-range failures; the provider's `static Config` (schemastery) enforces the documented clamps at cordis load: concurrency (3, 1–8), nodeRounds (3, 1–8), replanCap (3, 0–10), optimizer (on — consumed at plan boundaries with issue 09), maxNodes (24), historyMax (64), planBytesMax (256 KiB — the plan gate now rejects oversized artifacts as its first check), childAwaitBudget (600 s, 1–3600). `WorkGraphLimits` gains the optional `planBytesMax`.

## Alternatives considered

**A second "detached start" engine entry.** Rejected for this issue: the deterministic set-drives-to-settlement contract is pinned by the execution suite; the command documents the blocking behavior and the parent conversation still spends no model turn. Detached start remains future work.

**Clamp silently instead of failing loud.** Rejected: the spec and acceptance demand an out-of-range value fail at load — a deployment typo must surface, not be absorbed.

**Bare retry as a loop of per-node retries.** Rejected: a shared final blocked by sibling failures refuses any single-root reset, so the loop can never clear the graph; the union batch is the only correct semantics.

## Consequences

- `/graph` dispatches without a model turn with the full jxca grammar; `status`/`show` render state honestly and degrade gracefully; `resume`/`retry` prefixes can never replace a graph.
- Pause returns only after bounded child settlement; the budget top-up hint guides a `budget_limited` graph.
- Bare retry clears every failure chain in one batch; `retryAllNodes` joins the tracker vocabulary.
- The validated `Config` schema makes deployment tuning code-free; the plan gate enforces the byte budget.
- 255 workgraph tests green (18 new command tests plus config/gate/tracker additions) at per-file 100% coverage; host typecheck and staged lint clean.
- Issue 08 renders the live DAG in the Web client from the same session events; issue 09 consumes the `optimizer` toggle at plan boundaries.
