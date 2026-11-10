// ICS calendar: one `event` segment per VEVENT (one per series, not per occurrence).
// RRULE recurrences are expanded for 12 months from the anchor date (default 2026-11-11) into
// meta.occurrences (ISO list, capped at 60).
import ICAL from "ical.js";
import type { AdapterResult } from "@/lib/types";
import { istWallClock, toIstIso } from "../ids";
import { basename, ResultBuilder, stripBom, type AdapterContext, type SourceFile } from "./common";

export const DEFAULT_ANCHOR = "2026-11-11";
const MAX_OCCURRENCES = 60;

type ITime = InstanceType<typeof ICAL.Time>;
type IComponent = InstanceType<typeof ICAL.Component>;

function icalToIso(t: ITime | null | undefined): string | null {
  if (!t) return null;
  if (t.isDate) return istWallClock(t.year, t.month, t.day);
  const tzid = t.zone?.tzid;
  if (tzid === "UTC" || tzid === "Z") return toIstIso(t.toUnixTime() * 1000);
  if (!tzid || tzid === "floating" || /kolkata|calcutta/i.test(tzid)) {
    return istWallClock(t.year, t.month, t.day, t.hour, t.minute, t.second);
  }
  return toIstIso(t.toUnixTime() * 1000);
}

function human(iso: string | null, isDate: boolean): string {
  if (!iso) return "unknown";
  return isDate ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} IST`;
}

const DAY_NAMES: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const UNIT: Record<string, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year", HOURLY: "hour", MINUTELY: "minute" };

function listJoin(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Plain-English text for an RRULE string, e.g. "every 2 weeks on Monday until 2027-05-01". */
export function rruleText(rrule: string, startIso: string | null): string {
  const parts = new Map<string, string>();
  for (const kv of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = kv.split("=");
    if (k && v !== undefined) parts.set(k.toUpperCase(), v);
  }
  const freq = parts.get("FREQ") ?? "";
  const unit = UNIT[freq] ?? freq.toLowerCase();
  const interval = Number(parts.get("INTERVAL") ?? "1") || 1;
  let s = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  const byday = parts.get("BYDAY");
  if (byday) {
    const days = byday.split(",").map((d) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d);
      if (!m) return d;
      const name = DAY_NAMES[m[2]] ?? m[2];
      if (!m[1]) return name;
      const n = +m[1];
      const ord = n === -1 ? "last" : n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : n === 4 ? "fourth" : `${n}th`;
      return `the ${ord} ${name}`;
    });
    s += ` on ${listJoin(days)}`;
  }
  const bymd = parts.get("BYMONTHDAY");
  if (bymd) s += ` on day ${listJoin(bymd.split(","))}`;
  const bymonth = parts.get("BYMONTH");
  if (bymonth) s += ` in ${listJoin(bymonth.split(",").map((m) => MONTHS[+m - 1] ?? m))}`;
  if (freq === "YEARLY" && !bymonth && !bymd && startIso) {
    s += ` on ${+startIso.slice(8, 10)} ${MONTHS[+startIso.slice(5, 7) - 1]}`;
  }
  const until = parts.get("UNTIL");
  if (until) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(until);
    s += m ? ` until ${m[1]}-${m[2]}-${m[3]}` : ` until ${until}`;
  }
  const count = parts.get("COUNT");
  if (count) s += `, ${count} times`;
  return s;
}

function personFromProp(b: ResultBuilder, ctx: AdapterContext, comp: IComponent, name: string) {
  const props = comp.getAllProperties(name);
  return props.map((p) => {
    const v = String(p.getFirstValue() ?? "");
    const email = v.replace(/^mailto:/i, "").trim();
    const cn = p.getParameter("cn");
    const display = typeof cn === "string" && cn ? cn : email || "unknown";
    const person = ctx.people.resolve({ displayName: b.mask(display), email: email.includes("@") ? email : null, scope: ctx.sourceId });
    b.touch(person.id);
    return person;
  });
}

export function parseIcs(files: SourceFile[], ctx: AdapterContext): AdapterResult {
  const b = new ResultBuilder(ctx, "ics");
  const anchorDate = (ctx.now ?? DEFAULT_ANCHOR).slice(0, 10);
  const anchorIso = `${anchorDate}T00:00:00+05:30`;
  const endIso = `${String(+anchorDate.slice(0, 4) + 1)}${anchorDate.slice(4)}T00:00:00+05:30`;

  for (const file of files) {
    if (!/\.(ics|ical|ifb)$/i.test(file.path) && files.length > 1) continue;
    let cal: IComponent;
    try {
      cal = new ICAL.Component(ICAL.parse(stripBom(file.content)));
    } catch (e) {
      b.reject(0, file.path, `not a valid iCalendar file: ${(e as Error).message}`);
      continue;
    }
    for (const tz of cal.getAllSubcomponents("vtimezone")) {
      try {
        ICAL.TimezoneService.register(tz);
      } catch {
        /* ignore a broken VTIMEZONE: times fall back to IST wall clock */
      }
    }
    const calName = cal.getFirstPropertyValue("x-wr-calname");
    const thread = typeof calName === "string" && calName ? calName : basename(file.path).replace(/\.ics$/i, "");

    cal.getAllSubcomponents("vevent").forEach((vevent, i) => {
      const line = i + 1;
      let ev: InstanceType<typeof ICAL.Event>;
      try {
        ev = new ICAL.Event(vevent);
      } catch (e) {
        return b.reject(line, `VEVENT #${line}`, `unreadable VEVENT: ${(e as Error).message}`);
      }
      const summary = ev.summary ?? "";
      const start = icalToIso(ev.startDate);
      if (!start) return b.reject(line, `VEVENT #${line} ${summary}`, "VEVENT has no valid DTSTART");
      const isDate = !!ev.startDate?.isDate;
      const end = icalToIso(ev.endDate);
      const rruleVal = vevent.getFirstPropertyValue("rrule");
      const rrule = rruleVal ? String(rruleVal.toString()) : null;
      const repeats = rrule ? rruleText(rrule, start) : "no";

      const occurrences: string[] = [];
      if (rrule) {
        try {
          const it = ev.iterator();
          for (let guard = 0; guard < 5000; guard++) {
            const next = it.next();
            if (!next) break;
            const iso = icalToIso(next);
            if (!iso) continue;
            if (iso >= endIso) break;
            if (iso >= anchorIso) occurrences.push(iso);
            if (occurrences.length >= MAX_OCCURRENCES) break;
          }
        } catch (e) {
          b.reject(line, `VEVENT #${line} ${summary}`, `RRULE could not be expanded: ${(e as Error).message}`);
        }
      }

      const organizers = personFromProp(b, ctx, vevent, "organizer");
      const attendees = personFromProp(b, ctx, vevent, "attendee");
      const location = ev.location ?? "";
      const description = (ev.description ?? "").trim();
      const text =
        `Event: ${summary || "(untitled)"} | when: ${human(start, isDate)} | where: ${location || "not set"} | repeats: ${repeats}` +
        (description ? ` | ${description}` : "");

      const lastMod = vevent.getFirstPropertyValue("last-modified") ?? vevent.getFirstPropertyValue("created");
      const recordTs = lastMod && typeof lastMod === "object" ? icalToIso(lastMod as ITime) : null;

      b.add({
        kind: "event",
        ts: recordTs ?? start,
        thread,
        rawText: text,
        authorId: organizers[0]?.id ?? null,
        meta: {
          uid: ev.uid ?? null,
          summary: b.maskSilent(summary),
          start,
          end,
          allDay: isDate,
          location: location ? b.maskSilent(location) : null,
          rrule,
          repeats,
          recurring: !!rrule,
          occurrences,
          organizerId: organizers[0]?.id ?? null,
          attendeeIds: attendees.map((p) => p.id),
          calendar: thread,
        },
      });
    });
  }
  return b.result();
}
