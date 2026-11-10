import { describe, expect, it } from "vitest";
import { claimId, isExactQuote, locateSpan, verifyDrafts } from "@/lib/attest/core/verify";
import { draft, pack, seg, segMap } from "./fixtures-verify/build";

function wordOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().match(/\w+/g));
  const tb = new Set(b.toLowerCase().match(/\w+/g));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size);
}

describe("verifyDrafts: citation rules", () => {
  it('the "not" case: a quote with "not" removed fails the exact match even though word overlap is high', () => {
    const s = seg({ text: "Do **not** flash the firmware from the main branch, use the release tag." });
    const quote = "Do flash the firmware from the main branch";
    expect(wordOverlap(quote, "Do not flash the firmware from the main branch")).toBeGreaterThan(0.8);
    expect(isExactQuote(quote, s.text)).toBe(false);

    const { claims, dropped } = verifyDrafts(
      [draft({ value: "flash from main", citations: [{ segment_id: s.id, quote }] })],
      segMap(s), pack, "ws",
    );
    expect(dropped).toHaveLength(0);
    expect(claims).toHaveLength(1);
    expect(claims[0].citations[0]).toMatchObject({ accepted: true, exact: false });
    expect(claims[0].trust).toBe("inferred");

    // locateSpan still finds a near span for reviewers, but it never changes the label.
    const span = locateSpan(quote, s.text);
    expect(span).not.toBeNull();
    expect(span!.literal).toBe(false);
    expect(span!.score).toBeGreaterThan(0.8);
    expect(claims[0].trust).toBe("inferred");
  });

  it("an exact quote (after norm: case, markdown, whitespace) gives from_record", () => {
    const s = seg({ text: "Do **not** flash the firmware\n   from the MAIN branch." });
    const { claims } = verifyDrafts(
      [draft({ value: "never flash from main", citations: [{ segment_id: s.id, quote: "do not flash the firmware from the main branch" }] })],
      segMap(s), pack, "ws",
    );
    expect(claims[0].citations[0]).toMatchObject({ accepted: true, exact: true });
    expect(claims[0].trust).toBe("from_record");
  });

  it("a citation to a segment outside the batch is rejected; with nothing else the draft is dropped and counted", () => {
    const inBatch = seg({ text: "Lab is booked through Facilities.", sourceId: "src_a" });
    const outside = seg({ text: "Lab booking is done by Priya every term.", sourceId: "src_b" });
    const segments = segMap(inBatch, outside);

    const onlyOutside = draft({
      entity: "lab-booking", attribute: "owner", value: "Priya",
      citations: [{ segment_id: outside.id, quote: "Lab booking is done by Priya" }],
      batchSegmentIds: [inBatch.id],
    });
    const mixed = draft({
      entity: "lab-booking", attribute: "procedure", value: "via Facilities",
      citations: [
        { segment_id: outside.id, quote: "Lab booking is done by Priya" },
        { segment_id: inBatch.id, quote: "booked through Facilities" },
      ],
      batchSegmentIds: [inBatch.id],
    });
    const { claims, dropped, droppedBySource } = verifyDrafts([onlyOutside, mixed], segments, pack, "ws");

    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toMatch(/not in the batch/);
    expect(dropped[0].sourceId).toBe("src_b");
    expect(droppedBySource).toEqual({ src_b: 1 });

    expect(claims).toHaveLength(1);
    const c = claims[0];
    expect(c.citations.find((x) => x.segmentId === outside.id)).toMatchObject({ accepted: false });
    expect(c.citations.find((x) => x.segmentId === inBatch.id)).toMatchObject({ accepted: true, exact: true });
    expect(c.trust).toBe("from_record");
    // Only accepted segments shape the claim id.
    expect(c.id).toBe(claimId("lab-booking", "procedure", "via Facilities", [inBatch.id]));
  });

  it("a citation to a segment that does not exist is rejected and the draft dropped", () => {
    const s = seg({ text: "anything" });
    const { claims, dropped, droppedBySource } = verifyDrafts(
      [draft({ citations: [{ segment_id: "seg_doesnotexist0000", quote: "x" }], batchSegmentIds: [s.id, "seg_doesnotexist0000"] })],
      segMap(s), pack, "ws",
    );
    expect(claims).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/not found/);
    expect(droppedBySource).toEqual({ [s.sourceId]: 1 });
  });

  it("structured drafts only need the segment to exist", () => {
    const row = seg({ text: "T-12 | Book lab | open | Priya | 2026-11-02", sourceKind: "tasks_csv", kind: "task" });
    const { claims } = verifyDrafts(
      [draft({ entity: "lab-booking", attribute: "deadline", value: "2026-11-02", origin: "structured",
        citations: [{ segment_id: row.id, quote: "2026-11-02" }], batchSegmentIds: [] })],
      segMap(row), pack, "ws",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].trust).toBe("from_record");
    expect(claims[0].origin).toBe("structured");
  });

  it("an accepted citation without a quote is at most inferred", () => {
    const s = seg({ text: "We roll back with the previous release tag." });
    const { claims } = verifyDrafts([draft({ citations: [{ segment_id: s.id, quote: null }] })], segMap(s), pack, "ws");
    expect(claims[0].trust).toBe("inferred");
    expect(claims[0].citations[0]).toMatchObject({ accepted: true, exact: false });
  });

  it("claim role set is the intersection of the cited segments' role sets; time and author come from the newest", () => {
    const wide = seg({ text: "Deploy uses the release tag.", ts: "2026-10-01T09:00:00Z", authorId: "p-2",
      roleSet: ["president", "tech_lead", "new_member", "treasurer", "leaver"] });
    const narrow = seg({ text: "Deploy key lives in the club vault.", ts: "2026-10-03T09:00:00Z", authorId: "p-1",
      roleSet: ["president", "tech_lead", "leaver"], sourceKind: "markdown", kind: "note", thread: "notes/deploy.md" });
    const { claims } = verifyDrafts(
      [draft({ value: "release tag + vault key", citations: [
        { segment_id: wide.id, quote: "release tag" },
        { segment_id: narrow.id, quote: "club vault" },
      ] })],
      segMap(wide, narrow), pack, "ws",
    );
    const c = claims[0];
    expect(c.roleSet).toEqual(["president", "tech_lead", "leaver"]);
    expect(c.validFrom).toBe("2026-10-03T09:00:00Z");
    expect(c.authorId).toBe("p-1");
    expect(c.sourceKinds).toEqual(["markdown", "slack"]);
  });

  it("ids are deterministic and exact duplicates merge", () => {
    const s = seg({ text: "Regionals are on 14 November." });
    const d = draft({ entity: "Regionals", attribute: "deadline", value: "14 November",
      citations: [{ segment_id: s.id, quote: "on 14 November" }] });
    const d2 = { ...d, statement: "Other wording.", citations: [{ segment_id: s.id, quote: null }] };
    const a = verifyDrafts([d, d2], segMap(s), pack, "ws");
    const b = verifyDrafts([d], segMap(s), pack, "ws");
    expect(a.claims).toHaveLength(1);
    expect(a.claims[0].id).toBe(b.claims[0].id);
    expect(a.claims[0].id).toMatch(/^clm_[0-9a-f]{16}$/);
    expect(a.claims[0].entity).toBe("competition"); // alias resolved to the pack key
    expect(a.claims[0].citations).toHaveLength(2);
    expect(a.claims[0].trust).toBe("from_record");
  });

  it("drops drafts with an attribute outside the closed list", () => {
    const s = seg({ text: "x" });
    const bad = { ...draft({ citations: [{ segment_id: s.id, quote: "x" }] }), attribute: "colour" as never };
    const { claims, dropped } = verifyDrafts([bad], segMap(s), pack, "ws");
    expect(claims).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/unknown attribute/);
  });
});

describe("locateSpan", () => {
  it("returns the literal span when the quote occurs", () => {
    const text = "Roll back with: git checkout v1.4 && make flash";
    const span = locateSpan("git checkout v1.4", text)!;
    expect(text.slice(span.start, span.end)).toBe("git checkout v1.4");
    expect(span).toMatchObject({ literal: true, score: 1 });
  });
  it("returns null when nothing overlaps", () => {
    expect(locateSpan("zebra crossing", "the robot arm")).toBeNull();
  });
});
