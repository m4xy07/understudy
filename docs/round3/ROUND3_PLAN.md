# Understudy: Round 3 plan

Planning document only. No product code is written or committed before the build
window opens. This file lives outside the product repository on purpose.

**Window:** opens 23:59 IST on Fri 13 Nov 2026, closes 23:59 IST on Mon 16 Nov 2026 (72 hours).
**Measured against:** the three improvements we named in Round 2 (event rule 21).
**Starting point:** main at `05473dd`, live at https://understudy-lyart.vercel.app, 334 tests plus the end-to-end judge path.

## What the organisers ask for

The final product should work from beginning to end, include all three promised
improvements, have a reliable core workflow, show stronger technical work, be more
usable and practical, fix important Round 2 bugs, and explain any change of plan.

Submission (format still to be announced): working link, repository, updated PDF,
completed-improvements list, technical details, testing notes, and each member's
contribution. Every member files their own entry (event rule 18).

---

## Improvement 1: Unreachable-leaver recovery (lead: Aman; with Advait and Om)

**Done when:** with "leaver unreachable" switched on, the same gaps reach a knowledge
neighbour and a trace, fewer close than when the leaver answers, and every result shows
its weaker trust label.

### What a judge sees
- A switch on the Ask page: "Priya can't be reached". Approver only, logged.
- Each open gap then walks a ladder, shown as three rungs with the result of each:
  1. **Neighbours.** The two or three people closest to that topic, with why they were
     picked ("replied in 14 threads about the sponsor"). Each is asked only if their role
     may see the topic; otherwise the rung says "skipped: no access", never the content.
     The judge can switch to a neighbour (Arjun, Rohan, Ananya) and answer. The answer is
     labelled **Second-hand**.
  2. **Traces.** Procedures rebuilt from workflow files, commit history and calendar
     recurrences, labelled **Inferred**, each step citing the file or commit it came from.
  3. **Ranked options.** For what is still open, two or three candidate answers with the
     evidence for each, labelled **Ranked options**. These never count as answered.
- A before and after panel: gaps closed with the leaver against gaps closed without her,
  and the K score showing the weaker evidence.

### How it is built
- `src/lib/tether/graph.ts`: collaboration graph from metadata only. Nodes are people;
  edges are replies in the same thread, co-changed file paths and shared calendar events.
  Message text is never read. Neighbour score per entity = interactions about that
  entity's segments (by segment id, not content) weighted by recency.
- `src/lib/tether/traces.ts`: trace reader. Parses workflow YAML (jobs, steps, triggers,
  secrets by name), commit sequences touching a path (what changes together, in what
  order), and calendar recurrences into ordered steps with citations.
- `src/lib/lacuna/recovery.ts`: the ladder. Gap router picks rungs per gap, builds
  neighbour questions only from claims that neighbour may see (read under their role),
  stores each rung's outcome. Scoring: Second-hand and Inferred raise C, not K; ranked
  options give no credit.
- New table `recovery_steps` (gap, rung, target person or trace, status, claim id).
- Attest verifies trace-derived claims with the same exact-quote rule against the cited
  file or commit; anything it cannot quote stays Inferred.
- The switch is stored on the workspace; turning it off restores the normal Ask flow.

### Tests
Graph is built without reading text (test passes segments with text removed and gets
the same graph). A neighbour without access is skipped and sees nothing. Second-hand and
Inferred never raise K. Ranked options never close a gap. End-to-end: switch on, answer
as a neighbour, fewer gaps closed than the leaver run.

---

## Improvement 2: Content-level confidentiality (lead: Yash; with Aman)

**Done when:** the wider leak test passes for every role and every output, including
restricted notes and conflict flags, and the reworded-fact probe results are written up.

### What a judge sees
- On Connect, a "Sensitive content" panel: messages in open channels that look like
  finance, HR or health content, each already narrowed to the roles allowed to see that
  category, with the reason ("mentions a medical condition"). Only the approver can widen
  one again, and must write why. Every change is in the audit log.
- The demo pack gains planted cases: a medical excuse and a fee dispute posted in the
  main group chat. A new member never sees them or anything derived from them.
- The Leak check grid grows: more surfaces (conflict flags, the collaboration graph,
  neighbour questions, recovery traces, stubs) and a second row type, **paraphrase
  probes**: restricted facts planted in reworded form, checked by meaning.
- A written results page (in the app and in the repo) with what was caught and missed.

### How it is built
- `src/lib/tether/sensitivity.ts`: classifier run at ingest, before storage of the role
  set and before any model call. Stage one is rules (category lexicons, amounts with
  currency, health terms, HR terms). Stage two asks the model about borderline segments
  only, batched by role set, cached. It can only narrow.
- Category to roles map lives in the setting pack (`sensitivity: { finance: [...] }`).
- `segments.sensitivity`, `segments.role_set_original`; widening goes through an approver
  action that writes `audit_log` and bumps the segment version.
- Paraphrase probes: `data/demo/probes.json` holds each restricted fact with reworded
  forms and key terms. The probe checks every output surface for each role with a
  normalised key-term match plus a model judge ("does this text reveal fact X"), and the
  model judge can only add findings, never clear one.
- Policies: a conflict flag is shown to a role only if that role can see both sides;
  otherwise it becomes a stub. Graph edges derived from restricted segments are hidden
  from roles that cannot see those segments.

### Tests
Sensitive segments in an open channel are narrowed before extraction (no model call
contains them for a wider role set). Widening needs the approver and a reason. Conflict
flag with one hidden side never reveals the hidden value. Probe suite runs for five
roles across every surface and is part of `pnpm test`.

---

## Improvement 3: Living handover and a second setting (lead: Advait; with Om)

**Done when:** a successor finding goes through review into the next snapshot with the
score change explained, and the research-group setting runs with zero core code changes.

### What a judge sees
- After approval, the incoming tech lead gets a **First weeks** page: the open gaps as a
  checklist, each with its owner and due date from the continuation plan.
- The successor records what they found ("Mr. Pawar confirmed late access is every
  Wednesday") with an optional link or file. It becomes evidence labelled
  **Successor found**, goes through the same checks, and waits in the approver's review.
- When the approver approves it, snapshot v2 is created. A "What changed" panel shows
  the claim added, the gap closed and the score moving (B 5 to 4), with the reason.
- On the landing page, a second demo: **University research group**. Same seven steps,
  different roles (PI, postdoc, PhD student, lab manager), different checklists
  (protocols, dataset provenance, compute environments, agreements).

### How it is built
- `findings` flow: finding becomes a segment (kind `finding`, source "First weeks"),
  then a claim with new trust label `successor_found` (ranked beside Leaver said: raises
  C, not K, until a record backs it). Role set can be narrowed, never widened.
- Review shows findings in their own group; approval triggers a re-test and a snapshot
  with a stored diff and score delta text.
- `packs/lab.json` and `data/lab/` (synthetic lab corpus with its own planted answer
  key). The pack carries roles, entities, checklists, source authority, read-back items,
  sensitivity map.
- Proof of "zero core code changes": a test that runs the whole pipeline on the lab pack,
  and a CI check that fails if anything under `src/lib` mentions a pack id or a role key
  literal outside the pack loader. Round 2 hardcodes five role keys in `types.ts` and
  "Club President" in the stub text; both move into the pack first.

### Tests
Finding to review to snapshot v2 with the delta explained. Lab pack pipeline end to end.
The no-setting-literals check.

---

## Round 2 issues to fix inside the window

| Issue | Fix |
|---|---|
| Extraction recall 57.7%, 5 false conflicts | Two-pass extraction (candidate facts, then per-entity consolidation), thread context, per-entity recall targets in the evaluation |
| A kickoff date can be filed under the competition | Event-binding rule: a deadline needs the event named in the same quote |
| Uploads can pass the 5-minute function limit | Run extraction in resumable chunks with progress, so a large upload finishes across requests |
| No sign-up | Workspace invite links per role (signed tokens), keeping the role switcher only for the demo |
| Old workspaces never cleaned up | Scheduled cleanup (Vercel cron) calling the existing purge function |
| No CI | GitHub Actions: tests, build, leak and probe suites on every push |
| Leaver answer re-test takes 6 to 16 s | Re-test only the answered responsibility |

## Order of work across the 72 hours

| When | Work |
|---|---|
| Hours 0 to 4 | Move role keys and approver label into the pack (unblocks the second setting). CI workflow. Schema migrations for all three improvements. |
| Hours 4 to 28 | Three improvements in parallel, one worktree each, pure logic with tests first, then pages. Demo data additions (sensitive plants, probes, lab corpus) alongside. |
| Hours 28 to 40 | Merge, Round 2 fixes, extraction accuracy work, precompute the new demo answers. |
| Hours 40 to 52 | Deploy, full judge walkthrough on the live link for both settings, fix what breaks. |
| Hours 52 to 64 | Final PDF, testing notes, completed-improvements list, contribution statements, demo video if asked. |
| Hours 64 to 72 | Buffer. Freeze by hour 68. Nothing pushed after the deadline. |

## Decisions for the team before the window opens

1. **Contributions.** Rule 18 asks each member to state the part they built, and judges
   may ask any member to explain it. Every commit so far carries one git identity. Decide
   how each member takes part in Round 3 and make sure statements match what happened.
2. **Demo video.** Record one if the submission format asks for it.
3. **Sign-in.** Invite links are the planned answer. Full accounts are out of scope.
