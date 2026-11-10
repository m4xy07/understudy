// Leaver footprint (pure): candidate off-board duties with the rule that fired.
// ARCHITECTURE section 4, "Test and Ask": same action 3+ times over 2+ distinct weeks; 80%+ of
// changes to a path or messages about an entity in 6 months; sole contact with an external
// person; schedules (calendar, cron, CI, yearly renewals); credential names.
import type { Person, Segment } from "@/lib/types";

export interface FootprintEntity {
  key: string;
  label: string;
  aliases: string[];
}

export interface FootprintThresholds {
  repeatMin: number;
  distinctWeeksMin: number;
  ownershipShare: number;
  windowMonths: number;
}

export type FootprintRule = "repeat" | "ownership" | "sole_contact" | "schedule" | "credential";

export interface FootprintCandidate {
  entityKey: string;
  rule: FootprintRule;
  evidenceSegmentIds: string[];
  detail: string;
}

const RULE_ORDER: FootprintRule[] = ["repeat", "ownership", "sole_contact", "schedule", "credential"];
const MAX_EVIDENCE = 20;

/** lowercase NFKC, every non-alphanumeric run -> one space, padded with spaces. */
function simple(s: string): string {
  return ` ${s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function aliasHit(textSimple: string, alias: string): boolean {
  const a = simple(alias).trim();
  if (!a) return false;
  // long aliases match as word prefixes (deploy -> deployed); short ones need whole words
  return a.length >= 4 ? textSimple.includes(` ${a}`) : textSimple.includes(` ${a} `);
}

function entityTerms(e: FootprintEntity): string[] {
  return [...new Set([...e.aliases, e.key.replace(/[-_]/g, " ")])].filter((x) => x.trim().length >= 2);
}

export function matchEntities(text: string, entities: FootprintEntity[]): FootprintEntity[] {
  const t = simple(text);
  return entities.filter((e) => entityTerms(e).some((a) => aliasHit(t, a)));
}

function bestEntity(texts: string[], entities: FootprintEntity[]): FootprintEntity | null {
  const counts = new Map<string, number>();
  for (const tx of texts) for (const e of matchEntities(tx, entities)) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  let best: FootprintEntity | null = null;
  let n = 0;
  for (const e of entities) {
    const c = counts.get(e.key) ?? 0;
    if (c > n) {
      best = e;
      n = c;
    }
  }
  return best;
}

/** ISO week ("2026-W33") of an ISO timestamp, computed on the IST calendar. */
export function isoWeek(ts: string): string {
  const d = new Date(Date.parse(ts) + 330 * 60_000);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function segSearchText(s: Segment): string {
  const files = Array.isArray(s.meta.files) ? (s.meta.files as string[]).join(" ") : "";
  return `${s.text} ${files}`;
}

function pathPrefix(path: string): string | null {
  const parts = path.split("/");
  if (parts.length < 2) return null;
  if (parts[0] === ".github" && parts.length >= 3) return `${parts[0]}/${parts[1]}/`;
  return `${parts[0]}/`;
}

export function computeFootprint(
  segments: Segment[],
  people: Person[],
  leaverPersonId: string | string[],
  thresholds: FootprintThresholds,
  entities: FootprintEntity[],
  opts: { now?: string } = {},
): FootprintCandidate[] {
  const leaver = new Set(Array.isArray(leaverPersonId) ? leaverPersonId : [leaverPersonId]);
  const byId = new Map(segments.map((s) => [s.id, s]));
  const personById = new Map(people.map((p) => [p.id, p]));
  const isLeaverSeg = (s: Segment) =>
    (s.authorId !== null && leaver.has(s.authorId)) ||
    (s.kind === "task" && typeof s.meta.ownerId === "string" && leaver.has(s.meta.ownerId));

  // default "now" = newest recorded activity; calendar events can be future-dated
  const recorded = segments.filter((s) => s.kind !== "event" && s.kind !== "file").map((s) => Date.parse(s.ts)).filter(Number.isFinite);
  const nowMs = opts.now ? Date.parse(opts.now) : Math.max(0, ...recorded);
  const start = new Date(nowMs);
  start.setUTCMonth(start.getUTCMonth() - thresholds.windowMonths);
  const inWindow = (s: Segment) => {
    const t = Date.parse(s.ts);
    return t >= start.getTime() && t <= nowMs;
  };

  const out = new Map<string, FootprintCandidate>();
  const emit = (entityKey: string, rule: FootprintRule, evidence: Segment[], detail: string) => {
    const k = `${entityKey}|${rule}`;
    const prev = out.get(k);
    const ids = [...(prev?.evidenceSegmentIds ?? []), ...evidence.map((s) => s.id)];
    const uniq = [...new Set(ids)]
      .map((id) => byId.get(id))
      .filter((s): s is Segment => !!s)
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
      .slice(0, MAX_EVIDENCE)
      .map((s) => s.id);
    out.set(k, { entityKey, rule, evidenceSegmentIds: uniq, detail: prev ? `${prev.detail}; ${detail}` : detail });
  };

  // (a) same action 3+ times over 2+ distinct ISO weeks
  const authored = segments.filter((s) => s.authorId !== null && leaver.has(s.authorId) && (s.kind === "message" || s.kind === "commit"));
  for (const e of entities) {
    const hits = authored.filter((s) => matchEntities(segSearchText(s), [e]).length > 0);
    const weeks = [...new Set(hits.map((s) => isoWeek(s.ts)))].sort();
    if (hits.length >= thresholds.repeatMin && weeks.length >= thresholds.distinctWeeksMin) {
      emit(e.key, "repeat", hits, `leaver acted on "${e.label}" ${hits.length} times across ${weeks.length} distinct weeks (${weeks.join(", ")})`);
    }
  }

  // (b1) ownership of a path prefix by commits in the window
  const commits = segments.filter((s) => s.kind === "commit" && inWindow(s));
  const byPrefix = new Map<string, { all: Segment[]; mine: Segment[] }>();
  for (const c of commits) {
    const prefixes = new Set(((c.meta.files as string[] | undefined) ?? []).map(pathPrefix).filter((p): p is string => !!p));
    for (const p of prefixes) {
      const slot = byPrefix.get(p) ?? { all: [], mine: [] };
      slot.all.push(c);
      if (c.authorId && leaver.has(c.authorId)) slot.mine.push(c);
      byPrefix.set(p, slot);
    }
  }
  for (const [prefix, { all, mine }] of [...byPrefix].sort((a, b) => a[0].localeCompare(b[0]))) {
    const share = mine.length / all.length;
    if (mine.length >= 2 && share >= thresholds.ownershipShare) {
      const ent = matchEntities(prefix, entities)[0] ?? bestEntity(mine.map(segSearchText), entities);
      emit(
        ent?.key ?? `path:${prefix}`,
        "ownership",
        mine,
        `leaver authored ${mine.length} of ${all.length} commits touching ${prefix} (${Math.round(share * 100)}%) in ${thresholds.windowMonths} months`,
      );
    }
  }

  // (b2) ownership of the conversation about an entity in the window
  const messages = segments.filter((s) => s.kind === "message" && inWindow(s));
  for (const e of entities) {
    const about = messages.filter((s) => matchEntities(s.text, [e]).length > 0);
    const mine = about.filter((s) => s.authorId !== null && leaver.has(s.authorId));
    if (about.length >= thresholds.repeatMin && mine.length / about.length >= thresholds.ownershipShare) {
      emit(e.key, "ownership", mine, `leaver wrote ${mine.length} of ${about.length} messages about "${e.label}" (${Math.round((mine.length / about.length) * 100)}%) in ${thresholds.windowMonths} months`);
    }
  }

  // (c1) people who only talk with the leaver (replies to the leaver, or 1:1 threads)
  const msgAll = segments.filter((s) => s.kind === "message");
  const participants = new Map<string, Set<string>>();
  for (const s of msgAll) {
    if (!s.authorId) continue;
    const set = participants.get(s.thread) ?? new Set<string>();
    set.add(s.authorId);
    participants.set(s.thread, set);
  }
  const authors = [...new Set(msgAll.map((s) => s.authorId).filter((a): a is string => !!a && !leaver.has(a)))];
  for (const x of authors) {
    const mine = msgAll.filter((s) => s.authorId === x);
    const viaLeaverOnly = mine.every((s) => {
      const parent = typeof s.meta.replyTo === "string" ? byId.get(s.meta.replyTo) : undefined;
      if (parent?.authorId && leaver.has(parent.authorId)) return true;
      const ps = participants.get(s.thread) ?? new Set();
      return [...ps].every((p) => p === x || leaver.has(p)) && [...ps].some((p) => leaver.has(p));
    });
    if (!mine.length || !viaLeaverOnly) continue;
    const threads = [...new Set(mine.map((s) => s.thread))];
    const leaverSide = msgAll.filter((s) => threads.includes(s.thread) && s.authorId !== null && leaver.has(s.authorId));
    const ent = bestEntity(mine.map((s) => s.text), entities) ?? bestEntity(leaverSide.map((s) => s.text), entities);
    const name = personById.get(x)?.displayName ?? x;
    emit(ent?.key ?? `person:${x}`, "sole_contact", [...mine, ...leaverSide], `${name} only talks with the leaver (${mine.length} messages in ${threads.join(", ")})`);
  }

  // (c2) contact tokens only ever mentioned by the leaver
  const authorsAll = new Set(segments.map((s) => s.authorId).filter((a): a is string => !!a));
  const mentions = new Map<string, Segment[]>();
  for (const s of segments) {
    for (const m of s.text.matchAll(/\[CONTACT:([pc]-\d+)\]/g)) {
      const list = mentions.get(m[1]) ?? [];
      if (!list.includes(s)) list.push(s);
      mentions.set(m[1], list);
    }
  }
  for (const [token, segs] of [...mentions].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (leaver.has(token)) continue;
    if (token.startsWith("p-") && authorsAll.has(token)) continue; // an internal person who writes
    if (!segs.every(isLeaverSeg)) continue;
    const ent = bestEntity(segs.map((s) => s.text), entities);
    emit(ent?.key ?? `contact:${token}`, "sole_contact", segs, `contact [CONTACT:${token}] is mentioned only by the leaver (${segs.length} times)`);
  }

  // (d) schedules: recurring calendar events, cron in workflow files, yearly renewals
  const leaverNames = people
    .filter((p) => leaver.has(p.id))
    .flatMap((p) => [p.displayName, ...p.aliases])
    .map((n) => simple(n).trim())
    .filter((n) => n.length >= 3);
  const mentionsLeaver = (text: string) => {
    const t = simple(text);
    return leaverNames.some((n) => t.includes(` ${n} `));
  };
  for (const s of segments.filter((x) => x.kind === "event" && x.meta.recurring)) {
    const attendees = (s.meta.attendeeIds as string[] | undefined) ?? [];
    const linked = isLeaverSeg(s) || attendees.some((a) => leaver.has(a)) || mentionsLeaver(s.text);
    if (!linked) continue;
    const ent = matchEntities(s.text, entities)[0];
    emit(ent?.key ?? `schedule:${String(s.meta.summary ?? s.thread)}`, "schedule", [s], `recurring calendar event "${String(s.meta.summary ?? "")}" (${String(s.meta.repeats ?? "")})`);
  }
  const leaverTouched = new Set<string>();
  for (const c of segments.filter((s) => s.kind === "commit" && s.authorId && leaver.has(s.authorId))) {
    for (const f of (c.meta.files as string[] | undefined) ?? []) leaverTouched.add(f);
  }
  for (const s of segments.filter((x) => x.kind === "file")) {
    const cron = /\bcron\s*:\s*["']?([^"'\n]+)/.exec(s.text);
    if (!cron) continue;
    const path = String(s.meta.path ?? s.thread);
    if (!(leaverTouched.has(path) || isLeaverSeg(s))) continue;
    const ent = matchEntities(`${path} ${s.text}`, entities)[0];
    emit(ent?.key ?? `schedule:${path}`, "schedule", [s], `scheduled job in ${path} (cron ${cron[1].trim()})`);
  }
  for (const s of segments) {
    if (!/\b(renew\w*|expir\w*)\b/i.test(s.text)) continue;
    const yearly = /\b(year|yearly|annual\w*|every year|per year|12 months)\b/i.test(s.text) || /FREQ=YEARLY/i.test(String(s.meta.rrule ?? ""));
    const linked = isLeaverSeg(s) || (s.kind === "event" && mentionsLeaver(s.text));
    if (!linked || !(yearly || s.kind === "task" || s.kind === "event")) continue;
    const ent = matchEntities(s.text, entities)[0];
    emit(ent?.key ?? `schedule:${s.thread}`, "schedule", [s], `renewal mentioned by the leaver${yearly ? " (yearly)" : ""}`);
  }

  // (e) credential names (never values) mentioned by the leaver
  const CRED = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|KEY|PASSWORD|PASS|PWD|SECRET|PAT|CREDENTIALS?)\b/g;
  const credSegs = new Map<string, Segment[]>();
  for (const s of segments) {
    if (!isLeaverSeg(s)) continue;
    const names = new Set<string>([...s.text.matchAll(CRED)].map((m) => m[0]));
    for (const m of s.text.matchAll(/secrets\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
    for (const n of names) {
      const list = credSegs.get(n) ?? [];
      list.push(s);
      credSegs.set(n, list);
    }
  }
  for (const [name, segs] of [...credSegs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ent = matchEntities(name, entities)[0] ?? bestEntity(segs.map((s) => s.text), entities);
    emit(ent?.key ?? `credential:${name}`, "credential", segs, `credential name ${name} mentioned by the leaver (${segs.length} segments)`);
  }

  return [...out.values()].sort(
    (a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) || a.entityKey.localeCompare(b.entityKey),
  );
}
