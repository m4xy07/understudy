// The Ask step's hint: it must not tell the viewer to switch to the leaver while recovery is on.
import { describe, expect, it } from "vitest";
import { askHint } from "@/lib/progress";
import { getPack } from "@/lib/pack";

describe("askHint", () => {
  for (const id of ["club", "lab"]) {
    const pack = getPack(id);
    it(`${id}: recovery on points at the people listed on the Ask page, whoever is viewing`, () => {
      for (const viewerIsLeaver of [true, false]) {
        const hint = askHint(pack, { recovery: true, viewerIsLeaver });
        expect(hint).toContain("marked as unreachable");
        expect(hint).toContain("ask the people listed on the Ask page");
        expect(hint).not.toMatch(/switch to/i);
        expect(hint.startsWith(pack.leaverPerson.name.trim() || "The leaver")).toBe(true);
      }
    });
    it(`${id}: recovery off keeps the leaver hints`, () => {
      expect(askHint(pack, { recovery: false })).toMatch(/^Switch to .+ \(leaver\) and answer a gap question\.$/);
      expect(askHint(pack, { recovery: false, viewerIsLeaver: true })).toBe("Answer a gap question.");
    });
  }
});
