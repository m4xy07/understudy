# 04. Round 2 fixes: designs for the Round 3 window

Planning document only. Nothing here is product code. No file in the product repository is
created or changed before the window opens at 23:59 IST on Fri 13 Nov 2026.

Read with `ROUND3_PLAN.md` (the three improvements), `05_schedule_and_roles.md` (when and who)
and `06_submission_checklist.md` (what the submission needs).

Starting point: main at `05473dd`, 334 tests plus the end-to-end judge path, live at
https://understudy-lyart.vercel.app.

Before writing any route, cron or server action in the window, read the Next.js 16 docs in
`node_modules/next/dist/docs/` as `AGENTS.md` in the repo asks. This version differs from older ones.

---

## 1. What reading the code changed

These facts come from the Round 2 code and they shape the designs below.

1. **Finished model calls are already checkpoints.** `callJson` in `src/lib/model/client.ts` writes
   every valid answer to `model_cache` as soon as it arrives. A run that dies at the 5-minute limit
   loses its in-memory drafts, but a second run replays the finished batches from the cache in
   milliseconds. Resumable extraction (fix b) can use the cache as its checkpoint store.
2. **One slow call can outlive the function.** Each call has a 120 s timeout and 3 retries with
   backoff. Worst case for one batch is over 8 minutes, longer than the 300 s limit in
   `src/app/api/w/[id]/run/route.ts`. Retries must move from inside a call to across slices.
3. **A dead run blocks a new one for 6 minutes.** `startRun` in `src/lib/pipeline/run.ts` returns
   `alreadyRunning` while a run row is younger than `STALE_MS`. There is no way to continue it.
4. **The re-test already replays every responsibility but one.** `scripts/precompute.ts` says so:
   only the answered responsibility's prompt changes. The 6 to 16 s is one live stand-in call per
   role (successor and new member), and the answer is output-bound at about 30 tokens per second.
   "Re-test only the answered responsibility" saves little by itself. The real saving is a smaller
   prompt (only the affected checks), a deterministic result shown first, and the new-member run
   moved to the background (fix f).
5. **The cache key holds the schema name, not the schema body.** `cacheKey(tag, system, user,
   schemaName)`. Any change to the extraction output shape needs a new schema name, or old answers
   replay into the new shape.
6. **Batches never mix role sets.** `planBatches` groups by source, thread and identical role set.
   Any second pass must keep this rule: a consolidation call may only see candidates from one role
   set. Merging across role sets is done by code on normalised values, never by the model.
7. **The purge function deletes by age alone.** `purge_workspaces(days)` in
   `db/migrations/0001_core.sql` removes every workspace older than N days. With invite links and
   the living handover, a real team's workspace must outlive 7 days. The cleanup needs a rule for
   what to keep (fix d).
8. **Any visitor without a cookie is the president.** `DEFAULT_ROLE` in `src/lib/session.ts` is
   `president`, and `setRole` accepts any role. That is right for the demo and wrong for a team.
9. **Role keys and the approver label are in core code.** A search for the five role key literals
   and "Club President" finds 29 hits in 20 files under `src/`. The extraction prompt examples
   also name Priya Nair and the robotics setting. The pack refactor in hours 0 to 4 and the prompt
   rewrite in fix (a) both serve the "zero core code changes" promise.
10. **The upload limit text is wrong for the live site.** The code allows 5 MB; Vercel caps a
    request body at about 4.5 MB, as we told judges in Round 2 field 12.
11. **Round 2 field 13 promises "CI runs" as a trace source.** `ROUND3_PLAN.md` lists workflow
    files, commit history and calendar recurrences. Either the demo GitHub export gains a small
    synthetic run history that the trace reader uses, or the change is explained in the
    submission. Decide at kickoff. See risk 15 in `05_schedule_and_roles.md`.

---

## 2. Ranking by value to a judge, and the cut order

Judges measure Round 3 against the three improvements first. The fixes count under "reliable core
workflow", "stronger technical work", "more usable and practical" and "fix important Round 2 bugs".

| Rank | Fix | Why a judge cares | Hours | Risk |
|---|---|---|---|---|
| 1 | (a) Extraction accuracy | We named it as our main known issue and said Round 3 would improve it. The Evaluation page shows the number. | 11 | High |
| 2 | (e) CI | Cheap, visible in the repository, and it protects everything else that lands. | 3 | Low |
| 3 | (f) Faster re-test | Every judge who answers a question waits 10 to 15 s today. Improvements 1 and 3 reuse the same path. | 4 | Low |
| 4 | (b) Large uploads | Named known issue. Seen only by judges who upload their own files, but a failed run looks broken. | 7 | Medium |
| 5 | (g) Small weak spots | Read-back showing "Nothing to check", the wrong upload limit, a spend cap. Small and judge-facing. | 5 | Low |
| 6 | (c) Invite links | Answers "no sign-up" and makes the tool usable by a real team. Largest fix and it touches every permission read. | 8 | High |
| 7 | (d) Scheduled cleanup | Invisible to a judge. Good hygiene, small. | 2 | Low |

Total: about 40 person-hours of about 180 available. The three improvements need most of the rest.

**Cut order (first to go is first in the list):**

1. (c) invite links, the whole fix. If cut, say so under "changes of plan" and keep the role
   switcher with its honest label.
2. (a) step 2b only (the model pair judge). Keep the code-only consolidation.
3. (b) down to its minimum: slice budget plus re-entry through the cache, no time estimate, no
   self-chaining.
4. (d) cleanup. The function exists; calling it by hand before submission is the fallback.
5. (g) items 3 to 7. Keep items 1 and 2.

**Never cut:** (e) CI, (f) in its minimum form, (a) steps 0 to 2a, and (g) items 1 and 2.

Decision points for cuts: hour 36 and hour 56 (see the schedule).

---

## (a) Extraction accuracy: two passes

### Where we stand (docs/EVALUATION.md, demo answer key)

| Metric | Round 2 |
|---|---|
| Recall | 57.7% (45 of 78) |
| Precision on answer-key topics | 47.5% (48 of 101) |
| Citation pass rate | 99.3% |
| Supersessions found | 1 of 4 |
| Planted conflicts found | 1 of 2 |
| False conflicts | 5 |
| Secrets leaked, restricted token violations | 0 and 0 |

The reverted prompt rewrite reached 73.1% and 67.9% recall on two cold runs but raised false
conflicts to 11 and 12. Two causes: rejected options came out as separate decision claims, and
venue options came out as locations. Note the 5-point spread between two runs of the same
prompt. Any accept rule has to allow for that.

### What the misses and false conflicts tell us

- Misses cluster in procedures (5), risks (4), decisions and reasons (5), status (5), cadences
  written as deadlines (2), and people named by role (4). `lab-late-access` is 0 of 3, most
  likely filed under `lab-booking` or `lab-slot`.
- Two of the three missed supersessions are recall problems: the older value (USB flashing,
  20 Nov) was never extracted, so there was nothing to supersede. The third (`contact`) is
  expected: contact is multi-valued by contract.
- The five false conflicts have four different causes:

| False conflict | Cause | Fix in this design |
|---|---|---|
| competition / location: "Hall B" vs "Lab 3" | A venue option compared with a place for something else | Stance (considered) and event binding |
| domain-dns / location: "NameHarbor (online)" vs "dns/" | A registrar and a repo path are two kinds of location | Location kind |
| recruitment / location: "Near the canteen" vs "README" | Same | Location kind |
| recruitment / deadline: 8 Aug vs 2 Aug 10:00 to 13:00 | Two different events under one entity | Event binding |
| firmware-rollback / status: "known-good build" vs "keep as rollback target" | Two compatible statements by one person | Compatibility check |

### Design

Keep the Round 2 path intact and selectable (`EXTRACT_VERSION=1`). The new path is version 2.
The committed cache keeps the version 1 answers, so falling back is a config change, not a revert.

**Pass 1: candidates (model, one call per batch, as today).** Tuned for recall.

- Start from the reverted rewrite in git history (header times labelled "written", guidance for
  procedure, owner, cadence and access).
- Examples come from a made-up setting that is in neither pack, with no dates. This also removes
  the setting literals from `src/lib/attest/core/prompts.ts`, which Improvement 3 needs.
- Two new fields per candidate. Both are content, and code decides what they mean:
  - `stance`: one of `decided`, `considered`, `rejected`, `open`.
  - `event`: for deadline and location only, the few words from the quote that say what the date
    or place is for ("kickoff", "trial run"). Empty when the quote names nothing.
- New schema name (`extraction_v2`), because the cache key holds only the name.
- Thread context: each batch after the first in a thread starts with the last 3 segments of the
  previous batch (same thread, same role set, so the role rule holds). They are part of the
  batch, so they can be cited. Duplicates this creates are removed in pass 2.

**Pass 2a: consolidation by code (no model, pure functions, new file
`src/lib/attest/core/consolidate.ts`).** Runs per entity after `verifyDrafts`, before `applyRules`.

1. **Merge duplicates.** Same entity, attribute and normalised value, or one value contains the
   other, inside one role set: keep the most specific value and the union of citations. Across
   role sets nothing is merged; `corroborate` already handles agreement.
2. **Re-file to the most specific entity.** If the cited quote names an alias of another pack
   entity and not the one the model chose, move the claim. This is what should recover
   `lab-late-access`. Aliases live in the pack.
3. **Bind dates to named events.** A deadline stays on entity E only when the quote, or the
   sentence around the date in the cited segment, names E by key, label or alias, or the `event`
   words resolve to E. Otherwise it moves to the entity it does name, or to `other`. This is the
   rule that stops a kickoff date being filed under the competition. The `event` words are stored
   on the claim.
4. **Separate "considered" from "decided".** Only stance `decided` yields an active `decision`,
   `location`, `owner` or `deadline`. All `considered` and `rejected` candidates for one entity
   and topic fold into one claim: attribute `decision`, stance `considered`, value "Options:
   A or B", with every citation kept. That is the claim the "options considered" check wants,
   and it matches the planted `competition / decision = Venue options ...`.
5. **Location kind.** Classify each location value by pattern: place, repo path, URL, account
   or service. Stored on the claim.

**Rule changes in `src/lib/attest/core/rules.ts` (`comparable`).** Two claims are compared only when:

- both have stance `decided` (a considered option never conflicts with or supersedes anything);
- for deadline: their `event` words match after normalising, or both are empty;
- for location: they have the same location kind.

Nothing else in the four supersession rules changes.

**Pass 2b: pair judge (model, optional, first thing to cut).** For pairs that the rules would
mark conflicting, and only those, ask the model one small question: are these the same fact, an
update, two compatible facts, or a contradiction? One call per entity and role set, both claims
with their quotes. Code uses the answer in one direction only: "compatible" or "same fact"
removes the comparison. The model can never create a conflict or a supersession. This is aimed
at the `firmware-rollback / status` case. Expect about 10 to 15 small calls on the demo.

**Pass 3: gap-directed re-read (optional, only if recall is still under target).** For a pack
entity that has a blocking checklist attribute with no candidate at all, re-read that entity's
threads with a narrow prompt ("what are the steps", "what goes wrong"). Same exact-quote
verifier. Costly in calls, so it runs only inside the resumable run of fix (b).

**Storage.** `claims` gains `stance`, `event` and `location_kind` (nullable, defaults that match
Round 2 behaviour). `Claim` in `src/lib/types.ts` gains the same fields. Claim ids do not change.

### Measurable targets

Measured by `scripts/eval.ts` on the demo answer key, as the worse of two cold runs.

| Metric | Round 2 | Target | Stretch | Guard (must not get worse than) |
|---|---|---|---|---|
| Recall | 57.7% | 70% | 75% | 57.7% |
| False conflicts | 5 | 3 or fewer | 2 or fewer | 5 |
| Supersessions found | 1 of 4 | 3 of 4 | 3 of 4 | 1 of 4 |
| Planted conflicts found | 1 of 2 | 2 of 2 | 2 of 2 | 1 of 2 |
| Precision on answer-key topics | 47.5% | 55% | 60% | 47.5% |
| Citation pass rate | 99.3% | 99% or more | | 99% |
| Secrets leaked, restricted violations | 0, 0 | 0, 0 | | 0, 0 |
| Per-entity recall | 0% to 100% | every entity at 50% or more, at most two exceptions, none at 0% | | no entity drops by more than one claim |
| Uncached demo run time | about 4.5 min | under 6 min | | under 8 min (needs fix b above 5 min) |

The fourth supersession (`title-sponsor / contact`) stays missing by contract. The report says
so next to the number. We do not change the answer key to make it disappear.

### Rule for accepting a change

1. **Freeze a baseline first.** At the start of the work, and again after Improvement 2's demo
   plants land (they change the WhatsApp batches), run two cold evaluations and record both.
2. **One change at a time,** in this order: 2a rules with the Round 2 prompt (cannot lower
   recall), then the pass 1 prompt, then thread context, then 2b, then pass 3.
3. **Two cold runs per change.** Use the worse run for every metric.
4. **Accept only if all of these hold:**
   - secrets leaked and restricted violations are 0 in both runs;
   - no guard in the table is broken in either run;
   - false conflicts are 5 or fewer in both runs;
   - and either recall rises by 5 points or more over the current baseline, or false conflicts
     fall by 1 or more with recall within 2 points of the baseline.
5. **Check the hold-out.** The research-group answer key (Improvement 3) is never used for
   tuning. Before the final accept, run it once. Report both packs. If the lab pack is clearly
   worse than the club pack, say so in EVALUATION.md.
6. **No answer-key text in prompts or packs.** A second person (Aman) reads the prompt and pack
   diff against `ground_truth.json` before the accept.
7. **Deadline: hour 40.** Whatever is accepted by then ships. If nothing is accepted, ship the
   2a rules with the Round 2 prompt, and write the measured numbers as they are.

A small script change supports this: an `--cold` option for `scripts/eval.ts` that ignores cached
answers for the current prompt on the local database, and a thresholds file the CI gate reads.

### Files touched

`src/lib/attest/core/prompts.ts`, `schema.ts`, `extract.ts` (context overlap), new
`consolidate.ts`, `rules.ts` (`comparable`), `verify.ts` (carry the new fields),
`src/lib/attest/index.ts` (call order, version switch), `src/lib/types.ts`,
`src/lib/db/mappers.ts`, one migration (three columns on `claims`), `scripts/eval.ts`,
`src/lib/attest/core/evaluate.ts` (per-entity floors, hold-out report), `packs/club.json`
(aliases only), `data/demo/model_cache.json` (re-precomputed), `docs/EVALUATION.md`.

### Tests

- Unit, with hand-written candidates (no model): duplicate merge keeps all citations; merge never
  crosses role sets; a deadline whose quote names another entity moves; a deadline with no named
  event goes to `other`; considered and rejected options fold into one claim; a considered
  location never conflicts; two locations of different kinds never conflict; deadlines with
  different event words never conflict.
- One regression test per Round 2 false conflict, built from the real quotes.
- The two planted conflicts and the supersessions that were found still fire.
- Prompt tests: no pack id, role key or demo name in the system prompt; segment text still cannot
  fake a header; the schema name changed.
- Version 1 path still replays the Round 2 cache (the existing demo-prompt test stays).
- CI gate: evaluation from the committed cache, compared with the thresholds file.

### Risk

High. Model variance, a tight clock, and the cache must be re-precomputed after every prompt or
data change. Mitigations: the accept rule, the version switch, the hour-40 deadline, and doing
2a first because it is deterministic and cannot lower recall.

### Hours

About 11: baseline and tooling 1, pass 2a and rule changes with tests 4, prompt and schema 2,
cold runs and decisions 3, hold-out and write-up 1. Owner: Om. Reviewer: Aman.

---

## (b) Large uploads: resumable extraction with progress

### Problem

A run executes inside `after()` in one function with `maxDuration = 300`. The demo's 23 batches
took about 4.5 minutes uncached. A larger upload cannot finish. When the function is killed the
drafts are lost, the run row says "running" for 6 minutes, and the user cannot restart it.

### Approach

Run the pipeline in slices. Each slice is one function call with a time budget. The model cache
is the checkpoint: a batch that finished in an earlier slice replays at once in the next.

1. **Lease.** `runs` gains `lease_until`, `heartbeat_at`, `slices` and `cursor` (step, done,
   total, per-batch attempts). A slice starts by taking the lease in one atomic update (only if
   the lease is empty or expired). Two tabs cannot run the same run twice.
2. **Budget.** A slice gets a deadline of about 150 s for starting new model calls. Calls already
   in flight may finish (120 s timeout), so the worst case is about 270 s, inside the limit.
   Inside a slice, model calls use `retries: 0`. A failed batch is tried again in a later slice,
   at most 3 times in total, then marked failed and shown.
3. **Re-entry.** `reconstruct` takes a deadline. It plans all batches, runs them in order until
   the deadline, and reports `done`, `total`, `cached`, `failed`, `deferred`. If any batch is
   deferred, the step stays "running", the cursor is saved and the slice ends with status
   `paused`. The next slice calls `reconstruct` again: finished batches come from the cache, the
   rest run live. When nothing is deferred, drafts are stored once, as today.
   The same deadline applies to the support check in `verify` and to the stand-in calls in
   `runTest`. Both already go through the cache, so re-entry is the same idea.
4. **Who starts the next slice.** The run panel already polls `GET /api/w/[id]/run` every 1.5 s.
   When the status is `paused`, or `running` with a heartbeat older than 45 s and an expired
   lease, the panel sends `POST /api/w/[id]/run` and the server continues the same run. If the
   tab is closed the run waits; it continues when the page is opened again and says so.
   Stretch: the slice chains itself with a signed internal request, so no open tab is needed.
5. **Progress.** The step shows "Reading 12 of 40 batches (9 from the cache, 1 will be retried)"
   with a bar, a word and a number, never colour alone. After the first slice it shows a rough
   time left from the median batch time.
6. **Limits.** At most 40 slices per run and a total batch cap per workspace (see g3), so a run
   can never loop or spend without bound.
7. **New model steps go inside the run.** Improvement 2's model stage for borderline sensitive
   segments must be a pipeline step under the same budget, not part of the upload request, which
   has `maxDuration = 60`.

Minimum version (keep this if time is short): items 1 to 4 without the time estimate and
without self-chaining.

### Files touched

`src/lib/pipeline/run.ts` (lease, slices, cursor, paused status), `src/lib/attest/index.ts` and
`core/extract.ts` (deadline, deferred batches), `src/lib/attest/core/support.ts` and
`src/lib/lacuna/index.ts` (deadline pass-through), `src/app/api/w/[id]/run/route.ts`,
`src/lib/db/mappers.ts` and `queries.ts` (run status shape), the run panel component in
`src/components/`, one migration (columns on `runs`), `TESTING.md`.

### Tests

- A fake model with a delay and a tiny budget: slice 1 finishes k batches and pauses; slice 2
  finishes; the stored drafts equal a one-shot run.
- Two POSTs at the same moment: one slice runs (lease).
- A slice that dies without cleanup: the next POST after lease expiry continues it.
- A batch that always fails: tried 3 times, marked failed, the run still ends, the note names it.
- Progress counts never go down. The slice cap ends a run with a clear message.
- The demo path is unchanged: one slice, a few seconds (the e2e suite proves this).
- Manual on the live link: a WhatsApp export of about 3 MB runs to the end across slices.

### Risk

Medium. It changes the run path every demo uses. Mitigation: the demo finishes in its first
slice, so the judge path does not exercise the new branches; e2e runs on every pull request.

### Hours

About 7 (minimum version 4). Owner: Aman. Progress UI: Yash.

---

## (c) Invite links per role

### Problem

Anyone with a workspace link can pick any role. That is right for a demo and useless for a team.

### Approach

Two access modes per workspace, stored on `workspaces.access_mode`.

- **`open` (demo behaviour).** The role switcher works as today. Every demo workspace is always
  open. A workspace started empty begins open, with a plain banner: "Roles are open. Anyone with
  this link can view as any role. Lock roles to invite your team."
- **`invite` (locked).** The role comes only from a signed session cookie. The switcher is
  hidden and `setRole` is refused. Locking is one-way and logged. The person who locks becomes
  the approver for that browser.

We start empty workspaces open so that a judge who uploads a file can still try every role
without juggling links. A team locks it with one click.

**Tokens.** No new library; `node:crypto` only.

- Invite token: `base64url(payload) . base64url(HMAC-SHA256(payload, INVITE_KEY))`. Payload:
  workspace id, role key, invite id, expiry, version.
- Table `invites`: workspace, invite id, role key, a label (the person's name), optional person
  id, created by, created at, expires at (default 7 days), redeemed at, revoked at. The token
  itself is never stored.
- Link: `/w/<id>/join?t=<token>`. The join route checks the signature with a constant-time
  compare, then the workspace, expiry, revocation and redemption. It sets an httpOnly, Secure,
  SameSite=Lax cookie `us_sess_<workspaceId>` holding a signed session (workspace, role, invite
  id, label, issued at) and redirects to the first page that role uses. The join response sends
  `Referrer-Policy: no-referrer`.
- One link per person, single use. The approver can revoke and reissue. A revoked invite ends
  its session on the next request, because `getRole` checks the invite row.
- If `INVITE_KEY` is not set, locking is disabled with a clear message. There is no default key.

**Server changes.** `getRole(ws)` in `src/lib/session.ts` becomes the single gate:

- open workspace: the cookie as today, default president;
- invite workspace: a valid session or nothing. No session means the "You need an invite link"
  page for pages and 401 for API routes. No default role.

Role keys are validated against the workspace's pack (after the hour 0 to 4 pack refactor), so
invites work for the research-group setting too.

**Who may do what when locked.** Create, revoke and list invites: approver only. Upload and
start a run: approver and leaver. Everything else is unchanged, because every rule already reads
the role on the server ("the leaver can never approve" needs no change).

**UI.** A "Team" panel on Connect for the approver: one row per role, a name field, "Create
link", copy button, status (not opened, opened on a date, revoked). The header shows "Signed in
as Incoming tech lead (Arjun)" in place of the switcher.

**Honest label.** An invite link proves that someone holds the link. It is not an account and
not a password. README and TESTING say this in those words.

### Files touched

`src/lib/session.ts`, new `src/lib/invite.ts` (sign, verify, session), new join route under
`src/app/w/[id]/join/`, `src/app/w/actions.ts` (`setRole` guard, lock action, invite actions),
`src/components/RoleSwitcher.tsx`, the workspace layout, the Connect page, the four API routes
under `src/app/api/w/[id]/` (401 when locked and no session), one migration (`invites`,
`workspaces.access_mode`), `.env.example`, README, TESTING.

### Tests

- Token: a changed role, workspace or expiry fails; an expired token fails; a token signed with
  another key fails; a token for workspace A fails on workspace B.
- Redeem: second use refused; revoked refused; a revoked invite's session stops working.
- Locked workspace with no session: every page under `/w/[id]` and every API route refuses.
- `setRole` is refused when locked. Lock is one-way.
- A leaver session cannot approve; a new-member session cannot read a finance claim (the same RLS
  tests, entered through a session).
- Demo workspaces are unchanged (the e2e judge path).
- Canary: the join page and the invite panel show no restricted token.

### Risk

High. It touches the function every permission check starts from. Mitigations: `getRole` keeps
its signature, the open mode is byte-for-byte the old behaviour, and the fix merges only after
the improvements are in (hour 36 or later). First in the cut order.

### Hours

About 8. Owner: Yash. Reviewer: Aman.

---

## (d) Scheduled cleanup of old workspaces

### Approach

- A cron entry in `vercel.json` calls `GET /api/cron/purge` once a day (about 03:00 IST). Daily
  is what the Hobby plan allows; check the plan limit at kickoff.
- The route requires `Authorization: Bearer <CRON_SECRET>`, which Vercel sends when the variable
  is set. Anything else gets 401.
- A new SQL function replaces the age-only rule. `workspaces` gains `last_active_at`, updated at
  most once an hour from the workspace layout.

| Workspace | Deleted when |
|---|---|
| Demo copy | created more than 7 days ago |
| Started empty, still open, no snapshot | no activity for 14 days |
| Locked (invite mode) or has an approved snapshot | never by the cron; only by hand |

- It deletes in batches (200 workspaces per call) inside the 20 s query timeout, and returns the
  count. A `dry=1` parameter returns what would be deleted without deleting.
- `model_cache` is never touched. Every child table already has `ON DELETE CASCADE`, and the
  append-only triggers already allow deletes under `us.allow_purge`.
- During judging, set demo retention to 14 days so no judge's link dies. Run the dry mode first
  and read the number before the real cron is switched on.

### Files touched

`vercel.json`, new `src/app/api/cron/purge/route.ts`, one migration (column and function), the
workspace layout (activity stamp), `.env.example`, `docs/ARCHITECTURE.md` section 5.

### Tests

Database tests: an old demo workspace is deleted with every child row (count each table); a
fresh one stays; a locked one stays; one with a snapshot stays; the dry mode deletes nothing.
Route test: no secret or a wrong secret gets 401.

### Risk

Low, but it deletes data. The keep rules and the dry mode are the protection.

### Hours

About 2. Owner: Aman.

---

## (e) CI on GitHub Actions

One workflow, on every push to main and every pull request. Newer runs cancel older runs of the
same branch. Each job has a 10-minute timeout. No job calls a live model.

| Job | What it does | Notes |
|---|---|---|
| lint and types | install with a frozen lockfile, `pnpm lint`, type check | Needs a `typecheck` script in `package.json` |
| test | Postgres 16 service with a health check, `pnpm db:migrate`, `pnpm db:seed`, `pnpm test` | `DATABASE_URL` points at the service. `IDENTITY_KEY` and `CONTACTS_KEY` are fixed dummy test values in the workflow, not secrets. `scripts/load-env.ts` already lets the environment win and tolerates a missing `.env.local`. |
| leak suite | The RLS, canary, leak-integration and (new) paraphrase-probe suites as their own job | A separate green check a judge can point at. Same database setup. |
| setting literals | The check from Improvement 3: no pack id or role key literal under `src/lib` outside the pack loader | Starts as soon as the pack refactor merges |
| evaluation gate | `scripts/eval.ts` from the committed cache, no network, compared with a thresholds file | Deterministic and fast (under 2 s in Round 2). Fails if recall or false conflicts pass a guard. |
| build | `pnpm build` with dummy environment values | Confirms the production build |
| e2e (local server) | Build, start, run Playwright against `localhost` with the seeded cache and `LACUNA_MODEL=cache` | No secrets. Uploads the Playwright report as an artefact. Confirm at kickoff that the Ask step still shows a score change with cached or deterministic answers. |
| e2e (preview), optional | Runs when Vercel reports a successful preview deployment; `E2E_BASE_URL` is the preview URL | Needs deployment protection off for previews or a bypass secret, and a preview database with the cache seeded. Cut first. |

Also: a status badge in the README, required checks on main (lint, test, leak, build), and an
opt-in job for the real pooler regression test when `POOLER_TEST_URL` is set as a secret.

### Files touched

New `.github/workflows/ci.yml`, `package.json` (scripts `typecheck`, `test:leak`, `eval:gate`),
a thresholds file for the gate, README (badge), TESTING.md ("No CI" leaves the known limits).

### Tests

The workflow is its own test. Before relying on it: open a pull request with a deliberately
failing test and one with a planted canary leak, and confirm both go red. Then delete them.

### Risk

Low. The likely snag is the database roles (`us_reader`) on the service container; the service
user is a superuser, as in local Docker.

### Hours

About 3 (2 without e2e). Owner: Yash. Done in hours 1 to 4 so every later merge passes through it.

---

## (f) Faster re-test after an answer

### Problem

Saving an answer takes 6 to 16 s. `answerQuestion` in `src/lib/lacuna/index.ts` waits for two
full `runTest` calls (successor and new member). Each replays every responsibility from the
cache and makes one live stand-in call for the answered one. The live call writes a verdict for
every check of that responsibility, and the answer speed is bound by output length.

### Approach

1. **Re-judge only what the answer can change.** `runTest` gets a `scope` option: a set of
   responsibility ids and, inside them, check keys. For an answer, the scope is every
   responsibility whose entities include the new claim's entity, and the checks whose attribute
   list includes the claim's attribute. All other results are copied from the last stored run.
   Scores are recomputed over the full result set. The stand-in prompt lists only the scoped
   checks, so the reply is one or two verdicts, not five.
2. **Safe to splice only when nothing else moved.** Each test run stores a fingerprint of the
   claims it read (count and newest update time). A scoped run is allowed when the last run's
   fingerprint matches the state just before the answer was saved. Otherwise a full run happens.
3. **Deterministic first.** The rule-based reading takes milliseconds, and the model can only
   lower coverage. The action returns the deterministic scoped result at once, labelled
   "checking". The model verdict for the scoped checks runs in `after()` and the page updates by
   the poll that already exists. If the model lowers a check, the line changes and says why.
4. **New member in the background.** The leaver never sees the new-member score. That run moves
   to `after()`.
5. **One shared path.** A single function takes "a statement from a person" and does: mask,
   segment, claim, scoped re-test, score delta. The leaver answer (today), the neighbour answer
   (Improvement 1) and the successor finding (Improvement 3) all call it with a different trust
   label. Build it before those two features wire up their pages.

### Targets

| Measure | Round 2 | Target |
|---|---|---|
| Save to first visible score change | 6 to 16 s | under 2 s |
| Save to model-confirmed line | 6 to 16 s | under 6 s at the median |
| e2e timeout for the answer step | 120 s | 30 s |

### Files touched

`src/lib/lacuna/index.ts` (`runTest` scope, `answerQuestion`, the shared statement path),
`src/lib/lacuna/core/standin.ts` (prompt for a subset of checks), `src/app/w/[id]/ask/actions.ts`
and the Ask page (the "checking" state), `src/app/w/actions.ts`, one migration (fingerprint and
scope columns on `test_runs`), `tests/e2e/judge-path.spec.ts` (shorter timeout), TESTING.md.

### Tests

- Equivalence: for each demo gap question, with the deterministic stand-in, a scoped run gives
  the same results and scores as a full run.
- The same with a fake model that lowers one check.
- A claim on an entity shared by two responsibilities puts both in scope.
- A fingerprint mismatch forces a full run.
- The trust rules still hold: "Leaver said" raises C and not K.
- Only the leaver can answer (unchanged).

### Risk

Low to medium. The danger is a stale splice; the fingerprint guard and the equivalence tests
cover it. A full re-run button stays on the Test page.

### Hours

About 4. Owner: Advait.

---

## (g) Other weak spots

From the known limits in TESTING.md and from reading the code. In order of value.

| # | Weak spot | Fix | Hours | Owner |
|---|---|---|---|---|
| 1 | **Read-back can show "Nothing to check".** In the Round 2 live check, two of five critical items had no approved claim, so a judge saw a three-item read-back. | Before approval, Review lists the read-back items that have no approved claim, each with a link to the claims that could fill it. A warning, not a block. The judge guide and the e2e path approve those claims. | 1.5 | Yash |
| 2 | **Upload limit says 5 MB; the live site fails at about 4.5 MB** with a platform error, not our message. | Limit and text at 4 MB. Client-side check before sending. | 0.5 | Aman |
| 3 | **No spend cap.** Anyone can start an empty workspace and run the paid model. If the credit runs out during judging, uploads fail. `client.ts` already notes HTTP 402 on low credit. | A daily cap on live model calls, per workspace and global, from an environment value. When reached: "The demo's model budget for today is used. The cached demo still works." Top up the credit before hour 0 and check it at hour 56. | 1.5 | Aman |
| 4 | **The browser suite covers the judge path only.** | New Playwright specs: upload a small file and run; tier C review with a reason; read-back and acknowledge; Markdown export; and one spec per improvement (recovery ladder, sensitive panel and probes, finding to snapshot v2, the research-group demo). | 3 (shared) | each feature owner |
| 5 | **Lacuna's reported numbers use the planted claims**, a perfect extractor. | EVALUATION.md gains an end-to-end line: B, C and K from the real cached extraction next to the planted-claim numbers. | 1 | Advait |
| 6 | **"Source correct" is 71.1%** for matched claims. | Read the 13 mismatches once. Fix the answer key if it is too strict, or the extractor if a claim cites a weaker source when a stronger one exists. Part of (a). | 1 | Om |
| 7 | **No licence file.** README says so. | The team decides (MIT is the usual choice) and adds it. | 0.2 | Aman |

Already covered elsewhere: no CI (e); paraphrase leaks (Improvement 2); the role switcher is not
sign-in (c); model quality is not unit-tested (the evaluation gate in e); the pooler check is
opt-in (the optional job in e); retries that outlive the function and dead runs that block (b).

---

## 3. Migrations these fixes need

One person (Aman) numbers and merges all Round 3 migrations so two branches never claim the same
number. All are additive, so the Round 2 build still runs against the new schema and a Vercel
rollback stays possible.

| Fix | Change |
|---|---|
| (a) | `claims`: stance, event, location kind |
| (b) | `runs`: lease, heartbeat, slice count, cursor, a `paused` status |
| (c) | `workspaces`: access mode. New table `invites` |
| (d) | `workspaces`: last active. New purge function |
| (f) | `test_runs`: claims fingerprint, scope |

## 4. Open questions for kickoff

1. CI runs as a trace source: add a synthetic run history to the demo GitHub export, or explain
   the change? (Round 2 field 13.)
2. Is a second Supabase project available for staging, or do previews share the production
   database?
3. Is the Vercel plan limited to daily cron? (Only matters for d.)
4. Licence: which one?
5. Invite links: start empty workspaces open (this design) or locked?
