# Understudy Round 3, improvement 2: content-level confidentiality

Design spec. Planning only. Nothing in this file is product code, a migration, a test file or a
dataset file. Signatures and outlines show shape and names; the builder writes the real thing after
the window opens (23:59 IST, Fri 13 Nov 2026).

Lead: Yash, with Aman. Builder budget: 12 hours for one person (cut order in section 16).
Baseline: main at `05473dd`. Names below match that commit.

Read with: `ROUND3_PLAN.md` (section "Improvement 2"), `docs/ARCHITECTURE.md` sections 4 and 5.

---

## 1. Goal and the "done when" test

Round 2 decides who sees a segment from where it was posted: every segment takes its source's role
set. That fails when someone posts a private matter in an open channel. Round 3 adds a second
decision from what the segment says.

**Goal.** A segment that carries finance, HR or health content is limited to the roles the setting
pack allows for that category, before it is stored and before any model reads it. Nothing derived
from it (claims, conflict flags, scores, questions, graph edges, traces, stubs, exports) reaches a
role outside that set, in the original words or in other words.

**Done when** (all five hold on a fresh demo workspace and in `pnpm test`):

1. The three planted cases in the main group chat (section 3) are limited at ingest by the rule
   stage alone, with the model switched off.
2. A recorded model-call audit shows zero calls in which a limited segment sits in a batch whose
   role set is wider than the segment's role set.
3. The wider leak check passes for every role on every surface in section 9: 0 leaks in the
   "Exact tokens" rows and 0 confirmed leaks in the "Reworded facts" rows.
4. Only the approver can widen a limited segment, only with a written reason, and the change is in
   `audit_log` and on a new segment version.
5. `docs/PROBE_RESULTS.md` and the in-app Probe results page exist and list what was caught and
   what was missed, with the numbers in section 13.

---

## 2. The threat this closes

**Sensitive content in an open channel.** The demo source "RoboClub Core (WhatsApp)" is readable by
all five roles. In Round 2 a medical message posted there is stored with all five roles, goes into
an extraction batch with the rest of the chat, and can come back as a claim, a risk line in the new
member's handover, a gap question, or a stand-in note. The canary check would not notice, because
the claim statement is written by the model in new words and carries no token.

Four paths have to close:

| Path | How it leaks today | Closed by |
|---|---|---|
| Direct | The segment row and anything quoting it are visible to every role of the source | Role set narrowed before first storage (section 5) |
| Derived | A claim, question or note restates the fact in other words | Batching by the narrowed role set (already in `planBatches`), plus reworded-fact probes (section 9) |
| Inference | A conflict flag, a "Superseded" note or a graph edge shows that something hidden exists | Flag visibility in RLS (section 10), graph and recovery rules (section 11) |
| Old versions | A wider earlier version of a segment stays readable after it is limited again | Readers only see the head version (section 7) |

Out of scope: per-person access (roles only, as in Round 2), redacting part of a message (the whole
segment is limited), images and attachments, and content in a language the lexicons do not cover
(reported as a known miss).

---

## 3. Demo cases to plant

Facts only. The data builder writes the lines in the existing chat style and adds the answer-key
entries. Demo "today" stays 11 Nov 2026. Every planted positive also carries a canary token in the
text, listed in `ground_truth.json` under `restricted` with the narrowed role set, so the existing
token check covers it with no code change.

### Case A: medical excuse (health)

- Where: main group chat, early November.
- Facts: Dev Malhotra tells the group he is having knee surgery on 17 Nov 2026, will be out for two
  weeks, and cannot take his drive-team trial on the planned date. He asks for his slot to move.
- Follow-ups in the same thread within a few minutes: Kabir wishes him a quick recovery; Rohan says
  he will sort out the trial slot.
- Expected: Dev's message limited by rule (health). Kabir's reply limited as a follow-up. Rohan's
  reply ("I will sort your trial slot") is a decoy that should stay open: it says nothing medical.
- Allowed roles: `president` only.
- Why it matters for the handover: it touches R10 (drive team selection), so a careless pipeline
  would turn it into a risk or dependency claim for everyone.

### Case B: fee dispute (finance)

- Where: main group chat, late October.
- Facts: Ananya (treasurer) writes that Kabir Sethi still owes the Rs 1,500 season membership fee
  from August and that his Rs 2,340 reimbursement for motor drivers is on hold until it is cleared.
  Kabir answers that he paid Rs 1,500 in cash to Priya in July.
- Expected: both messages limited by rule (finance: amount plus a person plus an owes or paid cue).
  The two statements disagree, so Attest should mark a conflict whose both sides are limited to the
  finance roles.
- Allowed roles: `president`, `treasurer`, `leaver` (the same set as the "Slack #finance" source).
- Why it matters: the leaver can see it and may be asked about it; the successor and new member
  must not learn that a member is in a money dispute.

### Case C: complaint about a person (HR)

- Where: main group chat, mid October.
- Facts: Sneha Joshi writes that Arjun Rao keeps dismissing her firmware work in reviews, called it
  useless in front of the first years, and asks Rohan to step in or she will leave the firmware
  subteam.
- Expected: limited by rule (HR: complaint cue plus a named person).
- Allowed roles: `president` only. The leaver and the incoming tech lead do not see it. Arjun is a
  likely knowledge neighbour in improvement 1, so this case also proves that a neighbour is never
  asked about, or shown, a matter that concerns them and is hidden from their role.

### Case D: conflict with one hidden side (for the flag policy)

- Facts: in "Slack #events" (open) a member says the competition entry fee must be paid by 28 Nov.
  "Slack #finance" (restricted source, already in the demo) says 25 Nov. Equal authority, different
  authors, no reply link: rule 3, both conflicting.
- Expected: the #events message is not limited (a fee deadline with no amount and no person is not
  sensitive). `tech_lead` and `new_member` can read one side only, so they see neither the flag nor
  the value: a stub and coverage "Restricted". `president`, `treasurer` and `leaver` see both sides
  and the flag. R08 "next due date" stays restricted for the tech lead, as in the Round 2 answer key.

### Decoys that must stay open

Already in the demo or to add. Each is a labelled negative in the evaluation set.

| Text idea | Why it tempts the classifier | Expected |
|---|---|---|
| "All reimbursements go through me, please keep the bills" (exists) | finance word | open |
| "Late registration for RoboLeague costs double" (exists) | finance word | open |
| "Motor driver got hot again" (exists) | "hot", near a health lexicon | open |
| "Saturday attendance was low, exams?" (exists) | attendance | open |
| "I am sick of this USB cable drama" | idiom | open |
| "First aid kit is in the grey cupboard in Lab 3" | health word, operational fact | open |
| "ESP32 dev boards ordered, 3 pcs, Rs 1,350, voucher filed" | amount plus purchase | borderline, model says none, open |
| "This PID bug is a headache" | idiom | open |

One decoy is deliberately a likely false positive for the demo script: "Priya paid Rs 450 for the
lab booking deposit, I will reimburse her on Monday". It has an amount, a person and a
reimbursement cue, so the rule stage limits it, yet it is routine and useful (it backs the lab
booking procedure). The judge walkthrough widens this one (section 4.2).

---

## 4. What a judge sees

All copy below is final wording. Plain words. No em dashes. Every status has a symbol and a word.
"Club President" is the approver label from the pack; after improvement 3 it is read from the pack,
never typed in core code.

### 4.1 Connect: the "Sensitive content" panel

Placed on the Connect page under the Sources table, above the run panel.

Heading: **Sensitive content**

Approver view, intro:

> These messages were posted where many people can read them, but they look like money, people or
> health matters. Each one was limited to the roles allowed to see that kind of content before
> anything was stored or read by the model.

Count line: `{n} limited · {h} held for you to check · {w} widened by you`

One row per limited segment the viewer can read:

| Part | Copy |
|---|---|
| Header | `{source name} · {date} · {author}` |
| Text | the masked segment text |
| Category chip | `₹ Money` / `☷ People matter` / `✚ Health` |
| Reason | `Why: {reason}` where reason is one of: "mentions a medical condition", "mentions money a person owes or is owed", "mentions a bank or payment account", "reads like a complaint about a person", "follows a message that was limited", "could not be checked" |
| Found by | `Found by a rule` / `Found by the model` / `Held: not checked yet` / `Limited by {approver label}` |
| Visibility | `Visible to: {role chips}` and, muted, `Before: {role chips}` |
| Action (approver) | button `Widen` |
| Action (others) | muted text `Only the approver can widen this.` |

Held notice, shown when `h > 0`:

> {h} messages could not be checked because the model was unavailable. They stay limited until the
> approver decides.

Non-approver summary line, shown when the role cannot read some limited segments:

> {n} messages in sources you can open are limited to fewer roles. Ask the approver (Club President).

The number comes from a count-only database function (section 7). No topic, category or author.

Empty state: `No sensitive content found in open channels.`

A small line in the Sources table, under the segment count of a source, approver only:
`{n} limited`.

### 4.2 Widening

`Widen` opens a form in place.

- Heading: **Widen who can see this**
- Choice 1 (default): `Everyone who can see {source name}`
- Choice 2: `Choose roles`, with one checkbox per role of the source. Roles that already see it are
  ticked and locked.
- Text area label: `Why is this safe to widen?`
- Hint: `At least 10 characters. Saved in the audit log.`
- Submit: `Widen and re-run`
- Cancel: `Keep it limited`

After submit, in the row: `⟳ Widened. Re-running the steps that used this message.` then
`✓ Widened by Club President on {date}. Reason: {reason}` and a button `Limit again`.

Errors:

- `Only the approver (Club President) can change who sees this.`
- `Write why, in at least 10 characters.`
- `You can only widen back to the roles of the source.`

On the Handover page, when a visibility change is newer than the latest snapshot:

> Visibility changed after this snapshot was approved. Approve a new snapshot to apply it.

Manual limit (the fix for a miss), approver only, on the source segment page: button
`Limit who sees this`; form heading **Limit who can see this**; field `What kind of content is
this?` with options `Money`, `People matter`, `Health`; field `Why?`; submit `Limit and re-run`.

### 4.3 Handover: the expanded Leak check grid

The panel keeps its place and title. It gains surfaces and a second block.

Heading: **Leak check**

Intro:

> {t} canary tokens and {f} reworded facts are planted in restricted and sensitive content. Every
> role's view of every output is checked. A role may only meet what it is allowed to see.

Summary chip: `✓ All {n} checks pass` or `✕ {k} of {n} checks fail`.

Block 1 heading: **Exact tokens**. Sub-line: `Looks for the planted tokens, letter for letter.`
Block 2 heading: **Reworded facts**. Sub-line, one of:

- `Checked by key terms and by the model judge. Last judge run: {date time}.`
- `Checked by key terms. The model judge has not run yet.`

Rows are roles (label, and under it `may see {m} of {t}`). Columns:

`Handover text · Export · Stubs · Scores · Timeline · Questions · Conflict flags · Claim list ·
Test notes · Sensitive panel · People graph · Neighbour questions · Traces · Ranked options`

Cell copy: `✓ Pass` (title: `{n} texts checked`), `✕ {n} leaks`, `· Nothing to check`,
`· Not built`. "Not built" is used when improvement 1 has not registered its surfaces.

Footer link: `See probe results`. Approver-only button: `Run probes again`.

### 4.4 Probe results page (`/w/[id]/probes`)

Title: **Probe results**

Lead:

> Restricted facts were planted in reworded form. This page shows what each check caught and what
> it missed.

Sections, in order:

1. **Classifier**. Table: `Category · Planted · Caught by a rule · Caught by the model · Held ·
   Missed · Wrongly limited`. Under it: `Precision {p}%. Recall {r}%. {n} messages checked.`
2. **Outputs**. The same grid as on Handover, both blocks.
3. **Detector check**. `We fed {n} reworded leaks straight into each check to see what it catches.
   Key terms caught {a}. The model judge caught {b} more. {c} got past both.`
4. **Findings**. One line each: `Probe {id} · {role label} · {surface label} · caught by
   {key terms / model judge}`. The fact text and the matching quote are shown to the approver only.
   Other roles see the line without them.
5. **Missed**. Plain list of planted items no check caught, with the wording that got through
   (approver only), or `Nothing was missed in this run.`
6. **What we do about a miss**. Fixed text:

   > A miss is fixed by the approver with "Limit who sees this" on the message. The change applies
   > at once to claims and handovers, and is logged.

The same content is generated into `docs/PROBE_RESULTS.md` by a script (section 9.6).

---

## 5. Classifier design (`src/lib/tether/sensitivity.ts`)

### 5.1 Types

```ts
export type SensitivityCategory = "finance" | "hr" | "health";      // closed list, core
export type SensitivityStage = "rule" | "follow" | "model" | "held" | "manual" | "widened";

export interface SensitivityDecision {
  segmentId: string;
  outcome: "clear" | "borderline" | "sensitive";
  categories: SensitivityCategory[];      // empty when clear
  stage: SensitivityStage | null;
  reason: string | null;                  // one of the fixed reason strings in 4.1
  hits: string[];                         // rule ids that fired, for tests and the results page
}

export interface PackSensitivity {
  roles: Record<SensitivityCategory, RoleKey[]>;
  extraTerms?: Partial<Record<SensitivityCategory, { strong?: string[]; weak?: string[] }>>;
}

/** Rule stage. Pure and synchronous. */
export function classifyByRules(segs: readonly Segment[], ctx: RuleContext): SensitivityDecision[];

/** Narrow one role set. Never returns a role that is not in `current`. */
export function narrowRoleSet(current: readonly RoleKey[], categories: readonly SensitivityCategory[],
  pack: PackSensitivity): RoleKey[];

/** Rules, then the model for borderline segments. Returns copies with roleSet and the new fields set. */
export async function applySensitivity(sources: IngestedSource[], pack: PackSensitivity,
  opts: { call?: SensitivityModelCall; budgetMs?: number; knownNames: string[] }): Promise<{
    sources: IngestedSource[]; report: SensitivityReport }>;

/** For segments made outside ingest (leaver answers, neighbour answers, findings). Rules only. */
export function narrowForSensitivity(text: string, kind: SegmentKind, roleSet: readonly RoleKey[],
  pack: PackSensitivity, knownNames: string[]): { roleSet: RoleKey[]; categories: SensitivityCategory[];
  stage: SensitivityStage | null; reason: string | null };

export const CLASSIFIER_VERSION = 1;     // bump when lexicons or rules change
```

`RuleContext = { knownNames: string[]; pack: PackSensitivity }`. `knownNames` are display names and
aliases from the `PersonRegistry`, split into first and last names, lowercased. Names are used only
to decide "is a person mentioned"; they are never written into ids or reasons.

### 5.2 Rule stage

Input text: the masked segment text, plus for `task` segments the masked title and description from
`meta`. Normalised with the existing `norm()`. Matching is on whole words.

Each category has **strong** terms, **weak** terms, **context cues** and an **ignore list**. The
lexicons live in one data file, `src/lib/tether/sensitivity-lexicon.ts`, so reviewers can read them
in one place. English plus the common Hinglish forms seen in the demo chat.

**Finance**

| Kind | Content |
|---|---|
| Amount pattern | currency mark or word (`₹`, `Rs`, `Rs.`, `INR`, `rupees`, `rs`) next to a number, with `k`, `lakh`, `crore`, commas and decimals allowed |
| Account patterns | IFSC shape (4 letters, `0`, 6 letters or digits); UPI id shape (`name@bank` with no dot after the `@`); 9 to 18 digits within 3 words of `account`, `a/c`, `acct`; PAN shape (5 letters, 4 digits, 1 letter) |
| Personal-money cues | owe, owes, owed, dues, unpaid, not paid, has not paid, pending from, refund, refunded, penalty, fine of, waive, waiver, defaulter, on hold until, salary, stipend, loan, lent, borrowed, paid in cash, udhaar, baki |
| Weak terms | fee, payment, budget, invoice, quote, quotation, reimbursement, reimburse, voucher, ledger, purchase order, PO, sponsor amount |
| Ignore | "costs double", "free", "price of" with no person |

Rules:

- F1 strong: an account pattern. Reason "mentions a bank or payment account".
- F2 strong: an amount AND a personal-money cue AND a person (known name, or `I`, `me`, `my`,
  `he`, `she`, `him`, `her`). Reason "mentions money a person owes or is owed".
- F3 strong: a personal-money cue AND a known name AND the word `fee` or `dues`, no amount needed.
- F4 weak (borderline): an amount alone, or a personal-money cue alone, or two or more weak terms.
- A single weak term alone is clear. This keeps "entry fee" and "reimbursements go through me" open:
  both are entity aliases in `packs/club.json` and appear in open sources on purpose.

**HR**

| Kind | Content |
|---|---|
| Complaint cues | complain, complaint, grievance, harass, harassment, bully, bullying, misbehave, abusive, shouted at, yelled at, insulted, humiliated, in front of, discriminate, unfair to, threatened, disciplinary, warning letter, show cause, suspend, kick out, remove from the team, step in, or I will leave, quit the team |
| Judgement terms | useless, lazy, incompetent, not pulling weight, dead weight, toxic |
| Weak terms | attendance, late again, dropped from, removed, behaviour, attitude |

Rules:

- H1 strong: a complaint cue AND a known name other than the author. Reason "reads like a complaint
  about a person".
- H2 strong: a judgement term AND a known name within 8 words.
- H3 weak: a complaint cue with no name; or a weak term AND a known name.

**Health**

| Kind | Content |
|---|---|
| Condition and treatment terms | surgery, operation, operated, hospital, hospitalised, admitted, ICU, diagnosed, diagnosis, fracture, dengue, typhoid, malaria, covid, migraine, asthma, epilepsy, diabetes, anxiety, depression, panic attack, therapy, therapist, counselling, medication, prescription, medical certificate, doctor's note, medical leave, chemo, pregnant, miscarriage, injury, stitches |
| Weak terms | sick, unwell, not feeling well, fever, doctor, clinic, medical, health issue, tabiyat, bukhar, bimar |
| Ignore (idioms and equipment) | sick of, fever pitch, is a headache, pain to, killing it, dead battery, first aid kit, soldering clinic, got hot, burnt out motor |

Rules:

- M1 strong: a condition or treatment term AND a person (known name, `I`, `my`, `me`, or a family
  word: mom, dad, mother, father, brother, sister, wife, husband). Reason "mentions a medical
  condition".
- M2 weak: a condition or treatment term with no person; or a weak term with a person.
- A weak term alone is clear. Ignore-list phrases are removed before matching.

**Follow-up rule (all categories)**

- R1: a segment that replies to a sensitive segment (`meta.replyTo`) takes its categories. Stage
  `follow`, reason "follows a message that was limited".
- R2: in sources with no reply links (WhatsApp), the next 4 segments in the same thread within 20
  minutes of a sensitive segment become **borderline** with the parent's categories as candidates
  when they contain a follow-up cue (get well, take care, recover, sorry to hear, that is not fair,
  I paid, you owe, prove it, not true) or the first name of a person named in the parent. Others
  stay clear.

**Outcome per segment**

- any strong rule: `sensitive`, stage `rule` (or `follow` for R1).
- else any weak rule: `borderline`.
- else `clear`.
- several categories: all are recorded; the role set is the intersection of their role lists.

**Segment kinds.** All kinds go through the rule stage. `file` segments (repository files) only
honour strong rules and never go to the model stage; code and config are full of words that look
like weak terms.

### 5.3 Model stage (borderline segments only)

- Input: borderline segments, grouped by `(sourceId, source role set)`, in batches of at most
  4,000 characters. One batch never mixes role sets, the same rule as extraction.
- System prompt: fixed text that defines the three categories in one sentence each and says "answer
  none when the text is routine club business". For an R2 candidate the user prompt adds one line
  per segment: `follows a message already limited as: {category}`. The parent's text is never
  included.
- Output schema (zod, strict): `{ items: [{ segment_id, category: "finance" | "hr" | "health" |
  "none" }] }`. Ids not in the batch are dropped. Anything other than the four enum values fails
  the schema. No free text is accepted from the model.
- Effect: a category narrows the segment (stage `model`). `none` leaves the segment as the rules
  left it, which for a borderline segment is the source role set. The model stage has no way to
  express "widen" and no way to clear a strong rule hit, because strong hits are never sent to it.
- Client: `callJson` through a thin wrapper (same pattern as `attestModelCall`), `jsonSchemaName`
  `sensitivity_v1`, temperature 0. Cached by the existing content hash, so the committed
  `data/demo/model_cache.json` makes the demo instant and identical on every clone.
- Budget at ingest: 20 seconds in total, one retry per batch, concurrency 4.
- **Fail closed.** If a batch fails, times out, is not in the cache while the model is off, or the
  budget runs out, its segments are limited to the candidate categories with stage `held` and
  reason "could not be checked". Held segments are released only by the approver. So with
  `MODEL_DISABLED=1` the pipeline is still safe, only more conservative.

Why this still fits "the model can only narrow": the model runs before the first write. Until then
the segment has no stored role set. After the first write, the only code path that adds a role is
the approver action in section 8.

### 5.4 Where it runs, exactly

In `ingestSources` (`src/lib/pipeline/ingest.ts`), one new call between parsing and the first write:

```
ingestSources(ws, inputs, origin):
  registry    <- registryFor(ws)
  out         <- ingestAll(inputs, ...)            // adapters: parse, mask, ids. Pure. Unchanged.
  classified  <- applySensitivity(out.sources, pack.sensitivity, { knownNames, call, budgetMs })   // NEW
  storePeople(ws, out.people)
  for each source in classified.sources: storeResult(ws, source, origin)   // first write of role_set
  audit(ws, "system", "classify_sensitivity", report counts only)
```

Consequences:

- The narrowed role set is the first and only role set ever stored for version 1 of the segment.
  `role_set_original` keeps the source role set for the panel and for widening.
- Segment ids do not change: the id hash never included the role set.
- Extraction needs no change. `planBatches` already groups by `(source, thread, identical role
  set)`, so a limited segment lands in a batch with only its own role set. The support check, the
  stand-in and the gap questions already read under RLS or per batch.
- The same holds for every later model call. The invariant is stated and tested once (section 14,
  test T7): for every model call in a full pipeline run, each segment in the call has exactly the
  call's role set, and no limited segment appears in a call whose role set contains a role outside
  the pack's list for its category.
- The classifier's own calls are the one place a model reads a borderline segment before its final
  role set is known. They return ids and enum labels only, and their results are written to
  columns, never to text a role reads.

Segments created outside ingest call `narrowForSensitivity` before their insert: leaver answers
(`answerQuestion` in `src/lib/lacuna/index.ts`), neighbour answers (improvement 1) and successor
findings (improvement 3). Rules only; a borderline answer is held. This is a one-line hook in each
place and is listed in section 17 as a request to those owners.

### 5.5 Re-ingest and segment versions

- Same content uploaded again: same segment id, `INSERT ... ON CONFLICT DO NOTHING` on
  `(workspace_id, id, version)`, so nothing changes and any approver decision stands.
- Changed content: a new segment id, classified from scratch. A decision made on the old text does
  not carry over, which is right because the text is different.
- Lexicon or rule change (`CLASSIFIER_VERSION` bumped): the pipeline's `connect` step calls
  `reclassify(ws)`. For each head segment with `classifier_version` lower than the current one and
  stage not in (`manual`, `widened`), rules run again. A newly sensitive segment gets a new version
  row with the narrowed role set. A segment that the new rules would clear is **not** widened
  automatically; it is listed in the panel as `Rules no longer flag this` for the approver to
  widen. Approver decisions (`manual`, `widened`) are never overwritten by a reclassify.
- Segments are immutable (the `segments_immutable` trigger blocks UPDATE). Every visibility change
  is therefore a new row with `version + 1`, the same id, text and meta, and the new role set and
  sensitivity fields. Admin reads already take the newest version (`DISTINCT ON (id) ... ORDER BY
  version DESC`). Reader policies change so that only the head version is visible (section 7).
- Snapshots record evidence segment ids and versions. A visibility change therefore shows up in the
  next snapshot's diff as a changed evidence version, and changes its hash.

---

## 6. Pack additions (`packs/club.json`, `src/lib/pack/schema.ts`)

New key, required for every pack:

```jsonc
"sensitivity": {
  "roles": {
    "finance": ["president", "treasurer", "leaver"],
    "hr":      ["president"],
    "health":  ["president"]
  },
  "extraTerms": { "finance": { "weak": ["cost centre"] } }     // optional, per setting
}
```

Schema rules (zod):

- `roles` has exactly the three category keys; each value is a non-empty list of the pack's role
  keys.
- Every list contains `approverRole`. A pack that breaks this fails to load, so the approver can
  always open what the panel shows.
- `extraTerms` is optional; terms are added to the core lexicons for that pack only.

Narrowing rule: `new role set = current role set ∩ roles[category]` (intersection over all hit
categories). If the intersection is empty (the source already excluded every allowed role), the
role set is left as it is and the row is still marked, with the panel note `Already limited. Not
changed.` Narrowing never adds a role.

Review tier: a claim that cites any segment with a non-empty `sensitivity` is tier C (evidence
opened and a written reason before approval), whatever its role set. Today tier C is tied to the
literal `new_member`; improvement 3 moves that to the pack, and this rule is added next to it.

For improvement 3: `packs/lab.json` must carry the same key (for example finance to PI and lab
manager; HR and health to PI only). Categories are core vocabulary, not setting literals, so they
do not trip the no-setting-literals check. This module contains no role key literal.

---

## 7. Database changes (one migration, proposed name `0007_confidentiality.sql`)

Numbering to agree in hours 0 to 4: `0006_recovery` (improvement 1), `0007_confidentiality`,
`0008_findings` (improvement 3). All statements idempotent, like 0005.

**`segments`, new columns**

| Column | Type | Meaning |
|---|---|---|
| `sensitivity` | `text[] NOT NULL DEFAULT '{}'` | categories found; empty means not sensitive |
| `sensitivity_stage` | `text` null | `rule`, `follow`, `model`, `held`, `manual`, `widened` |
| `sensitivity_reason` | `text` null | fixed reason string shown in the panel |
| `role_set_original` | `text[]` null | the source role set at ingest; null when never narrowed |
| `visibility_note` | `text` null | the approver's written reason, on the version it created |
| `visibility_actor` | `text` null | role key that made this version |
| `classifier_version` | `integer NOT NULL DEFAULT 0` | rules version that last looked at the row |

The history of a segment's visibility is its list of versions. No separate table.

**Head-version rule for readers.** New function `us_segment_head(ws uuid, seg text) returns
integer` (SQL, STABLE, SECURITY DEFINER, returns the highest version only). The `us_reader_select`
policy on `segments` becomes: same workspace AND role in `role_set` AND
`version = us_segment_head(workspace_id, id)`. Without this, a segment widened in version 2 and
limited again in version 3 would still be readable at version 2: `getSegment` and `loadEvidence`
take "the newest version this role can see". A policy cannot query its own table directly
(recursion), hence the function.

**Flag visibility on claims**

| Table | Column | Meaning |
|---|---|---|
| `claims` | `flag_role_set text[]` null | when set, only these roles may see the claim at all (section 10) |
| `snapshot_claims` | `flag_role_set text[]` null | frozen copy at approval |

New function `us_can_see(role text, role_set text[], flag_role_set text[]) returns boolean`
(IMMUTABLE): `role = ANY(role_set) AND (flag_role_set IS NULL OR role = ANY(flag_role_set))`.
Used in three places so they cannot drift apart:

1. `us_reader_select` on `claims` and on `snapshot_claims`.
2. `count_withheld()`.
3. `claim_meta()`, which now returns the effective role set (`role_set` cut down by
   `flag_role_set`), so the stand-in's "Restricted" decision agrees with what RLS shows.

**New count function** `count_limited(ws uuid, role text) returns integer`: head segments with a
non-empty `sensitivity` that the role cannot read. SECURITY DEFINER, integer only, EXECUTE granted
to `us_reader`. Used by the non-approver line in the panel.

**New table `probe_runs`** (admin only: no grant to `us_reader`)

| Column | Type |
|---|---|
| `workspace_id`, `id` | uuid, text (primary key together) |
| `created_at`, `actor` | timestamptz, text |
| `snapshot_id` | text null |
| `model_tag`, `judge_used` | text, boolean |
| `cells` | jsonb: `[{ role, surface, row: "token" or "probe", texts, leaks, unconfirmed }]` |
| `findings` | jsonb: `[{ factId, role, surface, by: "key_terms" or "judge", quote, confirmed }]` |
| `summary` | jsonb: the numbers of section 13 |

**Audit actions** (rows in the existing `audit_log`): `classify_sensitivity`, `widen_segment`,
`limit_segment`, `reclassify_sensitivity`, `run_probes`.

Shared files touched by these changes (additive only): `src/lib/types.ts` (optional fields on
`Segment`, the two new types), `src/lib/db/mappers.ts` (`segmentRow`, `toSegment`).

---

## 8. The widening action (`src/lib/tether/visibility.ts`)

```ts
export type VisibilityChange =
  | { action: "widen"; roles: RoleKey[] | "source"; reason: string }
  | { action: "limit"; categories: SensitivityCategory[]; reason: string };

export async function setSegmentVisibility(ws: string, segmentId: string, change: VisibilityChange,
  actor: RoleKey): Promise<{ ok: true; version: number; runId: string } | { ok: false; error: string }>;

export async function listSensitive(ws: string, role: RoleKey): Promise<SensitiveRow[]>;  // under withRole
export async function countLimited(ws: string, role: RoleKey): Promise<number>;           // count_limited()
export async function reclassify(ws: string): Promise<{ narrowed: number; noLongerFlagged: number }>;
```

Rules, all checked on the server (the role comes from the cookie, as in the other actions):

1. `actor` must equal `pack.approverRole`. The leaver can never do this. Error text as in 4.2.
2. `reason`, trimmed, has at least 10 characters.
3. Widen: the target set `S` must satisfy `current ⊆ S ⊆ role_set_original`. `"source"` means
   `role_set_original`. Widening never goes beyond the source's own roles.
4. Limit: the target set is `narrowRoleSet(current, categories, pack)`.

Steps for **widen**:

```
begin
  head <- newest version of the segment (admin read)
  insert version head+1: same id, text, meta; role_set = S; sensitivity kept;
         sensitivity_stage = 'widened'; visibility_note = reason; visibility_actor = actor
commit
audit(ws, actor, "widen_segment", { segmentId, fromVersion, toVersion, from, to, categories, reason })
runId <- startRun(ws); after(): executeRun(ws, runId)        // the normal five steps
```

The categories stay on the row, so the panel still lists the segment, now as "Widened", and the
tier C rule in section 6 still applies to its claims.

Re-run of affected steps. The whole pipeline is started, and the cache makes it cheap: only the
extraction batches of the affected `(source, thread)` have new contents (one segment moves from the
narrow group to the wide group), so only those miss the cache. Everything else replays (Round 2
measured 23 cached batches in under a second). Then verify recomputes claim role sets by
intersection, the test runs again for the tested roles and the gap questions are rebuilt. For the
scripted demo widening (the lab deposit decoy in section 3) the answers are precomputed into
`data/demo/model_cache.json`, so the judge sees it finish in seconds.

A widening changes live claims after the re-run. It reaches handovers only when the approver
approves the next snapshot; until then the banner in 4.2 is shown. Snapshots stay frozen.

Steps for **limit** (must take effect at once, not after a re-run):

```
begin
  insert version head+1 with the narrowed role_set, sensitivity = categories, stage 'manual', note, actor
  claims that cite the segment (accepted citation): role_set <- role_set ∩ new role set
  snapshot_claims for those claim ids, in every snapshot: role_set <- role_set ∩ new role set
  delete unanswered gap_questions (their text may quote the claim)
  blank the notes of the latest test run per role for checks that cite those claims
commit
audit(ws, actor, "limit_segment", { ... })
start the same re-run
```

The stored snapshot payload and its hash are not touched; only the per-role projection
(`snapshot_claims.role_set`) is cut down. Confidentiality wins over showing an old handover
unchanged. The Handover banner in 4.2 tells the approver to approve a new snapshot.

---

## 9. Leak check: more surfaces, and paraphrase probes

### 9.1 Surface registry (`src/lib/relay/surfaces.ts`)

Today `runLeakCheck` hard-codes six surfaces. It becomes a loop over providers:

```ts
export interface SurfaceProvider {
  key: LeakSurface;                       // column key
  label: string;                          // column label from 4.3
  collect(ws: string, role: RoleKey): Promise<Surface[] | "not_built">;   // Surface from relay/core/canary
}
```

Each provider returns the exact strings that role would be shown, read the same way the page reads
them (inside `withRole`, or through the page's own data function).

| Key | Label | What is collected for a role | Owner |
|---|---|---|---|
| `handover` | Handover text | every line of the compiled doc and the plain claim groups (as today) | this spec |
| `export` | Export | the Markdown export | this spec |
| `stubs` | Stubs | every stub line and the header stub | this spec |
| `scores` | Scores | score line and release label | this spec |
| `timeline` | Timeline | decision timeline lines | this spec |
| `questions` | Questions | gap question texts, plus the leaver's answers the role can read | this spec |
| `conflicts` | Conflict flags | conflict lines in the handover; state notes and "Superseded by" lines on the Claims page; coverage words on the Test page | this spec |
| `claims` | Claim list | statement, value, entity label and state note of every claim from `listClaims(ws, { role })`; dropped drafts from `listDropped` | this spec |
| `test_notes` | Test notes | stand-in notes of the latest run, for the tested role and the approver (others get the generic notes) | this spec |
| `sensitive_panel` | Sensitive panel | everything the Connect panel renders for the role, including the count line | this spec |
| `graph` | People graph | node labels, edge labels and "why picked" lines | improvement 1 |
| `neighbour_questions` | Neighbour questions | question texts shown to that role as a neighbour | improvement 1 |
| `traces` | Traces | trace step texts | improvement 1 |
| `ranked_options` | Ranked options | option texts and their evidence lines | improvement 1 |

The four improvement 1 surfaces come from one function they export (section 11). The registry
imports it defensively (the same pattern as `lacunaReleaseLine` in `relay/index.ts`), so this work
merges in any order: until the function exists those columns read "Not built" and are left out of
the pass count.

`LeakReport` gains `rows: ("token" | "probe")[]`, cells gain `row` and `unconfirmed`, and
`runLeakCheck(ws, opts?: { judge?: "stored" | "off" })` returns both blocks. The export guard
(`exportMarkdown`) also runs the key-term probe check and refuses the export on a hit, with the
existing "Export blocked" message.

### 9.2 Probe file shape (`data/demo/probes.json`)

```jsonc
{
  "version": 1,
  "facts": [
    {
      "id": "pf-01",
      "category": "health",
      "fact": "Dev Malhotra is having knee surgery on 17 Nov 2026 and is out for two weeks.",
      "roleSet": ["president"],                 // roles allowed to meet this fact
      "canary": "CANARY-XXXX",                  // the token on the planted original, if any
      "termGroups": [                           // each inner list is a set of alternatives
        ["dev", "malhotra"],
        ["surgery", "operation", "operated", "hospital", "knee", "under the knife"],
        ["2026-11-17", "17 nov", "17th", "two weeks", "fortnight"]
      ],
      "mustGroups": [1],                        // groups that have to be among the matches
      "minGroups": 2,
      "rewordings": [                           // the fact in other words, 3 or more
        "One of the drivers is going under the knife on the 17th and will not be around for a fortnight.",
        "Dev ka 17 ko operation hai, do hafte nahi aayega.",
        "Dev unavailable 17 Nov to 1 Dec (medical)."
      ]
    }
  ],
  "evalSegments": [                             // classifier evaluation set, not part of the live demo
    { "id": "ev-001", "kind": "message", "thread": "RoboClub Core", "author": "Dev Malhotra",
      "text": "...", "expect": "sensitive", "category": "health", "factId": "pf-01", "difficulty": "rule" }
  ]
}
```

`difficulty` is `rule` (a strong rule should catch it), `model` (weak terms only) or `hard` (no
lexicon word at all). `expect` is `sensitive` or `open`. Planned size: 8 facts (the three cases
with their sub-facts, plus the five existing restricted compartments restated as facts),
3 rewordings each, and about 40 evaluation segments: 18 positives and 22 negatives including every
decoy in section 3.

### 9.3 How reworded facts are planted

Three places, each answering a different question:

1. **In the live demo sources** (a few): each of cases A, B and C gets one extra message that
   restates the fact with different words and still trips a rule (for example a later line "Dev's
   operation is on the 17th, he is out till December"). These must be limited, and the grid must
   stay green. They prove the pipeline, not only the first message.
2. **In the evaluation set** (`evalSegments`): all difficulties, including `hard` ones no rule can
   catch. These are ingested into a scratch workspace by the evaluation script only. This is where
   honest misses come from. Hard rewordings are kept out of the live demo so the demo never shows a
   new member someone's medical details.
3. **Straight into outputs** (the detector check): each rewording is placed into a synthetic
   surface text for a role that may not see the fact, and both checks are asked to find it. This
   measures the probe itself: a probe that cannot catch a planted rewording is not evidence of
   anything.

Note what the probes add over tokens even when the classifier is perfect: claim statements are
written by the model in its own words and carry no token. A claim wrongly visible to a role would
pass the token rows and fail the probe rows.

### 9.4 Check 1: normalised key-term match (`src/lib/relay/core/probes.ts`, pure)

```ts
export interface ProbeFact { id: string; roleSet: RoleKey[]; termGroups: string[][]; mustGroups: number[]; minGroups: number }
export interface ProbeFinding { factId: string; surface: string; by: "key_terms" | "judge"; quote: string; confirmed: boolean }

export function normaliseForProbe(text: string): string;
export function scanForFacts(texts: readonly Surface[], role: RoleKey, facts: readonly ProbeFact[]): ProbeFinding[];
```

`normaliseForProbe`: `norm()`; punctuation to spaces; currency marks dropped and numbers
canonicalised ("Rs 1,500", "1.5k", "₹1500" all become `1500`); dates canonicalised to ISO with the
existing `toIsoDate`; a light stem (trailing `s`, `ed`, `ing` removed from words of 5 or more
letters). Terms in `termGroups` are normalised the same way.

A fact is found in one text unit (one surface string, split into windows of 400 characters with
half overlap) when at least `minGroups` groups match and every group in `mustGroups` is among them.
Only facts whose `roleSet` lacks the role are checked. The finding's quote is the window.
Deterministic, no model, runs in `pnpm test` and live on every render of the grid.

### 9.5 Check 2: model judge (`src/lib/relay/probes.ts`)

- One call per `(role, surface chunk)`, chunk at most 4,000 characters, listing the facts that role
  may not see. Prompt: "For each fact, does this text reveal it, in any wording? If yes, copy the
  exact words that reveal it."
- Output schema: `{ revealed: [{ fact_id, quote }] }`.
- The judge **can only add findings**. Its answers are merged as a union with the key-term
  findings. There is no code path by which a judge answer removes or downgrades a key-term finding,
  and a "not revealed" answer is simply ignored.
- A judge finding counts as a leak only when its quote is found in the chunk after `norm()` (the
  same exact-quote rule Attest uses). A finding with a quote that is not in the text is kept and
  shown as `unconfirmed`, and does not fail the check. This stops an invented quote from turning
  the grid red.
- The judge reads restricted facts next to one role's outputs. Its results go only to `probe_runs`
  (admin table). Pages show fact text and quotes to the approver only.
- Calls go through `callJson` (cached). The judge does not run on page render. It runs from the
  approver's `Run probes again` action (inside `after()`), from the script, and with an injected
  fake call in tests.

### 9.6 Storing and writing up

- `runProbes(ws, actor, opts)` builds the grid (both rows), runs the judge when asked, and inserts
  one `probe_runs` row. The Handover grid shows live token and key-term results and merges in the
  judge findings of the latest stored run for the current snapshot.
- `scripts/probe-eval.ts` (run as `pnpm tsx scripts/probe-eval.ts`, like `scripts/eval.ts`):
  1. creates a demo workspace, runs the pipeline, approves a snapshot with the scripted plan;
  2. runs the classifier over `evalSegments` in a scratch workspace and scores it;
  3. runs the detector check of 9.3 point 3;
  4. runs `runProbes` with the judge;
  5. writes `docs/PROBE_RESULTS.md` (same sections as the page in 4.4) and prints the summary.
- The page `/w/[id]/probes` reads the latest `probe_runs` row plus the committed classifier numbers
  (the evaluation set is not in the visitor's workspace, so those numbers come from the summary the
  script wrote into `data/demo/probe_summary.json`).

---

## 10. Policy for conflict flags and other tell-tale labels

**Rule.** A role sees a conflict flag only if it can see every claim in the conflict. Otherwise it
sees none of them: the claims count as restricted items and the role gets a stub.

Why not show the visible side without the flag: the successor would act on a value the record
disputes. Why not show the flag on the visible side: "disputed" tells the role that a hidden claim
exists and that it disagrees, which narrows down a hidden value. So the visible side is withheld
until the approver settles the conflict in Review (rejecting one side clears the flag and the
surviving claim becomes visible again under its own role set).

**How.** In `verify()` after `applyRules`, a new pure helper computes flag visibility and one
UPDATE writes it:

```ts
// src/lib/attest/core/flags.ts
export function flagRoleSets(claims: readonly Claim[], firings: readonly RuleFiring[]): Map<string, RoleKey[] | null>;
```

- Conflicts (rules 3 and 4): group conflicting claims by `(entity, attribute)` into connected
  components over the firings. For each component, `flag = intersection of the members' role sets`.
  Every member gets that set. When the intersection equals a member's own role set, null is stored
  (nothing extra to hide).
- Supersession (rules 1 and 2): a superseded claim gets `flag = its role set ∩ the winner's role
  set`. Its state note ("Superseded: the task board owns deadlines (updated on ...)") and the
  "Superseded by" link otherwise reveal that a newer hidden value exists.
- Everything else: null.

RLS does the rest through `us_can_see` (section 7). No change is needed in `compileHandover`,
`questionText` or the Claims page: for a role outside the flag set the row does not exist. The
stand-in sees no evidence for that check while `claim_meta` reports that evidence exists for other
roles, so the coverage is "Restricted", and a restricted blocking check keeps counting in B until
an authorised owner is named (the existing rule).

At approval, `approveSnapshot` copies `flag_role_set` into `snapshot_claims`.

**Known and accepted residue** (written into the results page, not hidden):

- A claim labelled "Corroborated" can owe that label to an agreeing claim the role cannot see. The
  value is one the role already sees, so nothing new is revealed beyond "another source agrees".
- The Test page shows "Restricted" per check and responsibility. That a named check has evidence
  the role cannot open was already shown in Round 2 and is needed for the continuation plan.

---

## 11. Policy for the collaboration graph and recovery questions (with improvement 1)

Rules this spec sets:

1. **The graph is built per viewer.** Edges and scores shown to a role are computed only from
   segment metadata that role can read (the read happens inside `withRole`). An edge that exists
   only because of segments the viewer cannot see does not exist for that viewer.
2. **Sensitive segments never count, for anyone.** Segments with a non-empty `sensitivity` are left
   out of the graph even for the approver. A medical excuse or a complaint thread must not make
   someone "the closest person" to a topic, and its reply pattern is itself private.
3. **"Why picked" lines** ("replied in 14 threads about the sponsor") use counts from the viewer's
   own graph. If the viewer's graph has no interactions for that pick, the line is `Picked from
   records your role cannot open.` with no count and no topic beyond the gap's own name.
4. **Neighbour questions** are built only from claims the neighbour's role can see, read under that
   role, so flag visibility applies with no extra code. A neighbour whose role cannot see the
   topic's claims is `skipped: no access` (the plan's wording). Case C is the test: Arjun is never
   asked about, or shown, the complaint.
5. **Neighbour answers** become segments whose role set is the asked role set (the intersection of
   the role sets of the claims quoted in the question, cut by anything the neighbour chooses), then
   pass through `narrowForSensitivity` before the insert.
6. **Traces**: a trace step is visible to a role only if the file or commit segment it cites is. A
   trace-derived claim takes the intersection of its cited segments' role sets (the existing rule).
7. **Ranked options**: an option's role set is the intersection of its evidence claims' role sets.
   A role sees only the options in its set. The number of hidden options is not shown per gap.

Interface this spec needs from improvement 1:

```ts
// src/lib/tether/graph.ts
export interface GraphSegmentMeta { id: string; authorId: string | null; thread: string; ts: string;
  replyTo: string | null; paths: string[]; roleSet: RoleKey[]; sensitivity: string[] }
export function buildGraph(metas: readonly GraphSegmentMeta[]): Graph;          // pure, skips sensitivity.length > 0
export async function graphFor(ws: string, role: RoleKey): Promise<Graph>;       // reads metas inside withRole(ws, role)

// src/lib/lacuna/recovery.ts
export async function recoverySurfaces(ws: string, role: RoleKey): Promise<Surface[]>;
//   surface names: "graph", "neighbour_questions", "traces", "ranked_options"
//   returns exactly the strings the Ask page renders for that role
```

Plus: `recovery_steps` carries a `role_set text[]` column with the standard `us_reader_select`
policy, so its rows are read under `withRole` like claims.

What this spec gives improvement 1: `narrowForSensitivity`, the `sensitivity` column to filter on,
`us_can_see`, and the `Surface` type from `src/lib/relay/core/canary.ts`.

For improvement 3: findings call `narrowForSensitivity` before the insert, and may export
`firstWeeksSurfaces(ws, role)` in the same shape to add a "First weeks" column later.

---

## 12. How `count_withheld` and stubs change

- **Stub text**: unchanged in form. "N restricted items. Ask the approver (Club President)." It
  still shows no topic, compartment, owning role or value, and it never says why an item is
  restricted (source, sensitivity or conflict all look the same).
- **What N counts**: `count_withheld(ws, role, section)` counts snapshot claims for which
  `us_can_see(role, role_set, flag_role_set)` is false. Two new kinds of item therefore enter the
  count with no change in the callers:
  1. claims derived from limited segments (their role set is narrower by intersection);
  2. claims hidden by flag visibility (section 10).
- **Section counts** keep using `SECTION_ATTRIBUTES` in `relay/handover.ts`.
- **New count**: `count_limited(ws, role)` for the Connect line in 4.1.
- **Expected movement on the demo** (to confirm after the precompute): `new_member` and
  `tech_lead` gain withheld items for cases A to D; `treasurer` gains items for cases A and C;
  `leaver` gains items for cases A and C; `president` stays at 0.
- **Read-back**: an item whose answering claim is hidden by a flag is "not_visible", as today for
  role-set hiding, because `visibleSnapshotClaimIds` reads under RLS.

---

## 13. Evaluation numbers to report

All produced by `scripts/probe-eval.ts`, written to `docs/PROBE_RESULTS.md`, shown on the page.
Targets are what we aim for; the report states the measured value either way.

| Number | How measured | Target |
|---|---|---|
| Primary cases caught by rules alone | cases A, B, C with the model off | 3 of 3 (hard gate, also a test) |
| Classifier recall, rules only | planted positives in `evalSegments` | report |
| Classifier recall, rules plus model | same | at least 90% |
| Classifier precision, rules plus model | flagged that are truly sensitive | at least 80% |
| Per category precision and recall | finance, HR, health | report |
| Decoys wrongly limited | of the 22 negatives | at most 2 |
| Held (model unavailable) | count in a model-off run | report |
| Misses by difficulty | rule, model, hard | 0 for `rule`; report the rest, with the wording |
| Model calls with a limited segment in a wider batch | audit over a full pipeline run | 0 (hard gate) |
| Leak grid, exact tokens | roles x surfaces passed | all pass |
| Leak grid, reworded facts | same, confirmed leaks | 0 |
| Texts checked | total strings scanned | report |
| Detector check | rewordings caught by key terms, by the judge only, by neither | key terms at least 70%; both at least 90% |
| Unconfirmed judge findings | judge said yes, quote not in text | report |
| Withheld counts per role | before and after the plants | report |
| Scores | B, C, K for successor and new member, before and after | B unchanged except where the answer key says so |
| Cost | classifier calls, cached share, time added to ingest | under 2 s cached, under 20 s live |

---

## 14. Tests and what each proves

`pnpm test` runs with `MODEL_DISABLED=1`; tests that need model answers inject a fake call.

**Rule stage (`tests/tether/sensitivity.test.ts`, pure)**

| # | Test | Proves |
|---|---|---|
| T1 | Each strong rule (F1 to F3, H1, H2, M1) fires on a minimal sentence and names its rule id | the rules exist and are separately reachable |
| T2 | Every decoy in section 3 is `clear` or `borderline`, never `sensitive` | false positives are bounded by design |
| T3 | Ignore-list idioms do not fire ("sick of", "is a headache", "first aid kit") | idioms are handled |
| T4 | Follow-up: a `replyTo` child inherits; a WhatsApp follow-up within the window with a cue is borderline; one outside the window is clear | the propagation rule |
| T5 | `narrowRoleSet` output is always a subset of the input, for every category mix and an empty intersection | narrowing never adds a role |
| T6 | Cases A, B and C (the facts, rewritten as fixtures) are `sensitive` with the model off | done-when 1 |

**Ingest (`tests/tether/sensitivity-ingest.test.ts`, database)**

| # | Test | Proves |
|---|---|---|
| T7 | Full pipeline over a fixture with a sensitive message in an open chat, every model call recorded through an injected spy: no call whose role set includes a non-allowed role contains the segment's id or text; every call's segments share one role set | done-when 2 |
| T8 | The first stored version already has the narrowed `role_set`, with `role_set_original` equal to the source role set | narrowing happens before storage |
| T9 | Model stage: fake says a category, the segment is narrowed; fake says `none`, it is stored with the source role set; fake fails or times out, it is held | model stage and fail closed |
| T10 | The model stage is never sent a strong-rule segment, and a response naming an id outside the batch is ignored | the model cannot clear or touch what it was not asked about |
| T11 | Re-ingest of the same files changes nothing and keeps an approver's widening | re-ingest behaviour |
| T12 | `reclassify` after a version bump narrows a newly flagged segment as version 2 and never widens one | version behaviour |

**Visibility (`tests/db/visibility.test.ts`, database)**

| # | Test | Proves |
|---|---|---|
| T13 | Widen as the leaver, the successor, the treasurer: refused. As the approver with a 5-character reason: refused. Beyond the source roles: refused | done-when 4 |
| T14 | A valid widen writes version 2, an `audit_log` row with the reason, and starts a run | logging and versioning |
| T15 | Widen then limit again: a role that could read version 2 cannot read the segment at all under `withRole` (head-version policy) | old versions do not leak |
| T16 | Limit: claims and `snapshot_claims` citing the segment are narrowed in the same transaction; a compile for the excluded role right after shows a stub, with no re-run needed | limiting takes effect at once |
| T17 | `count_limited` returns the right integer per role and nothing else | count-only disclosure |

**Flags (`tests/attest/flags.test.ts` pure, plus one database test)**

| # | Test | Proves |
|---|---|---|
| T18 | Two-sided conflict with equal role sets: flag is null, both roles see the flag line | no over-hiding |
| T19 | One hidden side (case D shape): the role that sees one side gets no claim row, no conflict line, no "disputed" text, coverage Restricted, and a stub count up by one | the plan's "never reveals the hidden value", and never reveals that a conflict exists |
| T20 | Superseded claim whose winner is hidden: hidden from that role | "Superseded" notes do not point at hidden values |
| T21 | `count_withheld`, the reader policy and `claim_meta` agree for every claim in the fixture | the three uses of `us_can_see` cannot drift |
| T22 | Approver rejects one side in Review; after verify the other side is visible again | the fix path works |

**Probes and the wider leak check (`tests/relay/probes.test.ts`, `tests/relay/leak-wide.test.ts`)**

| # | Test | Proves |
|---|---|---|
| T23 | `normaliseForProbe`: amounts, dates and simple inflections reduce to the same form | the key-term check sees through formatting |
| T24 | Detector check with key terms only: every rewording marked catchable in `probes.json` is found when injected | the probe can catch what it claims to |
| T25 | Judge merge: a fake judge answering "nothing revealed" does not remove a key-term finding; a judge finding with a quote not in the text is `unconfirmed` and does not fail the cell | the judge can only add findings |
| T26 | Demo workspace, five roles, all fourteen surfaces, both rows: zero leaks; "Not built" columns are excluded, not counted as pass | done-when 3, and the plan's "probe suite runs for five roles across every surface and is part of `pnpm test`" |
| T27 | Mutation check: widen case A to everyone in a scratch workspace, re-run, and the grid goes red in both rows for `new_member` | the grid is able to fail |
| T28 | Export guard: an export that would contain a reworded restricted fact is refused | exports are covered by the same check |
| T29 | With improvement 1 merged: Arjun as a neighbour is `skipped: no access` for anything touching case C, and the graph for `new_member` has no edge that exists only through limited segments | graph and neighbour rules |

End to end (`tests/e2e/judge-path.spec.ts`, one added step): as the approver open Connect, see
three rows in "Sensitive content", widen the lab deposit decoy with a reason, see "Widened"; switch
to New member and see the count line only; open Handover and see "All checks pass" in both blocks.

---

## 15. Edge cases

**False positives that hide useful content.** This is the main cost of the feature, so the path
must be obvious:

- How the approver sees them: every limited segment is listed in the panel with its text, category
  and reason. The Sources table shows `{n} limited` per source. A limited segment's claims are tier
  C in Review, so the approver opens the evidence anyway before approving.
- How the approver fixes one: `Widen`, choose "Everyone who can see {source}", write the reason.
  The pipeline re-runs; the claim returns to the wider roles; the handover picks it up at the next
  snapshot.
- How we keep them few: a single weak term never limits; idiom list; borderline goes to the model,
  which is told to answer "none" for routine business; the pack can add or drop terms per setting.
- How we count them: "Wrongly limited" in section 13.
- A coverage drop is visible, not silent: a check that loses its only evidence for the successor
  becomes "Restricted", and a restricted blocking check counts in B until an owner is named.

**Misses (false negatives).** The approver uses `Limit who sees this` on the source segment page.
It applies at once (section 8). The results page lists known misses by wording.

**Other cases**

| Case | Behaviour |
|---|---|
| Model down during upload | borderline segments are held; the panel shows the held notice; nothing waits on the model |
| Upload near the 60 s page limit | the classifier budget is 20 s; past it, the rest are held |
| A message with two categories | both chips; role set is the intersection of both lists |
| A sensitive message in an already restricted source | role set = source roles ∩ category roles; if empty, unchanged and noted `Already limited. Not changed.` |
| A long note split by heading | each heading is its own segment; only the sensitive ones are limited |
| A task card with a sensitive description | the card is limited; its deterministic claims take the narrow role set; the responsibility title still shows, as it comes from the pack entity label |
| The leaver's own answer is sensitive | narrowed by `narrowForSensitivity`; the leaver keeps it only if the category allows the leaver role; the Ask page then says `Saved. This answer is limited to fewer roles because it mentions {category label}.` |
| The approver widens, then the lexicon changes | the decision stands; reclassify skips `widened` and `manual` rows |
| A quote of a limited message inside an open message ("as Dev said, surgery on the 17th") | it is its own segment and is classified on its own text; rule M1 fires |
| Contact tokens inside a limited segment | unchanged: the token is only in the segment text, which is now limited |
| Rejected rows of a source | not classified; Connect shows only the line number and reason, never the raw row |
| A snapshot approved before a limit | its per-role projection is narrowed at once; its hash still verifies; the banner asks for a new snapshot |
| Uploader narrows a source on a second upload of the same files | not handled today (existing rows are kept); out of scope, noted for the foundation owner |
| Non-English or code-mixed text beyond the lexicon | likely miss at the rule stage; the model stage may catch it; reported under "Missed" |
| Workspaces made before the migration | columns default to "not sensitive"; the next pipeline run calls `reclassify` |

---

## 16. Task breakdown in build order (one builder, 12 hours)

| # | Task | Output | Hours |
|---|---|---|---|
| 1 | Migration; `Segment` fields; mappers; pack schema and `club.json` key | schema in place, all existing tests green | 1.0 |
| 2 | Lexicon file and `classifyByRules`, `narrowRoleSet`, `narrowForSensitivity`; tests T1 to T6 | rule stage done, pure | 2.0 |
| 3 | Model stage, `applySensitivity`, hook in `ingestSources`, held logic; tests T7 to T10 | sensitive content limited before storage | 1.5 |
| 4 | Demo plants (cases A to D, decoys), `ground_truth.json` entries, `probes.json` (with Aman) | data in place | 1.0 |
| 5 | `visibility.ts` (widen, list, count), Connect panel and actions; tests T13 to T15, T17 | judge-visible flow on Connect | 1.5 |
| 6 | `flags.ts`, the write in `verify()`, policies, `count_withheld`, `claim_meta`, snapshot copy; tests T18 to T22 | conflict flag policy | 1.5 |
| 7 | Surface registry, new providers, grid with two blocks; test T26 for tokens | wider leak grid | 1.0 |
| 8 | `core/probes.ts`, judge, `probe_runs`, `runProbes`, script, `/probes` page, `docs/PROBE_RESULTS.md`; tests T23 to T25, T27, T28 | probes and write-up | 2.0 |
| 9 | Precompute the new cache entries, e2e step, architecture doc section, buffer | demo replays from the cache | 0.5 |
| | **Total** | | **12.0** |

Order rationale: tasks 1 to 3 close the direct and derived paths and are the minimum that can be
demoed. Task 6 is independent of 4 and 5 and can swap with them if data is late.

Cut order if time runs short (drop from the top, say so in the submission):

1. Manual `Limit who sees this` (keep widen only). Saves about 0.5 h. Misses are then reported, not
   fixable in the app.
2. The in-app `Run probes again` button (the script still produces the results). Saves 0.5 h.
3. Follow-up rule R2 (keep R1). Saves 0.5 h; Kabir's "get well soon" reply stays open and is
   reported as a miss.
4. Flag visibility for superseded claims (keep conflicts). Saves 0.3 h.
5. `reclassify` on version bump. Saves 0.5 h.

Not cuttable: tasks 1 to 3, the widen gate, conflict flags, the grid with the key-term probe row,
and the written results.

---

## 17. Builder brief (paste as is)

> **You are building Round 3 improvement 2 of Understudy: content-level confidentiality.**
> Spec: `round3/specs/02_confidentiality.md`. Contract: `docs/ARCHITECTURE.md`. Work in your own
> worktree off main after the hour 0 to 4 foundation commit (role keys moved into the pack, CI,
> migrations numbered). Tests first for pure logic, then pages.
>
> **Outcome.** A message with finance, HR or health content in an open channel is limited to the
> roles the pack allows before it is stored or read by any model. Only the approver can widen it,
> with a written reason, logged. Conflict flags never reveal a hidden side. The Leak check grid
> covers fourteen surfaces with exact tokens and reworded-fact probes, and the results are written
> up in the app and in `docs/PROBE_RESULTS.md`.
>
> **Your lane (create or own these files):**
> - `src/lib/tether/sensitivity.ts`, `src/lib/tether/sensitivity-lexicon.ts`, `src/lib/tether/visibility.ts`
> - `src/lib/attest/core/flags.ts`
> - `src/lib/relay/surfaces.ts`, `src/lib/relay/core/probes.ts`, `src/lib/relay/probes.ts`
> - `src/app/w/[id]/connect/SensitivePanel.tsx`, `src/app/w/[id]/connect/actions.ts`
> - `src/app/w/[id]/handover/LeakGrid.tsx` (the Leak check panel moves out of `page.tsx`)
> - `src/app/w/[id]/probes/page.tsx`
> - `db/migrations/0007_confidentiality.sql` (confirm the number with the foundation owner)
> - `scripts/probe-eval.ts`, `docs/PROBE_RESULTS.md`
> - `data/demo/probes.json`, `data/demo/probe_summary.json`
> - tests: `tests/tether/sensitivity*.test.ts`, `tests/db/visibility.test.ts`,
>   `tests/attest/flags.test.ts`, `tests/relay/probes.test.ts`, `tests/relay/leak-wide.test.ts`
>
> **Small edits in files you do not own (additive only, keep each to a few lines, tell the owner):**
> - `src/lib/types.ts`: optional sensitivity fields on `Segment`, two new types.
> - `src/lib/db/mappers.ts`: the new segment columns in `segmentRow` and `toSegment`.
> - `src/lib/pack/schema.ts` and `packs/club.json`: the `sensitivity` key. Do this after improvement
>   3's role-key refactor has merged; use the pack's role key type, no role literals anywhere.
> - `src/lib/pipeline/ingest.ts`: one call to `applySensitivity` between `ingestAll` and
>   `storeResult`, plus one audit row.
> - `src/lib/pipeline/run.ts`: call `reclassify(ws)` in the `connect` step.
> - `src/lib/attest/index.ts`: after `applyRules` in `verify()`, write `flag_role_set`.
> - `src/lib/relay/index.ts`: copy `flag_role_set` into `snapshot_claims` in `approveSnapshot`.
> - `src/lib/relay/handover.ts`: `runLeakCheck` loops over the surface registry; the export guard
>   adds the key-term probe check.
> - `src/app/w/[id]/connect/page.tsx` and `handover/page.tsx`: mount the two new components.
> - `src/app/w/[id]/source/[segmentId]`: the approver's `Limit who sees this` form.
> - `data/demo/whatsapp`, `data/demo/slack/events`, `data/demo/ground_truth.json`: the planted
>   cases, with the data builder.
>
> **Stay out of these lanes.**
> - Improvement 1: `src/lib/tether/graph.ts`, `src/lib/tether/traces.ts`,
>   `src/lib/lacuna/recovery.ts`, the Ask page, `recovery_steps`. You consume
>   `recoverySurfaces(ws, role)` and `graphFor(ws, role)` when they exist; import them defensively
>   so your branch builds without them and the grid says "Not built".
> - Improvement 3: findings, First weeks, snapshot v2 and its diff panel, the pack refactor of role
>   keys, `packs/lab.json`, `data/lab/`. Ask them to add a `sensitivity` key to the lab pack and to
>   call `narrowForSensitivity` before inserting a finding segment.
> - `src/lib/lacuna/index.ts`: ask its owner to call `narrowForSensitivity` in `answerQuestion`
>   before the segment insert. Do not edit it yourself.
>
> **Rules you must not break.**
> 1. Narrowing happens before the first write of `role_set`. No automatic code path ever adds a
>    role. The only widening is the approver action.
> 2. Segments are immutable. A visibility change is a new version row. Readers see the head version
>    only.
> 3. The model sets no roles: the classifier model returns an enum per segment id, the judge can
>    only add findings, and both are validated by zod.
> 4. Stubs and counts stay count-only: no topic, category, author or reason.
> 5. Fail closed: when the model cannot be asked, borderline segments are held, not released.
> 6. Every approver action writes `audit_log`.
> 7. UI copy is the wording in section 4, word for word. No em dashes. Every status has a symbol
>    and a word.
>
> **Done when.** The five points in section 1 hold, tests T1 to T28 pass in `pnpm test`, the judge
> path end-to-end test passes with the added step, and `docs/PROBE_RESULTS.md` is generated from a
> real run with the measured numbers, including the misses.
>
> **Report back with:** files changed outside your lane, the measured numbers of section 13, what
> you cut from section 16 and why, and any place the spec was wrong.

---

## 18. Points where this spec differs from, or adds to, the plan

1. **"Bumps the segment version" needs a reader-policy change.** Segments are immutable, so a
   change is a new version row, and without a head-version rule in RLS an older, wider version
   stays readable after a segment is limited again. The plan does not mention this. Section 7.
2. **Borderline segments fail closed (held).** The plan says the model stage "can only narrow".
   This spec keeps that, and adds that a borderline segment the model could not be asked about is
   limited until the approver decides. Otherwise a model outage would quietly publish it.
3. **The model stage runs inside ingest, with a 20 second budget.** That is the only way it can
   act "before storage of the role set". It adds a cached call to demo workspace creation and to
   uploads.
4. **Conflict flags are enforced in RLS, and the visible side is withheld too.** The plan says the
   flag "becomes a stub". Showing the visible claim without its flag would mislead the successor,
   so the role sees a stub and coverage "Restricted" until the approver settles the conflict. The
   same rule is applied to "Superseded" notes, which the plan does not list.
5. **Hard rewordings live in an evaluation set, not in the live demo sources.** The plan puts
   probes in `data/demo/probes.json` and asks for a write-up of what was missed. Planting
   uncatchable rewordings in the live demo would make the demo itself leak, so misses are measured
   in a scratch workspace by a script and reported.
6. **The model judge cannot run in `pnpm test`** (tests run with the model off). The key-term check
   and the judge's merge logic are tested there; the real judge runs from the script and the
   approver's button.
7. **Four grid columns depend on improvement 1.** Until it exports `recoverySurfaces`, they show
   "Not built" and are left out of the pass count.
8. **More shared-file edits than the plan's file list suggests**: `types.ts`, `mappers.ts`, pack
   schema, `pipeline/ingest.ts`, `pipeline/run.ts`, `attest/index.ts`, `relay/index.ts`,
   `relay/handover.ts`, and a replaced `claim_meta()` from migration 0004. All additive.
9. **Order against improvement 3.** The pack key and any role typing must land after the role-key
   refactor planned for hours 0 to 4, or the two will collide in `pack/schema.ts` and
   `packs/club.json`. The tier C rule currently names `new_member` in two files; this spec adds a
   sensitivity condition beside it and leaves the literal for improvement 3 to move.
10. **A manual "Limit who sees this" action is added** (not in the plan) as the fix for a miss. It
    is first on the cut list.
11. **Scope against 12 hours.** The plan's list fits only with the cut order in section 16 ready.
