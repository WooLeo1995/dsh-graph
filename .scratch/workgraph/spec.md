# Work Graph — Phase 2: Deterministic DAG Scheduler over Agent Work

Status: ready-for-agent

## Problem Statement

The code knowledge graph (phase one) answers structural questions about a codebase, but executing a large objective is still one conversation: the agent plans and works sequentially in a single context, re-deriving intent after every compaction, with no durable decomposition, no dependency-ordered parallelism, and no independent verification that a unit of work is done. jxca-cli solved this with `/graph`: an objective becomes a dependency DAG of autonomous, self-verifying agent loops driven by a deterministic scheduler that survives pauses, restarts, and budget stops. DeepSeek Harness has no equivalent: same-session goals continue one conversation, Ralph iterates fresh workers on a single objective, and model-written workflow scripts are neither deterministic nor durable.

## Solution

The work graph turns an objective into a planned DAG of nodes executed by a deterministic scheduler. A planner child produces a validated plan (bounded size, hygienic slugs, acyclic, harness-appended final node); nodes execute as fresh worker subagents, each verified by an adversarial verifier child before it may pass; parallel-ready nodes run concurrently in per-node git worktrees merged back sequentially. Every transition is a pure function of the tracker snapshot plus a report outcome, checkpointed to the session log, and projected to a team-visible `.dsh/graph.jsonl` at the repo root so a fresh session can revive the graph. Workers report necessary out-of-scope work instead of doing it; the replanner appends it under a cap. A human command surface (`/graph`) sets, inspects, pauses, resumes, retries, and clears graphs; the GUI renders the live DAG. The parent conversation spends no model turn on execution.

## User Stories

1. As a user, I want to give an objective (plus an optional token budget) and get a validated DAG executed autonomously until the final whole-objective verification node passes, so that large work proceeds without me steering each step.
2. As a user, I want every transition deterministic and inspectable — status shows each node's state, dependency, rounds, and token spend, plus the graph's pause reason — so that I can always answer "where is this and why".
3. As a user, I want the DAG rendered (`show`, GUI), so that I can see structure and progress at a glance.
4. As a user, I want pause to stop the live episode and resume to continue from the durable tracker state, so that nothing is re-derived after a stop.
5. As a user, I want `/graph retry [node]` to reset a failed node and its transitively blocked chain (refusing when an upstream dependency is neither achieved nor in the same batch), so that a wedge is always escapable.
6. As a user, I want clear to remove graph state and its project projection (tombstone), so that a cleared graph cannot resurrect.
7. As a user, I want the graph project-visible at `.dsh/graph.jsonl` under a single-writer lock, so that teammates see status while a second session cannot resume it.
8. As a user, I want a fresh session to revive the project graph demoted to paused (Running nodes demoted to Ready), so that a restored snapshot never resurrects as self-driving.
9. As a user, I want concurrency, worker-verifier rounds, replan cap, optimizer, and node caps as validated cordis.yml config, so that deployment tuning never edits code.
10. As a user, I want parallel-ready nodes to run concurrently, each worker isolated in its own git worktree and merged back sequentially, so that parallelism cannot corrupt the main tree.
11. As a user, I want a merge conflict or a moved main HEAD to fail only that node (siblings continue, dependents block), so that one bad merge never kills the graph.
12. As a user, I want a failed node to keep its worktree, so that I can postmortem it.
13. As a user, I want every node verified by an adversarial verifier that re-runs the decisive checks itself, so that an unverifiable claim is a gap and an errored verifier never passes.
14. As a user, I want a worker's `blocked` declaration (with reason) to fail the node and block its dependency chain, so that impossible work surfaces loudly instead of looping.
15. As a user, I want verifier rejections to iterate the SAME worker child with named gaps, bounded by a rounds cap, so that fixing round N+1 keeps round N's context and worktree.
16. As a user, I want workers to report necessary out-of-scope work instead of doing it, and the replanner to append it as new nodes under a cap, so that the graph converges on reality.
17. As a user, I want a harness-appended final node that independently re-verifies the whole objective and always runs last, so that completion is certified, not declared.
18. As a user, I want an invalid plan to get exactly one retry carrying the validation feedback, a second failure to pause the graph as infra, and resume to re-plan, so that planner noise never wedges the graph.
19. As a user, I want a budget trip to demote in-flight nodes to Ready (a resource stop, not a verdict), spent-so-far always charged, and `resume --budget` to top up from spent, so that budget control is honest and resumable.
20. As a user, I want the scheduler to write only `.dsh/graph.jsonl` (+lock) into the repo, worktree checkouts under the harness home, and committing to stay my decision, so that the product never surprises my git history.
21. As a user, I want execution to spend no parent-conversation model turn: workers and verifiers are subagents and `/graph` commands dispatch without inference, so that the graph costs tokens only in its children.
22. As a user, I want the GUI to render the live DAG with per-node state and progress from the session log, so that the view survives reload.
23. As a user, I want the first validation target to be this repository, so that usefulness is judged on a real codebase.

## Implementation Decisions

- **Capability family `workgraph/`**: Service Definition `dsh-workgraph` owns the vocabulary, service methods (`set`, `status`, `render`, `pause`, `resume`, `retry`, `clear`), and `workgraph/*` observe-only emits; `dsh-workgraph-scheduler` is the Provider (tracker, episodes, passes, worktrees, merge); `dsh-command-workgraph` is the human-command Consumer registering on `ctx.commands`; `packages/client/ui-workgraph` renders. No model-facing tool in v1.
- **Deterministic tracker**: node states `Waiting`, `Ready`, `Running`, `Achieved`, `Failed`, `Blocked`; `Verifying` is display-only and never persisted; an unknown persisted state restores as `Ready`. `Waiting → Ready` when every `Blocks` dependency is `Achieved`; a `Failed` node triggers a fixed-point `block_dependents` sweep (an already-`Achieved` dependent is never demoted); a wedge (nothing runnable, not all achieved) pauses the graph with a retry hint; `retry` resets one node plus its transitive blocked chain. Graph status: `active`, `user_paused`, `infra_paused`, `blocked`, `budget_limited`, `complete` — jxca's goal-engine pause kinds (`back_off`, `no_progress`) are dropped because dsh nodes are subagents, not goal-engine occupants. History is capped with an `Unknown` forward-compat sink.
- **Durability**: session events (a `SessionEventMap` extension) are the source of truth; every transition checkpoint appends and the project file is a projection. `.dsh/graph.jsonl` at the repo root: line 1 is the header (orchestration minus nodes), then one node per line, written atomically; an exclusive lock on a sidecar is held for the graph's lifetime; a second holder gets read-only status and refused resume; a malformed file is a loud error, never "no graph". Revive sanitizes then demotes (`Active → user_paused` with a restart message, `Running → Ready`).
- **Planning**: a planner child (spawn subagent, structured output) emits `{ nodes: [{ id, title, spec, deps }] }`. The static gate checks, in order: JSON parses; nodes non-empty; duplicate deps deduped; size ≤ `maxNodes` (24); slug hygiene (1–64 chars of `[A-Za-z0-9_-]`); slug uniqueness; non-empty `title`/`spec`; no self dependency; deps resolve within the plan; acyclicity by planner-order-stable Kahn (first Ready in storage order inherits planner intent); canonical-id collision. Node ids are `gn-<fnv1a32(slug)>` (8 lowercase hex — stable across machines, line-mergeable). The harness appends `gn-final`, depending on every planner node, with the fixed whole-objective re-verification spec; plans are told not to write it, and replan/optimizer edges onto it are rejected. One retry-with-feedback; a second invalid plan pauses the graph as `infra_paused` (resume re-plans). Each plan version's baseline is frozen before execution and never overwritten.
- **Episodes, not a daemon**: the scheduler service owns in-process episode execution; one episode settles one serial node or one parallel batch. Children run through `ctx.subagents` directly — round 1 as a spawn start request, later rounds continuing the same child through the continuation manager (context and worktree preserved). This refines ADR 0001's "workflow seam" pointer (see ADR 0003): the workflow engine stays the model-authored-script surface; its one-shot `agent()` cannot resume a worker across verifier rounds and its runs are foreground and process-local.
- **The one seam extension**: `SubagentStartRequest` gains a capability-gated `workspace` override so a worker's child runs inside its worktree. Providers without the capability — and non-git working copies — exclude parallel mode, which degrades to serial exactly like jxca's non-git clamp.
- **Reports**: structured-output schemas replace jxca's line-anchored `NODE_RESULT:`/`NODE_VERDICT:` markers. Worker: `{ status: done | blocked, summary, discovered: string[] }`; verifier: `{ verdict: achieved | not_achieved, gaps: string[], discovered: string[] }`. Fail-closed mapping is preserved: a missing or invalid report is unparseable (burns the round as a gap); an errored verifier run is `not_achieved`; a rejection without gaps is rejected as invalid. The worker's summary is schema-field data, so it cannot spoof a verdict field — jxca's marker neutralization is unnecessary by construction.
- **Worker and verifier prompts**: the worker prompt carries the node objective (position, title, spec, the graph objective, a complete-only-this-scope instruction, and the prior round's gaps), worktree semantics (changes merge back after verification; the harness owns version control), and the discovered-work contract. The verifier prompt is adversarial (re-run the decisive checks; an unverifiable claim is a gap; read-only — a tool filter where the provider supports it, prompt contract otherwise) and receives the worker's summary as data to audit, not trust.
- **Merge-back**: sequentially per node in batch order. A HEAD guard captures the main HEAD at fan-out and fails the node loudly if it moved. The changed set comes from `git` plumbing through the shell service; each changed file merges by 3-way over raw bytes (base = blob at the fan-out HEAD, ours = main working file, theirs = worktree file; `base==ours` takes theirs; `ours==theirs` is already present; otherwise conflict). A conflict fails only that node; a successful merge removes the worktree best-effort; a failed node keeps it for postmortem.
- **Discovery and replan**: `discovered` entries collect from worker and verifier reports and serial node finals; at episode boundaries, under pre-gates (pending entries exist, budget remains, `gn-final` not yet achieved, replan cap not exhausted), a replanner child appends nodes. Install rules: append-only; `discovered_from` references live existing nodes; deps may not target `gn-final`; no dependency on a dead node; combined acyclicity and size; `gn-final` re-gated over the additions and a Ready final demoted. An empty appendix still consumes a cap slot; a failed replan degrades (entries drain to history) — a working graph never pauses because an enhancement pass failed.
- **Budget**: an optional token budget at set or resume; the scheduler accumulates per-child usage from the child sessions' durable usage records, keyed by the child session ids it started. A composition without usage recording rejects a configured budget at `set` (misconfiguration fails loud). Dispatch gates at zero remaining; in-flight nodes demote to `Ready` (resource stop, not verdict); spent-so-far is always charged, including failed nodes; top-up sets the budget to spent-plus-extra; a plain resume on `budget_limited` refuses with the top-up hint.
- **Config** (validated `Config` fields, changeable from cordis.yml): concurrency (3, clamp 1–8), nodeRounds (3, clamp 1–8), replanCap (3, clamp 0–10), optimizer (on), maxNodes (24), historyMax (64), planBytesMax (256 KiB), per-child await budget (600 s).
- **Write isolation**: the scheduler writes only `.dsh/graph.jsonl` and its lock into the repo; worktree checkouts live under the harness home (`workgraph/worktrees/<session>/<node>`); git itself adds worktree admin entries under `.git`; committing stays the user's decision.
- **Inter-node dataflow honesty**: sibling results never enter node prompts (isolation by design); the merged working tree plus the final node's whole-objective re-verification are the only channels.

## Testing Decisions

- **Units without a model**: the transition table exhaustively; gate ordering with each rejection reason; fnv1a32 vectors; restore demotion; `block_dependents` fixed point; retry refusal; the 3-way matrix including conflict and moved-HEAD; project-file round-trip, malformed-content loudness, and lock exclusivity.
- **Real-stack keyless integration**: the llm-mock-server scripts planner, worker, and verifier responses; the real spawn provider and continuation manager run children; a real git fixture repo exercises real worktrees and merges; cancellation reaches child quiescence.
- **Snapshot**: a real runnable example composition executes a three-node diamond plus the final node over a fixture repo; the transcript is pinned keyless.
- **Self-validation**: a real objective against this repository through the composed product.
- **Honesty tests**: an errored verifier never passes; an invalid report never parses; an unknown persisted state restores `Ready`; a budget trip never records a verdict.

## Out of Scope

- A model-facing graph tool: the model never sets or steers graphs in v1.
- More than one active graph per session.
- Planner consumption of the phase-one code knowledge graph (a future synthesis).
- Token budgets in compositions without usage recording (fails loud instead).
- Cross-repo objectives; daemon-mode episodes beyond the session process; cancellation mid-merge.
- Sibling-result dataflow into node prompts.
- Phase-one plugin promotion (a separate effort).

## Further Notes

- Vocabulary: CONTEXT.md gains *work graph* and *discovered work*.
- ADR 0003 records the seam decision (episodes drive the subagent seam directly, refining ADR 0001's workflow-seam pointer; structured reports replace marker lines; project file at the repo root).
- Contracts are transplanted from jxca-cli's `/graph` with file:line provenance in `.scratch/research/2026-08-14-graph-dag-phase2-design.zh.md`; behavior is reparsed into dsh seams, no code copied.
- Main risk: worktree lifecycle and provider capability gaps. Mitigations: parallel mode requires a git repo and a workspace-capable provider, degrading to serial otherwise; failed nodes keep their worktrees for postmortem; every report path fails closed.
