// Consolidation (second pass of two-pass extraction): one test per rule, with hand-written
// candidates and no model. The setting is a made-up garden, so nothing here is a pack fact.
import { describe, expect, it } from "vitest";
import {
  consolidate,
  contentTokens,
  exampleValues,
  eventOf,
  isOptionsValue,
  locationKind,
  sameEvent,
  sameFact,
} from "@/lib/attest/core/consolidate";
import type { DraftClaim, PackEntity, Stance } from "@/lib/attest/core/schema";
import type { Attribute, RoleKey, Segment } from "@/lib/types";
import { seg } from "./fixtures/segments";

const ORDER: RoleKey[] = ["chair", "grower", "visitor"];
const EVERYONE: RoleKey[] = ["chair", "grower", "visitor"];
const INNER: RoleKey[] = ["chair", "grower"];

const entities: (PackEntity & { partOf?: string })[] = [
  { key: "watering", label: "Watering the beds", aliases: ["watering", "pump", "hose"] },
  { key: "pump-repair", label: "Pump repair", partOf: "watering", aliases: ["pump repair", "repair"] },
  { key: "plot-booking", label: "Plot booking each season", aliases: ["plot booking", "booking form"] },
  { key: "late-entry", label: "Evening entry to the garden", aliases: ["evening entry", "after dark", "gate key"] },
  { key: "open-day", label: "Garden open day (date and place)", aliases: ["open day", "fair"] },
];

function draft(
  entity: string,
  attribute: Attribute,
  value: string,
  cites: [Segment, string][],
  extra: Partial<DraftClaim> & { stance?: Stance; event?: string } = {},
): DraftClaim {
  return {
    entity,
    entityRaw: null,
    attribute,
    value,
    statement: extra.statement ?? `${value}.`,
    citations: cites.map(([s, quote]) => ({ segmentId: s.id, quote })),
    origin: "extracted",
    batchId: "batch_1",
    batchSegmentIds: cites.map(([s]) => s.id),
    stance: "decided",
    event: "",
    ...extra,
  };
}

function run(drafts: DraftClaim[], segs: Segment[]) {
  return consolidate(drafts, { entities, segmentsById: new Map(segs.map((s) => [s.id, s])), roleOrder: ORDER });
}

describe("rule: merge duplicates", () => {
  it("keeps the most specific value and every citation", () => {
    const s1 = seg({ text: "Sam keeps the shed key.", roleSet: EVERYONE });
    const s2 = seg({ text: "Sam Okoye keeps the shed key, ask him.", roleSet: EVERYONE });
    const a = draft("watering", "owner", "Sam", [[s1, "Sam keeps the shed key"]]);
    const b = draft("watering", "owner", "Sam Okoye", [[s2, "Sam Okoye keeps the shed key"]], { batchId: "batch_2" });
    const r = run([a, b], [s1, s2]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0].value).toBe("Sam Okoye");
    expect(r.drafts[0].citations.map((c) => c.segmentId).sort()).toEqual([s1.id, s2.id].sort());
    expect(r.drafts[0].batchSegmentIds.sort()).toEqual([s1.id, s2.id].sort());
    expect(r.counts.merge_duplicates).toBe(1);
    // Inputs are not mutated.
    expect(a.citations).toHaveLength(1);
  });

  it("never merges across role sets", () => {
    const open = seg({ text: "Sam keeps the shed key.", roleSet: EVERYONE });
    const inner = seg({ text: "Sam keeps the shed key.", roleSet: INNER, thread: "#committee" });
    const r = run(
      [draft("watering", "owner", "Sam", [[open, "Sam keeps the shed key"]]), draft("watering", "owner", "Sam", [[inner, "Sam keeps the shed key"]])],
      [open, inner],
    );
    expect(r.drafts).toHaveLength(2);
    expect(r.counts.merge_duplicates).toBe(0);
  });

  it("leaves two people who agree as two claims, so they can corroborate each other", () => {
    const s1 = seg({ text: "The pump lives in the blue cupboard.", authorId: "p-1" });
    const s2 = seg({ text: "Pump is in the blue cupboard.", authorId: "p-2" });
    const r = run(
      [
        draft("watering", "location", "the blue cupboard", [[s1, "the blue cupboard"]]),
        draft("watering", "location", "the blue cupboard", [[s2, "the blue cupboard"]]),
      ],
      [s1, s2],
    );
    expect(r.drafts).toHaveLength(2);
  });

  it("does not merge a value with its negation, two dates, or board rows", () => {
    const s1 = seg({ text: "Pump is fixed." });
    const s2 = seg({ text: "Pump is not fixed after all." });
    const fixed = draft("watering", "status", "fixed", [[s1, "Pump is fixed"]]);
    const notFixed = draft("watering", "status", "not fixed", [[s2, "not fixed"]]);
    expect(sameFact(fixed, notFixed)).toBe(false);
    const d1 = draft("open-day", "deadline", "2026-05-02", [[s1, "Pump is fixed"]]);
    const d2 = draft("open-day", "deadline", "2026-05-02 (setup)", [[s2, "not fixed"]]);
    expect(sameFact(d1, d2)).toBe(false);
    const row = { ...draft("watering", "status", "fixed", [[s1, "Pump is fixed"]]), origin: "structured" as const };
    expect(run([row, { ...row }], [s1]).drafts).toHaveLength(2);
  });
});

describe("rule: re-file to the most specific entity", () => {
  it("moves a claim whose quote names another entity when the cited text does not name the chosen one", () => {
    const s = seg({ text: "Asked the warden for evening entry again this week.", thread: "Garden chat" });
    const r = run([draft("plot-booking", "contact", "the warden", [[s, "Asked the warden for evening entry"]])], [s]);
    expect(r.drafts[0].entity).toBe("late-entry");
    expect(r.firings[0]).toMatchObject({ rule: "refile_entity", entity: "late-entry" });
  });

  it("stays when the cited segment names the chosen entity", () => {
    const s = seg({ text: "Plot booking form is due, and I asked the warden for evening entry too.", thread: "Garden chat" });
    const r = run([draft("plot-booking", "contact", "the warden", [[s, "asked the warden for evening entry"]])], [s]);
    expect(r.drafts[0].entity).toBe("plot-booking");
    expect(r.counts.refile_entity).toBe(0);
  });

  it("does not move on a single common word", () => {
    const s = seg({ text: "Bring the forms to the fair.", thread: "Garden chat" });
    const r = run([draft("plot-booking", "procedure", "bring the forms", [[s, "Bring the forms to the fair"]])], [s]);
    expect(r.drafts[0].entity).toBe("plot-booking");
  });

  it("moves to a part of the chosen entity when the quote names the part", () => {
    const s = seg({ text: "Watering: the repair is booked with the plumber." });
    const r = run([draft("watering", "status", "booked with the plumber", [[s, "the repair is booked with the plumber"]])], [s]);
    expect(r.drafts[0].entity).toBe("pump-repair");
    expect(r.firings[0].detail).toContain("part");
  });

  it("leaves claims under other alone", () => {
    const s = seg({ text: "Evening entry was fun last year." });
    const r = run([draft("other", "status", "fun", [[s, "Evening entry was fun"]])], [s]);
    expect(r.drafts[0].entity).toBe("other");
  });
});

describe("rule: bind dates and places to named events", () => {
  it("a date for the entity's own event stays as it is", () => {
    const s = seg({ text: "The open day is on 2 May." });
    const r = run([draft("open-day", "deadline", "2026-05-02", [[s, "The open day is on 2 May"]], { event: "open day" })], [s]);
    expect(r.drafts[0]).toMatchObject({ entity: "open-day", value: "2026-05-02" });
    expect(r.counts.bind_event).toBe(0);
  });

  it("a date whose event names another entity moves there", () => {
    const s = seg({ text: "Forms go in by 12 April." });
    const r = run([draft("open-day", "deadline", "2026-04-12", [[s, "Forms go in by 12 April"]], { event: "booking form" })], [s]);
    expect(r.drafts[0]).toMatchObject({ entity: "plot-booking", value: "2026-04-12" });
    expect(r.firings[0]).toMatchObject({ rule: "bind_event", entity: "plot-booking" });
  });

  it("a date for another, unlisted event keeps its entity and carries the event in its value", () => {
    const s = seg({ text: "Marquee setup for the open day is on 30 April." });
    const r = run([draft("open-day", "deadline", "2026-04-30", [[s, "Marquee setup for the open day is on 30 April"]], { event: "marquee setup" })], [s]);
    expect(r.drafts[0]).toMatchObject({ entity: "open-day", value: "2026-04-30 (marquee setup)" });
    expect(eventOf(r.drafts[0].value)).toBe("marquee setup");
  });

  it("leaves a date with no event, a cadence, and a date that is only the written day", () => {
    const s = seg({ text: "Marquee goes up soon.", ts: "2026-04-30T09:00:00.000Z" });
    const none = draft("open-day", "deadline", "2026-05-02", [[s, "Marquee goes up soon"]]);
    const cadence = draft("open-day", "deadline", "every spring", [[s, "Marquee goes up soon"]], { event: "marquee" });
    const written = draft("open-day", "deadline", "2026-04-30", [[s, "Marquee goes up soon"]], { event: "marquee" });
    const r = run([none, cadence, written], [s]);
    expect(r.drafts.map((d) => d.value)).toEqual(["2026-05-02", "every spring", "2026-04-30"]);
  });

  it("a date, place or owner whose text never names the chosen entity moves to the entity it names, or to other", () => {
    const roster = seg({ text: "Posts this year. Sam Okoye: chair. Dee Park: treasurer.", thread: "notes/posts.md" });
    const gate = seg({ text: "The gate key hangs in the tool store.", thread: "Garden chat" });
    const reply = seg({ text: "Yes, the 14th of March 2026.", thread: "Garden chat", meta: { replyTo: "seg_parent" } });
    const parent = seg({ id: "seg_parent", text: "Is the open day still on the 14th?", thread: "Garden chat" });
    const r = run(
      [
        draft("watering", "owner", "Sam Okoye", [[roster, "Sam Okoye: chair"]]),
        draft("watering", "owner", "Dee Park", [[roster, "Dee Park: treasurer"]]),
        draft("plot-booking", "location", "the tool store", [[gate, "The gate key hangs in the tool store"]]),
        draft("open-day", "deadline", "2026-03-14", [[reply, "the 14th of March 2026"]]),
      ],
      [roster, gate, reply, parent],
    );
    expect(r.drafts.map((d) => d.entity)).toEqual(["other", "other", "late-entry", "open-day"]);
    // The gate key is moved by the re-file rule (its quote names another entity by a phrase);
    // the two roster owners have no entity to go to, so they go to "other".
    expect(r.counts.refile_entity).toBe(1);
    expect(r.counts.bind_event).toBe(2);
    expect(r.firings.find((f) => f.rule === "bind_event")?.detail).toContain("never names watering");
  });

  it("an owner named in a text about the entity stays", () => {
    const s = seg({ text: "Sam looks after the pump and the hoses." });
    const r = run([draft("watering", "owner", "Sam", [[s, "Sam looks after the pump"]])], [s]);
    expect(r.drafts[0].entity).toBe("watering");
    expect(r.counts.bind_event).toBe(0);
  });

  it("values with different events are different facts; without events they are the same event", () => {
    expect(sameEvent("2026-04-30 (marquee setup)", "2026-05-02")).toBe(false);
    expect(sameEvent("2026-04-30 (marquee setup)", "2026-05-01 (seed swap)")).toBe(false);
    expect(sameEvent("2026-04-30 (marquee setup)", "2026-05-01 (setup of the marquee)")).toBe(true);
    expect(sameEvent("2026-04-30", "2026-05-02")).toBe(true);
    expect(contentTokens("the Trials")).toEqual(["trial"]);
  });
});

describe("rule: fold considered and rejected options into one claim", () => {
  it("folds options for one entity into one decision claim with every citation", () => {
    const s1 = seg({ text: "Open day could be in the car park or the old orchard." });
    const s2 = seg({ text: "The school hall is out, too far." });
    const r = run(
      [
        draft("open-day", "location", "the car park", [[s1, "in the car park"]], { stance: "considered" }),
        draft("open-day", "location", "the old orchard", [[s1, "the old orchard"]], { stance: "considered" }),
        draft("open-day", "location", "the school hall", [[s2, "The school hall is out"]], { stance: "rejected", batchId: "batch_2" }),
        draft("open-day", "status", "place not settled", [[s1, "could be in the car park"]], { stance: "open" }),
      ],
      [s1, s2],
    );
    const folded = r.drafts.filter((d) => d.attribute === "decision");
    expect(folded).toHaveLength(1);
    expect(folded[0].value).toBe("Options: the car park or the old orchard; rejected: the school hall");
    expect(folded[0].citations).toHaveLength(3);
    expect(folded[0].batchSegmentIds.sort()).toEqual([s1.id, s2.id].sort());
    expect(isOptionsValue(folded[0].value)).toBe(true);
    // No considered option survives as a location; other attributes pass through.
    expect(r.drafts.filter((d) => d.attribute === "location")).toHaveLength(0);
    expect(r.drafts.filter((d) => d.attribute === "status")).toHaveLength(1);
    expect(r.counts.fold_options).toBe(1);
  });

  it("a value that offers a choice is not settled, whatever stance the model gave it", () => {
    const s = seg({ text: "The open day will be in the car park or the old orchard." });
    const r = run([draft("open-day", "location", "the car park or the old orchard", [[s, "in the car park or the old orchard"]])], [s]);
    expect(r.drafts.map((d) => [d.attribute, d.value])).toEqual([["decision", "Options: the car park or the old orchard"]]);
  });

  it("a decided value is never folded, and options never cross role sets", () => {
    const open = seg({ text: "Open day is in the car park. The orchard was an idea.", roleSet: EVERYONE });
    const inner = seg({ text: "We might still use the school hall.", roleSet: INNER, thread: "#committee" });
    const r = run(
      [
        draft("open-day", "location", "the car park", [[open, "Open day is in the car park"]]),
        draft("open-day", "location", "the orchard", [[open, "The orchard was an idea"]], { stance: "considered" }),
        draft("open-day", "location", "the school hall", [[inner, "use the school hall"]], { stance: "considered" }),
      ],
      [open, inner],
    );
    expect(r.drafts.filter((d) => d.attribute === "location").map((d) => d.value)).toEqual(["the car park"]);
    expect(r.drafts.filter((d) => d.attribute === "decision").map((d) => d.value)).toEqual([
      "Options: the orchard",
      "Options: the school hall",
    ]);
  });
});

describe("rule: location kind", () => {
  it("classifies places, paths, web addresses and services", () => {
    expect(locationKind("the blue cupboard")).toBe("place");
    expect(locationKind("Shed 3")).toBe("place");
    expect(locationKind("docs/PLOTS.md")).toBe("path");
    expect(locationKind("README")).toBe("path");
    expect(locationKind("plots/")).toBe("path");
    expect(locationKind("https://garden.example/plots")).toBe("url");
    expect(locationKind("garden.example")).toBe("url");
    expect(locationKind("SeedHost (online)")).toBe("service");
    expect(locationKind("the council portal")).toBe("service");
    // An event label does not change the kind of the place it follows.
    expect(locationKind("Shed 3 (website photos)")).toBe("place");
  });

  it("reports an entity that has locations of more than one kind", () => {
    const s = seg({ text: "Watering plans are in plots/ and the tools are in Shed 3." });
    const r = run(
      [draft("watering", "location", "plots/", [[s, "Plans are in plots/"]]), draft("watering", "location", "Shed 3", [[s, "tools are in Shed 3"]])],
      [s],
    );
    expect(r.counts.location_kind).toBe(1);
    expect(r.firings.find((f) => f.rule === "location_kind")?.detail).toContain("path, place");
  });
});

describe("rule: example echo", () => {
  it("drops a candidate whose value repeats a prompt example, and nothing else", () => {
    const s = seg({ text: "The pump is waiting for a new seal." });
    const values = exampleValues({ status: 'value "waiting for seeds", statement "The herb bed is waiting for seeds."' });
    expect(values).toEqual(["waiting for seeds"]);
    const drafts = [
      draft("watering", "status", "Waiting for seeds", [[s, "The pump is waiting"]]),
      draft("watering", "status", "waiting for a new seal", [[s, "waiting for a new seal"]]),
    ];
    const r = consolidate(drafts, { entities, segmentsById: new Map([[s.id, s]]), roleOrder: ORDER, exampleValues: values });
    expect(r.drafts.map((d) => d.value)).toEqual(["waiting for a new seal"]);
    expect(r.counts.example_echo).toBe(1);
  });
});

describe("consolidate", () => {
  it("is deterministic and reports every rule in its counts", () => {
    const s = seg({ text: "Sam keeps the shed key." });
    const drafts = [draft("watering", "owner", "Sam", [[s, "Sam keeps the shed key"]])];
    const a = run(drafts, [s]);
    const b = run(drafts, [s]);
    expect(a).toEqual(b);
    expect(Object.keys(a.counts).sort()).toEqual(["bind_event", "example_echo", "fold_options", "location_kind", "merge_duplicates", "refile_entity"]);
  });

  it("treats a draft without stance or event (the Round 2 shape) as decided", () => {
    const s = seg({ text: "Open day is in the car park." });
    const d = draft("open-day", "location", "the car park", [[s, "Open day is in the car park"]]);
    delete d.stance;
    delete d.event;
    expect(run([d], [s]).drafts[0]).toEqual(d);
  });
});
