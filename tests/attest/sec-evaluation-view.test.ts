// The Evaluation page lists answer-key entity and attribute names. Every list is filtered by the
// viewing role: an item whose planted facts are outside the role's access is counted, never named.
import { describe, expect, it } from "vitest";
import type { EvalReport, GroundTruth } from "@/lib/attest/core/evaluate";
import { evaluationLists } from "@/lib/attest/evaluation-view";

const gt = {
  claims: [
    { id: "g1", entity: "open_day", attribute: "deadline", value: "2026-03-01", keywords: [], roleSet: ["president", "member"] },
    { id: "g2", entity: "sponsor_payout", attribute: "amount", value: "4000", keywords: [], roleSet: ["president", "treasurer"] },
    { id: "g3", entity: "sponsor_payout", attribute: "owner", value: "Ravi", keywords: [], roleSet: ["president", "treasurer"] },
    { id: "g4", entity: "no_roles", attribute: "owner", value: "x", keywords: [] },
  ],
} as unknown as GroundTruth;

const report = {
  unmatched: [
    { id: "g1", entity: "open_day", attribute: "deadline", value: "2026-03-01" },
    { id: "g2", entity: "sponsor_payout", attribute: "amount", value: "4000" },
  ],
  perEntity: {
    sponsor_payout: { expected: 2, matched: 1, recall: 0.5 },
    open_day: { expected: 1, matched: 0, recall: 0 },
    no_roles: { expected: 1, matched: 1, recall: 1 },
  },
  supersessions: {
    found: 0, expected: 2, ruleMatched: null,
    missing: [
      { entity: "sponsor_payout", attribute: "amount", old: "3000", new: "4000" },
      { entity: "open_day", attribute: "deadline", old: "2026-02-01", new: "2026-03-01" },
    ],
  },
  falseConflicts: {
    count: 2,
    pairs: [
      { entity: "open_day", attribute: "deadline", values: ["a", "b"], claimIds: ["c1", "c2"] },
      { entity: "sponsor_payout", attribute: "amount", values: ["3000", "4000"], claimIds: ["c3", "c4"] },
    ],
  },
} as unknown as EvalReport;

describe("evaluationLists", () => {
  it("a role outside the finance facts sees no finance entity, attribute or value in any list", () => {
    const lists = evaluationLists(report, gt, "member", new Set(["c1", "c2", "c3"]));
    expect(JSON.stringify(lists)).not.toMatch(/sponsor_payout|4000|3000|no_roles/);
    expect(lists.perEntity.map(([e]) => e)).toEqual(["open_day"]);
    expect(lists.hiddenEntities).toBe(2);
    expect(lists.unmatched.map((u) => u.id)).toEqual(["g1"]);
    expect(lists.hiddenUnmatched).toBe(1);
    expect(lists.supersessionsMissing.map((s) => s.entity)).toEqual(["open_day"]);
    expect(lists.hiddenSupersessions).toBe(1);
    expect(lists.falsePairs.map((p) => p.entity)).toEqual(["open_day"]);
  });

  it("a role with access sees its items, sorted by entity, and the hidden counts add up", () => {
    const lists = evaluationLists(report, gt, "president", new Set(["c1", "c2", "c3", "c4"]));
    expect(lists.perEntity.map(([e]) => e)).toEqual(["open_day", "sponsor_payout"]);
    expect(lists.hiddenEntities).toBe(1); // the entity whose fact has no role set is shown to no one
    expect(lists.unmatched).toHaveLength(2);
    expect(lists.hiddenUnmatched).toBe(0);
    expect(lists.supersessionsMissing).toHaveLength(2);
    expect(lists.hiddenSupersessions).toBe(0);
    expect(lists.falsePairs).toHaveLength(2);
  });

  it("a role in no planted fact gets empty lists and only counts", () => {
    const lists = evaluationLists(report, gt, "leaver", new Set());
    expect(lists.perEntity).toEqual([]);
    expect(lists.unmatched).toEqual([]);
    expect(lists.supersessionsMissing).toEqual([]);
    expect(lists.falsePairs).toEqual([]);
    expect([lists.hiddenEntities, lists.hiddenUnmatched, lists.hiddenSupersessions]).toEqual([3, 2, 2]);
  });
});
