# Testing

How we test Understudy, ordered by what was tested: rules in isolation, the database boundary, the product in a browser, abuse, extraction quality against planted answer keys, leaks, and an independent code review.

## Totals

From a fresh clone of `main`, following the README, with no model key (2026-11-14, Windows 11, Node 26, local Postgres 16 in Docker):

| Command | Result |
|---|---|
| `pnpm test` | 79 test files, 1025 tests passed, 1 skipped, 67 s. The skipped test needs a Supabase pooler URL (`POOLER_TEST_URL`). |
| `pnpm test:e2e` against `pnpm dev` | 5 spec files, 9 tests passed, 3.2 min, no retry |

`pnpm test` prints the totals on its last lines, so these numbers are easy to check.

## How to run

```bash
pnpm install
pnpm db:up          # Postgres 16 in Docker on localhost:45432
pnpm db:migrate     # the database suites need the schema
pnpm db:seed        # the pack suites replay the committed model answers
pnpm test           # the literal check, then vitest
pnpm test:e2e       # Playwright; needs `pnpm dev` running (see section 3)
```

- Tests read `.env.local`. The README's setup creates it.
- No test calls a live model. `vitest.config.mts` sets `MODEL_DISABLED=1` and `LACUNA_MODEL=off`: the model client answers from the cache or fails fast, and suites that need model answers inject a fake one. Results do not depend on the network.
- Test files run one at a time, because the database suites share one Postgres.

## 1. Unit tests: the rules, with no database

Pure functions with fixtures, in six folders.

| Folder | Files | What it checks |
|---|---|---|
| `tests/tether/` | 11 | Each adapter (WhatsApp, Slack, GitHub, task CSV, Markdown, ICS): parsing, rejected rows with reasons, threads, recurring events. Masking of keys, tokens, passwords, emails and phone numbers; credential names kept, values dropped. Identity merges only on an exact email. Footprint thresholds. The sensitivity classifier: every rule, borderline cases, fail closed, narrowing never adds a role. The collaboration graph gives the same result with all message text removed. The trace reader on workflow files, CI runs and commits. GitHub URL validation. |
| `tests/attest/` | 17 | Batching never mixes role sets. The exact-quote verifier: a quote with "not" removed fails, citations outside the batch are rejected, a claim with no accepted citation is dropped. The support check can only lower trust. Supersession rules 1 to 4, corroboration. Both extraction prompts and the consolidation pass. Prompt injection: segment text cannot fake a header or the end marker. Flag visibility for conflicts with a hidden side. The evaluation page filters its lists by role. |
| `tests/lacuna/` | 10 | Inventory from the board, the footprint and the role template. The stand-in successor: code decides coverage and drops citations to claims that are missing, hidden or superseded. Scores B, C, K. Gap ranking, at most ten, never about restricted checks. The recovery ladder: who is asked, who is skipped, how options are ranked. |
| `tests/relay/` | 11 | Review tiers; tier C needs the evidence opened and a reason. Canonical JSON and the SHA-256 hash. The release rule. Per-role compile and stub text. Read-back parsers. Findings: form rules, fixed evidence layout, narrowing. "What changed": every reason sentence. Canary scanning across case and markup. Probe key-term matching. |
| `tests/pack/` | 5 | The pack loader's rules. Golden hashes: the prompts of both demos, for both extraction variants, are byte-stable, so the committed caches still match. The literal check: core names no setting. The zero-core check from the commit history. |
| `tests/model/` | 2 | The model client in tests: no probe, no network, a fast typed failure on a cache miss; request deadlines. |

Some files in `tests/attest/`, `tests/lacuna/` and `tests/relay/` are integration suites that also use the database.

## 2. Database tests: row-level security and the whole pipeline

These run against a real Postgres (`tests/db/`, 11 files, plus the integration suites above). They are the tests behind "each role sees only what it may see".

**Row-level security is the boundary** (`tests/db/rls.test.ts`, run once per pack)
- A role outside a row's role set reads nothing from `segments`, `claims`, `contacts` or `snapshot_claims`. Rows from another workspace are invisible even with a matching role.
- The policies know no role key: the same fixture passes with the club's roles and the lab's, and a role key of another pack reads nothing.
- `count_withheld()` returns an integer only.
- The reader role cannot write. `claim_events` rejects UPDATE and DELETE; `audit_log` and `acknowledgements` reject UPDATE; segments are immutable.

**Who may do what**
- The leaver can never review or approve; nobody but the approver can. Checked in code and by a database trigger (`tests/relay/snapshot.test.ts`, `tests/relay/integration.test.ts`, `tests/db/pipeline.test.ts`).
- Only the leaver answers gap questions; only the successor records findings; only the approver widens or limits a message (`tests/db/visibility.test.ts`).

**Grants** (`tests/db/grants.test.ts`): the Supabase Data API roles hold nothing in the schema, no function is executable by PUBLIC, every SECURITY DEFINER function has a fixed search path, and `count_withheld()` answers only for the workspace in the request.

**The whole product on each demo, model off, committed cache** (`tests/db/pipeline.packs.test.ts`, 12 tests per pack): every extraction batch replays from the pack's `model_cache.json`; no planted secret is stored; the inventory matches the answer key; per-role handover; the leak check passes for every role; the read-back asks the pack's items.

**Round 3 flows against the database**: recovery (`tests/db/recovery.test.ts`), visibility changes (`tests/db/visibility.test.ts`), the living handover chain from finding to snapshot v2 (`tests/relay/living.integration.test.ts`), and the wiring between the three improvements (`tests/db/round3-wiring.test.ts`).

### The Round 2 production bug, and its regression test

**Symptom.** On the live Vercel deployment, workspace pages sometimes never finished loading. The HTML stream stayed open until the function timed out, and different pages hung at different times. Local runs talk to Docker Postgres directly, with no pooler in between, so they did not show it.

**Cause.** Production reaches Supabase through the transaction pooler (Supavisor, port 6543), because the session pooler allows only 15 clients. postgres.js 4 pipelines up to 100 queries on one connection by default, and Supavisor in transaction mode never answers pipelined queries: the backend waits until its 2-minute statement timeout. A cold page's layout header and Suspense boundary query at the same time, the pool sends both down its first connection as a pipeline, and the boundary never resolves. The stuck connections stayed in the pool and hung later requests on the same instance.

**Fix** (commit `7184910`, `src/lib/db/client.ts`):
- `max_pipeline: 1`: one query in flight per connection.
- `query_timeout: 20` seconds: a pooler that stops answering rejects the query and the pool reconnects, instead of holding the page open.
- `prepare: false` for transaction-mode pooling, and a small pool (`max: 5`).

**Regression test** (`tests/db/pool.test.ts`):
- the shared pool has `max_pipeline` 1 and a positive `query_timeout`;
- six copies of a cold page's query mix (plain reads plus `withRole` transactions) finish within 15 seconds on a 2-connection pool, so a hang fails the test instead of timing it out;
- with `POOLER_TEST_URL` set, three rounds on a fresh pool through the real transaction pooler. This check fails on the old configuration.

## 3. End to end in a browser (Playwright)

Five specs in `tests/e2e/`, Chromium, one worker. Each opens a fresh private copy of a demo.

| Spec | What it walks |
|---|---|
| `judge-path.spec.ts` | The club demo: run, a citation with its quote highlighted, B · C · K, an answer as the leaver, review and plan as the approver, snapshot v1, handover as two roles, the restricted stub, no canary token, the leak check |
| `lab-path.spec.ts` | The research-group demo: two cards on the landing page, the five lab roles, claims, evaluation, test, ask, review as the PI, handover, read-back with the lab's items, the stub for the PhD student, the leak check |
| `recovery.spec.ts` | The approver switches recovery on; three rungs per gap; a skipped neighbour; rebuilt procedures with quoted steps; fewer gaps close without the leaver; a neighbour answers with the sample and it is saved as Second-hand with B unchanged; "I don't know" stores nothing; switching back |
| `living-handover.spec.ts` | First weeks is empty before a snapshot; the successor records a finding with a link and a file; nothing moves while it waits; the leaver and the successor cannot approve; the approver approves; snapshot v2; "What changed in v2"; every role's handover on v2 |
| `reliability.spec.ts` (5 tests) | The abuse cases in section 4; fails on any page error or 5xx answer |

```bash
pnpm dev                                    # terminal 1
pnpm exec playwright install chromium       # terminal 2, once
pnpm test:e2e                               # terminal 2
```

Set `E2E_BASE_URL` to run against another address, for example the live app. A failure leaves a screenshot and a trace in `test-results/` and a report in `playwright-report/`.

Results on 2026-11-14:

| Target | Result |
|---|---|
| `pnpm dev` on a fresh clone, no model key | 9 passed, 3.2 min |
| Local production build with `MODEL_DISABLED=1`, freshly seeded database | 9 passed, 1.3 min |

## 4. Abuse cases

What a judge does to break things. In the browser: `tests/e2e/reliability.spec.ts`. Against the server: `tests/pipeline/` (6 files).

- **Bad addresses.** Unknown and malformed workspace ids on every page and API route give a not-found page with a way back, or a JSON 404.
- **Empty workspace.** Every page, for every role, shows an empty state that names the next step.
- **Bad uploads.** A zero-byte file, a file over 4.5 MB, a PNG, a malformed CSV, malformed JSON and a malformed calendar are each refused in words, with nothing stored. Bad GitHub URLs are refused.
- **The same thing twice.** A double click on Upload sends one request. Five pipeline starts at the same moment make one run. One answer saved from two tabs is stored once. A snapshot approved from two tabs at once makes one version; approving again with nothing changed makes none.
- **Interrupted runs.** A run with a tiny time budget pauses, continues, and stores the same drafts as a one-shot run. A slice that died is continued once its lease expires, not before. A batch that always fails is tried three times, then named.
- **Spend.** The per-workspace cap stops live model calls and says so.
- **Cleanup.** An old demo copy is deleted with every child row; active, locked and approved workspaces stay. The cleanup route answers 401 without its secret.

## 5. Evaluation against planted answer keys

The suites above fake or disable the model, so they test the rules around it. Extraction quality is measured separately. Each demo has an answer key (`ground_truth.json`) of planted facts, gaps, supersessions, conflicts, fake secrets and canary tokens. `pnpm tsx scripts/eval.ts` (add `--pack lab`) builds a fresh workspace, runs extraction and compares.

| | Robotics club | Research group (hold-out) |
|---|---|---|
| Planted facts | 80 | 76 |
| Recall | 77.5% (62/80) | 72.4% (55/76) |
| Citations that quote the source exactly | 98.8% | 99.1% |
| False conflicts | 1 | 2 |
| Planted conflicts found | 1 of 3 | 2 of 3 |
| Supersessions found | 1 of 4 | 3 of 4 |
| Secrets leaked, restricted violations | 0, 0 | 0, 0 |

- The research group is the hold-out: its pack and corpus were written after the prompts were fixed, and nothing was tuned to its answer key. We chose the shipped extraction prompt there, by a rule fixed before the runs.
- Round 2 recall on the club was 57.7%.
- Full reports: [docs/EVALUATION.md](docs/EVALUATION.md), [docs/EVALUATION.lab.md](docs/EVALUATION.lab.md). Notes per variant: `docs/eval-notes/`. The same numbers are on the in-app Evaluation page.
- `pnpm tsx scripts/check-demo.ts` (add `--pack lab`) checks each corpus against its answer key before any model runs: every planted sentence is in a masked segment, every planted secret is masked, and each canary token sits only in sources with the right role set.

## 6. Leak grid and probes

**Exact tokens.** Restricted demo sources carry `CANARY-XXXX` tokens. For every role and every output (handover text, export, stubs, scores, timeline, questions, conflict flags, the claim list, test notes, the sensitive panel, the people graph, neighbour questions, traces, ranked options, what changed), no token outside that role's visibility may appear. This runs in `pnpm test` (`tests/relay/integration.test.ts`, `tests/relay/leak-wide.test.ts`) and in the app as the Leak check grid on the Handover page.

**Reworded facts.** Nine restricted facts are planted in the club demo with rewordings. Two checks look for them in every role's outputs: key terms, then a model judge that can only add findings. `pnpm tsx scripts/probe-eval.ts` scores all of it and writes [docs/PROBE_RESULTS.md](docs/PROBE_RESULTS.md):

| Measure | Result |
|---|---|
| Output checks (role, output, row) | 94, 0 failing |
| Exact token leaks | 0 |
| Confirmed reworded leaks | 0 (4 unconfirmed judge findings, listed in the report) |
| Detector check: 36 reworded leaks fed straight in | 31 caught (key terms 27, model judge 4 more) |
| Classifier on 40 labelled messages | Precision 87%, recall 72%. With the rules alone recall is 50%, and 6 borderline messages are then held for the approver. |
| Model calls with a limited message in a batch for a wider role set | 0 of 31 |

The report lists every miss with the wording that got through.

## 7. Independent code review, and the fixes

Before the final merge, the Round 3 branch went through a separate review pass for correctness and for security. It raised 13 correctness findings and 8 security findings. We fixed each one and added a regression test for each (merge `4d09ae3`). The larger ones:

| Finding | Fix | Test |
|---|---|---|
| Limiting a message did not reach recovery rows and findings built from it | The limit narrows them in the same transaction; a ladder rebuild takes role sets from the claims as they are now | `tests/db/sec-limit-recovery.test.ts` |
| Tables created after the first migration kept Supabase's default grants | Migration `0012_grants.sql` revokes them, forces row-level security on three admin tables, and fixes the search path of SECURITY DEFINER functions | `tests/db/grants.test.ts` |
| The evaluation page listed answer-key items a role may not see | Lists are filtered by the viewing role | `tests/attest/sec-evaluation-view.test.ts` |
| A saved answer could be reported as an error when the re-test after it failed | The write is reported as saved; the re-test result is reported separately | `tests/db/review-fixes.test.ts` |
| A background re-check could store a run older than the evidence | Every writer bumps a generation; a stale run is refused | `tests/db/review-fixes.test.ts` |
| Approve and reject did not re-test, so a rejected claim kept its better result | Every review decision re-tests | `tests/db/review-fixes.test.ts` |
| Two answers saved at the same moment could share a contact placeholder | A per-workspace counter, advanced atomically (`0013_contact_counters.sql`) | `tests/db/review-fixes.test.ts` |
| A model call could outlive its slice or server action | Request timeouts are cut to the hard deadline | `tests/model/deadline.test.ts`, `tests/pipeline/action-limits.test.ts` |
| Ingest routes ran outside the spend cap; odd repository URLs were accepted | Routes run under the cap; URLs are validated | `tests/pipeline/sec-routes.test.ts`, `tests/tether/sec-github-url.test.ts` |

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every push and pull request to `main`. A newer run cancels the older run of the same branch. It needs no secrets and never calls a live model (`MODEL_DISABLED=1`).

| Job | Steps |
|---|---|
| test and build | Postgres 16 service, `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm test`, `pnpm build` |
| e2e (local server, model disabled) | The same database setup, `pnpm build`, `pnpm start`, then `pnpm test:e2e` in Chromium against `localhost:3000`. The Playwright report is uploaded when the job fails. |

`IDENTITY_KEY` and `CONTACTS_KEY` are dummy values written in the workflow. `MODEL_NAME` and `MODEL_BASE_URL` are set only because they are part of the cache key: with them the seeded answers are found and no request is sent.

## Manual end-to-end checks on the live link

Run on https://understudy-lyart.vercel.app on 14 Nov 2026, after the last deployment of that day, as a first-time visitor: a fresh browser context each time (Playwright, Chromium, 1440×900, no stored cookies), following [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md) and then going off script. Numbers are the ones on screen in that run; they can differ by a point or two in another run.

### Robotics-club demo

| Step | Expected | Result |
|---|---|---|
| Landing | Two demo cards with their roles, "Start empty", and what is new in Round 3 | Pass. Loads in under 1 s. Both cards, the roles of each, and a "New in Round 3" strip that says where each improvement is. |
| Open the demo | A private workspace opens on Connect and the run starts by itself | Pass. Connect opened in about 1 s; the run finished about 3.4 s after the click ("Read 31 batches (31 from the cache)"). |
| Connect | Eight sources with segment, masked and rejected counts; data level | Pass. 8 sources, 466 segments (154, 51, 52, 25, 113, 40, 22, 9). Masked: 4 secrets and 8 contacts. No rejected rows. L3. |
| Connect: Sensitive content | Limited messages with a category, a reason, who sees them now and before | Pass. "9 limited · 0 held · 0 widened": 4 money, 2 people matter, 3 health; 8 found by a rule, 1 by the model. Each card shows "Why", "Visible to" and "Before". |
| Connect: widen the false positive | The approver widens the lab deposit message with a reason; the run repeats | Pass. An empty reason is refused. With a reason the card reads "Widened by Club President on 14 Nov 2026. Reason: ..." and the count becomes "8 limited · 1 widened by you". The run repeated and finished. |
| Claims | Trust labels, Superseded and Conflicting with the rule, a citation with the quote highlighted | Pass. 396 claims: 368 From record, 20 Corroborated, 8 Inferred; 57 superseded (rule named), 4 conflicting. A citation opened the source in about 1 s with the quote highlighted; Back returned to the list. |
| Test | B, then C, then K; blocking gaps; the grid | Pass. Incoming tech lead: B 4 · C 77% · K 100%. Four blocking gaps listed; 10 responsibilities with Covered, Missing and Restricted checks and their evidence. |
| Ask as Priya | Ranked questions with a reason; an answer is labelled "Leaver said"; the scores move | Pass. 8 questions. "Use a sample answer" on the first one, then Save: B 4 → 3, C 77% → 82%, K 100% → 95%, in about 2 s. A typed answer to another question also worked (under 1 s). |
| Improvement 1: "Priya can't be reached" | The ladder: three rungs per gap, a skipped role, rebuilt procedures, ranked options, a before and after panel | Pass. Switched on in 16 to 26 s. 7 gaps, each with "People who worked on this", "What the files and history show" and "Possible answers". One role "Skipped: no access", people without a role "Not asked", "Files and history cannot say who. Skipped.", Ranked options with quotes. Rebuilt procedures (5), one from the CI run history of deploy.yml. Panel: if Priya answered, up to 7 closed, B 1, C 100%, K 80%; without Priya so far, 0 closed, B 4, C 80%, K 97%. |
| Improvement 1: a teammate answers | Switch to Arjun, use the sample, save: labelled Second-hand, B unchanged | Pass. "Saved as Second-hand. Re-test: B 4 (no change) · C 80% → 82% · K 97% → 95%". Panel: 1 partly answered, 6 still open, 3% of coverage rests on Second-hand. Switching recovery off restored the question list in about 1 s. |
| Review | Tier A in bulk, tier B, tier C with evidence and a reason, the plan, the snapshot | Pass. "Approve 14 tier A claims" (a double click approved once). Tier C stays disabled until the evidence is opened and a reason is written. Approval is blocked until each gap has an owner, a date and a risk note. Snapshot v1, SHA-256 cc69f7733956, "Released with 4 open blocking gaps", hash verified. |
| Review as Priya | "The leaver can never approve." | Pass. |
| Handover per role | I-PASS sections, stub, read-back, acknowledge, export | Pass. Incoming tech lead and New member each get a handover with no restricted value; stub "1 restricted item. Ask the approver (Club President)." Read-back gives a verdict per item; items whose claim was not approved say so. Acknowledgement row with role, time, version and hash. Export handover-tech_lead-v1.md, 3 KB, no canary token. |
| Improvement 3: First weeks | The successor records the example finding; nothing moves until review | Pass. "Use the example finding", Save: "Saved as Successor found", row "Waiting for review", "12 open gaps · 1 finding waiting for review · 0 closed since v1 · handover v1". A typed finding on another gap also worked. |
| Improvement 3: review and v2 | The approver approves under "Successor findings"; snapshot v2; "What changed" | Pass. "Finding approved. Snapshot v2 released. B 3 → 2." in 8 to 12 s. Version history shows v1 and v2, both verified. "What changed in v2": 1 claim added, 2 gaps closed, B 3 → 2, C 82% → 89%, K 95% → 87%, each with one sentence. |
| Improvement 2: leak check | Exact tokens and reworded facts, every role and output | Pass. "All 127 checks pass" with recovery on (95 with recovery off, when the four recovery outputs have nothing to check): 9 tokens and 9 reworded facts, 5 roles, 15 outputs. No canary token in any role's page that may not see it. |
| Improvement 2: probe results | What each check caught and missed | Pass. Classifier on 40 labelled messages: precision 87%, recall 72%. 36 reworded leaks: key terms caught 27, the model judge 4 more, 5 got past both, and the page lists them under "Missed". |
| Evaluation | Scores against the planted answer key | Pass. Strict precision 23.3%, recall 77.5%, citation pass rate 96.5%, secrets leaked 0, restricted-token violations 0. |

### Research-group demo

| Step | Expected | Result |
|---|---|---|
| Open the demo | Same steps, the lab's roles and sources | Pass. Finished about 3.5 s after the click. Roles: Principal investigator, Incoming postdoc, PhD student, Lab manager, Farhan (outgoing postdoc). "3 limited" under Sensitive content. |
| Claims, Test | A citation with its quote; B, C, K | Pass. Quote highlighted. Incoming postdoc: B 6 · C 69% · K 100%. |
| Ask as Farhan | An answer moves the scores | Pass. B 6 → 5, C 69% → 73%, K 100% → 95%. |
| Recovery | Ladder, rebuilt procedures, the panel, a teammate answer | Pass. Switched on in about 30 s. 9 gaps, 11 ranked options, Rebuilt procedures (3). Panel: if Farhan answered, up to 9 closed, B 1, C 99%, K 78%; without Farhan, 0 closed, B 5, C 73%, K 95%. The Lab manager's typed answer was saved as Second-hand with B unchanged. |
| Review | Approve as the PI | Pass. 7 tier A claims, 5 plan items, snapshot v1, "Released with 5 open blocking gaps". |
| Handover for three roles | Stubs name the PI; no canary token | Pass. Incoming postdoc, PhD student and Lab manager: "3 restricted items. Ask the approver (Principal investigator)."; no canary token. Leak check: "All 53 checks pass" (6 tokens; this pack plants no reworded facts). |
| First weeks to v2 | The example finding, review, v2 | Pass. Example on "Freezer check and alarm rota: Next due date". "Finding approved. Snapshot v2 released. B 4 → 3." What changed: C 73% → 77%, K 95% → 90%. |

### Abuse

| Check | Result |
|---|---|
| Unknown and malformed workspace addresses, an unknown page | Pass. "This workspace or page does not exist." with a "Start again" link. |
| An empty workspace, every page, each of the five roles | Pass. Each page shows an empty state that names the next step. |
| Uploads: an empty file, a PNG, a CSV with the wrong header, a bad and a missing GitHub address | Pass. Each refused in words; nothing stored ("0 connected"). |
| A valid WhatsApp upload, Upload double clicked, Run double clicked, refresh mid-run | Pass. One source, 5 segments, 1 secret and 1 contact masked; the run finished in about 11 s with the live model ("Read 1 batches (0 from the cache)") and 3 claims. The planted password and phone number were not on the page. |
| Double click on bulk approve, on Approve snapshot and on Save finding | Pass. One approval, one version, one finding. |
| Two tabs with different roles; Back and Forward | Pass. The role is stored per workspace, so the other tab shows the new role after a reload. Back and Forward land on the right pages. |
| 375 px wide, ten pages | Pass. No horizontal page scroll. Wide tables scroll inside their own box. |
| Console errors and failed requests during the walks | None, apart from the expected 400 and 404 answers to the bad uploads and the unknown page. |
| Opening a demo while other heavy actions run | One failure in 13 opens: the first research-group open was cancelled by the database after a long wait. The next 12 opens, 8 of them at once, took 1 to 2 s each. Opening a demo now retries once and, if it still fails, says "Press the button again". |

## Final polish pass (14 Nov 2026), and its tests

A walkthrough of the live link found seven things. Each fix has a test.

| Found | Fix | Test |
|---|---|---|
| Approving only tier A left the handover thin: few claims, read-back items with no approved claim, one dated action listed twice | Review groups pending tier B claims by responsibility. A group is approved in one go after its list was opened; the server takes the approver only, never tier C, a conflict or a superseded claim, and only the claims that were on screen; a repeat approves nothing; one re-test per group. The handover lists the same action once and labels a passed date "Past due" | `tests/relay/group-review.test.ts`, `tests/db/group-approve.test.ts`, and the grouped approval in `judge-path.spec.ts` and `lab-path.spec.ts` (read-back resolves at least 3 of 5 items) |
| B went from 3 back to 4 after the leaver had closed a gap | Root cause: the first reading after an answer is rule-based; the model re-check seconds later read the same answer as only partly enough and reopened the gap, while the approver was already widening a message or switching recovery on. Now a direct answer to a check stands at the record's reading until the approver rejects it, a re-run keeps a check's earlier, better result while its claims are live, and a re-check that does lower a check says which and why | `tests/db/score-stability.test.ts` (leaver answers, approver widens, recovery on; a new conflict still reopens the check) |
| The leak grid needed sideways scroll | Roles across, outputs down, a tick and a word per cell | Checked at 1440, 1280 and 375 px with a script: no overflow |
| The first open of a demo once failed under load | One retry, then one plain sentence | `tests/pipeline/open-demo-retry.test.ts` |

## Known imperfections

- **Model quality is measured, not unit-tested.** Extraction misses some planted facts and produces claims outside the answer key. Section 5 has the numbers.
- **The reworded-fact check is not complete.** 5 of 36 planted rewordings got past both detectors. The approver can limit a message by hand.
- **The role switcher is not sign-in.** Row-level security enforces what the chosen role sees; it does not prove who the visitor is.
- **CI covers tests, the build and the browser suite.** Lint, the type check and the evaluation are run by hand.
- **The pooler regression against a real pooler is opt-in** (`POOLER_TEST_URL`). The default run checks the pool options and the concurrency behaviour on local Postgres.
- **Scores can move by one after a widen.** In a demo where the approver first widens a sensitive message, later re-tests no longer match the replayed model answers and use the rule-based reader. Switching recovery on then showed B one higher for the same evidence (3 to 4) in one manual run.
- **The leak grid is wider than the page.** Its 15 output columns scroll sideways inside the table; the "All N checks pass" line above it covers every column.
- **Each browser run creates workspaces on its target.** The daily cleanup removes them.
