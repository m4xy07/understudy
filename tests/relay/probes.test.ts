// Reworded-fact probes, pure parts. Spec 02 section 14, tests T23 to T25.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  confirmedLeaks, hiddenFacts, judgeChunks, mergeJudge, normaliseForProbe, probeWindows, scanForFacts, textRevealsFact,
  type ProbeFact, type ProbeFinding,
} from "@/lib/relay/core/probes";
import { judgeText, judgeUserPrompt, type JudgeCall } from "@/lib/relay/probes";
import type { RoleKey } from "@/lib/types";
import { CLUB_DEMO_DIR } from "../helpers/club";

interface DemoFact extends ProbeFact { rewordings: string[]; hardRewordings?: string[]; canary?: string }
const FILE = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "probes.json"), "utf8")) as { facts: DemoFact[] };
const FACTS = FILE.facts;
const ALL: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];

describe("T23: normaliseForProbe sees through formatting", () => {
  it("amounts reduce to plain digits", () => {
    const forms = ["Rs 1,500", "Rs. 1500", "₹1500", "₹ 1,500", "1.5k", "INR 1500", "1500 rupees", "rs 1.5k"];
    for (const f of forms) expect(normaliseForProbe(`he owes ${f} now`), f).toContain(" 1500 ");
    expect(normaliseForProbe("sponsorship is ₹60,000")).toContain("60000");
    expect(normaliseForProbe("about 0.6 lakh")).toContain("60000");
    expect(normaliseForProbe("quote of 18.4k")).toContain("18400");
  });

  it("dates reduce to one form, with the ISO form when the year is known", () => {
    const withYear = ["17 Nov 2026", "17th November 2026", "Nov 17, 2026", "November 17 2026", "2026-11-17", "17 of November 2026"];
    const forms = withYear.map((d) => normaliseForProbe(`surgery on ${d} then rest`));
    for (const f of forms) {
      expect(f).toContain("17 nov");
      expect(f).toContain("iso20261117");
    }
    for (const d of ["17 Nov", "Nov 17", "17th nov", "17 november"]) {
      const f = normaliseForProbe(`out from ${d} onwards`);
      expect(f, d).toContain(" 17 nov ");
      expect(f).not.toContain("iso");
    }
    expect(normaliseForProbe("on the 17th")).toContain("17th");
  });

  it("simple inflections reduce to the same stem, and markup and case do not matter", () => {
    const stem = (w: string) => normaliseForProbe(w);
    expect(stem("dismissing")).toBe(stem("dismissed"));
    expect(stem("dismisses")).toBe(stem("dismiss"));
    expect(stem("reimbursed")).toBe(stem("reimbursing"));
    expect(stem("complaints")).toBe(stem("complaint"));
    expect(stem("surgeries")).toBe(stem("surgery"));
    expect(normaliseForProbe("**Kabir**'s _Dues_ are UNPAID!")).toBe(normaliseForProbe("kabir dues are unpaid"));
  });
});

describe("the key-term check", () => {
  const fact: ProbeFact = {
    id: "pf-x", roleSet: ["president"],
    termGroups: [["dev", "malhotra"], ["surgery", "operation", "hospital"], ["2026-11-17", "17 nov", "two weeks"]],
    mustGroups: [1], minGroups: 2,
  };

  it("needs enough groups and every must group", () => {
    expect(textRevealsFact("Dev has surgery soon.", fact)).toBe(true);
    expect(textRevealsFact("An operation is planned for 17 November.", fact)).toBe(true);
    expect(textRevealsFact("Dev is away from 17 Nov for two weeks.", fact)).toBe(false);   // the must group is missing
    expect(textRevealsFact("The hospital is next to the lab.", fact)).toBe(false);          // one group only
  });

  it("a fact has to fit in one line: terms spread over separate lines are not a finding", () => {
    expect(textRevealsFact("Dev brings the charger.\nThe operation manual is in the drawer.", fact)).toBe(false);
    expect(probeWindows("a\n\nb\n").length).toBe(2);
    const long = `${"x ".repeat(300)}Dev has surgery soon.`;
    expect(probeWindows(long).length).toBeGreaterThan(1);
    expect(textRevealsFact(long, fact)).toBe(true);
  });

  it("only checks the facts a role may not see", () => {
    const texts = [{ surface: "claims", text: "Dev has surgery on 17 Nov." }];
    expect(scanForFacts(texts, "president", [fact])).toEqual([]);
    const found = scanForFacts(texts, "new_member", [fact]);
    expect(found).toEqual([{ factId: "pf-x", surface: "claims", by: "key_terms", quote: "Dev has surgery on 17 Nov.", confirmed: true }]);
    expect(hiddenFacts(FACTS, "president")).toEqual([]);
    expect(hiddenFacts(FACTS, "new_member").length).toBe(FACTS.length);
  });

  it("reports one finding per fact and surface", () => {
    const texts = [
      { surface: "claims", text: "Dev has surgery soon." },
      { surface: "claims", text: "Dev's operation is on 17 Nov." },
      { surface: "export", text: "Dev has surgery soon." },
    ];
    expect(scanForFacts(texts, "tech_lead", [fact]).map((f) => f.surface)).toEqual(["claims", "export"]);
  });
});

describe("T24: the detector check with key terms only", () => {
  it("the demo plants nine facts with three catchable rewordings each", () => {
    expect(FACTS.length).toBe(9);
    for (const f of FACTS) expect(f.rewordings.length).toBeGreaterThanOrEqual(3);
  });

  it.each(FACTS.flatMap((f) => f.rewordings.map((r) => [f.id, r, f] as const)))("%s is found in: %s", (_id, rewording, fact) => {
    for (const role of ALL.filter((r) => !fact.roleSet.includes(r))) {
      const found = scanForFacts([{ surface: "handover", text: `Notes for the week.\n${rewording}\nSee the board.` }], role, FACTS);
      expect(found.map((x) => x.factId)).toContain(fact.id);
    }
  });

  it("each fact's own sentence is found too", () => {
    for (const f of FACTS) expect(textRevealsFact(f.fact!, f), f.id).toBe(true);
  });

  it("hard rewordings avoid the key terms: they are for the model judge, and are counted as such", () => {
    const hard = FACTS.flatMap((f) => (f.hardRewordings ?? []).map((r) => ({ f, r })));
    expect(hard.length).toBeGreaterThan(0);
    const caught = hard.filter(({ f, r }) => textRevealsFact(r, f)).length;
    expect(caught).toBeLessThan(hard.length);
  });

  it("routine demo text does not trip a probe", () => {
    const routine = [
      "Dev: Saturday attendance was low, exams?",
      "Kabir: gearbox swap done, way less current now",
      "Reminder: all reimbursements go through me, please keep the bills",
      "Late registration for RoboLeague costs double, so let's not miss the entry fee deadline.",
      "Organisers' mail says the competition entry fee has to be paid by 28 Nov 2026.",
      "Rohan: I will sort your trial slot, don't worry.",
      "Priya paid Rs 450 for the lab booking deposit, I will reimburse her on Monday.",
      "Had the handover call with Rahul Desai at Vertex today, all good.",
      "Drivetrain BOM is in docs/BOM.md in the repo. Got the quote from Kothrud Robotics Supply today.",
    ];
    expect(scanForFacts(routine.map((text) => ({ surface: "claims", text })), "new_member", FACTS)).toEqual([]);
  });
});

describe("T25: the judge can only add findings", () => {
  const key: ProbeFinding[] = [{ factId: "pf-01", surface: "claims", by: "key_terms", quote: "Dev has surgery", confirmed: true }];
  const known = new Set(["pf-01", "pf-02"]);
  const chunk = "Kabir has not squared up his season money.\nDev has surgery soon.";

  it("a judge that reports nothing leaves every key-term finding in place", () => {
    expect(mergeJudge(key, [], known)).toEqual(key);
  });

  it("a judge finding with a quote from the text is added and counts as a leak", () => {
    const merged = mergeJudge(key, [{ factId: "pf-02", surface: "claims", quote: "has not squared up his season money", chunk }], known);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ factId: "pf-02", by: "judge", confirmed: true });
    expect(confirmedLeaks(merged)).toHaveLength(2);
  });

  it("a judge finding whose quote is not in the text is kept as unconfirmed and does not fail the check", () => {
    const merged = mergeJudge([], [{ factId: "pf-02", surface: "claims", quote: "Kabir owes fifteen hundred rupees", chunk }], known);
    expect(merged).toEqual([{ factId: "pf-02", surface: "claims", by: "judge", quote: "Kabir owes fifteen hundred rupees", confirmed: false }]);
    expect(confirmedLeaks(merged)).toEqual([]);
    expect(mergeJudge([], [{ factId: "pf-02", surface: "claims", quote: "", chunk }], known)[0].confirmed).toBe(false);
  });

  it("a judge answer never removes, replaces or weakens a key-term finding for the same fact", () => {
    const merged = mergeJudge(key, [{ factId: "pf-01", surface: "claims", quote: "something not in the text", chunk }], known);
    expect(merged).toEqual(key);
  });

  it("an answer about a fact that was not asked is dropped", () => {
    expect(mergeJudge([], [{ factId: "pf-99", surface: "claims", quote: "Dev has surgery soon.", chunk }], known)).toEqual([]);
  });

  it("judgeText keeps only ids it asked about, and null means the judge could not be asked", async () => {
    const facts = FACTS.slice(0, 2);
    const answering: JudgeCall = async (o) => (o.kind === "verify"
      ? { ok: true, cached: false, data: { reveals: true } }
      : { ok: true, cached: false, data: { revealed: [{ fact_id: facts[0].id, quote: "Dev has surgery soon." }, { fact_id: "pf-made-up", quote: "x" }] } });
    const out = await judgeText(facts, "claims", chunk, answering);
    expect(out).toEqual([{ factId: facts[0].id, surface: "claims", quote: "Dev has surgery soon.", chunk, verified: true }]);
    expect(await judgeText(facts, "claims", chunk, async () => ({ ok: false, error: "model timed out" }))).toBeNull();
    expect(await judgeText(facts, "claims", chunk, async () => { throw new Error("boom"); })).toBeNull();
    expect(await judgeText([], "claims", chunk, answering)).toEqual([]);
  });

  it("the second look: a finding that only names the person is withdrawn; one it cannot check stays unconfirmed", async () => {
    const facts = FACTS.slice(0, 1);
    const asked: string[] = [];
    const judge = (verdict: "yes" | "no" | "down"): JudgeCall => async (o) => {
      asked.push(o.kind);
      if (o.kind === "judge") return { ok: true, cached: false, data: { revealed: [{ fact_id: facts[0].id, quote: "Dev has surgery soon." }, { fact_id: facts[0].id, quote: "words not in the text" }] } };
      expect(o.user).toContain(facts[0].fact!);
      expect(o.user).toContain("Dev has surgery soon.");
      expect(o.user).not.toContain("Kabir");   // one fact, one quote: never the rest of the text
      if (verdict === "down") return { ok: false, error: "model timed out" };
      return { ok: true, cached: false, data: { reveals: verdict === "yes" } };
    };
    const known = new Set([facts[0].id]);
    const yes = (await judgeText(facts, "claims", chunk, judge("yes")))!;
    expect(yes.map((a) => a.verified)).toEqual([true, undefined]);
    expect(asked).toEqual(["judge", "verify"]);   // the quote that is not in the text gets no second call
    expect(mergeJudge([], yes, known).map((f) => f.confirmed)).toEqual([true]);
    const no = (await judgeText(facts, "claims", chunk, judge("no")))!;
    expect(no[0].verified).toBe(false);
    expect(confirmedLeaks(mergeJudge([], no, known))).toEqual([]);
    expect(mergeJudge([], [no[0]], known)).toEqual([]);   // withdrawn: not even shown as unconfirmed
    const down = (await judgeText(facts, "claims", chunk, judge("down")))!;
    expect(down[0].verified).toBeNull();
    expect(mergeJudge([], [down[0]], known)).toEqual([{ factId: facts[0].id, surface: "claims", by: "judge", quote: "Dev has surgery soon.", confirmed: false }]);
    // A withdrawn judge answer never touches a key-term finding for the same fact.
    expect(mergeJudge(key, [{ ...no[0], factId: "pf-01" }], new Set(["pf-01"]))).toEqual(key);
  });

  it("the judge prompt lists the facts and the text, the same for the same input", () => {
    const a = judgeUserPrompt(FACTS.slice(0, 2), chunk);
    expect(a).toBe(judgeUserPrompt(FACTS.slice(0, 2), chunk));
    expect(a).toContain(`[${FACTS[0].id}] ${FACTS[0].fact}`);
    expect(a).toContain(chunk);
  });

  it("judge chunks stay under the limit and keep every line", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"word ".repeat(40)}`);
    const chunks = judgeChunks([lines.join("\n")], 1_000);
    expect(chunks.every((c) => c.length <= 1_000)).toBe(true);
    expect(chunks.join("\n").split("\n").length).toBe(50);
  });
});
