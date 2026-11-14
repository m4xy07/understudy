# Understudy Round 3, improvement 3: Living handover and a second setting

Build-ready design spec. Planning only: nothing here is product code, a migration, a test file or a dataset file.
Lead: Advait, with Om. Read against main at `05473dd`. Line numbers are from that commit and must be re-checked when the window opens.

Done when (from ROUND3_PLAN.md): a successor finding goes through review into the next snapshot with the score change explained, and the research-group setting runs with zero core code changes.

Contents

- A. Pack refactor (lands first, hours 0 to 4)
- B. Living handover
- C. Second setting: a university research group
- D. Tests, edge cases, task breakdown, builder briefs
- E. Conflicts with the plan and open questions

Words used the same way everywhere in this file:

| Word | Meaning |
|---|---|
| core | everything under `src/`, plus `db/migrations/` and `next.config.ts` |
| setting data | `packs/`, `data/`, and nothing else |
| finding | one thing the successor learned after release, recorded on the First weeks page |
| approver, successor, leaver | the three roles a pack flags; never a literal role key |
| restricted audience | a role a pack flags as "sees least"; a claim hidden from it is sensitive |

---

## A. Pack refactor

### A1. Goal

After this step no file in core names a role key, a role label, a pack id, a person or a place from any setting. A workspace knows its pack. The club demo behaves exactly as before and replays from the committed model cache.

Done when:

1. `pnpm test` passes with the club pack and the same test count as before, plus the new tests in A9.
2. `pnpm tsx scripts/check-literals.ts` exits 0, and exits 1 when a role key literal is put back into any core file.
3. A demo workspace created after the refactor produces the same extraction prompts and the same claim ids as one created before it (golden hashes, A8).
4. The stub line for the club still reads exactly `N restricted items. Ask the approver (Club President).`

### A2. What "new_member" and friends really mean

The five club keys are used in core for four different jobs. Each job gets a pack-level name.

| Today in core | Job | New source |
|---|---|---|
| `"president"` | the only role that reviews and approves | role flagged `approver` |
| `"tech_lead"` | the role the stand-in successor is tested as | role flagged `successor` |
| `"leaver"` | the person leaving; answers questions; can never approve | role flagged `leaver` |
| `"new_member"` in tier rules | "a claim this role cannot see is sensitive" | roles flagged `restrictedAudience` |
| `"new_member"` in test runs | "also test this role" | derived `testRoles` = successor plus every restricted audience role |
| `"treasurer"` | no special job in core | nothing; it is just a role |
| the fixed order of the five keys | canonical order of a role set | derived `roleOrder` = the order of `roles` in the pack |
| first word of the leaver label | the leaver's name, used to find their person records | `leaverPerson.name` |

### A3. Pack shape, version 2

`RoleKey` stays as a name in `src/lib/types.ts` but becomes `string` (a key defined by the pack). The zod schema checks the format and the loader checks that every key used anywhere in a pack is one of that pack's roles.

Signatures (not code to paste; the builder writes them):

```
// src/lib/types.ts
type RoleKey = string            // pack-defined; format ^[a-z][a-z0-9_]{1,31}$

// src/lib/pack/schema.ts
RoleKeyZ   = string matching ^[a-z][a-z0-9_]{1,31}$
PackRoleZ  = { key: RoleKeyZ, label: string, short?: string,
               approver?: boolean, successor?: boolean, leaver?: boolean,
               restrictedAudience?: boolean }
PackZ adds = {
  roles: PackRoleZ[],
  approverRole?, successorRole?, leaverRole?: RoleKeyZ,   // legacy; if present must agree with the flags
  leaverPerson: { name: string, aliases?: string[] },
  kindLabels?: Record<ResponsibilityKind, string>,
  extraction?: { examples: Record<Attribute, string>, entityHint?: string, contactExample?: string },
  demo?: { dataDir: string, today: string, button: string, pendingText?: string, title: string, blurb: string },
  sensitivity?: Record<string, RoleKey[]>,               // owned by improvement 2
  forbiddenInCore?: string[],                            // proper nouns the literal check must never find in core
}

// src/lib/pack/index.ts
interface ResolvedPack extends Pack {
  approverRole: RoleKey; successorRole: RoleKey; leaverRole: RoleKey;
  restrictedAudienceRoles: RoleKey[];
  testRoles: RoleKey[];        // [successor, ...restrictedAudienceRoles], no duplicates
  roleOrder: RoleKey[];        // roles.map(r => r.key)
}
getPack(id: string): ResolvedPack                 // no default argument any more
getWorkspacePack(ws: string): Promise<ResolvedPack>   // reads workspaces.pack_id; memoised per workspace id
listPacks(): { id, name, demo? }[]                // from packs/index.json
defaultPackId(): string                           // from packs/index.json
isRoleOf(pack, x: unknown): x is RoleKey
roleLabel(role, pack), roleShort(role, pack), checklistFor(kind, pack), entityLabel(key, pack), authority(attr, kind, pack)
                                                  // pack is now a required argument on all of them
```

Validation rules the loader enforces (each gets a unit test):

| Rule | Error text |
|---|---|
| role keys are unique | `roles: duplicate key "x"` |
| exactly one approver, one successor, one leaver, all different | `roles: need exactly one approver, one successor and one leaver` |
| at least one restricted audience role; it is not the approver or the leaver | `roles: flag at least one restrictedAudience role` |
| every key in `contactsRoles`, `uploadDefaults.roleSet`, `roleTemplates`, `sensitivity` is a role of this pack | `contactsRoles: unknown role "x"` |
| `uploadDefaults.roleSet` contains the approver | `uploadDefaults.roleSet must include the approver` |
| legacy `approverRole` and friends, when present, equal the flags | `approverRole disagrees with the role flagged approver` |
| `readback[].entity` and `roleTemplates[].entities[]` exist in `entities` | `readback: unknown entity "x"` |
| `demo.dataDir` exists and holds `sources.json` | `demo.dataDir not found` |

`packs/index.json` (setting data, new): `{ "default": "club", "demos": ["club"] }`. Builder C adds `"lab"`. This file is how core learns a pack id without holding one.

Changes to `packs/club.json` (data only, described, not written here):

| Key | Value |
|---|---|
| role flags | `president` approver; `tech_lead` successor; `leaver` leaver; `new_member` restrictedAudience |
| role `short` | "Club President", "the incoming tech lead", "a new member", "the Treasurer", "Priya" |
| `leaverPerson` | name "Priya" (the same word the current first-word rule yields, so the footprint is unchanged) |
| `extraction.examples` | the eleven example strings now in `ATTRIBUTE_GUIDE`, byte for byte |
| `extraction.entityHint` | `an entry fee is entry-fee, not competition` (byte for byte) |
| `extraction.contactExample` | `Rahul Desai` |
| `demo` | dataDir `data/demo`, today `2026-11-11T12:00:00+05:30`, button "Open the robotics-club demo", title "College robotics club", blurb in C8 |
| `sourceAuthority.*.finding` | 1 for all eleven attributes (see B5) |
| `forbiddenInCore` | Priya, Club President, robotics, RoboLeague, Vertex, Pawar, Kulkarni, Rahul Desai |
| legacy `approverRole`, `successorRole`, `leaverRole` | kept this round, cross-checked against the flags |

### A4. Approver label in stub text

`stubText(n, approverLabel)` in `src/lib/relay/core/compile.ts` loses its default; `DEFAULT_APPROVER_LABEL` is deleted. Every caller passes `roleLabel(pack.approverRole, pack)`. The contract text becomes: `N restricted items. Ask the approver (<approver label from the pack>).` Singular for one. The lab pack yields `Ask the approver (Principal investigator).`

All other copy that names a role is built from the pack:

| Where | New copy (template) |
|---|---|
| progress hint, Test | `See what {successor.short} still could not do tomorrow.` |
| progress hint, Ask | `Switch to {leaver.short} and answer a gap question.` |
| progress hint, Review | `As {approver.label}, approve claims, plan open gaps, then approve the snapshot.` |
| inventory guard | `Only the approver ({approver.label}) can confirm the inventory.` |
| plan guard | `Only the approver ({approver.label}) can set the continuation plan.` |
| review guard, leaver | `The leaver can never review or approve the handover. Switch to {approver.label}.` |
| export, no snapshot | `The approver hasn't approved a handover yet. Switch to {approver.label} and go to Review.` |
| Test page | `The approver ({approver.label}) sets an owner, a due date and a risk note for each on the Review page.` |
| Test page | `Found from the task board, the leaver's footprint (what {leaver.short} actually did, off the board) and the role template.` |
| Ask page button | `Switch to {leaver.short} to answer` |
| Connect empty state | `Use the upload form on this page, or go back to the start page and open a demo.` |
| Evaluation page | `The answer key only describes the synthetic demo data. Open a demo workspace to see precision and recall.` |

### A5. Core signatures that change

Pure cores take the facts they need as arguments. Nothing in a `core/` folder imports the pack loader.

```
// src/lib/relay/core/labels.ts   (APPROVER_ROLE, LEAVER_ROLE, DEFAULT_APPROVER_LABEL removed)
interface ApprovalRoles { approver: RoleKey; leaver: RoleKey; approverLabel: string }
checkApprover(by: RoleKey, roles: ApprovalRoles): RelayError | null

// src/lib/relay/core/review.ts
assignTier(claim, restrictedAudience: readonly RoleKey[]): ReviewTier
applyReview(claim, action, roles: ApprovalRoles): ReviewResult
bulkApproveTierA(claims, by, roles: ApprovalRoles, at?): BulkResult

// src/lib/relay/core/snapshot.ts
approveSnapshot({ by, roles: ApprovalRoles, releaseState, payload, at? }): ApproveResult

// src/lib/relay/core/compile.ts
stubText(n: number, approverLabel: string): string | null
CompileInput.approverLabel: string            // required

// src/lib/attest/core/verify.ts            (ROLE_ORDER removed)
AttestPack adds { roleOrder: RoleKey[]; restrictedAudience: RoleKey[] }
intersectRoleSets(sets: RoleKey[][], order: readonly RoleKey[]): RoleKey[]

// src/lib/attest/core/extract.ts           (ROLE_ORDER removed)
canonicalRoleSet(roles, order: readonly RoleKey[]): RoleKey[]
PlanOptions adds { roleOrder: readonly RoleKey[] }

// src/lib/attest/core/rules.ts
isSensitive(roleSet, restrictedAudience): boolean      // true when any restricted audience role is missing
tierOf(claim, restrictedAudience): ReviewTier

// src/lib/attest/core/prompts.ts + schema.ts
ExtractionPack adds { examples?: Record<Attribute, string>; entityHint?: string; contactExample?: string }
ATTRIBUTE_GUIDE keeps the definitions only; examples come from the pack

// src/lib/attest/index.ts
tierFor(claim, pack: ResolvedPack): ReviewTier

// src/lib/lacuna
questionText(gap, resp, check, kind, leaverVisibleClaims, leaverRole: RoleKey)   // no default
leaverName(pack) -> pack.leaverPerson.name                                        // no label parsing
workspaceNow(ws) -> pack.demo.today for demo workspaces, else the real time       // DEMO_NOW removed

// src/lib/session.ts                          (DEFAULT_ROLE removed)
getRole(ws: string, pack: ResolvedPack): Promise<RoleKey>      // cookie value if isRoleOf(pack, v), else pack.approverRole

// src/lib/db/withRole.ts                      (ROLE_KEYS removed)
isRoleKey(x): boolean                          // format check only
withRole(ws, role, fn)                         // unchanged call shape

// src/lib/pipeline/ingest.ts
createDemoWorkspace(packId: string)
createEmptyWorkspace(name?: string, packId?: string)   // packId defaults to defaultPackId()

// src/lib/tether/demo.ts
loadDemoSources(rootDir: string)               // no default
```

Why a format check is enough in `withRole`: the policy is `role_key = ANY(role_set)`. A role key that no row lists sees nothing. Membership in the pack is checked where the role enters the system: the cookie reader (`getRole`), the `setRole` action, and form fields that carry role keys.

Prompt text, exact rule for cache stability: `buildSystemPrompt` prints `Example: <pack example>` when the pack gives one and prints nothing after the definition when it does not. Rule 9 prints `Pick the most specific entity (<entityHint>); use "other" when no entity fits.` with the hint, and `Pick the most specific entity; use "other" when no entity fits.` without it. The contact line prints `(e.g. "<contactExample>")` only when present. With the club values copied byte for byte, the club prompt is unchanged.

### A6. Workspace stores its pack id; database and RLS

`workspaces.pack_id` already exists (default `'club'`) but core never reads it: `getPack()` is called with no id in about 35 places, so every workspace is treated as the club. After the refactor every one of those calls becomes `await getWorkspacePack(ws)` or uses the pack already loaded by `loadWorkspace`.

Migration `db/migrations/0006_packs.sql` (outline only; the foundation builder writes it):

| Change | Why |
|---|---|
| `workspaces.pack_id`: drop the default | the app always supplies it; no pack id in SQL |
| `workspaces.approver_role text`, `workspaces.leaver_role text`, filled at creation from the pack, then `NOT NULL` | lets the database keep enforcing who may approve without a literal |
| guard on update of `pack_id`, `approver_role`, `leaver_role` (raise, like `us_immutable`) | a workspace never changes setting |
| `snapshots`: drop `CHECK (approved_by = 'president')` | this literal would reject every lab snapshot |
| trigger `us_check_approver` before insert on `snapshots`: `approved_by` must equal the workspace's `approver_role` and must differ from its `leaver_role` | the "leaver can never approve" rule stays enforced in the database |
| backfill for rows that exist: club values where `pack_id = 'club'` | one allow-listed line; old workspaces are purged after 7 days anyway |
| widen the four enum checks used by this improvement: `sources.kind` and `segments.kind` add `finding`; `claims.trust` adds `successor_found`; `claims.origin` adds `successor_finding` | types and database must agree from hour 4 so all three branches compile and insert |

RLS: nothing changes. `role_set` stays `text[]` on `segments`, `claims`, `contacts`, `snapshot_claims`, `attest_dropped`. The policy stays `workspace_id = us_claim('workspace_id')::uuid AND us_claim('role_key') = ANY(role_set)`. `count_withheld(ws, role, section)` and `claim_meta(ws)` already take the role as text. There is no enum of roles anywhere in the schema, so a new pack needs no migration.

Things to check in the database after the migration: a snapshot insert with `approved_by` set to the leaver role fails; with a role of another pack fails; with the approver role succeeds; the RLS suite (`tests/db/rls.test.ts`) passes unchanged for the club and passes again with the lab role keys.

### A7. Hardcoded setting knowledge: every place found

Grep at `05473dd` for role key literals, "Club President", "Priya", "club", "robotics", demo proper nouns and `data/demo` paths, outside `packs/` and `data/`. 63 places. "Fix" names the pack value that replaces it.

Core library (`src/lib`), 44 places:

| # | File and line | What is hardcoded | Fix |
|---|---|---|---|
| H01 | `src/lib/types.ts:4` | `RoleKey` is a union of the five club keys | `RoleKey = string` |
| H02 | `src/lib/types.ts:105-106, 199` | comments name club entities and `"president"` | neutral comments |
| H03 | `src/lib/pack/schema.ts:5` | `RoleKeyZ` enum of the five keys | format check plus loader rules (A3) |
| H04 | `src/lib/pack/index.ts:12` | `packPath(id = "club")` | required id |
| H05 | `src/lib/pack/index.ts:16-17` | `getPack(id = "club")` and its comment | required id |
| H06 | `src/lib/pack/index.ts:31, 35, 39, 44` | four helpers default to `getPack()` | required `pack` argument |
| H07 | `src/lib/db/withRole.ts:11` | `ROLE_KEYS` list, used by `isRoleKey` | format check; `isRoleOf(pack, x)` at the edges |
| H08 | `src/lib/db/mappers.ts:50` | `pack_id ?? "club"` | no fallback; column is `NOT NULL` |
| H09 | `src/lib/session.ts:7` | `DEFAULT_ROLE = "president"` | `pack.approverRole` |
| H10 | `src/lib/progress.ts:40` | "the incoming tech lead" | `{successor.short}` |
| H11 | `src/lib/progress.ts:42` | "Switch to Priya (leaver)" | `{leaver.short}` |
| H12 | `src/lib/progress.ts:44` | "As Club President" | `{approver.label}` |
| H13 | `src/lib/attest/index.ts:101` | tier C when role set lacks `"new_member"` | `isSensitive(roleSet, pack.restrictedAudienceRoles)` |
| H14 | `src/lib/attest/core/rules.ts:425-429` | same rule in `tierOf` | argument `restrictedAudience` |
| H15 | `src/lib/attest/core/rules.ts:143` | comment "Priya Nair" | neutral comment |
| H16 | `src/lib/attest/core/verify.ts:31` | `ROLE_ORDER` | `pack.roleOrder` argument |
| H17 | `src/lib/attest/core/extract.ts:27` | `ROLE_ORDER` | `roleOrder` option |
| H18 | `src/lib/attest/core/prompts.ts:6-51` | eleven prompt examples from the club (Priya Nair, firmware deploy, the robot, Lab B-204, Teensy, faculty sign-off) | `pack.extraction.examples` |
| H19 | `src/lib/attest/core/prompts.ts:81` | "an entry fee is entry-fee, not competition" (club entity keys) | `pack.extraction.entityHint` |
| H20 | `src/lib/attest/core/prompts.ts:84` | "Rahul Desai" | `pack.extraction.contactExample` |
| H21 | `src/lib/attest/dates.ts:62` | comment "the club's Indian locale" | neutral comment |
| H22 | `src/lib/attest/evaluation.ts:36` | path `data/demo/ground_truth.json` | `pack.demo.dataDir` |
| H23 | `src/lib/lacuna/index.ts:39-40, 51` | `DEMO_NOW` fixed date | `pack.demo.today` |
| H24 | `src/lib/lacuna/index.ts:136` | "Only the Club President can confirm the inventory." | template (A4) |
| H25 | `src/lib/lacuna/index.ts:447` | fallback author id `"leaver"` | `null`, with the role in `meta` |
| H26 | `src/lib/lacuna/index.ts:506` | `runTest(ws, "new_member")` | loop over `pack.testRoles` |
| H27 | `src/lib/lacuna/index.ts:559` | "Only the Club President can set the continuation plan." | template (A4) |
| H28 | `src/lib/lacuna/core/questions.ts:124` | comment names `packs/club.json` | neutral comment |
| H29 | `src/lib/lacuna/core/questions.ts:171` | default `leaverRole = "leaver"` | required argument |
| H30 | `src/lib/lacuna/adapt.ts:47-51` | leaver's name taken from the first word of the role label | `pack.leaverPerson.name` |
| H31 | `src/lib/relay/core/labels.ts:5` | `APPROVER_ROLE = "president"` | `ApprovalRoles.approver` |
| H32 | `src/lib/relay/core/labels.ts:7` | `LEAVER_ROLE = "leaver"` | `ApprovalRoles.leaver` |
| H33 | `src/lib/relay/core/labels.ts:9` | `DEFAULT_APPROVER_LABEL = "Club President"` | deleted |
| H34 | `src/lib/relay/core/review.ts:46-50` | sensitive when role set lacks `"new_member"` | argument `restrictedAudience` |
| H35 | `src/lib/relay/core/compile.ts:104, 112-113` | default label "Club President" | required argument |
| H36 | `src/lib/relay/core/snapshot.ts:231` | comment "(president)" | neutral comment |
| H37 | `src/lib/relay/index.ts:48` | comment with the club stub text | neutral comment |
| H38 | `src/lib/relay/index.ts:58` | "Switch to the Club President." | template (A4) |
| H39 | `src/lib/relay/handover.ts:447` | path `data/demo/ground_truth.json` for canary tokens | `pack.demo.dataDir`; cache per pack id |
| H40 | `src/lib/relay/handover.ts:494` | "Switch to Club President and go to Review." | template (A4) |
| H41 | `src/lib/pipeline/run.ts:61` | tested roles `[successor, "new_member"]` | `pack.testRoles` |
| H42 | `src/lib/pipeline/ingest.ts:132-139` | `createDemoWorkspace()` knows one demo | `createDemoWorkspace(packId)` |
| H43 | `src/lib/tether/demo.ts:40` | default `rootDir = "data/demo"` | required argument |
| H44 | about 35 call sites in 13 files (`lacuna/index.ts` 10, `relay/handover.ts` 7, `relay/index.ts` 3, `pipeline/ingest.ts` 3, `attest/index.ts` 2, `pipeline/run.ts`, `page.ts`, `app/w/actions.ts`, `ask/actions.ts` 2, `layout.tsx`, `review/actions.ts`, `handover/actions.ts`, `test/actions.ts`) | `getPack()` with no id, so every workspace is the club | `getWorkspacePack(ws)` |

App and components (`src/app`), 10 places:

| # | File and line | What is hardcoded | Fix |
|---|---|---|---|
| H45 | `src/app/page.tsx:52-53` | footer tells the club story | generic footer (C8) |
| H46 | `src/app/LandingActions.tsx:25` | one button, "Open the robotics-club demo" | one card per pack in `packs/index.json` |
| H47 | `src/app/w/actions.ts:111` | `runTest(ws, "new_member")` | `pack.testRoles` |
| H48 | `src/app/w/[id]/layout.tsx:66-67` | `role === "leaver"` and a "Priya" comment | `role === pack.leaverRole` |
| H49 | `src/app/w/[id]/test/page.tsx:63` | targets `[successor, "new_member"]` | `pack.testRoles` |
| H50 | `src/app/w/[id]/test/page.tsx:145` | "The Club President sets" | template (A4) |
| H51 | `src/app/w/[id]/test/page.tsx:166` | "what Priya actually did" | `{leaver.short}` |
| H52 | `src/app/w/[id]/evaluation/page.tsx:43` | "the synthetic robotics-club pack" | generic copy (A4) |
| H53 | `src/app/w/[id]/connect/page.tsx:73` | "open the robotics-club demo" | generic copy (A4) |
| H54 | `src/app/w/[id]/ask/page.tsx:96`, `ask/actions.ts:42` | first word of the leaver label; "Priya" comment | `roleShort(leaver, pack)` |

Database, config, scripts, docs, tests, 9 places:

| # | File and line | What is hardcoded | Fix |
|---|---|---|---|
| H55 | `db/migrations/0001_core.sql:78` | `pack_id ... DEFAULT 'club'` | dropped in `0006_packs.sql` |
| H56 | `db/migrations/0001_core.sql:249` | `CHECK (approved_by = 'president')` | dropped; trigger in `0006_packs.sql` |
| H57 | `next.config.ts:8` | file tracing ships only `./data/demo/**/*` | `./data/**/*` (without this the lab demo works locally and fails on Vercel) |
| H58 | `scripts/precompute.ts:27, 73, 91` | answer text about "Arjun Rao", roles `tech_lead` and `new_member`, actor `"leaver"` | `--pack`; roles from the pack; answer text from the answer key |
| H59 | `scripts/check-demo.ts` (lines 14, 66-90, 268, 447, 497, 509-519) | validates only the club: fixed labels, "Priya Nair" footprints, `packs/club.json` | `--pack`; generic checks; expectations read from the answer key |
| H60 | `scripts/eval.ts:58-76` | writes club commentary and reads `data/demo` | `--pack`; commentary moves to `<dataDir>/EVAL_NOTES.md` |
| H61 | `scripts/seed.ts:19`, `scripts/export-cache.ts:28`, `scripts/precompute.ts:146` | one cache file `data/demo/model_cache.json` | one file per pack at `<dataDir>/model_cache.json`; seed loads all |
| H62 | `docs/ARCHITECTURE.md` sections 1, 3, 4 | "Approver must be `president`", the stub text with "Club President", "role set excludes `new_member`" | rewritten in pack terms first (the file is the contract) |
| H63 | `tests/**` (300 literal hits in 48 files) and `tests/e2e/judge-path.spec.ts` | club fixtures | allowed to stay; calls updated for the new signatures through one helper (A9) |

Not counted, noted for honesty: `src/lib/lacuna/core/inventory.ts:33` infers "external relationship" from words such as "sponsor" (a generic word list; the lab pack pins kinds with `kindOverrides`, which already exists). Date display uses `Asia/Kolkata` in four pages and Tether reads wall-clock times as IST. That is a locale assumption, not a setting literal; the lab story is set in Pune so nothing changes.

### A8. Demo cache keys

The cache key is `sha256(model tag, system prompt, user prompt, schema name)` (`src/lib/model/client.ts:73`). No role key and no pack id is in any prompt today:

| Prompt | What it contains | After the refactor |
|---|---|---|
| extraction, system | entity list, attribute guide with examples, rules | unchanged for the club if the examples, the entity hint and the contact example are copied byte for byte into the pack |
| extraction, user | thread, segment ids, author names, times, text | unchanged |
| support check | claim statements and segment text | unchanged |
| stand-in successor | responsibility key and title, check lines, claim ids with attribute and trust | unchanged while `leaverPerson.name` is "Priya" and `roleOrder` equals the old order |

Guard: before the first edit, record three golden hashes from main (system prompt for the club pack; the ordered list of user prompt hashes from `tests/attest/demo-prompts.test.ts`; the claim id list from the ground-truth seed). The refactor is not done until the same three hashes come out.

Where keys will change, so the precompute is re-run once (planned for hours 28 to 40, after all prompt work is frozen):

1. The Round 2 extraction fixes (two-pass extraction, thread context, event binding) rewrite the extraction prompts: every club extraction key changes.
2. Improvement 2 narrows some club segments at ingest and adds planted sensitive messages. Batches are grouped by role set, so the threads it touches are re-batched and their keys change.
3. Any edit to a club entity label, alias or example changes the system prompt and so every extraction key.
4. The lab pack is all new keys.
5. The re-test after a finding has a new claim line `(deadline, successor_found)`. Its key is new and replays only for the example finding with the fixed time (B10).

Nothing in the pack refactor itself is on this list. If a builder cannot make the golden hashes match, stop and ask rather than re-running the precompute early: the three improvement branches develop against the committed cache from hour 4 to hour 28.

### A9. The no-literals check

`scripts/check-literals.ts`, run three ways: `pnpm check:literals`; as the first half of the `build` script (so a Vercel build fails); and wrapped by a vitest test so `pnpm test` and CI fail.

Outline:

```
packs      = every packs/*.json except index.json
roleKeys   = all role keys of all packs
packIds    = all pack ids
nouns      = all role labels + leaverPerson.name and aliases + forbiddenInCore of all packs
files      = src/**/*.{ts,tsx}, db/migrations/*.sql, next.config.ts
             (not tests/, not scripts/, not packs/, not data/, not docs/)
for each file, each line:
  flag if a whole quoted string equals a role key or a pack id        ("president", 'lab', `pi`)
  flag if the line contains a noun as a whole word, any case          (Club President, Priya, Farhan)
  skip if (file, token) is in scripts/literals-allow.json, which must give a reason
print file:line:token for every hit; exit 1 if any
```

Only whole quoted strings are matched for keys, so the word "leaver" in `leaver_said`, `leaverRole` or "The leaver can never approve" is fine, and a property named `leaver` is fine. Comments are scanned too: fix the comment rather than allow-list it.

Allow-list at the start: the two historic lines in `0001_core.sql` (H55, H56; applied migrations are never edited) and the backfill line in `0006_packs.sql`.

The check proves itself: a unit test feeds it a temp file containing `"new_member"` and expects exit 1, and a second containing `leaver_said` and expects exit 0.

Test fixtures: add `tests/helpers/club.ts` exporting the club's `ApprovalRoles`, `restrictedAudience` and `roleOrder` read from `packs/club.json`. Every test that calls a changed signature passes these. Tests may keep club literals; the check does not scan `tests/`.

---

## B. Living handover

### B1. Goal and done when

A handover keeps improving after release. The successor closes open gaps in their first weeks, each finding is checked and approved like any other claim, and every change to the released handover is a new hashed version with the reason for the score change in plain words.

Done when:

1. After snapshot v1, the successor opens First weeks and sees every open gap, with owner and due date from the continuation plan.
2. The successor records a finding with an answer, a note and optionally a link or a text file. It is saved as evidence labelled "Successor found". Scores and the released handover do not change yet.
3. The approver sees it in a "Successor findings" group on Review, opens the evidence, writes a reason and approves.
4. Approval re-tests the successor, creates snapshot v2, and stores the diff and the score change.
5. A "What changed in v2" panel shows the claim added, the gap closed and B, C and K before and after, each with one sentence saying why.
6. K does not rise from a finding alone. It rises only when a record agrees.
7. No role sees a finding, or any text derived from it, that its role set excludes.

### B2. Judge-visible flow

Demo path in the club workspace, after the existing seven steps:

1. Handover page, viewing as Incoming tech lead. Under the release banner: "Some gaps are still open. Record what you find in your first weeks." with a link "Go to First weeks".
2. First weeks page. Open gaps as a checklist. The judge picks "Late-night lab access: Next due date", presses "Use the example finding", then "Save finding".
3. The row now says "Waiting for review". Scores are unchanged.
4. Switch to Club President. Review page shows "Successor findings (1)". Open the evidence, write a reason, press "Approve and release v2".
5. Message: "Finding approved. Snapshot v2 released. B 5 → 4." (numbers depend on the run).
6. Review, version history: a v2 row with "Finding approved: Late-night lab access: Next due date". Handover page: the "What changed in v2" panel.
7. Switch to New member: the panel shows what that role may see, or a stub count.

The example finding (club): date `2026-11-18`, note "Mr. Pawar confirmed late access is every Wednesday in build season. The next one is Wednesday 18 Nov. Ask him by Monday." This closes the blocking gap R09 `next_due_date`. See E2 for why the date is needed.

### B3. Exact UI copy

No em dashes. Plain words. `{x}` is filled from the pack or the data.

First weeks page (`/w/[id]/first-weeks`):

| Element | Copy |
|---|---|
| eyebrow | After handover |
| title | First weeks |
| intro | The handover is approved, but some gaps are still open. Work through them here. When you find an answer, record it. The approver checks it, then the handover is updated. |
| empty, no snapshot | title: "No approved handover yet." body: "First weeks starts after the approver approves a snapshot. Go to Review." |
| notice, approver | Viewing as {approver.label}. You can see every finding here. Approve or reject them on Review. |
| notice, leaver | Viewing as {role label}: read only. Findings are recorded by {successor.label}. |
| notice, other roles | Viewing as {role label}: read only. Only {successor.label} records findings. |
| summary line | {n} open gaps · {m} findings waiting for review · {k} closed since v1 |
| section heading | Open gaps |
| group 1 heading | Blocking gaps |
| group 1 help | Each one has an owner and a due date from the continuation plan. |
| group 2 heading | Other open gaps |
| group 2 help | Not blocking, but still unanswered. |
| row title | {responsibility title}: {check label} |
| row meta, planned | Owner: {owner} · Due: {due date} · Risk: {risk note} |
| row meta, no plan | No owner set |
| row, restricted | Restricted for your role. Ask the approver ({approver.label}). |
| row button | Record a finding |
| row state chips | "○ Open", "◔ Waiting for review", "✓ Closed in v{n}", "✕ Finding rejected" |
| all closed | Every gap is closed. Nothing left to find. |

Finding form (opens under the row):

| Element | Copy |
|---|---|
| heading | What did you find? |
| field 1 label, text checks | Answer |
| field 1 help | The fact in a few words. |
| field 1 label, date checks | Date |
| field 1 help, date checks | The next date this is due. |
| field 2 label | How do you know? |
| field 2 help | Who told you, or where you saw it. Do not paste passwords. |
| field 3 label | Link (optional) |
| field 3 help | A page or document that shows it. We keep the address only. Understudy never opens it. |
| field 4 label | File (optional) |
| field 4 help | A text file up to 200 KB: .txt, .md, .csv or .ics. Secrets are masked before it is saved. |
| field 5 legend | Who can see this |
| field 5 help | You can remove roles, never add them. {approver.label} and you always see it. |
| demo helper button | Use the example finding |
| submit | Save finding |
| pending | Saving… |
| success | Saved as "Successor found". It is waiting for {approver.label} to review. Scores do not change until it is approved. |

Form errors:

| Case | Copy |
|---|---|
| empty answer | Write an answer first. |
| no date on a date check | Pick a date. |
| date in the past on a date check | That date has passed. Enter the next one. |
| answer too long | Keep the answer under 300 characters. |
| note too long | Keep the note under 4000 characters. |
| bad link | That link is not a web address. Use one that starts with https:// |
| file too large | The file is over 200 KB. |
| file type | Use a .txt, .md, .csv or .ics file. |
| duplicate | This gap already has a finding waiting for review. Withdraw it first. |
| wrong role | Only {successor.label} can record findings. |
| restricted gap | This gap is restricted for your role. Ask the approver ({approver.label}). |
| gap closed | This gap is already closed. |
| no snapshot | There is no approved handover yet. |

"Your findings" list on the same page:

| Element | Copy |
|---|---|
| heading | Your findings |
| empty | No findings yet. |
| columns | Gap · Answer · Status · Recorded |
| status chips | "○ Waiting for review", "✓ Approved in v{n}", "✕ Rejected", "↩ Withdrawn" |
| rejected reason | Reason: "{note}" |
| row link | Open evidence |
| row button, pending only | Withdraw |
| withdraw done | Finding withdrawn. |

Review page, new group above tier C:

| Element | Copy |
|---|---|
| heading | Successor findings ({n}) |
| blurb | Found by {successor.label} after the handover. Each one is a person's word until a record backs it. Open the evidence, then approve or reject. |
| card line 1 | {statement} |
| card chips | "⚑ Successor found", tier chip, "○ Pending" |
| card meta | Closes: {responsibility title}: {check label} · Recorded {date and time} |
| link line | Link: {url} (not opened by Understudy) |
| file line | File: {name}, {size} |
| agrees line | Agrees with: {statement} ({trust label}) |
| disagrees line | Disagrees with: {statement} ({trust label}). Approving this will mark both as conflicting. |
| narrowed line | Visible to: {role labels} |
| evidence checkbox | I opened the evidence |
| reason label | Why is this right or wrong? |
| approve button | Approve and release v{n} |
| reject button | Reject |
| approve done | Finding approved. Snapshot v{n} released. {delta text} |
| approve done, release blocked | Finding approved. Snapshot v{n} is not released yet: {first blocker} Fix the plan below, then approve the snapshot. |
| reject done | Finding rejected. The gap stays open. |
| not approver | Only {approver.label} can approve findings. |
| leaver | The leaver can never approve. |
| empty | (group hidden when there are no findings) |

"What changed" panel (Handover page under the release banner, and inside each row of the version history on Review):

| Element | Copy |
|---|---|
| heading | What changed in v{n} |
| sub line | Compared with v{n-1}. Approved {date and time}. |
| cause, finding | Why: a successor finding was approved. |
| cause, manual | Why: the approver released a new version. |
| added | Added: {statement} |
| removed | Removed: {statement} |
| changed trust | Changed: {statement} Trust went from {old label} to {new label}. |
| changed text | Changed: {statement} (edited by reviewer) |
| gap closed | Gap closed: {responsibility title}: {check label} |
| gap opened | Gap opened: {responsibility title}: {check label} |
| plan changed | The continuation plan changed. |
| B changed | B went from {b0} to {b1}. {reason} |
| B same | B stayed at {b}. |
| C changed | C went from {c0}% to {c1}%. {reason} |
| C same | C stayed at {c}%. |
| K changed | K went from {k0}% to {k1}%. {reason} |
| K same | K stayed at {k}%. |
| hidden items | {N} restricted changes. Ask the approver ({approver.label}). (singular: "1 restricted change.") |
| nothing changed | No claims changed in this version. |
| footer link | See all versions |
| re-acknowledge | This is a new version. Read back again to acknowledge v{n}. |

Reason sentences (picked by code, never written by a model):

| Case | Sentence |
|---|---|
| B down, finding | {n} blocking gap is now covered by a successor finding. (plural: "{n} blocking gaps are now covered by successor findings.") |
| B down, record | {n} blocking gap is now covered by a record. |
| B up, conflict | A new answer disagrees with an existing claim, so {n} blocking check is conflicting again. |
| C up | {n} more check is covered. (plural: "{n} more checks are covered.") |
| C down | {n} check is no longer covered. |
| K down, finding added | K counts only covered work that a record backs. A finding is a person's word, so it raises C and not K. |
| K up, corroborated | A record now agrees with a finding, so that work counts as backed by a record. |
| K not available | K is n/a because nothing is covered yet. |

Version history table on Review gains two columns: "Why" ("First release", "Finding approved: {gap}", "Released by the approver") and "What changed" (a disclosure that opens the panel for that version).

Header: when a snapshot exists, a link "First weeks" sits at the right end of the stepper row. The seven steps stay seven.

### B4. Who may do what

| Action | Successor | Approver | Leaver | Other roles |
|---|---|---|---|---|
| see First weeks checklist (blocking gaps and plan) | yes | yes | yes | yes |
| see "Other open gaps" (from the successor's test) | yes | yes | no | no |
| record or withdraw a finding | yes | no | no | no |
| see a finding | if in its role set | yes | if in its role set | if in its role set |
| approve or reject a finding | no | yes | never | no |
| see "What changed" | role-scoped | everything | role-scoped | role-scoped |

All checks are on the server, from the role cookie, as today.

### B5. Data model

Shared types (`src/lib/types.ts`, landed with the pack refactor so branches do not collide):

```
SourceKind   adds "finding"
SegmentKind  adds "finding"
Trust        adds "successor_found"
Claim.origin adds "successor_finding"
```

Trust order, strongest first: `from_record`, `corroborated`, `leaver_said`, `successor_found`, `second_hand`, `inferred`, `ranked_options`.

Where "Successor found" ranks and why: right below "Leaver said". Both are a named person's direct word and both count as covered (they are in `STRONG_TRUST`, so they raise C and can lower B). Neither is in `RECORD_TRUST`, so neither raises K. It sits below the leaver because the leaver did the work; the successor often reports what someone else told them. It sits above "Second-hand" because the successor is the accountable owner and the finding passes the approver before it counts at all.

The five places that list trust values and must all gain the new one in the same commit: `src/lib/lacuna/core/pack.ts` (`TRUST_ORDER`, `TRUST_LABEL`, `STRONG_TRUST`), `src/lib/relay/core/labels.ts` (`TRUST_LABEL`, `TRUST_ORDER`), `src/lib/attest/core/support.ts` (`TRUST_ORDER`), `src/components/chips.tsx` (`TRUST_LABEL`, `TRUST_STYLE`: symbol "⚑", tone info), `src/app/w/[id]/claims/page.tsx` (`TRUSTS`, `COUNTED`). Also `KIND_OWNER` and `KIND_ITEM` in `src/lib/attest/core/rules.ts` ("the successor's findings", "a successor finding"), `KINDS` on the claims page, the `kind <> 'interview'` filters in `src/lib/progress.ts` and the Connect page (exclude `finding` too), and `src/lib/tether/data-level.ts`.

A finding is stored as four things:

| Thing | Shape |
|---|---|
| source | one per workspace: id `src_first_weeks`, kind `finding`, name "First weeks", role set = pack upload default |
| segment (the evidence) | kind `finding`, source kind `finding`, thread `first-weeks:{responsibility key}:{check key}`, position 0, immutable, masked text in the fixed layout below, `meta` = finding id, responsibility id, check key, recorded-by role, has link, attachment name |
| optional attachment segment | same source and thread, position 1, kind `finding`, masked file text, `meta.attachment` = name, bytes, sha256 |
| claim | origin `successor_finding`, trust `successor_found`, state `active`, review `pending`, entity = `responsibility.entities[0]`, attribute = `check.attributes[0]`, value = the answer, one citation to segment 0 with the exact quote `Answer: {answer}` |
| findings row | the flow record (table below) |

Segment text layout (fixed, so the quote is always an exact substring):

```
Finding for {responsibility key} {responsibility title}: {check label}
Answer: {answer}
How I know: {note}
Link: {url}            (line omitted when there is no link)
File: {file name}      (line omitted when there is no file)
```

Claim statement: `{successor.label} found: {note, or the answer when the note is empty}`. Claim value: the answer alone (an ISO date for date checks), so that it can equal a record's value in corroboration.

Segment id follows the contract: `seg_` + 16 hex of `sha256("finding" | ts | thread | position | sha256(norm(text)))`. Author id is `null`; the role is in `meta.recordedByRole` (roles are not people in Understudy).

New table `findings` (migration `0009_living.sql`, outline):

| Column | Notes |
|---|---|
| `workspace_id`, `id` | id `fnd_` + 12 hex; primary key |
| `responsibility_id`, `check_key` | the gap it answers |
| `segment_id`, `attachment_segment_id` | evidence |
| `claim_id` | the claim it created |
| `recorded_by` | role key |
| `status` | `pending`, `approved`, `rejected`, `withdrawn` |
| `role_set text[]` | same as the segment and the claim; RLS policy identical to `claims` |
| `snapshot_id`, `score_delta` | set on approval |
| `review_note` | approver's reason |
| `created_at`, `decided_at` | |
| unique partial index | one `pending` row per `(workspace_id, responsibility_id, check_key)` |

The row holds no answer, note or link text. Content lives only in the segment, under RLS.

New table `snapshot_changes` (append-only, one row per snapshot from now on, v1 included):

| Column | Notes |
|---|---|
| `workspace_id`, `snapshot_id` | primary key |
| `from_snapshot_id` | null for v1 |
| `test_run_id` | the successor's run this snapshot was built on |
| `diff jsonb` | `SnapshotDiff` as returned by `diffSnapshots` (ids, scores, plan flag) |
| `gaps_closed jsonb`, `gaps_opened jsonb` | arrays of `{ responsibilityId, checkKey }` |
| `delta_text` | the existing `scoreDelta` string, numbers and trust labels only |
| `lines jsonb` | the B, C and K sentences from B3 |
| `cause jsonb` | `{ type: "first" \| "finding" \| "manual", findingIds: [] }` |
| `created_at` | |

This table holds ids, numbers and fixed sentences only: no statement, no value. Statements are joined from `snapshot_claims` inside `withRole`, so RLS decides what each role reads.

`claim_meta(ws)` is replaced (same columns) to leave out findings that are not approved: `NOT (origin = 'successor_finding' AND review NOT IN ('approved','edited'))`. A pending finding is evidence for nobody, so it can never make a check show as Restricted for another role.

The snapshot payload schema stays `understudy.snapshot/1`. The diff is derived data kept beside the snapshot, not inside the hash, so v1 hashes and `verifySnapshot` are untouched. A test checks the stored diff equals `diffSnapshots(payload v1, payload v2)`.

### B6. Role set: narrowing only

```
base      = pack.uploadDefaults.roleSet
keep      = { successor, approver }
requested = roles ticked on the form (ignored if not in base)
roleSet   = base filtered to (requested or keep)          // narrowRoleSet from lacuna/core/questions.ts
roleSet   = roleSet intersected with the sensitivity result, if improvement 2's classifier is present
```

The segment is immutable, so its role set cannot change later. The claim's role set is the intersection of its cited segments, which is this set. The attachment segment gets the same set. Contacts found by masking are stored with `contactsRoles` intersected with this set. Nothing in this flow can widen: there is no code path that adds a role. Widening an existing segment is improvement 2's approver action and is out of scope here.

### B7. How a finding re-enters Attest

"The same checks" means these, in order:

| Step | What happens | Where |
|---|---|---|
| 1. mask | `maskText` on answer, note and file before anything is stored; secrets become `[SECRET:type]`, emails and phones become contact tokens | Tether, as for leaver answers |
| 2. sensitivity | improvement 2's classifier may narrow the role set | `tether/sensitivity`, if merged |
| 3. citation | the claim cites its own segment with the exact quote `Answer: ...`; `isExactQuote` must be true or the save fails | Attest verifier rule, called directly |
| 4. trust | set by code to `successor_found`. A finding can never be `from_record`, whatever it cites | new code |
| 5. no model reading | finding segments are never sent to extraction (see the note below) and are skipped by the support check, like leaver answers | Attest |
| 6. rules on approval | supersession, conflict, corroboration, importance and tier run over all claims | `rerunRules(ws)` (below) |
| 7. review | tier C when the gap is blocking, the claim is conflicting or the role set excludes a restricted audience role: evidence opened and a written reason | Relay, unchanged rule |

Rules, case by case:

| Situation | Rule that fires | Result |
|---|---|---|
| nothing else on that entity and attribute | none | active, "Successor found"; the gap is covered; B and C move, K does not |
| a record with a different value, higher authority | rule 4 (finding authority is 1, the lowest) | both conflicting; the finding's note says a record disagrees; the approver decides |
| a leaver answer or chat message with a different value, equal authority | rule 3 | both conflicting; ask a person |
| a record with the same normalised value | corroboration | both become "Corroborated"; K rises |
| the gap was already conflicting (two records disagree) and the finding agrees with one | rule 3 keeps all three conflicting | the Review card shows "Agrees with" and "Disagrees with"; when the approver rejects the losing claim, the rules re-run, the conflict ends, and the finding plus the agreeing record become "Corroborated" |

Can a record later corroborate a finding: yes. `corroborate()` in `src/lib/attest/core/rules.ts` gains `successor_found` in its `UPGRADEABLE` list. A finding is upgraded when another active claim has the same entity, attribute and normalised value, comes from a different source kind, and is itself a record (`from_record` or `corroborated`). Then both read "Corroborated", the next snapshot lists the claim as changed, and the panel says "Trust went from Successor found to Corroborated" and "A record now agrees with a finding".

What can never corroborate a finding: another finding; a leaver answer; the finding's own link (never fetched); the finding's own file. The attached file is stored inside the First weeks source with source kind `finding`, so anything about it stays "Successor found". This closes the obvious loophole of typing a note, uploading it and calling it a record. A record that arrives through Connect is a normal source and can corroborate; who uploaded it is in the audit log. Limit to state openly in the testing notes: Understudy cannot tell who wrote a file uploaded through Connect.

A claim that began as a finding never enters tier A: `reviewFlags` adds "from a successor finding" when `origin` is `successor_finding`, so even a corroborated one is reviewed one by one.

Two changes in Attest that this flow needs and that also protect improvement 1 (land them in the foundation hours, in a new file so nobody edits the same lines):

```
// src/lib/attest/core/origins.ts
PERSON_ORIGINS = { "leaver_answer", "successor_finding", + improvement 1's origins }
isPersonOrigin(origin): boolean
PERSON_SEGMENT_KINDS = { "answer", "finding" }
```

1. `verify()` in `src/lib/attest/index.ts` (lines 382 and 397) today carries over only `leaver_answer` claims and marks every other claim the extraction did not produce as dropped. Without `isPersonOrigin`, the next "Run Understudy" would drop every finding.
2. `planBatches` skips only `task` and `event` segments (`DETERMINISTIC_KINDS`). Leaver answer segments are therefore sent to the model on a re-run and can come back as "From record" claims quoted from the leaver's own answer. Pass `skipKinds` = task, event, answer, finding. A fresh demo has no answer segments when the pipeline runs, so no cache key changes. This is a Round 2 bug found while reading; confirm it with a test at window open.

```
// src/lib/attest/index.ts
rerunRules(ws: string, actor: string): Promise<{ changed: number; firings: number }>
// loads current claims (not dropped) and segments, runs applyRules, writes only changed
// fields and one claim_events row per change. No extraction, no model call.
```

### B8. Functions

```
// src/lib/relay/core/finding.ts   (pure)
interface FindingInput {
  answer: string; note: string; link: string | null;
  attachment: { name: string; text: string } | null;
  resp: Pick<Responsibility, "id" | "key" | "title" | "entities">;
  check: Pick<LacunaCheck, "key" | "label" | "attributes" | "needsDate">;
  baseRoleSet: RoleKey[]; keepRoles: RoleKey[]; narrowTo: RoleKey[] | null;
  successorLabel: string; entityLabel: string; ts: string; today: string;
}
validateFinding(input): { ok: true } | { ok: false; error: string }       // the error strings in B3
findingText(input): string                                                // the fixed layout
findingToDrafts(input): { segment: Segment; attachment: Segment | null; claim: ClaimDraft }

// src/lib/relay/living.ts   (database layer)
listOpenGaps(ws, role): Promise<OpenGapRow[]>          // plan + latest successor run; role-scoped
listFindings(ws, role): Promise<FindingView[]>         // inside withRole
recordFinding(ws, actor, form): Promise<{ ok: true; findingId; claimId } | { ok: false; error }>
withdrawFinding(ws, actor, findingId): Promise<ActionResult>
decideFinding(ws, actor, findingId, decision: "approved" | "rejected",
              opts: { note: string; evidenceOpened: boolean }):
  Promise<ActionResult & { snapshot?: Snapshot; delta?: string; blocked?: string }>
whatChanged(ws, role, snapshotId): Promise<ChangeView | null>    // inside withRole for statements
changeTexts(ws, role): Promise<string[]>                         // every string the panel would show; for the leak grid

// src/lib/relay/core/changes.ts   (pure)
gapChanges(before: CheckResult[], after: CheckResult[], checks): { closed: GapRef[]; opened: GapRef[] }
explainScores(before: ScoredRun, after: ScoredRun, closed, opened, trustChanges): { b: string; c: string; k: string }
buildChangeRecord({ diff, before, after, checks, cause }): SnapshotChangeRecord
```

`recordFinding`, in order: actor is the successor; a snapshot exists; the gap is open in the latest successor run and not Restricted for the successor; no pending finding on it; `validateFinding`; mask; sensitivity narrow; build drafts; assert the exact quote; one transaction inserts source (if new), segment, attachment segment, contacts, claim, a `created` claim event, the findings row; audit `record_finding`. No test run, no snapshot.

`decideFinding` approved, in order:

```
gate: actor is the approver (leaver never)
reviewClaim(ws, claimId, "approved", actor, { note, evidenceOpened })     // tier rules apply
rerunRules(ws, actor)
before = latest successor test run
for role in pack.testRoles: runTest(ws, role, { trigger: "finding <id>" })
        // Round 2 fix "re-test only the answered responsibility" applies here when it lands
release = getReleaseInfo(ws)
if release.blockers is empty:
    snapshot = approveSnapshot(ws, actor)          // writes snapshot_changes with cause finding
    findings row: approved, snapshot_id, score_delta
    return ok with snapshot and delta
else:
    findings row: approved, no snapshot
    return ok with blocked = first blocker         // approver fixes the plan, then presses Approve snapshot
audit "decide_finding"
```

`decideFinding` rejected: `reviewClaim(..., "rejected")` (reason needed for tier C), findings row rejected, `rerunRules` (a rejected claim leaves any conflict it was part of). No test run and no snapshot: the released picture did not change.

`approveSnapshot` in `src/lib/relay/index.ts` gains one step inside its transaction: write the `snapshot_changes` row (for every snapshot, whatever caused it). `runTest` in `src/lib/lacuna/index.ts` gains one filter: a claim with origin `successor_finding` counts only when review is `approved` or `edited`.

### B9. Re-test, diff storage, version history

Re-test: the stand-in successor runs for each role in `pack.testRoles`. When the model is down the deterministic reading applies: "Successor found" is strong trust, so the check is covered and B moves the same way.

Diff: computed once at approval by `diffSnapshots(previous payload, new payload)` plus `gapChanges` over the two test runs, stored in `snapshot_changes`. For snapshots made before this table existed, the panel falls back to `diffSnapshots` on the stored payloads and shows claims and scores without the gap list.

Version history (Review page), one row per snapshot, newest first: Version, SHA-256 with "verified", Approved, Release, Claims, Why, Since previous ("+1 added · −0 removed · ~0 changed"), What changed (disclosure). Handover page shows the panel for the latest version only, open by default when the version is above 1. Acknowledgements already carry the snapshot id; the panel adds "This is a new version. Read back again to acknowledge v{n}." when the viewing role has not acknowledged the latest hash.

### B10. Replay for the demo (do if time; the deterministic reading is the fallback)

The re-test prompt for the answered responsibility contains the new claim id, which depends on the finding's time. For the example finding only, in demo workspaces only, the server uses a fixed time from the answer key (`firstWeeks.example.ts`, two weeks after the demo's today). The claim id is then the same in every demo workspace, the prompt repeats, and `scripts/precompute.ts` can export its key. A typed finding uses the real time and makes one live call, as a leaver answer does today.

---

## C. Second setting: a university research group

### C1. Proof target

Builder C's branch changes nothing under `src/`, `db/` or `scripts/`. It adds `packs/lab.json`, one line in `packs/index.json`, `data/lab/**`, and tests under `tests/packs/`. If the lab needs a core change, that is a bug in the pack refactor: fix it there, generically, and re-run the literal check.

### C2. The story

Menon Lab, a fictional soil microbial genomics group at a fictional institute in Pune. All names are new (none appears in the club data). Times are IST and dates are written day first, as in the club data. The data is written as of Wednesday 11 November 2026.

| Person | Who | Role key |
|---|---|---|
| Prof. Leela Menon | principal investigator | `pi` |
| Dr. Farhan Qureshi | postdoc, leaves on 30 Nov 2026 for a faculty post | `leaving_postdoc` |
| Dr. Nisha Iyer | incoming postdoc, started 2 Nov | `incoming_postdoc` |
| Tara Bose | PhD student, third year | `phd_student` |
| Imran Sheikh | PhD student, first year | `phd_student` |
| Gauri Patil | lab manager | `lab_manager` |
| Dr. Joseph Mathew | sequencing core facility, external; only ever talks to Farhan | none |
| Vikram Sood | cluster support desk, external | none |
| Ms. Deepa Rao | biosafety committee office, external | none |
| Dr. Elena Petrova | Helix Agritech, industry partner, external | none |

Farhan built and runs the lab's sequencing analysis pipeline, books the sequencing core, renews the approvals and holds half the lab's working knowledge in his head. Nisha must take all of it over.

### C3. The pack, in full

Identity: id `lab`, name "University research group".

Roles:

| key | label | short | flags | sees |
|---|---|---|---|---|
| `pi` | Principal investigator | the PI | approver | everything |
| `incoming_postdoc` | Incoming postdoc | the incoming postdoc | successor | general and technical sources |
| `phd_student` | PhD student | a PhD student | restrictedAudience | general sources only |
| `lab_manager` | Lab manager | the lab manager | none | general and admin sources |
| `leaving_postdoc` | Farhan (outgoing postdoc) | Farhan | leaver | everything; can never approve |

Who approves: `pi`. Who leaves: `leaving_postdoc`. Who succeeds: `incoming_postdoc`. Tested roles (derived): `incoming_postdoc`, `phd_student`. `contactsRoles`: pi, incoming_postdoc, lab_manager, leaving_postdoc. `uploadDefaults.roleSet`: all five. `leaverPerson`: name "Farhan", alias "Farhan Qureshi". Stub text: `N restricted items. Ask the approver (Principal investigator).`

Entities (16):

| key | label | aliases (start with these) | partOf |
|---|---|---|---|
| `qc-pipeline` | Nightly QC and assembly pipeline | pipeline, Snakefile, nightly QC, nightly-qc.yml, bio-142 jobs | |
| `pipeline-env` | Pipeline environment pin and rollback | environment.lock.yml, conda env, restore_env.sh, v1.4.2, known-good environment | `qc-pipeline` |
| `seq-core` | Sequencing core facility bookings | sequencing core, flow cell slot, run submission, Dr. Mathew | |
| `biosafety-approval` | Biosafety committee approval | biosafety, IBSC, committee renewal, isolate work approval | |
| `hpc-allocation` | Cluster compute allocation | allocation, compute hours, bio-142, cluster renewal | |
| `freezer-rota` | Freezer check and alarm rota | freezer check, minus 80, alarm rota, freezer log | |
| `helix-agreement` | Data-sharing agreement with Helix Agritech | Helix, data-sharing agreement, DSA, Dr. Petrova | |
| `revision-analysis` | Manuscript revision analysis (reviewer 2) | revision, reviewer 2, figure 3, revision_r2 | |
| `soil-dataset-v3` | Soil reference dataset version 3 | dataset v3, reference dataset, manifest, SR-0412 | |
| `assembler-choice` | Choice of long-read assembler | assembler, Flye, hifiasm, long-read assembly | |
| `standing-order` | Flow-cell and reagent standing order | standing order, indent, purchase order, flow cells | |
| `lab-meeting` | Weekly lab meeting | lab meeting, group meeting | |
| `lab-budget` | Grant budget and reimbursements | budget, grant head, reimbursement | |
| `intern-training` | Summer intern training | interns, training session | |
| `student-progress` | Student progress and supervision | progress review, committee meeting | |
| `sample-storage` | Sample storage map | box map, rack, shelf | |

`kindOverrides` pins the kind of each responsibility entity (the club word list for kinds does not fit a lab): `qc-pipeline` deploy_operate; `seq-core` and `helix-agreement` external_relationship; `biosafety-approval`, `hpc-allocation`, `freezer-rota`, `standing-order` recurring_obligation; `revision-analysis` and `soil-dataset-v3` unfinished_work; `assembler-choice` open_decision.

Checklist kinds: the five kinds are reused, because `ResponsibilityKind` is a closed list in the types, the zod schema and a database check (see E3). The lab pack gives each kind its own label and its own checks. Check keys are reused where the question template in `MISSING_TEMPLATES` fits; new checks carry their own `question.missing`.

| Kind (lab label) | Check key | Label | W | Weight | Attributes | New |
|---|---|---|---|---|---|---|
| deploy_operate (Compute environments and pipelines) | `access_path` | Where it runs and how to get in | WHERE | 3 | location, access | |
| | `steps` | Run steps | HOW | 3 | procedure | |
| | `how_to_verify` | How to check the output | HOW | 3 | procedure, status | |
| | `rollback` | Environment pin and rollback | HOW | 5 | procedure | |
| | `credential_owner` | Allocation and credential owner | WHO | 5 | owner, access | |
| external_relationship (Facilities, partners and agreements) | `contact_person` | Contact person | WHO | 5 | contact, owner | |
| | `last_interaction` | Last interaction | WHEN | 1 | status, deadline | |
| | `open_commitments` | Agreement terms and open commitments | WHY | 3 | dependency, decision, risk | |
| | `next_date` | Next date | WHEN | 3 | deadline | |
| recurring_obligation (Protocols, approvals and renewals) | `cadence` | How often | WHEN | 3 | deadline, procedure | |
| | `next_due_date` | Next due date | WHEN | 5 | deadline | |
| | `how_to_do_it` | Protocol or steps | HOW | 3 | procedure | |
| | `protocol_location` | Where the current protocol or form lives | WHERE | 3 | location | yes |
| | `consequence_if_missed` | What happens if it lapses | WHY | 1 | risk, reason | |
| open_decision (Open decisions) | `current_state`, `options_considered`, `owner`, `deadline` | as in the club pack | | 3, 1, 5, 3 | as in the club pack | |
| unfinished_work (Analyses and datasets in progress) | `where_it_lives` | Where the code and data live | WHERE | 3 | location | |
| | `data_provenance` | Dataset provenance | WHERE | 5 | dependency | yes |
| | `last_state` | Last state | WHERE | 3 | status | |
| | `next_concrete_step` | Next concrete step | HOW | 5 | procedure | |
| | `who_reviews_it` | Who reviews it | WHO | 1 | owner, contact | |

New check details: `protocol_location` question "Where is the current version of the protocol or form for {resp} kept, and who can edit it?". `data_provenance` question "Which sequencing run, sample sheet and data version does {resp} use, and where is the checksum manifest?", with `keywords` run, sample sheet, manifest, checksum, raw reads (the existing `keywords` field makes the deterministic reading count only claims that mention one).

Role templates, `incoming_postdoc`: sequencing core bookings (external_relationship, `seq-core`); biosafety approval renewal (recurring_obligation, `biosafety-approval`); choice of long-read assembler (open_decision, `assembler-choice`).

Footprint thresholds: same as the club (`repeatMin` 3, `distinctWeeksMin` 2, `ownershipShare` 0.8, `windowMonths` 6).

Source authority (higher wins; `whatsapp` listed only so uploads work):

| Attribute | tasks_csv | ics | github | markdown | slack | whatsapp | interview | finding |
|---|---|---|---|---|---|---|---|---|
| owner | 3 | 1 | 2 | 2 | 1 | 1 | 1 | 1 |
| status | 3 | 1 | 2 | 2 | 1 | 1 | 1 | 1 |
| deadline | 3 | 3 | 1 | 2 | 1 | 1 | 1 | 1 |
| location | 2 | 3 | 3 | 2 | 1 | 1 | 1 | 1 |
| procedure | 1 | 1 | 3 | 2 | 1 | 1 | 1 | 1 |
| access | 1 | 1 | 3 | 2 | 1 | 1 | 1 | 1 |
| decision | 2 | 1 | 2 | 3 | 2 | 2 | 1 | 1 |
| reason | 1 | 1 | 2 | 3 | 2 | 2 | 1 | 1 |
| dependency | 2 | 1 | 3 | 2 | 1 | 1 | 1 | 1 |
| contact | 2 | 1 | 1 | 2 | 2 | 2 | 1 | 1 |
| risk | 1 | 1 | 1 | 3 | 2 | 2 | 1 | 1 |

Reading: the task sheet and the calendar own dates; the repository owns procedures, locations, access and data dependencies; the lab notebook owns decisions, reasons and risks; a person's word is always lowest.

Read-back items (five):

| key | label | type | entity | attribute | answer |
|---|---|---|---|---|---|
| `biosafety_renewal_date` | Biosafety approval renewal date | date | `biosafety-approval` | deadline | 2026-12-10 |
| `env_rollback` | Command that restores the last known-good environment | command | `pipeline-env` | procedure | `./scripts/restore_env.sh v1.4.2` |
| `seq_core_contact` | Contact at the sequencing core | contact | `seq-core` | contact | Dr. Joseph Mathew |
| `revision_due_date` | Date the manuscript revision is due | date | `revision-analysis` | deadline | 2026-11-28 |
| `lab_meeting_day` | Day the lab meeting is held each week | text | `lab-meeting` | deadline | Thursday |

Extraction examples in the pack (one per attribute, written about a made-up greenhouse so no example value can be mistaken for a lab fact; the builder writes them) and an entity hint: `a pinned environment is pipeline-env, not qc-pipeline`. Contact example: a made-up name that is not in the corpus.

Sensitivity map (placeholder; improvement 2 owns the categories, the classifier and the final values):

| Category | Roles allowed (proposal) |
|---|---|
| finance | pi, lab_manager, leaving_postdoc |
| hr | pi, lab_manager |
| health | pi |

`demo`: dataDir `data/lab`, today `2026-11-11T12:00:00+05:30`, title "University research group", button "Open the research-group demo", blurb in C8. `forbiddenInCore`: Farhan, Menon, Principal investigator, Helix, Nisha.

### C4. The ten responsibilities

Keys are whatever the inventory assigns (the club's are R01 to R10); the answer key must use the same keys the inventory produces.

| # | Title | Kind | Entities | How the inventory finds it | Due |
|---|---|---|---|---|---|
| 1 | Nightly QC and assembly pipeline | deploy_operate | `qc-pipeline`, `pipeline-env` | footprint, ownership share: Farhan wrote 19 of 22 commits touching `pipeline/` and `env/`, and all commits to the workflow file | none |
| 2 | Sequencing core facility bookings | external_relationship | `seq-core` | role template; footprint, sole external contact (Dr. Mathew) | 2026-11-26 |
| 3 | Biosafety approval renewal | recurring_obligation | `biosafety-approval` | role template; footprint, schedule (yearly calendar entry) | 2026-12-10 |
| 4 | Cluster allocation renewal | recurring_obligation | `hpc-allocation` | task sheet card; footprint, renewal mentioned by the leaver | none (dates conflict) |
| 5 | Freezer check and alarm rota | recurring_obligation | `freezer-rota` | footprint, repeat: Farhan posts "freezer check done" in six different weeks; no card on the task sheet | none |
| 6 | Helix Agritech data-sharing agreement | external_relationship | `helix-agreement` | task sheet card | 2026-12-15 |
| 7 | Manuscript revision analysis | unfinished_work | `revision-analysis` | task sheet card | 2026-11-28 |
| 8 | Soil reference dataset v3 | unfinished_work | `soil-dataset-v3` | task sheet card | 2026-12-18 |
| 9 | Choice of long-read assembler | open_decision | `assembler-choice` | role template | none |
| 10 | Flow-cell and reagent standing order | recurring_obligation | `standing-order` | task sheet card | none on the card |

Off-board duties (for the answer key): 1 ownership share, 2 sole external contact, 3 schedule, 4 schedule, 5 repeat, 9 role template. Footprint noise to plant and expect dropped: the finished move from the old cluster (cards done in August) and a conference poster (done in September).

### C5. Sources

| Source | Format | Role set | Segments (about) | What is in it |
|---|---|---|---|---|
| Slack `#lab-general` | slack folder (`users.json` + channel file) | all five | 45 | day-to-day talk: lab meeting day, freezer checks, deadlines people remember differently, who owns what, the superseded dates |
| Slack `#pipeline` | slack folder | pi, incoming_postdoc, leaving_postdoc | 26 | how the pipeline runs, where raw reads live, the environment rollback, the unanswered "who has the sequencing core API token" question, two fake secrets |
| Slack `#lab-admin` | slack folder | pi, lab_manager, leaving_postdoc | 16 | money and agreements: prepaid flow cells, the standing order date and steps, Helix terms, what a biosafety lapse costs |
| Git repo `soil-metagenomics-pipeline` | github folder (`commits.json` + `files/`) | all five | 22 commits + 16 file segments | `README.md`, `docs/RUNBOOK.md`, `env/environment.yml`, `env/environment.lock.yml`, `.github/workflows/nightly-qc.yml`, `config/samples.yaml`, `scripts/restore_env.sh`, `analysis/revision_r2/README.md`, `analysis/revision_r2/normalise.py`, `CHANGELOG.md` |
| Lab notebook | markdown, one file per entry, front matter with title, date, author, author_email | all five, except one entry with `roles: pi, leaving_postdoc` | 16 (six entries) | decisions with reasons (why the environment was pinned, why samples were excluded), the state of the revision analysis, handover prep notes |
| Task sheet | tasks_csv | all five | 26 rows | open and done cards with owners and due dates; three malformed rows to exercise rejection |
| Lab calendar | ics | all five | 10 events | weekly lab meeting (RRULE, Thursday), yearly biosafety renewal, the sequencing slot, the revision due date, the Helix delivery date |

Total about 177 segments (target band 150 to 200). No WhatsApp source on purpose: the source mix is not the club's.

### C6. Facts to plant

Write the answer key first, then the prose around it. Each planted claim needs: entity, attribute, value, keywords, the source file and the exact sentence it sits in, the role set, the check it answers, and its expected state.

Claims: about 70 (`gt-001` onward), spread so every responsibility has between four and nine. At least 12 are corroborated across two source kinds (for example the biosafety date on the task sheet and in the calendar). At least six come from repository files, including two from the environment files and one from the workflow file, so traces (improvement 1) have something to read.

Gaps expected for the incoming postdoc (15):

| Responsibility | Check | Coverage | Blocking | How it is planted |
|---|---|---|---|---|
| 1 | `credential_owner` | missing | yes | the runbook names `SEQCORE_API_TOKEN`; Nisha asks in `#pipeline` on 5 Nov who holds it; nobody answers |
| 2 | `open_commitments` | partial | no | the booked slot is public; the two prepaid flow cells are only in `#lab-admin` |
| 3 | `how_to_do_it` | partial | no | "it is a form on the committee portal", no steps |
| 3 | `consequence_if_missed` | restricted | no | "isolate work must stop; last year it stopped for two weeks" is only in `#lab-admin` |
| 4 | `next_due_date` | conflicting | yes | Vikram says the form is due 1 Dec, Tara says 8 Dec; same channel, different authors, no reply link, no calendar entry |
| 5 | `next_due_date` | missing | yes | past checks are in the chat; no upcoming date is written anywhere |
| 5 | `how_to_do_it` | missing | no | nobody wrote what to do when the alarm sounds |
| 6 | `open_commitments` | restricted | no | embargo and fee are only in `#lab-admin` |
| 7 | `next_concrete_step` | partial | yes | the notebook says "one normalisation issue left before figure 3 can be redrawn"; only a WIP commit hints at what |
| 8 | `data_provenance` | missing | yes | the manifest lists files, but which run the excluded samples came from is not recorded |
| 8 | `who_reviews_it` | conflicting | no | task sheet says Farhan owns it; a newer message from the PI says Tara is taking it over |
| 9 | `owner` | missing | yes | "someone has to own the assembler decision once Farhan leaves"; nobody is named |
| 9 | `deadline` | conflicting | no | Tara says decide at the lab meeting on 19 Nov, Imran says 26 Nov |
| 10 | `next_due_date` | restricted | yes | the card has no date; 24 Nov is only in `#lab-admin` |
| 10 | `how_to_do_it` | restricted | no | "the PI signs the indent, then the lab manager raises the order" is only in `#lab-admin` |

Expected blocking gaps for the incoming postdoc: 7 (rows 1, 5, 6, 9, 10, 12, 14 of the table).

Restricted checks (for the per-role test): the four `#lab-admin` rows above are visible to pi, lab_manager, leaving_postdoc; responsibility 1 `rollback` and responsibility 4 `how_to_do_it` are stated only in `#pipeline`, visible to pi, incoming_postdoc, leaving_postdoc.

Supersessions (4):

| Entity and attribute | Old | New | Rule | Planted as |
|---|---|---|---|---|
| `biosafety-approval` deadline | 2026-12-03 | 2026-12-10 | 1 | chat in September says 3 Dec; the task sheet and the calendar say 10 Dec |
| `seq-core` deadline | 2026-11-24 | 2026-11-26 | 1 | chat says 24 Nov; the calendar entry says 26 Nov |
| `soil-dataset-v3` location | `/scratch/bio-142/raw` | `/project/bio-142/raw_v3` | 2, same author | Farhan in August, then Farhan in October ("scratch is purged after 30 days") |
| `freezer-rota` owner | Tara Bose | Gauri Patil | 2, reply | Tara says she keeps the rota; Gauri replies in the thread that it is hers from November |

Conflicts (3): `hpc-allocation` deadline 1 Dec against 8 Dec (rule 3); `assembler-choice` deadline 19 Nov against 26 Nov (rule 3); `soil-dataset-v3` owner, task sheet against a newer chat message (rule 4, "possibly outdated owner").

Restricted items with canary tokens (6; tokens are new and never appear in the club data):

| Token | Role set | Where | The fact |
|---|---|---|---|
| CANARY-L2FA | pi, lab_manager, leaving_postdoc | `#lab-admin` | two flow cells are prepaid for the January run |
| CANARY-L9HX | pi, lab_manager, leaving_postdoc | `#lab-admin` | standing order must be raised by 24 Nov |
| CANARY-L4PE | pi, lab_manager, leaving_postdoc | `#lab-admin` | Helix embargo and fee terms |
| CANARY-L6BT | pi, lab_manager, leaving_postdoc | `#lab-admin` | what a biosafety lapse stops |
| CANARY-L3SN | pi, leaving_postdoc | notebook entry "handover prep" | a note about one student's progress review |
| CANARY-L8RV | pi, incoming_postdoc, leaving_postdoc | `#pipeline` | the rollback tag and the node it must run on |

Fake secrets to plant and expect masked (8): a GitHub token and a `password=` for the sequencing portal in `#pipeline`; a Slack bot token in the runbook; an AWS-style key in a notebook entry; a `token=` in a commit message; an OpenAI-style key in `config/samples.yaml`; a private key header in the notebook; a 32-character random string in a task description. Credential names (`SEQCORE_API_TOKEN`, `HPC_PROJECT`) must survive masking.

Contacts to plant: email and phone for Dr. Mathew; email for Dr. Petrova; the facilities desk phone.

Read-back answers: the five values in C3, each backed by at least one planted claim visible to the incoming postdoc.

Placeholders for improvement 2 (three ordinary-looking messages in `#lab-general`: one about a student's medical leave, one about stipend arrears, one about a reimbursement amount). Plant them without canary tokens: until the classifier is merged they are visible to everyone, and a token there would fail the leak check. Improvement 2 adds them to its probes file and decides their categories.

For the living handover: `firstWeeks.example` in the answer key. Gap: responsibility 5 `next_due_date`. Date `2026-11-16` (a Monday). Note: "Gauri confirmed the freezer check is every Monday morning. The next one is Monday 16 Nov. If the alarm sounds, call the facilities desk." Expected: that gap closes, B drops by one, K does not rise. Also `demoAnswer` for the leaver (answers responsibility 1 `credential_owner`): "Gauri holds it in the lab password manager. I showed her on 6 Nov. Ask her, never post it in a channel."

Answer key shape: the same keys as `data/demo/ground_truth.json` (`today`, `responsibilities`, `claims`, `gaps`, `restrictedChecks`, `supersessions`, `conflicts`, `restricted`, `secrets`, `offBoard`, `readback`, `footprintNoise`, expected blocking gap count), with the count key renamed to a generic `expectedSuccessorBlockingGaps`, plus `firstWeeks` and `demoAnswer`. The club answer key gains the same three generic keys.

### C7. Evaluation and precompute cover both

| Tool | Change |
|---|---|
| `scripts/check-demo.ts --pack <id>\|all` | generic checks for any pack: pack validates; sources parse; canary tokens match the answer key and sit only in sources with that role set; every planted sentence exists in its file; footprint thresholds are met for the off-board duties listed in the answer key (leaver found through `leaverPerson`); read-back answers resolve |
| `scripts/eval.ts --pack <id>\|all` | one section per pack in `docs/EVALUATION.md`; pack commentary from `<dataDir>/EVAL_NOTES.md`; per-entity recall targets (Round 2 fix) reported for both |
| `scripts/precompute.ts --pack <id>\|all` | per pack: pipeline twice, leaver answer from `demoAnswer`, example finding and its approval, cache written to `<dataDir>/model_cache.json`; exits 1 unless the second run is fully cached with identical claims, scores and questions |
| `scripts/seed.ts` | loads the cache file of every pack |
| Evaluation page | reads the answer key of the workspace's pack |
| Leak check | reads canary tokens from the workspace's pack answer key |
| `next.config.ts` | ships `./data/**/*` with every function |

Cost note: the lab corpus is about the club's size, so about 27 extraction batches and 10 to 25 minutes cold. Run both packs once in hours 28 to 40.

### C8. Landing page offers both demos

Built generically in the pack refactor from `packs/index.json`; the lab card appears when Builder C adds the id.

| Element | Copy |
|---|---|
| section label | Try a demo |
| card 1 title | College robotics club |
| card 1 body | Priya, the outgoing tech lead, graduates. The incoming tech lead must take over the robot, the sponsor and the lab bookings. |
| card 1 button | Open the robotics-club demo |
| card 2 title | University research group |
| card 2 body | Farhan, a postdoc, leaves for a new post. The incoming postdoc must take over the analysis pipeline, the sequencing bookings and the approvals. |
| card 2 button | Open the research-group demo |
| pending | Creating your private copy… |
| line under the cards | Same seven steps. Different roles, checklists and sources. |
| empty start, select label | Use the roles and checklists of |
| empty start, button | Start empty and upload my files |
| footer | Both demos are fictional and fully synthetic. You get a private copy; nobody else sees your approvals. |

Card titles, bodies and button text come from each pack's `demo` block. The workspace is named `{pack name} (demo)`. `openDemo(packId)` checks the id against `listPacks()`.

---

## D. Tests, edge cases, tasks, briefs

### D1. Tests and what each proves

Pack refactor:

| Test | Proves |
|---|---|
| pack schema: each loader rule in A3, one failing fixture each | a broken pack fails with a readable message, at load |
| derived fields for the club: approver, successor, leaver, restricted audience, test roles, role order | flags give the same roles the constants gave |
| `checkApprover` with the leaver, the approver and a third role, for two different role sets | the approval rule holds for any pack |
| `assignTier` / `tierOf` with `restrictedAudience` given; a claim hidden from that role is tier C | sensitivity follows the flag, not a key |
| `stubText(3, "Principal investigator")` and the club label | stub text carries the pack's approver label |
| golden hashes: system prompt, user prompt list, planted claim ids for the club | the committed model cache still replays |
| database: snapshot insert as leaver role fails, as another pack's role fails, as approver succeeds; `pack_id` cannot be updated | the approver rule is still enforced in the database without a literal |
| RLS suite re-run with lab role keys on a lab workspace | policies work for any role key |
| `getRole` with a cookie holding a role of another pack returns the approver of this pack | a stale cookie cannot pick a foreign role |
| no-literals check: clean tree passes; a planted `"new_member"` fails; `leaver_said` passes; an allow-list entry without a reason fails | the check works and cannot be silenced quietly |
| existing 334 tests and the end-to-end judge path | nothing regressed for the club |

Living handover:

| Test | Proves |
|---|---|
| `validateFinding`: every error case in B3 | the form rules are in code, not only in the page |
| `findingToDrafts`: quote is an exact substring; trust `successor_found`; origin `successor_finding`; value is the answer | a finding is cited like any claim and can never start as a record |
| narrowing: requested roles outside the base are ignored; successor and approver always kept; result is a subset of the base | role sets only narrow |
| masking: a token and an email in the note and in the file are masked before storage | no secret reaches the database through a finding |
| only the successor records; approver, leaver and others are refused | the role rule holds on the server |
| pending finding: successor's scores, the handover, `claim_meta` and gap questions are unchanged | nothing moves until the approver decides |
| approval by the leaver refused; by the approver without evidence opened or without a reason refused (tier C) | review rules apply to findings |
| approve: claim approved, rules re-run, re-test, snapshot v2, `snapshot_changes` row, findings row updated, audit rows | the whole chain happens once and in order |
| scores: B drops by one, C rises, K does not rise | "Successor found" raises C, not K |
| stored diff equals `diffSnapshots(v1 payload, v2 payload)`; v1 hash still verifies | the diff is honest and old versions are untouched |
| `explainScores`: each reason sentence for each case in B3 | the explanation is fixed text chosen by code |
| corroboration: a record with the same value arrives through ingest; after the rules run the finding is "Corroborated", K rises, v3 lists it as changed | a record can back a finding later |
| no laundering: the finding's own file, another finding, a leaver answer with the same value: trust stays "Successor found" | only an independent record upgrades it |
| conflict: a finding that disagrees with a record makes both conflicting; panel says "Gap opened" | disagreement is surfaced, not overwritten |
| reject: claim rejected, gap stays open, no snapshot, successor sees the reason | a wrong finding leaves no trace in the handover |
| release blocked: approval succeeds, no snapshot, message names the blocker | the release rule still gates every version |
| pipeline re-run after a finding: the finding claim survives; finding and answer segments are not sent to extraction | "Run Understudy" cannot drop or launder a finding |
| "What changed" per role: a role outside the finding's role set gets a stub count and none of its text; canary token in a finding never appears for that role | the panel is role-scoped |
| end to end (Playwright, club): record the example finding, approve, see v2 and the panel, switch roles | a judge can do it without help |

Second setting:

| Test | Proves |
|---|---|
| `packs/lab.json` loads; derived roles are as in C3 | the pack is valid |
| `check-demo --pack lab` | the corpus matches its answer key before any model runs |
| lab pipeline end to end (vitest, local database, no live model): create a lab demo workspace; ingest with the real adapters; reconstruct with a fake model built from the answer key (for each batch, return the planted claims whose sentence is in that batch); verify; inventory; test as incoming postdoc and PhD student; questions; leaver answer; review as PI; plan; snapshot; compile for all five roles; read-back; leak check; record and approve the example finding | the whole product runs on a second setting |
| assertions inside it: ten responsibilities with the kinds in C4; the seven blocking gaps; 4 supersessions with their rules; 3 conflicts with their rules; restricted checks per role; stub text contains "Principal investigator"; zero canary leaks on every surface for every role; zero secrets in any claim; read-back all match for the successor | the planted facts are found and the permission boundary holds |
| the same generic suite runs once per id in `packs/index.json` | the lab is one more row, not a special case |
| branch check at merge: Builder C's diff touches nothing under `src/`, `db/`, `scripts/` | "zero core code changes" is a fact about the diff |
| no-literals check with the lab pack present (its role keys, labels and nouns are now forbidden in core too) | core holds no lab knowledge either |
| end to end (Playwright): open the research-group demo from the landing page and walk the seven steps | the second demo works on the live link |
| `eval --pack lab` with the live model, written to `docs/EVALUATION.md` | honest accuracy numbers for the new setting |

### D2. Edge cases

Pack refactor:

| Case | Behaviour |
|---|---|
| workspace whose `pack_id` names a pack that no longer exists | the page shows "This workspace uses a setting that is no longer available." and nothing else runs |
| cookie holds a role key from another pack | treated as no cookie: the approver role of this pack |
| two packs use the same role key (for example both have `leaver`) | fine; keys are scoped by workspace |
| a pack with two restricted audience roles | a claim is sensitive when it is hidden from either; both are tested |
| pack file edited while the server runs | the loader caches per process; a deploy picks it up |
| old workspaces created before the migration | backfilled as club; still open |
| empty workspace | uses the pack chosen on the landing page, else the default from `packs/index.json` |
| a pack without `extraction.examples` | prompts print definitions only |
| a pack without `demo` | valid for empty workspaces; not offered as a demo |

Living handover:

| Case | Behaviour |
|---|---|
| finding on a gap that closed meanwhile | refused: "This gap is already closed." |
| two successors' browser tabs save for the same gap | the unique index lets one through; the other sees the duplicate message |
| two approvals at once | snapshot versions are unique; the second gets "Another snapshot was approved just now. Reload." |
| answer is a secret or a phone number | masked; the claim value is the masked token |
| link to an internal address | stored as text; never fetched; rendered as plain text with a note, not as an auto-followed link |
| file with binary content or wrong encoding | refused with the file type message |
| note contains a canary token | scoped by the role set like any text; covered by the leak test |
| successor narrows to themselves only | role set becomes successor plus approver; other roles get a stub count |
| the finding names a date that has passed | refused for date checks, because it could not close the gap |
| the check's first attribute is not what the successor found | same rule as leaver answers: the claim is filed under the check's first attribute; the note carries the detail |
| approval when another blocking gap has no plan | finding approved, snapshot not released, blocker shown |
| finding approved, then the approver rejects that claim later | rules re-run, re-test, next snapshot removes it; panel says "Removed" and "Gap opened" |
| model unavailable at re-test | deterministic reading; note shown as today |
| workspace purge | findings and changes cascade with the workspace |
| improvement 1's switch "leaver unreachable" is on | no interaction: findings come from the successor after release |
| improvement 2 widens a finding segment | not possible in this flow; their action bumps the segment version and the next snapshot shows the claim as changed |

Second setting:

| Case | Behaviour |
|---|---|
| a lab entity alias also matches a common word | caught by `check-demo` (entity match report); fix the alias |
| the kind word list guesses the wrong kind for a card | `kindOverrides` wins |
| the placeholder sensitive messages before improvement 2 merges | visible to all; no canary token on them; not in the leak expectations |
| the read-back day item | key ends in `_day` and the label contains "day", which is what the existing day parser looks for |
| dates written day first | already how the date parser reads them |

### D3. Task breakdown in build order

Hours are working hours. The refactor needs both builders to fit in four hours of wall-clock time.

| # | Task | Who | Hours | Depends on |
|---|---|---|---|---|
| A1 | Record the three golden hashes from main. Rewrite `docs/ARCHITECTURE.md` sections 1, 3, 4 in pack terms | Advait | 0.5 | |
| A2 | Pack schema v2, loader rules, `packs/index.json`, club pack additions, loader tests | Advait | 1.0 | A1 |
| A3 | `types.ts` (RoleKey, the four new enum values), trust lists in five places, pure core signatures in Attest, Lacuna, Relay, `attest/core/origins.ts` | Advait | 1.5 | A2 |
| A4 | `getWorkspacePack` at about 35 call sites, session, `withRole`, pipeline, ingest, `tether/demo` | Om | 1.25 | A2 |
| A5 | Migration `0006_packs.sql` with the trigger and enum checks; database tests | Om | 0.5 | A2 |
| A6 | App copy from templates, landing cards from the registry, `next.config.ts` | Om | 0.75 | A4 |
| A7 | Scripts take `--pack`; one cache file per pack; `check-demo` generic | Om | 1.0 | A4 |
| A8 | `tests/helpers/club.ts`, update test calls, literal check and its test, golden hash test, full run | Advait | 1.25 | A3, A4 |
| | Pack refactor total | both | 7.75 (about 4 wall-clock) | |
| B1 | Migration `0009_living.sql`: `findings`, `snapshot_changes`, new `claim_meta` | Advait | 1.0 | A |
| B2 | `relay/core/finding.ts` with tests | Advait | 2.0 | A |
| B3 | `relay/core/changes.ts` with tests (gap changes, reason sentences) | Advait | 2.0 | A |
| B4 | `attest.rerunRules`, corroboration and flag changes in `rules.ts`, skip kinds, tests | Advait | 2.0 | A |
| B5 | `relay/living.ts`: record, withdraw, decide, list, whatChanged; hook in `approveSnapshot`; filter in `runTest`; integration tests | Advait | 4.0 | B1 to B4 |
| B6 | First weeks page, form, actions | Advait | 3.0 | B5 |
| B7 | Review group and the "Agrees / Disagrees" lines | Advait | 2.0 | B5 |
| B8 | "What changed" panel on Handover; version history columns; header link | Advait | 2.0 | B5 |
| B9 | Example finding with fixed time; precompute step; Playwright spec | Advait | 2.0 | B6 to B8 |
| | Living handover total | Advait | 20 | |
| C1 | `packs/lab.json`; add the id to `packs/index.json`; loader test | Om | 1.5 | A |
| C2 | Story bible and the answer key skeleton (all planted facts as rows, before any prose) | Om | 2.0 | C1 |
| C3 | Three Slack-format channels | Om | 3.0 | C2 |
| C4 | Git repository: commits and files, environment files, workflow, restore script | Om | 2.5 | C2 |
| C5 | Lab notebook entries | Om | 1.5 | C2 |
| C6 | Task sheet and calendar | Om | 1.0 | C2 |
| C7 | `check-demo --pack lab` green (footprints, canaries, secrets, planted sentences) | Om | 2.0 | C3 to C6 |
| C8 | Lab end-to-end test with the fake model from the answer key; generic per-pack suite | Om | 2.5 | C7 |
| C9 | Live eval on the lab; tune aliases, examples and wording of planted sentences (data only) | Om | 2.0 | C7 |
| C10 | Playwright walk of the lab demo | Om | 1.0 | C8 |
| | Lab pack and corpus total | Om | 19 | |
| M1 | Merge; precompute both packs once; deploy; walk both demos on the live link | both | hours 28 to 40 in the plan | all |

If time runs short, cut in this order: B10 replay for the example finding; "Agrees / Disagrees" lines; attachments (keep the link); "Other open gaps" group; the Playwright walk of the lab (keep the vitest end-to-end run).

### D4. File lanes

| Lane | Files | Owner |
|---|---|---|
| Improvement 1 (do not touch) | `src/lib/tether/graph.ts`, `src/lib/tether/traces.ts`, `src/lib/lacuna/recovery.ts`, `src/app/w/[id]/ask/**`, table `recovery_steps` | Aman |
| Improvement 2 (do not touch) | `src/lib/tether/sensitivity.ts`, `data/*/probes.json`, `src/lib/relay/core/canary.ts`, the leak grid in `src/lib/relay/handover.ts` (`LEAK_SURFACES`, `runLeakCheck`) and on the Handover page, the Connect page panel, columns `segments.sensitivity` and `segments.role_set_original` | Yash |
| Pack refactor (hours 0 to 4, then frozen) | everything in A7 | Advait and Om |
| Living handover, new files | `src/lib/relay/living.ts`, `src/lib/relay/core/finding.ts`, `src/lib/relay/core/changes.ts`, `src/app/w/[id]/first-weeks/**`, `src/app/w/[id]/review/FindingsGroup.tsx`, `src/components/WhatChanged.tsx`, `db/migrations/0009_living.sql`, `tests/relay/finding*.test.ts`, `tests/relay/changes.test.ts`, `tests/relay/living.integration.test.ts`, `tests/e2e/living-handover.spec.ts` | Advait |
| Living handover, small edits in shared files (each one named so reviewers can check) | `src/lib/relay/index.ts` (one step in `approveSnapshot`, exports); `src/lib/lacuna/index.ts` (one filter in `runTest`); `src/lib/attest/index.ts` (add `rerunRules`); `src/lib/attest/core/rules.ts` (`UPGRADEABLE`, `reviewFlags`); `src/app/w/[id]/review/page.tsx` (mount the group, hide findings from the tier lists, two history columns); `src/app/w/[id]/handover/page.tsx` (mount the panel above the document, not in the leak grid); `src/app/w/[id]/layout.tsx` (one link) | Advait |
| Lab pack and corpus | `packs/lab.json`, `packs/index.json` (one line), `data/lab/**`, `tests/packs/**` | Om |

Handoffs across lanes:

| From | To | What |
|---|---|---|
| Living handover | Improvement 2 | `changeTexts(ws, role)` and the First weeks strings, to add as leak grid surfaces "changes" and "first weeks". Until then the role-scoping test in `tests/relay/living.integration.test.ts` covers them |
| Improvement 2 | Living handover | the classifier's function name and shape, to call in `recordFinding` step 2. If it is not merged, the step is skipped |
| Improvement 1 | Foundation | its claim origins and trust use, to add to `attest/core/origins.ts` and the enum checks in the hour 0 to 4 migration |
| Lab pack | Improvement 2 | the three placeholder messages and the proposed sensitivity map |
| Lab pack | Improvement 1 | the repository has a workflow file, environment files and co-changed paths for traces; Dr. Mathew is a sole external contact for the graph |

Migration numbers (existing files are 0001, 0003, 0004, 0005): propose `0006_packs.sql` (foundation), 0007 and 0008 for improvements 1 and 2, `0009_living.sql`. Agree before the window opens.

### D5. Builder briefs (ready to paste)

Brief 1: pack refactor (Advait and Om, hours 0 to 4)

```
Goal: no file under src/, db/migrations/ or next.config.ts names a role key, a role label, a pack id
or a person from any setting. A workspace uses the pack named in workspaces.pack_id. The club demo
behaves exactly as before and still replays from data/demo/model_cache.json.

Read first: specs/03_living_handover_second_setting.md section A (A3 pack shape, A5 signatures,
A6 migration, A7 the list of 63 places, A8 golden hashes, A9 the literal check).

Before the first edit: record three golden values from main and keep them in the new golden test:
the sha256 of the extraction system prompt for the club pack, the list of user prompt hashes from
tests/attest/demo-prompts.test.ts, and the claim id list from the ground-truth seed.

Change docs/ARCHITECTURE.md first (sections 1, 3, 4), then the code.

Split:
  Advait: pack schema and loader, packs/index.json, club pack additions, src/lib/types.ts,
          the five trust lists, pure cores in attest/lacuna/relay, attest/core/origins.ts,
          tests/helpers/club.ts, the literal check, the golden test.
  Om:     getWorkspacePack at every call site, session, withRole, pipeline, ingest, tether/demo,
          migration 0006_packs.sql and its tests, app copy and landing cards, next.config.ts,
          scripts with --pack.

Rules:
  - RoleKey becomes string. Role facts come from flags on the pack's roles. Pure cores take what
    they need as arguments and never import the pack loader.
  - No default pack id anywhere in core. The default comes from packs/index.json.
  - Copy the club's prompt examples, the entity hint and the contact example into packs/club.json
    byte for byte. If a golden hash changes, stop and find out why. Do not re-run the precompute.
  - Keep the button text "Open the robotics-club demo" and the club role labels unchanged, so the
    end-to-end judge path still passes.
  - Do not edit 0001_core.sql. Undo its two literals in 0006_packs.sql.
  - Also land the shared enum values for improvement 3 (source kind and segment kind "finding",
    trust "successor_found", origin "successor_finding") and improvement 1's origins, in types,
    in the five trust lists and in the migration.

Done when: pnpm test passes with the same tests plus the new ones; pnpm check:literals exits 0 and
exits 1 when "new_member" is put back in any core file; the golden test passes; a fresh club demo
workspace runs fully cached; the stub line still reads
"N restricted items. Ask the approver (Club President)."

Report: files changed, test counts before and after, the three golden values, anything left on the
allow-list with its reason, and any signature that differs from section A5.
```

Brief 2: living handover (Advait, hours 4 to 28)

```
Goal: after a snapshot is approved, the successor records findings on a First weeks page; each
finding is evidence labelled "Successor found"; the approver reviews it; approval re-tests, creates
the next snapshot and stores what changed and why. K never rises from a finding alone.

Read first: specs/03_living_handover_second_setting.md section B (B3 has every string of UI copy,
B5 the data model, B7 the Attest rules, B8 the function list and the order of steps) and D1, D2.

Your files (new): src/lib/relay/living.ts, src/lib/relay/core/finding.ts,
src/lib/relay/core/changes.ts, src/app/w/[id]/first-weeks/**, src/app/w/[id]/review/FindingsGroup.tsx,
src/components/WhatChanged.tsx, db/migrations/0009_living.sql, tests/relay/finding*.test.ts,
tests/relay/changes.test.ts, tests/relay/living.integration.test.ts, tests/e2e/living-handover.spec.ts.

Small edits allowed in shared files, nothing else in them:
  src/lib/relay/index.ts      one step in approveSnapshot that writes snapshot_changes; exports
  src/lib/lacuna/index.ts     one filter in runTest: a finding counts only when approved or edited
  src/lib/attest/index.ts     add rerunRules(ws, actor)
  src/lib/attest/core/rules.ts  successor_found in UPGRADEABLE; reviewFlags flags finding origin
  src/app/w/[id]/review/page.tsx     mount FindingsGroup; hide finding claims from the tier lists;
                                     two columns in version history
  src/app/w/[id]/handover/page.tsx   mount WhatChanged under the release banner
  src/app/w/[id]/layout.tsx          one "First weeks" link when a snapshot exists

Do not touch: src/lib/tether/graph.ts, traces.ts, sensitivity.ts; src/lib/lacuna/recovery.ts;
src/app/w/[id]/ask/**; src/lib/relay/core/canary.ts; LEAK_SURFACES and runLeakCheck in
src/lib/relay/handover.ts; the leak grid on the Handover page; the Connect page.

Rules that must hold, each with a test:
  - Only the successor records. Only the approver decides. The leaver never approves.
  - Text is masked before storage. The link is stored as text and never fetched. The file is text,
    at most 200 KB, stored as a second segment of the same finding, never as a record source.
  - Role set = pack upload default, narrowed by the successor; successor and approver always kept;
    never widened.
  - Trust is set by code to successor_found. A finding is upgraded to corroborated only by an
    independent record with the same entity, attribute and normalised value.
  - A pending finding changes no score, no handover, no claim_meta result.
  - The snapshot payload schema does not change. The diff is stored beside the snapshot and must
    equal diffSnapshots(previous payload, new payload).
  - The "What changed" panel reads statements inside withRole. Hidden items become a count:
    "N restricted changes. Ask the approver (<approver label>)."
  - Every sentence in the panel is fixed text chosen by code. No model writes any of it.
  - No role key, role label or pack id in your code: read them from the workspace's pack.
    Run pnpm check:literals before every commit.

Work order: migration, pure cores with tests, rerunRules, database layer with integration tests,
then pages. Write the failing test first for each rule above.

Demo to verify by hand in the club workspace: as the incoming tech lead record the example finding
on "Late-night lab access: Next due date" (date 2026-11-18); as the approver open the evidence,
write a reason, approve; see snapshot v2, B one lower, K not higher, and the panel; switch to the
new member and check the panel shows nothing it should not.

Hand to improvement 2: changeTexts(ws, role) and the First weeks strings, for the leak grid.

Report: files changed, tests added and what each proves, the score change you saw with real
numbers, anything cut from the list in D3, and any place the spec did not match the code.
```

Brief 3: lab pack and corpus (Om, hours 4 to 28)

```
Goal: a second setting, a university research group, that runs through all seven steps and the
First weeks flow with zero changes to core code.

Read first: specs/03_living_handover_second_setting.md section C (C3 the pack in full, C4 the ten
responsibilities, C5 the sources, C6 every fact to plant) and D1, D2. Read docs/ARCHITECTURE.md
section 7a for the exact input formats, and data/demo/ as the worked example.

Your files, and only these: packs/lab.json, one line in packs/index.json, data/lab/**,
tests/packs/**. Your branch must not change anything under src/, db/ or scripts/. If the lab cannot
work without a core change, stop and report it: that is a gap in the pack refactor and is fixed
there, generically.

Order of work:
  1. packs/lab.json exactly as in C3. It must load.
  2. The answer key first: data/lab/ground_truth.json with every planted claim, gap, supersession,
     conflict, restricted item, secret, off-board duty, read-back answer, the leaver's demo answer
     and the example finding. Same keys as data/demo/ground_truth.json plus the three generic keys
     named in C6.
  3. Then the sources around it: three Slack-format channels, the git repository (commits.json and
     files/), six lab notebook entries, the task sheet, the calendar, and sources.json. About 177
     segments; stay between 150 and 200.
  4. pnpm tsx scripts/check-demo.ts --pack lab until it is green.
  5. tests/packs/: the lab end-to-end run with a fake model built from the answer key, and the
     generic suite that runs once per pack id.
  6. pnpm tsx scripts/eval.ts --pack lab with the live model. Tune only data: aliases, examples,
     the wording of planted sentences.

Rules for the corpus:
  - All of it is synthetic. New names only; none from the club data. IST times, dates day first,
    written as of 11 November 2026.
  - Every planted sentence appears word for word in its file, once.
  - Canary tokens only inside sources whose role set matches the answer key. Six tokens, listed in
    C6. The three placeholder messages for improvement 2 carry no token.
  - Secrets are fake and are listed in the answer key so the evaluation can prove none leaks.
    Credential names must be kept; values must be masked.
  - The leaver must pass the footprint thresholds for the off-board duties in C4: 19 of 22 commits
    on the pipeline paths, freezer check messages in six different weeks, one external person who
    only ever talks to the leaver.
  - Do not make the story neat. Leave the seven blocking gaps open exactly as planted.

Done when: check-demo is green for lab; the lab end-to-end test passes with the ten responsibilities,
seven blocking gaps, four supersessions, three conflicts, zero canary leaks and zero secrets; the
landing page shows the research-group card and the demo opens; git diff against the refactor commit
shows no file under src/, db/ or scripts/.

Hand to improvement 2: the three placeholder messages and the proposed sensitivity map.
Hand to improvement 1: the workflow file, the environment files and the sole external contact.

Report: segment counts per source, the answer key counts, the eval numbers, every alias or sentence
you changed after the live run and why, and any core limit you hit.
```

---

## E. Conflicts with the plan, and open questions

| # | Plan says | What the code shows | This spec does |
|---|---|---|---|
| E1 | The literal check covers `src/lib`. Round 2 hardcodes "five role keys in `types.ts` and Club President in the stub text; both move into the pack first" | 63 places, not 2. Ten are in `src/app`, two in the database (`approved_by = 'president'` would reject every lab snapshot), one in `next.config.ts` (lab data would not ship to Vercel). `workspaces.pack_id` exists but is never read | checks all of `src/`, `db/migrations/` and `next.config.ts`; lists every place in A7 |
| E2 | Example finding: "Mr. Pawar confirmed late access is every Wednesday", with B going from 5 to 4 | The open blocking gap on late-night lab access is `next_due_date`, which needs a date that has not passed. "Every Wednesday" answers `cadence` (weight 3, already covered), so B would not move | the example finding carries the next date (18 Nov 2026) and keeps the Wednesday sentence in the note |
| E3 | The lab has "different checklists (protocols, dataset provenance, compute environments, agreements)" | Checks are per pack already, but the five kinds are a closed list in the types, the zod schema and a database check. New kinds would be a core change | keeps the five kinds; the lab pack relabels them and defines its own checks, two of them new |
| E4 | Hours 0 to 4: the pack move, CI and all migrations | The pack move alone is about 7.75 working hours | both builders split it to fit four hours of wall-clock time; if only one person is free, plan 7 to 8 hours and start the two feature branches later |
| E5 | "A finding goes through the same checks" | Two existing behaviours would break it: `verify()` drops every claim the extraction did not produce unless its origin is `leaver_answer`; and extraction does not skip `answer` segments, so a pipeline re-run can turn a leaver's answer into a "From record" claim | adds `attest/core/origins.ts` and the skip kinds in the foundation hours. The second point is a Round 2 bug; confirm with a test at window open |
| E6 | "When the approver approves it, snapshot v2 is created" | The release rule can block a snapshot (for example the finding opens a conflict on a blocking check with no plan) | the finding is approved; the snapshot waits, with the blocker shown |
| E7 | Scores move when the approver approves | Leaver answers move provisional scores as soon as they are saved | findings are stricter on purpose: after release nothing moves without the approver. Say so in the testing notes |
| E8 | The finding has "an optional link or file" | A file treated as a new source would let a successor upgrade their own finding to a record | the file is stored inside the finding; only a record that arrives through Connect can corroborate. Stated limit: Understudy cannot tell who wrote an uploaded file |
| E9 | Leak grid growth belongs to improvement 2 | "What changed" and First weeks are two new output surfaces | this spec hands over `changeTexts` and covers the surfaces with its own role-scoping test until the grid includes them |
| E10 | One migration slot in hours 0 to 4 | Four people will add migrations | proposes numbers 0006 to 0009; agree before the window |

Open questions for the team before the window:

1. Is one snapshot per approved finding acceptable (three findings give v2, v3, v4), or should the approver be able to approve several and release once?
2. Should the approver be allowed to narrow a finding's role set at review? The spec leaves narrowing to the successor and to improvement 2's classifier.
3. Lab pack role keys: `pi`, `incoming_postdoc`, `phd_student`, `lab_manager`, `leaving_postdoc`. Confirm, because the answer key, the sources file and the probes file all repeat them.
4. Who runs the single precompute in hours 28 to 40, and after which merge?
