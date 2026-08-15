# 04 — adversarial verifier and bounded worker rounds

**What to build:** Verification per node: after a `done` report, an adversarial verifier child (one-shot spawn on the worker's workspace — a read-only tool filter where the provider supports it, prompt contract otherwise) receives the node objective as the contract to judge and the worker's summary as data to audit, and returns `{ verdict: achieved | not_achieved, gaps, discovered }`. `achieved` settles the node Achieved; `not_achieved` with gaps re-enters the worker: rounds ≥ 2 continue the SAME child through the continuation manager (context and workspace preserved) with the gaps appended to the prompt, bounded by the nodeRounds config; cap exhaustion fails the node naming the last gaps. An errored verifier run is `not_achieved` (an unverified claim never passes); a rejection without gaps is rejected as invalid; a missing verdict is fail-closed. `discovered` entries from both roles queue for issue 06.

**Blocked by:** 03 — serial node execution and budget cascade

**Status:** resolved

- [x] `achieved` settles Achieved; one rejection iterates the same worker child (continuation, not a fresh spawn) with exactly the named gaps; the rounds cap fails the node with the last gaps.
- [x] An errored or schema-invalid verifier result never passes; a gap-less rejection is itself rejected.
- [x] The verifier runs read-only under a tool filter where supported and by prompt contract otherwise.
- [x] Worker `discovered` entries and verifier `discovered` entries both queue as pending discovery records checkpointed to the log.

## Resolution

`verifier.ts` ships the adversarial check: the `VERIFIER_OUTPUT_SCHEMA` capture schema, the ported skeptic contract (re-run the decisive checks yourself; an unverifiable claim is a gap; read-only by contract) rendered with the node contract and the worker summary as data to audit, and a strict outcome split — `achieved`, `rejected` (gaps required; a gap-less rejection is itself invalid), `fail-closed` (missing verdict, unknown verdict, or an errored child never passes). The verifier spawn carries the `VERIFIER_TOOL_FILTER` deny-list (write/edit, delegation, and runtime tools denied; `bash` kept so the decisive checks can re-run — the rest of the read-only contract is prompt-enforced). `serial.ts`'s node episode becomes the bounded round loop: worker round 1 → verifier → `not_achieved` iterates the SAME durable child with exactly the named gaps (round 2+ prompts append the gaps section) → `achieved` settles with the full round count recorded, cap exhaustion fails the node naming the last gaps. `continuation.ts` is the default worker round transport: round 1 `startContinuable`, rounds 2+ `followup` on the same child, each round awaited through the child's `subagent/end` epoch edge (leaf workers — delegation tools denied — settle their epoch per turn); the report travels as the strict `REPORT:` JSON envelope in the child's final output, parsed fail-closed (the continuation manager's composition does not carry the structured capture into later rounds; the envelope preserves the anti-spoofing property — the summary cannot change the status field). The `workerRound`/`verifierSpawn` config seams script rounds without a model; `nodeRounds` (default 3) bounds the loop. Interrupted episodes (pause/clear) demote the in-flight node on the authoritative snapshot at every await boundary; the no-usage-recording budget check moved before the settlement so the node demotes while running.

Coverage: 149 vitest tests green (49 new for this issue) at per-file 100% on the scheduler sources — verifier parse matrix, envelope parsing (last-line-wins, malformed), the transport (same child across rounds, foreign end events ignored, aborted waits, non-completed rounds), round iteration with gaps, cap exhaustion, pause during verifier and during round 2, and the tracker's round recording on failures. Lint clean.

## Notes

- `settleFailed` now records the settled round count for audit, matching achievements; retry keeps rounds across resets.
- The `REPORT:` envelope is the continuation transport's report channel; the one-shot seams still parse the structured capture. A real-stack integration with the continuation manager's structured setup contribution is deferred with the llm-mock-server work.
- Issue 05 reuses the worker round mechanics for parallel batches and adds the workspace override (worktrees).
