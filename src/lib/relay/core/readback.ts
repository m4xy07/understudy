// Typed read-back (Relay): the successor types the critical items; code normalises and compares
// exactly with the snapshot. Pure. Contract: docs/ARCHITECTURE.md section 4, "Review and Handover".
import type { Claim, ReadbackItem, ReadbackVerdict, RoleKey } from "@/lib/types";
import { norm } from "@/lib/text/norm";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAY = /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/;

function toIso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/**
 * Parse a typed date to ISO `YYYY-MM-DD`, or null. Accepts "2026-11-28" (with or without a time),
 * "28/11/2026" (day first; also `-` or `.`), "28 Nov 2026", "28th November", "Nov 28", "November 28, 2026",
 * with an optional weekday prefix. A missing year takes `defaultYear` (the snapshot year).
 */
export function parseDate(input: string, defaultYear?: number): string | null {
  let s = (input ?? "").normalize("NFKC").trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s].*)?$/.exec(s);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s);
  if (m) return toIso(fullYear(m[3]), Number(m[2]), Number(m[1]));

  s = s.replace(WEEKDAY, "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1");
  const year = (y: string | undefined) => (y ? fullYear(y) : defaultYear);

  m = /^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}|\d{2}))?$/.exec(s);
  if (m && MONTHS[m[2]] !== undefined) {
    const y = year(m[3]);
    return y === undefined ? null : toIso(y, MONTHS[m[2]], Number(m[1]));
  }
  m = /^([a-z]+)\.? (\d{1,2})(?: (\d{4}|\d{2}))?$/.exec(s);
  if (m && MONTHS[m[1]] !== undefined) {
    const y = year(m[3]);
    return y === undefined ? null : toIso(y, MONTHS[m[1]], Number(m[2]));
  }
  return null;
}

const CONTACT_TOKEN = /\[contact:[^\]\s]+\]/i;

/** Contact: the masked token if one is present (e.g. "[CONTACT:p-3]"), else the name; both via norm(). */
export function parseContact(input: string): string {
  const raw = input ?? "";
  const token = CONTACT_TOKEN.exec(raw);
  if (token) return norm(token[0]);
  return norm(raw).replace(/^@+/, "").trim();
}

/** Normalise one typed or expected value by item type. Unparseable dates give "". */
export function normaliseReadback(type: ReadbackItem["type"], value: string, defaultYear?: number): string {
  switch (type) {
    case "date":
      return parseDate(value, defaultYear) ?? "";
    case "contact":
      return parseContact(value);
    case "command":
    case "text":
      return norm(value ?? "");
  }
}

/** Expected value per item from the claims this role can see; null when not visible (or no claim). */
export function expectedFromClaims(
  items: readonly ReadbackItem[],
  visibleClaims: readonly Pick<Claim, "id" | "value">[],
): Record<string, string | null> {
  const byId = new Map(visibleClaims.map((c) => [c.id, c.value]));
  const out: Record<string, string | null> = {};
  for (const item of items) {
    out[item.key] = item.expectedClaimId ? byId.get(item.expectedClaimId) ?? null : null;
  }
  return out;
}

/**
 * Compare typed values with the snapshot's expected values after typed normalisation, exactly.
 * expected[key] null/undefined => "not_visible". An empty answer never matches.
 */
export function checkReadback(
  items: readonly ReadbackItem[],
  typed: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string | null>>,
  opts: { year?: number } = {},
): ReadbackVerdict[] {
  return items.map((item) => {
    const t = typed[item.key] ?? "";
    const exp = expected[item.key];
    if (exp === null || exp === undefined) {
      return { key: item.key, typed: t, normalised: normaliseReadback(item.type, t, opts.year), expected: null, verdict: "not_visible" };
    }
    const expNorm = normaliseReadback(item.type, exp, opts.year);
    const year = opts.year ?? (item.type === "date" && expNorm ? Number(expNorm.slice(0, 4)) : undefined);
    const typedNorm = normaliseReadback(item.type, t, year);
    const verdict = typedNorm !== "" && typedNorm === expNorm ? "match" : "mismatch";
    return { key: item.key, typed: t, normalised: typedNorm, expected: expNorm, verdict };
  });
}

export interface Acknowledgement {
  role: RoleKey;
  at: string;
  snapshotHash: string;
  verdicts: ReadbackVerdict[];
  /** True when at least one item was visible and every visible item matched. */
  allMatched: boolean;
}

/** The acknowledgement row: verdicts, role, time and snapshot hash. */
export function ackRecord(input: {
  role: RoleKey;
  snapshotHash: string;
  verdicts: readonly ReadbackVerdict[];
  at?: string;
}): Acknowledgement {
  const visible = input.verdicts.filter((v) => v.verdict !== "not_visible");
  return {
    role: input.role,
    at: input.at ?? new Date().toISOString(),
    snapshotHash: input.snapshotHash,
    verdicts: input.verdicts.map((v) => ({ ...v })),
    allMatched: visible.length > 0 && visible.every((v) => v.verdict === "match"),
  };
}
