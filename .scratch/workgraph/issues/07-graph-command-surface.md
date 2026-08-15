# 07 — /graph command surface, rendering, and config

**What to build:** The human surface: `dsh-command-workgraph` registers the `/graph` command on `ctx.commands` (dispatches without a model turn): `/graph <objective> [--budget N] | status | show | pause | resume [--budget N] | retry [node] | clear`. `status` renders per-node state glyphs, the waiting-on dependency, rounds and token spend, the budget line, and the pause reason; `show` renders the DAG (layered, status glyphs, legend) degrading to the status tree when it cannot fit. `resume`/`retry` prefixes never fall through to set. Pause cancels the live episode (bounded child settlement); a plain resume on `budget_limited` prints the top-up hint. Config validation lands with the command: concurrency, nodeRounds, replanCap, optimizer, maxNodes, historyMax, planBytesMax, and the per-child await budget as validated Config fields with their clamps.

**Blocked by:** 06 — discovery and capped replan

**Status:** resolved

- [x] The full command grammar dispatches without inference; `resume`/`retry` never fall through to set; unknown states render honestly.
- [x] `status`/`show` output carries node glyphs, dependencies, spend, and pause reasons; `show` degrades to the tree under width pressure.
- [x] Pause cancels the live episode and children reach quiescence before the command returns; clear removes state and the project projection (tombstone).
- [x] Every config field validates with its clamp; an out-of-range value fails load loudly.

## Resolution

**`dsh-command-workgraph`** registers `/graph` on `ctx.commands` (injects `commands` + `workGraph`): the grammar is a faithful port of jxca's — control words case-insensitive only as complete input; ANY `resume`/`retry` prefix resolves to that command and never falls through to set (a typo'd top-up cannot silently replace a resumable budget-limited graph); only a trailing own-token `--budget` with a final all-digit positive token is consumed, everything else stays in the objective. `status` renders the jxca ASCII glyph tree ([x] [>] [ ] [.] [!] [-], waits, rounds, spend, budget line, discoveries, pause reason); `show` ports the box-drawing DAG renderer (longest-path layering, dummy chains, one-pass barycenter ordering, lane-packed buses, unicode glyphs + legend, 120-column budget) and degrades to the status tree when the packing cannot fit or the graph cannot be layered (pending or cyclic foreign data). Domain rejections (already set, not retryable, budget hint, unknown node) become stable direct errors; non-domain failures rethrow for the adapter to report.

**Pause quiescence** — the scheduler tracks each drive's settlement; `pause()` aborts the episode, awaits the in-flight drive's settlement bounded by `childAwaitBudget` (the per-child await budget), and returns the latest committed view (the drive's demote lands before quiescence). A clear during the wait falls back to the committed snapshot. `clear` keeps the durable tombstone semantics.

**Bare retry is a union batch** — `retryAllNodes` (tracker) resets every failed node plus its transitively blocked chains as ONE batch: a shared final blocked by sibling failures refuses any single-root reset (`WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED`), so `retryAll` on the engine/`/graph retry` carries the whole set, with `node-retried` recorded once. Per-node `retry` keeps its existing semantics.

**Config** — `config.ts` resolves the spec tunables with defaults and loud out-of-range failures; `static Config` (schemastery) enforces the documented clamps at cordis load: concurrency (3, 1–8), nodeRounds (3, 1–8), replanCap (3, 0–10), optimizer (on, consumed with issue 09), maxNodes (24), historyMax (64), planBytesMax (256 KiB — the plan gate now rejects oversized artifacts first), childAwaitBudget (600 s, 1–3600). `WorkGraphLimits` gains the optional `planBytesMax`.

Coverage: 255 workgraph tests green (18 new command tests + config/gate/tracker additions) at per-file 100%; host typecheck and staged lint clean.

## Notes

- The `--budget` grammar, glyphs, legend, and width budget are transplanted from jxca with file:line provenance; no code copied.
- `optimizer` is validated and exposed (`optimizerEnabled()`) but consumed only at plan boundaries with issue 09; `planBytesMax` and `childAwaitBudget` have live behavior now.
- Issue 08 renders the live DAG in the Web client from the same session events.
