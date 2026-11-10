import { describe, expect, it } from "vitest";
import type { CheckResult, Coverage } from "@/lib/types";
import { answerToDrafts, narrowRoleSet, questionText, rankGaps, segmentId } from "@/lib/lacuna/core/questions";
import { checksByResp, checksFor } from "@/lib/lacuna/core/checks";
import { norm, sha256Hex } from "@/lib/text/norm";
import { ALL_ROLES, claim, resp } from "./fixtures";

const TODAY = "2026-11-11";

function r(responsibilityId: string, checkKey: string, coverage: Coverage, claimIds: string[] = []): CheckResult {
  return { responsibilityId, checkKey, coverage, claimIds, bestTrust: null, note: "" };
}

describe("rankGaps", () => {
  const deploy = resp({ id: "d", key: "R01", kind: "deploy_operate", entities: ["firmware-deploy"], dueDate: "2026-11-20" });
  const lab = resp({ id: "l", key: "R02", kind: "recurring_obligation", entities: ["lab-booking"], title: "Book the lab", dueDate: "2027-02-01" });
  const resps = [deploy, lab];
  const checks = checksByResp(resps);

  it("scores weight × uncertainty × urgency and excludes restricted and covered", () => {
    const gaps = rankGaps([
      r("d", "rollback", "missing"),          // 5 × 1 × 1.5 = 7.5
      r("d", "credential_owner", "restricted"),
      r("d", "steps", "conflicting"),         // 3 × 0.8 × 1.5 = 3.6
      r("d", "verify", "covered"),
      r("l", "next_due", "missing"),          // 5 × 1 × 1 = 5
      r("l", "how_to", "partial"),            // 3 × 0.5 × 1 = 1.5
      r("l", "cadence", "conflicting"),       // 3 × 0.8 × 1 = 2.4
    ], resps, checks, TODAY);
    expect(gaps.map((g) => [g.checkKey, g.score])).toEqual([
      ["rollback", 7.5], ["next_due", 5], ["steps", 3.6], ["cadence", 2.4], ["how_to", 1.5],
    ]);
    expect(gaps.map((g) => g.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(gaps.find((g) => g.checkKey === "credential_owner")).toBeUndefined();
    expect(gaps[0]).toMatchObject({ gapType: "missing", weight: 5, uncertainty: 1, urgency: 1.5 });
  });

  it("treats overdue as urgent and caps at 10", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      resp({ id: `u${i}`, key: `R${String(i + 1).padStart(2, "0")}`, kind: "unfinished_work", entities: [`e${i}`], dueDate: i === 5 ? "2026-11-01" : null }));
    const results = many.flatMap((x) => checksFor(x).map((c) => r(x.id, c.key, "missing")));
    expect(results).toHaveLength(24);
    const gaps = rankGaps(results, many, checksByResp(many), TODAY);
    expect(gaps).toHaveLength(10);
    expect(gaps[0]).toMatchObject({ responsibilityId: "u5", checkKey: "next_step", score: 7.5 });
    // then the remaining weight-5 gaps in responsibility key order
    expect(gaps.slice(1, 6).map((g) => g.responsibilityId)).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    expect(gaps.slice(1, 6).every((g) => g.checkKey === "next_step")).toBe(true);
  });
});

describe("questionText", () => {
  const deploy = resp({ id: "d", kind: "deploy_operate", entities: ["firmware-deploy"], title: "firmware deploy to the robot" });
  const rollback = checksFor(deploy).find((c) => c.key === "rollback")!;
  const owner = checksFor(deploy).find((c) => c.key === "credential_owner")!;

  it("builds a specific missing question from the check template", () => {
    expect(questionText({ gapType: "missing" }, deploy, rollback, "deploy_operate")).toBe(
      "If firmware deploy to the robot breaks at the worst possible moment, what exact steps or command roll it back, and where is that written down?",
    );
  });

  it("uses a pack template when present", () => {
    const custom = { ...rollback, question: { missing: "If a {resp} breaks the robot the night before a match, what exact steps or command roll it back, and where is that written down?" } };
    expect(questionText({ gapType: "missing" }, { ...deploy, title: "firmware deploy" }, custom, "deploy_operate")).toBe(
      "If a firmware deploy breaks the robot the night before a match, what exact steps or command roll it back, and where is that written down?",
    );
  });

  it("gives the setting pack's check keys the same plain text (no generic fallback)", () => {
    const work = resp({ id: "w", kind: "unfinished_work", entities: ["website"], title: "Website registration form" });
    const step = { ...checksFor(work).find((c) => c.key === "next_step")!, key: "next_concrete_step" };
    expect(questionText({ gapType: "missing" }, work, step, "unfinished_work")).toBe(
      "What is the next concrete step on Website registration form, and what does someone need to take it?",
    );
  });

  it("prefixes partial gaps", () => {
    expect(questionText({ gapType: "partial" }, deploy, rollback, "deploy_operate")).toMatch(/^The record only partly answers this for this system\. If firmware/);
  });

  it("names conflicting values only from claims the leaver may see", () => {
    const a = claim({ id: "a", entity: "firmware-deploy", attribute: "owner", value: "Arjun", state: "conflicting" });
    const b = claim({ id: "b", entity: "firmware-deploy", attribute: "access", value: "Meera", state: "conflicting" });
    const hidden = claim({ id: "h", entity: "firmware-deploy", attribute: "access", value: "CANARY-0001", state: "conflicting", roleSet: ["president"] });
    const text = questionText({ gapType: "conflicting", claimIds: ["a", "h", "b"] }, deploy, owner, "deploy_operate", [a, hidden, b]);
    expect(text).toBe('Two people gave different answers for credential owner of firmware deploy to the robot: "Arjun" and "Meera". Which is right now, and since when?');
    expect(text).not.toContain("CANARY");

    const onlyOne = questionText({ gapType: "conflicting", claimIds: ["a", "h"] }, deploy, owner, "deploy_operate", [a, hidden]);
    expect(onlyOne).not.toContain("CANARY");
    expect(onlyOne).not.toContain("Arjun");
    expect(onlyOne).toMatch(/^People gave different answers for credential owner/);
  });

  it("finds conflicting claims by entity and attribute when no ids are given", () => {
    const a = claim({ id: "a", entity: "firmware-deploy", attribute: "procedure", value: "make flash-prev", state: "conflicting" });
    const b = claim({ id: "b", entity: "firmware-deploy", attribute: "procedure", value: "git revert and reflash", state: "conflicting" });
    expect(questionText({ gapType: "conflicting" }, deploy, rollback, "deploy_operate", [a, b])).toContain('"make flash-prev" and "git revert and reflash"');
  });
});

describe("answers", () => {
  const deploy = resp({ id: "d", key: "R01", kind: "deploy_operate", entities: ["firmware-deploy", "ci"] });
  const question = {
    id: "q1",
    text: "If firmware deploy breaks...",
    resp: deploy,
    check: checksFor(deploy).find((c) => c.key === "credential_owner")!,
    roleSet: ALL_ROLES,
    entityLabel: "Firmware deploy to the robot",
  };

  it("turns an answer into an interview segment and a leaver_said claim with the exact full answer as quote", () => {
    const answer = "Meera holds the deploy key now; ask her for the GitHub environment secret named FLASH_TOKEN.";
    const { segment, claim: c } = answerToDrafts(answer, question, "p-1", { leaverName: "Priya", ts: "2026-11-11T10:00:00.000Z", workspaceId: "ws" });
    expect(segment).toMatchObject({ kind: "answer", sourceKind: "interview", authorId: "p-1", text: answer, roleSet: ALL_ROLES });
    expect(segment.id).toBe(segmentId("interview", "2026-11-11T10:00:00.000Z", "interview:R01:credential_owner", 0, answer));
    expect(segment.id).toMatch(/^seg_[0-9a-f]{16}$/);
    expect(segment.textHash).toBe(sha256Hex(norm(answer)));
    expect(c).toMatchObject({
      trust: "leaver_said", attribute: "access", entity: "firmware-deploy", value: answer,
      statement: `Priya said: ${answer}`, authorId: "p-1", origin: "leaver_answer", state: "active",
    });
    expect(c.citations).toEqual([{ segmentId: segment.id, quote: answer, accepted: true, exact: true }]);
  });

  it("lets the leaver narrow the role set, never widen it", () => {
    const { segment, claim: c } = answerToDrafts("x", { ...question, roleSet: ["president", "tech_lead"] }, "p-1", {
      narrowTo: ["tech_lead", "new_member", "treasurer"],
    });
    expect(c.roleSet).toEqual(["tech_lead"]);
    expect(segment.roleSet).toEqual(["tech_lead"]);
  });

  it("narrowRoleSet is the intersection", () => {
    expect(narrowRoleSet(["president", "tech_lead"], ["tech_lead", "new_member"])).toEqual(["tech_lead"]);
    expect(narrowRoleSet(["president", "tech_lead"], ["new_member"])).toEqual([]);
    expect(narrowRoleSet(["president", "tech_lead"], null)).toEqual(["president", "tech_lead"]);
    for (const req of [ALL_ROLES, ["leaver"], [], ["president", "president"]] as const) {
      const out = narrowRoleSet(["president", "tech_lead"], req as never);
      expect(out.every((x) => ["president", "tech_lead"].includes(x))).toBe(true);
    }
  });

  it("rejects an empty answer", () => {
    expect(() => answerToDrafts("   ", question, "p-1")).toThrow();
  });
});
