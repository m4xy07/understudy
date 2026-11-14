// Two Attest fixes found while planning Round 3 (pure half; the database half is in
// tests/db/foundation.test.ts):
//   1. extraction never reads a person's own words (answer and finding segments), so a re-run
//      cannot turn a leaver's answer into a "From record" claim quoted from the answer itself;
//   2. only origins Attest derives from the record can go stale; the others are carried.
import { describe, expect, it } from "vitest";
import { extractClaims, planBatches } from "@/lib/attest/core/extract";
import {
  DETERMINISTIC_KINDS, EXTRACTION_SKIP_KINDS, PERSON_SEGMENT_KINDS, isCarriedOrigin, isPersonOrigin, isRecordOrigin,
  takesPartInRules,
} from "@/lib/attest/core/origins";
import type { ClaimOrigin } from "@/lib/types";
import { CLUB_ROLE_ORDER } from "../helpers/club";
import { ALL, at, fakeModel, pack, seg } from "./fixtures/segments";

const PLAN = { roleOrder: CLUB_ROLE_ORDER };

describe("extraction skips a person's own words", () => {
  const segs = [
    seg({ id: "seg_chat", kind: "message", thread: "chat", ts: at(1), roleSet: ALL, text: "The lab is booked through the office form." }),
    seg({ id: "seg_answer", kind: "answer", sourceKind: "interview", thread: "interview:R01:rollback", ts: at(2), roleSet: ALL,
      text: "Roll back with make flash-prev. ANSWER-ONLY-TEXT" }),
    seg({ id: "seg_finding", kind: "finding", sourceKind: "finding", thread: "finding:R03:next_due_date", ts: at(3), roleSet: ALL,
      text: "Answer: late access is next due on 18 Nov 2026. FINDING-ONLY-TEXT" }),
    seg({ id: "seg_task", kind: "task", thread: "board", ts: at(4), roleSet: ALL, text: "status: Open" }),
  ];

  it("skip kinds are task, event, answer, finding and run", () => {
    expect([...EXTRACTION_SKIP_KINDS].sort()).toEqual(["answer", "event", "finding", "run", "task"]);
    expect([...DETERMINISTIC_KINDS]).toEqual(["task", "event"]);
    expect([...PERSON_SEGMENT_KINDS]).toEqual(["answer", "finding"]);
  });

  it("planBatches leaves answer and finding segments out by default", () => {
    const ids = planBatches(segs, PLAN).flatMap((b) => b.segmentIds);
    expect(ids).toEqual(["seg_chat"]);
  });

  it("no prompt sent to the model contains an answer or a finding", async () => {
    const model = fakeModel(() => ({ claims: [] }));
    const res = await extractClaims(segs, pack, model.call, PLAN);
    expect(res.batches).toHaveLength(1);
    const sent = model.calls.map((c) => c.user).join("\n");
    expect(sent).toContain("The lab is booked through the office form.");
    expect(sent).not.toContain("ANSWER-ONLY-TEXT");
    expect(sent).not.toContain("FINDING-ONLY-TEXT");
    expect(sent).not.toContain("seg_answer");
    expect(sent).not.toContain("seg_finding");
  });

  it("the old default (task and event only) would have sent the answer: the bug this fixes", () => {
    const ids = planBatches(segs, { ...PLAN, skipKinds: DETERMINISTIC_KINDS }).flatMap((b) => b.segmentIds);
    expect(ids).toContain("seg_answer");
  });
});

describe("claim origins", () => {
  const all: ClaimOrigin[] = ["extracted", "structured", "leaver_answer", "neighbour_answer", "trace", "successor_finding"];

  it("only extracted and structured claims are re-derived from the record", () => {
    expect(all.filter(isRecordOrigin)).toEqual(["extracted", "structured"]);
    expect(all.filter(isCarriedOrigin)).toEqual(["leaver_answer", "neighbour_answer", "trace", "successor_finding"]);
  });

  it("a person's word is a leaver answer, a neighbour answer or a successor finding", () => {
    expect(all.filter(isPersonOrigin)).toEqual(["leaver_answer", "neighbour_answer", "successor_finding"]);
  });

  it("second-hand answers and traces stay outside the rules: they never supersede or conflict with a record", () => {
    expect(all.filter(takesPartInRules)).toEqual(["extracted", "structured", "leaver_answer", "successor_finding"]);
  });
});
