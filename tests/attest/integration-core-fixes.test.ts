// Tests for the integration-time fixes to the Attest core: same-kind comparison in the
// supersession rules, the next-occurrence claim for recurring events, ISO date normalisation.
import { describe, expect, it } from "vitest";
import { applySupersession, comparable, isDateValue } from "@/lib/attest/core/rules";
import { eventClaims, labelSpan } from "@/lib/attest/core/structured";
import { toIsoDate } from "@/lib/attest/dates";
import type { Segment } from "@/lib/types";
import { claim, pack, seg, segMap } from "./fixtures-verify/build";

const byId = <T extends { id: string }>(xs: T[], id: string) => xs.find((x) => x.id === id)!;

describe("only claims about the same kind of fact are compared", () => {
  it("a cadence never conflicts with a due date", () => {
    const cadence = claim({ id: "c", entity: "lab-booking", value: "Once every term", sourceKinds: ["whatsapp"], authorId: "p-1", validFrom: "2026-10-01T10:00:00Z" });
    const due = claim({ id: "d", entity: "lab-booking", value: "2026-12-01", sourceKinds: ["whatsapp"], authorId: "p-2", validFrom: "2026-10-21T10:00:00Z" });
    const { claims, firings } = applySupersession([cadence, due], pack);
    expect(firings).toEqual([]);
    expect(claims.map((x) => x.state)).toEqual(["active", "active"]);
    expect(isDateValue("Once every term")).toBe(false);
    expect(isDateValue("yearly, next 2026-12-02")).toBe(false);
    expect(isDateValue("2026-12-01")).toBe(true);
    expect(isDateValue("27 Oct")).toBe(true);
  });

  it("two dates from different people still conflict (planted rule 3)", () => {
    const a = claim({ id: "a", entity: "lab-booking", value: "2026-12-01", sourceKinds: ["whatsapp"], authorId: "p-1", validFrom: "2026-10-21T10:00:00Z" });
    const b = claim({ id: "b", entity: "lab-booking", value: "2026-12-05", sourceKinds: ["whatsapp"], authorId: "p-2", validFrom: "2026-10-29T10:00:00Z" });
    const { claims, firings } = applySupersession([a, b], pack);
    expect(firings).toEqual([{ rule: 3, olderId: "a", newerId: "b" }]);
    expect(byId(claims, "a").state).toBe("conflicting");
  });

  it("a verify step from the repo does not supersede the chat's deploy steps (no restatement)", () => {
    const steps = claim({ id: "s", entity: "firmware-deploy", attribute: "procedure", value: "./scripts/flash.sh --ota 192.168.4.1",
      sourceKinds: ["slack"], authorId: "p-1", validFrom: "2026-09-01T10:00:00Z" });
    const check = claim({ id: "v", entity: "firmware-deploy", attribute: "procedure", value: "check the boot banner on the serial monitor",
      sourceKinds: ["github"], authorId: null, validFrom: "2026-10-01T10:00:00Z" });
    const { claims, firings } = applySupersession([steps, check], pack);
    expect(firings).toEqual([]);
    expect(claims.every((x) => x.state === "active")).toBe(true);
  });

  it("the same person's reply restating the procedure supersedes it (planted rule 2)", () => {
    const s1 = seg({ text: "Plug the lab laptop in over USB and upload from the Arduino IDE", ts: "2026-08-01T10:00:00Z", authorId: "p-1" });
    const s2 = seg({ text: "Update: run ./scripts/flash.sh --ota 192.168.4.1", ts: "2026-08-20T10:00:00Z", authorId: "p-1", meta: { replyTo: s1.id } });
    const usb = claim({ id: "usb", entity: "firmware-deploy", attribute: "procedure", value: "USB upload from the Arduino IDE",
      sourceKinds: ["slack"], authorId: "p-1", validFrom: s1.ts, citations: [{ segmentId: s1.id, quote: "over USB", accepted: true, exact: true }] });
    const ota = claim({ id: "ota", entity: "firmware-deploy", attribute: "procedure", value: "./scripts/flash.sh --ota 192.168.4.1",
      sourceKinds: ["slack"], authorId: "p-1", validFrom: s2.ts, citations: [{ segmentId: s2.id, quote: "flash.sh --ota", accepted: true, exact: true }] });
    const { claims, firings } = applySupersession([usb, ota], pack, segMap(s1, s2));
    expect(firings).toEqual([{ rule: 2, olderId: "usb", newerId: "ota" }]);
    expect(byId(claims, "usb")).toMatchObject({ state: "superseded", supersededBy: "ota" });
  });

  it("values where one contains the other agree; risks and access are never compared; 'other' is not one entity", () => {
    const a = claim({ id: "a", attribute: "owner", value: "Priya Nair", sourceKinds: ["tasks_csv"], authorId: "p-1" });
    const b = claim({ id: "b", attribute: "owner", value: "Priya Nair (only club member in touch with Vertex)", sourceKinds: ["whatsapp"], authorId: "p-2" });
    expect(comparable(a, b)).toBe(false);
    const r1 = claim({ id: "r1", attribute: "risk", value: "late fee doubles", authorId: "p-1" });
    const r2 = claim({ id: "r2", attribute: "risk", value: "form goes offline", authorId: "p-2" });
    expect(comparable(r1, r2)).toBe(false);
    const o1 = claim({ id: "o1", entity: "other", value: "2026-11-01", sourceKinds: ["slack"], authorId: "p-1" });
    const o2 = claim({ id: "o2", entity: "other", value: "2026-11-09", sourceKinds: ["whatsapp"], authorId: "p-2" });
    expect(applySupersession([o1, o2], pack).firings).toEqual([]);
  });
});

describe("items that are not two versions of one fact", () => {
  it("two board cards on the same entity never conflict; one segment listing options does not contradict itself", () => {
    const t1 = claim({ id: "t1", entity: "recruitment", attribute: "owner", value: "Tanvi Deshpande", origin: "structured", sourceKinds: ["tasks_csv"], authorId: "p-1", validFrom: "2026-08-08T10:00:00Z" });
    const t2 = claim({ id: "t2", entity: "recruitment", attribute: "owner", value: "Dev Malhotra", origin: "structured", sourceKinds: ["tasks_csv"], authorId: "p-2", validFrom: "2026-08-22T10:00:00Z" });
    expect(applySupersession([t1, t2], pack).firings).toEqual([]);
    const s = seg({ text: "We chose the ESP32; rejected the Pico W and the Mega + Wi-Fi shield.", ts: "2026-07-03T10:00:00Z", authorId: "p-1" });
    const cite = [{ segmentId: s.id, quote: "We chose the ESP32", accepted: true, exact: true }];
    const d1 = claim({ id: "d1", entity: "controller-board", attribute: "decision", value: "use ESP32", authorId: "p-1", validFrom: s.ts, citations: cite });
    const d2 = claim({ id: "d2", entity: "controller-board", attribute: "decision", value: "rejected Raspberry Pi Pico W", authorId: "p-1", validFrom: s.ts, citations: cite });
    const out = applySupersession([d1, d2], pack, segMap(s));
    expect(out.firings).toEqual([]);
    expect(out.claims.every((c) => c.state === "active")).toBe(true);
  });
});

describe("recurring calendar events", () => {
  const ev: Segment = {
    id: "seg_dns", sourceId: "src_cal", sourceKind: "ics", kind: "event", ts: "2026-06-01T00:00:00Z", authorId: null,
    thread: "RoboClub", position: 0, textHash: "x", roleSet: ["president", "tech_lead", "new_member", "treasurer", "leaver"], version: 1,
    text: "Event: Renew the domain (yearly) | when: 2 Dec 2026 | where: not set | repeats: every year on 2 December",
    meta: { summary: "Renew the domain (yearly)", start: "2026-12-02", rrule: "FREQ=YEARLY", occurrences: ["2026-12-02", "2027-12-02"] },
  };
  const p = { entities: [{ key: "domain-dns", label: "Domain and DNS renewal", aliases: ["domain"] }] };

  it("emits the cadence and a separate plain ISO next-occurrence deadline, both quoting the event text", () => {
    const out = eventClaims(ev, p, { now: "2026-11-05T00:00:00Z" });
    const deadlines = out.filter((c) => c.attribute === "deadline");
    expect(deadlines.map((c) => c.value)).toEqual([expect.stringContaining("next 2026-12-02"), "2026-12-02"]);
    for (const d of deadlines) {
      expect(d.entity).toBe("domain-dns");
      expect(d.citations[0].quote).toBeTruthy();
      expect(ev.text.includes(d.citations[0].quote!)).toBe(true);
    }
    expect(labelSpan(ev.text, ["repeats"])).toBe("repeats: every year on 2 December");
  });
});

describe("deadline values to ISO dates", () => {
  it("normalises one date and leaves cadences alone", () => {
    expect(toIsoDate("2026-12-19")).toBe("2026-12-19");
    expect(toIsoDate("19 Dec 2026")).toBe("2026-12-19");
    expect(toIsoDate("December 19, 2026")).toBe("2026-12-19");
    expect(toIsoDate("Sat 19th December")).toBe(null); // no year and no reference
    expect(toIsoDate("19th December", "2026-10-28T10:00:00Z")).toBe("2026-12-19");
    expect(toIsoDate("5 Jan", "2026-11-20T10:00:00Z")).toBe("2027-01-05");
    expect(toIsoDate("01/12/2026")).toBe("2026-12-01");
    expect(toIsoDate("every Saturday")).toBe(null);
    expect(toIsoDate("Once per term")).toBe(null);
    expect(toIsoDate("31 Feb 2026")).toBe(null);
  });
});
