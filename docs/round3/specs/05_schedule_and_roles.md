# 05. Schedule and roles for the 72 hours

Planning document only. No product code, workflow file, migration or test is written before the
window opens.

**Window:** 23:59 IST Fri 13 Nov 2026 to 23:59 IST Mon 16 Nov 2026.
**Team DRACONIX:** Aman Shaikh (team lead), Advait Dikshit, Om Manish Vibhute, Yash Mahajan.

Hours below count from the opening. For reading ease the table rounds 23:59 to midnight:
hour 0 is Sat 00:00, hour 24 is Sun 00:00, hour 48 is Mon 00:00, hour 72 is Mon 23:59.

This file refines the "Order of work" table in `ROUND3_PLAN.md`. Where they differ, this file is
the newer one. The main differences: a staging rehearsal at hour 36 before production is touched,
a fixed prompt and data freeze at hour 40, and two production deploys, not one.

---

## 1. Before the window (allowed: no product code)

Only reading, deciding and account access. If in doubt about any item, ask the organisers.

- Everyone reads `ROUND3_PLAN.md` and the specs in this folder.
- Everyone has their own GitHub account added to the repository, and git on their machine set to
  their own name and email. Round 2 commits carry one identity. Round 3 commits must show who
  did what, because rule 18 asks each member to state their part.
- Everyone can run the Round 2 app locally (Node 20, pnpm 10, Docker). This is running existing
  code, not building.
- Aman checks the OpenRouter credit and that `qwen/qwen3-32b` is still served. OpenRouter retired
  the 8B model in October with little notice.
- Decide the five open questions at the end of `04_round2_fixes.md`.
- Agree the sleep windows below. A tired team ships bugs at hour 60.

---

## 2. Fixed points

| Point | Hour | Clock (IST) | What it means |
|---|---|---|---|
| Kickoff | 0 | Sat 00:00 | Tag the Round 2 state. Record the baseline numbers. |
| Foundations merged | 4 | Sat 04:00 | Pack refactor, CI and all migrations are on main and green. |
| Demo data freeze 1 | 20 | Sat 20:00 | Club demo plants (sensitive cases, probes, CI run history) are on main. Extraction baseline is re-measured. |
| Cache rehearsal | 34 to 36 | Sun 10:00 to 12:00 | First full precompute on main, both packs, to learn the time and the failures. |
| Feature merge deadline | 36 | Sun 12:00 | All three improvements merged. Cut decision 1. |
| Staging rehearsal | 36 to 38 | Sun 12:00 to 14:00 | Full walkthrough of both settings on a preview deployment. |
| Prompt and data freeze | 40 | Sun 16:00 | No more changes to prompts, pack entities, batch size or demo data. Extraction decision is final. |
| Final precompute | 40 to 43 | Sun 16:00 to 19:00 | Both packs, cold run then replay check, evaluation, cache committed. |
| Production deploy 1 | 43 to 45 | Sun 19:00 to 21:00 | Migrations, deploy, seed the cache, verify, e2e on the live link. |
| Cut decision 2 | 56 | Mon 08:00 | Anything not working is cut or labelled. No new features after this. |
| Emergency precompute slot | 58 to 60 | Mon 10:00 to 12:00 | Used only if a blocker fix had to touch a prompt or the data. |
| Production deploy 2 (final) | 62 to 63 | Mon 14:00 to 15:00 | The submission candidate. |
| Code freeze | 68 | Mon 20:00 | Final commit and tag. Nothing is pushed, deployed, migrated or seeded after this. |
| Submit | 68 to 70 | Mon 20:00 to 22:00 | Team form and each member's own entry. |
| Buffer | 70 to 72 | Mon 22:00 to 23:59 | Nothing planned. One last look at the live link from a phone. |

**When the demo cache is re-precomputed:** hour 20 (club pack, after the plants), hours 34 to 36
(rehearsal, both packs), hours 40 to 43 (final), and hours 58 to 60 only in an emergency. One
person (Aman) runs every precompute and commits the cache file, so the large JSON never has a
merge conflict. Between those points, anyone who changes a prompt, a pack entity or demo data
tells Aman in the team chat.

**When production is deployed:** hours 43 to 45 and hours 62 to 63. Before hour 43 the live
link stays on the Round 2 build, which is known to work. Every pull request gets a Vercel
preview from hour 4 on.

**Deploy gate (both deploys).** A deploy is done only when all of these are true:

1. CI is green on the commit.
2. Migrations ran on production and were additive.
3. The cache is seeded and a fresh demo of each setting reads all its batches from the cache
   (the Connect run panel says "N from the cache" with N equal to the total).
4. The Playwright suite passes against the live link, twice.
5. The previous deployment is still listed in Vercel for instant rollback.

---

## 3. Hour-by-hour plan

Sleep is in the plan on purpose. Common sleep windows make the stand-ups work.

### Day 1: Saturday (hours 0 to 24)

| Hours | Clock | Aman | Om | Advait | Yash | Gate at the end |
|---|---|---|---|---|---|---|
| 0 to 1 | 00:00 to 01:00 | Kickoff with all. Tag Round 2. Run tests, e2e and the evaluation twice; write down the baseline. Create branches. | Same kickoff. Save the two baseline evaluation runs. | Same kickoff. | Same kickoff. | Baseline numbers written in the team log. |
| 1 to 4 | 01:00 to 04:00 | All Round 3 migrations in one numbered set (improvements and fixes). Staging database if we have one. | Pack refactor with Advait: role keys and the approver label move into the pack (29 literals in 20 files). | Pack refactor with Om. Leads it. | CI workflow (fix e): lint, types, tests with Postgres, leak suite, build, local e2e. | **Integration point 1.** Main is green in CI. Judge path e2e passes. Everyone rebases on it. |
| 4 to 9 | 04:00 to 09:00 | Sleep | Sleep | Sleep | Sleep | |
| 9 to 9.5 | 09:00 | Stand-up, 15 minutes: what each person builds first, which shared types change today. | | | | |
| 9.5 to 14 | 09:30 to 14:00 | Collaboration graph from metadata only, tests first (`tether/graph.ts`). Then the demo plants: medical excuse, fee dispute, CI run history. | Fix (a) step 2a: consolidation rules and `comparable` changes, tests first, with hand-written candidates. | Fix (f): the shared "statement from a person" path and the scoped re-test. Recovery ladder skeleton (`lacuna/recovery.ts`). | Sensitivity rules, stage one, tests first (`tether/sensitivity.ts`). Policy for conflict flags and graph edges. | Unit tests green on each branch. |
| 14 to 15 | 14:00 to 15:00 | Lunch, then a 20-minute sync. **Integration point 2:** one pull request with every change to `src/lib/types.ts` (new trust label, stance and event fields, recovery step and finding types). Merged before anyone goes on. | | | | Shared types on main. |
| 15 to 20 | 15:00 to 20:00 | Trace reader, tests first (`tether/traces.ts`). Fix (b) slice budget and lease. | Finish 2a. Verify trace-derived claims with Aman (exact quote against the cited file or commit). Fix (a) prompt and schema version 2. | Ladder routing: rungs, neighbour questions built only from what that neighbour may see, scoring rules (second-hand and inferred raise C, not K; ranked options give nothing). | Sensitivity wired into ingest before storage. "Sensitive content" panel. Approver-only widen with a written reason and an audit row. | **Integration point 3.** Sensitivity at ingest and the demo plants merged to main. |
| 20 to 21 | 20:00 to 21:00 | Dinner. Aman runs the club precompute on main. Om runs two cold evaluations: this is the new baseline, because the plants changed the WhatsApp batches. | | | | **Demo data freeze 1.** New baseline written down. |
| 21 to 24 | 21:00 to 00:00 | Ask page with Advait: the "can't be reached" switch, the three rungs, the before and after panel. | Fix (a): cold runs, one change at a time, by the accept rule. | First weeks page. Findings into their own review group. | Leak grid: new surfaces. `probes.json` with Aman. Key-term paraphrase probe. | |

### Day 2: Sunday (hours 24 to 48)

| Hours | Clock | Aman | Om | Advait | Yash | Gate at the end |
|---|---|---|---|---|---|---|
| 24 to 28 | 00:00 to 04:00 | Finish fix (b) with progress counts. Fix (d) cleanup route and function. | Research-group pack and corpus with its own planted answer key. Lands as a pull request that touches only `packs/`, `data/` and `tests/`. | Snapshot v2 with a stored diff and the "What changed" panel. | Model judge for probes (can only add findings). Probe results page. Start fix (c) token library and tests. | Each improvement works end to end on its branch. |
| 28 to 33 | 04:00 to 09:00 | Sleep | Sleep | Sleep | Sleep | |
| 33 to 33.5 | 09:00 | Stand-up. Merge order agreed: Improvement 2, then 1, then 3. The lab pack goes last, as data only. | | | | |
| 33.5 to 36 | 09:30 to 12:00 | Merge Improvement 1. Rehearsal precompute on main, both packs. | Fix (a) continues. Lab pack pipeline test and the no-setting-literals check green. | Merge Improvement 3 (findings, First weeks, v2). | Merge Improvement 2 (rest of it). Leak grid covers every new surface from 1 and 3. | **Integration point 4: feature merge deadline.** Main has all three improvements. CI green. **Cut decision 1.** |
| 36 to 38 | 12:00 to 14:00 | **Staging rehearsal.** Preview deployment through the real pooler. Aman and Yash walk the club setting; Om and Advait walk the research-group setting. Each pair tests the parts the other pair built. One shared bug list, sorted: blocker, should fix, leave. | | | | Bug list with owners. |
| 38 to 40 | 14:00 to 16:00 | Lunch. Blocker fixes. Fix (g2) upload limit, (g3) spend cap. | Fix (a) final runs and the decision. Hold-out check on the lab answer key. | Blocker fixes. Fix (g5) end-to-end numbers. | Blocker fixes. Fix (g1) read-back warning. | **Prompt and data freeze.** Extraction decision written down with both runs. |
| 40 to 43 | 16:00 to 19:00 | **Final precompute**, both packs: cold run, replay check, export, commit. | Evaluation for both packs from the new cache. EVALUATION.md regenerated. Thresholds file for the CI gate. | New Playwright specs: recovery, finding to v2. | Fix (c) join route, session gate, Team panel. New Playwright specs: sensitive panel, probes, lab demo. | Cache committed. Evaluation gate green. |
| 43 to 45 | 19:00 to 21:00 | **Production deploy 1.** Dump the production database first. Migrate, deploy, seed, verify the gate. | Watches the evaluation page and both demos on live. | Runs e2e against live, twice. | Checks every page at phone width and for console errors. | Deploy gate passed, or rolled back to Round 2. |
| 45 to 46 | 21:00 to 22:00 | Dinner | | | | |
| 46 to 50 | 22:00 to 02:00 | Full judge walkthrough on the live link, both settings, in fresh private windows. Each person walks a path they did not build. Fix what breaks. Start the documents: Aman README and ARCHITECTURE; Om EVALUATION and the extraction write-up; Advait JUDGE_GUIDE for the new steps; Yash TESTING and the probe write-up. | | | | Manual check table filled in with real results. |

### Day 3: Monday (hours 48 to 72)

| Hours | Clock | Aman | Om | Advait | Yash | Gate at the end |
|---|---|---|---|---|---|---|
| 50 to 56 | 02:00 to 08:00 | Sleep | Sleep | Sleep | Sleep | |
| 56 to 56.5 | 08:00 | Stand-up. **Cut decision 2.** Anything not working is cut or labelled as partial. No new features from here. | | | | Final scope list. |
| 56.5 to 60 | 08:30 to 12:00 | Updated PDF, first full draft. Change-of-plan section. Emergency precompute only if needed. | Completed-improvements list: evidence for Improvement 3 (lab pack) and the extraction numbers. | Evidence for Improvements 1 and 3 (findings). Last bug fixes in Lacuna. | Evidence for Improvement 2. Last bug fixes in Relay and the interface. DISCLOSURES update. | Every "done when" has its evidence or an honest "not done". |
| 60 to 62 | 12:00 to 14:00 | Lunch. Record the demo video on the live link if the format asks for one (shot list in `06_submission_checklist.md`). Others: contribution statements, first draft, each person writes their own. | | | | Raw video. Four draft statements. |
| 62 to 63 | 14:00 to 15:00 | **Production deploy 2, the final candidate.** Same gate. | e2e against live, twice. | Manual check table, last pass. | Leak grid and probe page on live, both settings. | Deploy gate passed. |
| 63 to 66 | 15:00 to 18:00 | PDF final. Technical details text. Reads every statement against the git log and pull requests. | Testing notes with Yash. Reads Advait's statement. | Reads Om's statement. Judge guide final. | Testing notes with Om. Video edit if there is one. | All documents cross-read by someone who did not write them. |
| 66 to 68 | 18:00 to 20:00 | Last fixes to documents only. Final commit, tag, freeze. | Clone the repository fresh, follow the README from zero, run the tests. | Open every link in the submission from a private window. | Same on a phone. | **Code freeze at hour 68.** |
| 68 to 70 | 20:00 to 22:00 | Submit the team entry. | Submit own entry. | Submit own entry. | Submit own entry. | Four entries submitted. Screenshots of each confirmation. |
| 70 to 72 | 22:00 to 23:59 | Buffer. No pushes. | | | | |

---

## 4. Dependency map

What must land before what. "A before B" means B is blocked or its numbers are wrong without A.

| Before | After | Why |
|---|---|---|
| Pack refactor (role keys and approver label into the pack) | Improvement 3 lab pack; fix (c) invites; Improvement 2 sensitivity map; Improvement 1 neighbours | It touches 20 files. Done first and alone, or every branch conflicts with it. Invites and the sensitivity map read roles from the pack. |
| Fix (e) CI | Everything | Every later merge goes through it. The leak job and the literals job are how two "done when" lines are proved. |
| All migrations, numbered by one person | Every branch | Two branches must never claim the same migration number. |
| Shared types pull request (hour 14) | All four lanes | `types.ts` is the only shared type file. One merge, early. |
| Improvement 2 at ingest, plus the demo plants | Fix (a) measurements | Sensitivity narrows role sets before extraction. Batches group by role set, so the batches, the cache keys and the evaluation numbers all move. Extraction is measured only after this lands (hour 20). |
| Fix (a) prompt with neutral examples | Improvement 3 "zero core code changes" | The Round 2 prompt names Priya and the robotics setting in core code. The literals check would fail on it. |
| Improvement 3 lab answer key | Fix (a) final accept | It is the hold-out set. |
| Fix (f) shared statement path and scoped re-test | Improvement 1 neighbour answers; Improvement 3 findings | A leaver answer, a neighbour answer and a successor finding are the same operation with a different trust label. Build it once, by hour 14. |
| Improvement 1 trace reader (Aman) | Trace claim verification (Om) | Om needs real trace output to verify against the cited file or commit. Agree the trace step shape at the hour 9 stand-up. |
| Fix (b) resumable run | Fix (a) pass 2b and pass 3; Improvement 2 model stage on uploads | Both add model calls. On an uncached upload they push a run past 5 minutes. The sensitivity model stage must be a pipeline step, not part of the 60 s upload request. |
| Fix (c) invite links | Fix (d) cleanup rules | The cleanup must never delete a locked team workspace. |
| Improvement 3 living handover | Fix (d) cleanup rules | A First weeks page is useless if the workspace is deleted after 7 days. Workspaces with a snapshot are kept. |
| Every new page or output (ladder, graph, neighbour questions, traces, First weeks, What changed, invite panel) | Improvement 2 leak grid and probes | The "done when" says every output. Rule: no new surface merges without an entry in the leak check. Yash reviews for this. |
| Prompt and data freeze (hour 40) | Final precompute | The cache key holds the exact prompt. A later change makes the live demo run uncached, which took 4.5 minutes in Round 2. |
| Final precompute | Production deploy 1 | Never deploy new prompts without their cache. |

Two files have two natural owners. To avoid collisions:

- `src/lib/attest/core/rules.ts`: Om only. Yash's rule "a conflict flag is shown to a role only if
  it can see both sides" lives in the Relay compile and view layer, not in the rules.
- `src/lib/lacuna/index.ts`: Advait only. Aman's recovery pieces live in `tether/` and are called
  by Advait's ladder.

One more link worth knowing: the trace reader may produce claims the extractor missed (for
example the planted "GitHub Actions builds the firmware on every push"). Report those in a
separate line of the evaluation. Do not fold them into extraction recall.

---

## 5. Risks and fallbacks

| # | Risk | How we would notice | Fallback |
|---|---|---|---|
| 1 | The extraction change does not beat the baseline, or the two runs disagree | The accept rule fails at hour 40 | Ship the code-only consolidation with the Round 2 prompt. Report the measured numbers as they are. |
| 2 | The live demo runs uncached after a deploy | Deploy gate item 3 | Re-seed the cache. If still cold, roll back in Vercel. |
| 3 | OpenRouter is down, out of credit, or retires the model | Precompute fails; HTTP 402 or 404 | Wait for the hour 58 slot. If still down: `EXTRACT_VERSION=1` and the last complete cache. The cached demo needs no model. Top up before hour 0. |
| 4 | The pack refactor causes merge conflicts everywhere | Rebase pain after hour 4 | It is done first, alone, and merged before branches start. |
| 5 | A production-only bug, like the pooler hang in Round 2 | Staging rehearsal at hour 36, through the real pooler | Fix before hour 43. Otherwise the live link stays on the last good build. |
| 6 | A migration breaks production data | Deploy 1 | Migrations are additive. Database dump before deploy 1. Vercel rollback to the Round 2 build still works against the new schema. |
| 7 | The sensitivity rules narrow too much and the new member's demo looks empty | Walkthrough at hour 36 | Rules-only stage with a tighter word list. The approver's widen action is the designed escape. |
| 8 | Paraphrase probes miss some reworded facts | Probe results | That is an allowed result. The "done when" asks for the results written up, caught and missed. Never hide a miss. |
| 9 | "Zero core code changes" fails late because of a hidden literal | The literals check | It runs in CI from hour 4. A stub lab pack runs the pipeline by hour 24. |
| 10 | Contribution statements do not match the record | Aman's read at hour 63 | Each member commits under their own identity from hour 0 and keeps a short work log. Statements are written from the log. See section 7. |
| 11 | A member is ill or offline | Stand-ups | Review pairs double as backups: Aman and Advait on Improvement 1, Yash and Aman on Improvement 2, Advait and Om on Improvement 3. |
| 12 | Too much scope: three improvements and seven fixes | Cut decisions at hours 36 and 56 | The cut order in `04_round2_fixes.md`. The three improvements are never cut for a fix. |
| 13 | A new feature breaks the Round 2 judge path | e2e on every pull request | The seven steps and their labels do not change. Revert the offending merge. |
| 14 | Fix (c) weakens a permission check | Its tests; the RLS suite | It merges last and is first in the cut order. Open mode is the old behaviour unchanged. |
| 15 | We told judges the trace reader would use "CI runs" (Round 2 field 13) and the plan has only workflow files | Now | Add a small synthetic run history to the demo GitHub export and read it in the trace reader. Or state the change under "changes of plan". Decide at kickoff. |
| 16 | The submission format is announced late or asks for something unplanned | Organisers' message | Everything in `06_submission_checklist.md` is ready by hour 66. Two hours of buffer after submitting. |
| 17 | The cleanup job deletes a workspace a judge is using | Dry run count | 14-day retention during judging. Dry mode first. The cron is the last thing switched on, or left off. |
| 18 | The cache JSON conflicts between branches | Git | One person runs every precompute and commits the file. |
| 19 | A judge uploads a large file and the run looks stuck | Manual check | Fix (b) progress and slices. The upload page already warns that live runs take minutes. |
| 20 | Fatigue causes a bad push near the end | Clock | Freeze at hour 68. Deploy 2 at hour 62. Only documents change after hour 63. |

---

## 6. Who owns what

This follows the Round 1 and Round 2 ownership. Owner means: decides the design within the spec,
directs the build (including the AI coding tools), reviews every line that merges into their
module, runs its tests, and can explain it to a judge without notes.

| Member | Module | Round 3 lead | Fixes |
|---|---|---|---|
| Aman Shaikh | Tether, data, pipeline | Improvement 1 (recovery) | (b) resumable runs, (d) cleanup, (g2), (g3), (g7). Release: migrations, precompute, deploys, submission. |
| Om Manish Vibhute | Attest, evaluation | Second setting pack (Improvement 3, with Advait). Verification of trace-derived claims (Improvement 1). | (a) extraction accuracy, (g6), the evaluation gate. |
| Advait Dikshit | Lacuna | Improvement 3 (living handover). Gap routing (Improvement 1). | (f) faster re-test, (g5), pack refactor lead. |
| Yash Mahajan | Relay, interface | Improvement 2 (confidentiality) | (e) CI, (c) invite links, (g1), progress UI for (b). |

Every pull request has one reviewer who is not its author. Pairs: Aman and Advait, Om and Yash
by default; the owner of the module touched always reviews.

### Aman Shaikh: team lead, Tether, data, recovery lead

**Owns this round**

- `src/lib/tether/graph.ts`: the collaboration graph from metadata only.
- `src/lib/tether/traces.ts`: procedures rebuilt from workflow files, commit sequences and
  calendar recurrences, with citations.
- `src/lib/tether/sensitivity.ts`, with Yash.
- Demo data: the sensitive plants, `data/demo/probes.json` with Yash, the CI run history.
- `src/lib/pipeline/`: resumable runs. The cleanup route and function.
- All migrations (numbering and merge), every precompute, both production deploys, the team entry.

**Reviews:** the recovery ladder (Advait), fix (a) prompt and pack diff against the answer key
(Om), fix (c) (Yash).

**Should be able to explain to a judge**

- How the graph is built without reading message text, and the test that proves it (same graph
  with the text removed).
- How a neighbour is chosen for a gap and why a neighbour without access sees nothing.
- How a trace step cites its file or commit, and why trace claims are labelled Inferred.
- Why fewer gaps close without the leaver, with the numbers from the before and after panel.
- How a long run continues across function calls and why the cache makes that safe.
- Masking before storage and before any model call (from Round 2).
- The deploy and cache process, and the pooler bug from Round 2.

**Checklist for his own entry**

- [ ] States the modules above and which parts he built with Advait, Om and Yash.
- [ ] Names two or three decisions he made (for example: metadata only, the slice budget).
- [ ] Names one thing that did not go to plan and what he did.
- [ ] Points to his pull requests and commits.
- [ ] Says how AI coding tools were used in his part (see section 7).
- [ ] Describes the team lead work: plan, integration, releases.
- [ ] Matches the team entry and the other three statements.

### Om Manish Vibhute: Attest, verification of trace-derived claims, second setting pack

**Owns this round**

- `src/lib/attest/`: two-pass extraction, `consolidate.ts`, the changes to `comparable`, the
  prompt and schema version 2.
- Verification of trace-derived claims: the exact-quote rule against the cited file or commit;
  what cannot be quoted stays Inferred.
- `packs/lab.json`, `data/lab/` and its planted answer key, with Advait.
- `scripts/eval.ts`, the thresholds file, the evaluation gate, `docs/EVALUATION.md`.

**Reviews:** the trace reader's output shape (Aman), the no-setting-literals check and the lab
pipeline test (Advait), the paraphrase probe matcher (Yash).

**Should be able to explain to a judge**

- The exact-quote rule and why a quote with "not" removed fails (from Round 2).
- Why the first prompt rewrite was reverted, with its numbers.
- What pass 1 and pass 2 each do, and why the model never decides a label, a conflict or a
  supersession.
- Each Round 2 false conflict and which rule removes it.
- The accept rule: two cold runs, the worse run counts, the hold-out pack.
- The final numbers, including what is still missed and why.
- How the research-group pack differs from the club pack, and why adding it changed no core code.

**Checklist for his own entry**

- [ ] States the modules above and the before and after evaluation numbers.
- [ ] Names the decisions he made (for example: stance field, event binding, what was rejected).
- [ ] Says plainly what the extractor still misses.
- [ ] Describes how the lab corpus and answer key were authored, including AI help.
- [ ] Points to his pull requests and commits.
- [ ] Says how AI coding tools were used in his part.
- [ ] Matches the team entry and the other three statements.

### Advait Dikshit: Lacuna, gap routing, living handover lead

**Owns this round**

- `src/lib/lacuna/recovery.ts`: the ladder, rung choice per gap, neighbour questions built under
  the neighbour's role, the rung outcomes, the scoring rules.
- The findings flow: finding to segment to claim with the trust label "Successor found", the
  First weeks page, the re-test, snapshot v2 with its diff and score change text (with Yash for
  the snapshot and review side).
- The shared "statement from a person" path and the scoped re-test (fix f).
- The pack refactor (with Om) and the no-setting-literals check.

**Reviews:** the graph's neighbour scores (Aman), the lab pack (Om), the review group for
findings (Yash).

**Should be able to explain to a judge**

- B, C and K, and why second-hand, inferred and successor-found evidence raises C but not K.
- Why ranked options never close a gap.
- How a gap picks its rungs, and what is stored for each rung.
- The path of a finding: recorded, checked, reviewed, approved, snapshot v2, "What changed".
- Why the re-test is fast now and how he knows a partial re-test equals a full one.
- What "zero core code changes" means, and the check and the commit that prove it.

**Checklist for his own entry**

- [ ] States the modules above and which parts he built with Aman, Om and Yash.
- [ ] Gives the recovery numbers: gaps closed with the leaver and without.
- [ ] Gives the living handover example: the claim added, the gap closed, the score change.
- [ ] Names the decisions he made and one thing that changed from the plan.
- [ ] Points to his pull requests and commits.
- [ ] Says how AI coding tools were used in his part.
- [ ] Matches the team entry and the other three statements.

### Yash Mahajan: Relay, confidentiality lead, interface

**Owns this round**

- Improvement 2: the "Sensitive content" panel, the approver-only widen with a reason and audit
  row, the policies for conflict flags and graph edges, the wider leak grid, paraphrase probes
  (key-term match plus a model judge that can only add findings), the results page in the app
  and in the repository.
- `src/lib/relay/`: findings in review, snapshot v2 (with Advait), stubs.
- Interface consistency across every new page: stepper, chips with a symbol and a word,
  keyboard use, phone width.
- CI (fix e), invite links (fix c), the read-back warning (g1), the run progress display.

**Reviews:** every new output surface, for a leak-check entry; the sensitivity rules (Aman);
the Ask and First weeks pages (Advait).

**Should be able to explain to a judge**

- Why RLS is the boundary: `withRole`, the policy, the stub count from a function that returns
  only a number (from Round 2).
- How a sensitive message in an open channel is narrowed before any model call, and the test.
- Why narrowing is automatic and widening needs the approver and a written reason.
- What a paraphrase probe is, what was caught, what was missed, and why the model judge can only
  add findings.
- Why a conflict flag with one hidden side becomes a stub.
- What an invite link proves and what it does not.
- What CI runs on every push.

**Checklist for his own entry**

- [ ] States the modules above and which parts he built with Aman and Advait.
- [ ] Gives the leak grid size (roles by surfaces, both settings) and the probe results with the
      misses.
- [ ] Names the decisions he made (for example: narrow only, the judge can only add).
- [ ] Says plainly what invite links are not.
- [ ] Points to his pull requests and commits.
- [ ] Says how AI coding tools were used in his part.
- [ ] Matches the team entry and the other three statements.

---

## 7. Contribution statements: the plain rule

Contribution statements must describe what each person actually did. Nothing else.

- AI coding tools, mainly Claude Code, wrote much of the code and documentation under the team's
  direction and review. We disclosed this in Round 2 (form field 10 and `DISCLOSURES.md`). Every
  Round 3 statement says the same, in the member's own words. No statement says or implies that
  a member hand-wrote code that a tool wrote.
- What a member can honestly claim is the work they did: the design decisions, the specs and
  prompts they gave the tools, the code they read and changed, the tests they ran, the bugs they
  found, the data they authored, the evaluations they ran, the deploys they made, the documents
  they wrote.
- Round 2 commits carry one git identity. Do not rewrite that history. In Round 3 each member
  commits from their own machine under their own identity, opens their own pull requests and
  reviews others'. Do not commit under someone else's name to make the log look balanced.
- Each member keeps a short work log during the window: time, what they did, link. Statements
  are written from the log, not from this plan.
- If someone's real part differs from the split in section 6, the statement follows what
  happened, and the change-of-plan note says so.
- Judges may ask any member to explain their part. The "should be able to explain" lists above
  are there for that. If a member cannot explain something, they should not claim it.
- Aman reads all four statements against the git log and pull requests at hour 63. Any line the
  record does not support is removed.
