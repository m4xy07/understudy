import { describe, expect, it } from "vitest";
import { evaluate, formatReport, type GroundTruth } from "@/lib/attest/core/evaluate";
import { applyRules } from "@/lib/attest/core/rules";
import { verifyDrafts } from "@/lib/attest/core/verify";
import { draft, pack, seg, segMap } from "./fixtures-verify/build";

// A tiny end-to-end fixture: segments -> drafts -> verify -> rules -> evaluate.
function fixture() {
  const chatDeadline = seg({ text: "Regionals registration closes 27 Oct I think", ts: "2026-10-02T10:00:00Z", authorId: "p-1", sourceId: "src_slack" });
  const boardDeadline = seg({ text: "T-7 | Register for regionals | open | Priya | 2026-10-20", ts: "2026-10-15T10:00:00Z",
    authorId: "p-2", sourceKind: "tasks_csv", kind: "task", sourceId: "src_tasks", thread: "board" });
  const roomA = seg({ text: "Lab is room 101 this term", ts: "2026-10-03T10:00:00Z", authorId: "p-3", sourceId: "src_slack" });
  const roomB = seg({ text: "We are in room 204 now", ts: "2026-10-04T10:00:00Z", authorId: "p-4", sourceKind: "whatsapp", sourceId: "src_wa", thread: "club chat" });
  const rollback = seg({ text: "To roll back, run make flash TAG=v1.3. Token is [SECRET:github]", ts: "2026-10-05T10:00:00Z", authorId: "p-1",
    sourceKind: "github", kind: "file", sourceId: "src_gh", thread: "files/README.md" });
  const budget = seg({ text: "CANARY-B7Q2 sponsor pays 40000 in March", ts: "2026-10-06T10:00:00Z", authorId: "p-5",
    sourceKind: "markdown", kind: "note", sourceId: "src_notes", thread: "notes/budget.md", roleSet: ["president", "treasurer"] });
  const segments = segMap(chatDeadline, boardDeadline, roomA, roomB, rollback, budget);

  const drafts = [
    draft({ entity: "competition", attribute: "deadline", value: "27 Oct", statement: "Regionals registration closes on 27 Oct.",
      citations: [{ segment_id: chatDeadline.id, quote: "closes 27 Oct" }] }),
    draft({ entity: "competition", attribute: "deadline", value: "2026-10-20", statement: "Register for regionals by 2026-10-20.",
      origin: "structured", citations: [{ segment_id: boardDeadline.id, quote: "2026-10-20" }] }),
    draft({ entity: "lab-booking", attribute: "location", value: "room 101", statement: "The lab is room 101.",
      citations: [{ segment_id: roomA.id, quote: "room 101" }] }),
    draft({ entity: "lab-booking", attribute: "location", value: "room 204", statement: "The lab is room 204.",
      citations: [{ segment_id: roomB.id, quote: "room 204" }] }),
    draft({ entity: "firmware-deploy", attribute: "procedure", value: "make flash TAG=v1.3", statement: "Roll back by flashing the previous tag.",
      citations: [{ segment_id: rollback.id, quote: "run make flash TAG=v1.3" }] }),
    draft({ entity: "sponsor", attribute: "deadline", value: "March", statement: "CANARY-B7Q2 sponsor pays in March.",
      citations: [{ segment_id: budget.id, quote: "sponsor pays 40000 in March" }] }),
    // Noise: an unplanted claim, a claim about "other", and a hallucinated citation.
    draft({ entity: "firmware-deploy", attribute: "risk", value: "bricking", statement: "Flashing can brick the board.",
      citations: [{ segment_id: rollback.id, quote: "may brick the board" }] }),
    draft({ entity: "other", attribute: "status", value: "fine", statement: "Things are fine.",
      citations: [{ segment_id: roomA.id, quote: "this term" }] }),
    draft({ entity: "lab-booking", attribute: "owner", value: "Priya", statement: "Priya books the lab.",
      citations: [{ segment_id: "seg_made_up_000000", quote: "Priya books" }] }),
  ];

  const verified = verifyDrafts(drafts, segments, pack, "ws");
  const { claims, firings } = applyRules(verified.claims, pack, { segmentsById: segments });
  return { segments, verified, claims, firings };
}

const gt: GroundTruth = {
  claims: [
    { id: "G1", entity: "competition", attribute: "deadline", value: "2026-10-20", keywords: ["2026-10-20"],
      source: { kind: "tasks_csv", path: "tasks/board.csv", contains: "Register for regionals" },
      roleSet: ["president", "tech_lead", "new_member", "treasurer", "leaver"], check: "next_date" },
    { id: "G2", entity: "firmware-deploy", attribute: "procedure", value: "make flash TAG=v1.3", keywords: ["make flash", "v1.3"],
      source: { kind: "github", path: "github/files/README.md", contains: "roll back" },
      roleSet: ["president", "tech_lead", "new_member", "treasurer", "leaver"], check: "rollback" },
    { id: "G3", entity: "sponsor", attribute: "deadline", value: "March", keywords: ["march"],
      source: { kind: "markdown", path: "notes/budget.md", contains: "sponsor pays" },
      roleSet: ["president", "treasurer"], check: "next_date" },
    { id: "G4", entity: "lab-booking", attribute: "owner", value: "Priya", keywords: ["priya"],
      source: { kind: "slack", path: "slack/lab.json", contains: "book" }, roleSet: ["president", "tech_lead", "new_member", "treasurer", "leaver"], check: "owner" },
  ],
  supersessions: [{ entity: "competition", attribute: "deadline", old: "27 Oct", new: "2026-10-20", rule: 1 }],
  conflicts: [{ entity: "lab-booking", attribute: "location", values: ["room 101", "room 204"] }],
  restricted: [{ token: "CANARY-B7Q2", roleSet: ["president", "treasurer"], where: "notes/budget.md" }],
  secrets: [{ where: "github/files/README.md", type: "github", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
};

describe("evaluate", () => {
  it("scores a small hand-made fixture", () => {
    const { segments, verified, claims, firings } = fixture();
    const r = evaluate({ claims, segmentsById: segments, groundTruth: gt, dropped: verified.dropped, firings });

    expect(r.totals).toMatchObject({ claims: 8, superseded: 1, conflicting: 2, droppedDrafts: 1 });
    // Recall: G1, G2, G3 matched; G4's only draft cited a made-up segment and was dropped.
    expect(r.recall).toMatchObject({ num: 3, den: 4 });
    expect(r.unmatched.map((u) => u.id)).toEqual(["G4"]);
    expect(r.perEntity["lab-booking"]).toEqual({ expected: 1, matched: 0, recall: 0 });
    expect(r.perEntity["competition"]).toEqual({ expected: 1, matched: 1, recall: 1 });
    // Precision ignores "other": 7 scored; correct = 27 Oct (superseded, matches nothing) ... see below.
    // Matched: board deadline (G1), rollback (G2), sponsor (G3), plus the two planted-conflict room claims.
    expect(r.precision).toMatchObject({ num: 5, den: 7 });
    // On answer-key topics the unplanted "bricking" risk is not judged; the superseded 27 Oct
    // deadline sits on a planted topic and still counts as wrong.
    expect(r.topicPrecision).toMatchObject({ num: 5, den: 6 });
    // Citations: 8 live + 1 dropped; inexact: "may brick the board".
    expect(r.citationPassRate).toMatchObject({ num: 7, den: 9 });
    expect(r.supersessions).toMatchObject({ found: 1, expected: 1, ruleMatched: 1 });
    expect(r.plantedConflicts).toMatchObject({ found: 1, expected: 1 });
    expect(r.falseConflicts.count).toBe(0);
    expect(r.secretsLeaked.count).toBe(0);
    expect(r.restrictedViolations.count).toBe(0);
    expect(r.roleSetCorrect).toMatchObject({ num: 3, den: 3 });
    expect(r.sourceCorrect).toMatchObject({ num: 3, den: 3 });

    const md = formatReport(r);
    expect(md).toContain("# Attest evaluation");
    expect(md).toContain("| Recall | 75.0% (3/4) |");
    expect(md).toContain("| Precision, strict (every claim on a known entity) | 71.4% (5/7) |");
    expect(md).toContain("| Precision on answer-key topics | 83.3% (5/6) |");
    expect(md).toContain("| Secrets leaked (must be 0) | 0 |");
    expect(md).toContain("G4: lab-booking / owner = Priya");
  });

  it("precision on answer-key topics ignores true extra facts but not wrong values on planted topics", () => {
    const { segments, claims } = fixture();
    const base = evaluate({ claims, segmentsById: segments, groundTruth: gt });
    const extra = claims.find((c) => c.attribute === "procedure")!;
    const more = [
      ...claims,
      // A true fact the answer key never planted: hurts strict precision only.
      { ...extra, id: "clm_extra_topic", attribute: "risk" as const, value: "board overheats", statement: "The board can overheat." },
      // A wrong value on a planted topic: hurts both.
      { ...extra, id: "clm_wrong_topic", value: "make flash TAG=v9.9", statement: "Roll back with make flash TAG=v9.9." },
    ];
    const r = evaluate({ claims: more, segmentsById: segments, groundTruth: gt });
    expect(r.precision).toMatchObject({ num: base.precision.num, den: base.precision.den + 2 });
    expect(r.topicPrecision).toMatchObject({ num: base.topicPrecision.num, den: base.topicPrecision.den + 1 });
  });

  it("flags leaked secrets, restricted-token widening and false conflicts", () => {
    const { segments, claims } = fixture();
    const leaky = claims.map((c) =>
      c.attribute === "procedure" ? { ...c, statement: c.statement + " ghp_abcdefghijklmnopqrstuvwxyz0123456789" } :
      c.entity === "sponsor" ? { ...c, roleSet: ["president", "treasurer", "new_member"] as typeof c.roleSet } : c,
    );
    const r = evaluate({ claims: leaky, segmentsById: segments, groundTruth: { ...gt, conflicts: [] } });
    expect(r.secretsLeaked.count).toBe(1);
    expect(r.secretsLeaked.hits[0]).toMatchObject({ field: "statement", type: "github" });
    expect(r.restrictedViolations.hits).toEqual([expect.objectContaining({ token: "CANARY-B7Q2", extraRoles: ["new_member"] })]);
    expect(r.falseConflicts.count).toBe(1);
    expect(formatReport(r)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

// Regression: attest_dropped.citations can come back as JSON text; reading `.length` of that text
// counted every character as a citation (3 dropped drafts turned a 99% citation pass rate into 45%).
describe("droppedFromRow", () => {
  const row = (citations: unknown) => ({
    source_id: "src_gh", reason: "r", entity: "e", attribute: "deadline", value: "v", statement: "s", citations,
  });
  const cs = [{ segment_id: "seg_1", quote: "a quote" }, { segment_id: "seg_2", quote: null }];

  it("reads citations stored as jsonb or as JSON text", async () => {
    const { droppedFromRow } = await import("@/lib/attest/evaluation");
    expect(droppedFromRow(row(cs)).draft.citations).toEqual(cs);
    expect(droppedFromRow(row(JSON.stringify(cs))).draft.citations).toEqual(cs);
    expect(droppedFromRow(row(null)).draft.citations).toEqual([]);
    expect(droppedFromRow(row("not json")).draft.citations).toEqual([]);
  });
});
