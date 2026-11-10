import { describe, expect, it } from "vitest";
import {
  ackRecord, checkReadback, expectedFromClaims, normaliseReadback, parseContact, parseDate,
} from "@/lib/relay/core/readback";
import type { ReadbackItem } from "@/lib/types";
import { AT, makeClaim } from "./fixtures";

describe("parseDate", () => {
  it.each([
    ["28 Nov 2026", "2026-11-28"],
    ["2026-11-28", "2026-11-28"],
    ["2026-11-28T09:30:00Z", "2026-11-28"],
    ["28/11/2026", "2026-11-28"],
    ["28-11-2026", "2026-11-28"],
    ["Nov 28", "2026-11-28"],
    ["November 28, 2026", "2026-11-28"],
    ["28th November", "2026-11-28"],
    ["Sat 28 Nov 2026", "2026-11-28"],
    ["  28 nov 2026 ", "2026-11-28"],
    ["1/2/2027", "2027-02-01"],
  ])("%s -> %s", (input, iso) => {
    expect(parseDate(input, 2026)).toBe(iso);
  });

  it("uses the snapshot year when the year is missing", () => {
    expect(parseDate("Nov 28", 2027)).toBe("2027-11-28");
    expect(parseDate("Nov 28")).toBeNull();
  });

  it("rejects impossible or unreadable dates", () => {
    expect(parseDate("30/02/2026", 2026)).toBeNull();
    expect(parseDate("Smarch 3", 2026)).toBeNull();
    expect(parseDate("", 2026)).toBeNull();
    expect(parseDate("next friday", 2026)).toBeNull();
  });
});

describe("text, command and contact parsers", () => {
  it("normalise via norm()", () => {
    expect(normaliseReadback("command", "  `make   FLASH` ")).toBe("make flash");
    expect(normaliseReadback("text", "Room **B-204**")).toBe("room b-204");
    expect(parseContact("Call [CONTACT:p-3] tomorrow")).toBe("[contact:p-3]");
    expect(parseContact("@Ravi  Kumar")).toBe("ravi kumar");
  });
});

const items: ReadbackItem[] = [
  { key: "competition_date", label: "Competition date", type: "date", expectedClaimId: "c-date" },
  { key: "deploy_command", label: "Deploy command", type: "command", expectedClaimId: "c-cmd" },
  { key: "sponsor_contact", label: "Sponsor contact", type: "contact", expectedClaimId: "c-contact" },
  { key: "budget_code", label: "Budget code", type: "text", expectedClaimId: "c-budget" },
];

describe("checkReadback", () => {
  const visible = [
    makeClaim({ id: "c-date", value: "28 Nov 2026" }),
    makeClaim({ id: "c-cmd", value: "make flash" }),
    makeClaim({ id: "c-contact", value: "[CONTACT:p-3]" }),
  ];
  const expected = expectedFromClaims(items, visible);

  it("derives expected values from visible claims (null when not visible)", () => {
    expect(expected).toEqual({
      competition_date: "28 Nov 2026",
      deploy_command: "make flash",
      sponsor_contact: "[CONTACT:p-3]",
      budget_code: null,
    });
  });

  it("gives match / mismatch / not_visible per item, comparing normalised values exactly", () => {
    const v = checkReadback(
      items,
      { competition_date: "2026-11-28", deploy_command: "Make Flash ", sponsor_contact: "[contact:p-4]", budget_code: "X" },
      expected,
      { year: 2026 },
    );
    expect(v.map((x) => x.verdict)).toEqual(["match", "match", "mismatch", "not_visible"]);
    expect(v[0]).toMatchObject({ normalised: "2026-11-28", expected: "2026-11-28" });
    expect(v[3].expected).toBeNull();
  });

  it("accepts every supported date format, taking the expected year for 'Nov 28'", () => {
    for (const typed of ["28 Nov 2026", "2026-11-28", "28/11/2026", "Nov 28"]) {
      const [d] = checkReadback(items.slice(0, 1), { competition_date: typed }, expected);
      expect(d.verdict).toBe("match");
    }
    const [wrong] = checkReadback(items.slice(0, 1), { competition_date: "29 Nov 2026" }, expected);
    expect(wrong.verdict).toBe("mismatch");
    const [empty] = checkReadback(items.slice(0, 1), {}, expected);
    expect(empty.verdict).toBe("mismatch");
  });
});

describe("ackRecord", () => {
  it("records role, time, hash and verdicts; allMatched only when every visible item matched", () => {
    const verdicts = checkReadback(items.slice(0, 2), { competition_date: "Nov 28", deploy_command: "make flash" }, {
      competition_date: "2026-11-28", deploy_command: "make flash",
    });
    const ack = ackRecord({ role: "tech_lead", snapshotHash: "ab".repeat(32), verdicts, at: AT });
    expect(ack).toMatchObject({ role: "tech_lead", at: AT, snapshotHash: "ab".repeat(32), allMatched: true });
    expect(ack.verdicts).toHaveLength(2);
    const bad = ackRecord({ role: "tech_lead", snapshotHash: "x", verdicts: [{ ...verdicts[0], verdict: "mismatch" }, verdicts[1]] });
    expect(bad.allMatched).toBe(false);
    const none = ackRecord({ role: "new_member", snapshotHash: "x", verdicts: [{ ...verdicts[0], verdict: "not_visible" }] });
    expect(none.allMatched).toBe(false);
  });
});
