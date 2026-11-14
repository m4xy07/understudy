# Judge guide: Understudy in about ten minutes

Live app: https://understudy-lyart.vercel.app · No sign-up · Works in a private window

**What is here.** Two demos and three Round 3 improvements. Steps 1 to 7 walk the robotics-club demo (about six minutes). Steps 8 to 10 show the improvements: First weeks, recovery, and sensitive content. The last section is the research-group demo.

**The story.** A fictional college robotics club. Priya, the outgoing tech lead, graduates. The incoming tech lead takes over. Understudy reads the club's record, tests whether the successor could do the work tomorrow, asks Priya only what the record cannot answer, and gives each role its own handover.

**Two controls do everything.**
- The **stepper** across the top (Connect, Reconstruct, Verify, Test, Ask, Review, Handover) marks each step and says what to do next. After the first snapshot, **First weeks** appears at its right end.
- The **Viewing as** menu in the header switches the person. You start as **Club President**. The role is stored per workspace, and the database decides what each role can see.

---

### 1. Landing → open the demo
**Do:** press **Open the robotics-club demo**.
**Look for:** you land on Connect in a private copy of the workspace. Nobody else sees your approvals, and the run starts by itself.

### 2. Connect (role: Club President)
**Do:** wait for the **Run Understudy** panel to show every step as Done. The demo replays precomputed model answers, so a fresh copy finishes in a few seconds. Your own uploads call the model live and can take a few minutes; the panel updates by itself.
**Look for:**
- Eight sources and 466 segments: a WhatsApp chat, three Slack channels (#events, #infra, #finance), a GitHub repo, the task board, meeting notes, a calendar.
- The run panel line "Read 31 batches (31 from the cache)" and, at the end, "Run finished. Open Reconstruct to see the claims."
- Per source: segments, **Masked** secrets and contacts, and **Rejected** rows with the reason.
- The data level reached (L0 to L3).
- The **Sensitive content** panel under the sources (step 10 below).
- The demo contains planted FAKE secrets. Their values never reach the database or the model; they appear as `[SECRET:<type>]`. Emails and phone numbers appear as `[CONTACT:p-n]` and are shown in full only to roles allowed to see contacts.

### 3. Claims: Reconstruct and Verify (role: Club President)
**Do:** open **Reconstruct** from the stepper, pick any claim and click its citation.
**Look for:**
- The source segment opens with the **exact quote highlighted**. A claim is "From record" only when the quote matches the source word for word.
- Trust labels in words: From record, Corroborated, Leaver said, Successor found, Second-hand, Inferred.
- **Superseded** and **Conflicting** claims, each naming the rule that fired.
- A counter of dropped claims per source.
- Optional: the **Evaluation** button shows how the claims compare with the planted ground truth.

**Claim history.** Every claim row has a **History** link.
**Do:** on **Reconstruct**, set the State filter to **superseded**, press **Filter**, then press **History** on any claim.
**Look for:**
- A timeline, oldest first: what happened, when, and by which role ("System" for the pipeline).
- For a superseded or conflicting claim, the rule that fired, for example "Rule: the task board owns deadlines". When the role can see the winning claim, a link to it.
- **Open source** links for each citation. A claim with no changes says "No changes since this claim was created."
- As Club President, open the history of a claim that cites Slack #finance. Switch **Viewing as** to **New member** and reload: the page says "Claim not found", the same as for an id that does not exist. The database decides, not the page.

### 4. Test (role: Club President, testing the Incoming tech lead)
**Do:** open **Test**. "Testing as" is set to Incoming tech lead (successor).
**Look for:**
- Scores shown as **B · C · K**, never one percentage. B = blocking checks not covered. C = weighted coverage. K = the share of coverage backed by a record.
- The blocking gaps list, and a grid of Covered / Partial / Missing / Restricted per responsibility, with evidence links.
- Each responsibility's origin: task board, leaver footprint (work not on the board), or role template.
- Press **New member** under "Testing as": more checks turn **Restricted**, which means evidence exists but this role may not see it.

### 5. Ask (switch to: Priya (outgoing tech lead))
**Do:** set **Viewing as** to **Priya (outgoing tech lead)**, open **Ask**. On the first question press **Use a sample answer** (or type your own), then **Save answer**. You can untick roles to narrow who sees the answer. Leave "When exactly is Late-night lab access next due?" open: step 8 uses it.
**Look for:**
- Up to ten questions, ranked, each saying why it was asked.
- Saved answers are labelled **Leaver said**, never verified.
- The "Re-test after this answer" line shows how B, C and K moved. C can rise; K rises only when a record backs the answer.
- Other roles see the questions read only.

### 6. Review (switch to: Club President)
**Do:** set **Viewing as** to **Club President** and open **Review**.
The **Where to start** box lists the five steps in order and ticks each one off.
1. Press **Approve N tier A claims** (corroborated, low-risk claims in bulk).
2. Under **Tier B by responsibility**, open a group, read its claims (each has an **Open evidence** link), then press **Approve these N claims**. The button stays off until the list was opened. Do this for as many groups as you like; the read-back on Handover fills in as its claims are approved (competition date, domain renewal date, the weekly lab day).
3. Optional: approve a tier C claim. It needs the evidence opened and a written reason, one claim at a time.
4. Under **Continuation plan**, give every open blocking gap an owner, a due date and a risk note.
5. Press **Approve snapshot v1**.

**Look for:**
- Before the plan is complete, approval is blocked and the page lists what is missing.
- After approval: a SHA-256 hash and version v1 in the history. With open gaps the release line reads "Released with N open blocking gaps", never "complete".
- Try it as Priya: "The leaver can never approve." The server enforces this, not just the button.

### 7. Handover (switch to: Incoming tech lead, then New member)
**Do:** set **Viewing as** to **Incoming tech lead** and open **Handover**.
**Look for:**
- I-PASS order: workstream status (B, C, K, release state), project summary, action list, situation and contingency, synthesis.
- A decision timeline and open items. Numbers in brackets open the source with the quote highlighted.
- The stub: "N restricted items. Ask the approver (Club President)." No topic, owner or value is shown.

**Do:** type the five read-back items (competition date, firmware rollback command, sponsor contact at Vertex Motors, domain renewal date, the lab day), press **Check my read-back**, then **Acknowledge receipt**.
**Look for:** a verdict per item checked by code, and a new row under Acknowledgements with role, time and snapshot hash. An item whose claim you did not approve shows "Nothing to check": the read-back only compares against the approved snapshot.

**Do:** switch **Viewing as** to **New member** on the same page.
**Look for:** nothing restricted. Approved claims from sources the New member may not see (Slack #infra, #finance) drop out and the stub count grows. If you approved only tier A claims, the two views can look alike, because tier A claims come from sources every role can see.

**Then scroll to Leak check.** It compiles every role's handover and scans every surface (handover text, export, stubs, scores, timeline, questions) for the planted `CANARY-` tokens. Each cell should pass: a token may appear only for roles allowed to see it.

Optional: **Download handover (Markdown)** exports the current role's view.

### 8. First weeks: the handover keeps improving (switch to: Incoming tech lead, then Club President)
**Do:** as **Incoming tech lead**, open **First weeks** (right end of the step row, or the link under the release banner). On "Late-night lab access: Next due date" press **Record a finding**, then **Use the example finding**, then **Save finding**. If that gap is gone because Priya answered it in step 5, press **Record a finding** on any other open gap and type an answer; the rest of the step works the same way.
**Look for:** the row reads "Waiting for review". It is saved as evidence labelled "Successor found". The scores and the handover have not changed.

**Do:** switch to **Club President**, open **Review**. Under **Successor findings (1)** read the evidence, tick "I opened the evidence", write a reason and press **Approve and release v2**.
**Look for:** "Finding approved. Snapshot v2 released. B 6 → 5." (numbers depend on the run). Version history shows v1 and v2 with "Finding approved: ..." and a stored diff. On **Handover**, "What changed in v2" lists the claim added, the gap closed and B, C and K with one sentence each. K does not rise: a finding is a person's word until a record agrees.

### 9. Recovery: the leaver cannot be reached (switch to: Club President, then Incoming tech lead)
This works at any point after the run. A fresh copy of the demo is the cleanest place to try it.

**Do:** as **Club President**, open **Ask**. In the card "Can Priya answer?" type a reason if you like and press **Priya can't be reached**.
**Look for:**
- A banner "Priya can't be reached" with who switched it on and when. Priya's answer boxes are closed.
- **With Priya and without**: two columns, "If Priya answered" and "Without Priya, so far". Fewer gaps close without her, and the evidence is weaker.
- **Gaps being worked (N)**: each gap goes down three rungs.
  1. **People who worked on this.** Who was closest to the topic and why, built from counts only. Some say "Skipped: no access." or "Not asked: no role in this handover."
  2. **What the files and history show.** Procedures rebuilt from workflow files, CI runs, commits and the calendar, labelled Inferred.
  3. **Possible answers.** "Leads, not answers. They never close a gap."
- **Rebuilt procedures (N)** at the bottom: each step is marked "Quoted" or "Worked out from history", with a link to its source.

**Do:** press **Switch to Arjun to answer**. Under **Questions for you**, press **Use a sample answer**, then **Save answer**. On another question you can press **I don't know**.
**Look for:** the line Saved as "Second-hand", and B reads "(no change)" when the check is a blocking one: a second-hand answer does not close a blocking gap until the approver approves it in Review. "I don't know" stores nothing as evidence.

**Do:** switch back to **Club President** and press **Priya is back. Use the normal flow**.
**Look for:** the normal questions return. What the neighbours said stays, with its label.

### 10. Sensitive content, the leak check and the probes page (role: Club President, then New member)
**Do:** as **Club President**, open **Connect** and scroll to **Sensitive content**.
**Look for:**
- The count line, "9 limited · 0 held for you to check · 0 widened by you" on a fresh club demo.
- Each row: the kind (Money, People matter, Health), why it was limited ("Found by a rule" or "Found by the model"), the roles that can still see it, and **Open message**.
- **Widen** on a row asks who should see it and why (at least 10 characters), then **Widen and re-run**. Only the approver can widen. On a message's own page the approver also has **Limit who sees this**. Both are written to the audit log.

**Do:** switch **Viewing as** to **New member** on the same page.
**Look for:** no message text, only a count: "N messages in sources you can open are limited to fewer roles. Ask the approver (Club President)."

**Do:** open **Handover** and scroll to **Leak check**.
**Look for:**
- Two tables, one row per role and one column per output. **Exact tokens** looks for the planted `CANARY-` tokens letter for letter. **Reworded facts** looks for restricted facts said in other words.
- Each cell reads a pass with the number of texts checked, "Nothing to check", or a finding.
- **See probe results** opens the Probe results page: how the classifier scored on a labelled set, what the two detectors caught, and a **Missed** section with what got through. As Club President, **Run probes again** asks the model judge once more.

---

### A second setting: the research-group demo

The landing page has two cards. **Open the research-group demo** runs the same seven steps on a different organisation, with no change to the product's code: one pack file (`packs/lab.json`) and one data folder.

- **The story.** A fictional university research group. Farhan, a postdoc, leaves for a new post. The incoming postdoc takes over the analysis pipeline, the sequencing bookings and the approvals.
- **Roles in "Viewing as":** Principal investigator (the approver; you start here), Incoming postdoc (the successor), PhD student (sees least), Lab manager, Farhan (outgoing postdoc).
- **Sources:** seven sources and 191 segments: three Slack channels (#lab-general, #pipeline, #lab-admin), a git repository, a lab notebook, a task sheet and a calendar. No WhatsApp. The run reads 25 batches from the cache and finishes in a few seconds.
- **Look for:** different checklists on Test (for example "Dataset provenance" and "Environment pin and rollback"); the stub line reads "N restricted items. Ask the approver (Principal investigator)."; the read-back asks for the biosafety renewal date, the environment restore command, the sequencing core contact, the revision due date and the lab meeting day; the leak check scans for the lab's own six canary tokens.
- **Evaluation** (button on the Claims page) scores this workspace against the lab's answer key. The lab is our hold-out: nothing was tuned to it. Numbers: [EVALUATION.lab.md](EVALUATION.lab.md).

---

**Want to try your own files?** On the landing page, press **Start empty and upload my files**. Connect accepts a WhatsApp `.txt`, Slack JSON, a task board CSV, Markdown notes, an `.ics` calendar, or a public GitHub repo URL (4.5 MB per upload). Please do not upload real or confidential data.

**If something looks stuck:** the run panel on Connect shows each step's status and any error. If the model is unreachable, the panel says so and the rule-based steps still run.

**Running it yourself:** the [README](../README.md#run-it-locally) takes a fresh clone to both demos in about ten minutes, with no model key.
