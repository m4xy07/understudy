# Testing

How we test Understudy: automated suites per module, an evaluation harness against planted ground truth, permission and leak tests, and manual checks on the live link.

## How to run

```bash
pnpm install
pnpm db:up          # Postgres 16 in Docker on localhost:45432
pnpm db:migrate     # the integration, permission and pool suites need the schema
pnpm test           # vitest run, all suites
pnpm test:watch     # while working
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

## Manual end-to-end checks on the live link

Run in a fresh private browser window on https://understudy-lyart.vercel.app, following [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md). We fill in the Result column at feature freeze.

| Step | Expected | Result |
|---|---|---|
| Landing: press "Open the robotics-club demo" | A private workspace opens on Connect; the run starts by itself | to be filled at freeze |
| Connect | Eight sources with segment, masked-secret, masked-contact and rejected counts; data level shown; run panel reaches Done for every step | to be filled at freeze |
| Claims: open a citation | Source segment opens with the exact quote highlighted; back link returns to the claim | to be filled at freeze |
| Claims: Superseded and Conflicting | Each shows the rule that fired; dropped-claim counter per source | to be filled at freeze |
| Test as Incoming tech lead | B, then C, then K; grid of Covered, Partial, Missing, Restricted with evidence links | to be filled at freeze |
| Test as New member | More Restricted checks; no restricted values shown | to be filled at freeze |
| Ask as Priya | Up to ten ranked questions with a reason each; an answer is labelled "Leaver said"; re-test line shows the B, C, K change | to be filled at freeze |
| Ask as anyone else | Questions are read only; only Priya can answer | to be filled at freeze |
| Review as Priya | "The leaver can never approve."; no approve controls | to be filled at freeze |
| Review as Club President: approve without a plan | Approval blocked, with the list of missing owners, dates or risk notes | to be filled at freeze |
| Review as Club President: plan every gap, approve | Snapshot v1 with a SHA-256 hash; "Released with N open blocking gaps" if B > 0 | to be filled at freeze |
| Handover as Incoming tech lead | I-PASS sections, decision timeline, open items, stub "N restricted items. Ask the approver (Club President)." | to be filled at freeze |
| Read-back and acknowledge | Per-item verdicts; acknowledgement row with role, time and snapshot hash | to be filled at freeze |
| Handover as New member | Fewer items, larger stub, no topic or value of restricted items | to be filled at freeze |
| Leak check grid | Every role and surface passes | to be filled at freeze |
| Download handover (Markdown) | File matches the role's view; no canary outside that role's visibility | to be filled at freeze |
| Start empty and upload a file | Upload accepted (5 MB max per file) or rejected with a reason; run works on the upload | to be filled at freeze |

## Known limits

- **No automated browser suite yet.** Playwright is installed, but the end-to-end checks on the live link are the manual table above.
- **No CI.** We run the suites locally before pushing; there is no CI workflow in the repository yet.
- **Model quality is measured, not unit-tested.** The suites fake or disable the model, so they test the rules around it. Extraction quality comes from the evaluation harness. Extraction misses some planted facts and produces extra claims, and supersession and conflict detection miss some planted cases; [docs/EVALUATION.md](docs/EVALUATION.md) has the current numbers.
- **Lacuna's integration numbers use the planted claims** (a perfect extractor), so they are not the numbers you get from the live pipeline.
- **The leak check finds tokens, not paraphrases.** A restricted fact reworded without its token would not be caught. Paraphrase probes are Round 3 commitment 2.
- **The role switcher is not sign-in.** Anyone with the workspace link can pick any role. RLS enforces what the selected role sees; it does not prove who the visitor is.
- **The pooler check against the real pooler is opt-in** (`POOLER_TEST_URL`); the default run checks the options and the concurrency behaviour on local Postgres.
