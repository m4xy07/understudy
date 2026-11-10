import { describe, expect, it } from "vitest";
import type { CheckResult, Coverage, PlanItem } from "@/lib/types";
import { namedOwnersFromPlan, openBlockingGaps, releaseState, validatePlan } from "@/lib/lacuna/core/plan";
import { checksByResp } from "@/lib/lacuna/core/checks";
import { computeScores } from "@/lib/lacuna/core/scores";
import { deterministicStandin } from "@/lib/lacuna/core/standin";
import { answerToDrafts, rankGaps } from "@/lib/lacuna/core/questions";
import { ALL_ROLES, claim, metaIndex, resp } from "./fixtures";

const R = resp({ id: "r1", kind: "deploy_operate", entities: ["firmware-deploy"] });
const CHECKS = checksByResp([R]);

function r(checkKey: string, coverage: Coverage): CheckResult {
  return { responsibilityId: "r1", checkKey, coverage, claimIds: [], bestTrust: coverage === "covered" ? "from_record" : null, note: "" };
}

const plan = (checkKey: string, over: Partial<PlanItem> = {}): PlanItem => ({
  responsibilityId: "r1", checkKey, owner: "Arjun", dueDate: "2026-12-01", riskNote: "Robot cannot be recovered at regionals", ...over,
});

describe("openBlockingGaps and validatePlan", () => {
  const results = [r("access_path", "missing"), r("rollback", "partial"), r("credential_owner", "restricted"), r("steps", "covered")];

  it("lists only weight-5 checks that are not covered, restricted included", () => {
    expect(openBlockingGaps(results, CHECKS)).toEqual([
      { responsibilityId: "r1", checkKey: "rollback", coverage: "partial" },
      { responsibilityId: "r1", checkKey: "credential_owner", coverage: "restricted" },
    ]);
  });

  it("reports which gaps lack owner, due date or risk note", () => {
    const gaps = openBlockingGaps(results, CHECKS);
    const v = validatePlan(gaps, [plan("rollback", { owner: " ", dueDate: "next week" })]);
    expect(v.complete).toBe(false);
    expect(v.incomplete).toEqual([
      { gap: gaps[0], lacks: ["owner", "due date"] },
      { gap: gaps[1], lacks: ["owner", "due date", "risk note"] },
    ]);
    expect(validatePlan(gaps, [plan("rollback"), plan("credential_owner")]).complete).toBe(true);
  });

  it("names owners for restricted gaps from the plan", () => {
    const gaps = openBlockingGaps(results, CHECKS);
    expect([...namedOwnersFromPlan(gaps, [plan("rollback"), plan("credential_owner")])]).toEqual(["r1|credential_owner"]);
  });
});

describe("releaseState", () => {
  it("is ready only with no open blocking gaps", () => {
    expect(releaseState({ b: 0, c: 1, k: 1 }, [], [])).toEqual({ canApprove: true, openBlocking: 0, label: "Ready to release" });
  });

  it("blocks until every open blocking gap has owner, due date and risk note", () => {
    const gaps = openBlockingGaps([r("rollback", "missing"), r("credential_owner", "missing")], CHECKS);
    expect(releaseState({ b: 2, c: 0.3, k: 1 }, gaps, [plan("rollback")])).toEqual({
      canApprove: false, openBlocking: 2, label: "Blocked: 1 blocking gap needs an owner, a due date and a risk note",
    });
    expect(releaseState({ b: 2, c: 0.3, k: 1 }, gaps, []).label).toBe("Blocked: 2 blocking gaps need an owner, a due date and a risk note");
    expect(releaseState({ b: 2, c: 0.3, k: 1 }, gaps, [plan("rollback"), plan("credential_owner")])).toEqual({
      canApprove: true, openBlocking: 2, label: "Released with 2 open blocking gaps",
    });
  });

  it("never reports ready while restricted blocking gaps stay open, even with B 0", () => {
    const results = [r("rollback", "covered"), r("credential_owner", "restricted")];
    const gaps = openBlockingGaps(results, CHECKS);
    const p = [plan("credential_owner")];
    const scores = computeScores(results, CHECKS, namedOwnersFromPlan(gaps, p));
    expect(scores.b).toBe(0);
    expect(releaseState(scores, gaps, p).label).toBe("Released with 1 open blocking gap");
    expect(releaseState(scores, gaps, [plan("credential_owner", { riskNote: "" })]).canApprove).toBe(false);
  });

  it("treats B > 0 without a gap list as blocked", () => {
    expect(releaseState({ b: 3, c: 0, k: null }, [], []).canApprove).toBe(false);
  });
});

describe("ask → answer → re-test (end to end, pure)", () => {
  it("a leaver answer closes a blocking gap: B down, C up, K not raised until a record backs it", () => {
    const role = "tech_lead" as const;
    const visible = [claim({ id: "steps1", entity: "firmware-deploy", attribute: "procedure" })];
    const before = deterministicStandin(R, CHECKS.r1, visible, metaIndex(visible), role);
    const s0 = computeScores(before, CHECKS);
    expect(before.find((x) => x.checkKey === "credential_owner")?.coverage).toBe("missing");

    const top = rankGaps(before, [R], CHECKS, "2026-11-11")[0];
    expect(top.checkKey).toBe("credential_owner");

    const { claim: draft } = answerToDrafts("Meera holds the FLASH_TOKEN environment secret.", {
      text: "q", resp: R, check: CHECKS.r1.find((c) => c.key === "credential_owner")!, roleSet: ALL_ROLES,
    }, "p-1", { leaverName: "Priya" });
    const answered = claim({ id: "ans1", entity: draft.entity, attribute: draft.attribute, trust: draft.trust, roleSet: draft.roleSet });
    const after = deterministicStandin(R, CHECKS.r1, [...visible, answered], metaIndex([...visible, answered]), role);
    const s1 = computeScores(after, CHECKS);
    expect(s1.b).toBe(s0.b - 1);
    expect(s1.c).toBeGreaterThan(s0.c);
    expect(s1.k!).toBeLessThan(s0.k!);

    const backed = { ...answered, trust: "corroborated" as const };
    const s2 = computeScores(deterministicStandin(R, CHECKS.r1, [...visible, backed], metaIndex([...visible, backed]), role), CHECKS);
    expect(s2.c).toBeCloseTo(s1.c);
    expect(s2.k).toBe(1);
  });
});
