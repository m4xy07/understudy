# 06. Submission checklist for Round 3

Planning document only. The submission format is still to be announced. This list covers what
`ROUND3_PLAN.md` says the organisers ask for: a working link, the repository, an updated PDF, a
completed-improvements list, technical details, testing notes and each member's contribution.
Every member files their own entry (event rule 18).

For each item: what we hand in, and what must exist in the product or the repository to back it.
If the backing does not exist, the item is not ready, whatever the text says.

Everything here is ready by hour 66 (Mon 18:00 IST). Code freeze is hour 68. Submit by hour 70.

---

## 1. One-page summary

| # | Item | Owner | Ready by |
|---|---|---|---|
| 1 | Working link | Aman | Hour 63 (after deploy 2) |
| 2 | Repository | Aman | Hour 68 (final tag) |
| 3 | Updated PDF | Aman, all review | Hour 66 |
| 4 | Completed-improvements list with evidence | One owner per improvement | Hour 60 |
| 5 | Changes of plan | Aman | Hour 60 |
| 6 | Technical details | Aman, with each module owner | Hour 66 |
| 7 | Testing notes | Yash and Om | Hour 66 |
| 8 | Known issues | Om | Hour 66 |
| 9 | Team-member contributions | Each member writes their own | Hour 66 |
| 10 | Demo video, if asked (3 to 4 minutes) | Yash edits, Aman narrates | Hour 66 |
| 11 | Each member's own entry | Each member | Hour 70 |

---

## 2. Working link

**Hand in:** https://understudy-lyart.vercel.app (the same link as Round 2).

**Must exist to back it**

- [ ] Production runs the final tagged commit. The commit hash is in the page footer or README.
- [ ] Both demos open from the landing page with no sign-up: the robotics club and the
      university research group.
- [ ] A fresh demo of each setting finishes in seconds, with every batch read from the cache.
      Check the run panel text for both.
- [ ] The Round 2 judge path still works unchanged: Connect, Claims, Test, Ask, Review, Handover.
- [ ] The Round 3 paths work: the "can't be reached" switch and ladder; the Sensitive content
      panel; the wider leak grid and probe results; First weeks, a finding, snapshot v2 and
      "What changed".
- [ ] The Playwright suite passes against the live link twice in a row, including the new specs.
- [ ] The manual check table in TESTING.md is filled in from the live link, with the date.
- [ ] Every page checked at 375 px wide and for console errors.
- [ ] Opened once from a phone on mobile data and once from a private window on another network.
- [ ] Model credit checked. The spend cap message works. The cached demos need no live model.
- [ ] The Round 2 deployment is still available in Vercel for rollback until the deadline.
- [ ] Nothing is deployed, migrated or seeded after hour 68.

---

## 3. Repository

**Hand in:** https://github.com/m4xy07/understudy, at the tag `round3-final`.

**Must exist to back it**

- [ ] The repository is public and the default branch is the submitted state.
- [ ] Tags: `round2-final` at `05473dd` and `round3-final` at the submitted commit, so a judge
      can diff the two rounds.
- [ ] The first Round 3 commit is dated after 23:59 IST on 13 Nov 2026. The last is before
      23:59 IST on 16 Nov 2026.
- [ ] Round 3 commits carry each member's own git identity. Round 2 history is not rewritten.
- [ ] CI is green on the final commit, with the badge in the README.
- [ ] README updated: both demos in "Try it in 5 minutes", the new steps, the new trust label,
      the "Round 3 commitments" section turned into "Round 3: what we delivered" with links.
- [ ] `docs/JUDGE_GUIDE.md` has a click path for each improvement and for the second setting.
- [ ] `docs/ARCHITECTURE.md` updated first where the contract changed (new trust label, stance
      and event fields, sensitivity, recovery steps, access modes, resumable runs).
- [ ] `docs/EVALUATION.md` regenerated from the final cache, with both packs.
- [ ] `TESTING.md` updated (see section 8).
- [ ] `DISCLOSURES.md` updated for Round 3: the build window statement, AI assistance, any new
      library with its licence, any new service, the new synthetic data and planted cases.
- [ ] `.env.example` lists every new variable (invite key, cron secret, spend cap, extraction
      version).
- [ ] A fresh clone follows the README from zero to a running demo and green tests. Om does this
      at hour 66 on a clean folder.
- [ ] No real secret anywhere. The planted fake secrets are still labelled as fake.
- [ ] A licence file, if the team chose one.
- [ ] `data/demo/model_cache.json` and the lab cache are the ones the final deploy was seeded from.

---

## 4. Updated PDF

**Hand in:** one PDF on Google Drive, link set to "anyone with the link can view". Test the link
in a private window.

**Suggested contents, about 8 to 10 pages**

1. What Understudy is, in three sentences, and the two links.
2. What we promised in Round 2, word for word: the three improvements and their "done when".
3. One page per improvement: what a judge sees, how it works, the evidence (section 5 below).
4. Round 2 issues fixed, as a before and after table.
5. Changes of plan (section 6 below).
6. Architecture in one diagram, updated.
7. Testing and evaluation in numbers.
8. Known issues, stated plainly.
9. Team and contributions in summary, with the AI tools statement.

**Must exist to back it**

- [ ] Every number in the PDF comes from a file in the repository (EVALUATION.md, TESTING.md) or
      a screen on the live link. No number is typed from memory.
- [ ] Every screenshot is taken from the live link after deploy 2.
- [ ] The architecture diagram matches README and ARCHITECTURE.md.
- [ ] The "done when" lines are copied exactly from Round 2 form field 13.
- [ ] Voice: plain, short sentences. Someone who did not write it reads it once.

---

## 5. Completed-improvements list, with evidence tied to each "done when"

One row per clause of each "done when". A clause is done only when its evidence exists. If a
clause is partly done, write "partly" and say what is missing.

### Improvement 1: Unreachable-leaver recovery (owner of the evidence: Advait, with Aman)

Done when (Round 2 form): with the switch on, the same gaps reach a teammate and a trace, fewer
of them close than when the leaver answers, and every answer carries its weaker trust label.

| Clause | Evidence to hand in | Must exist in the product or repository |
|---|---|---|
| A "leaver unreachable" switch | Screenshot of the Ask page with the switch on; the audit log line | The switch, approver only, stored on the workspace, logged. A test that a non-approver cannot flip it. |
| The same gaps reach a knowledge neighbour | A table: gap, neighbour picked, why picked, asked or skipped | `tether/graph.ts`, the ladder in `lacuna/recovery.ts`, the `recovery_steps` rows. The demo lets a judge switch to a neighbour and answer. |
| Built from metadata only | The test name and its result | The test that builds the same graph with message text removed. |
| A neighbour is asked only about what their role can see | The "skipped: no access" rung on screen; the test name | The test that a neighbour without access is skipped and sees nothing. Leak grid rows for neighbour questions and the graph. |
| The same gaps reach a trace | A rebuilt procedure on screen, each step with its citation | `tether/traces.ts`. Attest verifies each trace claim against the cited file or commit. |
| Fewer close than when the leaver answers | The before and after panel: gaps closed with the leaver and without, on the same gap set, with B, C and K for both | The panel on the Ask page. An end-to-end test that asserts fewer close in the unreachable run. The two numbers in TESTING.md. |
| Every answer carries its weaker label | Screenshots of Second-hand, Inferred and Ranked options chips | Tests: Second-hand and Inferred never raise K; ranked options never close a gap. |
| Trace sources as promised | A line saying which sources the trace reader uses | Either the CI run history is in the demo export and used, or the change is in section 6. |

### Improvement 2: Content-level confidentiality (owner of the evidence: Yash, with Aman)

Done when (Round 2 form): the wider leak test passes for every role and every output, including
restricted notes and conflict flags, and we've written up the results of the reworded-fact tests.

| Clause | Evidence to hand in | Must exist in the product or repository |
|---|---|---|
| Sensitive content in an open channel is narrowed before extraction | The "Sensitive content" panel showing the planted medical excuse and fee dispute, each with its reason and narrowed roles | `tether/sensitivity.ts`. The planted cases in the demo data. The test that no model call holds a narrowed segment for a wider role set. |
| Only the approver can widen, with a logged reason | The widen dialog and the audit log line | The action, the audit row, the test that other roles are refused and that an empty reason is refused. |
| The wider leak test passes for every role and every output | The Leak check grid: "All N checks pass", with N written as roles times surfaces, for both settings | The grid lists every surface: handover sections, read-back form, stubs (the restricted notes), scores, timeline, questions, export, conflict flags, the collaboration graph, neighbour questions, recovery traces, First weeks, What changed. The same suite runs in `pnpm test` and as the CI leak job. |
| Including restricted notes | The stub on screen for the new member, and its row in the grid | The stub count still comes from the count-only function. |
| Including conflict flags | A conflict with one hidden side shown as a stub | The test that such a flag never reveals the hidden value. |
| Reworded-fact results written up | The probe results page in the app and the same write-up in the repository: facts planted, reworded forms, caught, missed, by role and surface | `data/demo/probes.json`. The probe suite in `pnpm test`. The write-up names every miss and says why. |

### Improvement 3: Living handover and a second setting (owner of the evidence: Advait, with Om)

Done when (Round 2 form): a successor's finding goes through review into the next snapshot with
the score change explained, and the research group setting runs with zero changes to the core code.

| Clause | Evidence to hand in | Must exist in the product or repository |
|---|---|---|
| Open gaps become the successor's checklist | Screenshot of the First weeks page with owners and due dates | The page, fed from the continuation plan. |
| A successor's finding goes through the same checks | The finding on screen with the label "Successor found" | The findings flow: segment, claim, masking, the role set can narrow and never widen. Test: it raises C and not K until a record backs it. |
| Through review | The finding in its own group in the approver's review | The review group. The leaver still cannot approve. |
| Into the next snapshot | Snapshot v2 with its SHA-256 hash next to v1 | The versioned snapshot and the stored diff. |
| With the score change explained | The "What changed" panel: the claim added, the gap closed, the score before and after, the reason | The panel. The end-to-end test from finding to v2 with the explanation text. |
| A research group setting with its own dataset | The second demo button on the landing page; the lab roles and checklists on screen | `packs/lab.json`, `data/lab/` with its own planted answer key, its own cache. |
| Zero changes to the core code | Three things: the green "setting literals" CI check; the lab pipeline test; the pull request that added the lab pack, showing no file under `src/` in its diff | The check that fails on a pack id or role key literal under `src/lib` outside the pack loader. The lab pack lands as its own pull request touching only `packs/`, `data/` and `tests/`. |
| It works, not only runs | The evaluation numbers for the lab pack and its leak grid | EVALUATION.md with both packs. |

### Round 2 issues fixed

| Issue we named in Round 2 | Evidence to hand in | Must exist |
|---|---|---|
| Extraction misses facts | Before and after table: recall, false conflicts, supersessions, precision, per entity | EVALUATION.md from the final cache; the evaluation page; the thresholds file. If the target was missed, the real numbers and the reason. |
| A kickoff date filed under the competition | The rule and its test name | The event-binding rule and its regression test. |
| Re-test takes 10 to 15 s | The measured time before and after | The scoped re-test; the equivalence test; the shorter e2e timeout. |
| Large uploads take minutes and can fail | A run of a large file finishing across slices, with the progress line | Resumable runs; the tests; one manual run on the live link noted in TESTING.md. |
| No sign-up | The Team panel and an invite link in use | Invite links, or a line in section 6 if cut. The honest label: a link is not an account. |
| No CI | The Actions page, green | The workflow and the badge. |
| Old workspaces never cleaned | The cron entry and the keep rules | The route, the function, the tests, or a line in section 6 if cut. |

---

## 6. Changes of plan

The organisers ask us to explain any change. Write this even if it is short. Candidates:

- [ ] Anything from the cut order that was cut, with the reason.
- [ ] Any "done when" clause that is partly done.
- [ ] Trace sources: "CI runs" in the Round 2 form against what the trace reader really reads.
- [ ] Extraction: the target against the result, and which passes shipped.
- [ ] Any change in who did what, against Round 2 field 13.
- [ ] Any new library or service.

**Must exist to back it:** each line matches the repository. A cut feature has no half-built
page left in the app.

---

## 7. Technical details

**Hand in:** about 400 to 600 words, plus the diagram. Cover:

- The stack in one line, unchanged: Next.js 16, TypeScript, Postgres with RLS on Supabase,
  Vercel in Seoul, Qwen3 through an OpenAI-compatible endpoint.
- What is new in each module:
  - Tether: collaboration graph from metadata, trace reader, sensitivity check at ingest.
  - Attest: two-pass extraction, event binding, considered against decided, trace verification.
  - Lacuna: recovery ladder, scoped re-test, findings.
  - Relay: findings in review, snapshot v2 with a diff, wider leak check and paraphrase probes.
  - Platform: setting packs for two settings, resumable runs, invite links, CI, cleanup.
- The rules that did not change: the model proposes and code decides; RLS is the boundary; exact
  quotes; append-only ledgers; nothing a person said is labelled verified.
- The hardest problems of this round and how we solved them (write these from the work log).
- AI assistance, in one plain sentence, with a pointer to DISCLOSURES.md.

**Must exist to back it**

- [ ] `docs/ARCHITECTURE.md` says the same thing.
- [ ] Every file path named in the text exists at the final tag.
- [ ] The model named is the model the live link uses.

---

## 8. Testing notes

**Hand in:** a short summary, with TESTING.md as the full version.

- [ ] The test count at the final commit and the run time (Round 2: 334 tests).
- [ ] What each new suite covers: graph without text, neighbour access, trust labels and scores
      for the ladder, sensitivity before extraction, widen rules, conflict flags, probes for five
      roles across every surface, findings to v2, the lab pipeline, the literals check,
      consolidation rules, resumable runs, invite tokens, cleanup, scoped re-test equivalence.
- [ ] The evaluation table for both packs: recall, precision, citation pass rate, supersessions,
      conflicts, false conflicts, secrets leaked, restricted violations. Before and after for the
      club pack.
- [ ] The probe results, with the misses.
- [ ] The recovery numbers: gaps closed with the leaver and without.
- [ ] The end-to-end result against the live link, pasted with its date.
- [ ] The manual check table from the live link, with the new rows.
- [ ] What CI runs on every push.
- [ ] Known limits, rewritten: remove what is fixed, keep what is still true, add what is new.

**Must exist to back it**

- [ ] `pnpm test` passes on a fresh clone with the README steps.
- [ ] Every number is produced by a command a judge can run, and the command is named.
- [ ] No test calls a live model.

---

## 9. Known issues

Say what is still weak before a judge finds it. Likely lines:

- Extraction still misses some facts; the numbers and where they are.
- Paraphrase probes catch reworded facts by key terms and a model judge; what they missed.
- Invite links prove possession of a link, not identity.
- The hosted demo uses a hosted model; local use with Ollama is still the private option.
- Second-hand and inferred recovery is weaker evidence by design, and is labelled so.
- Anything cut.

**Must exist to back it:** the same list is in TESTING.md under known limits.

---

## 10. Team-member contributions

**Hand in:** a summary table in the team entry, and one statement per member in their own entry.

The rule, stated plainly: contribution statements must describe what each person actually did.
That includes saying that AI coding tools, mainly Claude Code, wrote much of the code and
documentation under the team's direction and review, as we already disclosed in Round 2
(form field 10 and DISCLOSURES.md). No statement claims hand-written code that a tool wrote.
No statement claims work the record does not show.

**Each statement, about 150 to 250 words**

- [ ] The modules the member owned this round.
- [ ] What they did themselves: decisions, specs and prompts to the tools, review, tests run,
      bugs found, data authored, evaluations, deploys, documents.
- [ ] What they built with another member, naming who.
- [ ] How AI coding tools were used in their part.
- [ ] One thing that changed from the plan, or one hard problem.
- [ ] Links to their pull requests and commits.

**Must exist to back it**

- [ ] Round 3 commits and pull requests under each member's own git identity.
- [ ] Each member's work log from the window.
- [ ] The README team table matches the statements.
- [ ] The four statements do not contradict each other or Round 2 field 13. Where the real split
      differs from field 13, section 6 says so.
- [ ] Each member can explain their part without notes (the lists in `05_schedule_and_roles.md`).
      A short practice round at hour 60: each member explains their part to one other in 3 minutes.
- [ ] Aman has read all four against the git log.

---

## 11. Each member's own entry (rule 18)

- [ ] The entry form is found and read by hour 56, so nothing in it is a surprise.
- [ ] Same hackathon name, team name, links and PDF in all four entries. Copy from one shared text.
- [ ] Each member's own contribution statement.
- [ ] Submitted by hour 70. A screenshot of the confirmation in the team chat.
- [ ] Aman checks at hour 70 that four confirmations exist.

---

## 12. Demo video, if asked: 3 to 4 minutes

Screen recording of the live link after deploy 2, 1080p, one voice. No slides except a title
and an end card. Captions on, so it works without sound. Practise once before recording.
Target length 3:40.

| # | Time | On screen | Say |
|---|---|---|---|
| 1 | 0:00 to 0:15 | Title card, then the landing page with two demo buttons | Understudy builds a handover from what the leaver really did, tests it, and shows each role only what it may see. In Round 2 we promised three improvements. Here they are. |
| 2 | 0:15 to 0:35 | Open the robotics demo. Connect finishes in seconds. Claims: click a citation, the quote is highlighted. Test: B, C, K. | The Round 2 flow, quickly: claims tied to exact quotes, and a successor test scored by code. |
| 3 | 0:35 to 0:50 | Ask as Priya. Answer one question. The score moves at once. | Priya answers a gap. The re-test used to take fifteen seconds. |
| 4 | 0:50 to 1:35 | As Club President, switch on "Priya can't be reached". The three rungs for one gap. Switch to Arjun, answer, label Second-hand. A rebuilt procedure labelled Inferred with a citation. Ranked options. The before and after panel. | Improvement 1. If the leaver is gone, each gap goes to the nearest teammate, found from metadata only, then to traces in the repository, then to ranked options. Fewer gaps close, and every result says how weak it is. |
| 5 | 1:35 to 2:20 | Connect: the "Sensitive content" panel with the medical excuse and the fee dispute. Switch to New member: nothing of it appears. Handover: the Leak check grid, all passing. The probe results page with a miss shown. | Improvement 2. A medical note in the open group chat is narrowed before the model sees it. Only the approver can widen it, with a reason. The leak check now covers every output, and reworded facts. Here is what it caught and what it missed. |
| 6 | 2:20 to 3:00 | Review: approve snapshot v1. As Incoming tech lead: First weeks, record a finding. As Club President: approve it. Snapshot v2. "What changed": B 5 to 4, with the reason. | Improvement 3. The handover keeps going. The successor's finding goes through the same checks and review into version two, and the score change is explained. |
| 7 | 3:00 to 3:20 | Landing page. Open the research group demo. Different roles and checklists. The green "setting literals" check on GitHub. | The same core runs a university research group. The pack is data. The core code did not change, and a check enforces it. |
| 8 | 3:20 to 3:35 | Evaluation page: before and after numbers. GitHub Actions, green. | What we fixed from Round 2: extraction accuracy, with the numbers, and CI on every push. |
| 9 | 3:35 to 3:40 | End card: the two links, team DRACONIX, "built with AI coding tools under our direction". | Thank you. |

**Must exist to back it**

- [ ] Every shot is the real product on the live link. Nothing is mocked or sped up without a
      "sped up" caption.
- [ ] The numbers spoken match EVALUATION.md and the app.
- [ ] The probe shot shows a real miss if there is one.
- [ ] The video link opens in a private window. Length is inside the limit the organisers set.
- [ ] If a feature in the shot list was cut, its shot is cut too, and the time goes to shot 8.

---

## 13. Final hour checks (hours 66 to 70)

- [ ] `round3-final` tag pushed. Its commit is the one on production.
- [ ] CI green on that commit.
- [ ] Live link, repository link, PDF link and video link each open in a private window.
- [ ] Both demos run from the cache on the live link.
- [ ] The completed-improvements list has evidence for every clause, or says "partly" or "cut".
- [ ] Changes of plan written.
- [ ] Four statements read against the record.
- [ ] Four entries submitted, four confirmations saved.
- [ ] Nothing pushed, deployed, migrated or seeded after hour 68.
