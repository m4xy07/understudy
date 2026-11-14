// Tier B review by responsibility: grouping, what a group approval may touch, and the two compile
// fixes that came with it (the same action once; a passed date is not an upcoming action).
import { describe, expect, it } from "vitest";
import { bulkApproveGroup, groupApprovable, groupTierB } from "@/lib/relay/core/review";
import { compileHandover, dedupeLines } from "@/lib/relay/core/compile";
import { AT, makeClaim, makeResp } from "./fixtures";
import { scenarioInput } from "./scenario";
import { CLUB_ROLES } from "../helpers/club";

const resps = [
  makeResp({ id: "r2", key: "R02", title: "Sponsor", entities: ["sponsor"] }),
  makeResp({ id: "r1", key: "R01", title: "Deploy firmware to the robot", entities: ["firmware-deploy", "firmware-rollback"] }),
];

const claims = [
  makeClaim({ id: "b1", tier: "B" }),
  makeClaim({ id: "b2", tier: "B", entity: "firmware-rollback" }),
  makeClaim({ id: "a1", tier: "A" }),
  makeClaim({ id: "c1", tier: "C" }),
  makeClaim({ id: "conf", tier: "B", state: "conflicting" }),
  makeClaim({ id: "sup", tier: "B", state: "superseded" }),
  makeClaim({ id: "done", tier: "B", review: "approved" }),
  makeClaim({ id: "find", tier: "B", origin: "successor_finding" }),
  makeClaim({ id: "s1", tier: "B", entity: "sponsor", entityLabel: "Sponsor" }),
  makeClaim({ id: "t1", tier: "B", entity: "lab-slot", entityLabel: "Weekly lab slot" }),
  makeClaim({ id: "o1", tier: "B", entity: "other", entityLabel: "Other" }),
];

describe("groupTierB", () => {
  const groups = groupTierB(claims, resps);

  it("groups pending tier B claims by responsibility in inventory order, then by topic, the catch-all last", () => {
    expect(groups.map((g) => g.key)).toEqual(["resp:r1", "resp:r2", "topic:lab-slot", "topic:other"]);
    expect(groups.map((g) => g.title)).toEqual([
      "R01 Deploy firmware to the robot", "R02 Sponsor", "Other: Weekly lab slot", "Other: not tied to one topic",
    ]);
    expect(groups[0].claims.map((c) => c.id)).toEqual(["b1", "b2"]);
    expect(groups[0].responsibilityId).toBe("r1");
    expect(groups[2].responsibilityId).toBeNull();
  });

  it("never lists tier A or C, a conflict, a superseded claim, a decided claim or a successor finding", () => {
    const ids = groups.flatMap((g) => g.claims.map((c) => c.id));
    for (const id of ["a1", "c1", "conf", "sup", "done", "find"]) expect(ids).not.toContain(id);
    expect(groupApprovable(makeClaim({ id: "x", tier: "C" }))).toBe(false);
    expect(groupApprovable(makeClaim({ id: "x", tier: "B", state: "conflicting" }))).toBe(false);
  });

  it("puts every claim in exactly one group", () => {
    const ids = groups.flatMap((g) => g.claims.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("bulkApproveGroup", () => {
  it("approves only the pending tier B claims that were on screen, with one event each", () => {
    const r = bulkApproveGroup(claims, new Set(["b1", "c1", "conf", "a1"]), "resp:r1", "president", CLUB_ROLES, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.approvedIds).toEqual(["b1"]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "claim_approved", claimId: "b1", by: "president", at: AT });
    expect(r.events[0].payload).toMatchObject({ tier: "B", bulk: true, group: "resp:r1" });
    expect(r.claims.find((c) => c.id === "c1")!.review).toBe("pending");
    expect(r.claims.find((c) => c.id === "conf")!.review).toBe("pending");
    expect(r.claims.find((c) => c.id === "b2")!.review).toBe("pending"); // not on screen
  });

  it("is for the approver alone: never the leaver, never another role", () => {
    const ids = new Set(["b1"]);
    const leaver = bulkApproveGroup(claims, ids, "resp:r1", "leaver", CLUB_ROLES);
    expect(leaver.ok === false && leaver.code).toBe("leaver_cannot_approve");
    const other = bulkApproveGroup(claims, ids, "resp:r1", "tech_lead", CLUB_ROLES);
    expect(other.ok === false && other.code).toBe("not_approver");
  });

  it("a second run approves nothing", () => {
    const first = bulkApproveGroup(claims, new Set(["b1", "b2"]), "resp:r1", "president", CLUB_ROLES, AT);
    if (!first.ok) throw new Error("first run failed");
    const again = bulkApproveGroup(first.claims, new Set(["b1", "b2"]), "resp:r1", "president", CLUB_ROLES, AT);
    expect(again.ok && again.approvedIds).toEqual([]);
  });
});

describe("compiled action list", () => {
  const base = scenarioInput("tech_lead", []);
  const input = (list: ReturnType<typeof makeClaim>[]) => ({ ...base, visibleClaims: list, plan: [], readbackItems: [] });
  const actions = (list: ReturnType<typeof makeClaim>[]) =>
    compileHandover(input(list)).sections.find((s) => s.key === "actions")!.lines.filter((l) => l.kind === "action");

  it("lists the same dated action once when two approved claims state it, citing both", () => {
    const lines = actions([
      makeClaim({ id: "d1", attribute: "deadline", value: "2026-11-28", trust: "from_record" }),
      makeClaim({ id: "d2", attribute: "deadline", value: "28 Nov 2026", trust: "corroborated" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toMatch(/^Due 2026-11-28: /);
    expect(lines[0].claimIds).toEqual(["d1", "d2"]);
    expect(lines[0].segmentIds).toHaveLength(2);
    expect(lines[0].trust).toBe("from_record");
  });

  it("labels a date before the approval day past due, once, and never as upcoming", () => {
    const lines = actions([
      makeClaim({ id: "d1", attribute: "deadline", value: "2026-11-12" }),
      makeClaim({ id: "d2", attribute: "deadline", value: "12 Nov 2026" }),
      makeClaim({ id: "d3", attribute: "deadline", value: "2026-11-28" }),
    ]);
    expect(lines.map((l) => l.text.split(":")[0])).toEqual(["Past due (was due 2026-11-12)", "Due 2026-11-28"]);
    expect(lines.filter((l) => l.text.includes("2026-11-12"))).toHaveLength(1);
  });

  it("counts passed dates on topics outside every responsibility in one line instead of listing them", () => {
    const lines = actions([
      makeClaim({ id: "o1", entity: "other", entityLabel: "Other", attribute: "deadline", value: "2026-06-12", statement: "The summer camp ran on 12 June." }),
      makeClaim({ id: "o2", entity: "other", entityLabel: "Other", attribute: "deadline", value: "2026-07-01", statement: "Fees were due on 1 July." }),
      makeClaim({ id: "o3", entity: "other", entityLabel: "Other", attribute: "deadline", value: "2026-12-05", statement: "The winter camp is on 5 December." }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "Due 2026-12-05: The winter camp is on 5 December.",
      "2 earlier dates on other topics passed before this handover was approved. They are not listed as actions.",
    ]);
  });

  it("dedupeLines keeps the first line in place and merges ids", () => {
    const line = (text: string, id: string) => ({ text, trust: "inferred" as const, claimIds: [id], segmentIds: [`seg_${id}`], kind: "action" as const, edited: false, date: null });
    const out = dedupeLines([line("a", "1"), line("b", "2"), line("a", "3")]);
    expect(out.map((l) => l.text)).toEqual(["a", "b"]);
    expect(out[0].claimIds).toEqual(["1", "3"]);
  });

  it("a summary line names the two newest values and counts the rest", () => {
    const doc = compileHandover(input([
      makeClaim({ id: "s1", attribute: "status", value: "started", validFrom: "2026-10-01T00:00:00.000Z" }),
      makeClaim({ id: "s2", attribute: "status", value: "in review", validFrom: "2026-10-03T00:00:00.000Z" }),
      makeClaim({ id: "s3", attribute: "status", value: "In Review.", validFrom: "2026-10-02T00:00:00.000Z" }),
      makeClaim({ id: "s4", attribute: "status", value: "merged", validFrom: "2026-10-04T00:00:00.000Z" }),
    ]));
    const summary = doc.sections.find((s) => s.key === "summary")!.lines[0];
    expect(summary.text).toContain("status merged and in review (+1 more)");
    expect(summary.claimIds).toEqual(["s1", "s2", "s3", "s4"]);
  });
});
