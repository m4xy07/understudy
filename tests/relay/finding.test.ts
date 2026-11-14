// A successor finding, pure core: the form rules, the fixed evidence layout, the drafts, and how
// a finding meets the Attest rules (corroboration only by a record, conflicts surfaced).
import { describe, expect, it } from "vitest";
import {
  ANSWER_MAX, FILE_MAX_BYTES, FINDING_ERRORS, NOTE_MAX, answerQuote, decodeAttachment, findingRoleSet, findingText,
  findingToDrafts, parseFindingText, validateFinding, type FindingInput,
} from "@/lib/relay/core/finding";
import { applyRules, corroborate, reviewFlags, tierOf } from "@/lib/attest/core/rules";
import { attestPack } from "@/lib/attest";
import { assignTier } from "@/lib/relay/core/review";
import { TRUST_ORDER, RECORD_TRUST, STRONG_TRUST } from "@/lib/trust";
import { norm } from "@/lib/text/norm";
import { ALL_ROLES, makeClaim } from "./fixtures";
import { CLUB, CLUB_RESTRICTED } from "../helpers/club";

const TS = "2026-11-25T06:30:00.000Z";

function input(over: Partial<FindingInput> = {}): FindingInput {
  return {
    answer: "2026-11-18",
    note: "Mr. Pawar confirmed late access is every Wednesday in build season.",
    link: null,
    attachment: null,
    resp: { id: "resp_1", key: "R09", title: "Late-night lab access", entities: ["lab-late-access"] },
    check: { key: "next_due_date", label: "Next due date", attributes: ["deadline"], needsDate: true },
    baseRoleSet: [...ALL_ROLES],
    keepRoles: ["tech_lead", "president"],
    narrowTo: null,
    successorLabel: "Incoming tech lead",
    entityLabel: "Late-night lab access",
    ts: TS,
    today: "2026-11-11T12:00:00+05:30",
    recordedByRole: "tech_lead",
    ...over,
  };
}
const textCheck = { key: "how_to_do_it", label: "How to do it", attributes: ["procedure" as const] };

describe("validateFinding: every form error", () => {
  const err = (over: Partial<FindingInput>) => {
    const r = validateFinding(input(over));
    return r.ok ? null : r.error;
  };

  it("accepts the example finding", () => {
    expect(validateFinding(input())).toEqual({ ok: true });
    expect(err({ check: textCheck, answer: "Ask at the workshop desk", note: "" })).toBeNull();
    expect(err({ link: "https://college.example/late-access" })).toBeNull();
    expect(err({ attachment: { name: "notes.md", text: "# rota" } })).toBeNull();
  });

  it("empty answer", () => {
    expect(err({ check: textCheck, answer: "   " })).toBe("Write an answer first.");
  });
  it("no date on a date check", () => {
    expect(err({ answer: "" })).toBe("Pick a date.");
    expect(err({ answer: "every Wednesday" })).toBe("Pick a date.");
    expect(err({ answer: "2026-02-30" })).toBe("Pick a date.");
  });
  it("a date in the past on a date check", () => {
    expect(err({ answer: "2026-11-10" })).toBe("That date has passed. Enter the next one.");
    expect(err({ answer: "2026-11-11" })).toBeNull(); // today still counts
  });
  it("answer too long", () => {
    expect(err({ check: textCheck, answer: "a".repeat(ANSWER_MAX + 1) })).toBe("Keep the answer under 300 characters.");
    expect(err({ check: textCheck, answer: "a".repeat(ANSWER_MAX) })).toBeNull();
  });
  it("note too long", () => {
    expect(err({ note: "n".repeat(NOTE_MAX + 1) })).toBe("Keep the note under 4000 characters.");
  });
  it("bad link", () => {
    for (const link of ["notice board", "ftp://files.example/x", "javascript:alert(1)", "https://", "http://localhost"]) {
      expect(err({ link }), link).toBe("That link is not a web address. Use one that starts with https://");
    }
  });
  it("file too large, wrong type, or binary", () => {
    expect(err({ attachment: { name: "big.txt", text: "x", bytes: FILE_MAX_BYTES + 1 } })).toBe("The file is over 200 KB.");
    expect(err({ attachment: { name: "big.txt", text: "x".repeat(FILE_MAX_BYTES + 1) } })).toBe("The file is over 200 KB.");
    expect(err({ attachment: { name: "photo.png", text: "x" } })).toBe("Use a .txt, .md, .csv or .ics file.");
    expect(err({ attachment: { name: ".txt", text: "x" } })).toBe("Use a .txt, .md, .csv or .ics file.");
    expect(err({ attachment: { name: "a.txt", text: "a\u0000b" } })).toBe("Use a .txt, .md, .csv or .ics file.");
  });
  it("the fixed messages for duplicate, closed gap and no snapshot", () => {
    expect(FINDING_ERRORS.duplicate).toBe("This gap already has a finding waiting for review. Withdraw it first.");
    expect(FINDING_ERRORS.gapClosed).toBe("This gap is already closed.");
    expect(FINDING_ERRORS.noSnapshot).toBe("There is no approved handover yet.");
  });
  it("no copy uses an em dash", () => {
    expect(Object.values(FINDING_ERRORS).join(" ")).not.toMatch(/\u2014/);
  });
});

describe("decodeAttachment", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it("decodes a small text file and keeps only the file name", () => {
    const r = decodeAttachment("C:\\notes\\rota.CSV", bytes("day,who\nwed,me\n"));
    expect(r).toEqual({ ok: true, attachment: { name: "rota.CSV", text: "day,who\nwed,me\n", bytes: 15 } });
  });
  it("refuses binary content, a wrong encoding, a wrong type and more than 200 KB", () => {
    expect(decodeAttachment("a.txt", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toEqual({ ok: false, error: FINDING_ERRORS.fileType });
    expect(decodeAttachment("a.txt", new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ ok: false, error: FINDING_ERRORS.fileType });
    expect(decodeAttachment("a.pdf", bytes("x"))).toEqual({ ok: false, error: FINDING_ERRORS.fileType });
    expect(decodeAttachment("a.ics", new Uint8Array(FILE_MAX_BYTES + 1).fill(0x41))).toEqual({ ok: false, error: FINDING_ERRORS.fileTooLarge });
    expect(decodeAttachment("a.ics", new Uint8Array(FILE_MAX_BYTES).fill(0x41)).ok).toBe(true);
  });
});

describe("role set: narrowing only", () => {
  it("no narrowing keeps the base", () => {
    expect(findingRoleSet(ALL_ROLES, ["tech_lead", "president"], null)).toEqual(ALL_ROLES);
  });
  it("the successor and the approver are always kept", () => {
    expect(findingRoleSet(ALL_ROLES, ["tech_lead", "president"], [])).toEqual(["president", "tech_lead"]);
    expect(findingRoleSet(ALL_ROLES, ["tech_lead", "president"], ["treasurer"])).toEqual(["president", "tech_lead", "treasurer"]);
  });
  it("requested roles outside the base are ignored: the result is always a subset of the base", () => {
    const base = ["president", "tech_lead", "treasurer"];
    const out = findingRoleSet(base, ["tech_lead", "president"], ["new_member", "leaver", "ghost", "treasurer"]);
    expect(out).toEqual(["president", "tech_lead", "treasurer"]);
    expect(out.every((r) => base.includes(r))).toBe(true);
    // A keep role that is not in the base is not added either.
    expect(findingRoleSet(["treasurer"], ["tech_lead", "president"], ["treasurer"])).toEqual(["treasurer"]);
  });
});

describe("findingToDrafts", () => {
  it("builds the fixed evidence layout and reads it back", () => {
    const full = input({ link: "https://college.example/late", attachment: { name: "rota.csv", text: "wed\n" }, note: "Line one.\nLine two." });
    const text = findingText(full);
    expect(text).toBe([
      "Finding for R09 Late-night lab access: Next due date",
      "Answer: 2026-11-18",
      "How I know: Line one.\nLine two.",
      "Link: https://college.example/late",
      "File: rota.csv",
    ].join("\n"));
    expect(parseFindingText(text, { hasLink: true, hasFile: true })).toEqual({
      heading: "Finding for R09 Late-night lab access: Next due date", answer: "2026-11-18",
      note: "Line one.\nLine two.", link: "https://college.example/late", fileName: "rota.csv",
    });
    const bare = findingText(input({ note: "" }));
    expect(bare.split("\n")).toHaveLength(3);
    expect(parseFindingText(bare, { hasLink: false, hasFile: false })).toMatchObject({ note: "", link: null, fileName: null });
  });

  it("the quote is an exact substring; trust and origin are set by code; the value is the answer alone", () => {
    const d = findingToDrafts(input());
    expect(d.claim.citations).toEqual([{ segmentId: d.segment.id, quote: "Answer: 2026-11-18", accepted: true, exact: true }]);
    expect(d.segment.text).toContain(answerQuote("2026-11-18"));
    expect(norm(d.segment.text)).toContain(norm(d.claim.citations[0].quote!));
    expect(d.claim).toMatchObject({
      trust: "successor_found", origin: "successor_finding", state: "active", review: "pending",
      entity: "lab-late-access", attribute: "deadline", value: "2026-11-18", sourceKinds: ["finding"], authorId: null,
      statement: "Incoming tech lead found: Mr. Pawar confirmed late access is every Wednesday in build season.",
    });
    expect(findingToDrafts(input({ note: "" })).claim.statement).toBe("Incoming tech lead found: 2026-11-18");
    expect(d.segment).toMatchObject({
      sourceId: "src_first_weeks", sourceKind: "finding", kind: "finding", thread: "first-weeks:R09:next_due_date",
      position: 0, authorId: null, ts: TS, version: 1,
    });
    expect(d.segment.id).toMatch(/^seg_[0-9a-f]{16}$/);
    expect(d.findingId).toMatch(/^fnd_[0-9a-f]{12}$/);
    expect(d.segment.meta).toMatchObject({ findingId: d.findingId, responsibilityId: "resp_1", checkKey: "next_due_date", recordedByRole: "tech_lead", hasLink: false, attachmentName: null });
    // Same input, same ids: the demo example repeats.
    expect(findingToDrafts(input()).segment.id).toBe(d.segment.id);
    expect(findingToDrafts(input({ ts: "2026-11-26T06:30:00.000Z" })).segment.id).not.toBe(d.segment.id);
  });

  it("whatever it links to or attaches, a finding never starts as a record", () => {
    const d = findingToDrafts(input({ link: "https://registrar.example/official.pdf", attachment: { name: "official.txt", text: "Signed by the registrar." } }));
    expect(d.claim.trust).toBe("successor_found");
    expect(RECORD_TRUST.has(d.claim.trust)).toBe(false);
    expect(STRONG_TRUST.has(d.claim.trust)).toBe(true);
    expect(TRUST_ORDER.indexOf("successor_found")).toBe(TRUST_ORDER.indexOf("leaver_said") + 1);
    // The file is a second segment of the same finding, with the same role set, never a source.
    expect(d.attachment).toMatchObject({
      sourceId: "src_first_weeks", sourceKind: "finding", kind: "finding", thread: d.segment.thread, position: 1,
      text: "Signed by the registrar.", roleSet: d.roleSet,
    });
    expect(d.attachment!.meta.attachment).toMatchObject({ name: "official.txt", bytes: 24 });
    expect(d.claim.citations.map((c) => c.segmentId)).toEqual([d.segment.id]);
    expect(d.claim.sourceKinds).toEqual(["finding"]);
  });

  it("segment, attachment and claim share the narrowed role set", () => {
    const d = findingToDrafts(input({ narrowTo: ["tech_lead"], attachment: { name: "a.txt", text: "x" } }));
    expect(d.roleSet).toEqual(["president", "tech_lead"]);
    expect(d.segment.roleSet).toEqual(d.roleSet);
    expect(d.attachment!.roleSet).toEqual(d.roleSet);
    expect(d.claim.roleSet).toEqual(d.roleSet);
  });

  it("refuses input that does not pass the form rules", () => {
    expect(() => findingToDrafts(input({ answer: "" }))).toThrow("Pick a date.");
  });
});

describe("a finding under the Attest rules", () => {
  const pack = attestPack(CLUB);
  const finding = (over: Partial<Parameters<typeof makeClaim>[0]> = {}) => makeClaim({
    id: "f1", entity: "lab-late-access", attribute: "deadline", value: "2026-11-18", trust: "successor_found",
    origin: "successor_finding", sourceKinds: ["finding"], authorId: null, validFrom: TS, review: "approved", ...over,
  });
  const record = (over: Partial<Parameters<typeof makeClaim>[0]> = {}) => makeClaim({
    id: "r1", entity: "lab-late-access", attribute: "deadline", value: "2026-11-18", trust: "from_record",
    origin: "structured", sourceKinds: ["tasks_csv"], validFrom: "2026-11-12T09:00:00.000Z", review: "approved", ...over,
  });
  const trustOf = (claims: ReturnType<typeof makeClaim>[], id: string) => claims.find((c) => c.id === id)!.trust;

  it("alone it stays Successor found", () => {
    const out = applyRules([finding()], pack).claims;
    expect(out[0]).toMatchObject({ trust: "successor_found", state: "active" });
  });

  it("a record with the same value corroborates it, and the record too", () => {
    const out = corroborate([finding(), record()]);
    expect(trustOf(out, "f1")).toBe("corroborated");
    expect(trustOf(out, "r1")).toBe("corroborated");
  });

  it("no laundering: another finding, a leaver answer or an inferred claim never upgrades it", () => {
    const second = finding({ id: "f2", validFrom: "2026-11-26T06:30:00.000Z" });
    const leaver = makeClaim({
      id: "l1", entity: "lab-late-access", attribute: "deadline", value: "2026-11-18", trust: "leaver_said",
      origin: "leaver_answer", sourceKinds: ["interview"], authorId: "p-2",
    });
    const inferred = record({ id: "i1", trust: "inferred", sourceKinds: ["whatsapp"] });
    const out = corroborate([finding(), second, leaver, inferred]);
    expect(out.map((c) => c.trust)).toEqual(["successor_found", "successor_found", "leaver_said", "inferred"]);
  });

  it("a finding that a record once corroborated is still not a record for other people's words", () => {
    const once = finding({ trust: "corroborated" });
    const second = finding({ id: "f2", validFrom: "2026-11-26T06:30:00.000Z" });
    const leaver = makeClaim({
      id: "l1", entity: "lab-late-access", attribute: "deadline", value: "2026-11-18", trust: "leaver_said",
      origin: "leaver_answer", sourceKinds: ["interview"], authorId: "p-2",
    });
    const out = corroborate([once, second, leaver]);
    expect(trustOf(out, "f2")).toBe("successor_found");
    expect(trustOf(out, "l1")).toBe("leaver_said");
  });

  it("a record that disagrees makes both conflicting: disagreement is surfaced, not overwritten", () => {
    const rival = record({ value: "2026-11-19", validFrom: "2026-11-12T09:00:00.000Z" });
    // Recorded on 13 Nov, while both dates are still ahead (a date already past is an earlier occurrence, not a rival).
    const { claims, firings } = applyRules([rival, finding({ validFrom: "2026-11-13T09:00:00.000Z" })], pack);
    expect(claims.map((c) => c.state)).toEqual(["conflicting", "conflicting"]);
    expect(firings).toEqual([{ rule: 4, olderId: "r1", newerId: "f1" }]);
    expect(claims.find((c) => c.id === "f1")!.stateNote).toContain("a successor finding");
    expect(claims.every((c) => c.trust !== "corroborated")).toBe(true);
  });

  it("a rejected finding leaves the conflict; the record is active again", () => {
    const rival = record({ value: "2026-11-19" });
    const { claims } = applyRules([rival, finding({ review: "rejected" })], pack);
    expect(claims.find((c) => c.id === "r1")!.state).toBe("active");
  });

  it("a claim that began as a finding never enters tier A, even when corroborated", () => {
    const corroborated = finding({ trust: "corroborated", importance: "normal" });
    expect(reviewFlags(corroborated)).toContain("from a successor finding");
    expect(tierOf(corroborated, CLUB_RESTRICTED)).toBe("B");
    // Tier C: a blocking gap, a conflict, or hidden from the restricted audience.
    expect(tierOf(finding({ importance: "blocking" }), CLUB_RESTRICTED)).toBe("C");
    expect(tierOf(finding({ state: "conflicting" }), CLUB_RESTRICTED)).toBe("C");
    expect(assignTier(finding({ roleSet: ["president", "tech_lead"] }), CLUB_RESTRICTED)).toBe("C");
  });
});
