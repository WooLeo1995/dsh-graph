# 06 — discovery and capped replan

**What to build:** Dynamic replanning: at episode boundaries, pending `discovered` entries (from worker and verifier reports and serial node finals) trigger a replanner child that extends the graph with the fewest additional nodes, each carrying `discovered_from`. Pre-gates: no pending entries → no-op; zero remaining budget → entries stay queued and persisted; `gn-final` already achieved → drain to history (advisory); replanCap 0 → quiet drain; cap exhausted → drain with the convergence message. Install rules: append-only; combined size within the cap; `discovered_from` references existing live nodes and never `gn-final`; deps never target `gn-final`; no dependency on a Failed/Blocked node (dead origins are the normal salvage case); combined-graph acyclicity; `gn-final` re-gated over the additions with a Ready final demoted; plan version bumped, a new frozen baseline written, entries cleared. An empty appendix still consumes a cap slot; one invalid retry, then degrade — entries drain to history, the slot is consumed, and the graph keeps running.

**Blocked by:** 04 — adversarial verifier and bounded worker rounds

**Status:** resolved

- [x] A worker's discovered entry produces an appended node (DiscoveredFrom provenance), plan v2, `gn-final` re-gated, both baselines frozen and v1 untouched, exactly one replanner spawn.
- [x] cap 0 drains entries to history with no replanner spawn and the graph converges; an exhausted cap drains with the convergence message.
- [x] Invalid appendix rules are each rejected with their precise reason; a second failure degrades without pausing the working graph; an empty appendix consumes a slot.

## Resolution

**`replan.ts` owns the pass.** `runReplannerEpisode` renders the replanner contract (`renderReplannerPrompt` — objective, compact live graph, pending discoveries, prior feedback) and spawns the replanner child through the same `PlannerSpawn` seam with its own output schema: `planned` (validated appendix rows canonicalized to `waiting` nodes), `invalid` (precise gate reason), `fail-closed` (child error or missing artifact). `validateAppendix` enforces the row rules in fixed order (artifact shape; per-row shape; slug hygiene; uniqueness; non-empty prose; string deps; no self-deps) — deps may reference EXISTING live nodes, resolved by `replanDependencyGuard` against the current graph (never `gn-final`, never a node that is not live). `installReplan` installs append-only in planner order, re-gates `gn-final` over the additions (a Ready final demotes to waiting; an empty appendix that leaves every dep achieved re-promotes through `promoteReady` so the terminal gate is never stranded), bumps the plan version, clears the entries, and records `replanned`. `drainDiscoveries` is the advisory/quiet degrade: entries to history, graph keeps running.

**`scheduler.ts` gates and degrades.** `maybeReplan` runs at episode boundaries (in-loop and once after the drive loops): no entries → no-op; zero remaining budget → entries stay queued (resume `--budget` re-enters); `gn-final` achieved → drain (advisory, terminal gate already verified); cap 0 or exhausted → drain. Otherwise one attempt with one feedback retry (invalid reason fed back), guarded by `replanDependencyGuard` on BOTH attempts; invalid/fail-closed degrades — entries drain, the cap slot is consumed (`replanRuns + 1` on the drained snapshot), never a pause. A successful install freezes the new baseline (an EEXIST collides as infra pause; a non-domain failure propagates). The default replanner spawn is the same `subagentPlannerSpawn` used for planning, so an unconfigured composition still replans.

**`parallel.ts` re-reads after the hook.** The batch driver computed the runnable set BEFORE the boundary hook; a re-gated Ready final was then dispatched stale (a real bug this issue's tests caught). The runnable set is now re-read from the authoritative snapshot after `hooks.replan()`.

Coverage: 227 vitest tests green (22 new for this issue) at per-file 100% — the pre-gate matrix (no entries, zero budget keeps queued, final-achieved drain, cap-0 quiet drain, cap-exhausted drain), the appendix validation rows, the dependency guard (unknown, reserved final, live), install rules (append, re-gate with Ready demote, empty-appendix re-promote, version bump, discovery clear), the freeze-collision infra pause and the non-domain rethrow, the default-spawn replan path, the degrade path, and the parallel replan boundary. Lint clean (staged profile), host typecheck clean.

## Notes

- The empty appendix is a respected answer, not an error: it consumes the slot and the graph converges on the current plan.
- One invalid retry then degrade, exactly like planning's one-retry discipline — a working graph never pauses because an enhancement pass failed.
- Issue 07 lands the command surface (including validated `replanCap`); issue 09 adds the `.dsh/graph.jsonl` project projection and the exclusive lock.
