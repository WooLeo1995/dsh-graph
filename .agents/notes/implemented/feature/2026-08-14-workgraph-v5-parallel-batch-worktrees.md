# Agent Note: Work graph v5 — parallel batches, worktree isolation, seam workspace override

Status: implemented

English | [中文](2026-08-14-workgraph-v5-parallel-batch-worktrees.zh.md)

## Problem

Issue 04 settled nodes serially in the main workspace. Parallelism needed real isolation: independent nodes had to run concurrently without corrupting the main tree, each verified in its own worktree and merged back only after passing — and a bad merge had to fail only its own node.

## Decision

**The subagent seam gains the one workspace extension.** `SubagentStartRequest.workspace` (an absolute session-`cwd` override) is capability-gated through the optional `SubagentCapabilities.workspace` flag: a request naming it on a provider that does not declare the flag is rejected `UNSUPPORTED_CAPABILITY` — the same fail-loud, never-silently-ignored discipline as the other capabilities. The in-process driver honors it by overriding the child session's `cwd` in its creation meta; the continuation manager persists the durable header, so resumed worker rounds keep the worktree automatically. The spawn provider advertises the capability; the scheduler probes it (`workspaceCapableFor`) and degrades to serial when absent.

**`worktrees.ts` owns the isolation mechanics.** A detached worktree is minted at the fan-out HEAD under the harness home (`workgraph/worktrees/<session>/<node>`); the changed set comes from git plumbing — the tracked diff against the base plus untracked files; each changed file merges 3-way over raw bytes (base = the fan-out HEAD blob, ours = the main working file, theirs = the worktree file; base==ours takes theirs, ours==theirs is already present, else conflict). A HEAD guard captures the main HEAD at fan-out and fails the node loudly if it moved. Merged worktrees are removed best-effort; failed nodes keep theirs for postmortem.

**`parallel.ts` drives batches where eligible.** When at least two nodes are Ready, the concurrency cap exceeds 1, the composition is workspace-capable, and the directory is a git repo (the probe degrades once to serial exactly like jxca's non-git clamp), a batch of up to the cap runs: all worktrees minted at one fan-out baseline, each node's worker/verifier rounds in its own worktree (the workspace override reaches the worker rounds and the verifier; round 2+ continues the SAME child in the worktree), then merge-back sequentially in batch order. A merge-back failure revokes the achievement through the new `settleMergeFailed` tracker transition — the node fails with the precise reason, its non-achieved dependents block, and a wedge blocks the graph, so one bad merge never kills the graph. `settleAchieved` now re-checks the wedge when a late achievement strands the graph (a failure while a sibling is still runnable wedges once the sibling settles).

## Alternatives considered

**No isolation (shared tree).** Rejected in the design session: parallel nodes on one tree necessarily collide; the worktree is the physical premise of "nothing merges until it passes".

**Sandbox-mode isolation instead of worktrees.** Rejected: sandboxes restrict, they do not isolate state — the merge-back semantics (HEAD guard, 3-way byte merge, keep-worktree-for-postmortem) need real checkouts.

**Let a merge conflict block the whole graph.** Rejected: the acceptance and jxca both fail only the conflicting node — siblings continue, dependents block via the tracker's ordinary failure semantics.

## Consequences

- Parallel batches run independent nodes in isolated worktrees; a clean batch lands its files via sequential 3-way merges and removes the worktrees; a conflict or a moved HEAD fails only that node, which keeps its worktree for postmortem.
- The workspace override is a proper, capability-gated seam extension with a real-stack child-`cwd` assertion in the subagent suite; non-git repos and incapable providers degrade to serial.
- 202 vitest tests green (51 new) at per-file 100% coverage across the scheduler sources; lint and host typecheck clean.
- Issue 06 wires discoveries and replan; issue 07 lands the command surface and the validated `concurrency` config.
