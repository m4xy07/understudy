import { describe, expect, it } from "vitest";
import { compileHandover, formatScores, renderMarkdown, stubText } from "@/lib/relay/core/compile";
import { OPEN_GAPS_NOTE } from "@/lib/relay/core/labels";
import { SECRET_TOKEN, scenarioClaims, scenarioDoc, scenarioInput } from "./scenario";
import { CLUB_APPROVER_LABEL } from "../helpers/club";

const section = (doc: ReturnType<typeof scenarioDoc>, key: string) => doc.sections.find((s) => s.key === key)!;
const texts = (doc: ReturnType<typeof scenarioDoc>) => doc.sections.flatMap((s) => s.lines.map((l) => l.text));

describe("stubText", () => {
  it("has the exact wording, singular and plural", () => {
    expect(stubText(1, CLUB_APPROVER_LABEL)).toBe("1 restricted item. Ask the approver (Club President).");
    expect(stubText(2, CLUB_APPROVER_LABEL)).toBe("2 restricted items. Ask the approver (Club President).");
    expect(stubText(12, CLUB_APPROVER_LABEL)).toBe("12 restricted items. Ask the approver (Club President).");
    expect(stubText(0, CLUB_APPROVER_LABEL)).toBeNull();
    expect(stubText(-3, CLUB_APPROVER_LABEL)).toBeNull();
  });
});

describe("formatScores", () => {
  it("shows B, then C, then K", () => {
    expect(formatScores({ b: 1, c: 0.91, k: 0.5 })).toBe("B 1 · C 91% · K 50%");
    expect(formatScores({ b: 0, c: 0, k: null })).toBe("B 0 · C 0% · K n/a");
  });
});

describe("compileHandover", () => {
  const doc = scenarioDoc("tech_lead");

  it("renders sections in I-PASS order, then timeline and open items", () => {
    expect(doc.sections.map((s) => s.key)).toEqual(["status", "summary", "actions", "risks", "synthesis", "timeline", "open_items"]);
    expect(doc.sections.map((s) => s.letter)).toEqual(["I", "P", "A", "S", "S", null, null]);
    expect(doc.sections.map((s) => s.title)).toEqual([
      "Workstream status", "Project summary", "Action list", "Situation awareness and contingency",
      "Synthesis by receiver", "Decision timeline", "Open items",
    ]);
  });

  it("every line carries text, trust, claim ids and segment ids", () => {
    for (const s of doc.sections) {
      for (const l of s.lines) {
        expect(typeof l.text).toBe("string");
        expect(l).toHaveProperty("trust");
        expect(Array.isArray(l.claimIds)).toBe(true);
        expect(Array.isArray(l.segmentIds)).toBe(true);
        if (l.claimIds.length) expect(l.segmentIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("I: release label, scores text and provisional note", () => {
    const lines = section(doc, "status").lines.map((l) => l.text);
    expect(lines[0]).toBe("Released with 2 open blocking gaps");
    expect(lines).toContain("B 1 · C 91% · K 50%");
    expect(lines).toContain("Scores are provisional until review.");
    // 2 open gaps next to B 1 reads as a contradiction without the note.
    expect(lines).toContain(OPEN_GAPS_NOTE);
    expect(lines.join(" ").toLowerCase()).not.toContain("complete");
  });

  it("P: one line per visible responsibility with owner, status, deadline and the weakest trust", () => {
    const lines = section(doc, "summary").lines;
    const r01 = lines.find((l) => l.text.startsWith("R01"))!;
    expect(r01.text).toBe("R01 Deploy firmware to the robot: owner Priya Nair; status In progress; due 28 Nov 2026.");
    expect(r01.trust).toBe("corroborated");
    expect(r01.claimIds.sort()).toEqual(["c-deadline", "c-owner", "c-status"]);
    expect(lines.find((l) => l.text.startsWith("R03"))!.text).toContain("owner not named");
    expect(lines.some((l) => l.text.startsWith("R02"))).toBe(false); // no visible claim: never named
  });

  it("A: actions sorted by date, each with owner and date", () => {
    const lines = section(doc, "actions").lines.filter((l) => l.kind === "action" || l.kind === "plan");
    expect(lines.map((l) => l.date)).toEqual(["2026-11-28", "2026-11-30"]);
    expect(lines[0].text).toBe("Due 2026-11-28: Firmware deploy to the robot. Owner: Priya Nair. Status: In progress.");
    expect(lines[1].text).toContain("Owner: Arjun (tech lead)");
  });

  it("S: risks, dependencies, conflicts (ask the approver) and access by credential name", () => {
    const lines = section(doc, "risks").lines.map((l) => l.text);
    expect(lines).toContain("Risk: Flashing without the backup image bricks the controller.");
    expect(lines).toContain("Dependency: Deploys need the workshop lab booked.");
    expect(lines).toContain('Two sources disagree: Regional competition location is "Hall A" or "Hall B". Ask the approver (Club President).');
    expect(lines).toContain("Access: Firmware deploy to the robot needs the credential named ROBOT_SSH_KEY.");
  });

  it("S: synthesis lists only read-back items the role can see, stubbing the rest", () => {
    expect(doc.readbackForm.map((r) => r.key)).toEqual(["competition_date", "deploy_command"]);
    const lines = section(doc, "synthesis").lines.map((l) => l.text);
    expect(lines).toContain("1 restricted item. Ask the approver (Club President).");
    expect(lines.join(" ")).not.toContain("Sponsor");
  });

  it("decision timeline is ordered by validFrom, decision before reason", () => {
    const lines = section(doc, "timeline").lines.filter((l) => l.kind !== "stub").map((l) => l.text);
    expect(lines).toEqual([
      "2026-09-01 · Decision: Firmware stays in C++.",
      "2026-10-05 · Decision: Switched the controller to Teensy 4.1.",
      "2026-10-05 · Reason: The old board ran out of pins.",
    ]);
  });

  it("open items: visible blocking gaps with owner, due date and risk note; hidden ones stubbed", () => {
    const lines = section(doc, "open_items").lines.map((l) => l.text);
    expect(lines[0]).toBe("R01 Deploy firmware to the robot: Rollback. Owner: Arjun (tech lead). Due 2026-11-30. Risk: Robot cannot be restored if a flash fails.");
    expect(lines[1]).toBe("1 restricted item. Ask the approver (Club President).");
  });

  it("stubs use the exact wording per section and never show topic, compartment, role or value", () => {
    expect(section(doc, "summary").lines.at(-1)!.text).toBe("2 restricted items. Ask the approver (Club President).");
    expect(section(doc, "actions").lines.at(-1)!.text).toBe("1 restricted item. Ask the approver (Club President).");
    expect(section(doc, "timeline").lines.at(-1)!.text).toBe("1 restricted item. Ask the approver (Club President).");
    expect(section(doc, "risks").lines.some((l) => l.kind === "stub")).toBe(false);
    for (const s of doc.sections) {
      for (const l of s.lines.filter((x) => x.kind === "stub")) {
        expect(l.text).toMatch(/^\d+ restricted items?\. Ask the approver \(Club President\)\.$/);
        expect(l.text.toLowerCase()).not.toMatch(/sponsor|treasurer|canary|dec 2026/);
        expect(l.claimIds).toEqual([]);
        expect(l.segmentIds).toEqual([]);
      }
    }
  });

  it("every visible claim appears on at least one line (procedures as 'How to' actions)", () => {
    const rendered = new Set(doc.sections.flatMap((s) => s.lines.flatMap((l) => l.claimIds)));
    for (const c of scenarioClaims().filter((x) => x.id !== "c-secret")) expect(rendered.has(c.id), c.id).toBe(true);
    expect(section(doc, "actions").lines.map((l) => l.text)).toContain(
      "How to (Firmware deploy to the robot): Flash with make flash-safe. (edited by reviewer)",
    );
  });

  it("defensively drops a claim whose role set lacks the role and records a violation", () => {
    expect(doc.violations).toEqual([{ claimId: "c-secret", reason: "role_not_in_role_set" }]);
    expect(texts(doc).join("\n")).not.toContain(SECRET_TOKEN);
    expect(doc.sections.flatMap((s) => s.lines.flatMap((l) => l.claimIds))).not.toContain("c-secret");
  });

  it("the same claim renders for a role in its role set without violations", () => {
    const president = compileHandover(scenarioInput("president"));
    expect(president.violations).toEqual([]);
    expect(texts(president).join("\n")).toContain(SECRET_TOKEN);
  });

  it("labels reviewer-edited text and keeps its trust", () => {
    const input = scenarioInput("tech_lead", scenarioClaims().map((c) => (c.id === "c-owner" ? { ...c, review: "edited" as const } : c)));
    const r01 = compileHandover(input).sections[1].lines.find((l) => l.text.startsWith("R01"))!;
    expect(r01.text.endsWith("(edited by reviewer)")).toBe(true);
    expect(r01.edited).toBe(true);
  });

  it("shows an empty note when a section has nothing and nothing is withheld", () => {
    const empty = compileHandover({ ...scenarioInput("new_member", []), plan: [], readbackItems: [], responsibilities: [], withheldCounts: { status: 0, summary: 0, actions: 0, risks: 0, timeline: 0 } });
    expect(empty.sections.find((s) => s.key === "open_items")!.lines[0]).toMatchObject({ kind: "empty", text: "No open blocking gaps." });
  });
});

describe("renderMarkdown", () => {
  it("exports the same doc with trust labels in words and [^seg_…] footnotes", () => {
    const doc = scenarioDoc("tech_lead");
    const md = renderMarkdown(doc);
    expect(md).toContain("# Handover for Incoming tech lead");
    expect(md).toContain("## I · Workstream status");
    expect(md).toContain("## Decision timeline");
    expect(md).toContain("(Corroborated)");
    expect(md).toContain("(From record)");
    expect(md).toMatch(/\[\^seg_[0-9a-z-]+\]/);
    expect(md).toMatch(/^\[\^seg_[^\]]+\]: Evidence segment seg_/m);
    expect(md).toContain("2 restricted items. Ask the approver (Club President).");
    expect(md).not.toContain(SECRET_TOKEN);
    expect(md.indexOf("## I ·")).toBeLessThan(md.indexOf("## P ·"));
    expect(md.indexOf("## P ·")).toBeLessThan(md.indexOf("## A ·"));
  });
});
