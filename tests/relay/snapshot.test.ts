import { describe, expect, it } from "vitest";
import {
  approveSnapshot, buildSnapshotPayload, canonicalJson, computeReleaseState, diffSnapshots,
  hashSnapshot, releaseLabel, verifySnapshot,
} from "@/lib/relay/core/snapshot";
import type { Scores } from "@/lib/types";
import { AT, makeClaim, makePlan } from "./fixtures";
import { CLUB_ROLES } from "../helpers/club";

const scores: Scores = { b: 1, c: 0.91, k: 0.5 };

function payloadOf(claims = [
  makeClaim({ id: "c2", review: "approved" }),
  makeClaim({ id: "c1", review: "edited", roleSet: ["tech_lead", "president"] }),
  makeClaim({ id: "c3", review: "pending" }),
  makeClaim({ id: "c4", review: "rejected" }),
  makeClaim({ id: "c5", review: "approved", state: "superseded" }),
], openBlocking = 1, plan = [makePlan()]) {
  return buildSnapshotPayload({ workspaceId: "ws-1", version: 1, claims, plan, scores: { ...scores, b: openBlocking }, openBlocking });
}

describe("canonicalJson", () => {
  it("is stable across key order, has no whitespace and keeps array order", () => {
    const a = canonicalJson({ b: 1, a: { y: [3, 1, 2], x: "s" }, c: null });
    const b = canonicalJson({ c: null, a: { x: "s", y: [3, 1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":"s","y":[3,1,2]},"b":1,"c":null}');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("omits undefined members and rejects values JSON cannot hold", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });
});

describe("buildSnapshotPayload / hashSnapshot", () => {
  it("keeps approved or edited claims only, sorted by id, with sorted role sets and versioned citations", () => {
    const p = payloadOf();
    expect(p.claims.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(p.claims[0].roleSet).toEqual(["president", "tech_lead"]);
    expect(p.claims[0].citations[0]).toEqual({ segmentId: expect.stringMatching(/^seg_/), version: 1 });
    expect(Object.keys(p.claims[0]).sort()).toEqual(
      ["attribute", "citations", "entity", "id", "roleSet", "statement", "trust", "value"],
    );
  });

  it("hash is stable for the same content regardless of input order", () => {
    const claims = [makeClaim({ id: "c1", review: "approved" }), makeClaim({ id: "c2", review: "approved" })];
    const h1 = hashSnapshot(payloadOf(claims));
    const h2 = hashSnapshot(payloadOf([...claims].reverse()));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash changes when one statement changes", () => {
    const base = [makeClaim({ id: "c1", review: "approved" }), makeClaim({ id: "c2", review: "approved" })];
    const changed = [base[0], { ...base[1], statement: base[1].statement + " Twice." }];
    expect(hashSnapshot(payloadOf(base))).not.toBe(hashSnapshot(payloadOf(changed)));
  });

  it("verifySnapshot detects tampering", () => {
    const p = payloadOf();
    const h = hashSnapshot(p);
    expect(verifySnapshot(p, h)).toBe(true);
    expect(verifySnapshot(p, h.toUpperCase())).toBe(true);
    const tampered = { ...p, claims: p.claims.map((c, i) => (i === 0 ? { ...c, value: "other" } : c)) };
    expect(verifySnapshot(tampered, h)).toBe(false);
  });
});

describe("release rule and approval", () => {
  const gaps = [{ responsibilityId: "r1", checkKey: "rollback" }];

  it("blocks B > 0 without a complete plan", () => {
    const none = computeReleaseState({ scores, blockingGaps: gaps, plan: [] });
    expect(none.canApprove).toBe(false);
    expect(none.problems[0].missing).toEqual(["plan"]);
    const partial = computeReleaseState({ scores, blockingGaps: gaps, plan: [makePlan({ owner: "", riskNote: " " })] });
    expect(partial.canApprove).toBe(false);
    expect(partial.problems[0].missing).toEqual(["owner", "riskNote"]);
    const badDate = computeReleaseState({ scores, blockingGaps: gaps, plan: [makePlan({ dueDate: "2026-02-30" })] });
    expect(badDate.problems[0].missing).toEqual(["dueDate"]);
    const unlisted = computeReleaseState({ scores: { ...scores, b: 2 }, blockingGaps: gaps, plan: [makePlan()] });
    expect(unlisted.canApprove).toBe(false);
  });

  it("allows release once every blocking gap has owner, due date and risk note", () => {
    const rs = computeReleaseState({ scores, blockingGaps: gaps, plan: [makePlan()] });
    expect(rs.canApprove).toBe(true);
    expect(rs.openBlocking).toBe(1);
    const r = approveSnapshot({ by: "president", roles: CLUB_ROLES, releaseState: rs, payload: payloadOf(), at: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.approvedBy).toBe("president");
    expect(r.snapshot.hash).toBe(hashSnapshot(r.payload));
    expect(r.snapshot.claimIds).toEqual(["c1", "c2"]);
    expect(r.label).toBe("Released with 1 open blocking gap");
    expect(r.event).toMatchObject({ type: "snapshot_approved", claimId: null, by: "president", at: AT });
  });

  it("the leaver can never approve, nor can any non-president role", () => {
    const rs = computeReleaseState({ scores, blockingGaps: gaps, plan: [makePlan()] });
    const leaver = approveSnapshot({ by: "leaver", roles: CLUB_ROLES, releaseState: rs, payload: payloadOf() });
    expect(leaver.ok === false && leaver.code).toBe("leaver_cannot_approve");
    for (const by of ["tech_lead", "treasurer", "new_member"] as const) {
      const r = approveSnapshot({ by, roles: CLUB_ROLES, releaseState: rs, payload: payloadOf() });
      expect(r.ok === false && r.code).toBe("not_approver");
    }
  });

  it("the president cannot approve while the release rule is not met", () => {
    const rs = computeReleaseState({ scores, blockingGaps: gaps, plan: [] });
    const r = approveSnapshot({ by: "president", roles: CLUB_ROLES, releaseState: rs, payload: payloadOf() });
    expect(r.ok === false && r.code).toBe("release_blocked");
  });

  it("B = 0 releases with no plan needed", () => {
    const rs = computeReleaseState({ scores: { b: 0, c: 1, k: 1 }, blockingGaps: [], plan: [] });
    expect(rs.canApprove).toBe(true);
    const r = approveSnapshot({ by: "president", roles: CLUB_ROLES, releaseState: rs, payload: payloadOf(undefined, 0, []) });
    expect(r.ok).toBe(true);
  });

  it("label wording: 'Released with N open blocking gaps', never 'complete'", () => {
    expect(releaseLabel(3)).toBe("Released with 3 open blocking gaps");
    expect(releaseLabel(1)).toBe("Released with 1 open blocking gap");
    expect(releaseLabel(0)).toBe("Released with no open blocking gaps");
    for (const n of [0, 1, 2, 7]) expect(releaseLabel(n).toLowerCase()).not.toContain("complete");
  });
});

describe("diffSnapshots", () => {
  it("lists added, removed and changed claim ids between versions", () => {
    const v1 = payloadOf([
      makeClaim({ id: "c1", review: "approved" }),
      makeClaim({ id: "c2", review: "approved" }),
      makeClaim({ id: "c3", review: "approved" }),
    ]);
    const v2 = {
      ...payloadOf([
        makeClaim({ id: "c1", review: "approved" }),
        makeClaim({ id: "c2", review: "edited", statement: "New text." }),
        makeClaim({ id: "c4", review: "approved" }),
      ], 0, []),
      version: 2,
    };
    const d = diffSnapshots(v1, v2);
    expect(d).toMatchObject({ fromVersion: 1, toVersion: 2, added: ["c4"], removed: ["c3"], changed: ["c2"], planChanged: true });
    expect(d.openBlocking).toEqual({ before: 1, after: 0 });
    expect(diffSnapshots(null, v1).added).toEqual(["c1", "c2", "c3"]);
  });
});
