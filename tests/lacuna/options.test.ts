// Ranked options (recovery rung 3). T-U-20 and T-U-21 of docs/round3/specs/01_recovery.md.
import { describe, expect, it } from "vitest";
import type { Claim } from "@/lib/types";
import { checksFor } from "@/lib/lacuna/core/checks";
import {
  buildOptionsPrompt, conflictOptions, evaluateOptions, patternOptions, rankOptions, weakOptions, OptionsOutputSchema,
} from "@/lib/lacuna/core/options";
import { ALL_ROLES, claim, resp } from "./fixtures";

const NOW = "2026-11-11T12:00:00+05:30";
const LAB = resp({ id: "r4", key: "R03", title: "Book the workshop lab each term", kind: "recurring_obligation", entities: ["lab-booking"] });
const NEXT_DUE = { ...checksFor(LAB).find((c) => c.key === "next_due")!, needsDate: true };
const FINANCE = ["president", "treasurer", "leaver"];
const authority = () => 3;

function withCitation(c: Claim, quote: string, over: Partial<Claim> = {}): Claim {
  return { ...c, citations: [{ segmentId: `seg_${c.id}`, quote, accepted: true, exact: true }], ...over };
}

describe("T-U-20: candidates and ranking", () => {
  const kabir = withCitation(claim({ id: "k", entity: "lab-booking", attribute: "deadline", value: "2026-12-01", state: "conflicting" }), "by 1 Dec", { authorId: "p-5", validFrom: "2026-10-21T10:00:00Z" });
  const sneha = withCitation(claim({ id: "s", entity: "lab-booking", attribute: "deadline", value: "2026-12-05", state: "conflicting" }), "by 5 Dec", { authorId: "p-6", validFrom: "2026-10-29T10:00:00Z" });
  const active = claim({ id: "a", entity: "lab-booking", attribute: "deadline", value: "2026-12-09" });
  const elsewhere = claim({ id: "e", entity: "other", attribute: "deadline", value: "2026-12-10", state: "conflicting" });

  it("conflict options come from conflicting claims on the gap only", () => {
    const got = conflictOptions(LAB, NEXT_DUE, [kabir, sneha, active, elsewhere]);
    expect(got.map((o) => o.value)).toEqual(["2026-12-01", "2026-12-05"]);
    expect(got[0].evidence[0]).toMatchObject({ claimId: "k", segmentId: "seg_k", quote: "by 1 Dec", authorId: "p-5" });
  });

  it("weak options come from active Second-hand and Inferred claims that satisfy the check", () => {
    const heard = claim({ id: "h", entity: "lab-booking", attribute: "deadline", value: "I think it is 1 Dec", trust: "second_hand" });
    const cadence = claim({ id: "c", entity: "lab-booking", attribute: "deadline", value: "Happened 3 times", trust: "inferred" }); // no date
    const record = claim({ id: "r", entity: "lab-booking", attribute: "deadline", value: "2026-12-09", trust: "from_record" });
    expect(weakOptions(LAB, NEXT_DUE, [heard, cadence, record], NOW).map((o) => o.evidence[0].claimId)).toEqual(["h"]);
  });

  it("a pattern option needs a check that asks for a date and a cadence with an implied date", () => {
    const traceClaim = claim({ id: "t", entity: "lab-booking", attribute: "deadline", value: "Happened 3 times", trust: "inferred" });
    const patterns = [{ entityKey: "lab-booking", impliedNext: "2026-12-14", claim: traceClaim }, { entityKey: "lab-booking", claim: traceClaim }];
    expect(patternOptions(LAB, NEXT_DUE, patterns).map((o) => o.value)).toEqual(["2026-12-14"]);
    expect(patternOptions(LAB, checksFor(LAB).find((c) => c.key === "how_to")!, patterns)).toEqual([]);
  });

  it("equal values merge and pool their evidence; ranking follows the formula; at most three", () => {
    const again = withCitation(claim({ id: "k2", entity: "lab-booking", attribute: "deadline", value: " 2026-12-01 ", state: "conflicting" }), "1 December", { authorId: "p-7", validFrom: "2026-10-21T10:00:00Z" });
    const extra = ["2026-12-20", "2026-12-21"].map((v, i) =>
      claim({ id: `x${i}`, entity: "lab-booking", attribute: "deadline", value: v, state: "conflicting", trust: "inferred" }));
    const ranked = rankOptions(conflictOptions(LAB, NEXT_DUE, [kabir, sneha, again, ...extra]), authority, NOW, ALL_ROLES);
    expect(ranked).toHaveLength(3);
    expect(ranked[0].value).toBe("2026-12-01");
    expect(ranked[0].evidence.map((e) => e.claimId).sort()).toEqual(["k", "k2"]);
    // two from_record claims, same age, authority 3: 2 x (3 x 1 x r) + 0.5 for the second author
    const r = Math.pow(0.5, (Date.parse(NOW) - Date.parse("2026-10-21T10:00:00Z")) / 86_400_000 / 90);
    expect(ranked[0].score).toBeCloseTo(2 * 3 * r + 0.5, 2);
    expect(ranked[1].value).toBe("2026-12-05");
    expect(ranked[1].score).toBeLessThan(ranked[0].score);
    expect(ranked[2].value).toBe("2026-12-20"); // tie between the two weak ones broken by value
  });

  it("an option is visible only to roles that can see all of its evidence", () => {
    const hidden = withCitation(claim({ id: "f", entity: "lab-booking", attribute: "deadline", value: "2026-12-01", state: "conflicting", roleSet: FINANCE }), "1 Dec");
    const [merged, other] = rankOptions(conflictOptions(LAB, NEXT_DUE, [kabir, hidden, sneha]), authority, NOW, ALL_ROLES);
    expect(merged.roleSet).toEqual(FINANCE);
    expect(other.roleSet).toEqual(ALL_ROLES);
  });
});

describe("T-U-21: model proposals are checked in code", () => {
  const form = claim({ id: "c1", entity: "lab-booking", attribute: "procedure", value: "send the booking form to the lab office", statement: "The lab booking form goes to the lab office." });
  const old = claim({ id: "c2", entity: "lab-booking", attribute: "deadline", value: "2026-06-08", state: "superseded" });
  const byId = new Map([form, old].map((c) => [c.id, c]));

  it("drops unknown claim ids, superseded claims and ungrounded answers", () => {
    const got = evaluateOptions({
      options: [
        { answer: "Send the booking form to the lab office", claim_ids: ["c1"], why: "It is what the record says." },
        { answer: "Email the dean for written permission", claim_ids: ["c1"], why: "made up" },
        { answer: "Book by 8 June", claim_ids: ["c2"], why: "superseded" },
      ],
    }, byId);
    expect(got.map((o) => o.value)).toEqual(["Send the booking form to the lab office"]);
    expect(got[0]).toMatchObject({ source: "model", why: "It is what the record says." });
    expect(evaluateOptions({ options: [{ answer: "Send the booking form", claim_ids: ["nope"], why: "" }] }, byId)).toEqual([]);
  });

  it("an option's role set is the role set of the claims it cites", () => {
    const fin = claim({ id: "c3", entity: "lab-booking", attribute: "procedure", value: "pay the lab deposit first", roleSet: FINANCE });
    const got = evaluateOptions({ options: [{ answer: "Pay the lab deposit first", claim_ids: ["c3"], why: "" }] }, new Map([["c3", fin]]));
    expect(rankOptions(got, authority, NOW, ALL_ROLES)[0].roleSet).toEqual(FINANCE);
  });

  it("the prompt lists the claims in id order and is the same text for the same input", () => {
    const check = checksFor(LAB).find((c) => c.key === "how_to")!;
    const a = buildOptionsPrompt(LAB, check, "How is it done?", [form, old]);
    const b = buildOptionsPrompt(LAB, check, "How is it done?", [old, form]);
    expect(a).toEqual(b);
    expect(a.user).toContain("[c1] (procedure, from_record)");
    expect(a.user.indexOf("[c1]")).toBeLessThan(a.user.indexOf("[c2]"));
    expect(OptionsOutputSchema.safeParse({ options: [] }).success).toBe(true);
    expect(OptionsOutputSchema.safeParse({ options: Array.from({ length: 4 }, () => ({ answer: "a", claim_ids: [], why: "" })) }).success).toBe(false);
  });
});
