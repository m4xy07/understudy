// What changed between two snapshots: gaps closed and opened, and the fixed reason sentences.
// Every sentence is chosen by code; these tests pin each one.
import { describe, expect, it } from "vitest";
import {
  REASONS, buildChangeRecord, claimChanges, explainScores, gapChanges, shortDelta, trustSentence, type GapRef,
} from "@/lib/relay/core/changes";
import { buildSnapshotPayload, diffSnapshots } from "@/lib/relay/core/snapshot";
import type { CheckDef, CheckResult, Coverage, Scores, Trust } from "@/lib/types";
import { makeClaim } from "./fixtures";

const CHECKS: Record<string, CheckDef[]> = {
  r1: [
    { key: "next_due_date", label: "Next due date", wTag: "WHEN", weight: 5, attributes: ["deadline"] },
    { key: "cadence", label: "Cadence", wTag: "WHEN", weight: 3, attributes: ["deadline"] },
    { key: "how", label: "How to do it", wTag: "HOW", weight: 3, attributes: ["procedure"] },
  ],
  r2: [{ key: "owner", label: "Owner", wTag: "WHO", weight: 5, attributes: ["owner"] }],
};

const res = (responsibilityId: string, checkKey: string, coverage: Coverage, bestTrust: Trust | null = null, claimIds: string[] = []): CheckResult =>
  ({ responsibilityId, checkKey, coverage, bestTrust, claimIds, note: "" });
const scores = (b: number, c: number, k: number | null): { scores: Scores } => ({ scores: { b, c, k } });
const gap = (over: Partial<GapRef> = {}): GapRef =>
  ({ responsibilityId: "r1", checkKey: "next_due_date", blocking: true, from: "missing", to: "covered", trust: "successor_found", claimIds: ["f1"], ...over });

describe("gapChanges", () => {
  const before = [res("r1", "next_due_date", "missing"), res("r1", "cadence", "covered", "from_record", ["c1"]), res("r1", "how", "partial"), res("r2", "owner", "covered", "from_record", ["c2"])];

  it("a gap closes when a check that was not covered is covered now", () => {
    const after = [res("r1", "next_due_date", "covered", "successor_found", ["f1"]), before[1], before[2], before[3]];
    expect(gapChanges(before, after, CHECKS)).toEqual({
      closed: [{ responsibilityId: "r1", checkKey: "next_due_date", blocking: true, from: "missing", to: "covered", trust: "successor_found", claimIds: ["f1"] }],
      opened: [],
    });
  });

  it("a gap opens when a covered check is no longer covered, and names the claims on both sides", () => {
    const after = [before[0], before[1], before[2], res("r2", "owner", "conflicting", null, ["c2", "f9"])];
    const { closed, opened } = gapChanges(before, after, CHECKS);
    expect(closed).toEqual([]);
    expect(opened).toEqual([{ responsibilityId: "r2", checkKey: "owner", blocking: true, from: "covered", to: "conflicting", trust: null, claimIds: ["c2", "f9"] }]);
  });

  it("partial to covered closes; missing to partial is neither; unknown checks and new results are skipped", () => {
    const after = [before[0], before[1], res("r1", "how", "covered", "leaver_said", ["l1"]), before[3], res("r9", "gone", "covered"), res("r2", "new_check", "covered")];
    const { closed, opened } = gapChanges(before, after, CHECKS);
    expect(closed.map((g) => [g.checkKey, g.blocking])).toEqual([["how", false]]);
    expect(opened).toEqual([]);
    expect(gapChanges([res("r1", "how", "missing")], [res("r1", "how", "partial")], CHECKS)).toEqual({ closed: [], opened: [] });
  });
});

describe("explainScores: each reason sentence", () => {
  it("first version: the scores as they are", () => {
    expect(explainScores(null, scores(5, 0.624, 0.88), [], [])).toEqual({ b: "B is 5.", c: "C is 62%.", k: "K is 88%." });
    expect(explainScores(null, scores(9, 0, null), [], []).k).toBe("K is n/a because nothing is covered yet.");
  });

  it("B down, finding (singular and plural)", () => {
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.64, 0.85), [gap()], []).b)
      .toBe("B went from 5 to 4. 1 blocking gap is now covered by a successor finding.");
    expect(explainScores(scores(5, 0.6, 0.9), scores(3, 0.7, 0.8), [gap(), gap({ responsibilityId: "r2", checkKey: "owner" })], []).b)
      .toBe("B went from 5 to 3. 2 blocking gaps are now covered by successor findings.");
  });

  it("B down, record", () => {
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.64, 0.92), [gap({ trust: "from_record" })], []).b)
      .toBe("B went from 5 to 4. 1 blocking gap is now covered by a record.");
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.64, 0.92), [gap({ trust: "corroborated" })], []).b)
      .toBe("B went from 5 to 4. 1 blocking gap is now covered by a record.");
  });

  it("B down for another reason says only that it is covered", () => {
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.64, 0.9), [gap({ trust: "leaver_said" })], []).b)
      .toBe("B went from 5 to 4. 1 blocking gap is now covered.");
    // A named owner on a restricted check lowers B without closing a gap.
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.6, 0.9), [], []).b).toBe("B went from 5 to 4. 1 blocking gap is now covered.");
  });

  it("B up, conflict", () => {
    const opened = [gap({ from: "covered", to: "conflicting", trust: null })];
    expect(explainScores(scores(4, 0.64, 0.85), scores(5, 0.6, 0.9), [], opened).b)
      .toBe("B went from 4 to 5. A new answer disagrees with an existing claim, so 1 blocking check is conflicting again.");
    expect(explainScores(scores(4, 0.64, 0.85), scores(5, 0.6, 0.9), [], [gap({ from: "covered", to: "missing", trust: null })]).b)
      .toBe("B went from 4 to 5. 1 blocking check is no longer covered.");
  });

  it("B same", () => {
    expect(explainScores(scores(4, 0.6, 0.9), scores(4, 0.6, 0.9), [], []).b).toBe("B stayed at 4.");
  });

  it("C up and C down (singular and plural), C same", () => {
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.64, 0.85), [gap()], []).c).toBe("C went from 60% to 64%. 1 more check is covered.");
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.7, 0.85), [gap(), gap({ checkKey: "how", blocking: false })], []).c)
      .toBe("C went from 60% to 70%. 2 more checks are covered.");
    expect(explainScores(scores(4, 0.64, 0.85), scores(5, 0.6, 0.9), [], [gap({ from: "covered", to: "missing" })]).c)
      .toBe("C went from 64% to 60%. 1 check is no longer covered.");
    expect(explainScores(scores(4, 0.64, 0.85), scores(6, 0.5, 0.9), [], [gap(), gap({ checkKey: "how" })]).c)
      .toBe("C went from 64% to 50%. 2 checks are no longer covered.");
    expect(explainScores(scores(4, 0.601, 0.9), scores(4, 0.604, 0.9), [], []).c).toBe("C stayed at 60%."); // compared as shown
  });

  it("K down, finding added", () => {
    expect(explainScores(scores(5, 0.6, 0.9), scores(4, 0.64, 0.85), [gap()], []).k)
      .toBe("K went from 90% to 85%. K counts only covered work that a record backs. A finding is a person's word, so it raises C and not K.");
  });

  it("K up, corroborated", () => {
    expect(explainScores(scores(4, 0.64, 0.85), scores(4, 0.64, 0.9), [], [], [{ claimId: "f1", from: "successor_found", to: "corroborated" }]).k)
      .toBe("K went from 85% to 90%. A record now agrees with a finding, so that work counts as backed by a record.");
  });

  it("K not available, K same, K moving for another reason", () => {
    expect(explainScores(scores(5, 0.1, 0.5), scores(6, 0, null), [], []).k).toBe("K is n/a because nothing is covered yet.");
    expect(explainScores(scores(4, 0.6, 0.9), scores(4, 0.62, 0.9), [], []).k).toBe("K stayed at 90%.");
    expect(explainScores(scores(4, 0.6, 0.9), scores(4, 0.62, 0.95), [], []).k).toBe("K went from 90% to 95%.");
    expect(explainScores(scores(4, 0.6, null), scores(4, 0.62, 0.95), [], []).k).toBe("K went from n/a to 95%.");
  });

  it("K never gets a 'raised by a finding' sentence: a finding alone cannot raise it", () => {
    const up = explainScores(scores(5, 0.6, 0.85), scores(4, 0.64, 0.9), [gap()], []).k;
    expect(up).toBe("K went from 85% to 90%.");
    expect(Object.values(REASONS).filter((r) => typeof r === "string").join(" ")).not.toMatch(/finding.*raises K/);
  });

  it("no sentence uses an em dash", () => {
    const all = [
      REASONS.bDownFinding(1), REASONS.bDownFinding(2), REASONS.bDownRecord(1), REASONS.bDownRecord(2), REASONS.bDown(1), REASONS.bDown(2),
      REASONS.bUpConflict(1), REASONS.bUpConflict(2), REASONS.bUp(1), REASONS.bUp(2), REASONS.cUp(1), REASONS.cUp(2), REASONS.cDown(1),
      REASONS.cDown(2), REASONS.kFinding, REASONS.kCorroborated, REASONS.kNone,
    ];
    for (const s of all) {
      expect(s).not.toMatch(/—/);
      expect(s.endsWith(".")).toBe(true);
    }
  });
});

describe("buildChangeRecord", () => {
  const base = makeClaim({ id: "c1", review: "approved" });
  const finding = makeClaim({
    id: "f1", review: "approved", trust: "successor_found", origin: "successor_finding", entity: "lab", attribute: "deadline",
    value: "2026-11-18", statement: "Incoming tech lead found: the next one is 18 Nov.",
  });
  const payload = (version: number, claims: ReturnType<typeof makeClaim>[], s: Scores, openBlocking: number) =>
    buildSnapshotPayload({ workspaceId: "ws-1", version, claims, plan: [], scores: s, openBlocking });
  const v1 = payload(1, [base], { b: 5, c: 0.6, k: 0.9 }, 5);
  const v2 = payload(2, [base, finding], { b: 4, c: 0.64, k: 0.85 }, 4);
  const before = { scores: v1.scores, results: [res("r1", "next_due_date", "missing"), res("r1", "cadence", "covered", "from_record", ["c1"])] };
  const after = { scores: v2.scores, results: [res("r1", "next_due_date", "covered", "successor_found", ["f1"]), res("r1", "cadence", "covered", "from_record", ["c1"])] };

  it("holds the diff of the two payloads, the gaps, the sentences and the cause", () => {
    const rec = buildChangeRecord({ prev: v1, next: v2, before, after, checks: CHECKS, cause: { type: "finding", findingIds: ["fnd_1"] } });
    expect(rec.diff).toEqual(diffSnapshots(v1, v2));
    expect(rec.diff.added).toEqual(["f1"]);
    expect(rec.gapsClosed.map((g) => g.checkKey)).toEqual(["next_due_date"]);
    expect(rec.gapsOpened).toEqual([]);
    expect(rec.lines).toEqual({
      b: "B went from 5 to 4. 1 blocking gap is now covered by a successor finding.",
      c: "C went from 60% to 64%. 1 more check is covered.",
      k: "K went from 90% to 85%. K counts only covered work that a record backs. A finding is a person's word, so it raises C and not K.",
    });
    expect(rec.deltaText).toBe("B 5 → 4: 1 blocking check now covered by Successor found answers · C 60% → 64% · K 90% → 85%");
    expect(rec.cause).toEqual({ type: "finding", findingIds: ["fnd_1"] });
    // Ids, numbers and fixed sentences only: no statement, no value.
    const stored = JSON.stringify(rec);
    expect(stored).not.toContain("18 Nov");
    expect(stored).not.toContain("2026-11-18");
    expect(stored).not.toContain(base.statement);
  });

  it("the first version has no previous run: no gaps, the scores as they are", () => {
    const rec = buildChangeRecord({ prev: null, next: v1, before: null, after: before, checks: CHECKS, cause: { type: "first", findingIds: [] } });
    expect(rec.diff.fromVersion).toBeNull();
    expect(rec.gapsClosed).toEqual([]);
    expect(rec.lines.b).toBe("B is 5.");
    expect(rec.deltaText).toBe("B 5 · C 60% · K 90%");
  });

  it("a record that later agrees shows as a trust change and explains K", () => {
    const upgraded = { ...finding, trust: "corroborated" as const };
    const v3 = payload(3, [base, upgraded], { b: 4, c: 0.64, k: 0.9 }, 4);
    const after3 = { scores: v3.scores, results: [res("r1", "next_due_date", "covered", "corroborated", ["f1", "r9"]), after.results[1]] };
    const rec = buildChangeRecord({ prev: v2, next: v3, before: after, after: after3, checks: CHECKS, cause: { type: "manual", findingIds: [] } });
    expect(rec.diff.changed).toEqual(["f1"]);
    expect(rec.claimChanges).toEqual([{ claimId: "f1", kind: "trust", from: "successor_found", to: "corroborated" }]);
    expect(rec.lines.k).toBe("K went from 85% to 90%. A record now agrees with a finding, so that work counts as backed by a record.");
    expect(trustSentence("successor_found", "corroborated")).toBe("Trust went from Successor found to Corroborated.");
  });

  it("an edited statement is a text change", () => {
    const edited = { ...base, statement: "Flash with make flash-safe.", review: "edited" as const };
    const next = payload(2, [edited], v1.scores, 5);
    expect(claimChanges(v1, next, diffSnapshots(v1, next).changed)).toEqual([{ claimId: "c1", kind: "text" }]);
  });

  it("shortDelta for messages", () => {
    expect(shortDelta({ b: 5, c: 0, k: null }, { b: 4, c: 0, k: null })).toBe("B 5 → 4.");
    expect(shortDelta({ b: 4, c: 0, k: null }, { b: 4, c: 0, k: null })).toBe("B stayed at 4.");
    expect(shortDelta(null, { b: 4, c: 0, k: null })).toBe("B 4.");
  });
});
