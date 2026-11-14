// Pure part of the claim history (src/lib/attest/history.ts): how one claim_events row becomes a
// timeline entry. No database. The role-scoped read is tested in tests/db/claim-history.test.ts.
import { describe, expect, it } from "vitest";
import {
  actorLabel, describeEvent, eventData, isClaimIdParam, relatedIdOf, ruleText, type RawEvent,
} from "@/lib/attest/history";
import { getPack, listDemoPacks } from "@/lib/pack";

const NONE = new Map<string, string>();
const NO_SEGS = new Set<string>();
const ev = (event: string, data: unknown, actor = "system"): RawEvent => ({
  id: "1", event, data, actor, createdAt: "2026-01-01T09:00:00.000Z",
});

describe("describeEvent", () => {
  it("a created event says where the claim came from, its label and value, and nothing else", () => {
    const e = describeEvent("c1", ev("created", {
      origin: "leaver_answer", trust: "leaver_said", value: "Friday", roleSet: ["secret_role_key"],
      sensitivity: ["finance"], questionId: "q_9", narrowed: true,
    }), NONE, NO_SEGS);
    expect(e.kind).toBe("created");
    expect(e.title).toBe("Created");
    expect(e.lines).toEqual(["An answer from the leaver.", "Label: Leaver said", 'Value: "Friday"', "Saved for fewer roles than usual."]);
    const text = JSON.stringify(e);
    for (const s of ["secret_role_key", "finance", "q_9"]) expect(text).not.toContain(s);
  });

  it("a label change reads from and to, in words", () => {
    const e = describeEvent("c1", ev("verified", { changes: { trust: { from: "inferred", to: "from_record" }, citations: { from: 1, to: 2 } } }), NONE, NO_SEGS);
    expect(e.title).toBe("Label changed");
    expect(e.lines).toEqual(["Label: Inferred → From record", "Citations: 1 → 2"]);
  });

  it("a superseded event names the rule without its prefix, and the winner only when visible", () => {
    const data = {
      changes: { state: { from: "active", to: "superseded" }, supersededBy: { from: null, to: "c2" } },
      note: "Superseded: the task board owns deadlines (updated on 2026-01-05)", rule: 1, olderId: "c1", newerId: "c2",
    };
    const hidden = describeEvent("c1", ev("superseded", data), NONE, NO_SEGS);
    expect(hidden.rule).toBe("the task board owns deadlines (updated on 2026-01-05)");
    expect(hidden.related).toBeNull();
    expect(hidden.lines).toEqual(["State: active → superseded"]);
    const shown = describeEvent("c1", ev("superseded", data), new Map([["c2", "Due on Monday."]]), NO_SEGS);
    expect(shown.related).toEqual({ id: "c2", statement: "Due on Monday.", relation: "Replaced by" });
  });

  it("a conflicting event points at the other side, whichever side this claim is", () => {
    expect(relatedIdOf("c2", { olderId: "c1", newerId: "c2" })).toBe("c1");
    expect(relatedIdOf("c1", { olderId: "c1", newerId: "c2" })).toBe("c2");
    const e = describeEvent("c2", ev("conflicting", { rule: 3, olderId: "c1", newerId: "c2" }), new Map([["c1", "Other."]]), NO_SEGS);
    expect(e.rule).toBe("two people disagree and no rule settles it");
    expect(e.related?.relation).toBe("Compared with");
  });

  it("an edit shows the older statement, the new one and the reviewer's note", () => {
    const e = describeEvent("c1", ev("claim_edited", {
      tier: "C", note: "Checked the letter.", evidenceOpened: true,
      before: { value: "PIN", statement: "Old words." }, after: { value: "PIN", statement: "New words." },
    }, "approver_key"), NONE, NO_SEGS);
    expect(e.kind).toBe("edited");
    expect(e.actor).toBe("approver_key");
    expect(e.lines).toEqual([
      "Review tier C.", "The evidence was opened first.", 'Before: "Old words."', 'After: "New words."', `Reviewer's note: "Checked the letter."`,
    ]);
  });

  it("a bulk approval says so", () => {
    const e = describeEvent("c1", ev("claim_approved", { tier: "A", bulk: true, note: null }), NONE, NO_SEGS);
    expect(e.title).toBe("Approved");
    expect(e.lines).toEqual(["Approved together with the other tier A claims."]);
  });

  it("a cited segment is linked only when the role can open it", () => {
    const data = { origin: "successor_finding", segmentId: "seg_1" };
    expect(describeEvent("c1", ev("created", data), NONE, NO_SEGS).segmentId).toBeNull();
    expect(describeEvent("c1", ev("created", data), NONE, new Set(["seg_1"])).segmentId).toBe("seg_1");
  });

  it("an event type it does not know becomes a plain change with no passed-through text", () => {
    const e = describeEvent("c1", ev("something_new", { secretField: "do not show" }), NONE, NO_SEGS);
    expect(e.kind).toBe("other");
    expect(e.title).toBe("Changed");
    expect(JSON.stringify(e)).not.toContain("do not show");
  });

  it("a rules re-run and a drop note are said in words", () => {
    const e = describeEvent("c1", ev("dropped", { changes: {}, note: "Withdrawn by the successor before review", trigger: "rules re-run" }), NONE, NO_SEGS);
    expect(e.lines).toEqual(["After the rules ran again.", "Withdrawn by the successor before review"]);
  });
});

describe("helpers", () => {
  it("eventData reads objects, JSON text and double-encoded JSON, and nothing else", () => {
    expect(eventData({ a: 1 })).toEqual({ a: 1 });
    expect(eventData('{"a":1}')).toEqual({ a: 1 });
    expect(eventData(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect(eventData("not json")).toEqual({});
    expect(eventData([1, 2])).toEqual({});
    expect(eventData(null)).toEqual({});
  });

  it("ruleText falls back to the rule number, and to null", () => {
    expect(ruleText("Conflicting: a note from 2026-01-01 disagrees with this. Ask a person.", 4)).toBe("a note from 2026-01-01 disagrees with this. Ask a person.");
    expect(ruleText(null, 2)).toBe("the same person, or a reply, updated it");
    expect(ruleText(null, 9)).toBeNull();
    expect(ruleText(undefined, undefined)).toBeNull();
  });

  it("isClaimIdParam accepts claim ids and refuses paths and junk", () => {
    expect(isClaimIdParam("clm_0123abcd")).toBe(true);
    expect(isClaimIdParam("../etc")).toBe(false);
    expect(isClaimIdParam("")).toBe(false);
    expect(isClaimIdParam("x".repeat(129))).toBe(false);
    expect(isClaimIdParam(42)).toBe(false);
  });

  it("actorLabel reads role labels from the pack", () => {
    const pack = getPack(listDemoPacks()[0].id);
    const r = pack.roles[0];
    expect(actorLabel(null, pack)).toBe("System");
    expect(actorLabel(r.key, pack)).toBe(r.label);
    expect(actorLabel("nobody_role", pack)).toBe("Unknown role");
  });
});
