# @deepseek-ai/dsh-command-workgraph

English | [中文](README.zh.md)

Human-facing `/graph` control over [`ctx.workGraph`](../workgraph/README.md). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. The grammar and rendering are faithful ports of jxca-cli's `/graph` (the [work-graph spec](../../../.scratch/workgraph/spec.md) owns the contracts).

## Command contract

| Input | Result |
|---|---|
| `/graph` or `/graph status` | Render the per-node state tree: glyphs, waits, rounds, token spend, the budget line, pending discoveries, and the pause reason. |
| `/graph show` | Render the layered box-drawing DAG (status glyphs and legend), degrading to the status tree when the packing cannot fit the width budget. |
| `/graph <objective> [--budget <tokens>]` | Plan and run the objective as a dependency graph; a trailing own-token `--budget` sets the token budget. |
| `/graph pause` | Pause the live episode; the command waits for bounded child settlement (the per-child await budget) before returning. |
| `/graph resume [--budget <tokens>]` | Resume a paused/blocked graph; a top-up re-enters a budget-limited graph, while a plain resume on `budget_limited` prints the top-up hint. |
| `/graph retry [node]` | Retry one failure chain by node id, or (bare) every failed chain as ONE union batch — a shared final blocked by sibling failures refuses any single-root reset. |
| `/graph clear` | Clear the graph and its durable tombstone; a cleared graph cannot resurrect. |

Control words are case-insensitive only when they occupy the complete input. ANY input starting with `resume` or `retry` resolves to that command and NEVER falls through to set — a typo'd top-up must not silently replace a resumable budget-limited graph. Only a TRAILING, standalone `--budget` flag with a final all-digit positive token is consumed; anything else stays part of the objective. Expected domain rejections (already set, not retryable, budget hint, unknown node) become stable direct command errors; unexpected implementation failures still reject dispatch so adapters can report them as command failures.

## Composition

The producer injects `commands` and `workGraph`. A custom app mounts their owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: workgraph
  name: '@deepseek-ai/dsh-workgraph-scheduler'
- id: command-workgraph
  name: '@deepseek-ai/dsh-command-workgraph'
```

The scheduler provider owns the durable graph; the command is a pure adapter over `ctx.workGraph`.

## Model Experience

### Human `/graph` control

#### What the model sees

The slash input, mutations, and direct status/error output are absent from model requests. The engine records every accepted transition as `workgraph/change`; the GUI (issue 08) renders the live DAG from those events. Presentation text is never logged.

#### Token effect

Reading status, mutating a graph, or receiving a direct command error adds no model tokens. The graph's worker and verifier children spend their own tokens, charged to the graph budget through the session usage records.

#### KV Cache effect

Command discovery, mutations, and direct output do not affect the cache. Child requests follow their own fresh sessions.

## Known Limitations and Deferred Work

- **Blocking set** — `/graph <objective>` runs the episode to its first settlement (complete, paused, or blocked) before returning, holding the agent's command loop; the parent conversation still spends no model turn. A detached start remains future work.
- **Plain-text interaction only** — the generic command registry has no modal forms; inline `--budget` flags and explicit control words keep intent deterministic across adapters.
- **No continuous status widget** — bare `/graph` is the portable observation API; the live DAG view lands with issue 08.
