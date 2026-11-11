// A model deadline that is only the day its source was written (the header time read as an event
// date) is dropped by the verifier and reported; dates the text states are kept.
import { describe, expect, it } from "vitest";
import { datesInText, isWrittenDateDeadline, writtenDate } from "@/lib/attest/dates";
import { verifyDrafts } from "@/lib/attest/core/verify";
import { draft, pack, seg, segMap } from "./fixtures-verify/build";

const TS = "2026-03-14T09:30:00.000Z";

describe("datesInText", () => {
  it("finds ISO, day-month, month-day and numeric dates", () => {
    const ref = "2026-03-01T00:00:00.000Z";
    expect([...datesInText("due 2026-04-02", ref)]).toEqual(["2026-04-02"]);
    expect([...datesInText("moved to Sat 18 April, then 20th of May 2026", ref)]).toEqual(["2026-04-18", "2026-05-20"]);
    expect([...datesInText("on April 3, 2026 at noon", ref)]).toEqual(["2026-04-03"]);
    expect([...datesInText("form closes 14/03/26", ref)]).toEqual(["2026-03-14"]);
    expect(datesInText("no dates here, just v2.3.1 and 8 pm", ref).size).toBe(0);
  });
});

describe("isWrittenDateDeadline", () => {
  it("true when the value is the writing day and the text states no date", () => {
    expect(writtenDate(TS)).toBe("2026-03-14");
    expect(isWrittenDateDeadline("2026-03-14", [{ ts: TS, text: "site: show the event date on the homepage" }])).toBe(true);
    expect(isWrittenDateDeadline("14 March 2026", [{ ts: TS, text: "site: show the event date on the homepage" }])).toBe(true);
  });

  it("false when the text states that date, or dates relative to the writing time", () => {
    expect(isWrittenDateDeadline("2026-03-14", [{ ts: TS, text: "The fair is on 14 March." }])).toBe(false);
    expect(isWrittenDateDeadline("2026-03-14", [{ ts: TS, text: "x", quote: "closes 14/03/2026" }])).toBe(false);
    expect(isWrittenDateDeadline("2026-03-14", [{ ts: TS, text: "Forms close today at 5." }])).toBe(false);
  });

  it("false for another date, a cadence, or a source written on another day", () => {
    expect(isWrittenDateDeadline("2026-03-21", [{ ts: TS, text: "show the event date" }])).toBe(false);
    expect(isWrittenDateDeadline("every Saturday", [{ ts: TS, text: "show the event date" }])).toBe(false);
    expect(
      isWrittenDateDeadline("2026-03-14", [
        { ts: TS, text: "show the event date" },
        { ts: "2026-03-01T09:00:00.000Z", text: "the event is on the 14th" },
      ]),
    ).toBe(false);
    expect(isWrittenDateDeadline("2026-03-14", [])).toBe(false);
  });
});

describe("verifyDrafts: written-date deadlines", () => {
  it("drops an extracted deadline that is only the commit's own date, with a reason", () => {
    const s = seg({ kind: "commit", sourceKind: "github", ts: TS, text: "site: show the event date on the homepage" });
    const { claims, dropped } = verifyDrafts(
      [draft({ entity: "competition", attribute: "deadline", value: "2026-03-14", citations: [{ segment_id: s.id, quote: "show the event date on the homepage" }] })],
      segMap(s), pack, "ws",
    );
    expect(claims).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toMatch(/date the cited text was written/);
  });

  it("keeps a deadline the text states, and structured rows whose date is a field", () => {
    const a = seg({ ts: TS, text: "Regionals are on 14 March, venue TBC." });
    const b = seg({ kind: "task", sourceKind: "tasks_csv", ts: TS, text: "Book the lab" });
    const { claims, dropped } = verifyDrafts(
      [
        draft({ entity: "competition", attribute: "deadline", value: "2026-03-14", citations: [{ segment_id: a.id, quote: "Regionals are on 14 March" }] }),
        draft({ entity: "lab-booking", attribute: "deadline", value: "2026-03-14", origin: "structured", citations: [{ segment_id: b.id, quote: null }] }),
      ],
      segMap(a, b), pack, "ws",
    );
    expect(dropped).toHaveLength(0);
    expect(claims.map((c) => c.entity).sort()).toEqual(["competition", "lab-booking"]);
  });
});
