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
  Prompts end with `/no_think`. Output is parsed with zod; one retry on invalid JSON; then the step reports
  "model unavailable" and continues with the deterministic paths. The model never sets labels, roles,
  statuses, scores or approvals.
- Tests: vitest (unit, rules, canary), Playwright (end-to-end on the live URL).
- No vector search. No Python at runtime.

## 1. The demo setting (setting pack `packs/club.json`)

A fictional college robotics club. Priya (leaver) is the outgoing tech lead and graduates. Roles
(`RoleKey`):

| key | label | notes |
|---|---|---|
| `president` | Club President | the approver; sees everything |
| `tech_lead` | Incoming tech lead | the successor tested by default |
| `new_member` | New member | sees least |
| `treasurer` | Treasurer | holds finance |
| `leaver` | Priya (outgoing tech lead) | answers gap questions; can never approve |

The setting pack holds: roles, source-to-role defaults, the closed attribute list with per-attribute
source authority, the five checklist kinds with checks and weights, role templates, footprint
thresholds, the five critical read-back items, review-tier rules. Core code never branches on the
setting; it reads the pack.

### 1a. Setting pack shape (`packs/club.json`, validated by zod in `src/lib/pack/`)

```jsonc
{
  "id": "club", "name": "College robotics club",
  "roles": [{ "key": "president", "label": "Club President" }, ...],   // all five RoleKeys
  "approverRole": "president", "successorRole": "tech_lead", "leaverRole": "leaver",
  "contactsRoles": ["president", "tech_lead", "treasurer", "leaver"],
  "entities": [{ "key": "firmware-deploy", "label": "Firmware deploy to the robot",
                 "aliases": ["deploy", "flash", "firmware"] }, ...],      // canonical entity keys for extraction
  "sourceAuthority": { "deadline": { "tasks_csv": 3, "ics": 3, "markdown": 2, "slack": 1, "whatsapp": 1, "github": 1, "interview": 1 }, ... },  // all 11 attributes
  "checklists": { "deploy_operate": [{ "key": "rollback", "label": "Rollback", "wTag": "HOW", "weight": 5,
                   "attributes": ["procedure"] }, ...], ... },            // the five kinds from section 4
  "roleTemplates": { "tech_lead": [{ "key": "R03", "title": "Book the workshop lab each term",
                     "kind": "recurring_obligation", "entities": ["lab-booking"] }] },
  "footprint": { "repeatMin": 3, "distinctWeeksMin": 2, "ownershipShare": 0.8, "windowMonths": 6 },
  "readback": [{ "key": "competition_date", "label": "Competition date", "type": "date",
                 "entity": "competition", "attribute": "deadline" }, ...],   // exactly five
  "uploadDefaults": { "roleSet": ["president", "tech_lead", "new_member", "treasurer", "leaver"] }
}
```

## 2. Vocabulary (exact strings, used in UI and code)

Coverage of a check, per role: `covered` "Covered", `partial` "Partial", `missing` "Missing",
`restricted` "Restricted", plus `conflicting` "Conflicting".

Trust (strongest first): `from_record` "From record", `corroborated` "Corroborated",
`leaver_said` "Leaver said", `second_hand` "Second-hand", `inferred` "Inferred",
`ranked_options` "Ranked options". Nothing a person said is ever labelled verified.

Claim states: `active`, `superseded` "Superseded", `conflicting` "Conflicting", `dropped`.

Closed attribute list (11): `owner`, `status`, `deadline`, `location`, `procedure`, `access`
(credential names, never values), `decision`, `reason`*, `dependency`*, `contact`*, `risk`.
`*` = multi-valued: values collect and never conflict.

## 3. Core types (`src/lib/types.ts`, the only shared type file)

See the file itself; it is the source of truth. Summary: `RoleKey`, `SourceKind`
(`whatsapp | slack | github | tasks_csv | markdown | ics | interview`), `Segment`, `Source`,
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
`roles:`). Data level shown on Connect: L0 none, L1 task board, L2 + chat, L3 + code/config.

**Claims (Attest).** Extraction runs per thread, batched by role set: a model call only ever sees
segments with one identical role set. Output schema: `{ claims: [{ entity, attribute, value,
statement, citations: [{ segment_id, quote }] }] }`. Structured sources (task CSV, ICS) produce claims
deterministically (no model). Verifier:
- `norm(x)` = lowercase(NFKC(x)), markdown markup removed, whitespace collapsed.
- citation accepted iff segment exists in this workspace AND was in the batch the model saw.
- trust `from_record` iff accepted AND quote given AND `norm(quote)` is a substring of `norm(segment)`.
- accepted without a valid quote: at most `inferred` until a reviewer confirms.
- no accepted citation: claim `dropped` and counted per source.
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
from claims the leaver may see. An answer becomes a segment (kind `interview`, author = leaver) and a
claim with trust `leaver_said`; it raises C but not K until a record backs it (then `corroborated`).
The leaver may narrow an answer's role set, never widen it.
Continuation plan: every open blocking gap needs owner, due date and the approver's risk note.

**Review and Handover (Relay).** Tiers: C = sensitive (role set excludes `new_member`), conflicting,
or blocking importance; A = corroborated, normal, no flags (bulk approve); B = everything else
(approve / edit / reject one by one). Tier C needs evidence opened and a written reason.
Snapshot: canonical JSON of approved claim statements + evidence segment IDs and versions +
continuation plan, hashed SHA-256, versioned v1, v2, ... Approver must be `president`; `leaver` can
never approve (server-side check + test). Release rule: B > 0 cannot be approved until every blocking
gap has owner, due date and risk note; then shown everywhere as "Released with N open blocking gaps",
never as complete.
Compile per role: inside `withRole(workspaceId, role)` read the snapshot's approved claims; render
through fixed templates (no model rewrites handover text) in I-PASS order:
I Workstream status (B, C, K and release state), P Project summary, A Action list (owners, dates),
S Situation awareness and contingency (risks, dependencies, conflicts), S Synthesis by receiver
(typed read-back). Plus a decision timeline (decision + reason claims by time), open items, and stubs.
Stub text exactly: "N restricted items. Ask the approver (Club President)." It never shows topic,
compartment, owning role or any value. Its count comes from `count_withheld()` (SECURITY DEFINER,
returns an integer only). Read-back: the successor types the five critical items from the pack; typed
parsers normalise (dates to ISO, strings via norm); code compares exactly with the snapshot; verdict per
item; an acknowledgement row records verdicts, role, time and snapshot hash.
Canary tests: restricted segments in the demo pack carry tokens `CANARY-XXXX`. For every role and every
surface (handover text, export, stubs, scores, timeline, questions), no token outside that role's
visibility may appear. Runs as a vitest suite and as a "Leak check" panel in the app.

## 5. Permissions: RLS is the compile boundary

- Tables owned by the migration user. Role `us_reader` (NOLOGIN) gets SELECT on role-scoped tables.
  RLS enabled and forced on `segments`, `claims`, `contacts`, `snapshot_claims`.
- `withRole(workspaceId, role, fn)`: `BEGIN; SET LOCAL ROLE us_reader; SELECT set_config('request.jwt.claims',
  '{"workspace_id":"…","role_key":"…"}', true); …fn…; COMMIT`.
- Policy: `workspace_id = (claims->>'workspace_id')::uuid AND (claims->>'role_key') = ANY(role_set)`.
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
db/migrations/              0001_core (foundation), 0002_tether, 0003_attest, 0004_lacuna, 0005_relay
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
