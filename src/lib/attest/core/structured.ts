// Deterministic claims from structured sources (task board rows, calendar events).
// No model. Every quote is an exact substring of the segment text, or null when the
// field does not appear in the text (the verifier then caps trust at "inferred").
import type { Attribute, Segment } from "@/lib/types";
import { entityToken } from "./extract";
import { OTHER_ENTITY, type DraftClaim, type ExtractionPack } from "./schema";

export interface StructuredOptions {
  /** ISO time; when given, the "next" occurrence of a recurring event is the first at or after it. */
  now?: string;
}

/** Claims from every `task` and `event` segment; other kinds are ignored. */
export function structuredClaims(
  segments: Segment[],
  pack: ExtractionPack,
  opts: StructuredOptions = {},
): DraftClaim[] {
  const out: DraftClaim[] = [];
  for (const seg of segments) {
    if (seg.kind === "task") out.push(...taskClaims(seg, pack));
    else if (seg.kind === "event") out.push(...eventClaims(seg, pack, opts));
  }
  return out;
}

export function taskClaims(seg: Segment, pack: ExtractionPack): DraftClaim[] {
  const m = seg.meta ?? {};
  const title = str(m.title) ?? firstLine(seg.text);
  const labels = list(m.labels);
  const { entity, entityRaw } = matchEntity(pack, [title, ...labels].join(" "), title);
  const make = mk(seg, entity, entityRaw);
  const out: DraftClaim[] = [];

  const owner = str(m.owner);
  if (owner) {
    out.push(make("owner", owner, `${owner} owns "${title}".`,
      findQuote(seg.text, ["owner", "assignee", "assigned to"], [owner])));
  }
  const status = str(m.status);
  if (status) {
    out.push(make("status", status, `The status of "${title}" is ${status}.`,
      findQuote(seg.text, ["status", "state"], [status])));
  }
  const due = str(m.due) ?? str(m.due_date) ?? str(m.dueDate);
  if (due) {
    const value = isoDate(due) ?? due;
    out.push(make("deadline", value, `"${title}" is due on ${value}.`,
      findQuote(seg.text, ["due", "due date", "deadline"], dateForms(due))));
  }
  return out;
}

export function eventClaims(seg: Segment, pack: ExtractionPack, opts: StructuredOptions = {}): DraftClaim[] {
  const m = seg.meta ?? {};
  const summary = str(m.summary) ?? str(m.title) ?? firstLine(seg.text);
  const categories = list(m.categories);
  const { entity, entityRaw } = matchEntity(pack, [summary, ...categories].join(" "), summary);
  const make = mk(seg, entity, entityRaw);
  const out: DraftClaim[] = [];

  const start = str(m.start) ?? str(m.dtstart) ?? str(m.startsAt);
  const rrule = str(m.rrule)?.replace(/^RRULE:/i, "");
  const occurrences = list(m.occurrences);

  if (rrule) {
    // Recurring: one deadline claim stating the cadence, quoting the RRULE text.
    const cadence = describeRrule(rrule);
    const nextRaw = nextOccurrence(occurrences, opts.now) ?? start;
    const next = nextRaw ? isoDate(nextRaw) ?? nextRaw : null;
    const value = next ? `${cadence}, next ${next}` : cadence;
    const statement = next
      ? `"${summary}" repeats ${cadence}; the next date is ${next}.`
      : `"${summary}" repeats ${cadence}.`;
    const repeatsQuote =
      findQuote(seg.text, ["rrule", "repeats", "recurs"], [rrule]) ?? labelSpan(seg.text, ["repeats", "rrule", "recurs"]);
    out.push(make("deadline", value, statement, repeatsQuote));
    // The next occurrence as a plain ISO date: a separate single-date deadline claim, so the
    // read-back and the date rules see a date (the cadence claim above is a different kind of fact).
    if (next && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
      const quote =
        findQuote(seg.text, ["start", "starts", "when", "date", "dtstart"], nextRaw ? dateForms(nextRaw) : []) ??
        repeatsQuote ??
        labelSpan(seg.text, ["when", "start", "dtstart"]);
      out.push(make("deadline", next, `The next "${summary}" is on ${next}.`, quote));
    }
  } else if (start) {
    const value = isoDate(start) ?? start;
    out.push(make("deadline", value, `"${summary}" is on ${value}.`,
      findQuote(seg.text, ["start", "starts", "when", "date", "dtstart"], dateForms(start))));
  }

  const location = str(m.location);
  if (location) {
    out.push(make("location", location, `"${summary}" takes place at ${location}.`,
      findQuote(seg.text, ["location", "where", "place"], [location])));
  }
  return out;
}

// ---------------------------------------------------------------------------

function mk(seg: Segment, entity: string, entityRaw: string | null) {
  return (attribute: Attribute, value: string, statement: string, quote: string | null): DraftClaim => ({
    entity,
    entityRaw,
    attribute,
    value,
    statement,
    citations: [{ segmentId: seg.id, quote }],
    origin: "structured",
    batchId: `struct_${seg.id}`,
    batchSegmentIds: [seg.id],
  });
}

const SUFFIX = "(?:s|es|ed|ing|ment|ments)?";

/**
 * Pick the pack entity whose key, label or aliases appear (as whole words) in `haystack`.
 * Longest matches score highest; ties go to the earlier entity in the pack. No hit: "other".
 */
export function matchEntity(
  pack: ExtractionPack,
  haystack: string,
  rawLabel: string,
): { entity: string; entityRaw: string | null } {
  const h = entityToken(haystack);
  let best: { key: string; score: number } | null = null;
  for (const e of pack.entities) {
    let score = 0;
    for (const name of [e.key, e.label, ...e.aliases]) {
      const t = entityToken(name);
      if (!t) continue;
      const re = new RegExp(`(?<![a-z0-9])${escapeRe(t)}${SUFFIX}(?![a-z0-9])`);
      if (re.test(h)) score += t.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { key: e.key, score };
  }
  return best ? { entity: best.key, entityRaw: null } : { entity: OTHER_ENTITY, entityRaw: rawLabel };
}

/**
 * An exact substring of `text` supporting a field: first `label: value` (any of the
 * labels, case-insensitive), then the bare value. Null when neither appears.
 */
export function findQuote(text: string, labels: string[], values: string[]): string | null {
  const vals = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  for (const v of vals) {
    for (const l of labels) {
      const re = new RegExp(`(?<![A-Za-z0-9])${loosePattern(l)}[ \\t]*[:=][ \\t]*${loosePattern(v)}${tailBoundary(v)}`, "i");
      const m = re.exec(text);
      if (m) return m[0];
    }
  }
  for (const v of vals) {
    const re = new RegExp(`${headBoundary(v)}${loosePattern(v)}${tailBoundary(v)}`, "i");
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** The exact `label: value` span (up to the next " | " or line end) for the first label present. */
export function labelSpan(text: string, labels: string[]): string | null {
  for (const l of labels) {
    const m = new RegExp(`(?<![A-Za-z0-9])${loosePattern(l)}[ \\t]*:[ \\t]*[^|\\n]*[^|\\s]`, "i").exec(text);
    if (m) return m[0];
  }
  return null;
}

const DAY: Record<string, string> ={ MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const FREQ: Record<string, [string, string]> = {
  DAILY: ["daily", "days"], WEEKLY: ["weekly", "weeks"], MONTHLY: ["monthly", "months"], YEARLY: ["yearly", "years"],
};

/** Plain words for an RRULE, e.g. "FREQ=WEEKLY;BYDAY=MO" -> "weekly on Monday". */
export function describeRrule(rrule: string): string {
  const parts = new Map<string, string>();
  for (const p of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = p.split("=");
    if (k && v) parts.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const freq = FREQ[parts.get("FREQ") ?? ""];
  if (!freq) return `on the schedule ${rrule}`;
  const interval = Number(parts.get("INTERVAL") ?? "1");
  let s = interval > 1 ? `every ${interval} ${freq[1]}` : freq[0];
  const byDay = parts.get("BYDAY");
  if (byDay) {
    const days = byDay.split(",").map((d) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d);
      if (!m) return d;
      return m[1] ? `${ordinal(Number(m[1]))} ${DAY[m[2]] ?? m[2]}` : DAY[m[2]] ?? m[2];
    });
    s += ` on ${days.join(", ")}`;
  }
  const byMonthDay = parts.get("BYMONTHDAY");
  if (byMonthDay) s += ` on day ${byMonthDay.split(",").join(", ")}`;
  return s;
}

function ordinal(n: number): string {
  if (n === -1) return "last";
  const abs = Math.abs(n);
  const suf = abs % 100 >= 11 && abs % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[abs % 10] ?? "th";
  return `${n < 0 ? "-" : ""}${abs}${suf}`;
}

function nextOccurrence(occurrences: string[], now?: string): string | null {
  if (!occurrences.length) return null;
  const sorted = [...occurrences].sort();
  if (!now) return sorted[0];
  const t = Date.parse(now);
  return sorted.find((o) => Date.parse(o) >= t) ?? null;
}

/** YYYY-MM-DD for ISO or compact iCalendar dates; null for anything ambiguous (e.g. 01/02/2026). */
function isoDate(x: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(x);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})(?:T\d{4,6}Z?)?$/.exec(x);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
}

function dateForms(raw: string): string[] {
  const d = isoDate(raw);
  return d ? [raw, d, d.replace(/-/g, "")] : [raw];
}

function str(x: unknown): string | null {
  if (typeof x === "number") return String(x);
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

function list(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(str).filter((s): s is string => s !== null);
  const s = str(x);
  return s ? s.split(/[,;|]/).map((p) => p.trim()).filter(Boolean) : [];
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loosePattern(s: string): string {
  return s.trim().split(/\s+/).map(escapeRe).join("\\s+");
}

function headBoundary(v: string): string {
  return /^[A-Za-z0-9]/.test(v) ? "(?<![A-Za-z0-9])" : "";
}

function tailBoundary(v: string): string {
  return /[A-Za-z0-9]$/.test(v) ? "(?![A-Za-z0-9])" : "";
}
