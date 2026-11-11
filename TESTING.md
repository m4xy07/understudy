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
- At commit `e0c873e` the full run was 314 tests in about 11 seconds on a laptop. The count grows as suites are added.
- Optional: set `POOLER_TEST_URL` to a Supabase transaction-pooler URL to also run the pooler regression check against the real pooler (see below).

## What the suites cover

| Folder | Module | What it checks |
|---|---|---|
| `tests/tether/` | Tether | Each adapter (WhatsApp, Slack, GitHub, task CSV, Markdown, ICS) on fixtures: parsing, rejected rows with reasons, threads and reply links, RRULE expansion. Masking: GitHub, AWS, Slack, OpenAI-style keys, private keys, `password=` / `token=` / `secret=` values, high-entropy tokens, emails and phone numbers; credential names kept, values dropped; normal text, slugs and commit SHAs left alone; contact decryption fails with the wrong key. Identity: merge only on exact email via HMAC, name matches are suggestions only. Footprint thresholds, including negative cases. Stable segment IDs, `norm()`, data level, public GitHub fetch (mocked). |
| `tests/attest/` | Attest | Batching never mixes role sets and keeps reply chains together. The exact-quote verifier: a quote with "not" removed fails, citations outside the batch are rejected, a claim without an accepted citation is dropped and counted, role set is the intersection of cited segments. Support check can only lower trust. Supersession rules 1 to 4, corroboration, importance and tier. Structured claims from the task board and calendar without a model. Prompt injection: segment text cannot fake segment headers or the end-of-data marker; labels the model adds are ignored. Fewer false conflicts (board rows, separate occurrences, recurring events). Integration on the demo pack with a fake model. |
| `tests/lacuna/` | Lacuna | Inventory from the board, footprint and role template, with origins and part-of entities. Stand-in successor: code decides coverage and drops citations to claims that are missing, hidden or superseded; deterministic fallback. Scores B, C, K and their deltas. Gap ranking (weight × uncertainty × urgency), at most ten, never about restricted checks. Answers: only the leaver answers, "Leaver said" raises C not K, narrowing never widens. Continuation plan and release state. Integration on the demo pack with the planted claims. |
| `tests/relay/` | Relay | Review tiers A, B, C; tier C needs evidence opened and a written reason; edits keep citations and are labelled. Canonical JSON and SHA-256 hash: stable across key order, changes when one statement changes, tampering detected, versions diff. Release rule and approval. Per-role compile in I-PASS order, stub text, Markdown export. Read-back parsers (dates to ISO, text, commands, contacts) and per-item verdicts. Canary scanning. Integration against the database. |
| `tests/db/` | Foundation | RLS through `withRole`, append-only and immutable tables, the walking-skeleton pipeline end to end (ingest, run, answer, review, snapshot, per-role handover), and the pool regression. |
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
| Start empty and upload a file | Upload accepted (5 MB max per file) or rejected with a reason; run works on the upload | Pass (2026-11-11). A 3-row task CSV was accepted (3 segments, 0 rejected); the run finished in about 7 s with 9 claims. |

## Known limits

- **Your own uploads call the model live.** The demo replays precomputed model answers (23 of 23 extraction batches from the cache) and finishes in a few seconds. A run on files you upload has no cached answers, so it can take a few minutes; the run panel says so and updates by itself.
- **The browser suite covers the judge path only.** It does not cover uploads, tier C review, the read-back form or the Markdown export; those are in the manual table above. Each run creates a demo workspace on the target site.
- **No CI.** We run the suites locally before pushing; there is no CI workflow in the repository yet.
- **Model quality is measured, not unit-tested.** The suites fake or disable the model, so they test the rules around it. Extraction quality comes from the evaluation harness. Extraction misses some planted facts and produces extra claims, and supersession and conflict detection miss some planted cases; [docs/EVALUATION.md](docs/EVALUATION.md) has the current numbers.
- **Lacuna's integration numbers use the planted claims** (a perfect extractor), so they are not the numbers you get from the live pipeline.
- **The leak check finds tokens, not paraphrases.** A restricted fact reworded without its token would not be caught. Paraphrase probes are Round 3 commitment 2.
- **The role switcher is not sign-in.** Anyone with the workspace link can pick any role. RLS enforces what the selected role sees; it does not prove who the visitor is.
- **The pooler check against the real pooler is opt-in** (`POOLER_TEST_URL`); the default run checks the options and the concurrency behaviour on local Postgres.
