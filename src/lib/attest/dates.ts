// Date normalisation for deadline values: "19 Dec", "December 19, 2026", "19/12/2026" -> "2026-12-19".
// Pure. Only a value that IS one date is rewritten; cadences ("every Saturday", "once per term")
// and anything ambiguous are left as written. The quote and statement are never changed.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const CADENCE = /\b(every|each|once|weekly|monthly|yearly|annually|daily|per|repeats?|weekdays?|weekends?)\b/i;
const WEEKDAY = "(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\\s+)?";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function valid(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * The year for a day and month written without one: the reference year, or the next year
 * when that date would fall more than ~2 months before the reference time.
 */
function inferYear(m: number, d: number, refIso: string | null): number | null {
  const ref = refIso ? new Date(refIso) : null;
  if (!ref || Number.isNaN(ref.getTime())) return null;
  const y = ref.getUTCFullYear();
  const cand = Date.UTC(y, m - 1, d);
  return cand < ref.getTime() - 60 * 86_400_000 ? y + 1 : y;
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
}

/** ISO date (YYYY-MM-DD) when `value` is exactly one calendar date, else null. */
export function toIsoDate(value: string, refIso: string | null = null): string | null {
  const v = value.trim().replace(/\s+/g, " ");
  if (!v || CADENCE.test(v)) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (m) return valid(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : null;

  // 19 Dec 2026 / 19th December, 2026 / Sat 19 Dec
  m = new RegExp(`^${WEEKDAY}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?(?:\\s+(\\d{4}))?$`, "i").exec(v);
  if (m) {
    const d = +m[1];
    const mo = monthIndex(m[2]);
    const y = m[3] ? +m[3] : inferYear(mo, d, refIso);
    return y && valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }

  // December 19, 2026 / Dec 19
  m = new RegExp(`^${WEEKDAY}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?$`, "i").exec(v);
  if (m) {
    const mo = monthIndex(m[1]);
    const d = +m[2];
    const y = m[3] ? +m[3] : inferYear(mo, d, refIso);
    return y && valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }

  // 19/12/2026 or 19.12.26 (day first, as in the club's Indian locale)
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(v);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, +m[2], +m[1]) ? `${y}-${pad(+m[2])}-${pad(+m[1])}` : null;
  }
  return null;
}

const DATE_IN_TEXT = new RegExp(
  [
    "\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b",
    `\\b${WEEKDAY}\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+\\d{4})?`,
    `\\b${WEEKDAY}${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`,
    "\\b\\d{1,2}[/.]\\d{1,2}[/.](?:\\d{4}|\\d{2})\\b",
  ].join("|"),
  "gi",
);

/** Every calendar date written in `text` (ISO, "8 Nov", "Nov 8, 2026", "08/11/26"), as YYYY-MM-DD. */
export function datesInText(text: string, refIso: string | null = null): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(DATE_IN_TEXT)) {
    const iso = toIsoDate(m[0].replace(/\s+/g, " ").trim(), refIso);
    if (iso) out.add(iso);
  }
  return out;
}

/** Words that date an event relative to when the message was written. */
const RELATIVE_DAY = /\b(today|tonight|this (?:morning|afternoon|evening)|now|tomorrow|yesterday)\b/i;

/** The UTC calendar date of a timestamp (as the extraction prompt shows it), or null. */
export function writtenDate(ts: string): string | null {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * True when a deadline `value` is only the day its sources were written: every cited text was
 * written on that date and none of them states it (no written date, no "today"/"tomorrow").
 * A commit titled "show the event date on the homepage" made on some day says nothing about the
 * event happening that day.
 */
export function isWrittenDateDeadline(value: string, cited: { ts: string; text: string; quote?: string | null }[]): boolean {
  if (!cited.length) return false;
  const iso = toIsoDate(value);
  if (!iso) return false;
  for (const c of cited) {
    if (writtenDate(c.ts) !== iso) return false;
    const texts = [c.text, c.quote ?? ""];
    if (texts.some((t) => RELATIVE_DAY.test(t) || datesInText(t, c.ts).has(iso))) return false;
  }
  return true;
}
