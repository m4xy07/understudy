// The recovery ladder core. T-U-11 to T-U-19 of docs/round3/specs/01_recovery.md, with the credit
// rule of docs/round3/DECISIONS.md: Second-hand covers a check of weight 1 or 3; a blocking check
// stays Partial until the approver confirms; Inferred is always Partial; options are never evidence.
import { describe, expect, it } from "vitest";
import type { CheckResult, Claim } from "@/lib/types";
import {
  accessFor, defaultAnswerRoleSet, gapState, ladderSummary, looksLikeNoAnswer, narrowAnswerRoleSet, neighbourAnswerToDrafts,
  neighbourQuestionText, neighbourRowRoleSet, openRoles, projectLeaverRun, routeCandidates, traceServes, traceToDraft,
} from "@/lib/lacuna/core/ladder";
import { checksByResp, checksFor } from "@/lib/lacuna/core/checks";
import { gapKey } from "@/lib/lacuna/core/pack";
import { computeScores } from "@/lib/lacuna/core/scores";
import { countsFully, deterministicStandin, evaluateStandin } from "@/lib/lacuna/core/standin";
import type { NeighbourScore } from "@/lib/tether/graph";
import type { Trace } from "@/lib/tether/traces";
import { ALL_ROLES, claim, metaIndex, resp } from "./fixtures";

const TODAY = "2026-11-11T12:00:00+05:30";
// deploy_operate: access_path 3, steps 3, verify 3, rollback 5, credential_owner 5
const R = resp({ id: "r1", key: "R01", kind: "deploy_operate", entities: ["firmware-deploy"] });
const CHECKS = checksFor(R);
const BY_RESP = checksByResp([R]);
const check = (key: string) => CHECKS.find((c) => c.key === key)!;
const FINANCE = ["president", "treasurer", "leaver"];

function run(claims: Claim[], role = "tech_lead"): CheckResult[] {
  return deterministicStandin(R, CHECKS, claims, metaIndex(claims), role, TODAY);
}

describe("T-U-11: accessFor", () => {
  it("is walled when a live claim that could satisfy the check is hidden from the role", () => {
    const hidden = claim({ entity: "firmware-deploy", attribute: "procedure", roleSet: FINANCE });
    const meta = metaIndex([hidden]);
    expect(accessFor(R, check("steps"), "tech_lead", meta)).toBe("walled");
    expect(accessFor(R, check("steps"), "treasurer", meta)).toBe("open");
    expect(accessFor(R, check("access_path"), "tech_lead", meta)).toBe("open"); // other attribute
    expect(openRoles(R, check("steps"), ALL_ROLES, meta)).toEqual(["president", "treasurer", "leaver"]);
  });

  it("a conflicting claim walls too; superseded and dropped claims do not", () => {
    const conflicting = claim({ entity: "firmware-deploy", attribute: "procedure", roleSet: FINANCE, state: "conflicting" });
    expect(accessFor(R, check("steps"), "tech_lead", metaIndex([conflicting]))).toBe("walled");
    const old = [
      claim({ entity: "firmware-deploy", attribute: "procedure", roleSet: FINANCE, state: "superseded" }),
      claim({ entity: "firmware-deploy", attribute: "procedure", roleSet: FINANCE, state: "dropped" }),
      claim({ entity: "other-thing", attribute: "procedure", roleSet: FINANCE }),
    ];
    expect(accessFor(R, check("steps"), "tech_lead", metaIndex(old))).toBe("open");
  });
});

describe("routing neighbours", () => {
  const score = (personId: string, s: number, roleSet = ALL_ROLES): NeighbourScore =>
    ({ personId, score: s, counts: { wrote: 1, replied: 0, near: 0, files: 0, events: 0 }, segmentIds: [`seg-${personId}`], roleSet });
  const holders = { byPerson: new Map([["p-2", ["president"]], ["p-3", ["treasurer"]], ["p-4", ["tech_lead"]], ["p-1", ["leaver"]]]) };

  it("asks role holders who can see the topic, skips walled roles, shows people with no role, never the leaver", () => {
    const hidden = claim({ entity: "firmware-deploy", attribute: "procedure", roleSet: ["president", "tech_lead", "leaver"] });
    const plan = routeCandidates(
      [score("p-1", 9), score("p-5", 8), score("p-3", 7), score("p-4", 6), score("p-2", 5), score("p-6", 4), score("p-7", 3)],
      holders, R, check("steps"), metaIndex([hidden]), "leaver",
    );
    expect(plan.map((p) => `${p.personId}:${p.status}:${p.role}`)).toEqual([
      "p-5:skipped_no_seat:null", "p-3:skipped_no_access:treasurer", "p-4:asked:tech_lead", "p-2:asked:president", "p-6:skipped_no_seat:null",
    ]);
  });

  it("people with no role who share a display name collapse to the best one", () => {
    const plan = routeCandidates([score("p-5", 8), score("p-10", 7), score("p-12", 6)], holders, R, check("steps"), new Map(), "leaver",
      (id) => (id === "p-12" ? "Someone Else" : "Kabir Sethi"));
    expect(plan.map((p) => p.personId)).toEqual(["p-5", "p-12"]);
  });

  it("a skipped neighbour's role is never in the row's role set", () => {
    const hidden = claim({ entity: "firmware-deploy", attribute: "procedure", roleSet: ["president", "tech_lead", "leaver"] });
    const open = openRoles(R, check("steps"), ALL_ROLES, metaIndex([hidden]));
    expect(neighbourRowRoleSet(ALL_ROLES, open)).toEqual(["president", "tech_lead", "leaver"]);
    expect(neighbourRowRoleSet(["president", "treasurer"], open)).toEqual(["president"]);
  });

  it("the question for a neighbour is about the leaver and quotes only values that role may see", () => {
    const decision = resp({ id: "r2", key: "R10", title: "Drive team selection", kind: "open_decision", entities: ["team-selection"] });
    const owner = checksFor(decision).find((c) => c.key === "owner")!;
    expect(neighbourQuestionText({ gapType: "missing" }, decision, owner, "open_decision", [], "president", "Asha"))
      .toBe("Who decides Drive team selection now that Asha cannot be reached?");
    const deadline = checksFor(decision).find((c) => c.key === "deadline")!;
    const a = claim({ id: "a", entity: "team-selection", attribute: "deadline", value: "22 Nov", state: "conflicting" });
    const b = claim({ id: "b", entity: "team-selection", attribute: "deadline", value: "29 Nov", state: "conflicting", roleSet: FINANCE });
    const forTreasurer = neighbourQuestionText({ gapType: "conflicting", claimIds: ["a", "b"] }, decision, deadline, "open_decision", [a, b], "treasurer", "Asha");
    expect(forTreasurer).toContain("22 Nov");
    expect(forTreasurer).toContain("29 Nov");
    const forTechLead = neighbourQuestionText({ gapType: "conflicting", claimIds: ["a", "b"] }, decision, deadline, "open_decision", [a], "tech_lead", "Asha");
    expect(forTechLead).not.toContain("29 Nov");
  });
});

describe("T-U-12: Second-hand evidence", () => {
  const before = run([]);
  const scoresBefore = computeScores(before, BY_RESP);

  it("on a blocking check stays Partial: B is unchanged and K does not rise", () => {
    const answer = claim({ id: "sh", entity: "firmware-deploy", attribute: "owner", trust: "second_hand" });
    const after = run([answer]);
    const r = after.find((x) => x.checkKey === "credential_owner")!;
    expect(r.coverage).toBe("partial");
    expect(r.bestTrust).toBe("second_hand");
    const s = computeScores(after, BY_RESP);
    expect(s.b).toBe(scoresBefore.b);
    expect(s.c).toBeGreaterThan(scoresBefore.c);
    expect(s.k ?? 0).toBeLessThanOrEqual(scoresBefore.k ?? 0);
    // model path: the stand-in says "can do", code still gives Partial
    const [m] = evaluateStandin(
      { checks: [{ check_key: "credential_owner", status: "can_do", claim_ids: ["sh"], blocker: "" }] },
      { resp: R, checks: [check("credential_owner")], role: "tech_lead", visibleClaimsById: new Map([["sh", answer]]), allClaimsMeta: metaIndex([answer]) },
    );
    expect(m.coverage).toBe("partial");
  });

  it("on a check of weight 3 covers it, and K still does not rise", () => {
    const record = claim({ id: "rec", entity: "firmware-deploy", attribute: "location", trust: "from_record" });
    const base = computeScores(run([record]), BY_RESP);
    const answer = claim({ id: "sh3", entity: "firmware-deploy", attribute: "procedure", trust: "second_hand" });
    const after = run([record, answer]);
    expect(after.find((x) => x.checkKey === "steps")!.coverage).toBe("covered");
    expect(after.find((x) => x.checkKey === "rollback")!.coverage).toBe("partial"); // same attribute, blocking check
    const s = computeScores(after, BY_RESP);
    expect(s.b).toBe(base.b);
    expect(base.k).toBe(1);
    expect(s.k!).toBeLessThan(1);
  });

  it("on a blocking check counts fully only after the approver confirmed it in review", () => {
    const pending = claim({ entity: "firmware-deploy", attribute: "owner", trust: "second_hand" });
    expect(countsFully(pending, check("credential_owner"))).toBe(false);
    expect(countsFully({ ...pending, review: "approved" }, check("credential_owner"))).toBe(true);
    expect(countsFully({ ...pending, review: "rejected" }, check("credential_owner"))).toBe(false);
    const approved = run([{ ...pending, review: "approved" }]);
    expect(approved.find((x) => x.checkKey === "credential_owner")!.coverage).toBe("covered");
  });
});

describe("T-U-13: Inferred evidence", () => {
  it("is Partial at most on any weight, alone or together with Second-hand on a blocking check (no stacking)", () => {
    const trace = claim({ id: "tr", entity: "firmware-deploy", attribute: "procedure", trust: "inferred" });
    const alone = run([trace]);
    expect(alone.find((x) => x.checkKey === "steps")!.coverage).toBe("partial");
    expect(alone.find((x) => x.checkKey === "rollback")!.coverage).toBe("partial");
    expect(countsFully({ ...trace, review: "approved" }, check("steps"))).toBe(false);
    const sh = claim({ id: "sh", entity: "firmware-deploy", attribute: "procedure", trust: "second_hand" });
    const both = run([trace, sh]);
    const rollback = both.find((x) => x.checkKey === "rollback")!;
    expect(rollback.coverage).toBe("partial");
    expect(rollback.bestTrust).toBe("second_hand");
    const sAlone = computeScores(alone, BY_RESP);
    const sBoth = computeScores(both, BY_RESP);
    expect(sBoth.b).toBe(sAlone.b);
    expect(sAlone.k).toBe(0);
  });

  it("a record on the same check keeps it Covered with the record's trust", () => {
    const record = claim({ id: "rec", entity: "firmware-deploy", attribute: "procedure", trust: "from_record" });
    const trace = claim({ id: "tr", entity: "firmware-deploy", attribute: "procedure", trust: "inferred" });
    const r = run([record, trace]).find((x) => x.checkKey === "rollback")!;
    expect(r.coverage).toBe("covered");
    expect(r.bestTrust).toBe("from_record");
  });
});

describe("T-U-14: ranked options are not evidence", () => {
  it("a claim with trust ranked_options leaves coverage and all three scores exactly as they were", () => {
    const record = claim({ id: "rec", entity: "firmware-deploy", attribute: "location", trust: "from_record" });
    const option = claim({ id: "opt", entity: "firmware-deploy", attribute: "owner", trust: "ranked_options" });
    const option2 = claim({ id: "opt2", entity: "firmware-deploy", attribute: "procedure", trust: "ranked_options" });
    const without = run([record]);
    const withOptions = run([record, option, option2]);
    expect(withOptions).toEqual(without);
    expect(computeScores(withOptions, BY_RESP)).toEqual(computeScores(without, BY_RESP));
    const [m] = evaluateStandin(
      { checks: [{ check_key: "steps", status: "can_do", claim_ids: ["opt2"], blocker: "" }] },
      { resp: R, checks: [check("steps")], role: "tech_lead", visibleClaimsById: new Map([["opt2", option2]]), allClaimsMeta: metaIndex([option2]) },
    );
    expect(m.coverage).not.toBe("covered");
  });
});

describe("T-U-15: the before and after panel", () => {
  it("the projection equals a real deterministic run in which the leaver answered the same gaps", () => {
    const record = claim({ id: "rec", entity: "firmware-deploy", attribute: "location", trust: "from_record" });
    const baseline = run([record]);
    const gaps = new Set(["steps", "rollback", "credential_owner"].map((k) => gapKey("r1", k)));
    const projected = projectLeaverRun({ scores: computeScores(baseline, BY_RESP), results: baseline }, gaps, BY_RESP);
    const answers = [
      claim({ id: "a1", entity: "firmware-deploy", attribute: "procedure", trust: "leaver_said" }),
      claim({ id: "a2", entity: "firmware-deploy", attribute: "owner", trust: "leaver_said" }),
    ];
    // "procedure" also answers "verify" in a real run; the projection only closes the ladder gaps.
    const real = run([record, ...answers]).map((r) => (r.checkKey === "verify" ? baseline.find((b) => b.checkKey === "verify")! : r));
    expect(projected.scores).toEqual(computeScores(real, BY_RESP));
    expect(projected.results.filter((r) => gaps.has(gapKey(r.responsibilityId, r.checkKey))).every((r) => r.coverage === "covered" && r.bestTrust === "leaver_said")).toBe(true);
  });

  it("recovery closes fewer gaps than the projection", () => {
    const baseline = run([]);
    const gaps = new Set(["steps", "rollback", "credential_owner"].map((k) => gapKey("r1", k)));
    const recovered = run([
      claim({ entity: "firmware-deploy", attribute: "procedure", trust: "second_hand" }),
      claim({ entity: "firmware-deploy", attribute: "owner", trust: "second_hand" }),
    ]);
    const without = ladderSummary(gaps, recovered);
    const projected = projectLeaverRun({ scores: computeScores(baseline, BY_RESP), results: baseline }, gaps, BY_RESP);
    const withLeaver = ladderSummary(gaps, projected.results);
    expect(withLeaver).toEqual({ worked: 3, closed: 3, partly: 0, open: 0 });
    expect(without).toEqual({ worked: 3, closed: 1, partly: 2, open: 0 }); // steps (weight 3) closes; both blocking checks stay Partial
    expect(without.closed).toBeLessThan(withLeaver.closed);
    expect(computeScores(recovered, BY_RESP).b).toBe(computeScores(baseline, BY_RESP).b);
    expect(projected.scores.b).toBeLessThan(computeScores(recovered, BY_RESP).b);
    expect(gapState("covered")).toBe("closed");
    expect(gapState("conflicting")).toBe("open");
  });
});

describe("T-U-16: the role set of a neighbour's answer", () => {
  it("is the base cut down to the roles that see every visible record on the topic", () => {
    const sponsor = resp({ id: "r3", key: "R02", kind: "external_relationship", entities: ["title-sponsor"] });
    const open = checksFor(sponsor).find((c) => c.key === "open_commitments")!;
    const visible = [
      claim({ entity: "title-sponsor", attribute: "dependency" }),
      claim({ entity: "title-sponsor", attribute: "decision", roleSet: FINANCE }),
      claim({ entity: "title-sponsor", attribute: "contact", roleSet: ["president"] }),          // other attribute: ignored
      claim({ entity: "title-sponsor", attribute: "dependency", roleSet: ["president"], state: "superseded" }),
    ];
    expect(defaultAnswerRoleSet(ALL_ROLES, sponsor, open, visible, ["treasurer", "president"])).toEqual(["president", "treasurer", "leaver"]);
    expect(defaultAnswerRoleSet(ALL_ROLES, sponsor, open, [], ["treasurer", "president"])).toEqual(ALL_ROLES);
  });

  it("narrowing never widens, and the neighbour's role and the approver stay", () => {
    const base = ["president", "treasurer", "leaver"];
    expect(narrowAnswerRoleSet(base, ["tech_lead", "new_member"], ["treasurer", "president"])).toEqual(["president", "treasurer"]);
    expect(narrowAnswerRoleSet(base, ["leaver"], ["treasurer", "president"])).toEqual(base);
    expect(narrowAnswerRoleSet(base, [], ["treasurer", "president"])).toEqual(base);
    expect(narrowAnswerRoleSet(base, null, ["treasurer", "president"])).toEqual(base);
  });
});

describe("T-U-17: a neighbour's answer as a claim", () => {
  const question = { id: "gq_1", text: "Who holds the key?", resp: R, check: check("credential_owner"), roleSet: ALL_ROLES, entityLabel: "Firmware deploy" };
  const opts = { ts: TODAY, sourceId: "src_recovery", workspaceId: "ws" };

  it("is Second-hand, origin neighbour_answer, in the recovery thread, with a deterministic segment id", () => {
    const a = neighbourAnswerToDrafts("She typed it herself each time.", question, { id: "p-4", name: "Asha Rao" }, opts);
    const b = neighbourAnswerToDrafts("She typed it herself each time.", question, { id: "p-4", name: "Asha Rao" }, opts);
    expect(a.claim.trust).toBe("second_hand");
    expect(a.claim.origin).toBe("neighbour_answer");
    expect(a.segment.thread).toBe("recovery:R01:credential_owner:p-4");
    expect(a.segment.kind).toBe("answer");
    expect(a.segment.id).toBe(b.segment.id);
    expect(a.claim.citations).toEqual([{ segmentId: a.segment.id, quote: "She typed it herself each time.", accepted: true, exact: true }]);
    expect(a.claim.statement).toBe("Asha Rao said (second-hand): She typed it herself each time.");
    expect(a.claim.attribute).toBe(check("credential_owner").attributes[0]);
    const other = neighbourAnswerToDrafts("She typed it herself each time.", question, { id: "p-2", name: "Ravi" }, opts);
    expect(other.segment.id).not.toBe(a.segment.id);
  });

  it("carries the narrowed role set", () => {
    const a = neighbourAnswerToDrafts("x y z", { ...question, roleSet: ["president", "tech_lead"] }, { id: "p-4", name: "A" }, opts);
    expect(a.claim.roleSet).toEqual(["president", "tech_lead"]);
    expect(a.segment.roleSet).toEqual(["president", "tech_lead"]);
  });
});

describe("T-U-18: a non-answer is a decline", () => {
  it("catches the usual phrases and lets a real answer through", () => {
    for (const t of ["I don't know", "i dont know.", "no idea", "Not sure, ask Priya", "idk", "I can't say", "  ", "N/A"]) {
      expect(looksLikeNoAnswer(t), t).toBe(true);
    }
    for (const t of [
      "Priya has it. She typed it on the lab laptop herself each time.",
      "I don't know the exact date, but Kabir told me the form has to reach the lab office by 1 December.",
      "Arjun will own it.",
    ]) expect(looksLikeNoAnswer(t), t).toBe(false);
  });
});

describe("T-U-19: which check a trace can serve", () => {
  const lab = resp({ id: "r4", key: "R03", kind: "recurring_obligation", entities: ["lab-booking"] });
  const nextDue = { ...checksFor(lab).find((c) => c.key === "next_due")!, needsDate: true };
  const cadence = checksFor(lab).find((c) => c.key === "cadence")!;

  it("a cadence without an upcoming date does not serve a check that needs a date", () => {
    const noDate = claim({ entity: "lab-booking", attribute: "deadline", trust: "inferred", value: "Happened 3 times, 7 and 11 weeks apart" });
    expect(traceServes(noDate, lab, nextDue, "tech_lead", TODAY)).toBe(false);
    expect(traceServes(noDate, lab, cadence, "tech_lead", TODAY)).toBe(true);
    const dated = claim({ entity: "lab-booking", attribute: "deadline", trust: "inferred", value: "every year on 2 December; next 2026-12-02" });
    expect(traceServes(dated, lab, nextDue, "tech_lead", TODAY)).toBe(true);
    const past = claim({ entity: "lab-booking", attribute: "deadline", trust: "inferred", value: "2026-10-12" });
    expect(traceServes(past, lab, nextDue, "tech_lead", TODAY)).toBe(false);
  });

  it("a check that asks who is never served, and a hidden trace serves nobody", () => {
    const who = claim({ entity: "firmware-deploy", attribute: "owner", trust: "inferred" });
    expect(traceServes(who, R, check("credential_owner"), "tech_lead", TODAY)).toBe(false);
    const hidden = claim({ entity: "firmware-deploy", attribute: "procedure", trust: "inferred", roleSet: FINANCE });
    expect(traceServes(hidden, R, check("steps"), "tech_lead", TODAY)).toBe(false);
    expect(traceServes(hidden, R, check("steps"), "treasurer", TODAY)).toBe(true);
  });

  it("a trace becomes a structured draft with one citation per step", () => {
    const trace: Trace = {
      id: "trc_1", kind: "commit_sequence", entityKey: "domain-dns", attribute: "procedure", title: "Rebuilt from 2 commits to dns/",
      sourceLabel: "2 commits to dns/", value: "In order: a; b", roleSet: ALL_ROLES,
      steps: [
        { n: 1, text: "1 Oct 2026 A: a", kind: "quoted", citations: [{ segmentId: "s1", quote: "a" }] },
        { n: 2, text: "both changed together", kind: "derived", citations: [{ segmentId: "s1", quote: null }, { segmentId: "s2", quote: null }] },
      ],
    };
    const d = traceToDraft(trace);
    expect(d).toMatchObject({ entity: "domain-dns", attribute: "procedure", value: "In order: a; b", origin: "structured", batchId: "trc_1" });
    expect(d.citations).toEqual([{ segment_id: "s1", quote: "a" }, { segment_id: "s1", quote: null }, { segment_id: "s2", quote: null }]);
    expect(d.statement).toBe("Rebuilt from 2 commits to dns/: 1. 1 Oct 2026 A: a 2. both changed together");
    expect(d.batchSegmentIds).toEqual(["s1", "s2"]);
  });
});
