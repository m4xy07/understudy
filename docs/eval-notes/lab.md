**This is the hold-out setting.** The research-group pack (`packs/lab.json`) and its corpus were
written after the extraction prompts were fixed on the club data. Nothing was tuned to this answer
key: no alias, example, prompt or planted sentence was changed after the first live run, and the
consolidation rules were written on the club answer key only.

## The extraction variant was decided here (14 Nov 2026)

One cold run of each variant on this demo, one after the other, code frozen, model cache emptied
first (`ATTEST_PROMPT=r2|v2 pnpm tsx scripts/eval.ts --pack lab --scores`). Both run the same
consolidation by code after the model.

| | r2 prompt + consolidation | v2 (two-pass) |
|---|---|---|
| Recall | 67.1% (51/76) | **72.4% (55/76)** |
| Precision, strict | 31.2% (49/157) | 34.4% (53/154) |
| Precision on answer-key topics | 46.2% (49/106) | 46.5% (53/114) |
| Citation pass rate | 97.0% | 99.1% |
| False conflicts | 2 | 2 |
| Planted conflicts found | 3/3 | 2/3 |
| Supersessions found | 2/4 | 3/4 |
| Secrets leaked, restricted violations | 0, 0 | 0, 0 |
| Incoming postdoc before answers, B · C · K | 6 · 71% · 100% | 6 · 69% · 100% |
| PhD student before answers, B · C · K | 6 · 70% · 100% | 6 · 69% · 100% |
| Blocking gaps against the 7 planted | 6 open, all 6 planted | 6 open, 5 planted and 1 not planted |
| Extraction, cold | 23 batches, 279 s | 25 batches, 323 s |

**Decision.** The rule was fixed before the runs: v2 becomes the default only if, on this hold-out,
its recall is higher, it raises no more false conflicts, and nothing leaks. All three hold (72.4%
against 67.1%, 2 against 2, 0 against 0), so **v2 is the default** (`DEFAULT_PROMPT_VARIANT` in
`src/lib/attest/core/schema.ts`). The Round 2 prompt stays selectable (`ATTEST_PROMPT=r2`, or
`extraction.prompt` in a pack) and its answers for both demos are in the committed caches.

What the table also says, against v2: it is one cold run per variant and the recall margin is four
facts; v2 found one planted conflict fewer and its blocking-gap list is one step further from the
planted one. The model is not deterministic between cold runs (the earlier cold r2 run of this
demo read 60.5% recall on the Round 2 code), so a margin of this size is an indication, not proof.

## What the shipped run shows (v2, replayed from the committed cache)

- Recall 72.4% (55 of 76 planted facts) on a source mix the prompts never saw (three Slack
  channels, a repository, a lab notebook, a task sheet, a calendar; no WhatsApp).
- Most misses are facts stated in repository files and notebook entries as part of a longer passage
  (the environment lock, checksum manifests, the unfinished normalisation step) and cadence facts
  ("once a year", "every quarter") that the model files under another attribute or drops.
- Two false conflicts: `qc-pipeline / owner` (the pipeline owner before and after the handover, two
  true facts) and `hpc-allocation / location` (the dataset folder and the allocation documents filed
  as one location). They surface for review; they are not hidden.
- Supersessions 3 of 4 and planted conflicts 2 of 3. Both misses depend on a claim the extraction
  did not produce (`seq-core / deadline = 2026-11-24`, `hpc-allocation / deadline = 2026-12-08`).
- Safety metrics hold with no change for this setting: 0 planted secrets in any claim or stored
  segment, 0 restricted-token violations, citations 99.1% exact.
- Downstream, the stand-in successor (incoming postdoc) reads B 6 · C 69% · K 100%. The answer key
  plants 7 blocking gaps for that role. Five of the six open ones are planted (the pipeline token's
  holder, dataset provenance, the freezer check's next date, the standing order's next date, who
  owns the assembler decision). Not open: the revision's next step (the stand-in reads it as
  covered) and the allocation renewal date (the second date was not extracted, so there
  is no conflict to raise). Open but not planted: the revision's data provenance.
- The sample leaver answer (who holds the sequencing core token) moves B 6 to 5, C 69% to 73%, K
  100% to 95%. The example finding in First weeks (the freezer check is every Monday, next 16 Nov)
  releases snapshot v2 with B one lower (5 to 4 after tier A is approved).
