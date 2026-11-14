// Collaboration graph (recovery rung 1). T-U-1 to T-U-5 of docs/round3/specs/01_recovery.md.
import { describe, expect, it } from "vitest";
import type { Segment } from "@/lib/types";
import {
  buildGraph, entitySegmentIndex, neighbourReason, neighbourScores, recency, toGraphSegment,
  type GraphSegment,
} from "@/lib/tether/graph";
import { ingestFixtures } from "./helpers";

const NOW = "2026-11-11T12:00:00+05:30";
const ALL = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
const INFRA = ["president", "tech_lead", "leaver"];

let n = 0;
function seg(over: Partial<GraphSegment> & { meta?: GraphSegment["meta"] }): GraphSegment {
  n += 1;
  return {
    id: over.id ?? `s${n}`, sourceKind: "slack", kind: "message", ts: NOW, authorId: "p-1", thread: "#infra", position: n,
    roleSet: ALL, meta: {}, ...over,
  };
}

const ALLOWED_META = ["replyTo", "files", "path", "attendeeIds", "organizerId", "ownerId", "recurring"];

describe("T-U-1: the graph is built without message text", () => {
  it("gives the same graph and scores when every text is empty and every other meta key is removed", () => {
    const out = ingestFixtures();
    const segments: Segment[] = out.sources.flatMap((s) => s.result.segments);
    expect(segments.length).toBeGreaterThan(10);
    const stripped = segments.map((s) => ({
      ...s,
      text: "",
      textHash: "",
      meta: Object.fromEntries(Object.entries(s.meta).filter(([k]) => ALLOWED_META.includes(k))),
    }));
    const opts = { now: "2026-11-11T12:00:00+05:30", windowMonths: 240 };
    const a = buildGraph(segments.map(toGraphSegment), opts);
    const b = buildGraph(stripped.map(toGraphSegment), opts);
    expect(b.edges).toEqual(a.edges);
    expect(b.instances).toEqual(a.instances);
    expect(a.edges.length).toBeGreaterThan(0);
    const topic = new Set(segments.map((s) => s.id));
    expect(neighbourScores(b, topic, { leaverIds: [] })).toEqual(neighbourScores(a, topic, { leaverIds: [] }));
  });

  it("a graph segment has no text field and keeps only the allowed meta keys", () => {
    const g = toGraphSegment({
      id: "x", sourceKind: "ics", kind: "event", ts: NOW, authorId: "p-1", thread: "cal", roleSet: ALL, position: 0,
      meta: { summary: "Secret party", description: "bring the key", organizerId: "p-2", attendeeIds: ["p-3"], recurring: true, title: "t" },
    } as never);
    expect(Object.keys(g).sort()).toEqual(["authorId", "id", "kind", "meta", "position", "roleSet", "sourceKind", "thread", "ts"]);
    expect(g.meta).toEqual({ organizerId: "p-2", attendeeIds: ["p-3"], recurring: true });
    expect(JSON.stringify(g)).not.toContain("Secret");
  });
});

describe("T-U-2: each edge type is created by its rule and by nothing else", () => {
  it("reply needs replyTo and a different author", () => {
    const parent = seg({ id: "parent", authorId: "p-1", ts: "2026-11-01T10:00:00Z" });
    const reply = seg({ id: "reply", authorId: "p-2", ts: "2026-11-03T10:00:00Z", meta: { replyTo: "parent" } });
    const self = seg({ id: "self", authorId: "p-1", ts: "2026-11-03T11:00:00Z", meta: { replyTo: "parent" } });
    const g = buildGraph([parent, reply, self], { now: NOW, windowMonths: 6 });
    expect(g.edges.filter((e) => e.type === "reply")).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ a: "p-1", b: "p-2", type: "reply", count: 1 });
  });

  it("same thread only within 30 minutes, different authors, and not for a reply pair", () => {
    const a = seg({ id: "a", authorId: "p-1", ts: "2026-11-01T10:00:00Z" });
    const b = seg({ id: "b", authorId: "p-2", ts: "2026-11-01T10:20:00Z" });
    const c = seg({ id: "c", authorId: "p-3", ts: "2026-11-01T11:30:00Z" });      // 70 minutes later: no edge
    const d = seg({ id: "d", authorId: "p-3", ts: "2026-11-01T11:35:00Z" });      // same author: no edge
    const e = seg({ id: "e", authorId: "p-1", ts: "2026-11-01T11:40:00Z", meta: { replyTo: "d" } }); // reply pair
    const other = seg({ id: "o", authorId: "p-4", ts: "2026-11-01T10:10:00Z", thread: "#events" }); // other thread
    const g = buildGraph([a, b, c, d, e, other], { now: NOW, windowMonths: 6 });
    const same = g.edges.filter((x) => x.type === "same_thread");
    expect(same.map((x) => `${x.a}-${x.b}`)).toEqual(["p-1-p-2"]);
    expect(g.edges.filter((x) => x.type === "reply").map((x) => `${x.a}-${x.b}`)).toEqual(["p-1-p-3"]);
  });

  it("co-change only inside the window, once per author pair per path", () => {
    const mk = (id: string, authorId: string, ts: string, files: string[]) =>
      seg({ id, authorId, ts, kind: "commit", sourceKind: "github", thread: "commits", meta: { files } });
    const g = buildGraph([
      mk("c1", "p-1", "2026-10-01T10:00:00Z", ["dns/zone"]),
      mk("c2", "p-2", "2026-10-02T10:00:00Z", ["dns/zone"]),
      mk("c3", "p-2", "2026-10-03T10:00:00Z", ["dns/zone"]),       // same pair, same path: still one
      mk("c4", "p-3", "2025-01-01T10:00:00Z", ["dns/zone"]),       // outside the 6 month window
      mk("c5", "p-4", "2026-10-03T10:00:00Z", ["website/a.html"]), // other path
    ], { now: NOW, windowMonths: 6 });
    const co = g.edges.filter((x) => x.type === "co_change");
    expect(co).toHaveLength(1);
    expect(co[0]).toMatchObject({ a: "p-1", b: "p-2", count: 1 });
  });

  it("a shared event links organiser and attendees pairwise; recurring counts double", () => {
    const once = seg({ id: "e1", kind: "event", sourceKind: "ics", authorId: null, meta: { organizerId: "p-1", attendeeIds: ["p-2", "p-3"] } });
    const g1 = buildGraph([once], { now: NOW, windowMonths: 6 });
    expect(g1.edges.map((x) => `${x.a}-${x.b}:${x.type}`)).toEqual(["p-1-p-2:shared_event", "p-1-p-3:shared_event", "p-2-p-3:shared_event"]);
    expect(g1.edges[0].weight).toBeCloseTo(1);
    const rec = seg({ id: "e2", kind: "event", sourceKind: "ics", authorId: null, meta: { organizerId: "p-1", attendeeIds: ["p-2"], recurring: true } });
    expect(buildGraph([rec], { now: NOW, windowMonths: 6 }).edges[0].weight).toBeCloseTo(2);
  });

  it("several records of one role holder share a node", () => {
    const parent = seg({ id: "parent", authorId: "p-1" });
    const reply = seg({ id: "reply", authorId: "p-17", meta: { replyTo: "parent" } });
    const g = buildGraph([parent, reply], { now: NOW, windowMonths: 6, canon: new Map([["p-17", "p-4"]]) });
    expect(g.edges[0]).toMatchObject({ a: "p-1", b: "p-4" });
  });
});

describe("T-U-3: recency, the leaver and the threshold", () => {
  it("an interaction 90 days old counts half of one today, never under a tenth", () => {
    expect(recency(NOW, NOW)).toBeCloseTo(1);
    expect(recency("2026-08-13T12:00:00+05:30", NOW)).toBeCloseTo(0.5);
    expect(recency("2020-01-01T00:00:00Z", NOW)).toBeCloseTo(0.1);
  });

  it("the leaver is never a neighbour and scores under 1 are left out", () => {
    const topic = seg({ id: "topic", authorId: "p-1", ts: NOW });
    const reply = seg({ id: "r1", authorId: "p-2", ts: NOW, meta: { replyTo: "topic" } });
    const old = seg({ id: "old-topic", authorId: "p-1", ts: "2025-01-01T00:00:00Z", thread: "#old" });
    const near = seg({ id: "old-near", authorId: "p-3", ts: "2025-01-01T00:05:00Z", thread: "#old" }); // 1 x 0.1
    const g = buildGraph([topic, reply, old, near], { now: NOW, windowMonths: 6 });
    const scores = neighbourScores(g, new Set(["topic", "old-topic"]), { leaverIds: ["p-1"] });
    expect(scores.map((s) => s.personId)).toEqual(["p-2"]);
    expect(scores[0].counts.replied).toBe(1);
    expect(scores[0].score).toBeGreaterThanOrEqual(3);
  });
});

describe("T-U-4: the reason sentence is counts and the entity label only", () => {
  it("contains no text from the segments", () => {
    const text = neighbourReason({ wrote: 0, replied: 3, near: 0, files: 1, events: 0 }, "Firmware deploy to the robot");
    expect(text).toBe("Replied in 3 threads and changed 1 of the same files for Firmware deploy to the robot");
    expect(neighbourReason({ wrote: 2, replied: 1, near: 4, files: 0, events: 1 }, "X"))
      .toBe("Wrote 2 of the records, replied in 1 thread, was in 4 of the same conversations and shared 1 calendar event for X");
  });
});

describe("T-U-5: role set of a score", () => {
  it("is the intersection of the contributing segments' role sets", () => {
    const pub = seg({ id: "pub", authorId: "p-1", roleSet: ALL, thread: "#events" });
    const pubReply = seg({ id: "pub-r", authorId: "p-2", roleSet: ALL, thread: "#events", meta: { replyTo: "pub" } });
    const infra = seg({ id: "infra", authorId: "p-1", roleSet: INFRA });
    const infraReply = seg({ id: "infra-r", authorId: "p-2", roleSet: INFRA, meta: { replyTo: "infra" } });
    const g = buildGraph([pub, pubReply, infra, infraReply], { now: NOW, windowMonths: 6 });
    const [both] = neighbourScores(g, new Set(["pub", "infra"]), { leaverIds: ["p-1"] });
    expect(both.roleSet).toEqual(INFRA);
    const [onlyPublic] = neighbourScores(g, new Set(["pub"]), { leaverIds: ["p-1"] });
    expect(onlyPublic.roleSet).toEqual(ALL);
  });
});

describe("entity segment index", () => {
  it("takes accepted citations of live claims plus one reply hop", () => {
    const a = seg({ id: "a" });
    const reply = seg({ id: "a-reply", meta: { replyTo: "a" } });
    const second = seg({ id: "a-reply-2", meta: { replyTo: "a-reply" } });
    const idx = entitySegmentIndex([
      { entity: "x", state: "active", citations: [{ segmentId: "a", quote: null, accepted: true, exact: false }] },
      { entity: "x", state: "dropped", citations: [{ segmentId: "zzz", quote: null, accepted: true, exact: false }] },
      { entity: "y", state: "superseded", citations: [{ segmentId: "b", quote: null, accepted: false, exact: false }] },
    ], [a, reply, second]);
    expect([...idx.get("x")!].sort()).toEqual(["a", "a-reply"]);
    expect([...idx.get("y")!]).toEqual([]);
  });
});
