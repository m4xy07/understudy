# Round 3: decisions that reconcile the specs

Planning document. Where a spec in `specs/` disagrees with this file, this file wins.
Nothing here is built before the window opens at 23:59 IST on 13 Nov 2026.

## Foundation pass (hours 0 to 4, before any feature builder starts)

Split between two builders. It must merge before the three improvement builders branch.

1. **Pack refactor** (spec 03, part A). Role keys, approver label, leaver person, prompt
   examples and demo list move into the pack. `getPack()` becomes `getWorkspacePack(ws)`.
   Club prompt examples move byte for byte so club cache keys stay stable (golden-hash test).
2. **`roleHolders` in the pack** (who holds which role), plus the `role_holders` table.
   Needed by recovery and by the lab pack. Added in this pass to `packs/club.json`.
3. **Shared types and constraints, written once:** `Claim.origin` gains
   `neighbour_answer`, `trace`, `successor_finding`. Trust gains `successor_found`
   (ranked just below Leaver said). Segment kind gains `finding`.
4. **Two Attest fixes found while planning:**
   - `verify()` keeps claims whose origin is not `extracted` or `structured` instead of
     marking them dropped.
   - Extraction skips `answer` and `finding` segments, so a re-run cannot turn a
     person's answer into a "From record" claim.
5. **CI workflow** (tests with Postgres, build, literal check, leak suite).
6. **The no-setting-literals check** covers `src/`, `db/migrations/` and `next.config.ts`.
7. **MIT licence** file, unless the team lead says otherwise.

## Migration numbers

| File | Owner |
|---|---|
| `0006_packs.sql` | foundation |
| `0007_recovery.sql` | improvement 1 |
| `0008_confidentiality.sql` | improvement 2 |
| `0009_findings.sql` | improvement 3 |
| `0010_fixes.sql` | Round 2 fixes (invite links, run leases, cleanup rule) |

## Improvement 1: recovery

- **Credit for weaker evidence.** A Second-hand answer can cover a check of weight 1 or 3.
  A blocking check (weight 5) answered only Second-hand stays Partial until a record
  backs it or the approver confirms it at review. Inferred (traces) is always Partial.
  Ranked options are never claims and give no credit. This makes "fewer close than with
  the leaver" true and non-zero.
- **Before and after panel** shows gaps closed, B, C, K and the evidence mix. The
  "with the leaver" column is a real stored run from the cached demo, not a projection,
  where one exists.
- **People with no role** are shown as close to the topic but are not asked.
- **Restricted gaps** stay out of the ladder; they go to the approver, as in Round 2.
- **CI runs.** We promised them in the Round 2 form. Add a small synthetic run history
  (`runs.json`: workflow, status, duration, commit) to the demo GitHub export and read it
  in the trace reader. Plant one gap that only the run history and workflow file answer.
- **Wording in the write-up:** the graph module never reads message text; which segments
  concern a topic comes from claims Attest extracted earlier.
- **Re-test of one responsibility** (`RunTestOptions.only`) is built here and reused by
  the leaver answer path and by findings.

## Improvement 2: confidentiality

- **Head-version rule in RLS:** a role only ever reads the newest version of a segment.
- **Fail closed:** a borderline segment is held (approver only) when the model cannot be
  asked.
- **Conflict flags:** a role sees a conflict only if it can see every side. Otherwise it
  sees a stub and the check reads Restricted. Same rule for Superseded notes.
- **Hard reworded probes** live in an evaluation set scored in a scratch workspace, not
  in the live demo sources.
- **Leak grid** columns for recovery and findings read `recoverySurfaces(ws, role)` and
  `changeTexts(ws, role)` from the other two improvements, and show "Not built" until
  those exist.
- **Manual "Limit who sees this"** is first on this improvement's cut list.
- **Order:** its pack key (`sensitivity`) lands after the foundation pass.

## Improvement 3: living handover and second setting

- **One snapshot per approved finding** this round. Batching is roadmap.
- **The approver may narrow** a finding's role set at review, never widen it.
- **Findings move no score until approved** (stricter than leaver answers, by design).
- **If the release rule blocks v2,** the finding is approved and the snapshot waits, with
  the blocker shown.
- **An attached file stays inside the finding.** It is never a new source, so a successor
  cannot upgrade their own finding to a record.
- **Demo finding** carries a date (late access next due 18 Nov 2026) so B moves.
- **Lab pack** keeps the five responsibility kinds and defines its own checks. Lab role
  keys are confirmed as specced: `pi`, `incoming_postdoc`, `phd_student`, `lab_manager`,
  `leaving_postdoc`.

## Round 2 fixes

Priority: extraction, CI, faster re-test, large uploads, small weak spots, invite links,
cleanup. Cut from the end.

- **Extraction target:** recall 70%, false conflicts 3 or fewer, supersessions 3 of 4,
  accepted only on the worse of two cold runs. The lab answer key is the hold-out.
  Hard decision at hour 40; the Round 2 prompt stays selectable.
- **Cleanup** never deletes a workspace that is locked or has an approved snapshot.
- **Empty workspaces** start open with the role switcher, with a one-way "lock roles"
  switch that turns on invite links.
- **Upload limit** copy says 4.5 MB. A per-workspace cap limits live model spend.

## Sequence

| Hours | Work |
|---|---|
| 0 to 4 | Foundation pass |
| 4 to 28 | Improvements 1, 2, 3 (living handover) and the lab pack in four worktrees; demo data additions alongside |
| 20 | Improvement 2's ingest narrowing merged; extraction re-baselined after it |
| 28 to 36 | Merge all; Round 2 fixes; extraction work |
| 36 | Rehearsal on a preview deployment |
| 40 | Prompt and data freeze |
| 40 to 43 | One precompute for both demos; seed production; deploy |
| 43 to 62 | Judge walkthrough of both settings on the live link; fixes; PDF and notes |
| 62 | Final production deploy |
| 68 | Code freeze |
| 70 | Submit |

## Contributions and commits

- Module ownership follows Rounds 1 and 2: Aman (Tether, recovery lead), Om (Attest,
  trace verification, lab pack), Advait (Lacuna, gap routing, living handover lead),
  Yash (Relay, confidentiality lead, interface).
- A commit carries the identity of whoever made it. Work done from the team lead's
  machine is committed as him. Members who work from their own machines commit as
  themselves.
- Contribution statements describe what each person did, including that AI coding tools
  wrote much of the code under the team's direction, as disclosed in Round 2.

## Open with the team lead

- A second Supabase project for the hour-36 rehearsal (otherwise rehearse against the
  live database in an isolated schema).
