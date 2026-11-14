import { describe, expect, it } from "vitest";
import type { CheckResult, Coverage, Trust } from "@/lib/types";
import { computeScores, evidenceMix, formatScores, scoreDelta } from "@/lib/lacuna/core/scores";
import { checksByResp } from "@/lib/lacuna/core/checks";
import { gapKey } from "@/lib/lacuna/core/pack";
import { resp } from "./fixtures";

// deploy_operate weights: access_path 3, steps 3, verify 3, rollback 5, credential_owner 5 (Σw = 19)
const R = resp({ id: "r1", kind: "deploy_operate", entities: ["firmware-deploy"] });
const CHECKS = checksByResp([R]);

function res(checkKey: string, coverage: Coverage, bestTrust: Trust | null = coverage === "covered" ? "from_record" : null): CheckResult {
  return { responsibilityId: "r1", checkKey, coverage, claimIds: [], bestTrust, note: "" };
}

function all(over: Record<string, [Coverage, Trust | null]>): CheckResult[] {
  return ["access_path", "steps", "verify", "rollback", "credential_owner"].map((k) =>
    over[k] ? res(k, over[k][0], over[k][1]) : res(k, "missing"));
}

describe("computeScores", () => {
  it("weights s = covered 1, partial 0.5, missing/conflicting 0", () => {
    const s = computeScores(all({
      access_path: ["covered", "from_record"],
      steps: ["partial", "from_record"],
      verify: ["conflicting", "from_record"],
    }), CHECKS);
    expect(s.c).toBeCloseTo((3 * 1 + 3 * 0.5) / 19);
    expect(s.b).toBe(2); // rollback + credential_owner missing
    expect(s.k).toBe(1);
  });

  it("counts partial and conflicting blocking checks in B", () => {
    const s = computeScores(all({
      rollback: ["partial", "from_record"],
      credential_owner: ["conflicting", null],
    }), CHECKS);
    expect(s.b).toBe(2);
  });

  it("excludes restricted from C and K but counts a restricted blocking check in B until an owner is named", () => {
    const results = all({
      access_path: ["covered", "from_record"],
      steps: ["covered", "from_record"],
      verify: ["covered", "from_record"],
      rollback: ["covered", "from_record"],
      credential_owner: ["restricted", null],
    });
    const s = computeScores(results, CHECKS);
    expect(s.c).toBe(1); // 14/14: the restricted slot leaves the denominator
    expect(s.k).toBe(1);
    expect(s.b).toBe(1);
    const named = computeScores(results, CHECKS, new Set([gapKey("r1", "credential_owner")]));
    expect(named.b).toBe(0);
    expect(named.c).toBe(1);
  });

  it("does not count a restricted non-blocking check in B", () => {
    const s = computeScores(all({ access_path: ["restricted", null], rollback: ["covered", "from_record"], credential_owner: ["covered", "from_record"] }), CHECKS);
    expect(s.b).toBe(0);
    expect(s.c).toBeCloseTo(10 / 16);
  });

  it("leaver_said raises C but not K; corroborated raises K", () => {
    const base = all({ access_path: ["covered", "from_record"] });
    const s0 = computeScores(base, CHECKS);
    expect(s0.k).toBe(1);

    const said = all({ access_path: ["covered", "from_record"], rollback: ["covered", "leaver_said"] });
    const s1 = computeScores(said, CHECKS);
    expect(s1.c).toBeGreaterThan(s0.c);
    expect(s1.k).toBeCloseTo(3 / 8); // the leaver_said weight sits in the denominator only
    expect(s1.b).toBe(s0.b - 1);

    const corr = all({ access_path: ["covered", "from_record"], rollback: ["covered", "corroborated"] });
    const s2 = computeScores(corr, CHECKS);
    expect(s2.c).toBeCloseTo(s1.c);
    expect(s2.k).toBe(1);
    expect(s2.k!).toBeGreaterThan(s1.k!);
  });

  it("K is null when nothing is covered; C is 0 with no weighable checks", () => {
    expect(computeScores(all({}), CHECKS)).toEqual({ b: 2, c: 0, k: null });
    expect(computeScores([], CHECKS)).toEqual({ b: 0, c: 0, k: null });
  });
});

describe("formatScores and scoreDelta", () => {
  it("formats B, then C, then K", () => {
    expect(formatScores({ b: 7, c: 0.5163, k: 0.88 })).toBe("B 7 · C 52% · K 88%");
    expect(formatScores({ b: 0, c: 0, k: null })).toBe("B 0 · C 0% · K n/a");
  });

  it("explains a re-test", () => {
    const before = all({ access_path: ["covered", "from_record"] });
    const after = all({ access_path: ["covered", "from_record"], rollback: ["covered", "leaver_said"], credential_owner: ["covered", "leaver_said"] });
    const text = scoreDelta(
      { scores: computeScores(before, CHECKS), results: before },
      { scores: computeScores(after, CHECKS), results: after },
      CHECKS,
    );
    expect(text).toBe("B 2 → 0: 2 blocking checks now covered by Leaver said answers · C 16% → 68% · K 100% → 23%");
  });

  it("says no change when B holds and mixes trust sources", () => {
    const r = all({});
    const s = computeScores(r, CHECKS);
    expect(scoreDelta({ scores: s, results: r }, { scores: s, results: r }, CHECKS)).toBe("B 2 (no change) · C 0% · K n/a");
    const after = all({ rollback: ["covered", "leaver_said"], credential_owner: ["covered", "from_record"] });
    const text = scoreDelta({ scores: s, results: r }, { scores: computeScores(after, CHECKS), results: after }, CHECKS);
    expect(text).toMatch(/^B 2 → 0: 2 blocking checks now covered \((1 by Leaver said, 1 by From record|1 by From record, 1 by Leaver said)\)/);
  });
});

// T-U-22 (recovery): the evidence mix is K broken open by trust label.
describe("evidenceMix", () => {
  it("shares sum to 1 and the two record shares sum to K", () => {
    const results = all({
      access_path: ["covered", "from_record"],
      steps: ["covered", "corroborated"],
      verify: ["covered", "second_hand"],
      rollback: ["partial", "inferred"],
      credential_owner: ["covered", "leaver_said"],
    });
    const mix = evidenceMix(results, CHECKS);
    const total = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBeCloseTo(1);
    expect((mix.from_record ?? 0) + (mix.corroborated ?? 0)).toBeCloseTo(computeScores(results, CHECKS).k!);
    expect(mix.second_hand).toBeCloseTo(3 / 16.5);
    expect(mix.inferred).toBeCloseTo(2.5 / 16.5);
    expect(mix.leaver_said).toBeCloseTo(5 / 16.5);
  });

  it("is empty when nothing is covered, and restricted checks stay out", () => {
    expect(evidenceMix(all({}), CHECKS)).toEqual({});
    const mix = evidenceMix(all({ access_path: ["covered", "from_record"], rollback: ["restricted", null] }), CHECKS);
    expect(mix).toEqual({ from_record: 1 });
  });
});
