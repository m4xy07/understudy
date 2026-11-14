# Testing

How we test Understudy, ordered by what was tested: rules in isolation, the database boundary, the product in a browser, abuse, extraction quality against planted answer keys, leaks, and an independent code review.

## Totals

From a fresh clone of `main`, following the README, with no model key (2026-11-14, Windows 11, Node 26, local Postgres 16 in Docker):

| Command | Result |
|---|---|
| `pnpm test` | 73 test files, 967 tests passed, 1 skipped, 62 s. The skipped test needs a Supabase pooler URL (`POOLER_TEST_URL`). |
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

## Known imperfections

- **Model quality is measured, not unit-tested.** Extraction misses some planted facts and produces claims outside the answer key. Section 5 has the numbers.
- **The reworded-fact check is not complete.** 5 of 36 planted rewordings got past both detectors. The approver can limit a message by hand.
- **The role switcher is not sign-in.** Row-level security enforces what the chosen role sees; it does not prove who the visitor is.
- **CI covers tests, the build and the browser suite.** Lint, the type check and the evaluation are run by hand.
- **The pooler regression against a real pooler is opt-in** (`POOLER_TEST_URL`). The default run checks the pool options and the concurrency behaviour on local Postgres.
- **Each browser run creates workspaces on its target.** The daily cleanup removes them.
