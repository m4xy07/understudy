# Judge guide: Understudy in about 5 minutes

Live app: https://understudy-lyart.vercel.app · No sign-up · Works in a private window

**The story.** A fictional college robotics club. Priya, the outgoing tech lead, graduates. The incoming tech lead takes over. Understudy reads the club's record, tests whether the successor could do the work tomorrow, asks Priya only what the record cannot answer, and gives each role its own handover.

**Two controls do everything.**
- The **stepper** across the top (Connect, Reconstruct, Verify, Test, Ask, Review, Handover) marks each step Done, Next or To do and says what to do next.
- The **Viewing as** menu in the header switches the person. You start as **Club President**. The role is stored per workspace, and the database decides what each role can see.

---

### 1. Landing → open the demo
**Do:** press **Open the robotics-club demo**.
**Look for:** you land on Connect in a private copy of the workspace. Nobody else sees your approvals, and the run starts by itself.

### 2. Connect (role: Club President)
**Do:** wait for the **Run Understudy** panel to show every step as Done. On a fresh copy this can take a few minutes; the panel updates by itself.
**Look for:**
- Eight sources: a WhatsApp chat, three Slack channels (#events, #infra, #finance), a GitHub repo, the task board, meeting notes, a calendar.
- Per source: segments, **Masked** secrets and contacts, and **Rejected** rows with the reason.
- The data level reached (L0 to L3).
- The demo contains planted FAKE secrets. Their values never reach the database or the model; they appear as `[SECRET:<type>]`. Emails and phone numbers appear as `[CONTACT:p-n]` and are shown in full only to roles allowed to see contacts.

### 3. Claims: Reconstruct and Verify (role: Club President)
**Do:** open **Reconstruct** from the stepper, pick any claim and click its citation.
**Look for:**
- The source segment opens with the **exact quote highlighted**. A claim is "From record" only when the quote matches the source word for word.
- Trust labels in words: From record, Corroborated, Leaver said, Inferred.
- **Superseded** and **Conflicting** claims, each naming the rule that fired.
- A counter of dropped claims per source.
- Optional: the **Evaluation** button shows how the claims compare with the planted ground truth.

### 4. Test (role: Club President, testing the Incoming tech lead)
**Do:** open **Test**. "Testing as" is set to Incoming tech lead (successor).
**Look for:**
- Scores shown as **B · C · K**, never one percentage. B = blocking checks not covered. C = weighted coverage. K = the share of coverage backed by a record.
- The blocking gaps list, and a grid of Covered / Partial / Missing / Restricted per responsibility, with evidence links.
- Each responsibility's origin: task board, leaver footprint (work not on the board), or role template.
- Press **New member** under "Testing as": more checks turn **Restricted**, which means evidence exists but this role may not see it.

### 5. Ask (switch to: Priya (outgoing tech lead))
**Do:** set **Viewing as** to **Priya (outgoing tech lead)**, open **Ask**, type an answer to one or two questions and press **Save answer**. You can untick roles to narrow who sees the answer.
**Look for:**
- Up to ten questions, ranked, each saying why it was asked.
- Saved answers are labelled **Leaver said**, never verified.
- The "Re-test after this answer" line shows how B, C and K moved. C can rise; K rises only when a record backs the answer.
- Other roles see the questions read only.

### 6. Review (switch to: Club President)
**Do:** set **Viewing as** to **Club President** and open **Review**.
1. Press **Approve N tier A claims** (corroborated, low-risk claims in bulk).
2. Optional: approve a tier C claim. It needs the evidence opened and a written reason.
3. Under **Continuation plan**, give every open blocking gap an owner, a due date and a risk note.
4. Press **Approve snapshot v1**.

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

---

**Want to try your own files?** On the landing page, press **Start empty and upload my files**. Connect accepts a WhatsApp `.txt`, Slack JSON, a task board CSV, Markdown notes, an `.ics` calendar, or a public GitHub repo URL (5 MB per file). Please do not upload real or confidential data.

**If something looks stuck:** the run panel on Connect shows each step's status and any error. If the model is unreachable, the page says "Model unavailable" and the rule-based steps still run.
