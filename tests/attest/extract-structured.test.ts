import { describe, expect, it } from "vitest";
import { describeRrule, findQuote, structuredClaims } from "@/lib/attest/core/structured";
import { norm } from "@/lib/text/norm";
import type { Segment } from "@/lib/types";
import { pack, seg } from "./fixtures/segments";

function task(text: string, meta: Record<string, unknown>): Segment {
  return seg({ kind: "task", sourceKind: "tasks_csv", sourceId: "src_tasks", thread: "Task board", text, meta });
}
function event(text: string, meta: Record<string, unknown>): Segment {
  return seg({ kind: "event", sourceKind: "ics", sourceId: "src_ics", thread: "club.ics", text, meta });
}

function expectExactQuotes(segs: Segment[], drafts: ReturnType<typeof structuredClaims>) {
  const byId = new Map(segs.map((s) => [s.id, s]));
  for (const d of drafts) {
    for (const c of d.citations) {
      const s = byId.get(c.segmentId)!;
      expect(c.quote).not.toBeNull();
      expect(s.text.includes(c.quote!)).toBe(true);
      expect(norm(s.text).includes(norm(c.quote!))).toBe(true);
    }
  }
}

describe("structured claims: task board", () => {
  const t = task(
    "T-12 Flash firmware before regionals\nstatus: In progress | owner: Priya Nair | due: 2026-11-20 | labels: firmware, robot\nTest on the spare board first.",
    { id: "T-12", title: "Flash firmware before regionals", status: "In progress", owner: "Priya Nair",
      due: "2026-11-20", labels: "firmware, robot" },
  );

  it("emits owner, status and deadline with exact-substring quotes", () => {
    const drafts = structuredClaims([t], pack);
    expect(drafts.map((d) => d.attribute)).toEqual(["owner", "status", "deadline"]);
    const q = Object.fromEntries(drafts.map((d) => [d.attribute, d.citations[0].quote]));
    expect(q).toEqual({ owner: "owner: Priya Nair", status: "status: In progress", deadline: "due: 2026-11-20" });
    expectExactQuotes([t], drafts);
  });

  it("matches the entity from aliases in title and labels; tags origin and batch", () => {
    const drafts = structuredClaims([t], pack);
    for (const d of drafts) {
      expect(d.entity).toBe("firmware-deploy");
      expect(d.entityRaw).toBeNull();
      expect(d.origin).toBe("structured");
      expect(d.batchId).toBe(`struct_${t.id}`);
      expect(d.batchSegmentIds).toEqual([t.id]);
    }
    expect(drafts.find((d) => d.attribute === "deadline")!.value).toBe("2026-11-20");
    expect(drafts.find((d) => d.attribute === "owner")!.statement).toBe('Priya Nair owns "Flash firmware before regionals".');
  });

  it("matches entity keys given as labels, and falls back to other", () => {
    const lab = task("T-3 Term booking\nStatus: Done", { title: "Term booking", status: "Done", labels: ["lab-booking"] });
    const misc = task("T-9 Order pizza\nstatus: Open", { title: "Order pizza", status: "Open" });
    const [a] = structuredClaims([lab], pack);
    const [b] = structuredClaims([misc], pack);
    expect(a.entity).toBe("lab-booking");
    expect(b).toMatchObject({ entity: "other", entityRaw: "Order pizza" });
  });

  it("quotes the text's own casing and spacing, falls back to the bare value, else null", () => {
    const s = task("Book lab — Status:in progress. Owner Arjun. Due 01/12/2026", {
      title: "Book lab", status: "In progress", owner: "Arjun", due: "01/12/2026",
    });
    const drafts = structuredClaims([s], pack);
    const q = Object.fromEntries(drafts.map((d) => [d.attribute, d.citations[0].quote]));
    expect(q.status).toBe("Status:in progress");
    expect(q.owner).toBe("Arjun");
    expect(q.deadline).toBe("01/12/2026");
    expectExactQuotes([s], drafts);

    const missing = task("Book lab", { title: "Book lab", status: "Blocked" });
    expect(structuredClaims([missing], pack)[0].citations[0].quote).toBeNull();
  });

  it("ignores non-structured kinds and empty fields", () => {
    const msg = seg({ text: "status: In progress", meta: { status: "In progress" } });
    const empty = task("T-1 Something", { title: "Something", status: "", owner: "  " });
    expect(structuredClaims([msg, empty], pack)).toEqual([]);
  });
});

describe("structured claims: calendar", () => {
  it("one-off event gives deadline and location", () => {
    const e = event("Regional robotics competition\nwhen: 2026-12-05T09:00:00\nwhere: COEP Ground, Pune", {
      summary: "Regional robotics competition", start: "2026-12-05T09:00:00", location: "COEP Ground, Pune",
    });
    const drafts = structuredClaims([e], pack);
    expect(drafts.map((d) => [d.attribute, d.value, d.citations[0].quote])).toEqual([
      ["deadline", "2026-12-05", "when: 2026-12-05T09:00:00"],
      ["location", "COEP Ground, Pune", "where: COEP Ground, Pune"],
    ]);
    expect(drafts.every((d) => d.entity === "competition")).toBe(true);
    expectExactQuotes([e], drafts);
  });

  it("recurring event states the cadence and quotes the RRULE text", () => {
    const e = event(
      "Book the workshop lab\nstart: 2026-08-01T10:00:00\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1\nlocation: Lab office",
      {
        summary: "Book the workshop lab", start: "2026-08-01T10:00:00", rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        occurrences: ["2026-12-01T10:00:00", "2026-11-01T10:00:00", "2027-01-01T10:00:00"], location: "Lab office",
      },
    );
    const drafts = structuredClaims([e], pack);
    const deadline = drafts.find((d) => d.attribute === "deadline")!;
    expect(drafts.filter((d) => d.attribute === "deadline")).toHaveLength(1);
    expect(deadline.citations[0].quote).toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=1");
    expect(deadline.value).toBe("monthly on day 1, next 2026-11-01");
    expect(deadline.statement).toBe('"Book the workshop lab" repeats monthly on day 1; the next date is 2026-11-01.');
    expect(deadline.entity).toBe("lab-booking");
    expectExactQuotes([e], drafts);

    const later = structuredClaims([e], pack, { now: "2026-11-15T00:00:00Z" }).find((d) => d.attribute === "deadline")!;
    expect(later.value).toBe("monthly on day 1, next 2026-12-01");
  });

  it("describes common RRULEs in plain words", () => {
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO")).toBe("weekly on Monday");
    expect(describeRrule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH")).toBe("every 2 weeks on Tuesday, Thursday");
    expect(describeRrule("FREQ=MONTHLY;BYDAY=1FR")).toBe("monthly on 1st Friday");
    expect(describeRrule("FREQ=YEARLY")).toBe("yearly");
  });
});

describe("findQuote", () => {
  it("returns an exact slice of the text", () => {
    const text = "Owner:   Priya\nNair | STATUS = Done";
    expect(findQuote(text, ["owner"], ["Priya Nair"])).toBe("Owner:   Priya\nNair");
    expect(findQuote(text, ["status"], ["done"])).toBe("STATUS = Done");
    expect(findQuote(text, ["status"], ["Don"])).toBeNull(); // no partial-word match
  });
});
