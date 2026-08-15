# Agent Note: Work graph v6 — discovery replan, capped enhancement passes

Status: implemented

English | [中文](2026-08-14-workgraph-v6-discovery-replan.zh.md)

## Problem

Issue 05 ran the plan to completion, but a plan is a snapshot: worker and verifier reports carry `discovered` entries that no longer fit the installed graph. Without a replan pass the graph either ignores them (lost signal) or must fail (lost convergence). jxca replans at episode boundaries with a replanner child and installs the appendix append-only; the graph had to replicate that discipline — capped, fail-loud on abuse, and never allowed to pause a working graph because an enhancement pass failed.

## Decision

**`replan.ts` owns the pass.** `runReplannerEpisode` renders the replanner contract (objective, compact live graph, pending discoveries, prior feedback) and spawns the replanner child through the same `PlannerSpawn` seam as planning, with its own output schema: `planned` (validated appendix rows canonicalized to `waiting` nodes), `invalid` (precise gate reason), `fail-closed` (child error or missing artifact). `validateAppendix` enforces the row rules in fixed order — artifact shape; per-row shape; slug hygiene; uniqueness; non-empty prose; string deps; no self-deps — and deliberately does NOT resolve deps internally: the appendix may reference existing live nodes, resolved by `replanDependencyGuard` against the current graph (never the reserved final node, never a non-live node). `installReplan` appends in planner order, re-gates `gn-final` over the additions (a Ready final demotes to waiting), bumps the plan version, clears the entries, and records `replanned`; the new baseline freezes under the harness home with v1 immutable. An empty appendix is a respected answer that still consumes the cap slot; the terminal gate is never stranded by an empty pass, because the re-gate re-promotes through the tracker's `promoteReady` when every dep is already achieved.

**The scheduler gates and degrades.** `maybeReplan` runs at episode boundaries — in-loop and once after the drive loops, so advisory discoveries landing with the final node still drain. Pre-gates: no entries → no-op; zero remaining budget → entries stay queued and persisted (a `resume --budget` top-up re-enters the pass); `gn-final` achieved → drain to history (advisory — appending now would ship work the terminal gate never re-verified); `replanCap` 0 or exhausted → drain. Otherwise one attempt with exactly one feedback retry, the guard applied to BOTH attempts; an invalid or fail-closed outcome degrades — entries drain to history, the cap slot is consumed (`replanRuns + 1` on the drained snapshot), and the graph keeps running. A successful install freezes the new baseline: a version collision pauses infra with the baseline message (resume re-enters), a non-domain failure propagates. The default replanner spawn is the same `subagentPlannerSpawn` used for planning, so an unconfigured composition still replans.

**`parallel.ts` re-reads after the boundary hook.** The batch driver computed the runnable set BEFORE the hook; a re-gated Ready final was then dispatched stale — a real bug this issue's tests caught. The runnable set is now re-read from the authoritative snapshot after `hooks.replan()`.

## Alternatives considered

**Replan by editing nodes in place.** Rejected: jxca appends and freezes a new baseline per pass; mutation would break the audit trail and the immutable-v1 invariant.

**Block the graph when the replanner fails.** Rejected: the acceptance and jxca degrade to drain-and-continue — an enhancement pass must never pause a working graph.

**Only in-loop replan, no post-loop hook.** Rejected: discoveries landing with the final node would either be dropped or shipped after the terminal gate — the advisory drain keeps both the convergence and the gate's authority.

## Consequences

- Discoveries fold into the graph as appended nodes with frozen baselines; the pass is capped (`replanCap`), the pre-gates keep the queue honest (budget-exhausted entries stay queued for a top-up), and every failure mode degrades to drain-and-continue — never a pause.
- The empty appendix is a respected answer; the re-gate re-promotes the terminal node so an empty pass cannot strand the graph.
- The parallel driver no longer dispatches a stale runnable set after a boundary hook.
- 227 vitest tests green (22 new) at per-file 100% coverage; lint (staged profile) and host typecheck clean.
- Issue 07 lands the command surface (validated `replanCap`); issue 09 adds the `.dsh/graph.jsonl` project projection and the exclusive lock.
