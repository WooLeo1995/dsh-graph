# dsh-graph — DeepSeek Harness workgraph plugin sources

English | [中文](README.zh.md)

The independently maintained source repository for the **workgraph capability family** of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the deterministic work-graph scheduler, the `/graph` command surface, and the Web Client live DAG view. An objective becomes a dependency DAG of autonomous, self-verifying nodes — planner child plans, worker children implement, adversarial verifier children audit, parallel batches run in isolated git worktrees merged back 3-way, discoveries replan under a cap, a topology optimizer reshapes the graph at plan boundaries, and the graph survives sessions via session events plus a repo-root `.dsh/graph.jsonl` projection under an exclusive lock.

## Repository layout

```
packages/
  workgraph/
    workgraph/             dsh-workgraph — Service Definition (vocabulary, ctx.workGraph, workgraph/* events)
    workgraph-scheduler/   dsh-workgraph-scheduler — provider: tracker, episodes, passes, worktrees, project revive
    command-workgraph/     dsh-command-workgraph — /graph command on ctx.commands (no model turn)
  client/
    ui-workgraph/          dsh-client-ui-workgraph — Web Client live DAG view (pure function of session events)
docs/subsystems/           workgraph subsystem page (service face + event scope catalog)
.scratch/workgraph/        the authoritative phase-2 spec (spec.md) and issues 01–09
.agents/notes/             Agent Notes v1–v9 (implemented decisions, bilingual)
CONTEXT.md                 the domain glossary established in the design grilling
```

## Relationship to DeepSeek Harness

This repository is a **source mirror** of the workgraph packages inside the `deepseek-harness` fork, kept as an independent GitHub project for maintenance and review. The packages declare their `@deepseek-ai/*` peer dependencies as `workspace:^` — those internal packages (cordis, schemastery, dsh-session, dsh-agent, dsh-subagent, …) are vendored in the host repository and not published to npm, so **building and running the tests requires the host checkout**:

- host repo: `/Users/wutianyu/Downloads/project/github/deepseek-harness` (branch `master`)
- worktree sync: `./sync.sh pull` (host → here) / `./sync.sh push` (here → host)

Per-package test gates (per-file 100% coverage, i18n trio records, staged lint) are enforced by the host's tooling.

## Usage

```
/graph <objective> [--budget <tokens>] | status | show | pause | resume [--budget <tokens>] | retry [node] | clear
```

`set`, `resume`, and `retry` **dispatch and return immediately**: the graph is planned and driven in the background by the scheduler, so the command never blocks the conversation channel for the graph's whole lifetime. Progress is observed through `/graph status`, `/graph show`, the repository projection (`.dsh/graph.jsonl`), and the Web Client live DAG view; `pause` still waits for bounded child settlement. A failed planning episode or drive pauses the graph as `infra_paused` with the reason — the graph is never left active with no driver.

## Local installation (trial)

1. Build the scheduler and the client bundle in the host checkout (the workgraph packages' `lib/` must be fresh):
   ```bash
   cd /Users/wutianyu/Downloads/project/github/deepseek-harness
   node_modules/.bin/tsc -b packages/workgraph/workgraph packages/workgraph/workgraph-scheduler packages/workgraph/command-workgraph
   node_modules/.bin/tsdown           # host face; the client face covers ui-workgraph
   ```
2. Link the packages into the dsh profile (the user plugin workspace resolves from `~/.dsh/profiles/`):
   ```bash
   cd ~/.dsh/profiles/node_modules/@deepseek-ai
   ln -s <host>/packages/workgraph/workgraph dsh-workgraph
   ln -s <host>/packages/workgraph/workgraph-scheduler dsh-workgraph-scheduler
   ln -s <host>/packages/workgraph/command-workgraph dsh-command-workgraph
   ln -s <host>/packages/client/ui-workgraph dsh-client-ui-workgraph
   ```
3. Add the plugin rows to the web profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):
   ```yaml
   - insert:
       - id: workgraph
         name: '@deepseek-ai/dsh-workgraph-scheduler'
         config:
           workgraphDir: !!js dshHomePath('workgraph')
       - id: command-workgraph
         name: '@deepseek-ai/dsh-command-workgraph'
       - id: ui-workgraph
         name: '@deepseek-ai/dsh-client-ui-workgraph'
   ```
4. Start a separate trial instance (default port 3080 may be taken by another instance):
   ```bash
   node apps/cli/lib/bin.js web --patch examples/web-graph.patch.yml
   ```
   The trial instance listens on `http://127.0.0.1:3081`; open it and run `/graph <objective>` in a session. To uninstall, remove the rows from `cordis.patch.yml` (or delete the file) and restart.

See [examples/web-graph.patch.yml](examples/web-graph.patch.yml) for the port overlay. The `workgraphDir` key lives in the scheduler's cordis Config schema; the loader unwraps the scheduler class as the package default export (class-plugin convention).

Validated cordis.yml config: `concurrency` (3, clamp 1–8), `nodeRounds` (3, 1–8), `replanCap` (3, 0–10), `optimizer` (on), `maxNodes` (24), `historyMax` (64), `planBytesMax` (256 KiB), `childAwaitBudget` (600 s, 1–3600).

## Documentation

- [CONTEXT.md](CONTEXT.md) — the domain glossary (ubiquitous language).
- [.scratch/workgraph/spec.md](.scratch/workgraph/spec.md) — the authoritative phase-2 spec.
- [.scratch/workgraph/issues/](.scratch/workgraph/issues/) — issues 01–09, each marked resolved with its resolution.
- [.agents/notes/implemented/feature/](.agents/notes/implemented/feature/) — Agent Notes v1–v9 (English/中文 pairs).

## License

MIT. The workgraph implementation is a port of jxca-cli's `/graph` contracts (behavioral contracts transplanted with provenance; no code copied); the host DeepSeek Harness codebase is © 2026 DeepSeek, MIT licensed.
