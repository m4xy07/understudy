Supersession of `title-sponsor / contact` (Meera Shah -> Rahul Desai) is expected to stay missing:
`contact` is multi-valued in the contract, so both values stay active and the newest is current.

Dates: the verifier drops a model deadline that is only the day its cited text was written while the
text states no such date (docs/ARCHITECTURE.md section 4).

## Round 3: two-pass extraction (docs/round3/specs/04_round2_fixes.md section a)

Two things changed, and they are measured separately.

1. **Consolidation by code** (`src/lib/attest/core/consolidate.ts`) runs after either prompt, and
   `comparable` in `rules.ts` reads three things from it: a date or place that names its own event
   ("2026-08-02 (stall)") is compared only with the same event; a room, a repo path, a web address and an
   online service are different kinds of location; a folded "Options: A or B" claim is never compared.
   Two pieces of prose by one person (status, procedure, decision) are versions of each other only when a
   reply links them, or they share a content word and the newer one is not from a weaker source.
2. **The candidate prompt** (`ATTEST_PROMPT=v2`): tuned for recall, 3,000-character batches, header
   times labelled "written", `stance` and `event` per candidate, examples from a made-up garden.

The table is the answer key of this demo (78 planted claims). The Round 2 prompt rows replay the committed
cache, so they have no model variance. The v2 rows are two cold runs with the code frozen (worse run first).

| | Round 2 (main) | r2 prompt + consolidation | v2, worse cold run | v2, better cold run | Target |
|---|---|---|---|---|---|
| Recall | 57.7% (45/78) | 60.3% (47/78) | 73.1% (57/78) | 75.6% (59/78) | 70% |
| Precision, strict | 27.1% (48/177) | 29.5% (49/166) | 24.0% (62/258) | 24.9% (62/249) | |
| Precision on answer-key topics | 47.5% (48/101) | 50.0% (49/98) | 48.8% (62/127) | 51.2% (62/121) | 55% |
| Citation pass rate | 99.3% | 99.3% | 98.2% | 98.1% | 99% or more |
| False conflicts | 5 | 1 | 0 | 0 | 3 or fewer |
| Planted conflicts found | 1/2 | 1/2 | 2/2 | 2/2 | 2/2 |
| Supersessions found | 1/4 | 1/4 | 2/4 | 2/4 | 3/4 |
| Secrets leaked, restricted violations | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| Stand-in tech lead before answers, B · C · K | not re-measured | 5 · 78% · 97% | 6 · 71% · 100% | 6 · 70% · 99% | |
| Extraction calls, cold | 23 | 23 | 28 | 28 | |

**Decision at that point (club only).** The acceptance rule then asked for recall 70%, false conflicts
3 or fewer and supersessions 3 of 4 on the worse of two cold runs. v2 met the first two and found 2 of 4
supersessions, and its citation pass rate (98.1%) was under the 99% guard, so the default stayed the Round 2
prompt with consolidation until the hold-out was measured.

**Final decision (14 Nov 2026, on the hold-out).** One cold run of each variant on the research-group demo,
whose answer key nothing was tuned against (table in docs/eval-notes/lab.md, same text in
docs/EVALUATION.lab.md). The rule, fixed before the runs: v2 becomes the default only with higher recall, no
more false conflicts and zero leaks there. v2 read 72.4% recall against 67.1%, 2 false conflicts against 2,
no leak on either. **v2 is the default.** The Round 2 prompt stays selectable (`ATTEST_PROMPT=r2`, or
`extraction.prompt` in the pack); `ATTEST_CONSOLIDATE=0` gives the bare drafts of either prompt. Both demos
are precomputed for both variants, so either replays from the committed caches.

The club numbers of the final precompute (one cold v2 run on the final code and data, 80 planted claims,
then replayed; the r2 column replays the cache of the earlier default):

| | v2 (shipped, default) | r2 prompt + consolidation (fallback) |
|---|---|---|
| Recall | 77.5% (62/80) | 57.5% (46/80) |
| Precision, strict | 22.9% (64/279) | 25.0% (50/200) |
| Precision on answer-key topics | 41.6% (64/154) | 37.3% (50/134) |
| Citation pass rate | 98.8% | 98.5% |
| False conflicts | 1 | 2 |
| Planted conflicts found | 1/3 | 2/3 |
| Supersessions found | 1/4 | 1/4 |
| Secrets leaked, restricted violations | 0, 0 | 0, 0 |
| Stand-in tech lead before answers, B · C · K | 4 · 76% · 100% | 6 · 72% · 97% |
| Stand-in new member before answers, B · C · K | 5 · 74% · 100% | 6 · 71% · 97% |
| Blocking gaps against the 7 planted | 4 open, all 4 planted | 6 open |
| Claims (active, conflicting, superseded) | 396 (335, 4, 57) | 320 (283, 5, 32) |
| Extraction, cold | 31 batches, 553 s | 25 batches (replayed) |

Stated plainly: on this run v2 finds fewer supersessions and planted conflicts than the two cold v2 runs in
the table above (1 of 4 and 1 of 3 here), precision on answer-key topics is under the 55% target, and the
citation pass rate is under 99%. The stand-in reads 4 blocking gaps where the answer key plants 7: all 4 are planted,
and three planted ones are not open in this run (the lab booking's next due date, the website form's next
step, the drivetrain order's next step). The answer key grew from 78 to 80 claims and from 2 to 3
planted conflicts with the Round 3 data additions, so the two tables do not share a denominator.

What was still missing in those earlier runs, and why:

- `firmware-deploy / procedure` (USB -> over the air): under v2 both claims are extracted and the reply
  link supersedes the older one, but the evaluator matches the old value by containment and the model
  writes "upload the firmware from the Arduino IDE" where the answer key says "upload from the Arduino
  IDE". Under r2 the older value is not extracted at all.
- `title-sponsor / deadline` (20 Nov -> 27 Nov): found under v2. Under r2 the 20 Nov claim is not extracted.
- `title-sponsor / contact`: by contract, see above.
- Under r2 the one false conflict left is `recruitment / deadline` (8 Aug vs "2 Aug 10:00 to 13:00"): two
  events of one entity, and the Round 2 prompt gives no event words to tell them apart. Under v2 it is gone.
- Per-entity recall under v2: `lab-late-access` 1/3 (was 0/3), `domain-dns` 5/8 (was 6/8), `entry-fee` 2 or 3
  of 4 (was 3/4); every other entity is level or up.

How these numbers were produced: three rounds of two cold v2 runs each (about 8 minutes of extraction per
run with two runs sharing the provider). Round 1 (5,000-character batches, first consolidation) gave recall
66.7% and 69.2% with 15 and 21 false conflicts: a list of who holds which post filed as owners of the
sponsor, one person's statuses compared across sources, and venue options written as one location. The
consolidation rules were then extended using those two runs. Round 2 (3,000-character batches, sharper
wording on updates and cadences) gave 74.4% and 73.1% with 4 false conflicts, all one pair (the college
versus a hall still under discussion); the hedge and listed-option rules came from that. Round 3 is the
table above: fresh cold runs, no code change afterwards. The rules were written on this answer key, so
the research-group demo is the hold-out that says whether they generalise.

Example values are no longer copied as facts under v2: its examples describe a made-up garden, and a
candidate whose value repeats one is dropped by code (none did in the last four runs; two did in round 1).
Under r2, `2026-12-05` and "USB port drops during flash" still echo the Round 2 examples.
