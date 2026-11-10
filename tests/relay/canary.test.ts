import { describe, expect, it } from "vitest";
import { scanForCanaries, surfacesOf } from "@/lib/relay/core/canary";
import { compileHandover, renderMarkdown } from "@/lib/relay/core/compile";
import { ALL_TOKENS, OPEN_TOKEN, SECRET_TOKEN, scenarioClaims, scenarioDoc, scenarioInput } from "./scenario";

describe("scanForCanaries", () => {
  it("finds a planted token in the export, but not when that token is allowed", () => {
    const doc = scenarioDoc("tech_lead");
    const planted = renderMarkdown(doc) + `\n- Note: ${SECRET_TOKEN}\n`;
    const leaks = scanForCanaries(surfacesOf(doc, { export: planted }), new Set([OPEN_TOKEN]), ALL_TOKENS);
    expect(leaks).toEqual([{ surface: "export", token: SECRET_TOKEN }]);
    expect(scanForCanaries(surfacesOf(doc, { export: planted }), new Set(ALL_TOKENS), ALL_TOKENS)).toEqual([]);
  });

  it("passes for the compiled tech lead handover (restricted claim dropped by the defensive filter)", () => {
    const doc = scenarioDoc("tech_lead");
    expect(scanForCanaries(surfacesOf(doc), new Set([OPEN_TOKEN]), ALL_TOKENS)).toEqual([]);
  });

  it("flags a token in the default export and handover when the role may not see it", () => {
    // The open token is visible to everyone; pretend this role may not see it.
    const claims = scenarioClaims().map((c) => (c.id === "c-risk" ? { ...c, statement: `${c.statement} ${OPEN_TOKEN}` } : c));
    const doc = compileHandover(scenarioInput("tech_lead", claims));
    const leaks = scanForCanaries(surfacesOf(doc), new Set(), ALL_TOKENS);
    expect(leaks).toContainEqual({ surface: "handover:risks", token: OPEN_TOKEN });
    expect(leaks).toContainEqual({ surface: "export", token: OPEN_TOKEN });
    expect(scanForCanaries(surfacesOf(doc), new Set([OPEN_TOKEN]), ALL_TOKENS)).toEqual([]);
  });

  it("matches across case and markdown markup, and catches unlisted CANARY-shaped tokens", () => {
    const surfaces = [
      { surface: "questions", text: "What about canary-7f3a?" },
      { surface: "timeline", text: "See `CANARY-7F3A`" },
      { surface: "scores", text: "B 0 · CANARY-ZZZZ" },
      { surface: "stubs", text: "1 restricted item. Ask the approver (Club President)." },
    ];
    expect(scanForCanaries(surfaces, new Set(), [SECRET_TOKEN])).toEqual([
      { surface: "questions", token: SECRET_TOKEN },
      { surface: "timeline", token: SECRET_TOKEN },
      { surface: "scores", token: "CANARY-ZZZZ" },
    ]);
  });
});

describe("surfacesOf", () => {
  it("returns every surface: handover sections, read-back form, stubs, scores, timeline, questions, export", () => {
    const doc = scenarioDoc("tech_lead");
    const surfaces = surfacesOf(doc, { stubs: ["s"], scores: "B 1", timeline: ["t"], questions: ["q1", "q2"] });
    const names = new Set(surfaces.map((s) => s.surface));
    for (const n of [
      "handover:header", "handover:status", "handover:summary", "handover:actions", "handover:risks",
      "handover:synthesis", "handover:timeline", "handover:open_items", "handover:readback_form",
      "stubs", "scores", "timeline", "questions", "export",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
    expect(surfaces.find((s) => s.surface === "export")!.text).toBe(renderMarkdown(doc));
  });
});
