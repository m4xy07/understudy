import { describe, expect, it } from "vitest";
import {
  applyRules,
  applySupersession,
  assignImportanceAndTier,
  corroborate,
  importanceOf,
  tierOf,
} from "@/lib/attest/core/rules";
import { claim, pack, seg, segMap } from "./fixtures-verify/build";
import { CLUB_RESTRICTED } from "../helpers/club";

const byId = <T extends { id: string }>(xs: T[], id: string) => xs.find((x) => x.id === id)!;

describe("supersession and conflicts (single-valued attributes)", () => {
  it("rule 1: a newer claim from a higher-authority source supersedes the older one", () => {
    const chat = claim({ id: "old", value: "2026-10-27", sourceKinds: ["slack"], validFrom: "2026-10-05T10:00:00Z", authorId: "p-1" });
    const board = claim({ id: "new", value: "2026-10-20", sourceKinds: ["tasks_csv"], validFrom: "2026-10-20T08:00:00Z", authorId: "p-2" });
    const { claims, firings } = applySupersession([chat, board], pack);
    expect(byId(claims, "old")).toMatchObject({
      state: "superseded",
      supersededBy: "new",
      stateNote: "Superseded: the task board owns deadlines (updated on 2026-10-20)",
    });
    expect(byId(claims, "new").state).toBe("active");
    expect(firings).toEqual([{ rule: 1, olderId: "old", newerId: "new" }]);
    // Inputs are not mutated.
    expect(chat.state).toBe("active");
  });

  it("rule 2: the same person correcting themselves is an update, not a conflict", () => {
    const first = claim({ id: "a", value: "Room 101", attribute: "location", entity: "lab-booking",
      sourceKinds: ["slack"], validFrom: "2026-10-01T10:00:00Z", authorId: "p-1" });
    const fix = claim({ id: "b", value: "Room 204", attribute: "location", entity: "lab-booking",
      sourceKinds: ["whatsapp"], validFrom: "2026-10-02T10:00:00Z", authorId: "p-1" });
    const { claims, firings } = applySupersession([first, fix], pack);
    expect(byId(claims, "a")).toMatchObject({ state: "superseded", supersededBy: "b",
      stateNote: "Superseded: the same person updated it on 2026-10-02" });
    expect(byId(claims, "b").state).toBe("active");
    expect(firings).toEqual([{ rule: 2, olderId: "a", newerId: "b" }]);
  });

  it("rule 2: a reply that quotes the earlier message supersedes it", () => {
    const s1 = seg({ text: "Regionals deadline is 27 Oct", ts: "2026-10-01T10:00:00Z", authorId: "p-1" });
    const s2 = seg({ text: "Correction: it moved to 20 Oct", ts: "2026-10-02T10:00:00Z", authorId: "p-3", meta: { replyTo: s1.id } });
    const a = claim({ id: "a", value: "27 Oct", validFrom: s1.ts, authorId: "p-1",
      citations: [{ segmentId: s1.id, quote: "27 Oct", accepted: true, exact: true }] });
    const b = claim({ id: "b", value: "20 Oct", validFrom: s2.ts, authorId: "p-3",
      citations: [{ segmentId: s2.id, quote: "20 Oct", accepted: true, exact: true }] });
    const { claims, firings } = applySupersession([a, b], pack, segMap(s1, s2));
    expect(byId(claims, "a")).toMatchObject({ state: "superseded", supersededBy: "b",
      stateNote: "Superseded: a reply updated it on 2026-10-02" });
    expect(firings).toEqual([{ rule: 2, olderId: "a", newerId: "b" }]);
  });

  it("rule 3: two people disagree at equal authority with no link: both conflicting (time does not settle it)", () => {
    const a = claim({ id: "a", value: "Room 101", attribute: "location", entity: "lab-booking",
      sourceKinds: ["slack"], validFrom: "2026-10-01T10:00:00Z", authorId: "p-1" });
    const b = claim({ id: "b", value: "Room 204", attribute: "location", entity: "lab-booking",
      sourceKinds: ["whatsapp"], validFrom: "2026-10-09T10:00:00Z", authorId: "p-2" });
    const { claims, firings } = applySupersession([a, b], pack);
    for (const id of ["a", "b"]) {
      expect(byId(claims, id)).toMatchObject({
        state: "conflicting",
        supersededBy: null,
        stateNote: "Conflicting: two people disagree and no rule settles it. Ask a person.",
      });
    }
    expect(firings).toEqual([{ rule: 3, olderId: "a", newerId: "b" }]);
  });

  it("rule 4: a newer claim from a lower-authority source: both conflicting, newer marked possibly outdated owner", () => {
    const board = claim({ id: "board", value: "2026-10-20", sourceKinds: ["tasks_csv"], validFrom: "2026-10-01T10:00:00Z", authorId: "p-2" });
    const chat = claim({ id: "chat", value: "2026-10-27", sourceKinds: ["slack"], validFrom: "2026-10-05T10:00:00Z", authorId: "p-1" });
    const { claims, firings } = applySupersession([board, chat], pack);
    expect(byId(claims, "board").state).toBe("conflicting");
    expect(byId(claims, "chat").state).toBe("conflicting");
    expect(byId(claims, "chat").stateNote).toMatch(/^Possibly outdated owner/);
    expect(byId(claims, "chat").stateNote).toMatch(/the task board owns deadlines/);
    expect(byId(claims, "board").stateNote).toMatch(/^Conflicting:/);
    expect(firings).toEqual([{ rule: 4, olderId: "board", newerId: "chat" }]);
  });

  it("multi-valued attributes (reason, dependency, contact) never conflict", () => {
    const xs = (["reason", "dependency", "contact"] as const).flatMap((attribute) => [
      claim({ id: `${attribute}-1`, attribute, value: "one thing", authorId: "p-1", validFrom: "2026-10-01T10:00:00Z" }),
      claim({ id: `${attribute}-2`, attribute, value: "another thing", authorId: "p-2", sourceKinds: ["tasks_csv"], validFrom: "2026-10-02T10:00:00Z" }),
    ]);
    const { claims, firings } = applySupersession(xs, pack);
    expect(claims.every((c) => c.state === "active" && c.stateNote === null)).toBe(true);
    expect(firings).toEqual([]);
  });

  it("equal values never clash; dropped and rejected claims are left alone; re-running is idempotent", () => {
    const a = claim({ id: "a", value: "Room 101", attribute: "location", authorId: "p-1" });
    const b = claim({ id: "b", value: "room  101", attribute: "location", authorId: "p-2", validFrom: "2026-10-05T10:00:00Z" });
    const d = claim({ id: "d", value: "Room 999", attribute: "location", authorId: "p-3", state: "dropped" });
    const r = claim({ id: "r", value: "Room 555", attribute: "location", authorId: "p-4", review: "rejected" });
    const once = applySupersession([a, b, d, r], pack);
    expect(once.claims.map((c) => c.state)).toEqual(["active", "active", "dropped", "active"]);
    expect(once.firings).toEqual([]);
    const twice = applySupersession(once.claims, pack);
    expect(twice.claims).toEqual(once.claims);
  });

  it("superseded wins over a conflict with a claim that is itself superseded", () => {
    // Two people disagree in chat, then the task board settles it.
    const a = claim({ id: "a", value: "27 Oct", authorId: "p-1", validFrom: "2026-10-01T10:00:00Z" });
    const b = claim({ id: "b", value: "29 Oct", authorId: "p-2", sourceKinds: ["whatsapp"], validFrom: "2026-10-02T10:00:00Z" });
    const t = claim({ id: "t", value: "20 Oct", authorId: "p-5", sourceKinds: ["tasks_csv"], validFrom: "2026-10-03T10:00:00Z" });
    const { claims, firings } = applySupersession([a, b, t], pack);
    expect(claims.map((c) => [c.id, c.state, c.supersededBy])).toEqual([
      ["a", "superseded", "t"], ["b", "superseded", "t"], ["t", "active", null],
    ]);
    expect(firings.map((f) => f.rule)).toEqual([1, 1]);
  });
});

describe("corroboration", () => {
  it("two records from different authors agreeing become corroborated", () => {
    const a = claim({ id: "a", value: "Room 204", attribute: "location", authorId: "p-1" });
    const b = claim({ id: "b", value: "room 204", attribute: "location", authorId: "p-2" });
    const out = corroborate([a, b]);
    expect(out.map((c) => c.trust)).toEqual(["corroborated", "corroborated"]);
  });

  it("the same author repeating themselves in the same kind of source is not corroboration", () => {
    const a = claim({ id: "a", value: "Room 204", attribute: "location", authorId: "p-1" });
    const b = claim({ id: "b", value: "Room 204", attribute: "location", authorId: "p-1" });
    expect(corroborate([a, b]).map((c) => c.trust)).toEqual(["from_record", "from_record"]);
  });

  it("different source kinds corroborate even with the same author", () => {
    const a = claim({ id: "a", value: "Room 204", attribute: "location", authorId: "p-1", sourceKinds: ["slack"] });
    const b = claim({ id: "b", value: "Room 204", attribute: "location", authorId: "p-1", sourceKinds: ["github"] });
    expect(corroborate([a, b]).map((c) => c.trust)).toEqual(["corroborated", "corroborated"]);
  });

  it("leaver said stays leaver said until a record agrees, then corroborated", () => {
    const said = claim({ id: "said", value: "Room 204", attribute: "location", authorId: "p-1",
      trust: "leaver_said", sourceKinds: ["interview"], origin: "leaver_answer" });
    const said2 = claim({ id: "said2", value: "Room 204", attribute: "location", authorId: "p-9",
      trust: "leaver_said", sourceKinds: ["whatsapp"] });
    expect(corroborate([said, said2]).map((c) => c.trust)).toEqual(["leaver_said", "leaver_said"]);

    const record = claim({ id: "rec", value: "Room 204", attribute: "location", authorId: "p-1", sourceKinds: ["slack"] });
    expect(corroborate([said, record]).map((c) => c.trust)).toEqual(["corroborated", "corroborated"]);
  });

  it("inferred never corroborates inferred; claims the support check rejected never take part; non-active are skipped", () => {
    const i1 = claim({ id: "i1", value: "X", attribute: "location", authorId: "p-1", trust: "inferred" });
    const i2 = claim({ id: "i2", value: "X", attribute: "location", authorId: "p-2", trust: "inferred" });
    expect(corroborate([i1, i2]).map((c) => c.trust)).toEqual(["inferred", "inferred"]);

    const r1 = claim({ id: "r1", value: "X", attribute: "location", authorId: "p-1", supportCheck: "no" });
    const r2 = claim({ id: "r2", value: "X", attribute: "location", authorId: "p-2" });
    expect(corroborate([r1, r2]).map((c) => c.trust)).toEqual(["from_record", "from_record"]);

    const s1 = claim({ id: "s1", value: "X", attribute: "location", authorId: "p-1", state: "superseded" });
    expect(corroborate([s1, r2]).map((c) => c.trust)).toEqual(["from_record", "from_record"]);
  });
});

describe("importance and tier", () => {
  it("importance comes from the checklist weights of the entity's responsibility kind", () => {
    expect(importanceOf({ entity: "firmware-deploy", attribute: "procedure" }, pack)).toBe("blocking"); // rollback w5
    expect(importanceOf({ entity: "firmware-deploy", attribute: "location" }, pack)).toBe("important"); // access path w3
    expect(importanceOf({ entity: "firmware-deploy", attribute: "risk" }, pack)).toBe("normal");
    expect(importanceOf({ entity: "unknown-thing", attribute: "procedure" }, pack)).toBe("normal");
    // An explicit entity -> kind map wins over role templates.
    expect(importanceOf({ entity: "sponsor", attribute: "contact" }, pack, { sponsor: "external_relationship" })).toBe("blocking");
    expect(importanceOf({ entity: "sponsor", attribute: "status" }, pack, new Map([["sponsor", "external_relationship" as const]]))).toBe("normal");
  });

  it("tier C for sensitive, conflicting or blocking; A for corroborated normal unflagged; else B", () => {
    const base = { entity: "sponsor", attribute: "status" as const, value: "renewed", trust: "corroborated" as const };
    expect(tierOf(claim({ ...base, roleSet: ["president", "treasurer"] }), CLUB_RESTRICTED)).toBe("C");
    expect(tierOf(claim({ ...base, state: "conflicting" }), CLUB_RESTRICTED)).toBe("C");
    expect(tierOf(claim({ ...base, importance: "blocking" }), CLUB_RESTRICTED)).toBe("C");
    expect(tierOf(claim({ ...base }), CLUB_RESTRICTED)).toBe("A");
    expect(tierOf(claim({ ...base, supportCheck: "partly" }), CLUB_RESTRICTED)).toBe("B");
    expect(tierOf(claim({ ...base, importance: "important" }), CLUB_RESTRICTED)).toBe("B");
    expect(tierOf(claim({ ...base, trust: "from_record" }), CLUB_RESTRICTED)).toBe("B");

    const [c] = assignImportanceAndTier([claim({ entity: "firmware-deploy", attribute: "procedure", value: "x" })], pack);
    expect(c).toMatchObject({ importance: "blocking", tier: "C" });
  });

  it("applyRules runs supersession, then corroboration, then tiers", () => {
    const a = claim({ id: "a", entity: "sponsor", attribute: "status", value: "renewed", authorId: "p-1" });
    const b = claim({ id: "b", entity: "sponsor", attribute: "status", value: "Renewed", authorId: "p-2", sourceKinds: ["markdown"] });
    const { claims, firings } = applyRules([a, b], pack);
    expect(firings).toEqual([]);
    expect(claims.map((c) => [c.trust, c.tier])).toEqual([["corroborated", "A"], ["corroborated", "A"]]);
  });
});
