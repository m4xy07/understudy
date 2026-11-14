# Testing

How we test Understudy: automated suites per module, an evaluation harness against planted ground truth, permission and leak tests, and manual checks on the live link.

## How to run

```bash
pnpm install
pnpm db:up          # Postgres 16 in Docker on localhost:45432
pnpm db:migrate     # the integration, permission and pool suites need the schema
pnpm test           # vitest run, all suites
pnpm test:watch     # while working
pnpm test:e2e       # Playwright, the judge path in Chromium (see "End-to-end suite" below)
```

- Tests read `.env.local` (through `scripts/load-env.ts`). `DATABASE_URL` must point at a migrated database; the Docker default from `.env.example` works.
- Tests never call a live model. `vitest.config.mts` sets `MODEL_DISABLED=1` and `LACUNA_MODEL=off`: the model client answers from the cache or fails fast, and integration suites inject a fake model or run the deterministic successor. Results do not depend on the network.
- Files run one at a time (`fileParallelism: false`) because the database suites share one Postgres.
- The count grows as suites are added, so no number is kept here: `pnpm test` prints the totals (test files and tests) on its last two lines. After the Round 3 integration (recovery, confidentiality, living handover and the reliability fixes on one branch) the run was 64 test files, 868 tests passed and 1 skipped (the pooler check, which needs `POOLER_TEST_URL`), in under two minutes on a laptop with a local database.
- Optional: set `POOLER_TEST_URL` to a Supabase transaction-pooler URL to also run the pooler regression check against the real pooler (see below).

## What the suites cover

| Folder | Module | What it checks |
|---|---|---|
| `tests/tether/` | Tether | Each adapter (WhatsApp, Slack, GitHub, task CSV, Markdown, ICS) on fixtures: parsing, rejected rows with reasons, threads and reply links, RRULE expansion. Masking: GitHub, AWS, Slack, OpenAI-style keys, private keys, `password=` / `token=` / `secret=` values, high-entropy tokens, emails and phone numbers; credential names kept, values dropped; normal text, slugs and commit SHAs left alone; contact decryption fails with the wrong key. Identity: merge only on exact email via HMAC, name matches are suggestions only. Footprint thresholds, including negative cases. Stable segment IDs, `norm()`, data level, public GitHub fetch (mocked). |
| `tests/attest/` | Attest | Batching never mixes role sets and keeps reply chains together. The exact-quote verifier: a quote with "not" removed fails, citations outside the batch are rejected, a claim without an accepted citation is dropped and counted, role set is the intersection of cited segments. Support check can only lower trust. Supersession rules 1 to 4, corroboration, importance and tier. Structured claims from the task board and calendar without a model. Prompt injection: segment text cannot fake segment headers or the end-of-data marker; labels the model adds are ignored. Fewer false conflicts (board rows, separate occurrences, recurring events). Integration on the demo pack with a fake model. |
| `tests/lacuna/` | Lacuna | Inventory from the board, footprint and role template, with origins and part-of entities. Stand-in successor: code decides coverage and drops citations to claims that are missing, hidden or superseded; deterministic fallback. Scores B, C, K and their deltas. Gap ranking (weight × uncertainty × urgency), at most ten, never about restricted checks. Answers: only the leaver answers, "Leaver said" raises C not K, narrowing never widens. Continuation plan and release state. Integration on the demo pack with the planted claims. |
| `tests/relay/` | Relay | Review tiers A, B, C; tier C needs evidence opened and a written reason; edits keep citations and are labelled. Canonical JSON and SHA-256 hash: stable across key order, changes when one statement changes, tampering detected, versions diff. Release rule and approval. Per-role compile in I-PASS order, stub text, Markdown export. Read-back parsers (dates to ISO, text, commands, contacts) and per-item verdicts. Canary scanning. Integration against the database. |
| `tests/db/` | Foundation | RLS through `withRole`, append-only and immutable tables, the walking-skeleton pipeline end to end (ingest, run, answer, review, snapshot, per-role handover), and the pool regression. |
| `tests/pipeline/` | Reliability | **The run lease:** five starts at the same moment make one run and four attach; the database refuses a second live run; a slice that died is continued once its lease expires, not before. **Resumable slices** (fake model endpoint, tiny time budget): a run pauses, continues, and stores the same drafts as a one-shot run, with every batch read live once; progress never goes down; a batch that always fails is tried three times, then named; the slice limit ends a run with a message; the per-workspace cap stops live calls and says so. **Repeats:** two saves of one answer store one; approving an approved claim is a no-op; three snapshot approvals at once make one version, a repeat makes none, a real change makes v2; one model re-check at a time. **Bad input:** empty, binary, wrong-shape and oversized uploads refused with a reason and no source left behind; plan dates must be real dates. **Cleanup:** an old demo copy is deleted with every child row; fresh, active, locked and approved workspaces stay; dry mode deletes nothing; the route answers 401 without the secret. |
| `tests/model/` | Foundation | The model client in tests: no probe, no network, a fast typed failure on a cache miss. |

## Evaluation harness

`pnpm tsx scripts/eval.ts` builds a fresh demo workspace, runs Attest (cache first, then the live model), and compares the claims with `data/demo/ground_truth.json`: claim precision and recall, citation pass rate, trust mix, role-set and source correctness, supersessions and planted conflicts found, false conflicts, leaked secrets and restricted-token violations (both must be 0). It writes the report to **[docs/EVALUATION.md](docs/EVALUATION.md)**. The same numbers are on the in-app **Evaluation** page (button on the Claims page).

`pnpm tsx scripts/precompute.ts` runs the pipeline twice against the live model, checks the second run is fully cached with identical claims, and merges the cache into `data/demo/model_cache.json`. `pnpm tsx scripts/check-demo.ts` validates the setting pack and the demo dataset against the contract.

The ground truth holds planted claims, gaps, supersessions, conflicts, restricted items with canary tokens, off-board duties, fake secrets and the five read-back answers.

## Permission tests

These are the tests behind "shows each role only what it may see".

**RLS is the boundary** (`tests/db/rls.test.ts`)
- New member cannot read a finance-only segment or claim; the Club President can read both.
- Rows from another workspace are invisible even with a matching role.
- `count_withheld()` returns only the right integer.
- `us_reader` cannot write; the app user still can for admin steps.
- `claim_events` rejects UPDATE and DELETE; `audit_log` and `acknowledgements` reject UPDATE; segments are immutable.
- Lacuna decides Restricted from the metadata function, without reading the hidden rows (`tests/lacuna/integration.test.ts`).

**The leaver cannot approve**
- Unit: the leaver and every non-president role are refused; the president is refused while the release rule is not met (`tests/relay/snapshot.test.ts`).
- Server, against the database: the leaver can never review or approve, and nobody but the president can (`tests/relay/integration.test.ts`, `tests/db/pipeline.test.ts`).
- Related: only the president confirms the inventory and saves plan items; only the leaver answers questions (`tests/lacuna/integration.test.ts`).

**Canary leak check across roles and surfaces**
- Restricted demo sources carry `CANARY-XXXX` tokens. For every role, every surface (handover sections, read-back form, stubs, scores, timeline, questions, Markdown export) is scanned; a token may appear only for roles allowed to see it (`tests/relay/integration.test.ts`).
- The scanner matches across case and Markdown markup and also catches unlisted CANARY-shaped tokens (`tests/relay/canary.test.ts`).
- The New member's compiled handover never contains a canary, and its stub count comes from `count_withheld()`.
- The same check runs in the app as the **Leak check** grid at the bottom of the Handover page.

## Second setting (Round 3): the research group

The university research group (`packs/lab.json`, `data/lab/`) is tested as one more row of the same suites, never as a special case.

| What | Where | What it proves |
|---|---|---|
| Corpus against its answer key, before any model runs | `pnpm tsx scripts/check-demo.ts --pack lab` (then its adapters stage, `scripts/check-demo-adapters.ts`) | The pack loads; 191 segments through the real adapters with 0 rejected rows; 8 planted secrets and 4 contacts masked, credential names kept; 6 canary tokens only in sources with the right role set; every planted sentence is in a masked segment; the footprint and the inventory give exactly the answer key's 10 responsibilities |
| The whole product on each demo pack, model off, committed cache | `tests/db/pipeline.packs.test.ts` (12 tests per pack) | Every extraction batch replays from the pack's `model_cache.json`; no planted secret is stored; the inventory matches the key; only the leaver answers; only the pack's approver approves; per-role handover with the pack's stub text ("Ask the approver (Principal investigator)."); RLS returns no row with a token outside a role's set; the leak check passes on every surface for every role; read-back asks the pack's items |
| RLS with each pack's role keys | `tests/db/rls.test.ts` (11 tests per pack) | The policies know no role key: the same fixture passes with the club's keys and the lab's; a role key of another pack reads nothing; the database refuses a snapshot approved by anyone but the workspace's approver |
| Browser walk of the lab | `tests/e2e/lab-path.spec.ts` | Two demo cards on the landing page; the lab demo opens in one click; the role switcher lists the five lab roles; claims, evaluation (76 planted facts), test, ask as the leaver, review as the PI, handover, read-back with the lab items, restricted stub for the PhD student, leak check |
| Zero setting-specific core code | `pnpm tsx scripts/check-zero-core.ts`, `tests/pack/zero-core.test.ts`, `pnpm check:literals` | From the git history: the pack's branch changed no core file; the 3 core files changed since are listed in [docs/round3/ZERO_CORE_CHANGES.md](docs/round3/ZERO_CORE_CHANGES.md); no added core line names the lab |
| Extraction quality on a hold-out | `pnpm tsx scripts/eval.ts --pack lab` → [docs/EVALUATION.lab.md](docs/EVALUATION.lab.md) | One cold run per extraction variant, nothing tuned to this answer key; the shipped variant (v2) reads recall 72.4% (55/76), citations 99.1% exact, 2 false conflicts, supersessions 3/4, planted conflicts 2/3, 0 secrets leaked, 0 restricted violations |

## The production bug we found and fixed

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

## End-to-end suite (Playwright)

`tests/e2e/judge-path.spec.ts` walks the five-minute path from [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md) in Chromium, on a fresh private copy of the demo:

1. Open the demo and wait for the run panel to say the run finished. The header stepper must show Reconstruct and Test as Done without a reload.
2. Claims (From record): a citation opens its source with the exact quote highlighted.
3. Test: the scores read B · C · K for the Incoming tech lead.
4. Ask as Priya: answer the top question; the "Re-test after this answer" line shows a change (an arrow in B, C or K).
5. Review as Club President: approve tier A from "Where to start", save an owner, due date and risk note for every open blocking gap, approve snapshot v1. The history shows "Released with N open blocking gaps".
6. Handover as Incoming tech lead: the five I-PASS sections and the release label (never "complete").
7. Handover as New member: the stub "N restricted items. Ask the approver (Club President)." and no `CANARY-` token in the page text.
8. Leak check: "All N checks pass".

```bash
pnpm exec playwright install chromium                           # once
pnpm dev                                                        # in another terminal, for a local run
pnpm test:e2e                                                   # baseURL http://localhost:3000
E2E_BASE_URL=https://understudy-lyart.vercel.app pnpm test:e2e  # against the live app
```

`tests/e2e/reliability.spec.ts` does what a judge does to break things, and fails on any page error or 5xx answer:

1. Unknown and malformed workspace ids, on every page and API route: a not-found page with a way back, JSON 404s.
2. An empty workspace, every page, every role: an empty state that names the next step.
3. Uploads: a zero-byte file, a file over 4.5 MB (both stopped in the browser), a PNG, a malformed CSV, malformed JSON, a malformed calendar (each refused in words, nothing stored); a good file with a double click on Upload (one request), then again (nothing new). Bad GitHub URLs.
4. The pipeline started by a double click plus three more starts at once, with a refresh mid-run: one run.
5. On the demo: a blank answer; one question answered from two tabs at the same moment (stored once); blank and over-long plan fields; the snapshot approved from two tabs at once, one with a double click (one version), then approved again with nothing changed (a note, no new version); back after an action; an acknowledgement pressed twice; two more pipeline starts after approval (the handover and the export still work).

`playwright.config.ts`: Chromium only, one worker, one retry, a screenshot and a trace on failure (in `test-results/`), an HTML report in `playwright-report/`. The answer step allows two minutes because the live re-test calls the model. Vitest ignores `tests/e2e`.

**Result (2026-11-11), against https://understudy-lyart.vercel.app:**

```text
$ E2E_BASE_URL=https://understudy-lyart.vercel.app pnpm test:e2e
Running 1 test using 1 worker
  ✓  1 [chromium] › tests\e2e\judge-path.spec.ts:35:1 › judge path: demo, claims, test, ask, review, handover, leak check (25.1s)
  1 passed (29.1s)

$ E2E_BASE_URL=https://understudy-lyart.vercel.app npx playwright test --retries=0 --repeat-each=2
  ✓  1 [chromium] › tests\e2e\judge-path.spec.ts:35:1 › judge path: demo, claims, test, ask, review, handover, leak check (25.2s)
  ✓  2 [chromium] › tests\e2e\judge-path.spec.ts:35:1 › judge path: demo, claims, test, ask, review, handover, leak check (24.4s)
  2 passed (51.3s)
```

The same suite passed against a local production build (`pnpm build && pnpm start`) in 19.8 s. The whole path takes about 25 s on the live app because the demo replays cached model answers.

### Round 3 integration run (2026-11-14)

All five specs against a local production build (`pnpm build && pnpm start`) of the integration
branch, live model for anything not in the cache (the single final precompute had not run yet):

| Spec | Result |
|---|---|
| `judge-path.spec.ts` | passed (1.2 min) |
| `lab-path.spec.ts` | passed (1.6 min) |
| `reliability.spec.ts` (5 tests) | passed |
| `living-handover.spec.ts` | passed (27 s) |
| `recovery.spec.ts` | failed at its last panel check: with uncached stand-in prompts the live model read `R01 credential owner` as covered, so the neighbour the sample answers are written for was not asked about it, the spec typed its fallback answer, and that answer was not cited as Second-hand. Re-run after the final precompute. |

### After the final precompute (2026-11-14)

All five specs against a local production build started with `MODEL_DISABLED=1`, on a database that
was created, migrated and seeded from the committed caches just before (no live model anywhere):

| Spec | Result |
|---|---|
| `judge-path.spec.ts` | passed (14 s) |
| `lab-path.spec.ts` | passed (8 s) |
| `living-handover.spec.ts` | passed (16 s) |
| `recovery.spec.ts` | passed (7 s) |
| `reliability.spec.ts` (5 tests) | passed |

9 tests passed in 1.3 min, no retry. The recovery samples were rewritten to the steps the cached
run asks (`data/demo/recovery.json`), so the neighbour's sample answer replays and is cited as
Second-hand. Two assertions were loosened because they named a count that depends on the run: the
"What changed" line now accepts "N more checks are covered", and an empty read-back accepts
"Nothing to check for this role." as its verdict. `pnpm test` on the same fresh database: 64 test
files, 881 tests passed and 1 skipped.


### Living handover (Round 3)

`tests/e2e/living-handover.spec.ts` walks the First weeks flow on a fresh club demo: empty state before a snapshot, snapshot v1, the successor records the example finding with a link and a small file (a past date is refused first), nothing moves while it waits, the leaver and the successor cannot approve, the approver opens the evidence and approves, snapshot v2, version history with the stored diff, the "What changed in v2" panel, the gap closed on First weeks, every role's handover on v2, and the leak check.

```bash
pnpm build && PORT=45617 pnpm start                                     # another terminal
E2E_BASE_URL=http://localhost:45617 pnpm exec playwright test living-handover
```

Result (2026-11-14, local production build, warm model cache): 1 passed, 47.3 s. Scores in that run: B 6 → 5, C 66% → 70%, K 100% → 94%.

Unit and database tests: `tests/relay/finding.test.ts` (form rules, fixed evidence layout, narrowing, a finding under the Attest rules), `tests/relay/changes.test.ts` (gaps closed and opened, every reason sentence) and `tests/relay/living.integration.test.ts` (the whole chain against Postgres, masking, role scoping with a canary token, withdraw, reject, release blocked, corroboration by a later record, pipeline re-run).

Stated limits: a finding moves no score until the approver decides (stricter than leaver answers, on purpose). An attached file stays inside the finding and can never corroborate it; a record that arrives through Connect can, and Understudy cannot tell who wrote an uploaded file.

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every push and pull request to `main`; a newer run cancels the older run of the same branch. It needs no secrets and never calls a live model (`MODEL_DISABLED=1`).

| Job | Steps |
|---|---|
| test and build | Postgres 16 service, `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm test`, `pnpm build` |
| e2e (local server, model disabled) | Same database setup, `pnpm build`, `pnpm start`, then `pnpm test:e2e` in Chromium against `localhost:3000`. The Playwright report is uploaded when the job fails. |

- `IDENTITY_KEY` and `CONTACTS_KEY` are dummy values written in the workflow. `MODEL_NAME` and `MODEL_BASE_URL` are set only because they form the cache tag: with them the seeded answers in `data/demo/model_cache.json` are found, and no request is sent.
- The e2e suite runs unchanged with the model disabled. The demo run replays the seeded cache, and the re-test after the leaver's answer falls back to the deterministic stand-in, which still moves the scores. Checked locally on 2026-11-14 against `pnpm start` with a freshly migrated and seeded database: 1 passed in 9.3 s.
- `pnpm staging:setup` (`scripts/staging.ts`) prepares the rehearsal database: it reads `STAGING_POOLER_URL` from `.env.local`, applies the migrations, seeds the model cache and prints row counts. It refuses to run if that URL is the production project.

## Manual end-to-end checks on the live link

Run in a fresh private browser window on https://understudy-lyart.vercel.app, following [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md). The results below come from a fresh browser context (Playwright, Chromium) on 2026-11-11 at 1440×900; every page was also checked at 375 px wide (no horizontal scroll) and no console errors were logged.

| Step | Expected | Result |
|---|---|---|
| Landing: press "Open the robotics-club demo" | A private workspace opens on Connect; the run starts by itself | Pass (2026-11-11). Workspace opened on Connect in about 3 s; the run started by itself. |
| Connect | Eight sources with segment, masked-secret, masked-contact and rejected counts; data level shown; run panel reaches Done for every step | Pass (2026-11-11). Eight sources (139, 50, 50, 25, 77, 40, 22 and 9 segments), masked secrets and contacts, no rejected rows, L3 shown; every step reached Done. That run took about 4.5 min, because the model cache was not hit ("Read 23 batches (0 from the cache)"), so the B, C and K values in this table come from a live, uncached run. Fixed the same day (our seed script stored every cached answer double-encoded); a fresh demo now reads 23 of 23 batches from the cache and finishes in about 3 to 4 s. |
| Claims: open a citation | Source segment opens with the exact quote highlighted; back link returns to the claim | Pass (2026-11-11). The source page opened in about 1 s with the exact quote highlighted; "Back to claims" link present. |
| Claims: Superseded and Conflicting | Each shows the rule that fired; dropped-claim counter per source | Pass (2026-11-11). Superseded and Conflicting claims name the rule (for example "the task board owns deadlines"); dropped-per-source counter shown (0). |
| Test as Incoming tech lead | B, then C, then K; grid of Covered, Partial, Missing, Restricted with evidence links | Pass (2026-11-11). B 7 · C 70% · K 94%; blocking-gap list and a Covered / Partial / Missing / Restricted grid with evidence links. |
| Test as New member | More Restricted checks; no restricted values shown | Pass (2026-11-11). B 8 · C 66%; restricted checks say "Evidence exists for other roles" and show no values. |
| Ask as Priya | Up to ten ranked questions with a reason each; an answer is labelled "Leaver said"; re-test line shows the B, C, K change | Pass (2026-11-11). Ten ranked questions, each with "Why asked"; two answers labelled Leaver said; B 7 · C 70% · K 94% became B 5 · C 79% · K 84%. Each save took 10 to 16 s (live re-test) while "Saving and re-testing…" showed. |
| Ask as anyone else | Questions are read only; only Priya can answer | Pass (2026-11-11). As Incoming tech lead: "Only Priya (outgoing tech lead) answers these.", no answer boxes. |
| Review as Priya | "The leaver can never approve."; no approve controls | Pass (2026-11-11). "The leaver can never approve." and no approve buttons. |
| Review as Club President: approve without a plan | Approval blocked, with the list of missing owners, dates or risk notes | Pass (2026-11-11). "Approval is blocked:" lists every gap that needs an owner, a due date and a risk note. |
| Review as Club President: plan every gap, approve | Snapshot v1 with a SHA-256 hash; "Released with N open blocking gaps" if B > 0 | Pass (2026-11-11). Bulk tier A, one tier B, one tier C (evidence opened, reason written), five plan items; snapshot v1, SHA-256 0fed7ece9236…, "Released with 5 open blocking gaps". |
| Handover as Incoming tech lead | I-PASS sections, decision timeline, open items, stub "N restricted items. Ask the approver (Club President)." | Pass (2026-11-11). I-PASS sections with trust labels and [n] citations, decision timeline, open items, stub "3 restricted items. Ask the approver (Club President)." |
| Read-back and acknowledge | Per-item verdicts; acknowledgement row with role, time and snapshot hash | Pass (2026-11-11). Sponsor contact, domain renewal date and lab day matched; competition date and rollback showed "Nothing to check" (their claims were not approved in this run); acknowledgement row with role, time, v1 and hash. |
| Handover as New member | Fewer items, larger stub, no topic or value of restricted items | Pass (2026-11-11). No restricted values; stub "3 restricted items. Ask the approver (Club President)." Same items as the tech lead in this run, because every approved claim came from sources all roles see. |
| Leak check grid | Every role and surface passes | Pass (2026-11-11). "All 30 checks pass" (5 roles × 6 surfaces). |
| Download handover (Markdown) | File matches the role's view; no canary outside that role's visibility | Pass (2026-11-11). handover-tech_lead-v1.md (3 KB), no CANARY token. |
| Start empty and upload a file | Upload accepted (4.5 MB max per upload) or rejected with a reason; run works on the upload | Pass (2026-11-11). A 3-row task CSV was accepted (3 segments, 0 rejected); the run finished in about 7 s with 9 claims. |

## Known limits

- **Your own uploads call the model live.** The demo replays precomputed model answers (23 of 23 extraction batches from the cache) and finishes in a few seconds. A run on files you upload has no cached answers, so it can take a few minutes. A run that needs more than one function invocation is read in parts: the run panel shows how many model calls are finished and asks for the next part by itself. **This needs the Connect page (or any workspace page) open in a browser**; with every tab closed a paused run waits and continues when the workspace is opened again. There is no time-left estimate.
- **Limits on uploads and model use.** One upload is at most 4.5 MB and 20,000 entries. Each workspace may make 400 live model calls a day (`MODEL_CALLS_PER_WORKSPACE_PER_DAY`), the whole deployment 4,000 (`MODEL_CALLS_PER_DAY`); past that, cached answers still replay and the run says how many calls were skipped.
- **After an answer, the first score is the rule-based reading.** The model re-check runs in the background (a header pill says so) and can lower it a few seconds later. If two answers are saved close together, the "re-test after this answer" sentence of the earlier one keeps its rule-based reading; the scores themselves always come from the latest run.
- **The browser suite covers the judge path and the abuse cases above.** It does not cover tier C review or the read-back values; those are in the manual table above. Each run creates workspaces on the target site.
- **Invite links are not built.** Roles stay open (the role switcher); the cleanup rule already protects a workspace marked locked, but nothing in the app locks one yet.
- **CI covers tests, build and the judge path only.** Lint, the type check and the evaluation gate are not CI jobs yet.
- **Model quality is measured, not unit-tested.** The suites fake or disable the model, so they test the rules around it. Extraction quality comes from the evaluation harness. Extraction misses some planted facts and produces extra claims, and supersession and conflict detection miss some planted cases; [docs/EVALUATION.md](docs/EVALUATION.md) has the current numbers.
- **Lacuna's integration numbers use the planted claims** (a perfect extractor), so they are not the numbers you get from the live pipeline.
- **The leak check finds tokens, not paraphrases.** A restricted fact reworded without its token would not be caught. Paraphrase probes are Round 3 commitment 2.
- **The role switcher is not sign-in.** Anyone with the workspace link can pick any role. RLS enforces what the selected role sees; it does not prove who the visitor is.
- **The pooler check against the real pooler is opt-in** (`POOLER_TEST_URL`); the default run checks the options and the concurrency behaviour on local Postgres.
