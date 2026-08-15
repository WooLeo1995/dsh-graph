# Agent Note: Work graph v4 — adversarial verifier and bounded worker rounds

Status: implemented

English | [中文](2026-08-14-workgraph-v4-adversarial-verifier-rounds.zh.md)

## Problem

Issue 03 settled a node directly from its `done` report — no one audited the work. The adversarial verifier had to gate achievement (an unverified claim is a gap by construction), and a rejection had to iterate the SAME worker child with its context and workspace preserved, bounded by a rounds cap — not a fresh spawn that forgets everything.

## Decision

**The verifier is a one-shot adversarial skeptic.** `verifier.ts` ships the `VERIFIER_OUTPUT_SCHEMA` capture schema, the ported jxca verifier contract (re-run the decisive checks yourself; an unverifiable claim is a gap; missing evidence is a gap; read-only by contract) rendered with the node contract and the worker's summary as data to audit, and a strict outcome split: `achieved`, `rejected` (concrete gaps required — a gap-less rejection is itself invalid), and `fail-closed` (missing verdict, unknown verdict, or an errored child — an unverified claim never passes). The verifier spawn carries the `VERIFIER_TOOL_FILTER` deny-list — `write`/`edit`, delegation (`subagent`/`workflow`/`jobs`/`skill`/`todo`) and the code runtime are denied outright; `bash` stays because re-running the decisive checks (tests, builds) may write artifacts, and the rest of the read-only contract is prompt-enforced. Verifier discoveries queue like the worker's.

**The node episode is a bounded round loop.** `serial.ts` runs worker round 1 → verifier; a rejection iterates the SAME durable child with exactly the named gaps (round 2+ prompts append the gaps section), bounded by the `nodeRounds` cap (default 3); cap exhaustion fails the node naming the last gaps, and `settleFailed` now records the settled round count for audit (retry keeps rounds). Every await boundary checks the abort signal and demotes the in-flight node on the authoritative snapshot, so a pause landing during the verifier or a later round is a resource stop, never a verdict. The no-usage-recording budget check moved before the settlement, so the first-child fail-loud demotes a running node instead of erasing a verdict.

**The continuation transport preserves the child.** `continuation.ts` is the default worker round seam: round 1 `startContinuable`, rounds 2+ `followup` on the same durable child id, each round awaited through the child's `subagent/end` epoch edge (a leaf worker child — delegation tools denied — settles its epoch when its turn completes). The continuation manager's composition does not carry the structured capture into later rounds, so the worker's report travels as the strict `REPORT:` JSON envelope in its final output — last line wins, missing or malformed is unparseable (fail-closed), and the status field cannot be spoofed by the summary any more than in the structured capture. The `workerRound`/`verifierSpawn` config seams script rounds and verdicts without a model.

## Alternatives considered

**Fresh worker spawn per round.** Rejected: the acceptance and the spec both require the same child (continuation, not a fresh spawn) — context and workspace preserved — so round N+1 keeps round N's work.

**Parse the round report from plain final text.** Rejected in favor of the strict envelope: the envelope is a single unambiguous JSON line the parser validates fully, preserving the anti-spoofing property (the summary cannot change the status) and the fail-closed discipline.

**Give the verifier a hard read-only sandbox.** Rejected: `bash` must re-run the decisive checks, which write test artifacts; a hard sandbox would make verification impossible, so the deny-list plus the prompt contract is the only self-consistent posture (as confirmed in the design session).

## Consequences

- A `done` report no longer settles a node: the verifier gates achievement, rejections iterate the same child with named gaps, and the rounds cap bounds the loop — the node's settled `rounds` reflect the true worker-verifier count.
- An errored or gap-less verifier never passes; verifier discoveries queue with the worker's for the replan boundary (issue 06).
- 149 vitest tests green (49 new) at per-file 100% coverage: the verifier parse matrix, the envelope parser, the transport (same child across rounds, foreign end events ignored, aborted epoch waits, non-completed rounds), round iteration with gaps, cap exhaustion, pause during the verifier and during round 2, and round recording on failures.
- The default transport's `REPORT:` envelope is a documented deviation from the structured-capture ideal, confined to continuation rounds; a real-stack integration of the continuation manager's capture setup is deferred with the llm-mock-server work.
