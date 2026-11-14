// What consolidation means for the rules: one regression test per Round 2 false conflict
// (values from docs/EVALUATION.md of Round 2), and the planted conflicts and supersessions still fire.
import { describe, expect, it } from "vitest";
import { applySupersession, comparable } from "@/lib/attest/core/rules";
import { claim, pack } from "./fixtures-verify/build";

const states = (cs: { state: string }[]) => cs.map((c) => c.state);

describe("Round 2 false conflicts", () => {
  it("competition / location: a venue option and a place for something else", () => {
    // Round 2: "Hall B" vs "Lab 3" conflicted. Now the option is folded into "Options: ..." and
    // the other place carries its own event.
    const option = claim({ entity: "competition", attribute: "decision", value: "Options: Hall B or Main Auditorium", authorId: "p-1" });
    const decided = claim({ entity: "competition", attribute: "decision", value: "book the hall this week", authorId: "p-1", validFrom: "2026-10-03T10:00:00.000Z" });
    expect(comparable(option, decided)).toBe(false);
    const venue = claim({ entity: "competition", attribute: "location", value: "Hall B", authorId: "p-1" });
    const trial = claim({ entity: "competition", attribute: "location", value: "Lab 3 (trial run)", authorId: "p-2", validFrom: "2026-10-03T10:00:00.000Z" });
    const { claims, firings } = applySupersession([venue, trial], pack);
    expect(states(claims)).toEqual(["active", "active"]);
    expect(firings).toEqual([]);
  });

  it("domain-dns / location: a registrar and a repo path are two kinds of location", () => {
    const a = claim({ entity: "domain-dns", attribute: "location", value: "NameHarbor (online)", authorId: "p-1" });
    const b = claim({ entity: "domain-dns", attribute: "location", value: "dns/", authorId: "p-2", sourceKinds: ["github"], validFrom: "2026-10-03T10:00:00.000Z" });
    expect(states(applySupersession([a, b], pack).claims)).toEqual(["active", "active"]);
  });

  it("recruitment / location: a place and a file are two kinds of location", () => {
    const a = claim({ entity: "recruitment", attribute: "location", value: "Near the canteen", authorId: "p-1" });
    const b = claim({ entity: "recruitment", attribute: "location", value: "README", authorId: "p-2", sourceKinds: ["github"], validFrom: "2026-10-03T10:00:00.000Z" });
    expect(states(applySupersession([a, b], pack).claims)).toEqual(["active", "active"]);
  });

  it("recruitment / deadline: the dates of two different events", () => {
    const a = claim({ entity: "recruitment", attribute: "deadline", value: "2026-08-08 (induction)", authorId: "p-1", validFrom: "2026-07-20T10:00:00.000Z" });
    const b = claim({ entity: "recruitment", attribute: "deadline", value: "2026-08-02 (stall)", authorId: "p-2", validFrom: "2026-07-21T10:00:00.000Z" });
    const { claims, firings } = applySupersession([a, b], pack);
    expect(states(claims)).toEqual(["active", "active"]);
    expect(firings).toEqual([]);
  });

  it("a date that names its event is not compared with the entity's own date", () => {
    const own = claim({ value: "2026-12-19", authorId: "p-1" });
    const side = claim({ value: "2026-12-12 (kit inspection)", authorId: "p-2", validFrom: "2026-10-03T10:00:00.000Z" });
    expect(comparable(own, side)).toBe(false);
  });
});

describe("what must still fire", () => {
  it("a planted conflict: two people, two dates, one event", () => {
    const a = claim({ entity: "lab-booking", value: "2026-12-01", authorId: "p-1", sourceKinds: ["whatsapp"], validFrom: "2026-10-21T10:00:00.000Z" });
    const b = claim({ entity: "lab-booking", value: "2026-12-05", authorId: "p-2", sourceKinds: ["whatsapp"], validFrom: "2026-10-29T10:00:00.000Z" });
    const { claims, firings } = applySupersession([a, b], pack);
    expect(states(claims)).toEqual(["conflicting", "conflicting"]);
    expect(firings).toEqual([{ rule: 3, olderId: a.id, newerId: b.id }]);
  });

  it("two dates for the same named event still conflict or supersede", () => {
    const a = claim({ value: "2026-11-20 (check-in)", authorId: "p-1", validFrom: "2026-10-21T10:00:00.000Z" });
    const b = claim({ value: "2026-11-27 (next check-in)", authorId: "p-1", validFrom: "2026-10-29T10:00:00.000Z" });
    const { claims, firings } = applySupersession([a, b], pack);
    expect(states(claims)).toEqual(["superseded", "active"]);
    expect(firings).toEqual([{ rule: 2, olderId: a.id, newerId: b.id }]);
  });

  it("rule 1: the board still supersedes a chat date", () => {
    const chat = claim({ value: "2026-12-12", sourceKinds: ["whatsapp"], authorId: "p-1", validFrom: "2026-09-08T10:00:00.000Z" });
    const board = claim({ value: "2026-12-19", sourceKinds: ["tasks_csv"], authorId: "p-2", origin: "structured", validFrom: "2026-10-28T10:00:00.000Z" });
    expect(states(applySupersession([chat, board], pack).claims)).toEqual(["superseded", "active"]);
  });

  it("two places of the same kind still conflict", () => {
    const a = claim({ entity: "lab-booking", attribute: "location", value: "Room 101", authorId: "p-1" });
    const b = claim({ entity: "lab-booking", attribute: "location", value: "Room 204", authorId: "p-2", validFrom: "2026-10-03T10:00:00.000Z" });
    expect(states(applySupersession([a, b], pack).claims)).toEqual(["conflicting", "conflicting"]);
  });
});
