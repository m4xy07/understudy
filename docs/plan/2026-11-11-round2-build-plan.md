# Understudy: Round 2 build plan

**Goal.** One public link where a judge, with no help, runs the whole loop
(Connect, Reconstruct, Verify, Test, Ask, Review, Handover) on the robotics-club
demo pack or on their own files, opens the source behind any claim, and sees
what is still unresolved. We build the Round 1 minimum loop exactly, plus the
cheap extras.

**What the judges score (Round 2, 100 points).** Core workflow end to end 30,
technical depth and reliability 25, progress against the Round 1 plan 20, the
three Round 3 commitments 15, usability without a walkthrough 10.

---

## 1. Decisions (what stays from Round 1, what changes, and why)

| Area | Round 1 plan | Round 2 build | Why |
|---|---|---|---|
| Interface | Next.js + TypeScript | Same, deployed on Vercel | |
| Database | Supabase Postgres, row-level security (RLS) | Same. Every role-scoped read runs in a transaction as a restricted Postgres role, with the viewer's role in `request.jwt.claims`; RLS policies decide what rows exist for that role. Compile, successor test and gap questions all read through this path. | RLS stays the compile boundary, as promised |
| Workers | Python 3.12 workers on a Postgres job queue | TypeScript server code in the same Next.js app; each pipeline run is a row in a `runs` table with per-step progress | One deployable link, one language, faster build. Disclosed as a change. |
| Masking | detect-secrets + Presidio (Python) | TypeScript port of the same detector types: known key formats (GitHub, AWS, Slack, private keys, passwords in config), an entropy check for unknown tokens, email and phone patterns. Secrets discarded; contacts tokenised as `[CONTACT:p-n]` and stored AES-GCM encrypted for roles allowed to see them | The Python libraries cannot run inside the Next.js app. Disclosed. |
| Model | Qwen3 8B on Ollama, cached by input hash | Local: Qwen3 8B on Ollama (RTX 5070 Ti) precomputes the demo pack. Deployed: the same Qwen3 8B weights through an OpenAI-compatible hosted endpoint, used only for judge uploads. Every output cached by input hash + model tag, so the demo replays instantly and identically. If no model is reachable, extraction shows "pending" and structured sources still work. | A public link cannot reach a laptop GPU. Demo data is synthetic. |
| Who is who | Accounts per project | A role switcher (Club President = approver, incoming tech lead, new member, treasurer, Priya = leaver). Each visitor gets a private copy of the workspace, so judges never see each other's approvals. The leaver can never approve (enforced on the server). | The form requires links that work for anyone not signed in |
| Dataset | about 1,500 messages, 300 commits, 120 tasks, 25 documents | about 300 chat messages, 60 commits, 40 tasks, 5 notes, 1 calendar, with planted ground truth (claims, gaps, supersessions, conflicts, restricted items, off-board duties, canary tokens) | Time. Round 2 reports measured numbers, not the Round 1 design values (73 / 61 / 38 claims, B 7 to 1). |

## 2. What a judge does (the product flow)

1. **Landing.** Three lines on what Understudy is. Two buttons: "Open the robotics-club demo" and "Start empty and upload my files". A data warning before any upload.
2. **Connect** (Tether). Sources with segment counts, masked-secret counts, rejected rows and why, and the data level reached (L0 to L3). Upload: WhatsApp `.txt`, Slack-format JSON, task-board CSV, markdown, calendar ICS, a public GitHub repo URL.
3. **Reconstruct and Verify** (Attest). The claim ledger: each claim has an attribute from the closed list of eleven, a trust label and citations. Click a claim to open its source segment with the quote highlighted. Conflicting and Superseded claims shown with the rule that fired. A counter of dropped claims per source.
4. **Test** (Lacuna). Responsibility inventory (origin: task board, leaver footprint or role template), typed checklists, and per-role scores shown as B, then C, then K. Grid of Covered / Partial / Missing / Restricted.
5. **Ask** (Lacuna). Up to ten ranked gap questions. Switch to Priya, answer; answers come back labelled "Leaver said"; the re-test shows the B, C, K change.
6. **Review** (Relay). Tiers A (bulk approve), B (one by one: approve, edit, reject), C (evidence opened, written reason). Continuation plan for open blocking gaps (owner, due date, risk note). Approve snapshot: SHA-256 hash shown; release rule enforced.
7. **Handover** (Relay). Switch role: the I-PASS-ordered handover compiled for that role, with restricted stubs ("2 restricted items. Ask the approver (Club President)."), a decision timeline, typed read-back of the five critical items checked by code, an acknowledgement record, version history, and a canary-check panel that proves no restricted token reached this role's output.

A stepper across the top always says which step is next and why.

## 3. Phases and ETA

Times are working hours for me; parallel tracks run as separate agents.

| Phase | What gets built | ETA |
|---|---|---|
| P0 Setup | Accounts, public repo, Next.js scaffold, Postgres schema + RLS policies, deploy a skeleton to Vercel. Ollama + `qwen3:8b` download in the background. | 1 h |
| P1 Walking skeleton (gate G1) | Synthetic dataset generator + ground-truth file; all six adapters emitting one segment format with stable IDs and content hash; masking; identity matching on keyed email hash; a stub extractor; all seven screens wired end to end. Deployed. | 2.5 h |
| P2 Real parts (gate G2), three tracks in parallel | **Attest:** extraction per thread per role set with JSON schema, citation verifier (normalise, exact substring), support check (can only downgrade), supersession and conflict rules, append-only ledger, cache. **Lacuna:** inventory (board, footprint thresholds, role template), five checklist kinds, stand-in successor with code-checked citations, B / C / K, ranked questions, answers, re-test, continuation plan. **Relay:** tiers, snapshot hash and release rule, per-role compile under RLS, stubs, I-PASS view, timeline, read-back, acknowledgement, canary suite. | 3 h |
| P3 Precompute and evaluation | Run Qwen3 8B over the pack locally, store the cache; evaluation harness against the planted truth (claim precision and recall, citation pass rate, false conflicts, canary pass), shown on an Evaluation page and in the repo. | 1 h |
| P4 Judge-proofing (gate G3, feature freeze) | Guided stepper, empty and error states, Playwright run of the full flow on the live URL in a fresh browser, fixes. | 1.5 h |
| P5 Submission pack | README (judge walkthrough, setup, architecture), DISCLOSURES (AI assistance, libraries, services), TESTING; updated Round 2 PDF built with the Round 1 toolkit, with screenshots; answers for every form field, ready to paste. | 2 h |
| **Total** | | **about 11 h of work, about 8 to 9 h wall-clock** |

Your part: about 30 minutes (logins and keys at P0, upload the PDF to Drive, test every link in a private window, submit the form).

**If the deadline is tighter, cut in the Round 1 order:** (1) markdown and ICS adapters, (2) the model support check, (3) tier C written reasons, (4) timeline polish and I-PASS styling, (5) read-back beyond the five critical items.

**Never cut (Round 1 minimum loop):** three adapters (chat, GitHub, task-board CSV), claims cited with the exact-quote rule, the successor test with B, C and K, up to ten gap questions and a re-test, one approver with hashed snapshot and release rule, two role views with stubs passing the canary test.

## 4. Round 3 commitments (unchanged from Round 1)

1. **Unreachable-leaver recovery.** Done when, with "leaver unreachable" on, the same gaps reach a knowledge neighbour and a trace, fewer close, and every result shows its weaker label.
2. **Content-level confidentiality.** Done when the wider canary suite (every role, every output, including stubs and conflict flags) passes and paraphrase probes are written up.
3. **Living handover and a second setting.** Done when a successor finding goes through review into snapshot v n+1 with the score change explained, and the research-group pack runs with zero core code changes.

## 5. Rules we keep

- All product code is written inside the build window; commits go in small steps so the history shows the work.
- AI assistance (Claude Code) and every library and hosted service are disclosed in `DISCLOSURES.md` and the PDF.
- Synthetic data only; the upload screen warns against real or confidential data.
