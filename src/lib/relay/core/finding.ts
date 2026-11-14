// A successor finding (living handover). Pure: validates the form, builds the fixed evidence
// text and turns it into a segment and a claim draft. No database, no pack loader, no model.
//
// Rules that live here:
//   - the answer is quoted exactly ("Answer: ...") so the claim is cited like any other claim;
//   - trust is always successor_found and origin successor_finding: a finding can never start
//     as a record, whatever it links to or attaches;
//   - the role set only narrows: the pack default, filtered to what the successor ticked, with
//     the successor and the approver always kept;
//   - an attached file is a second segment of the same finding, never a source of its own.
import { norm, sha256Hex } from "@/lib/text/norm";
import type { Attribute, Citation, RoleKey, Segment } from "@/lib/types";

export const ANSWER_MAX = 300;
export const NOTE_MAX = 4000;
export const FILE_MAX_BYTES = 200 * 1024;
export const FILE_TYPES = [".txt", ".md", ".csv", ".ics"] as const;
export const FINDING_SOURCE_ID = "src_first_weeks";
export const FINDING_SOURCE_NAME = "First weeks";

/** Every message the finding form can show. Copy from the spec, section B3. */
export const FINDING_ERRORS = {
  emptyAnswer: "Write an answer first.",
  noDate: "Pick a date.",
  pastDate: "That date has passed. Enter the next one.",
  answerTooLong: `Keep the answer under ${ANSWER_MAX} characters.`,
  noteTooLong: `Keep the note under ${NOTE_MAX} characters.`,
  badLink: "That link is not a web address. Use one that starts with https://",
  fileTooLarge: "The file is over 200 KB.",
  fileType: "Use a .txt, .md, .csv or .ics file.",
  duplicate: "This gap already has a finding waiting for review. Withdraw it first.",
  gapClosed: "This gap is already closed.",
  noSnapshot: "There is no approved handover yet.",
  noEntity: "This gap has no topic to attach a finding to.",
} as const;

export interface FindingInput {
  answer: string;
  note: string;
  link: string | null;
  /** Already decoded text of the attached file (see decodeAttachment). */
  attachment: { name: string; text: string; bytes?: number } | null;
  resp: { id: string; key: string; title: string; entities: string[] };
  check: { key: string; label: string; attributes: Attribute[]; needsDate?: boolean };
  /** The pack's upload default: the widest a finding can ever be. */
  baseRoleSet: RoleKey[];
  /** Roles that always keep the finding: the successor and the approver. */
  keepRoles: RoleKey[];
  /** Roles the successor ticked; null means "no narrowing". Roles outside the base are ignored. */
  narrowTo: RoleKey[] | null;
  successorLabel: string;
  entityLabel: string;
  /** ISO time of the finding. */
  ts: string;
  /** ISO date or date-time of "today" for the workspace: a date check refuses earlier dates. */
  today: string;
  /** Role key of whoever recorded it (roles are not people; there is no author id). */
  recordedByRole?: RoleKey;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** One line, single spaces. The answer is quoted on one line of the evidence text. */
export function oneLine(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** A web address a person can open: http or https with a host. Never fetched by Understudy. */
export function isWebAddress(s: string): boolean {
  if (/\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function hasAllowedFileType(name: string): boolean {
  const lower = (name ?? "").toLowerCase();
  return FILE_TYPES.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/**
 * Decode an uploaded file as text. Refuses the wrong extension, more than 200 KB, bytes that are
 * not valid UTF-8 and binary content (a NUL byte).
 */
export function decodeAttachment(
  name: string, bytes: Uint8Array,
): { ok: true; attachment: { name: string; text: string; bytes: number } } | { ok: false; error: string } {
  const clean = (name ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  if (!hasAllowedFileType(clean)) return { ok: false, error: FINDING_ERRORS.fileType };
  if (bytes.byteLength > FILE_MAX_BYTES) return { ok: false, error: FINDING_ERRORS.fileTooLarge };
  if (bytes.includes(0)) return { ok: false, error: FINDING_ERRORS.fileType };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: FINDING_ERRORS.fileType };
  }
  return { ok: true, attachment: { name: clean.slice(0, 120), text: text.replace(/^﻿/, ""), bytes: bytes.byteLength } };
}

/** The form rules, in the order a person would fix them. */
export function validateFinding(input: FindingInput): { ok: true } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const answer = oneLine(input.answer);
  const needsDate = input.check.needsDate === true;
  if (!answer) return fail(needsDate ? FINDING_ERRORS.noDate : FINDING_ERRORS.emptyAnswer);
  if (needsDate) {
    if (!isRealDate(answer)) return fail(FINDING_ERRORS.noDate);
    if (answer < input.today.slice(0, 10)) return fail(FINDING_ERRORS.pastDate);
  }
  if (answer.length > ANSWER_MAX) return fail(FINDING_ERRORS.answerTooLong);
  if ((input.note ?? "").trim().length > NOTE_MAX) return fail(FINDING_ERRORS.noteTooLong);
  const link = (input.link ?? "").trim();
  if (link && !isWebAddress(link)) return fail(FINDING_ERRORS.badLink);
  if (input.attachment) {
    if (!hasAllowedFileType(input.attachment.name)) return fail(FINDING_ERRORS.fileType);
    const size = input.attachment.bytes ?? Buffer.byteLength(input.attachment.text, "utf8");
    if (size > FILE_MAX_BYTES) return fail(FINDING_ERRORS.fileTooLarge);
    if (input.attachment.text.includes("\u0000")) return fail(FINDING_ERRORS.fileType);
  }
  if (!input.resp.entities[0] || !input.check.attributes[0]) return fail(FINDING_ERRORS.noEntity);
  return { ok: true };
}

/**
 * Role set of a finding: the base filtered to what was ticked, the keep roles always in.
 * Nothing here can add a role that is not in the base, so a finding only ever narrows.
 */
export function findingRoleSet(base: readonly RoleKey[], keep: readonly RoleKey[], narrowTo: readonly RoleKey[] | null): RoleKey[] {
  const uniqueBase = [...new Set(base)];
  if (!narrowTo) return uniqueBase;
  const want = new Set([...narrowTo, ...keep]);
  return uniqueBase.filter((r) => want.has(r));
}

/** The exact quote the claim cites. Always a substring of findingText(). */
export function answerQuote(answer: string): string {
  return `Answer: ${oneLine(answer)}`;
}

/**
 * The evidence text, in a fixed layout so the quote is always an exact substring:
 *   Finding for {key} {title}: {check label}
 *   Answer: {answer}
 *   How I know: {note}
 *   Link: {url}          (only with a link)
 *   File: {file name}    (only with a file)
 */
export function findingText(input: Pick<FindingInput, "answer" | "note" | "link" | "attachment" | "resp" | "check">): string {
  const lines = [
    `Finding for ${input.resp.key} ${oneLine(input.resp.title)}: ${input.check.label}`,
    answerQuote(input.answer),
    `How I know: ${(input.note ?? "").trim()}`,
  ];
  const link = (input.link ?? "").trim();
  if (link) lines.push(`Link: ${link}`);
  if (input.attachment) lines.push(`File: ${oneLine(input.attachment.name)}`);
  return lines.join("\n");
}

export interface FindingParts {
  heading: string;
  answer: string;
  note: string;
  link: string | null;
  fileName: string | null;
}

/** Read the fixed layout back. `hasLink` and `hasFile` come from the segment's meta. */
export function parseFindingText(text: string, flags: { hasLink: boolean; hasFile: boolean }): FindingParts {
  const lines = text.split("\n");
  const heading = lines.shift() ?? "";
  const answerLine = lines.shift() ?? "";
  let fileName: string | null = null;
  let link: string | null = null;
  if (flags.hasFile && lines.length && lines[lines.length - 1].startsWith("File: ")) fileName = lines.pop()!.slice(6);
  if (flags.hasLink && lines.length && lines[lines.length - 1].startsWith("Link: ")) link = lines.pop()!.slice(6);
  return {
    heading,
    answer: answerLine.replace(/^Answer: /, ""),
    note: lines.join("\n").replace(/^How I know: /, ""),
    link,
    fileName,
  };
}

/** seg_ + 16 hex of sha256(kind | ts | thread | position | sha256(norm(text))), as the contract says. */
export function findingSegmentId(ts: string, thread: string, position: number, text: string): string {
  return `seg_${sha256Hex(`finding|${ts}|${thread}|${position}|${sha256Hex(norm(text))}`).slice(0, 16)}`;
}

export function findingThread(respKey: string, checkKey: string): string {
  return `first-weeks:${respKey}:${checkKey}`;
}

export interface FindingClaimDraft {
  entity: string;
  entityLabel: string;
  attribute: Attribute;
  value: string;
  statement: string;
  citations: Citation[];
  trust: "successor_found";
  origin: "successor_finding";
  state: "active";
  review: "pending";
  roleSet: RoleKey[];
  validFrom: string;
  authorId: null;
  sourceKinds: ["finding"];
}

export interface FindingDrafts {
  findingId: string;
  roleSet: RoleKey[];
  segment: Segment;
  attachment: Segment | null;
  claim: FindingClaimDraft;
}

/**
 * Segment, optional attachment segment and claim draft for one finding. Every text here must
 * already be masked. Throws when the input does not pass validateFinding or the quote is not
 * an exact substring of the evidence (which the fixed layout rules out).
 */
export function findingToDrafts(input: FindingInput): FindingDrafts {
  const valid = validateFinding(input);
  if (!valid.ok) throw new Error(valid.error);
  const answer = oneLine(input.answer);
  const note = (input.note ?? "").trim();
  const roleSet = findingRoleSet(input.baseRoleSet, input.keepRoles, input.narrowTo);
  const thread = findingThread(input.resp.key, input.check.key);
  const text = findingText(input);
  const quote = answerQuote(answer);
  if (!text.includes(quote)) throw new Error("The answer is not quoted exactly in the evidence.");
  const id = findingSegmentId(input.ts, thread, 0, text);
  const findingId = `fnd_${sha256Hex(id).slice(0, 12)}`;
  const link = (input.link ?? "").trim();

  const segment: Segment = {
    id,
    sourceId: FINDING_SOURCE_ID,
    sourceKind: "finding",
    kind: "finding",
    ts: input.ts,
    authorId: null,
    thread,
    position: 0,
    text,
    textHash: sha256Hex(norm(text)),
    roleSet,
    version: 1,
    meta: {
      findingId,
      responsibilityId: input.resp.id,
      checkKey: input.check.key,
      recordedByRole: input.recordedByRole ?? null,
      hasLink: Boolean(link),
      attachmentName: input.attachment ? oneLine(input.attachment.name) : null,
    },
  };

  let attachment: Segment | null = null;
  if (input.attachment) {
    const fileText = input.attachment.text;
    attachment = {
      id: findingSegmentId(input.ts, thread, 1, fileText),
      sourceId: FINDING_SOURCE_ID,
      sourceKind: "finding",
      kind: "finding",
      ts: input.ts,
      authorId: null,
      thread,
      position: 1,
      text: fileText,
      textHash: sha256Hex(norm(fileText)),
      roleSet,
      version: 1,
      meta: {
        findingId,
        responsibilityId: input.resp.id,
        checkKey: input.check.key,
        attachment: {
          name: oneLine(input.attachment.name),
          bytes: input.attachment.bytes ?? Buffer.byteLength(fileText, "utf8"),
          sha256: sha256Hex(fileText),
        },
      },
    };
  }

  const claim: FindingClaimDraft = {
    entity: input.resp.entities[0],
    entityLabel: input.entityLabel || input.resp.entities[0],
    attribute: input.check.attributes[0],
    value: answer,
    statement: `${input.successorLabel} found: ${note ? oneLine(note).slice(0, 600) : answer}`,
    citations: [{ segmentId: id, quote, accepted: true, exact: true }],
    trust: "successor_found",
    origin: "successor_finding",
    state: "active",
    review: "pending",
    roleSet,
    validFrom: input.ts,
    authorId: null,
    sourceKinds: ["finding"],
  };
  return { findingId, roleSet, segment, attachment, claim };
}
