import { describe, expect, it } from "vitest";
import { computeFootprint, isoWeek, type FootprintEntity } from "@/lib/tether/footprint";
import type { Person, Segment } from "@/lib/types";
import { ingestFixtures } from "./helpers";

const ENTITIES: FootprintEntity[] = [
  { key: "firmware-deploy", label: "Firmware deploy to the robot", aliases: ["deploy", "flash", "firmware"] },
  { key: "dns", label: "Club domain and DNS", aliases: ["dns", "domain"] },
  { key: "lab-booking", label: "Workshop lab booking", aliases: ["lab booking", "book the lab"] },
  { key: "pcb-vendor", label: "PCB vendor", aliases: ["pcb", "vendor"] },
];
const T = { repeatMin: 3, distinctWeeksMin: 2, ownershipShare: 0.8, windowMonths: 6 };

describe("footprint on the fixtures", () => {
  const out = ingestFixtures();
  const segments = out.sources.flatMap((s) => s.result.segments);
  const leaverIds = out.people.filter((p) => p.displayName === "Priya Nair").map((p) => p.id);
  const fp = computeFootprint(segments, out.people, leaverIds, T, ENTITIES, { now: "2026-11-11T00:00:00+05:30" });
  const find = (entityKey: string, rule: string) => fp.find((c) => c.entityKey === entityKey && c.rule === rule);

  it("(a) repeated action over distinct weeks", () => {
    const c = find("firmware-deploy", "repeat");
    expect(c).toBeDefined();
    expect(c!.evidenceSegmentIds.length).toBeGreaterThanOrEqual(3);
    expect(c!.detail).toMatch(/distinct weeks/);
  });
  it("(b) ownership of a path prefix and of the conversation", () => {
    const own = fp.filter((c) => c.rule === "ownership" && c.entityKey === "firmware-deploy");
    expect(own.length).toBe(1);
    expect(own[0].detail).toMatch(/3 of 3 commits touching firmware\//);
    expect(own[0].detail).toMatch(/messages about/);
    expect(fp.some((c) => c.entityKey === "path:.github/workflows/")).toBe(false); // 1 commit is not ownership
  });
  it("(c) sole contact: an external person who only replies to the leaver", () => {
    const c = find("pcb-vendor", "sole_contact");
    expect(c?.detail).toMatch(/Kiran \(PCB vendor\) only talks with the leaver/);
    expect(fp.some((x) => x.rule === "sole_contact" && /Rahul/.test(x.detail))).toBe(false);
  });
  it("(d) schedules: recurring event, cron workflow, yearly renewal", () => {
    const sched = fp.filter((c) => c.rule === "schedule");
    expect(sched.some((c) => c.entityKey === "firmware-deploy" && /recurring calendar event "Firmware deploy window"/.test(c.detail))).toBe(true);
    expect(sched.some((c) => /cron 0 18 \* \* 1/.test(c.detail))).toBe(true);
    expect(sched.some((c) => c.entityKey === "dns" && /renewal/.test(c.detail))).toBe(true);
  });
  it("(e) credential names, never values", () => {
    const cred = fp.filter((c) => c.rule === "credential");
    expect(cred.find((c) => c.entityKey === "dns")?.detail).toMatch(/DNS_API_TOKEN/);
    expect(cred.find((c) => c.entityKey === "firmware-deploy")?.detail).toMatch(/DEPLOY_SSH_KEY/);
  });
  it("every evidence id exists", () => {
    const ids = new Set(segments.map((s) => s.id));
    for (const c of fp) for (const id of c.evidenceSegmentIds) expect(ids.has(id)).toBe(true);
  });
});

function seg(id: string, over: Partial<Segment>): Segment {
  return {
    id, sourceId: "s", sourceKind: "slack", kind: "message", ts: "2026-09-01T10:00:00+05:30", authorId: "p-1",
    thread: "#general", position: 0, text: "", textHash: "", roleSet: ["president"], version: 1, meta: {}, ...over,
  };
}
const people: Person[] = [
  { id: "p-1", displayName: "Priya Nair", emailHmac: null, aliases: [] },
  { id: "p-2", displayName: "Rahul Desai", emailHmac: null, aliases: [] },
];

describe("footprint thresholds (negative cases)", () => {
  it("3 mentions in one week is not a repeat; someone else's mentions do not count", () => {
    const segs = [
      seg("a", { text: "deploy now", ts: "2026-09-01T10:00:00+05:30" }),
      seg("b", { text: "deploy again", ts: "2026-09-02T10:00:00+05:30" }),
      seg("c", { text: "deploy third", ts: "2026-09-03T10:00:00+05:30" }),
      seg("d", { text: "deploy by Rahul", ts: "2026-09-20T10:00:00+05:30", authorId: "p-2" }),
    ];
    const fp = computeFootprint(segs, people, "p-1", T, ENTITIES);
    expect(fp.find((c) => c.rule === "repeat")).toBeUndefined();
    // 3 of 4 messages = 75% < 80%: no message ownership either
    expect(fp.find((c) => c.rule === "ownership")).toBeUndefined();
  });

  it("a contact token mentioned only by the leaver is a sole contact; one mentioned by others is not", () => {
    const segs = [
      seg("a", { text: "call the DNS registrar at [CONTACT:c-1]" }),
      seg("b", { text: "the vendor is [CONTACT:c-2]" }),
      seg("c", { text: "I also called [CONTACT:c-2]", authorId: "p-2" }),
    ];
    const fp = computeFootprint(segs, people, "p-1", T, ENTITIES).filter((c) => c.rule === "sole_contact");
    expect(fp).toHaveLength(1);
    expect(fp[0].entityKey).toBe("dns");
    expect(fp[0].detail).toMatch(/c-1/);
  });

  it("credentials owned by someone else are not the leaver's", () => {
    const segs = [seg("a", { text: "rotate DNS_API_TOKEN", authorId: "p-2" })];
    expect(computeFootprint(segs, people, "p-1", T, ENTITIES)).toEqual([]);
  });

  it("iso weeks", () => {
    expect(isoWeek("2026-08-12T21:14:00+05:30")).toBe("2026-W33");
    expect(isoWeek("2027-01-01T00:30:00+05:30")).toBe("2026-W53");
  });
});
