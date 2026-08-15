# Agent Note: Work graph v1 — tracker core, plan gate, session-event persistence

Status: implemented

English | [中文](2026-08-14-workgraph-v1-tracker-gate-persistence.zh.md)

## Problem

The work-graph spec's issue 01 is the deterministic half of a DAG scheduler over agent work: before any planner or worker runs, the vocabulary, the state machine, the plan gate, and durable persistence must exist and be exhaustively testable without a model. The durable format also has to survive issues 02–09 (planner artifacts, worker sessions, discovery provenance, budgets) without a session-log format churn, and the goal family's dual meaning of one name as both a brand constructor and a brand type had to be resolved without renaming the public vocabulary.

## Decision

**Two packages ship the core.** `dsh-workgraph` is the Service Definition: the durable vocabulary (`WorkGraphSnapshot` and its node/history/discovery members), the `workgraph/change` session event, the strict decoder and replay fold, the agent-scoped `workgraph/changed` emit, and the abstract `ctx.workGraph` engine with the `set`/`status`/`pause`/`resume`/`retry`/`clear` surface the later issues implement. `dsh-workgraph-scheduler` is the tracker: canonical `gn-<fnv1a32(slug)>` identity, the ordered plan gate, and pure snapshot transitions that take timestamps explicitly and throw `WORKGRAPH_INVALID_TRANSITION` on illegal moves. `commitWorkGraphChange` is the checkpoint funnel every provider transition will pass through: it appends the whole-value session event and, after it commits, emits the agent-scoped `workgraph/changed` notification through the fused agent dispatcher, so the durable log and the live stream cannot diverge.

**Every change carries the whole snapshot.** The whole-value rule keeps the fold last-wins after strict decode, with identity and monotonicity continuity checks across changes; a clear tombstone resets the fold. Decode is fail-safe by design: an unknown persisted node state restores as `ready` (restored work is re-runnable, never silently done or stuck) and an unknown history kind decodes as `unknown` with the raw kind retained — the same forward-compat posture the session envelope takes with `ignorable`. The full vocabulary (pending discoveries, token budget, replan runs, optional node provenance) is present from day one, so later issues populate fields instead of bumping the change version.

**The gate runs its checks in the spec's fixed order** (shape, non-empty, per-row shape with dependency dedupe, node cap, slug hygiene, uniqueness, non-empty fields, self/unknown deps, planner-order-stable Kahn acyclicity, canonical collision), each rejection naming its precise reason, and the harness — never the planner — appends the final node gated over every planner node. The id mint is injectable so the collision and reserved-final branches are testable without hunting a real FNV collision.

**The brand dual-name follows the goal family's subpath answer.** A same-name value export shadows the star type re-export, so `import type { WorkNodeId }` from the package root binds to the constructor; `dsh-workgraph` exports a `./types` subpath (as `dsh-goal` does) and the scheduler imports its branded types from there.

## Alternatives considered

**Fold the tracker into the Service Definition package.** Rejected: the seam's provider is swappable by design, and keeping the pure state machine beside its future episode driver lets compositions depend on the vocabulary without the implementation.

**Event-sourced per-transition events (node-started, node-achieved…) as the session log record.** Rejected: whole-snapshot changes make replay trivially byte-for-byte, keep the log short, and let the fold validate continuity rather than re-derive transitions; the fine-grained verbs live in the capped in-snapshot history instead.

**Store `verifying` as a durable state.** Rejected: it is a live badge, not a fact; persisting it would make a crash mid-verification ambiguous. It stays out of the durable union, and the fail-safe unknown-state mapping makes any leaked value harmless.

## Consequences

- The transition table, gate ordering, FNV vectors, retry/restore/wedge semantics, and event round-trips are covered by 57 vitest tests at per-file 100% coverage, with no model in the loop.
- `KNOWN_SESSION_EVENT_TYPES` and the persistence catalog include `workgraph/change`, so persistence refuses unknown logs correctly and accepts ours.
- Issues 02–09 implement the engine over this core; the README limitations record the missing provider, projection key, and stream invariant as their entry points.
