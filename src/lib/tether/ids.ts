import type { SourceKind } from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";

/**
 * Segment ID = "seg_" + first 16 hex of
 * sha256(`${sourceKind}|${isoTs}|${thread}|${position}|${sha256Hex(norm(text))}`).
 * Never built from a display name. `text` is the masked segment text.
 */
export function segmentId(
  sourceKind: SourceKind,
  isoTs: string,
  thread: string,
  position: number,
  text: string,
): string {
  const h = sha256Hex(`${sourceKind}|${isoTs}|${thread}|${position}|${sha256Hex(norm(text))}`);
  return "seg_" + h.slice(0, 16);
}

export function textHash(text: string): string {
  return sha256Hex(norm(text));
}

const IST_OFFSET_MIN = 330;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Format an instant as ISO 8601 in +05:30 (the demo setting is in Pune). */
export function toIstIso(d: Date | number): string {
  const ms = typeof d === "number" ? d : d.getTime();
  const t = new Date(ms + IST_OFFSET_MIN * 60_000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+05:30`
  );
}

/** Wall-clock fields interpreted as IST, returned as ISO in +05:30. Validates the date. */
export function istWallClock(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+05:30`;
}

/**
 * Parse common date strings to ISO +05:30. Accepts ISO with or without time/offset,
 * YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY. Date-only values are midnight IST. Null when invalid.
 */
export function parseDateLoose(raw: unknown): string | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // YAML date-only values arrive as UTC midnight: keep the calendar date.
    if (raw.getUTCHours() === 0 && raw.getUTCMinutes() === 0 && raw.getUTCSeconds() === 0) {
      return istWallClock(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
    }
    return toIstIso(raw);
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return toIstIso(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return istWallClock(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return istWallClock(+m[3], +m[2], +m[1]);
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s);
  if (m) return istWallClock(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : toIstIso(d);
  }
  return null;
}

/** Assigns `position` = order among segments sharing (thread, ts): ties only. */
export class PositionCounter {
  private seen = new Map<string, number>();
  next(thread: string, ts: string): number {
    const k = `${thread}\u0000${ts}`;
    const n = this.seen.get(k) ?? 0;
    this.seen.set(k, n + 1);
    return n;
  }
}
