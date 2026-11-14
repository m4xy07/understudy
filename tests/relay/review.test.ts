import { describe, expect, it } from "vitest";
import { applyReview, assignTier, bulkApproveTierA } from "@/lib/relay/core/review";
import { AT, makeClaim } from "./fixtures";
import { CLUB_RESTRICTED, CLUB_ROLES } from "../helpers/club";

describe("applyReview", () => {
  it("lets the president approve a tier B claim and emits one append-only event", () => {
    const claim = makeClaim({ id: "c1", tier: "B" });
    const r = applyReview(claim, { type: "approve", by: "president", at: AT }, CLUB_ROLES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.review).toBe("approved");
    expect(claim.review).toBe("pending"); // input untouched
    expect(r.event).toMatchObject({ type: "claim_approved", claimId: "c1", by: "president", at: AT });
    expect(Object.keys(r.event).sort()).toEqual(["at", "by", "claimId", "payload", "type"]);
  });

  it("never lets the leaver review", () => {
    for (const type of ["approve", "reject", "edit"] as const) {
      const r = applyReview(makeClaim({ id: "c1" }), { type, by: "leaver", newValue: "x", note: "a long enough note", evidenceOpened: true }, CLUB_ROLES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("leaver_cannot_approve");
    }
  });

  it("rejects any non-approver role (tech_lead, treasurer, new_member)", () => {
    for (const by of ["tech_lead", "treasurer", "new_member"] as const) {
      const r = applyReview(makeClaim({ id: "c1" }), { type: "approve", by }, CLUB_ROLES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_approver");
    }
  });

  it("tier C needs evidence opened and a written reason of 10+ characters", () => {
    const claim = makeClaim({ id: "c1", tier: "C" });
    const noEvidence = applyReview(claim, { type: "approve", by: "president", note: "Checked the deploy log." }, CLUB_ROLES);
    expect(noEvidence.ok === false && noEvidence.code).toBe("evidence_not_opened");
    const shortNote = applyReview(claim, { type: "approve", by: "president", evidenceOpened: true, note: "  ok fine " }, CLUB_ROLES);
    expect(shortNote.ok === false && shortNote.code).toBe("reason_required");
    const good = applyReview(claim, { type: "approve", by: "president", evidenceOpened: true, note: "Checked the deploy log.", at: AT }, CLUB_ROLES);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.claim.reviewNote).toBe("Checked the deploy log.");
      expect(good.event.payload).toMatchObject({ tier: "C", evidenceOpened: true });
    }
  });

  it("edit keeps citations and trust, sets review 'edited' and records before/after", () => {
    const claim = makeClaim({ id: "c1", trust: "inferred" });
    const r = applyReview(claim, { type: "edit", by: "president", newStatement: "Flash with make flash-safe.", newValue: "make flash-safe", at: AT }, CLUB_ROLES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.review).toBe("edited");
    expect(r.claim.trust).toBe("inferred"); // never upgraded
    expect(r.claim.citations).toEqual(claim.citations);
    expect(r.claim.statement).toBe("Flash with make flash-safe.");
    expect(r.claim.value).toBe("make flash-safe");
    expect(r.event.type).toBe("claim_edited");
    expect(r.event.payload).toMatchObject({
      before: { statement: claim.statement, value: claim.value },
      after: { statement: "Flash with make flash-safe.", value: "make flash-safe", review: "edited" },
    });
  });

  it("an edit with no new text is refused", () => {
    const r = applyReview(makeClaim({ id: "c1" }), { type: "edit", by: "president", newStatement: "   " }, CLUB_ROLES);
    expect(r.ok === false && r.code).toBe("edit_empty");
  });

  it("dropped claims cannot be reviewed; superseded claims can only be rejected", () => {
    expect(applyReview(makeClaim({ id: "c1", state: "dropped" }), { type: "reject", by: "president" }, CLUB_ROLES).ok).toBe(false);
    expect(applyReview(makeClaim({ id: "c2", state: "superseded" }), { type: "approve", by: "president" }, CLUB_ROLES).ok).toBe(false);
    expect(applyReview(makeClaim({ id: "c3", state: "superseded" }), { type: "reject", by: "president" }, CLUB_ROLES).ok).toBe(true);
  });
});

describe("bulkApproveTierA", () => {
  it("approves pending tier A claims only", () => {
    const claims = [
      makeClaim({ id: "a1", tier: "A" }),
      makeClaim({ id: "a2", tier: "A", review: "rejected" }),
      makeClaim({ id: "b1", tier: "B" }),
      makeClaim({ id: "c1", tier: "C" }),
      makeClaim({ id: "a3", tier: "A" }),
    ];
    const r = bulkApproveTierA(claims, "president", CLUB_ROLES, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.approvedIds).toEqual(["a1", "a3"]);
    expect(r.claims.map((c) => c.review)).toEqual(["approved", "rejected", "pending", "pending", "approved"]);
    expect(r.events.map((e) => e.claimId)).toEqual(["a1", "a3"]);
  });

  it("refuses the leaver", () => {
    const r = bulkApproveTierA([makeClaim({ id: "a1", tier: "A" })], "leaver", CLUB_ROLES);
    expect(r.ok === false && r.code).toBe("leaver_cannot_approve");
  });
});

describe("assignTier", () => {
  it("follows the contract: C sensitive/conflicting/blocking, A corroborated normal unflagged, else B", () => {
    expect(assignTier(makeClaim({ id: "x", roleSet: ["president", "treasurer"] }), CLUB_RESTRICTED)).toBe("C");
    expect(assignTier(makeClaim({ id: "x", state: "conflicting" }), CLUB_RESTRICTED)).toBe("C");
    expect(assignTier(makeClaim({ id: "x", importance: "blocking" }), CLUB_RESTRICTED)).toBe("C");
    expect(assignTier(makeClaim({ id: "x", trust: "corroborated" }), CLUB_RESTRICTED)).toBe("A");
    expect(assignTier(makeClaim({ id: "x", trust: "corroborated", supportCheck: "partly" }), CLUB_RESTRICTED)).toBe("B");
    expect(assignTier(makeClaim({ id: "x", trust: "from_record" }), CLUB_RESTRICTED)).toBe("B");
  });
});
