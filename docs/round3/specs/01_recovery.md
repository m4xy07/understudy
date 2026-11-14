# Spec 01: Unreachable-leaver recovery

Round 3, improvement 1 of Understudy (team DRACONIX). Planning document only. Nothing in
this file is product code, a migration, a test or a dataset. It was written against main at
`05473dd` and the agreed plan in `round3/ROUND3_PLAN.md`.

Lead: Aman, with Advait and Om. Sized for one builder, about 11.5 hours, plus listed stretch items.

Contents

1. Goal and the "done when" test
2. Decisions this spec makes (read first)
3. What a judge sees, screen by screen, with exact copy
4. Collaboration graph
5. Trace reader
6. Ranked options
7. Scoring rules for B, C and K
8. Database changes
9. Module layout and signatures
10. Demo pack: which gap reaches which rung, and facts to plant
11. Model calls and caching
12. Tests
13. Edge cases and failure behaviour
14. Task breakdown
15. Builder brief (ready to paste)
16. Conflicts with the plan and open questions

---

## 1. Goal and the "done when" test

Today the Ask step assumes Priya answers. If she has already left, every gap question dies.
Recovery gives the approver a second path that uses only what the organisation still has:
the people who worked next to her, the artefacts she left, and the record's own hints. Each
result carries a trust label weaker than "Leaver said", and nothing weaker than a leaver
answer can close a gap.

**Done when** (from the plan): with "leaver unreachable" switched on, the same gaps reach a
knowledge neighbour and a trace, fewer close than when the leaver answers, and every result
shows its weaker trust label.

Made testable:

| # | Check | Proven by |
|---|---|---|
| D1 | Only the approver can switch recovery on or off, and both are in `audit_log` | DB test T-DB-1 |
| D2 | With the switch on, every open gap question has rung 1, 2 and 3 outcomes stored in `recovery_steps` | DB test T-DB-2 |
| D3 | A neighbour whose role cannot see the topic is skipped, gets no question, and cannot read the skipped row | DB test T-DB-3, e2e step 6 |
| D4 | A neighbour answer is stored as a claim with trust `second_hand`; a trace as a claim with trust `inferred`; options are not claims at all | DB test T-DB-4 |
| D5 | Second-hand and Inferred evidence make a check Partial at most, so B does not fall and K does not rise | unit T-U-12, T-U-13 |
| D6 | Ranked options never change coverage, B, C or K and never mark a question answered | unit T-U-14, DB test T-DB-5 |
| D7 | The before and after panel shows fewer gaps closed without the leaver than with her | unit T-U-15, e2e step 8 |
| D8 | The graph is built without message text | unit T-U-1 |
| D9 | Switching off restores the normal Ask flow and keeps the labelled evidence | DB test T-DB-6 |

"Closed" means the check's coverage is `covered` in the successor's latest test run.

---

## 2. Decisions this spec makes (read first)

These are the points where the plan is silent or pulls two ways. Section 16 lists them again
as conflicts for the team.

1. **Traces are always labelled Inferred.** Attest still checks every step's quote against
   the cited file or commit, and the UI marks each step "Quoted" or "Worked out from
   history". A fully quoted trace does not become "From record" on its own. It can still
   become "Corroborated" through the existing rule in `corroborate()` when an independent
   record states the same value.
2. **Ranked options are not claims.** They live only in `recovery_steps`. The stand-in
   successor never sees them, so they cannot earn credit by accident. A defensive filter in
   the stand-in also ignores any claim with trust `ranked_options`.
3. **A neighbour answer does not mark the gap question answered.** `gap_questions.answered_claim_id`
   stays null, so Priya can still be asked if she comes back.
4. **People are asked through roles.** The app has no accounts; identity is the role cookie.
   A new table `role_holders` says which people hold which role. A person with no role in
   the workspace cannot be asked inside Understudy and is shown as such.
5. **"No access" has one definition.** A role is walled off from a gap when any live claim
   that could satisfy that check is hidden from that role. Such a neighbour is skipped, and
   the skipped row is itself hidden from that role by RLS.
6. **Restricted gaps do not enter the ladder.** They are access gaps, not knowledge gaps,
   and stay with the approver as today (`rankGaps` already leaves them out).
7. **K cannot rank Second-hand below Leaver said**, because both are "not a record". The
   panel therefore shows closed counts, B, C, K and an evidence mix by trust label.
8. **Recovery claims never take part in supersession.** A neighbour's word or a rebuilt
   procedure must not knock a record claim into "Conflicting".

---

## 3. What a judge sees

All copy below is final. `{leaver}` is `leaverName(pack)` ("Priya"), `{approver}` is
`roleLabel(pack.approverRole)` ("Club President"). No copy names a role or a person as a
literal in code; every name comes from the pack or the `people` table.

### 3.1 Ask page, switch off (today's page plus one card)

A card above "Open questions", shown to the approver only:

- Eyebrow: `If {leaver} has already left`
- Title: `Can {leaver} answer?`
- Body: `If {leaver} cannot be reached, Understudy asks the people who worked closest with her, reads the workflow files and history for procedures, and lists possible answers for what is left. All of it is weaker evidence than her own answer and is labelled that way.`
- Field label: `Why (optional, goes in the audit log)`
- Button: `{leaver} can't be reached`
- Pending text: `Starting recovery…`

The body uses "her" only because the demo pack does; the builder writes the sentence
without a pronoun: `...asks the people who worked closest with {leaver}, reads...`.

Other roles see nothing new while the switch is off.

Server message after switching on:
`Recovery is on. {n} gaps are being worked without {leaver}. This is in the audit log.`

Errors:
- Not the approver: `Only {approver} can change this.`
- No gap questions yet: `Run the successor test first. There are no gaps to work on yet.`

### 3.2 Ask page, switch on: banner

Shown to every role, at the top:

- Title: `{leaver} can't be reached`
- Line: `Switched on by {approver} on {date}, {time}.` plus the reason if one was given.
- Approver sees a button: `{leaver} is back. Use the normal flow`
- Other roles see: `Only {approver} can change this.`
- The leaver role sees instead: `You are marked as unreachable, so your answer boxes are closed. Only {approver} can change this.`

Server message after switching off:
`Recovery is off. {leaver} can answer again. Second-hand answers and rebuilt procedures stay, with their labels.`

The page header text changes while recovery is on:
`Gaps {leaver} would have answered. Each one goes down three rungs: people, files, then possible answers. Nothing here counts as much as her own word.`
(builder writes it without the pronoun: `...as much as {leaver}'s own word.`)

### 3.3 Before and after panel

Directly under the banner. Region label `With and without the leaver`.

- Title: `With {leaver} and without`
- A two column table.

| Row | Column 1: `If {leaver} answered` | Column 2: `Without {leaver}, so far` |
|---|---|---|
| `Gaps worked` | n | n |
| `Closed` | up to n | m |
| `Partly answered` | 0 | p |
| `Still open` | 0 | n minus m minus p |
| `B` | projected | latest |
| `C` | projected | latest |
| `K` | projected | latest |
| `Rests on` | evidence mix | evidence mix |

- Under column 1: `Worked out by the scoring rules, no model. Each answer would be labelled Leaver said.`
- Under column 2: `From the latest successor test.`
- "Rests on" is one line per column, for example
  `From record 78% · Second-hand 14% · Inferred 8%`. Every label has its symbol chip, never colour alone.
- Footer, fixed text:
  `Second-hand answers and rebuilt procedures raise C a little. They never close a blocking gap and never raise K. K is the share of what is covered that a record backs, so it falls in both columns: neither {leaver}'s word nor a colleague's is a record. The difference is in what closes.`

Column 1 is a projection (section 7.4). If the workspace already holds real leaver answers
from before the switch, they are part of the baseline, so both columns start from the same run.

### 3.4 "Questions for you" (shown to a role that has asked steps)

Appears above the ladder when the viewing role is the target of at least one step with
status `asked`.

- Title: `Questions for you ({n})`
- Intro: `{leaver} can't be reached, and the record shows you worked on these with her. Say what you know. Your answer is labelled Second-hand: it helps, but it does not count as a record.`
  (without the pronoun: `...you worked on these together.`)
- When a role has more than one holder with asked steps: a select `Answering as` listing those people.

Per question card:

- The question text (built for that role, section 4.6).
- One muted line: `Why you: {reason}` for example `Why you: you replied in 3 threads about Firmware deploy to the robot.`
- Label: `What you know`
- Helper: `Say only what you know yourself. If you are guessing, say so.`
- Fieldset legend: `Who can see this answer`
- Fieldset note: `It starts with the roles that can already see the records on this topic. You can narrow it, never widen it. You and {approver} always keep it.`
- Buttons: `Save answer` and `I don't know`
- Demo workspaces only, when a sample exists: a text button `Use a sample answer` that fills the box.

Messages:
- Saved: `Saved as "Second-hand". Re-test: {delta}` where `{delta}` is `scoreDelta()` output, for example `B 7 (no change) · C 61% → 63% · K 91% → 88%`.
- Declined: `Noted. Nothing was saved as evidence.`
- Wrong role: `Only the person who was asked can answer this.`
- Already answered: `You already answered this.`
- Recovery off: `Recovery is off. {leaver} answers these now.`
- Too short or too long: the existing strings `Write an answer first.` and `Keep the answer under 4000 characters.`

### 3.5 The ladder, one card per gap

Heading: `Gaps being worked ({n})`. Each card keeps today's question line, the gap chips
(Missing, Partial, Conflicting, Blocking, Due soon) and the "Why asked" line, then adds a
state chip and three rungs.

State chip (symbol and word): `● Closed`, `◐ Partly answered`, `○ Still open`.

**Rung 1.** Heading: `1. People who worked on this`
Sub line: `Picked from who replied to whom, who changed the same files and who shared calendar events. No message text was read to pick them.`

Row forms (each is one `recovery_steps` row, shown only if RLS lets the viewer read it; rows carry no position number):

| Status | Text |
|---|---|
| `asked` | `{name} ({role label}). {reason}. Asked. Waiting for an answer.` plus button `Switch to {first name} to answer` |
| `answered` | `{name} answered.` chip `Second-hand`, the statement, link `See claim` |
| `declined` | `{name} could not answer.` |
| `skipped_no_access` | `{name} ({role label}). Skipped: no access. This role cannot see the topic, so this person was not asked and was shown nothing.` |
| `skipped_no_seat` | `{name}. Not asked: no role in this handover. Ask outside Understudy and record what you learn.` |

Reason sentence is built from counts only (section 4.5), for example
`Replied in 3 threads and changed 1 of the same files for Firmware deploy to the robot`.

Empty states:
- No candidate at all: `Nobody else worked on this closely enough to ask.`
- Candidates exist but none is readable by this role: `Nothing here for your role.`

**Rung 2.** Heading: `2. What the files and history show`

- Trace present: chip `Inferred`, title `Rebuilt from {source label}` (for example
  `Rebuilt from .github/workflows/deploy.yml`, `Rebuilt from 8 commits to website/`,
  `Rebuilt from the Club calendar`), then a numbered list. Each step ends with a mark
  `Quoted` or `Worked out from history` and a link `Open source` to
  `/w/{id}/source/{segmentId}?claim={claimId}&cite={i}` (the existing source page).
- Footer under a trace: `{q} of {t} steps are quoted word for word. The order, and what was left out, is our reading, so the whole procedure is labelled Inferred.`
- Check asks who (WHO checks): `Files and history cannot say who. Skipped.`
- Nothing found: `No workflow file, commit history or calendar entry covers this.`
- Found but it does not answer this check: `Related history exists, but it does not answer this. See "Rebuilt procedures" below.`

**Rung 3.** Heading: `3. Possible answers`
Sub line: `Leads, not answers. They never close a gap.`

- Option row: chip `Ranked options`, then `Option {k}. {value}` and under it one evidence
  line per source: `{who} wrote this on {date} in {source name}. "{quote}"` with `Open source`.
- When an option came from the model: a muted mark `Suggested from the cited records`.
- Conflicting deadline gaps add: `If you must act before this is settled, plan for the earlier date.`
- One candidate only: the row reads `Lead. {value}` with the same chip.
- None: `Nothing on record points to an answer. This gap needs an owner in the continuation plan.`
- Gap closed: `Not needed. This gap is closed.`
- Model unavailable: `Model unavailable: these options come from the rules only.`

### 3.6 "Rebuilt procedures" list

At the bottom of the page while recovery is on. Lists every trace claim the viewing role
may see, whether or not an open gap needs it.

- Title: `Rebuilt procedures ({n})`
- Intro: `Procedures read back from workflow files, commit history and calendar entries. All are labelled Inferred until a person confirms them in Review.`
- Per item: title, chip `Inferred`, steps as in rung 2, and either `Helps with: {R key} {check label}` or `No open gap needs this. Kept for the handover.`

### 3.7 Judge path (about two minutes)

1. Open the demo, go to Ask as Club President. Press `Priya can't be reached`.
2. Read the panel and the ladder. One gap shows `Ananya Iyer (Treasurer). Skipped: no access.`
3. On "Firmware deploy" press `Switch to Arjun to answer`.
4. In "Questions for you" press `Use a sample answer`, then `Save answer`. Read the re-test line.
5. On another question press `I don't know`.
6. Switch "Viewing as" to Treasurer. The skipped row is not there, and there is no question for her about that gap.
7. Switch back to Club President. The panel shows `Closed 0`, `Partly answered` up by one, B unchanged.
8. Press `Priya is back. Use the normal flow`. Today's page returns; the Second-hand claim is still on the Claims page with its label.

---

## 4. Collaboration graph (`src/lib/tether/graph.ts`, pure)

### 4.1 Inputs: metadata only

The graph functions take `GraphSegment`, a type that has no `text` field:

```
GraphSegment = {
  id, sourceKind, kind, ts, authorId, thread, roleSet,
  meta: { replyTo?, files?, attendeeIds?, organizerId?, ownerId?, recurring? }
}
```

- `toGraphSegment(segment)` copies exactly those fields. Every other meta key (summary,
  section, questionText, title, description, location) is dropped.
- The database read in `recovery.ts` selects `id, source_kind, kind, ts, author_id, thread,
  role_set, meta` and never the `text` column.
- Which segments are "about" an entity is not decided by the graph. It is passed in as
  sets of segment ids, built from Attest's accepted claim citations (section 4.3). Honest
  wording for the write-up: the graph reads no text; the entity index reuses what Attest
  already extracted.

### 4.2 Nodes and edges

Nodes are people. People who hold a role are merged into one node per person through
`role_holders` (one human can have a WhatsApp record and a Slack record). People without a
role stay as separate records; this is not an identity merge, so the contract rule "merge
only on exact email" holds.

Edges are undirected and typed. Each edge instance has a base weight and a recency factor.

| Type | When one instance is created | Base |
|---|---|---|
| `reply` | a segment has `meta.replyTo` and its author differs from the parent's author | 3 |
| `same_thread` | two consecutive `message` segments in one thread, different authors, at most 30 minutes apart, not already a reply pair | 1 |
| `co_change` | two different authors each have a `commit` segment touching the same path inside the footprint window (`pack.footprint.windowMonths`) ; one instance per author pair per path | 2 |
| `shared_event` | organiser and each attendee of an `event` segment, pairwise | 2 if `meta.recurring`, else 1 |

Recency: `r(ts) = max(0.1, 0.5 ^ (ageDays / 90))`, age measured from `workspaceNow(ws)`.
Edge weight = sum of `base × r` over its instances. Each edge keeps up to 50 contributing
segment ids so a role set can be computed for anything derived from it.

### 4.3 Entity segment index

`entitySegmentIndex(claims)` returns `Map<entityKey, Set<segmentId>>` from every claim whose
state is not `dropped`: the segment ids of its accepted citations. One hop is added: a
segment that replies to an indexed segment joins the same set. No text is read.

### 4.4 Neighbour score per gap

For a gap on responsibility `resp`, let `S` be the union of the index sets of `resp.entities`.
For each person node `P` that is not the leaver (`leaverPersonIds`):

| Part | Sum over | Each adds |
|---|---|---|
| `wrote` | segments in `S` authored by `P` | 3 × r |
| `replied` | `reply` instances with one end in `S` and the other authored by `P` | 3 × r |
| `near` | `same_thread` instances with one end in `S` and the other authored by `P` | 1 × r |
| `files` | commits by `P` that touch a path also touched by a commit in `S` or equal to `meta.path` of a file segment in `S` | 2 × r |
| `events` | event segments in `S` where `P` is organiser or attendee | 2 × r |
| `tie` | once | min(1, 0.05 × weight of the edge between `P` and the leaver) |

`score = wrote + replied + near + files + events + tie`. Candidates need `score >= 1`.
Ranking is by score, ties by person id. The ladder takes the top 3 people who hold a role
(`MAX_NEIGHBOURS = 3`) and, if a higher scoring person holds no role, the single best such
person as a `skipped_no_seat` row. Rows for people with the same display name and no role
are collapsed to the best scoring one for display.

### 4.5 Reason sentence

`neighbourReason(counts, entityLabel)` builds a sentence from the integer counts behind the
parts, in a fixed order, skipping zero parts:

- `wrote` → `Wrote {n} of the records`
- `replied` → `Replied in {n} threads`
- `near` → `Was in {n} of the same conversations`
- `files` → `Changed {n} of the same files`
- `events` → `Shared {n} calendar events`

Joined with commas and "and", ending `for {entity label}`. The entity label comes from the
pack. No message content, file name or event title appears in a reason.

### 4.6 Role visibility: who is asked, who is skipped, who sees what

All decisions use `claim_meta()` (ids, attributes, states, role sets only) and reads under
`withRole`. None uses row content the target role cannot see.

**Access test.** `accessFor(resp, check, role, meta)` returns `walled` when at least one
claim with state `active` or `conflicting`, entity in `resp.entities` and attribute in
`check.attributes` has a role set that excludes `role`. Otherwise `open`. This is the same
question `hiddenEvidence()` in `core/standin.ts` asks, widened to conflicting claims.

**Routing a candidate.**

| Condition | Row status |
|---|---|
| person holds no role | `skipped_no_seat` |
| role is the leaver role | not a candidate |
| `accessFor` is `walled` for the person's role | `skipped_no_access` |
| otherwise | `asked` |

**Question text for an asked neighbour** is built by `questionText()` from
`visibleClaims(ws, neighbourRole)`, which reads under RLS as that role. The role passed as
`leaverRole` is the neighbour's role, so a conflicting question quotes only values that role may see.

**Row role set** (column `recovery_steps.role_set`, enforced by RLS):

```
neighbour row role set =
    intersection of the role sets of the segments that produced the score
  ∩ { roles for which accessFor(resp, check, role) is open }
```

Consequences, each covered by a test:

- A skipped neighbour's own role is never in the row's role set, so that person cannot read
  the row, the reason or the fact that they were considered.
- A role that cannot see the channel where the collaboration happened does not see the edge
  that came from it. This is the plan's rule for improvement 2 ("graph edges derived from
  restricted segments are hidden from roles that cannot see those segments") applied per row.
- There is no stub count for hidden rows. A viewer with no readable row sees
  `Nothing here for your role.` and cannot tell hidden rows from an empty rung.
- Nothing is sent to anyone. "Asked" only means a question appears when that role opens the page.

**Answer role set.** `defaultAnswerRoleSet(neighbourRole, resp, check, claimsVisibleToNeighbour, pack)` =
`pack.uploadDefaults.roleSet` intersected with the role set of every live claim on
`resp.entities` with an attribute in `check.attributes` that the neighbour can see. The
neighbour may narrow it further with `narrowRoleSet()`, never widen it. The neighbour's role
and the approver role are always kept; both are in the set by construction. A treasurer
answering about sponsor commitments therefore produces a claim that stays inside the finance
roles by default.

**Answer text** is masked with `maskText()` before storage, exactly as leaver answers are.
One marked call site (`// SENSITIVITY HOOK`) is left for improvement 2's classifier so a
neighbour answer in an open role set that contains finance, HR or health content is narrowed
the same way as any other segment.

---

## 5. Trace reader (`src/lib/tether/traces.ts`, pure)

### 5.1 Artefacts

| Kind | Read from | Produces |
|---|---|---|
| `workflow` | `file` segments whose `meta.path` is under `.github/workflows/` and ends `.yml` or `.yaml`, reassembled per path in `position` order | triggers, jobs, ordered steps, secret names |
| `commit_sequence` | `commit` segments (`meta.sha`, `meta.files`, message text, author, time) | what changed in what order on the paths of an entity, what changes together, unfinished last change |
| `calendar` | `event` segments (`meta.rrule`, `meta.repeats`, `meta.occurrences`, `meta.start`, `meta.summary`) | cadence and next occurrence for recurring events; cadence for repeated one-off events |

The reader works on masked segment text. Secrets appear by name only: `secrets.NAME`
references and environment names that match the credential pattern already used in
`footprint.ts`. A value is never present because masking ran at ingest.

A trace only ever combines segments that share one identical role set. This mirrors
Attest's batching rule and means a trace's role set is exact, not an intersection that
hides a public part.

### 5.2 How steps are derived

Two step kinds:

- `quoted`: the step text is a verbatim line (or contiguous lines) of the cited segment.
- `derived`: the step text is produced by a template from metadata across segments. It
  cites the segments it was computed from with a null quote.

**Workflow** (line based scan, no YAML dependency; the quote must be the original line anyway):

1. Trigger step, from the `on` block. `quoted` for each trigger line. Template for the
   summary step: `Runs on {push to main | a schedule (cron {expr}) | a manual start}`.
2. One `quoted` step per list item under `jobs.<id>.steps`, in file order: the `run:` line,
   or the `uses:` line, with `name:` as the display text when present and
   `working-directory` appended. A `run: |` block uses its lines joined, capped at 300 characters.
3. One `quoted` step listing secret names found: `Needs these secrets by name: {A, B}`. The
   quote is the first line that references each.
4. A matrix adds one `quoted` step: `Runs once for each of: {values}`.

**Commit sequence**, for the commits "about" an entity (the entity's indexed commit
segments plus commits whose path list or message matches the entity through
`matchEntities()` from `footprint.ts`), newest 8, oldest first:

1. One `quoted` step per commit: the first line of the message, shown as
   `{date} {author name}: {message} ({paths})`.
2. `derived` co-change step when two paths were changed by the same author within 48 hours
   on at least two occasions: `{path A} and {path B} were changed together {n} times`.
3. `derived` unfinished step when the newest commit message matches an open-work marker
   (`WIP`, `TODO`, `not wired`, `not yet`, `draft`, `testing`):
   `The last change on this path was left unfinished`, citing that commit with its message as quote
   (so this one is `quoted` on the commit line and the conclusion is the derived part).

**Calendar:**

1. Recurring event: `quoted` step from the segment's `repeats:` text (`every year on 2 December`)
   and a step `Next: {date}` from the first entry of `meta.occurrences` on or after today.
   It is `quoted` when that date string appears in the segment text, else `derived`.
2. Repeated one-off events: three or more events whose `meta.summary` shares the same first
   three normalised words, in at least two distinct ISO weeks (the pack's `footprint`
   thresholds): one `quoted` step per event and a `derived` step
   `Happened {n} times, {gaps} weeks apart`.

### 5.3 From trace to claim

`readTraces()` returns `Trace[]`. For each gap, the ladder asks which trace can serve it:

| Trace kind | Attribute it can fill |
|---|---|
| `workflow` | `procedure`; `access` for the secret names step alone |
| `commit_sequence` | `procedure`; `status` for an `unfinished_work` responsibility |
| `calendar` | `deadline` |

A trace is attached to a gap only if a claim built from it would satisfy the check. The
ladder builds the candidate claim and runs `deterministicStandin()` for that one check with
that one claim; anything other than `partial` means "does not answer this". This reuses the
existing `needsDate` and keyword rules, so a cadence without an upcoming date cannot earn
credit on a "Next due date" check.

Checks tagged WHO are never served by a trace.

### 5.4 How Attest verifies a trace

The trace becomes a `DraftClaim` with `origin: "structured"`, one citation per step
(`segment_id`, `quote` or null), and goes through `verifyDrafts()` unchanged. That gives:

- each citation `accepted` iff the segment exists in the workspace;
- each citation `exact` iff `norm(quote)` is a substring of `norm(segment.text)`;
- the claim's role set as the intersection of the cited segments' role sets;
- `validFrom` and `authorId` from the newest cited segment;
- the draft dropped when no citation is accepted.

Then recovery applies its own rules on the returned claim:

- trust is set to `inferred`, whatever `verifyDrafts` computed;
- origin is set to `trace`;
- a `quoted` step whose citation is not `exact` is shown as `Worked out from history` and
  counted as not quoted;
- a trace where fewer than half of its `quoted` steps verify is discarded and logged
  (`audit_log` action `trace_discarded`) because something is wrong with the read;
- `stateNote` is `Rebuilt from the record: {q} of {t} steps quoted`.

Importance and tier come from `importanceOf()` and `tierFor()` as for any claim, so a trace
on a blocking check lands in review tier C and needs the approver to open the evidence.

### 5.5 What stays Inferred

Everything a trace produces. The reasons, in the words used in the UI and the write-up:
the steps are quoted, but the choice of which steps belong together, their order across
files, and the assumption that nothing is missing are a reading of the record, not the record.

Two ways a trace can gain strength later, both already in the code and neither new:
an independent record claim with the same entity, attribute and normalised value makes both
`corroborated` (`corroborate()` treats `inferred` as upgradeable); or the approver edits and
approves it in Review.

---

## 6. Ranked options (`src/lib/lacuna/core/options.ts`, pure)

### 6.1 How candidates are formed

For a gap that is not Covered, candidates come from four sources, in this order:

| Source | Candidate | Evidence |
|---|---|---|
| `conflict` | each distinct value among `conflicting` claims on the gap's entities and attributes | those claims' citations |
| `weak` | each distinct value among active claims that satisfy the check with trust `second_hand` or `inferred` (neighbour answers, traces, unquoted extractions) | those claims' citations |
| `pattern` | for a `needsDate` check with a calendar trace: the next date the cadence implies | the trace's cited events |
| `model` | up to 3 answers proposed by the model from record claims on the same entities (section 11) | the claim ids the model cited, checked in code |

Candidates with the same `norm(value)` merge and pool their evidence.

### 6.2 Ranking (code only)

```
score(option) = sum over evidence claims of
                  trustWeight × authority(attribute, sourceKind) / 3 × r(validFrom)
                + 0.5 × (number of distinct authors minus 1)

trustWeight: from_record 3, corroborated 3, leaver_said 2, second_hand 1.5, inferred 1
```

Top 3 by score, ties by value. `authority()` is the pack function already used by Attest;
`r()` is the recency factor from section 4.2. The model never ranks and never sets a label.

Each option is one `recovery_steps` row (rung 3, kind `option`) whose role set is the
intersection of the role sets of its evidence segments. An option built from finance
evidence is invisible to a role that cannot see finance.

### 6.3 Why options never count as answered

- They are not rows in `claims`. `visibleClaims()` cannot return them, so `runStandin()`
  and `deterministicStandin()` never see them and coverage cannot change.
- `gap_questions.answered_claim_id` is not touched.
- They are not in `snapshot_claims`, so they cannot enter a handover as fact.
- A blocking gap with only options still needs owner, due date and risk note in the
  continuation plan; `openBlockingGaps()` and `releaseState()` are unchanged.
- Defence in depth: `visibleSatisfying()` in `core/standin.ts` ignores claims with trust
  `ranked_options`, so even a claim stored with that trust by mistake earns nothing.

---

## 7. Scoring rules for B, C and K

No formula changes. `computeScores()` stays as it is. The rules below are consequences of
`STRONG_TRUST = {from_record, corroborated, leaver_said}` and `RECORD_TRUST = {from_record, corroborated}`.

### 7.1 Per evidence kind

| Evidence on a check | Coverage | s | B (blocking check) | C | K |
|---|---|---|---|---|---|
| Leaver said (for comparison) | Covered | 1 | falls by 1 | rises by w / Σw | falls: denominator grows by w, numerator does not |
| Second-hand only | Partial | 0.5 | unchanged, still counted | rises by 0.5·w / Σw from Missing or Conflicting; unchanged from Partial | never rises; falls when the check was Missing or Conflicting |
| Inferred (trace) only | Partial | 0.5 | unchanged | as Second-hand | as Second-hand |
| Second-hand and Inferred together | Partial | 0.5 | unchanged | no stacking: still 0.5 | as above; `bestTrust` is `second_hand` |
| Two neighbours who agree | Partial | 0.5 | unchanged | no stacking | as above |
| Ranked options | unchanged | unchanged | unchanged | unchanged | unchanged |
| Second-hand or Inferred on a check already Covered by a record | Covered | 1 | unchanged | unchanged | unchanged (`bestTrust` stays the record's) |
| Inferred trace later corroborated by a record | Covered | 1 | falls by 1 | rises | rises: this is a record, by the existing rule |

### 7.2 Rules in words

1. Second-hand and Inferred evidence can lift a check to Partial and no further.
2. A blocking check with only such evidence stays in B and stays in the continuation plan.
3. K counts only `from_record` and `corroborated`. No recovery output is either.
4. `corroborate()` keeps excluding `second_hand`. Two colleagues agreeing is still hearsay.
5. Ranked options are outside scoring entirely.
6. A declined answer ("I don't know") stores no claim and changes nothing.

### 7.3 Evidence mix

`evidenceMix(results, checksByResp)` returns, per trust label, `Σ w·s` over checks whose
`bestTrust` is that label, divided by total `Σ w·s`. The `from_record` and `corroborated`
shares sum to K, so the mix is K broken open, not a new score. It is display only.

### 7.4 Projection for column 1

`projectLeaverRun(baseline, gapKeys, checksByResp, namedOwners)` copies the baseline
results, sets each ladder gap to `covered` with `bestTrust` = the stronger of its current
`bestTrust` and `leaver_said`, and calls `computeScores()`. It is an upper bound (the model
can lower a real answer), which is why the panel says "up to n".

The baseline is the successor run that existed when the switch went on, before traces were
stored. Its id is kept in `workspaces.recovery_baseline_run`.

---

## 8. Database changes (one migration, `0006_recovery.sql`, idempotent like the others)

### 8.1 `workspaces`: new columns

| Column | Type | Meaning |
|---|---|---|
| `leaver_unreachable` | boolean, not null, default false | the switch |
| `leaver_unreachable_at` | timestamptz, null | when it was last switched on |
| `leaver_unreachable_note` | text, null | the approver's optional reason |
| `recovery_baseline_run` | text, null | `test_runs.id` of the successor run at switch-on |

`Workspace` in `src/lib/db/mappers.ts` gains the same four fields.

### 8.2 `role_holders`: new table

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid, FK to `workspaces` on delete cascade | |
| `role_key` | text, not null | |
| `person_id` | text, not null | `people.id` |
| `source` | text, not null, default `pack` | `pack` or `approver` |
| primary key | (`workspace_id`, `role_key`, `person_id`) | several person records per role |

Admin path only: no grant to `us_reader`, no RLS needed. Revoke from `anon` and
`authenticated` as the other migrations do. Filled lazily by `ensureRoleHolders(ws)`.

### 8.3 `recovery_steps`: new table

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid, FK to `workspaces` on delete cascade | |
| `id` | text | `rs_` + 12 hex of sha256(`responsibility_id\|check_key\|rung\|target`) so a rebuild upserts |
| `responsibility_id` | text, not null | the gap |
| `check_key` | text, not null | the gap |
| `rung` | smallint, check in (1, 2, 3) | |
| `kind` | text, check in (`neighbour`, `trace`, `option`, `none`) | `none` = the rung ran and found nothing |
| `position` | integer, not null, default 0 | order inside the rung; not shown |
| `target_person` | text, null | node person id for rung 1 |
| `target_role` | text, null | role that may answer |
| `target_ref` | text, null | trace id or option hash |
| `status` | text, check in (`asked`, `answered`, `declined`, `skipped_no_access`, `skipped_no_seat`, `found`, `offered`, `none`, `not_applicable`) | |
| `score` | double precision, null | neighbour or option score |
| `reason` | text, not null, default '' | the metadata sentence |
| `question_text` | text, null | question built for the target role |
| `detail` | jsonb, not null, default '{}' | counts by edge type; trace steps (`n, text, kind, segmentId, quote, exact, path, sha`); option value and evidence |
| `claim_id` | text, null | the Second-hand or Inferred claim |
| `role_set` | text[], not null | who may read this row |
| `created_at`, `updated_at` | timestamptz | |
| primary key | (`workspace_id`, `id`) | |
| index | (`workspace_id`, `responsibility_id`, `check_key`, `rung`, `position`) | |

RLS needs, identical in shape to `claims` and `attest_dropped`:

- `GRANT SELECT ON recovery_steps TO us_reader`.
- `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- Policy `us_reader_select`: `workspace_id = us_claim('workspace_id')::uuid AND us_claim('role_key') = ANY(role_set)`.
- Policy `us_admin_all` for the migration user.
- Revoke all from `anon` and `authenticated`.
- No update or delete grant for `us_reader`. Writes happen on the admin path and each
  status change writes an `audit_log` row.

A `kind = none` row for an empty rung has the gap's open role set (all roles for which
`accessFor` is open), so "the rung ran and found nothing" is visible to the roles that may
see the gap and to nobody else.

### 8.4 `claims.origin` check

The check must also allow `neighbour_answer` and `trace`. The existing constraint was
created inline, so the migration drops it by its generated name and adds a named one.
Improvement 3 will need its own origin value on the same constraint; the foundation pass in
hours 0 to 4 should write the one statement with all values (section 16, item 5).

`Claim.origin` in `src/lib/types.ts` gains `"neighbour_answer" | "trace"`. No change to
`Trust`, `SourceKind` or `SegmentKind`: neighbour answers are `answer` segments of source
kind `interview` in a new source row `src_recovery` named `Recovery answers`.

### 8.5 Audit actions

`recovery_on`, `recovery_off`, `recovery_ladder_built` (counts per rung and status),
`neighbour_answer` (step id, claim id, role set), `neighbour_declined`, `trace_stored`,
`trace_discarded`, `role_holder_set`.

---

## 9. Module layout and signatures

Types below are described, not final code. Role keys always come from the pack; no file
under `src/lib` may contain a role key or pack id literal (improvement 3 adds a CI check for this).

### 9.1 `src/lib/tether/graph.ts` (new, pure)

| Function | Signature | Uses |
|---|---|---|
| `toGraphSegment` | `(s: Segment) => GraphSegment` | nothing |
| `buildGraph` | `(segments: GraphSegment[], opts: { now: string; windowMonths: number; canon?: Map<string, string> }) => CollabGraph` | `isoWeek` not needed; own recency helper |
| `entitySegmentIndex` | `(claims: Pick<Claim, "entity" \| "state" \| "citations">[], segments: GraphSegment[]) => Map<string, Set<string>>` | nothing |
| `neighbourScores` | `(graph: CollabGraph, segmentIds: Set<string>, opts: { leaverIds: string[]; now: string }) => NeighbourScore[]` | nothing |
| `neighbourReason` | `(counts: NeighbourCounts, entityLabel: string) => string` | nothing |

`CollabGraph = { nodes: string[]; edges: GraphEdge[]; byId: Map<string, GraphSegment> }`.
`GraphEdge = { a, b, type, count, weight, lastTs, segmentIds }`.
`NeighbourScore = { personId, score, counts: { wrote, replied, near, files, events }, segmentIds, roleSet }`
where `roleSet` is the intersection of the contributing segments' role sets
(`intersectRoleSets` from `attest/core/verify.ts`).

### 9.2 `src/lib/tether/traces.ts` (new, pure)

| Function | Signature | Uses |
|---|---|---|
| `parseWorkflow` | `(fileText: string) => WorkflowDoc` | nothing |
| `workflowTraces` | `(fileSegments: Segment[]) => Trace[]` | `parseWorkflow` |
| `commitSequenceTrace` | `(commits: Segment[], entity: FootprintEntity, people: Person[]) => Trace \| null` | `matchEntities` from `./footprint` |
| `calendarTraces` | `(events: Segment[], entities: FootprintEntity[], thresholds: FootprintThresholds, today: string) => Trace[]` | `matchEntities`, `isoWeek` |
| `readTraces` | `(segments: Segment[], entities: FootprintEntity[], people: Person[], opts: { today: string; thresholds: FootprintThresholds }) => Trace[]` | the three above; groups by identical role set first |

`Trace = { id, kind, entityKey, title, sourceLabel, steps: TraceStep[], roleSet }`,
`TraceStep = { n, text, kind: "quoted" | "derived", citations: { segmentId, quote | null }[], path?, sha? }`.
`id` is `trc_` + 12 hex of sha256(kind, entity, sorted segment ids).

Both new files are exported from `src/lib/tether/index.ts` (two added lines).

### 9.3 `src/lib/lacuna/core/ladder.ts` (new, pure)

| Function | Signature | Uses |
|---|---|---|
| `accessFor` | `(resp, check: LacunaCheck, role: RoleKey, meta: ClaimMetaIndex) => "open" \| "walled"` | same logic as `hiddenEvidence` |
| `openRoles` | `(resp, check, roles: RoleKey[], meta) => RoleKey[]` | `accessFor` |
| `routeCandidates` | `(scores: NeighbourScore[], holders: RoleHolderIndex, resp, check, meta, leaverRole) => NeighbourPlan[]` | `accessFor` |
| `defaultAnswerRoleSet` | `(base: RoleKey[], resp, check, visibleToNeighbour: VisibleClaim[]) => RoleKey[]` | `intersectRoleSets` |
| `neighbourAnswerToDrafts` | `(text, question: AnsweredQuestion, person: { id; name }, opts: AnswerOptions) => { segment; claim }` | `answerToDrafts` from `./questions`, then overrides trust `second_hand`, origin `neighbour_answer`, thread `recovery:{resp.key}:{check.key}:{personId}`, statement `{name} said (second-hand): {text}` |
| `looksLikeNoAnswer` | `(text: string) => boolean` | nothing |
| `traceToDraft` | `(trace: Trace, resp, check, entityLabel) => DraftClaim` | type from `attest/core/verify.ts` |
| `traceServes` | `(candidate: VisibleClaim, resp, check, role, today) => boolean` | `deterministicStandin` |
| `projectLeaverRun` | `(baseline: ScoredRun, gapKeys: Set<string>, checksByResp, namedOwners) => Scores` | `computeScores` |
| `ladderSummary` | `(gapKeys, baseline: CheckResult[], latest: CheckResult[]) => { worked; closed; partly; open }` | `gapKey` |

### 9.4 `src/lib/lacuna/core/options.ts` (new, pure)

| Function | Signature | Uses |
|---|---|---|
| `conflictOptions`, `weakOptions`, `patternOptions` | `(resp, check, claims: Claim[], …) => OptionCandidate[]` | `norm` |
| `rankOptions` | `(candidates, authorityOf, now) => RankedOption[]` (max 3) | nothing |
| `buildOptionsPrompt` | `(resp, check, questionText, claims: VisibleClaim[]) => { system; user }` | `formatClaimLine` from `./standin` |
| `OptionsOutputSchema` | zod: `{ options: [{ answer, claim_ids, why }] }`, max 3 | zod |
| `evaluateOptions` | `(output, claimsById) => OptionCandidate[]` | drops unknown ids and ungrounded answers |

### 9.5 `src/lib/lacuna/core/scores.ts` and `core/standin.ts` (small edits)

- `scores.ts`: add `evidenceMix(results, checksByResp) => Partial<Record<Trust, number>>`.
- `standin.ts`: `visibleSatisfying()` skips claims with trust `ranked_options`.

### 9.6 `src/lib/lacuna/recovery.ts` (new; database and model glue)

| Function | Signature | Calls |
|---|---|---|
| `recoveryState` | `(ws) => { on; at; note; baselineRunId }` | `getWorkspace` |
| `setLeaverUnreachable` | `(ws, on: boolean, actor: RoleKey, note?) => ActionResult` | approver check against `pack.approverRole`, `audit`, `buildQuestions` if none, `buildLadder` when on |
| `ensureRoleHolders` | `(ws) => RoleHolderIndex` | `listPeople`, pack `roleHolders`, `leaverPersonIds` for the leaver role |
| `buildLadder` | `(ws) => { gaps; steps }` | `listQuestions`, `listResponsibilities`, `checksByResp`, `claimMeta`, `listClaims`, metadata segment read, `buildGraph`, `entitySegmentIndex`, `neighbourScores`, `routeCandidates`, `visibleClaims(ws, role)` + `questionText` per asked role, `listSegments` + `readTraces` + `traceToDraft` + `verifyDrafts`, `conflictOptions` and friends, `callJson` for model options, then `runTest(ws, successor, { only })` |
| `listLadder` | `(ws, role) => LadderGap[]` | `withRole(ws, role, …)` select on `recovery_steps`; names from `peopleNames` |
| `questionsForRole` | `(ws, role) => NeighbourQuestion[]` | `withRole` select where `target_role = role and status = 'asked'` |
| `answerAsNeighbour` | `(ws, stepId, text, actor, opts: { narrowRoles?; personId? }) => AnswerResult` | step lookup, role check, `maskText`, `defaultAnswerRoleSet`, `neighbourAnswerToDrafts`, `claimId`, `tierFor`, `persistAnswer`, `audit`, `runTest(…, { only: [respId] })`, `scoreDelta`, then deterministic option refresh for that gap |
| `declineAsNeighbour` | `(ws, stepId, actor) => ActionResult` | status update, `audit` |
| `recoveryComparison` | `(ws) => { projected: Scores; latest: Scores; summary; mixProjected; mixLatest }` | `getLatestTestRun`, baseline run by id, `projectLeaverRun`, `ladderSummary`, `evidenceMix` |
| `listTraces` | `(ws, role) => TraceView[]` | `withRole` select of claims with origin `trace` joined to their steps |
| `recoverySurfaces` | `(ws, role) => { surface: string; text: string }[]` | everything a role can read from recovery (neighbour names and reasons, questions, traces, options) as plain text, for improvement 2's leak grid |
| `precomputeRecovery` | `(ws) => void` | switch on, apply each sample answer once, so `scripts/precompute.ts` can record the model calls |

### 9.7 `src/lib/lacuna/index.ts` (edits)

- `answerQuestion`: refuse while the switch is on, with
  `{leaver} is marked as unreachable. {approver} can switch this off.`
- Extract the storage block of `answerQuestion` into a private `persistAnswer(ws, parts)`
  (source row, segment, contacts, claim, `claim_events` row) so leaver and neighbour answers
  share one write path. No behaviour change for the leaver.
- `RunTestOptions` gains `only?: string[]`: responsibility ids to re-judge; results for all
  other responsibilities are copied from the latest run. This is also the Round 2 fix
  "re-test only the answered responsibility".
- Re-export the public recovery functions.

### 9.8 `src/lib/attest/index.ts` (one small edit, see section 16 item 4)

In `verify()`: claims with origin `neighbour_answer` or `trace` are carried over untouched.
They are not passed to `applyRules()` (so they never supersede or conflict with a record),
and they are not marked "Dropped: the latest extraction no longer finds this claim".

### 9.9 Pages and components

| File | Change |
|---|---|
| `src/app/w/[id]/ask/page.tsx` | read `recoveryState`; when on, render banner, panel, "Questions for you", ladder, rebuilt procedures; hide leaver answer forms. When off, today's page plus the switch card for the approver |
| `src/app/w/[id]/ask/actions.ts` | add `setUnreachableAction`, `answerAsNeighbourAction`, `declineAsNeighbourAction`, `switchToRoleAction` (generalises `switchToLeaverAction`; only accepts a role that is the target of an asked step) |
| `src/app/w/[id]/ask/RecoverySwitch.tsx`, `BeforeAfter.tsx`, `NeighbourQuestions.tsx`, `Ladder.tsx`, `RebuiltProcedures.tsx` | new, next to the page as the layout rule says |

Reused as is: `Chip`, `TrustChip`, `ScoreLine`, `ActionForm`, `SubmitButton`, `Notice`,
`EmptyState`, `roleOptions`, the source page.

---

## 10. Demo pack

### 10.1 Who holds which role (already true in the data, not yet stated anywhere)

| Person | Role |
|---|---|
| Rohan Mehta | Club President (approver) |
| Arjun Rao | Incoming tech lead (successor) |
| Ananya Iyer | Treasurer |
| Priya Nair | leaver |
| Kabir Sethi, Sneha Joshi, Dev Malhotra, Tanvi Deshpande | no role in the handover |
| Mr. Pawar, Dr. Kulkarni | outside the club, no role |

### 10.2 Expected rung per planted gap

These are the open, non-restricted gaps of the incoming tech lead in `ground_truth.json`.
"Expected" means worked out from the data by reading it; the builder confirms each cell on
the first real run and records the real values in the demo data (10.4, fact F7).

| Gap (from `gaps`) | Rung 1: people | Rung 2: traces | Rung 3: options | Expected end state |
|---|---|---|---|---|
| R01 Credential owner (missing, blocking) | Arjun asked (he replied in the deploy threads and asked "Who has the OTA password?" on 4 Nov). Kabir shown as no role | Not applicable: WHO check | Lead from Arjun's answer; model may add one from the record | Partly answered, Second-hand. B unchanged |
| R03 Next due date (conflicting, blocking) | Rohan asked (he wrote the once-a-term reminder). Kabir or Sneha shown as no role | Calendar: three "Book Workshop Lab 3" events give a cadence, but no upcoming date, so it does not answer this | Two options from the conflict: 1 Dec (Kabir, 21 Oct) and 5 Dec (Sneha, 29 Oct), plus the earlier-date hint | Still open unless Rohan answers, then Partly answered |
| R04 How to do it (partial) | **Ananya skipped: no access** (the only procedure claim is in #infra, which the Treasurer cannot see). Arjun asked, after fact F3 | Commit sequence on `dns/` ("lower the TTL before the renewal", "update.sh reads DNS_API_TOKEN") plus the yearly calendar entry | Usually none | Partly answered, now with an Inferred procedure |
| R06 Next concrete step (partial, blocking) | Sneha or Dev shown as no role; Arjun or Rohan only if they score 1 or more | Commit sequence on `website/register.*`; the last commit is "WIP confirmation email template, not wired yet", so the unfinished step fires | Options from the trace and from the model (the 2 Oct status message, the 1 Nov "PR is waiting on Priya") | Partly answered, Inferred. B unchanged |
| R09 Next due date (missing, blocking) | Rohan asked if he scores; Mr. Pawar shown as no role | Nothing: late access is only in chat | Nothing | Still open. The ladder reaches the bottom and says so |
| R09 How to do it (missing) | Rohan asked if he scores | Nothing | Model lead from the five past requests | Still open or Partly answered |
| R10 Owner (missing, blocking) | Rohan asked (he wrote "Someone has to own drive team selection"), Arjun asked | Not applicable: WHO check | Lead from Rohan's answer | Partly answered, Second-hand. B unchanged |
| R10 Deadline (conflicting) | Arjun asked; Dev or Tanvi shown as no role | Nothing | Two options from the conflict: 22 Nov (Dev) and 29 Nov (Tanvi), plus the earlier-date hint | Still open |
| R02 Open commitments (partial, part restricted) | Ananya asked; her answer defaults to the finance roles only. **Arjun skipped: no access** (the tech lead is walled off from the finance claim) | Nothing | None visible to the tech lead | Unchanged for the tech lead, by design |

Restricted gaps (R04 consequence, R07 next step, R08 both) do not enter the ladder.

What this gives the demo: every rung outcome appears at least once (asked, answered,
declined, skipped for access, no role, trace found, trace not applicable, options from a
conflict, nothing found), no gap closes without Priya, and the confidentiality case is
visible from two sides (R04 and R02).

The workflow file trace (`deploy.yml`) has no open gap to serve, because R01 "Steps" is
already Covered by `docs/DEPLOY.md`. It appears in "Rebuilt procedures" with
`No open gap needs this. Kept for the handover.` Fact F4 gives it a visible secrets step.

### 10.3 Facts to plant

A list of facts, not files. Each names what it changes downstream.

| # | Fact | Why | Ripple to expect |
|---|---|---|---|
| F1 | The setting pack states the role holders of 10.1 by full name (key `roleHolders`, role key to list of names) | Without it nobody can be asked | None in the pipeline; pack schema is loose so the key is kept |
| F2 | Arjun's two short #infra replies ("ok" on 6 Jul under the USB deploy message, "saving this" on 20 Sep under the rollback message) are true thread replies | Gives Arjun explicit reply edges and the reason "Replied in 3 threads" | Metadata only. They carry no claim, so supersession rule 2 is unaffected |
| F3 | Arjun replies in the thread under Priya's 25 Sep "Renewal is a few clicks on the NameHarbor dashboard" with a short question such as "Can you show me before you leave?" | Puts an asked neighbour next to the skipped one on R04 | One new #infra segment: that extraction batch's prompt changes, so the cache entry is rebuilt in the planned precompute |
| F4 | `deploy.yml` reads the OTA password by name from the repository secrets in the build job's environment, added by one commit from Priya in August ("ci: read OTA_PASSWORD from the repo secrets") | Shows "Needs these secrets by name" in the workflow trace and gives rung 3 evidence on R01 | The `jobs` file segment changes (cache rebuild for that batch); footprint adds a credential candidate for firmware deploy; the "5 of 5 commits" wording in the ground truth becomes 6 of 6. Masking keeps the name: `mask.ts` skips values that contain `{{` |
| F5 | Sample neighbour answers exist for the demo: Arjun on R01 ("Priya has it. She typed it on the lab laptop herself each time. I asked on 4 Nov and never got it."), Rohan on R10 owner ("Arjun will own drive team selection. We agreed it at the core meeting on 11 Nov."), Rohan on R03 ("I think it is 1 Dec, but I only heard that from Kabir."), Ananya on R02 ("Vertex also expects a banner at the competition and a report with photos afterwards.") | The judge can finish without inventing an answer, and the re-test replays from the cache | Stored in a new demo file owned by this builder (`data/demo/recovery.json`), not in `ground_truth.json`, to avoid merge collisions |
| F6 | A decline sample: Arjun on R04 has nothing to add, so the demo path uses `I don't know` there | Shows that a non-answer earns nothing | None |
| F7 | The same new demo file records the expected rung outcomes of 10.2 once measured, and the two expected skips (Ananya on R04 How to do it; Arjun on R02 Open commitments) | Answer key for the DB test | None |

Optional, default off: a second workflow file that pushes DNS records on a schedule would
put all three trace kinds on R04. It is left out because the extractor may then read a
procedure for domain renewal from it and close the planted R04 gap before the ladder runs.

---

## 11. Model calls and caching

| # | Call | When | Count in the demo | Cacheable for the precomputed demo |
|---|---|---|---|---|
| M1 | Stand-in successor for the responsibilities that gained a trace | at switch-on | 2 to 3 | Yes. Trace claim ids are deterministic (`claimId` over entity, attribute, value, segment ids), so the prompt is identical in every demo workspace |
| M2 | Ranked option proposals (`jsonSchemaName: "recovery_options"`) | at switch-on, only for gaps with fewer than 2 rule-based candidates, one call per identical role set among the entity's record claims | about 10 to 12 | Yes. The prompt holds record claims only (origins `extracted` and `structured`), never neighbour answers or traces, so it does not change after answers |
| M3 | Stand-in successor for the one answered responsibility | after each neighbour answer | 1 per answer | Yes for sample answers, no for free text (see below) |

No model call in: the graph, neighbour selection, access decisions, question text, trace
reading, trace verification, option ranking, scores, the projection.

Rules that keep it cacheable and safe:

- Every call goes through `callJson()`; nothing new in the client.
- M2 batches by identical role set, like Attest extraction, and an option's role set is the
  role set of the batch that produced it. A proposal that cites no valid claim id is
  dropped. An answer is also dropped when fewer than half of its words of four letters or
  more appear in the cited claims' statements.
- M2 runs once, at switch-on. After answers, only rule-based candidates are refreshed.
- M3 for demo workspaces: the answer segment's timestamp is `workspaceNow(ws)` (the fixed
  demo time) and its thread is `recovery:{R key}:{check}:{person}`, so the segment id and
  the claim id depend only on who answered what with which text. With a sample answer the
  stand-in prompt is byte identical across workspaces and replays from the cache. The real
  time of the answer is kept in `segment.meta.answeredAt` and on the step row. Each
  responsibility has at most one claim-producing sample, so the order of answers does not matter.
- Free-text answers use the existing "auto" mode for one responsibility: live model if
  reachable, else cache, else the deterministic reading.
- If the model or cache has nothing for M2: rule-based options only, and the rung says so.
- `precomputeRecovery(ws)` is the one entry point `scripts/precompute.ts` needs to call
  after the pipeline run, so the script edit at merge time is a few lines.
- vitest runs with `MODEL_DISABLED=1` and `LACUNA_MODEL=off`; tests that need M2 inject a fake `ModelCall`.

---

## 12. Tests

### 12.1 Unit (vitest, no database, no model)

| Id | File | What it proves |
|---|---|---|
| T-U-1 | `tests/tether/graph.test.ts` | Build the graph from the Tether fixtures, then again with every segment's `text` set to an empty string and every non-allowlisted meta key removed: the two graphs and all neighbour scores are deep equal |
| T-U-2 | same | Each edge type is created by its rule and by nothing else: reply by `replyTo`, same thread only within 30 minutes and different authors, co-change only inside the window, shared event pairs |
| T-U-3 | same | Recency: an interaction 90 days old counts half of one today; the leaver is never a neighbour; scores under 1 are left out |
| T-U-4 | same | `neighbourReason` contains counts and the entity label and none of the fixture's message text, file names or event titles |
| T-U-5 | same | `NeighbourScore.roleSet` is the intersection of contributing segments' role sets |
| T-U-6 | `tests/tether/traces.test.ts` | `parseWorkflow` on the fixture `deploy.yml`: triggers, job, steps in file order, secret names, matrix |
| T-U-7 | same | Every `quoted` step text is an exact-quote match (`isExactQuote`) against its cited segment; masked placeholders pass through; no secret value can appear |
| T-U-8 | same | Commit sequence: order, co-change step needs two occasions, the unfinished step fires on "WIP ... not wired yet" and not on a normal message |
| T-U-9 | same | Calendar: an RRULE event gives cadence and the next date after today; three one-off events in two weeks give a cadence; two do not |
| T-U-10 | same | Segments with different role sets never end up in one trace |
| T-U-11 | `tests/lacuna/ladder.test.ts` | `accessFor`: walled when a live satisfying claim excludes the role, open otherwise; superseded and dropped claims do not wall |
| T-U-12 | same | A check with only a `second_hand` claim is Partial under `deterministicStandin` and `evaluateStandin`; B is unchanged; K is not higher than before (compared against the run without the claim) |
| T-U-13 | same | The same for an `inferred` trace claim, and for both together (no stacking: s stays 0.5) |
| T-U-14 | same | A claim with trust `ranked_options` leaves coverage and all three scores exactly as they were |
| T-U-15 | same | `projectLeaverRun` equals a real deterministic run in which the leaver answered the same gaps; `ladderSummary` counts closed, partly, open; recovery closed count is lower than the projection |
| T-U-16 | same | `defaultAnswerRoleSet` is the base intersected with visible claims' role sets; narrowing never widens; the neighbour's role and the approver stay |
| T-U-17 | same | `neighbourAnswerToDrafts` yields trust `second_hand`, origin `neighbour_answer`, the recovery thread, and a deterministic segment id for a fixed timestamp |
| T-U-18 | same | `looksLikeNoAnswer` catches "I don't know", "no idea", "not sure, ask Priya" and lets a real answer through |
| T-U-19 | same | `traceServes`: a cadence without an upcoming date does not serve a `needsDate` check; a WHO check is never served |
| T-U-20 | `tests/lacuna/options.test.ts` | Conflict options come from conflicting claims only; equal values merge; ranking follows the formula; at most 3 |
| T-U-21 | same | `evaluateOptions` drops unknown claim ids, superseded claims and ungrounded answers; an option's role set equals its batch's role set |
| T-U-22 | `tests/lacuna/scores.test.ts` (extend) | `evidenceMix` shares sum to 1 and the two record shares sum to K |

### 12.2 Database (vitest with Postgres, like `tests/db/rls.test.ts`)

| Id | What it proves |
|---|---|
| T-DB-1 | `setLeaverUnreachable` refuses every role but the approver; on and off each write one `audit_log` row; the baseline run id is stored |
| T-DB-2 | After switch-on in a seeded workspace, every open gap question has at least one row for each of rungs 1, 2 and 3; a rebuild is idempotent (same ids, answered rows kept) |
| T-DB-3 | The skipped neighbour learns nothing: for the planted skip (Treasurer, R04 How to do it), a read under `withRole(ws, treasurer)` returns no `recovery_steps` row for that gap's rung 1, `questionsForRole` returns no question for it, and `recoverySurfaces(ws, treasurer)` does not contain the gap's question text, the person's own reason or the word "Skipped" for that gap. A direct `us_reader` select with the treasurer claim cannot read the row |
| T-DB-4 | `answerAsNeighbour` as the asked role stores an `answer` segment in source `src_recovery`, a claim with trust `second_hand` and origin `neighbour_answer` whose role set equals the default or the narrowed set, a `claim_events` row, and sets the step to `answered`. The wrong role is refused. The leaver's `answerQuestion` is refused while the switch is on |
| T-DB-5 | `gap_questions.answered_claim_id` is still null after a neighbour answer; rung 3 rows exist; no claim with trust `ranked_options` exists; B for the successor is the same before and after |
| T-DB-6 | Switching off: `answerQuestion` works again for the leaver, the Second-hand claim and the trace claims are still present with their labels, `listLadder` is not shown but rows remain |
| T-DB-7 | A second `verify(ws)` after recovery keeps the `neighbour_answer` and `trace` claims active and does not turn any record claim `conflicting` or `superseded` because of them |
| T-DB-8 | Trace claims: stored with trust `inferred`, origin `trace`, citations checked by `verifyDrafts`; a trace that cites a segment from another workspace is dropped |
| T-DB-9 | Canary: with recovery on, `recoverySurfaces` for each role contains no `CANARY-` token outside that role's visibility (reuses `scanForCanaries` from `relay/core/canary`) |
| T-DB-10 | `runTest(ws, role, { only: [id] })` changes results only for that responsibility and gives the same scores as a full deterministic run |

### 12.3 End to end (Playwright, `tests/e2e/recovery.spec.ts`, on the live URL)

One test, the judge path of 3.7:

1. Open the demo, go to Ask as Club President, note the scores.
2. Press `Priya can't be reached`. Expect the banner, the panel and `Gaps being worked`.
3. Expect one row with `Skipped: no access.` and at least one chip each of `Inferred` and `Ranked options`.
4. Press `Switch to Arjun to answer`, use the sample answer, save. Expect `Saved as "Second-hand".` and the re-test line with `B` unchanged.
5. Press `I don't know` on another question. Expect `Noted. Nothing was saved as evidence.`
6. Switch to Treasurer. Expect no `Skipped` text for the R04 gap and no "Questions for you" entry for it.
7. Switch to Club President. Expect `Closed` in column 2 to be lower than `Closed` in column 1, and the Claims page filtered by `trust=second_hand` to show one claim.
8. Press `Priya is back. Use the normal flow`. Expect `Open questions` and the leaver switch notice again.

The existing `judge-path.spec.ts` must still pass untouched (the switch is off by default).

---

## 13. Edge cases and failure behaviour

| Case | Behaviour |
|---|---|
| Switch pressed before any test run | `buildQuestions` runs first (it runs the test if needed). If there are still no questions: the "Run the successor test first" error |
| Switch pressed twice, or ladder rebuilt | Deterministic step ids, upsert. Rows with status `answered` or `declined` are never overwritten. Rows for gaps that left the question list are deleted unless answered |
| No `roleHolders` in the pack (uploaded workspace) | Everyone is `skipped_no_seat`; rung 1 shows the no-role rows. Stretch item S2 lets the approver set holders |
| The best neighbour is the successor | Allowed. Arjun can be asked about gaps in his own handover; the answer is still Second-hand |
| The best neighbour is the approver | Allowed and still Second-hand. Nothing a person says is ever labelled verified |
| A neighbour holds the leaver role | Not a candidate |
| Two people share a role | Both get rows; "Answering as" picks the person; the server accepts either holder of the step's target role only for their own step |
| Two neighbours disagree | Two Second-hand claims; the check stays Partial; rung 3 lists both values |
| Answer is "I don't know" typed as text | `looksLikeNoAnswer` treats it as a decline; no claim is stored |
| Answer contains a secret or a phone number | Masked by `maskText` before storage; contacts go to `contacts` with the answer's role set intersected with `pack.contactsRoles`, as for leaver answers |
| Answer carries restricted knowledge | The default role set follows the most restricted visible record on the topic; the neighbour can only narrow. The sensitivity hook can narrow again |
| Check is walled for every non-leaver role | Rung 1 has only `skipped_no_access` rows, readable by the approver if the approver's role is open, otherwise the `none` row |
| Entity has no claims at all | No entity segments, so no neighbours: `Nobody else worked on this closely enough to ask.` |
| Workflow file is not valid YAML | The line scan still returns what it can; with no steps found there is no trace |
| A trace's quoted steps fail verification | Under half verified: trace discarded and logged. Otherwise the failed steps are shown as "Worked out from history" |
| Model unavailable or not in cache | Rule-based options only, with the notice; traces, graph and scoring are unaffected; the re-test falls back to the deterministic reading as today |
| Pipeline re-run while recovery is on | `verify()` keeps recovery claims (9.8). The approver sees a button `Rebuild the ladder` because gaps may have changed |
| Gap becomes Covered for another reason | State chip `Closed`; rung 3 shows `Not needed. This gap is closed.`; open `asked` rows stay answerable |
| Switch turned off with unanswered steps | Rows stay with status `asked` but are not shown; turning on again resumes them |
| Leaver role opens the page while on | Banner text for the leaver; no answer forms; server refuses `answerQuestion` |
| Old workspace created before the migration | Columns default to off; nothing changes |
| Snapshot already approved | New claims make the scores provisional again through the existing `isProvisional()` check |
| More than 10 gaps | The ladder covers the same top 10 as the question list |

Failure rule for the whole feature: if any rung throws, the other rungs still store their
rows, the failed rung stores a `none` row with reason `Could not run: {short message}`, and
the page shows it. Nothing fails silently.

---

## 14. Task breakdown (build order, one builder)

| # | Task | Output | Hours |
|---|---|---|---|
| 1 | Contract first: add a "Recovery" subsection to `docs/ARCHITECTURE.md` (vocabulary, rules of sections 4.6, 5.4, 7); write migration `0006_recovery.sql`; extend `Claim.origin` and `Workspace` | migration applies on a fresh and an existing database | 1.0 |
| 2 | `tether/graph.ts` with T-U-1 to T-U-5 written first | pure module, tests green | 1.5 |
| 3 | `tether/traces.ts` with T-U-6 to T-U-10 written first | pure module, tests green | 2.0 |
| 4 | `lacuna/core/ladder.ts`, `evidenceMix`, the stand-in filter, with T-U-11 to T-U-19 and T-U-22 | pure module, tests green | 1.5 |
| 5 | `lacuna/core/options.ts` with T-U-20 and T-U-21 | pure module, tests green | 1.0 |
| 6 | `lacuna/recovery.ts`, the `lacuna/index.ts` edits (`persistAnswer`, `only`, the guard), the `attest/index.ts` keep-list | glue | 2.0 |
| 7 | Database tests T-DB-1 to T-DB-10 | tests green | 0.75 |
| 8 | Ask page: switch card, banner, panel, "Questions for you", ladder, rebuilt procedures, actions | page works for all five roles | 1.5 |
| 9 | Demo facts F2 to F7, `precomputeRecovery`, end to end test | e2e green locally | 1.0 |
| | **Total** | | **12.25** |

To land inside 10 to 12 hours, cut in this order, each cut independent:

1. Model option proposals (M2). Rule-based options only. Saves about 0.5 h.
2. The co-change derived step and the repeated one-off calendar rule in traces. Saves about 0.5 h.
3. The "Rebuilt procedures" list (traces still show in rung 2). Saves about 0.25 h.

Stretch, only if ahead:

- S1 `Use a sample answer` button wired to the demo file (0.25 h; without it the e2e types the sample text).
- S2 Approver form "Who holds which role" for uploaded workspaces (1 h).
- S3 Approver action on an option: `Record as my decision`, which stores a Second-hand claim by the approver (0.5 h).

Dependencies on the foundation pass (hours 0 to 4): the `roleHolders` pack key (F1) and the
single `claims.origin` constraint statement. If either is missing when this builder starts,
task 1 includes them and the builder says so in the merge note.

---

## 15. Builder brief (paste as the prompt at window open)

```
You are building Round 3 improvement 1 of Understudy: unreachable-leaver recovery.
The build window is open. Work in your own git worktree on branch r3/recovery.

READ FIRST, in this order
1. round3/specs/01_recovery.md (the spec; it wins over this brief on detail).
2. docs/ARCHITECTURE.md (the contract; if you change behaviour, change it there first).
3. AGENTS.md: this is Next.js 16. Read the relevant guide under
   node_modules/next/dist/docs/ before writing any page or server action.
4. src/lib/types.ts, src/lib/lacuna/index.ts, src/lib/lacuna/core/{standin,scores,questions,pack}.ts,
   src/lib/tether/footprint.ts, src/lib/attest/core/verify.ts, src/lib/db/withRole.ts,
   db/migrations/0001_core.sql, src/app/w/[id]/ask/.

WHAT TO BUILD
With "leaver unreachable" switched on by the approver, every open gap question walks three
rungs: (1) knowledge neighbours picked from a metadata-only collaboration graph and asked
only if their role may see the topic, their answers stored as Second-hand claims;
(2) procedures rebuilt from workflow files, commit history and calendar recurrences, stored
as Inferred claims with every step cited and checked by Attest's exact-quote rule;
(3) ranked options, stored only in recovery_steps, never as claims. A before and after
panel compares the leaver projection with the recovery run. Exact UI copy is in spec
section 3. Use it word for word. No em dashes in any UI text.

YOUR FILE LANE (create or edit only these)
  new   src/lib/tether/graph.ts
  new   src/lib/tether/traces.ts
  edit  src/lib/tether/index.ts            (two export lines only)
  new   src/lib/lacuna/core/ladder.ts
  new   src/lib/lacuna/core/options.ts
  new   src/lib/lacuna/recovery.ts
  edit  src/lib/lacuna/index.ts            (persistAnswer extraction, RunTestOptions.only,
                                            unreachable guard in answerQuestion, re-exports)
  edit  src/lib/lacuna/core/standin.ts     (ignore ranked_options in visibleSatisfying)
  edit  src/lib/lacuna/core/scores.ts      (add evidenceMix)
  edit  src/lib/attest/index.ts            (verify(): carry neighbour_answer and trace claims
                                            over untouched, outside applyRules; nothing else)
  edit  src/lib/types.ts                   (Claim.origin gains two values; nothing else)
  edit  src/lib/db/mappers.ts              (Workspace gains four fields; nothing else)
  new   db/migrations/0006_recovery.sql
  edit  src/app/w/[id]/ask/page.tsx, src/app/w/[id]/ask/actions.ts
  new   src/app/w/[id]/ask/{RecoverySwitch,BeforeAfter,NeighbourQuestions,Ladder,RebuiltProcedures}.tsx
  new   tests/tether/graph.test.ts, tests/tether/traces.test.ts
  new   tests/lacuna/ladder.test.ts, tests/lacuna/options.test.ts, tests/lacuna/recovery-fixtures.ts
  edit  tests/lacuna/scores.test.ts        (evidenceMix cases)
  new   tests/db/recovery.test.ts, tests/e2e/recovery.spec.ts
  new   data/demo/recovery.json            (sample answers and expected rung outcomes)
  edit  data/demo/slack/infra/infra.json, data/demo/github/commits.json,
        data/demo/github/files/.github/workflows/deploy.yml   (facts F2, F3, F4 only,
        in one commit titled "data: recovery plants")
  edit  docs/ARCHITECTURE.md               (add one "Recovery" subsection; do not reflow others)

DO NOT TOUCH (other builders own these)
  Improvement 2 (confidentiality): src/lib/tether/sensitivity.ts, src/lib/tether/{ingest,mask}.ts,
    src/lib/tether/adapters/**, src/lib/relay/core/canary.ts and the leak check,
    data/demo/probes.json, the Connect page, the WhatsApp and #finance demo files.
  Improvement 3 (living handover, second setting): src/lib/pack/**, packs/**, src/lib/relay/**,
    src/app/w/[id]/{review,handover}/**, the landing page, data/lab/**, the findings flow,
    the role-key refactor in types.ts and withRole.ts.
  Also leave alone: src/lib/model/**, src/lib/pipeline/**, scripts/** (export
    precomputeRecovery(ws) from recovery.ts; the integrator wires it into scripts/precompute.ts),
    data/demo/ground_truth.json, data/demo/model_cache.json, tests/e2e/judge-path.spec.ts.
  If you need something in a forbidden file, write the exact request in your report instead.

HARD RULES
- No role key, person name or pack id literal anywhere under src/lib or src/app. Read roles
  from the pack (approverRole, successorRole, leaverRole, roles, roleHolders) and names from
  the people table. Improvement 3 adds a CI check that fails on such literals.
- graph.ts takes GraphSegment, which has no text field. The SQL that feeds it must not
  select segments.text.
- Every role-scoped read goes through withRole. recovery_steps is read under RLS.
- A skipped neighbour's role must not be in that row's role_set.
- The model never sets a label, a role set, a status, a rank or a score.
- Traces are always trust "inferred". Neighbour answers are always trust "second_hand".
  Ranked options are never rows in claims.
- A neighbour answer never sets gap_questions.answered_claim_id.
- Leave one marked call site, a comment reading SENSITIVITY HOOK, where a neighbour answer's
  role set is final, so improvement 2 can plug in its classifier.
- Fail visibly. A rung that throws stores a "none" row with the reason.

ORDER OF WORK (spec section 14)
1. ARCHITECTURE.md subsection, migration 0006, type additions.      1.0 h
2. graph.ts, tests first.                                            1.5 h
3. traces.ts, tests first.                                           2.0 h
4. core/ladder.ts, evidenceMix, stand-in filter, tests first.        1.5 h
5. core/options.ts, tests first.                                     1.0 h
6. recovery.ts and the small edits in lacuna/index.ts, attest/index.ts.  2.0 h
7. tests/db/recovery.test.ts.                                        0.75 h
8. Ask page and actions.                                             1.5 h
9. Demo facts, precomputeRecovery, e2e.                              1.0 h
If you fall behind, cut in the order given in spec section 14 and say what you cut.

CHECK BEFORE YOU REPORT
  pnpm db:up && pnpm db:migrate && pnpm db:seed
  pnpm lint && pnpm test          (existing 334 tests still pass, new ones pass)
  pnpm build
  pnpm test:e2e                   (judge-path and recovery)
Then walk spec section 3.7 by hand as each of the five roles.

REPORT BACK
- Files added and changed, with one line each.
- The measured version of the table in spec section 10.2 (which gap reached which rung).
- Scores before the switch, after the switch, and after each sample answer.
- Anything you needed from another lane, and anything you cut.
- For the integrator: the model cache needs a precompute run because facts F3 and F4 change
  two extraction batches.
```

---

## 16. Conflicts with the plan and open questions

| # | Plan says | What the code or data says | This spec's choice |
|---|---|---|---|
| 1 | Traces are "labelled Inferred"; and "anything it cannot quote stays Inferred", which implies quoted traces move up | A quoted workflow step is as much a record as a calendar row; but the plan's tests say "Inferred never raise K" and the done-when asks for a weaker label on every result | Always Inferred at the trace level; each step is marked Quoted or not; upgrade only through the existing corroboration rule or the approver's review. Team may choose to let fully quoted, single-file traces become From record later; it is a one-line change in `recovery.ts` |
| 2 | The panel shows "the K score showing the weaker evidence" | K is record-backed weight over covered weight. Leaver said and Second-hand are both outside the numerator, and a leaver answer adds more unbacked weight (1·w) than a second-hand one (0.5·w). K in the recovery run is equal to or higher than K in the leaver run | Do not change K. Show Closed, B, C, K and an evidence mix by trust label, with one sentence that says why K falls in both columns |
| 3 | "The judge can switch to a neighbour (Arjun, Rohan, Ananya)" | The app has roles, not people. No file maps a person to a role. Kabir, Sneha, Dev and Tanvi hold no role, yet they are the natural neighbours for the website and the lab booking | New `role_holders` table and a `roleHolders` pack key (pack files are in improvement 3's lane, so it is requested from the foundation pass). People without a role are shown and not asked |
| 4 | The plan lists three new files and one table | `verify()` in `src/lib/attest/index.ts` drops every claim it did not re-produce unless its origin is `leaver_answer`, and runs kept answers through supersession. Recovery claims would be dropped on the next pipeline run, or a trace (source kind github, authority 3 for procedure) could supersede a record | One small edit in `attest/index.ts`: carry `neighbour_answer` and `trace` claims over untouched and outside `applyRules()`. Whoever does the Round 2 extraction rework should know about it |
| 5 | "Schema migrations for all three improvements" in hours 0 to 4 | `claims.origin` has an inline check with three values; improvements 1 and 3 both need new values on the same constraint | One statement in the foundation pass with every new value; this spec's migration assumes it or adds its two values itself |
| 6 | "Ranked options give no credit" | `deterministicStandin()` gives Partial to any active claim that satisfies the check, whatever its trust | Options are not claims; plus a filter for trust `ranked_options` in the stand-in |
| 7 | "Message text is never read" | The graph needs to know which segments are about an entity. That knowledge exists only as Attest claim citations, which came from reading text earlier | The graph module itself takes no text (typed and tested). The write-up should say "the graph reads no text; topics come from claim citations by segment id" |
| 8 | Rung 2 rebuilds procedures from workflow files | In the demo the only workflow file documents a procedure that is already Covered (R01 Steps) | The workflow trace is shown under "Rebuilt procedures"; fact F4 adds a secrets step. Commit history and the calendar carry rung 2 on real gaps (R04, R06) |
| 9 | "Fewer close than when the leaver answers" | With Second-hand and Inferred capped at Partial, the expected number closed without Priya in the demo is zero | Accepted and shown as it is: `Closed 0`, several `Partly answered`. The comparison is against a projection computed by the scoring code, labelled as such |
| 10 | "Each open gap then walks a ladder" | `rankGaps()` leaves restricted checks out of the question list | Restricted gaps do not enter the ladder; they are access questions for the approver |
| 11 | Round 2 fix "re-test only the answered responsibility" has no owner | Recovery needs it for a usable answer flow | Built here as `RunTestOptions.only`; the leaver flow can adopt it at merge |
| 12 | Improvement 2's leak grid will cover "the collaboration graph, neighbour questions, recovery traces" | Those surfaces do not exist until this is built | `recoverySurfaces(ws, role)` is the single hand-off point; improvement 2 adds it to the grid |

Open questions for the team before the window:

1. Should a person with no role be askable at all (for example by giving Kabir, Sneha, Dev
   and Tanvi a "member" role in the pack)? This spec says no for Round 3.
2. Is zero gaps closed without Priya the story we want to tell, or should a fully quoted
   trace close a non-blocking check (conflict 1)?
3. Who adds `roleHolders` to `packs/club.json` and to the lab pack?
