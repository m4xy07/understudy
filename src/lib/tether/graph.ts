// Collaboration graph (pure): who worked next to whom, from metadata only.
// Contract: docs/ARCHITECTURE.md section 4, "Recovery".
//
// The functions here take GraphSegment, a type with no text field. Which segments are "about" an
// entity is not decided here: it is passed in as sets of segment ids, built from the citations of
// claims Attest extracted earlier. So this module never reads message text, commit messages, file
// contents or event titles.
import type { Claim, RoleKey, Segment, SegmentKind, SourceKind } from "@/lib/types";

/** The only meta keys the graph may see. Everything else (summary, title, section, text) is dropped. */
export interface GraphMeta {
  replyTo?: string;
  files?: string[];
  path?: string;
  attendeeIds?: string[];
  organizerId?: string;
  ownerId?: string;
  recurring?: boolean;
}

export interface GraphSegment {
  id: string;
  sourceKind: SourceKind;
  kind: SegmentKind;
  ts: string;
  authorId: string | null;
  thread: string;
  position: number;
  roleSet: RoleKey[];
  meta: GraphMeta;
}

export type EdgeType = "reply" | "same_thread" | "co_change" | "shared_event";

export interface GraphEdge {
  a: string;
  b: string;
  type: EdgeType;
  count: number;
  weight: number;
  lastTs: string;
  /** Up to 50 contributing segment ids, so a role set can be computed for anything derived from the edge. */
  segmentIds: string[];
}

/** One interaction between two people. `segA` is authored by (or involves) `a`, `segB` by `b`. */
export interface EdgeInstance {
  type: EdgeType;
  a: string;
  b: string;
  segA: string;
  segB: string;
  ts: string;
  base: number;
}

export interface CollabGraph {
  nodes: string[];
  edges: GraphEdge[];
  instances: EdgeInstance[];
  byId: Map<string, GraphSegment>;
  /** person record id -> node id (several records of one role holder share a node). */
  canon: Map<string, string>;
  now: string;
}

export interface NeighbourCounts {
  wrote: number;
  replied: number;
  near: number;
  files: number;
  events: number;
}

export interface NeighbourScore {
  personId: string;
  score: number;
  counts: NeighbourCounts;
  segmentIds: string[];
  /** Intersection of the contributing segments' role sets. */
  roleSet: RoleKey[];
}

export const EDGE_BASE: Record<EdgeType, number> = { reply: 3, same_thread: 1, co_change: 2, shared_event: 2 };
export const SAME_THREAD_MINUTES = 30;
export const RECENCY_HALF_LIFE_DAYS = 90;
export const MIN_NEIGHBOUR_SCORE = 1;
const MAX_EDGE_SEGMENTS = 50;
const DAY_MS = 86_400_000;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Copy exactly the allowed fields. The text column and every other meta key never enter the graph. */
export function toGraphSegment(s: Pick<Segment, "id" | "sourceKind" | "kind" | "ts" | "authorId" | "thread" | "roleSet"> & {
  position?: number;
  meta?: Record<string, unknown> | null;
}): GraphSegment {
  const m = s.meta ?? {};
  const meta: GraphMeta = {};
  if (typeof m.replyTo === "string") meta.replyTo = m.replyTo;
  if (Array.isArray(m.files)) meta.files = strings(m.files);
  if (typeof m.path === "string") meta.path = m.path;
  if (Array.isArray(m.attendeeIds)) meta.attendeeIds = strings(m.attendeeIds);
  if (typeof m.organizerId === "string") meta.organizerId = m.organizerId;
  if (typeof m.ownerId === "string") meta.ownerId = m.ownerId;
  if (typeof m.recurring === "boolean") meta.recurring = m.recurring;
  return {
    id: s.id,
    sourceKind: s.sourceKind,
    kind: s.kind,
    ts: s.ts,
    authorId: s.authorId ?? null,
    thread: s.thread,
    position: typeof s.position === "number" ? s.position : 0,
    roleSet: [...s.roleSet],
    meta,
  };
}

function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** r(ts) = max(0.1, 0.5 ^ (ageDays / 90)). An interaction 90 days old counts half of one today. */
export function recency(ts: string, now: string): number {
  const ageDays = Math.max(0, (timeOf(now) - timeOf(ts)) / DAY_MS);
  return Math.max(0.1, Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS));
}

function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function buildGraph(
  segments: readonly GraphSegment[],
  opts: { now: string; windowMonths: number; canon?: Map<string, string> },
): CollabGraph {
  const canon = opts.canon ?? new Map<string, string>();
  const node = (id: string | null | undefined): string | null => (id ? canon.get(id) ?? id : null);
  const byId = new Map(segments.map((s) => [s.id, s]));
  const instances: EdgeInstance[] = [];
  const nodes = new Set<string>();
  for (const s of segments) {
    const n = node(s.authorId);
    if (n) nodes.add(n);
  }

  // reply: a segment with meta.replyTo whose author differs from the parent's author
  const replyPairs = new Set<string>();
  for (const s of segments) {
    if (!s.meta.replyTo) continue;
    const parent = byId.get(s.meta.replyTo);
    if (!parent) continue;
    replyPairs.add(`${s.id}|${parent.id}`);
    const a = node(s.authorId);
    const b = node(parent.authorId);
    if (!a || !b || a === b) continue;
    instances.push({ type: "reply", a, b, segA: s.id, segB: parent.id, ts: s.ts, base: EDGE_BASE.reply });
  }

  // same_thread: consecutive messages in one thread, different authors, at most 30 minutes apart
  const threads = new Map<string, GraphSegment[]>();
  for (const s of segments) {
    if (s.kind !== "message") continue;
    const k = `${s.sourceKind}|${s.thread}`;
    const list = threads.get(k) ?? [];
    list.push(s);
    threads.set(k, list);
  }
  for (const list of threads.values()) {
    list.sort((x, y) => timeOf(x.ts) - timeOf(y.ts) || x.position - y.position || (x.id < y.id ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const a = node(cur.authorId);
      const b = node(prev.authorId);
      if (!a || !b || a === b) continue;
      if (timeOf(cur.ts) - timeOf(prev.ts) > SAME_THREAD_MINUTES * 60_000) continue;
      if (replyPairs.has(`${cur.id}|${prev.id}`) || replyPairs.has(`${prev.id}|${cur.id}`)) continue;
      instances.push({ type: "same_thread", a, b, segA: cur.id, segB: prev.id, ts: cur.ts, base: EDGE_BASE.same_thread });
    }
  }

  // co_change: two authors each changed the same path inside the window; once per author pair per path
  const windowStart = new Date(timeOf(opts.now));
  windowStart.setMonth(windowStart.getMonth() - opts.windowMonths);
  const byPath = new Map<string, Map<string, GraphSegment>>(); // path -> author node -> newest commit
  for (const s of segments) {
    if (s.kind !== "commit") continue;
    const a = node(s.authorId);
    if (!a || timeOf(s.ts) < windowStart.getTime()) continue;
    for (const p of s.meta.files ?? []) {
      const authors = byPath.get(p) ?? new Map<string, GraphSegment>();
      const prev = authors.get(a);
      if (!prev || timeOf(s.ts) > timeOf(prev.ts)) authors.set(a, s);
      byPath.set(p, authors);
    }
  }
  for (const p of [...byPath.keys()].sort()) {
    const authors = [...byPath.get(p)!.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    for (let i = 0; i < authors.length; i++) {
      for (let j = i + 1; j < authors.length; j++) {
        const [a, sa] = authors[i];
        const [b, sb] = authors[j];
        const ts = timeOf(sa.ts) < timeOf(sb.ts) ? sa.ts : sb.ts; // the latest time both had touched it
        instances.push({ type: "co_change", a, b, segA: sa.id, segB: sb.id, ts, base: EDGE_BASE.co_change });
      }
    }
  }

  // shared_event: organiser and each attendee, pairwise
  for (const s of segments) {
    if (s.kind !== "event") continue;
    const people = [...new Set([s.meta.organizerId, ...(s.meta.attendeeIds ?? [])].map((x) => node(x)).filter((x): x is string => !!x))].sort();
    for (const n of people) nodes.add(n);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        instances.push({
          type: "shared_event", a: people[i], b: people[j], segA: s.id, segB: s.id, ts: s.ts,
          base: s.meta.recurring ? 2 : 1,
        });
      }
    }
  }

  const edges = new Map<string, GraphEdge>();
  for (const inst of instances) {
    nodes.add(inst.a);
    nodes.add(inst.b);
    const [a, b] = pair(inst.a, inst.b);
    const key = `${a}|${b}|${inst.type}`;
    const e = edges.get(key) ?? { a, b, type: inst.type, count: 0, weight: 0, lastTs: inst.ts, segmentIds: [] };
    e.count += 1;
    e.weight += inst.base * recency(inst.ts, opts.now);
    if (timeOf(inst.ts) > timeOf(e.lastTs)) e.lastTs = inst.ts;
    for (const id of [inst.segA, inst.segB]) {
      if (e.segmentIds.length < MAX_EDGE_SEGMENTS && !e.segmentIds.includes(id)) e.segmentIds.push(id);
    }
    edges.set(key, e);
  }

  return {
    nodes: [...nodes].sort(),
    edges: [...edges.values()].sort((x, y) => `${x.a}|${x.b}|${x.type}`.localeCompare(`${y.a}|${y.b}|${y.type}`)),
    instances,
    byId,
    canon,
    now: opts.now,
  };
}

/**
 * entity key -> ids of the segments that concern it: the accepted citations of every claim that
 * is not dropped, plus one hop (a segment that replies to an indexed segment). No text is read.
 */
export function entitySegmentIndex(
  claims: readonly Pick<Claim, "entity" | "state" | "citations">[],
  segments: readonly GraphSegment[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of claims) {
    if (c.state === "dropped") continue;
    const set = out.get(c.entity) ?? new Set<string>();
    for (const cit of c.citations) if (cit.accepted !== false) set.add(cit.segmentId);
    out.set(c.entity, set);
  }
  for (const set of out.values()) {
    const direct = new Set(set);
    for (const s of segments) if (s.meta.replyTo && direct.has(s.meta.replyTo)) set.add(s.id);
  }
  return out;
}

function intersect(sets: RoleKey[][]): RoleKey[] {
  if (sets.length === 0) return [];
  return sets[0].filter((r) => sets.every((s) => s.includes(r)));
}

/**
 * Score every person who is not the leaver against a set of segments (one gap's topic).
 * score = wrote + replied + near + files + events + tie; people under 1 are left out.
 */
export function neighbourScores(
  graph: CollabGraph,
  segmentIds: ReadonlySet<string>,
  opts: { leaverIds: readonly string[]; now?: string },
): NeighbourScore[] {
  const now = opts.now ?? graph.now;
  const node = (id: string | null | undefined): string | null => (id ? graph.canon.get(id) ?? id : null);
  const leaver = new Set(opts.leaverIds.map((id) => node(id)!).filter(Boolean));
  const r = (ts: string) => recency(ts, now);

  interface Acc { score: number; counts: NeighbourCounts; segs: Set<string>; paths: Set<string> }
  const acc = new Map<string, Acc>();
  const get = (p: string): Acc => {
    let a = acc.get(p);
    if (!a) {
      a = { score: 0, counts: { wrote: 0, replied: 0, near: 0, files: 0, events: 0 }, segs: new Set(), paths: new Set() };
      acc.set(p, a);
    }
    return a;
  };

  const topic = [...segmentIds].map((id) => graph.byId.get(id)).filter((s): s is GraphSegment => !!s);

  // wrote: segments on the topic authored by P
  for (const s of topic) {
    const p = node(s.authorId);
    if (!p || leaver.has(p)) continue;
    const a = get(p);
    a.score += 3 * r(s.ts);
    a.counts.wrote += 1;
    a.segs.add(s.id);
  }

  // replied / near: one end on the topic, the other authored by P
  for (const inst of graph.instances) {
    if (inst.type !== "reply" && inst.type !== "same_thread") continue;
    const ends: [string, string, string][] = [[inst.a, inst.segA, inst.segB], [inst.b, inst.segB, inst.segA]];
    for (const [p, own, other] of ends) {
      if (leaver.has(p) || !segmentIds.has(other)) continue;
      const ownSeg = graph.byId.get(own);
      if (!ownSeg) continue;
      const a = get(p);
      const base = inst.type === "reply" ? 3 : 1;
      a.score += base * r(ownSeg.ts);
      if (inst.type === "reply") a.counts.replied += 1;
      else a.counts.near += 1;
      a.segs.add(own);
      a.segs.add(other);
    }
  }

  // files: commits by P that touch a path the topic touches
  const topicPaths = new Set<string>();
  const pathSource = new Map<string, string>(); // path -> a topic segment that touches it
  for (const s of topic) {
    const paths = s.kind === "commit" ? s.meta.files ?? [] : s.kind === "file" && s.meta.path ? [s.meta.path] : [];
    for (const p of paths) {
      topicPaths.add(p);
      if (!pathSource.has(p)) pathSource.set(p, s.id);
    }
  }
  if (topicPaths.size > 0) {
    for (const s of graph.byId.values()) {
      if (s.kind !== "commit") continue;
      const p = node(s.authorId);
      if (!p || leaver.has(p)) continue;
      const shared = (s.meta.files ?? []).filter((f) => topicPaths.has(f));
      if (shared.length === 0) continue;
      const a = get(p);
      a.score += 2 * r(s.ts);
      for (const f of shared) {
        a.paths.add(f);
        a.segs.add(pathSource.get(f)!);
      }
      a.segs.add(s.id);
    }
  }

  // events: topic events where P is organiser or attendee
  for (const s of topic) {
    if (s.kind !== "event") continue;
    const people = new Set([s.meta.organizerId, ...(s.meta.attendeeIds ?? [])].map((x) => node(x)).filter((x): x is string => !!x));
    for (const p of people) {
      if (leaver.has(p)) continue;
      const a = get(p);
      a.score += 2 * r(s.ts);
      a.counts.events += 1;
      a.segs.add(s.id);
    }
  }

  // tie: how closely P worked with the leaver overall (only for people already on the topic)
  for (const [p, a] of acc) {
    a.counts.files = a.paths.size;
    if (a.score <= 0) continue;
    let w = 0;
    for (const e of graph.edges) {
      if ((e.a === p && leaver.has(e.b)) || (e.b === p && leaver.has(e.a))) w += e.weight;
    }
    a.score += Math.min(1, 0.05 * w);
  }

  const out: NeighbourScore[] = [];
  for (const [personId, a] of acc) {
    if (a.score < MIN_NEIGHBOUR_SCORE) continue;
    const ids = [...a.segs].sort();
    out.push({
      personId,
      score: Math.round(a.score * 1000) / 1000,
      counts: a.counts,
      segmentIds: ids,
      roleSet: intersect(ids.map((id) => graph.byId.get(id)?.roleSet ?? [])),
    });
  }
  return out.sort((x, y) => y.score - x.score || x.personId.localeCompare(y.personId, "en", { numeric: true }));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The reason a person was picked, from counts only. No message content, file name or event title
 * can appear here: the only words are fixed, plus the entity label from the pack.
 */
export function neighbourReason(counts: NeighbourCounts, entityLabel: string): string {
  const parts: string[] = [];
  if (counts.wrote > 0) parts.push(`wrote ${counts.wrote} of the records`);
  if (counts.replied > 0) parts.push(`replied in ${counts.replied} ${plural(counts.replied, "thread", "threads")}`);
  if (counts.near > 0) parts.push(`was in ${counts.near} of the same conversations`);
  if (counts.files > 0) parts.push(`changed ${counts.files} of the same files`);
  if (counts.events > 0) parts.push(`shared ${counts.events} calendar ${plural(counts.events, "event", "events")}`);
  if (parts.length === 0) parts.push("worked with the same people");
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
  return `${sentence} for ${entityLabel}`;
}
