# Understudy: architecture contract (Round 2)

This file is the contract every builder follows. Product rules come from the Round 1 plan
(team DRACONIX, CodersInPune, Knowledge Handover challenge). If code and this file disagree,
this file wins; change it first, then the code.

Product line: a handover that finds what the leaving person actually did, tests the draft
against the work the successor must do, asks only what the record cannot answer, and shows
each role only what it may see.

## 0. Stack

- Next.js 16 (App Router, TypeScript strict, Tailwind v4), pnpm. Deployed on Vercel.
- Postgres (Supabase in production, `postgres:16` in Docker for local dev). Driver: `postgres` (porsager).
  Plain SQL migrations in `db/migrations/NNNN_name.sql`, applied by `pnpm db:migrate`.
- Model: any OpenAI-compatible chat endpoint. Env: `MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY`.
  Self-hosted: Ollama `http://localhost:11434/v1`, `qwen3:8b` (no source text leaves the machine).
  Deployed demo: OpenRouter `qwen/qwen3-32b` (same open-weight Qwen3 family; OpenRouter retired
  `qwen/qwen3-8b` on 9 Oct 2026, and a public link cannot reach a laptop GPU).
  Hosting: Vercel functions pinned to `icn1` (Seoul) next to the Supabase database; production uses
  the Supabase transaction pooler (port 6543), because the session pooler allows only 15 clients.
  Every call goes through `src/lib/model/client.ts`, which caches by `sha256(model_tag + prompt + schema)`
  in table `model_cache` and in the committed file `data/demo/model_cache.json` (seeded on `pnpm db:seed`).
  Prompts end with `/no_think`. Each request has a 120 s timeout; timeouts, 429s, 5xx and dropped
  connections are retried up to 3 times with exponential backoff (same prompt, same cache key).
  Output is parsed with zod; one retry on invalid JSON; then the step reports
  "model unavailable" and continues with the deterministic paths. The model never sets labels, roles,
  statuses, scores or approvals.
- Tests: vitest (unit, rules, canary), Playwright (end-to-end on the live URL). vitest runs with
  `MODEL_DISABLED=1` and `LACUNA_MODEL=off`: no test calls the live model (cache or a fast failure);
  tests that need model answers inject a fake call.
- No vector search. No Python at runtime.

## 1. Settings and setting packs

A setting is one kind of organisation (a college club, a research group). Everything Understudy
knows about a setting lives in a **setting pack**, `packs/<id>.json`, and in that pack's demo data
under `data/`. Core code (everything under `src/`, plus `db/migrations/` and `next.config.ts`) never
names a role key, a role label, a pack id, a person or a place from any setting: it reads the pack.
`scripts/check-literals.ts` enforces this and runs with `pnpm test`.

A workspace belongs to one pack for life. `workspaces.pack_id` is set when the workspace is created
and cannot change; `getWorkspacePack(ws)` returns that pack. `packs/index.json`
(`{ "default": "<id>", "demos": ["<id>", ...] }`) is how core learns which packs exist: the default
is used for an empty workspace, and each demo pack gets a button on the landing page.

**Roles are defined by the pack.** A `RoleKey` is a string matching `^[a-z][a-z0-9_]{1,31}$`. A role
gets its job in core from flags on the pack's role list, never from its key:

| flag | job | how many |
|---|---|---|
| `approver` | the only role that reviews claims and approves snapshots | exactly one |
| `successor` | the role the stand-in successor is tested as; its scores gate release | exactly one |
| `leaver` | the leaving person: answers gap questions, can never review or approve | exactly one |
| `restrictedAudience` | "sees least": a claim hidden from such a role is sensitive (tier C); also tested | at least one, never the approver or the leaver |

From the flags the loader derives `approverRole`, `successorRole`, `leaverRole`,
`restrictedAudienceRoles`, `testRoles` (the successor, then every restricted audience role) and
`roleOrder` (the order of `roles`, the canonical order of any role set).

The first pack is `packs/club.json`, a fictional college robotics club (the Round 2 demo):

| key | label | flag |
|---|---|---|
| `president` | Club President | approver; sees everything |
| `tech_lead` | Incoming tech lead | successor |
| `new_member` | New member | restricted audience; sees least |
| `treasurer` | Treasurer | none; holds finance |
| `leaver` | Priya (outgoing tech lead) | leaver |

### 1a. Setting pack shape (`packs/<id>.json`, validated by zod in `src/lib/pack/`)

Objects are loose: a key a module adds later is kept. The loader (`resolvePack`) rejects a pack that
breaks a rule below with a readable message, at load.

```jsonc
{
  "id": "club", "name": "College robotics club",
  "roles": [                                              // order = canonical role order
    { "key": "president", "label": "Club President", "short": "Club President", "approver": true },
    { "key": "tech_lead", "label": "Incoming tech lead", "short": "the incoming tech lead", "successor": true },
    { "key": "new_member", "label": "New member", "short": "a new member", "restrictedAudience": true },
    { "key": "treasurer", "label": "Treasurer", "short": "the Treasurer" },
    { "key": "leaver", "label": "Priya (outgoing tech lead)", "short": "Priya", "leaver": true }
  ],
  "approverRole": "president", "successorRole": "tech_lead", "leaverRole": "leaver",   // legacy, optional; must agree with the flags
  "leaverPerson": { "name": "Priya", "aliases": [] },     // the leaver's name as the sources show it (footprint, role holders)
  "roleHolders": { "president": ["Rohan Mehta"], "tech_lead": ["Arjun Rao"], ... },    // who holds which role, by full name; a role nobody holds is left out
  "contactsRoles": ["president", "tech_lead", "treasurer", "leaver"],
  "entities": [{ "key": "firmware-deploy", "label": "Firmware deploy to the robot",
                 "aliases": ["deploy", "flash", "firmware"] }, ...],      // canonical entity keys for extraction
  "sourceAuthority": { "deadline": { "tasks_csv": 3, "ics": 3, "markdown": 2, "slack": 1, "whatsapp": 1, "github": 1, "interview": 1, "finding": 1 }, ... },  // all 11 attributes
  "checklists": { "deploy_operate": [{ "key": "rollback", "label": "Rollback", "wTag": "HOW", "weight": 5,
                   "attributes": ["procedure"] }, ...], ... },            // the five kinds from section 4
  "roleTemplates": { "tech_lead": [{ "key": "R03", "title": "Book the workshop lab each term",
                     "kind": "recurring_obligation", "entities": ["lab-booking"] }] },
  "footprint": { "repeatMin": 3, "distinctWeeksMin": 2, "ownershipShare": 0.8, "windowMonths": 6 },
  "readback": [{ "key": "competition_date", "label": "Competition date", "type": "date",
                 "entity": "competition", "attribute": "deadline" }, ...],   // the critical read-back items
  "uploadDefaults": { "roleSet": ["president", "tech_lead", "new_member", "treasurer", "leaver"] },   // must include the approver
  "extraction": {                                         // optional; every string is part of the model cache key
    "examples": { "owner": "value \"...\", statement \"...\"", ... },   // one example line per attribute
    "entityHint": "an entry fee is entry-fee, not competition",
    "contactExample": "Rahul Desai"
  },
  "demo": {                                               // optional; a pack without it is for empty workspaces only
    "dataDir": "data/demo",                               // holds sources.json, ground_truth.json, model_cache.json
    "today": "2026-11-11T12:00:00+05:30",                 // the fixed "now" of the demo story
    "button": "Open the robotics-club demo", "pendingText": "Creating your private copy…",
    "title": "College robotics club", "blurb": "...", "sampleAnswer": "..."
  },
  "kindLabels": { ... },                                  // optional display names for the five responsibility kinds
  "kindOverrides": { ... },                               // optional; pins a responsibility kind per entity or card
  "sensitivity": {                                        // optional: who may see each kind of sensitive content (section 4a)
    "finance": ["president", "treasurer", "leaver"],      //   all three categories, each list includes the approver
    "hr": ["president"], "health": ["president"] },       //   a pack without the key keeps every category for its approver only
  "sensitivityTerms": { "finance": { "weak": ["cost centre"] } },   // optional: extra classifier terms per category (strong, weak)
  "forbiddenInCore": ["Priya", "Club President", ...]     // proper nouns the literal check must never find in core
}
```

Loader rules: role keys unique; exactly one approver, one successor and one leaver, all different;
at least one restricted audience role, not the approver or the leaver; every role named in
`contactsRoles`, `uploadDefaults.roleSet`, `roleTemplates`, `roleHolders` and `sensitivity` is a role
of this pack; `sensitivity`, when present, lists exactly `finance`, `hr` and `health`, each with at
least the approver; `uploadDefaults.roleSet` includes the approver; legacy `approverRole` and friends agree
with the flags; `readback[].entity` and `roleTemplates[].entities[]` exist in `entities`;
`extraction.examples` keys are attributes; `demo.dataDir` exists and holds `sources.json`.

The extraction prompt prints `Example: <text>` after an attribute's definition only when the pack
gives one, and the entity hint and contact example in brackets only when present. The club's values
were moved from code byte for byte, so the club's prompts and model cache keys are unchanged
(`tests/pack/golden.test.ts`).

## 2. Vocabulary (exact strings, used in UI and code)

Coverage of a check, per role: `covered` "Covered", `partial` "Partial", `missing` "Missing",
`restricted` "Restricted", plus `conflicting` "Conflicting".

Trust (strongest first): `from_record` "From record", `corroborated` "Corroborated",
`leaver_said` "Leaver said", `successor_found` "Successor found", `second_hand` "Second-hand",
`inferred` "Inferred", `ranked_options` "Ranked options". Nothing a person said is ever labelled
verified. The ladder is written once in `src/lib/trust.ts`: `STRONG_TRUST` (covers a check, raises C)
is the record plus "Leaver said" and "Successor found"; `RECORD_TRUST` (raises K) is the record only.

Claim origin: `extracted` and `structured` are read from the record by Attest. `leaver_answer`,
`neighbour_answer`, `trace` and `successor_finding` are written by other modules and carried across
re-runs (`src/lib/attest/core/origins.ts`).

Claim states: `active`, `superseded` "Superseded", `conflicting` "Conflicting", `dropped`.

Closed attribute list (11): `owner`, `status`, `deadline`, `location`, `procedure`, `access`
(credential names, never values), `decision`, `reason`*, `dependency`*, `contact`*, `risk`.
`*` = multi-valued: values collect and never conflict.

## 3. Core types (`src/lib/types.ts`, the only shared type file)

See the file itself; it is the source of truth. Summary: `RoleKey` (a pack-defined string),
`SourceKind` (`whatsapp | slack | github | tasks_csv | markdown | ics | interview | finding`),
`SegmentKind` (`message | commit | file | task | note | event | answer | finding`), `Segment`, `Source`,
`Person`, `Attribute`, `Trust`, `Coverage`, `Claim`, `Citation`, `Responsibility`, `CheckDef`,
`CheckResult`, `TestRun`, `GapQuestion`, `Snapshot`, `ReadbackItem`.

## 4. Data rules (enforced in code; each has a unit test)

**Segments (Tether).** One adapter per format, each a pure function `(file text or bytes, ctx) =>
{ segments, rejected, people }`. Segment ID = `seg_` + first 16 hex of
`sha256(sourceKind | iso timestamp | thread | position | sha256(norm(text)))`. Never built from a
display name. Segments are immutable; a changed re-import creates a new version.
Masking runs before storage and before any model call: secrets (GitHub/AWS/Slack/OpenAI-style keys,
private keys, `password=`/`token=`/`secret=` assignments, high-entropy tokens of 20+ chars) become
`[SECRET:<type>]` and the value is discarded; emails and phone numbers become `[CONTACT:p-<n>]`,
the real value stored AES-256-GCM encrypted (key from env `CONTACTS_KEY`) in `contacts`, revealed only
to roles in the pack's `contacts_roles`. Identity: people merge automatically only on an exact email,
compared as HMAC-SHA256 with env `IDENTITY_KEY`; other matches are suggestions only.
Role set of a segment = the source's role set from the pack (notes may narrow it with front matter
`roles:`), then narrowed by what the segment says (section 4a) before it is first stored.
Data level shown on Connect: L0 none, L1 task board, L2 + chat, L3 + code/config.

**Claims (Attest).** Extraction runs per thread, batched by role set: a model call only ever sees
segments with one identical role set. Output schema: `{ claims: [{ entity, attribute, value,
statement, citations: [{ segment_id, quote }] }] }`. Structured sources (task CSV, ICS) produce claims
deterministically (no model). A person's own words are never sent to extraction: segments of kind
`answer` (gap answers) and `finding` (successor findings) are skipped, so a re-run cannot turn an
answer into a "From record" claim quoted from the answer itself. Verifier:
- `norm(x)` = lowercase(NFKC(x)), markdown markup removed, whitespace collapsed.
- citation accepted iff segment exists in this workspace AND was in the batch the model saw.
- trust `from_record` iff accepted AND quote given AND `norm(quote)` is a substring of `norm(segment)`.
- accepted without a valid quote: at most `inferred` until a reviewer confirms.
- no accepted citation: claim `dropped` and counted per source.
- a model `deadline` whose date is only the day its cited segments were written, while their text
  states no such date (and no "today"/"tomorrow"), is `dropped` too: a header time read as an event date.
- `corroborated` when two claims agree on entity + attribute + normalised value and are independent
  (different source kinds OR different authors), and at least one side is backed by a record
  (from_record or corroborated). This lets a record confirm a leaver's answer even when the leaver
  wrote the record.
- support check (model, yes / partly / no) can only lower trust, never raise it.
- claim role set = intersection of its cited segments' role sets (most restrictive).
Supersession, for two claims on the same entity and single-valued attribute with different values,
t1 < t2, authority from the pack per attribute:
1. authority(src2) > authority(src1): claim 1 superseded.
2. equal authority AND (same author OR claim 2 replies to/quotes claim 1): claim 1 superseded, "updated on t2".
3. equal authority, different authors, no link: both `conflicting`, ask a person.
4. authority(src2) < authority(src1): both `conflicting`, newer marked "possibly outdated owner".
Carry-over: `verify()` re-derives only the claims Attest owns (origin `extracted` or `structured`); one
of those that a later run no longer produces is marked `dropped`. Claims of every other origin are
written by other modules and are never dropped or rewritten by a re-run. `leaver_answer` and
`successor_finding` claims take part in the rules above; `neighbour_answer` and `trace` claims do not
(they are weaker than any record and never supersede or conflict with one).
Every change is a row in `claim_events` (append-only: no UPDATE/DELETE grants). The `claims` table
is the current projection.

**Test and Ask (Lacuna).** Inventory = task board (open + recently active cards) + leaver footprint
(same action 3+ times over 2+ distinct weeks; 80%+ of changes to a path or messages about an entity in
6 months; sole contact with an external person; schedules: calendar, cron, CI, yearly renewals;
credential names) + role template. Merge by entity; approver confirms. Each responsibility has a kind
with typed checks (weights normal 1, important 3, blocking 5):
- deploy_operate: access path (WHERE, 3), steps (HOW, 3), how to verify (HOW, 3), rollback (HOW, 5), credential owner (WHO, 5)
- external_relationship: contact person (WHO, 5), last interaction (WHEN, 1), open commitments (WHY, 3), next date (WHEN, 3)
- recurring_obligation: cadence (WHEN, 3), next due date (WHEN, 5), how to do it (HOW, 3), consequence if missed (WHY, 1)
- open_decision: current state (WHERE, 3), options considered (WHY, 1), owner (WHO, 5), deadline (WHEN, 3)
- unfinished_work: where it lives (WHERE, 3), last state (WHERE, 3), next concrete step (HOW, 5), who reviews it (WHO, 1)
Each check lists the attributes that can satisfy it.
The stand-in successor (model) gets only claims visible to the target role (read under RLS), active,
not dropped, plus the checklist; prompt: "You must do this tomorrow. For each check, cite claim IDs or
say what stops you." Code drops citations to claims that do not exist, are not visible or are
superseded. A check with no visible evidence but evidence for other roles is `restricted` (count from
the metadata function, never the rows). Deterministic fallback when the model is unavailable: a check
is covered if a visible active claim on the entity has a satisfying attribute with trust from_record or
corroborated or leaver_said; partial if only inferred.
Scores, in code: s = covered 1, partial 0.5, missing 0; restricted slots leave the score.
B = blocking checks not covered (missing, partial or conflicting); a restricted blocking check counts
until an authorised owner is named. C = Σ w·s / Σ w. K = Σ w·s over checks backed by from_record or
corroborated / Σ w·s (n/a when nothing covered). UI shows B, then C, then K; never one percentage.
Scores are provisional until review; any edit triggers a re-test.
Gap questions: rank gaps by weight × uncertainty (missing 1, conflicting 0.8, partial 0.5) × urgency
(due within 14 days 1.5, else 1); top 10; text from a template per check kind and gap type; built only
from claims the leaver may see. An answer becomes a segment (segment kind `answer` in a source of
kind `interview`, author = leaver) and a
claim with trust `leaver_said`; it raises C but not K until a record backs it (then `corroborated`).
The leaver may narrow an answer's role set, never widen it.
Continuation plan: every open blocking gap needs owner, due date and the approver's risk note.

**Review and Handover (Relay).** Tiers: C = sensitive (the role set leaves out a role the pack flags
`restrictedAudience`), conflicting,
or blocking importance; A = corroborated, normal, no flags (bulk approve); B = everything else
(approve / edit / reject one by one). Tier C needs evidence opened and a written reason.
Snapshot: canonical JSON of approved claim statements + evidence segment IDs and versions +
continuation plan, hashed SHA-256, versioned v1, v2, ... Only the pack's approver role approves; its
leaver role can never approve. Checked on the server (`checkApprover(by, roles)`) and in the database:
a trigger on `snapshots` compares `approved_by` with the workspace's `approver_role` and
`leaver_role`, which are copied from the pack at creation and never change. Release rule: B > 0 cannot be approved until every blocking
gap has owner, due date and risk note; then shown everywhere as "Released with N open blocking gaps",
never as complete.
Compile per role: inside `withRole(workspaceId, role)` read the snapshot's approved claims; render
through fixed templates (no model rewrites handover text) in I-PASS order:
I Workstream status (B, C, K and release state), P Project summary, A Action list (owners, dates),
S Situation awareness and contingency (risks, dependencies, conflicts), S Synthesis by receiver
(typed read-back). Plus a decision timeline (decision + reason claims by time), open items, and stubs.
Stub text exactly: "N restricted items. Ask the approver (<approver label from the pack>)." ("1
restricted item." for one; for the club: "Ask the approver (Club President)."). It never shows topic,
compartment, owning role or any value. Its count comes from `count_withheld()` (SECURITY DEFINER,
returns an integer only). Read-back: the successor types the five critical items from the pack; typed
parsers normalise (dates to ISO, strings via norm); code compares exactly with the snapshot; verdict per
item; an acknowledgement row records verdicts, role, time and snapshot hash.
Canary tests: restricted segments in the demo pack carry tokens `CANARY-XXXX`. For every role and every
surface, no token outside that role's visibility may appear, and no restricted fact in other words
either (section 4a, "Leak check"). Runs as a vitest suite and as a "Leak check" panel in the app.

## 4a. Content-level confidentiality (Round 3)

Where a message was posted decides its source role set. What it says can narrow that further.

**Classifier (Tether, `src/lib/tether/sensitivity.ts`, lexicons in `sensitivity-lexicon.ts`).**
Three categories, a closed core list: `finance`, `hr`, `health`. The pack maps each to the roles that
may see it (`sensitivity`). Two stages, both between parsing and the first write in `ingestSources`:
1. Rules, pure: strong hits limit the segment (stage `rule`; a reply to a limited message inherits,
   stage `follow`); weak hits make it borderline. One weak term alone is clear. Repository files only
   honour strong rules. Rule ids: F1 account pattern, F2 amount + personal-money cue + person,
   F3 cue + name + fee or dues, F4 weak finance; H1 complaint + another person, H2 judgement near a
   name, H3 weak; M1 condition + person, M2 weak; R1 reply link, R2 follow-up window (4 messages,
   20 minutes, borderline only).
2. Model, borderline segments only, batched by one source and one role set, 4,000 characters, 20 s
   budget. It answers one enum per segment id (`finance | hr | health | none`), validated by zod. A
   category narrows; `none` leaves the source role set. The model cannot widen and never sees a
   strong hit. Segments that narrowing would not change are not sent.
Fail closed: a borderline segment the model could not be asked about (down, not cached, budget used,
no answer for its id) is held: limited to its candidate categories with stage `held` until the
approver decides.
Narrowing: new role set = current role set cut down to the pack's roles for every hit category. It
never adds a role; if nothing would be left, the set is unchanged. The narrowed set is the first
role set ever stored (`role_set`); the source role set is kept in `role_set_original`.
Segments made outside ingest (answers, findings) call `narrowForSensitivity(text, kind, roleSet,
packSensitivity(pack), knownNames)` before their insert and store what it returns (rules only; a
borderline text is held). Every pipeline run also calls `reclassify(ws)`: head segments stored by an
older rules version, or by a module that did not classify, are checked by the rules; a newly
sensitive one gets a narrower version and its derived rows shrink at once. Nothing is widened there.
Because extraction batches by identical role set, a limited segment only ever sits in a model call
whose role set is its own (tested: `tests/tether/sensitivity-ingest.test.ts`).
A claim that cites a segment with a non-empty `sensitivity` is tier C.

**Visibility changes (`src/lib/tether/visibility.ts`).** Segments are immutable, so a change is a new
version row; readers only see the head version (RLS). Only the pack's approver may change one segment,
with a written reason of at least 10 characters, logged in `audit_log` (`widen_segment`,
`limit_segment`) and on the new version (`visibility_note`, `visibility_actor`).
Widen: the target set S must satisfy current ⊆ S ⊆ `role_set_original`; stage `widened`; the pipeline
re-runs; handovers change only with the next approved snapshot (a banner says so).
Limit: target = narrowing by the chosen categories; stage `manual`; in the same transaction the claims
that cite the segment and their copies in every snapshot lose the removed roles, open gap questions
are deleted and stand-in notes citing those claims are blanked; then the pipeline re-runs. The stored
snapshot payload and hash are not touched. This is the only code path that adds a role to a stored
segment (widen), and no path does it without the approver.

**Flag visibility (Attest, `core/flags.ts`).** A role sees a conflicting claim only if it can also see
a claim it conflicts with; a claim whose every counterpart is hidden is hidden too (a stub, and the
check reads Restricted). With two sides: a role sees a conflict only if it can see every side. The
same for a superseded claim whose winner the role cannot see. `verify()` writes `claims.flag_role_set`
(null = nothing extra to hide); approval copies it to `snapshot_claims`. The approver settles the
conflict in Review: rejecting one side clears the flag and the other side is visible again.

**Leak check (Relay).** `src/lib/relay/surfaces.ts` is a registry of surface providers; each returns
the exact strings a role is shown, read under that role. Surfaces: handover text, export, stubs,
scores, timeline, questions, conflict flags, claim list, test notes, sensitive panel, and (owned by
other modules, wired in `surface-sources.ts`; "Not built" and not counted until then) people graph,
neighbour questions, traces, ranked options, what changed. Two rows per role and surface:
exact tokens (`scanForCanaries`) and reworded facts. Reworded facts are the planted facts of
`<demo.dataDir>/probes.json` (`{ id, fact, roleSet, termGroups, mustGroups, minGroups, rewordings,
hardRewordings }`); a role is only checked for facts it may not see. Check 1, key terms
(`core/probes.ts`): text and terms are normalised (amounts to digits, dates to one form, a light
stem); a fact is found in one line when at least `minGroups` term groups match and every must group
is among them. Check 2, a model judge (`relay/probes.ts`): one call per role and chunk; it can only
add findings, and a finding counts only when its quote is in the text (else it is kept as
unconfirmed). The judge never runs on a page render: it runs from the approver's "Run probes again"
and from `scripts/probe-eval.ts`, and its results are stored in `probe_runs` (admin only). The export
guard refuses an export that holds a restricted token or a reworded restricted fact.
`scripts/probe-eval.ts` scores the classifier on the labelled evaluation set (in a scratch workspace;
hard rewordings never enter the live demo), runs the detector check and the probes, and writes
`docs/PROBE_RESULTS.md` and `<demo.dataDir>/probe_summary.json` (read by `/w/[id]/probes`).

## 5. Permissions: RLS is the compile boundary

- Tables owned by the migration user. Role `us_reader` (NOLOGIN) gets SELECT on role-scoped tables.
  RLS enabled and forced on `segments`, `claims`, `contacts`, `snapshot_claims`.
- `withRole(workspaceId, role, fn)`: `BEGIN; SET LOCAL ROLE us_reader; SELECT set_config('request.jwt.claims',
  '{"workspace_id":"…","role_key":"…"}', true); …fn…; COMMIT`.
- Policy: `workspace_id = (claims->>'workspace_id')::uuid AND (claims->>'role_key') = ANY(role_set)`.
  On `segments` also `version = us_segment_head(workspace_id, id)`: a reader only ever sees the newest
  version, so an older, wider version is never readable again. On `claims` and `snapshot_claims` the
  role test is `us_can_see(role, role_set, flag_role_set)`; `count_withheld()` and `claim_meta()` use
  the same function, so the three cannot drift apart. `count_limited(ws, role)` returns how many
  messages in sources the role can open were limited away from it (an integer only).
- Compile, successor test, gap questions and every handover/export read go through `withRole`. Admin
  steps (import, extraction, review writes) run as the app user and are logged.
- Workspaces: each visitor gets a private copy (`POST /api/workspaces` clones the demo pack or creates an
  empty one). The workspace UUID is in the URL; the current role is a cookie `us_role_<workspaceId>`.
  No sign-up. Workspaces older than 7 days may be deleted.

## 6. Code layout and ownership (parallel builders stay in their lane)

```
src/lib/types.ts            shared types (foundation owns; others propose changes in their report)
src/lib/db/                 client, withRole, queries helpers (foundation)
src/lib/model/              OpenAI-compatible client + cache (foundation)
src/lib/pack/               setting-pack loader (foundation)
src/lib/tether/             adapters, masking, identity, ingest (Tether builder)
src/lib/attest/             extraction, verifier, rules, ledger, evaluation (Attest builder)
src/lib/lacuna/             inventory, checklists, test, scores, questions, plan (Lacuna builder)
src/lib/relay/              tiers, snapshot, compile, stubs, readback, canary (Relay builder)
src/lib/pipeline/           run orchestration across steps (foundation)
src/app/                    landing + /w/[id]/{connect,claims,test,ask,review,handover,evaluation}
src/components/             shared UI (foundation); step-specific components live next to their page
db/migrations/              0001_core (foundation), 0002_tether, 0003_attest, 0004_lacuna, 0005_relay,
                            0006_packs, 0008_confidentiality (segment sensitivity, head-version rule, flag visibility, probe_runs)
packs/club.json             setting pack (data builder)
data/demo/                  synthetic robotics-club exports + ground_truth.json + model_cache.json (data builder)
tests/                      vitest + playwright
```

## 7a. Input formats (the data builder writes these; the Tether adapters read them)

Adapter entry point (pure, no DB): `src/lib/tether/adapters/index.ts`
`parseSource(kind: SourceKind, files: { path: string; content: string }[], ctx: AdapterContext): AdapterResult`
where `AdapterContext = { sourceId: string; roleSet: RoleKey[]; identityKey: string; contactsKey: string;
people: PersonRegistry }` and `PersonRegistry` resolves/creates `Person` ids across sources (exact
email HMAC merge only). Masking is applied inside every adapter before a Segment is returned.

- `whatsapp`: one `.txt` chat export, Android style, one message per line, continuation lines belong to
  the previous message: `12/08/26, 21:14 - Priya Nair: text`. System lines (no `Name:`) are skipped.
  Chat name = file name. WhatsApp has no emails; people match by name only as a suggestion.
- `slack`: a folder with `users.json` (`[{ id, real_name, profile: { email } }]`) and one
  `<channel>.json` per channel (`[{ ts: "1723456789.000100", user, text, thread_ts?, reply_to? }]`).
  Thread = `#channel`. `thread_ts` links replies (used by the supersession rule 2).
- `github`: a folder with `commits.json` (`[{ sha, author_name, author_email, date, message,
  files: [{ path, status }] }]`) plus repository files under `files/` (e.g. `files/README.md`,
  `files/.github/workflows/deploy.yml`). Commits become `commit` segments; each file becomes `file`
  segments split by heading or top-level YAML key (thread = file path). A live public repo URL is
  fetched by `src/lib/tether/github-fetch.ts` into the same shape (last 100 commits, README, workflow
  files, up to 25 small text files).
- `tasks_csv`: header `id,title,status,owner,owner_email,due,labels,updated_at,description`. One `task`
  segment per row; `meta` holds the parsed fields. Malformed rows go to `rejected` with the reason.
- `markdown`: one `.md` per note, optional front matter `title`, `date`, `author`, `author_email`,
  `roles` (comma list that narrows the source role set). Split into segments by heading.
- `ics`: one `.ics` calendar; each VEVENT becomes an `event` segment; RRULE recurrences expanded for
  the next 12 months into `meta.occurrences` (one segment per series, not per occurrence).

Demo pack layout: `data/demo/{whatsapp/,slack/,github/,tasks/,notes/,calendar/}` plus
`data/demo/sources.json` listing each source `{ kind, name, path, roleSet }` and
`data/demo/ground_truth.json` (planted claims, gaps, supersessions, conflicts, restricted items with
canary tokens, off-board duties, critical read-back answers).

## 7. UI principles

- A stepper across the top: Connect, Reconstruct, Verify, Test, Ask, Review, Handover, always saying
  what to do next. A role switcher ("Viewing as") in the header. A judge must finish without help.
- Status is never colour alone: every chip has a symbol and a word. Keyboard operable. WCAG AA contrast.
- Every claim opens its source segment with the quote highlighted.
- Fail visibly: missing sources, failed citations, model outages are shown, never hidden.
- Plain words over jargon. Copy is short.
