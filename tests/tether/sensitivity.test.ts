// Content classifier, rule stage (pure). Spec 02 section 14, tests T1 to T6, plus the model stage's
// own rules with an injected call (no network, no database).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyByRules, classifySegments, narrowForSensitivity, narrowRoleSet, nameParts, packSensitivity,
  sensitivityUserPrompt, CATEGORIES, REASONS, type RuleContext, type SensitivityModelCall,
} from "@/lib/tether/sensitivity";
import type { RoleKey, Segment, SensitivityCategory } from "@/lib/types";
import { CLUB, CLUB_DEMO_DIR } from "../helpers/club";

const PACK = packSensitivity(CLUB);
const ALL: RoleKey[] = [...CLUB.roleOrder];
const PEOPLE = ["Dev Malhotra", "Kabir Sethi", "Rohan Mehta", "Ananya Iyer", "Priya Nair", "Sneha Joshi", "Arjun Rao", "Tanvi Deshpande", "Mr. Pawar", "Dr. Kulkarni"];
const NAMES = nameParts(PEOPLE);
const AUTHORS: Record<string, string[]> = Object.fromEntries(PEOPLE.map((p, i) => [`p-${i + 1}`, nameParts([p])]));
const authorOf = (name: string) => `p-${PEOPLE.indexOf(name) + 1}`;
const CTX: RuleContext = { knownNames: NAMES, pack: PACK, authorNames: AUTHORS };

let n = 0;
function seg(text: string, over: Partial<Segment> = {}): Segment {
  n++;
  return {
    id: `seg_${String(n).padStart(4, "0")}`, sourceId: "src_chat", sourceKind: "whatsapp", kind: "message",
    ts: new Date(Date.UTC(2026, 10, 1, 10, n)).toISOString(), authorId: null, thread: "Core", position: 0,
    text, textHash: "", roleSet: [...ALL], version: 1, meta: {}, ...over,
  };
}
const one = (text: string, over: Partial<Segment> = {}) => classifyByRules([seg(text, over)], CTX)[0];

describe("T1: each strong rule fires on a minimal sentence and names its rule id", () => {
  const cases: [string, string, SensitivityCategory, string][] = [
    ["F1", "Send it to my UPI rohan.m@okhdfcbank today.", "finance", REASONS.account],
    ["F1", "Club account IFSC is HDFC0001234 for the transfer.", "finance", REASONS.account],
    ["F2", "Kabir still owes Rs 1,500 to the club.", "finance", REASONS.finance],
    ["F3", "Kabir's membership dues are still pending from August.", "finance", REASONS.finance],
    ["H1", "This is a complaint about Arjun, he shouted at me.", "hr", REASONS.hr],
    ["H2", "Honestly Arjun is lazy.", "hr", REASONS.hr],
    ["M1", "I was diagnosed with dengue.", "health", REASONS.health],
  ];
  it.each(cases)("%s: %s", (rule, text, category, reason) => {
    const d = one(text, { authorId: authorOf("Sneha Joshi") });
    expect(d.outcome).toBe("sensitive");
    expect(d.stage).toBe("rule");
    expect(d.hits).toContain(rule);
    expect(d.categories).toContain(category);
    expect(d.reason).toBe(reason);
  });

  it("an account pattern needs no person and no amount", () => {
    expect(one("PAN for the invoice: ABCDE1234F").hits).toContain("F1");
    expect(one("account number 123456789012 at the campus branch").hits).toContain("F1");
  });

  it("a complaint needs a person other than its author", () => {
    const selfOnly = one("Sneha here, I want to complain about the wifi.", { authorId: authorOf("Sneha Joshi") });
    expect(selfOnly.outcome).not.toBe("sensitive");
  });

  it("a message with two categories records both", () => {
    const d = one("Arjun insulted me again, and he still owes Rs 500 to Kabir.", { authorId: authorOf("Sneha Joshi") });
    expect(d.outcome).toBe("sensitive");
    expect(d.categories).toEqual(["finance", "hr"]);
  });
});

describe("T2 and T3: decoys and idioms are never limited by rule", () => {
  const gt = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "ground_truth.json"), "utf8")) as {
    decoys: { group: string; containsText: string; classifierPath: string }[];
  };
  const open = gt.decoys.filter((d) => d.group !== "false_positive");

  it("the answer key lists the decoys", () => {
    expect(open.length).toBeGreaterThanOrEqual(10);
  });

  it.each(open.map((d) => [d.containsText, d.classifierPath] as const))("decoy stays open: %s", (text, expected) => {
    const d = one(text);
    expect(d.outcome).not.toBe("sensitive");
    if (expected === "clear") expect(d.outcome).toBe("clear");
    if (expected === "borderline_then_open") expect(d.outcome).toBe("borderline");
  });

  it.each([
    "I am sick of this USB cable drama",
    "this PID bug is a headache",
    "PSA: the first aid kit is in the grey cupboard in Lab 3",
    "Excitement is at fever pitch for the home competition",
    "Tuning the PID by hand is a pain to do",
    "The left motor is burnt out, we need a new one",
    "Soldering clinic for the first years on Saturday at 11",
    "motor driver got hot again",
    "Late registration costs double, do not miss the entry fee deadline",
    "The price of filament went up again",
  ])("idiom or equipment talk is clear: %s", (text) => {
    expect(one(text).outcome).toBe("clear");
  });

  it("a single weak term alone is clear, two weak terms or an amount alone are borderline", () => {
    expect(one("All reimbursements go through me, please keep the bills").outcome).toBe("clear");
    expect(one("The entry fee is a yearly payment.").outcome).toBe("borderline");
    expect(one("Boards ordered, Rs 1,350.").outcome).toBe("borderline");
  });

  it("the deliberate false positive is limited by rule (a named person's payment with an amount)", () => {
    const fp = gt.decoys.find((d) => d.group === "false_positive")!;
    const d = one(fp.containsText, { authorId: authorOf("Ananya Iyer") });
    expect(d.outcome).toBe("sensitive");
    expect(d.categories).toEqual(["finance"]);
    expect(d.hits).toContain("F2");
  });

  it("repository files only honour strong rules", () => {
    expect(one("fee: 100\npayment: monthly\nbudget: 5", { kind: "file", sourceKind: "github" }).outcome).toBe("clear");
    expect(one("# paid to HDFC0001234", { kind: "file", sourceKind: "github" }).outcome).toBe("sensitive");
  });

  it("a name counts only when written as a name in mixed-case text", () => {
    // "dev boards" is not Dev.
    const d = one("Spare ESP32 dev boards are lazy to boot.");
    expect(d.hits).not.toContain("H2");
  });
});

describe("T4: follow-up rules", () => {
  it("R1: a reply to a limited message inherits its categories, and so does a reply to the reply", () => {
    const parent = seg("I was diagnosed with dengue, out this week.", { sourceKind: "slack", thread: "#general" });
    const child = seg("ok noted", { sourceKind: "slack", thread: "#general", meta: { replyTo: parent.id } });
    const grandchild = seg("thanks", { sourceKind: "slack", thread: "#general", meta: { replyTo: child.id } });
    const other = seg("build at 5", { sourceKind: "slack", thread: "#general" });
    const [p, c, g, o] = classifyByRules([parent, child, grandchild, other], CTX);
    expect(p.outcome).toBe("sensitive");
    expect(c).toMatchObject({ outcome: "sensitive", stage: "follow", categories: ["health"], reason: REASONS.follow });
    expect(g).toMatchObject({ outcome: "sensitive", stage: "follow" });
    expect(o.outcome).toBe("clear");
  });

  it("R2: in a chat with no reply links, a follow-up with a cue inside the window is borderline", () => {
    const t = (min: number) => new Date(Date.UTC(2026, 10, 4, 13, 50 + min)).toISOString();
    const parent = seg("Guys, I am having knee surgery on 17 Nov and will be out for two weeks.", { ts: t(0), authorId: authorOf("Dev Malhotra") });
    const wish = seg("Get well soon Dev, speedy recovery bro", { ts: t(3) });
    const plain = seg("I will sort your trial slot, don't worry.", { ts: t(6) });
    const late = seg("Get well soon!", { ts: t(45) });
    const [p, w, pl, l] = classifyByRules([parent, wish, plain, late], CTX);
    expect(p.outcome).toBe("sensitive");
    expect(w).toMatchObject({ outcome: "borderline", categories: ["health"] });
    expect(w.hits).toContain("R2");
    expect(pl.outcome).toBe("clear");
    expect(l.outcome).toBe("clear");
  });

  it("R2 reaches only the next four messages", () => {
    const t = (min: number) => new Date(Date.UTC(2026, 10, 4, 14, min)).toISOString();
    const parent = seg("My mother is in hospital this week.", { ts: t(0) });
    const fill = [1, 2, 3, 4].map((m) => seg(`build note ${m}`, { ts: t(m) }));
    const fifth = seg("take care", { ts: t(5) });
    const out = classifyByRules([parent, ...fill, fifth], CTX);
    expect(out[0].outcome).toBe("sensitive");
    expect(out[5].outcome).toBe("clear");
  });
});

describe("T5: narrowRoleSet never adds a role", () => {
  const subsets = (xs: RoleKey[]): RoleKey[][] => xs.reduce<RoleKey[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);
  const mixes = subsets([...CATEGORIES] as string[]) as SensitivityCategory[][];

  it("for every role set and every category mix the result is a subset of the input", () => {
    for (const current of subsets(ALL)) {
      for (const cats of mixes) {
        const out = narrowRoleSet(current, cats, PACK);
        // The one exception is the approver, when no role of the input may see the content.
        expect(out.every((r) => current.includes(r) || (r === CLUB.approverRole && out.length === 1))).toBe(true);
      }
    }
  });

  it("several categories give the intersection of their lists", () => {
    expect(narrowRoleSet(ALL, ["finance"], PACK)).toEqual(ALL.filter((r) => PACK.roles.finance.includes(r)));
    expect(narrowRoleSet(ALL, ["finance", "hr"], PACK)).toEqual(ALL.filter((r) => PACK.roles.finance.includes(r) && PACK.roles.hr.includes(r)));
  });

  it("an empty intersection fails closed: the approver alone, never the unchanged set (review finding a)", () => {
    const outsiders = ALL.filter((r) => !PACK.roles.hr.includes(r) && r !== CLUB.approverRole).slice(0, 2);
    expect(outsiders.length).toBeGreaterThan(0);
    // Before the fix this returned `outsiders`: HR content stayed readable by roles the pack keeps it from.
    expect(narrowRoleSet(outsiders, ["hr"], PACK)).toEqual([CLUB.approverRole]);
    // No role of the input that is outside the category survives, for any category mix.
    for (const current of subsets(ALL)) {
      for (const cats of mixes) {
        if (cats.length === 0) continue;
        const out = narrowRoleSet(current, cats, PACK);
        const allowed = (r: RoleKey) => cats.every((c) => PACK.roles[c].includes(r));
        expect(out.every((r) => allowed(r) || r === CLUB.approverRole)).toBe(true);
        if (current.length > 0) expect(out.length).toBeGreaterThan(0);
      }
    }
    // A pack that names no approver limits such content to nobody.
    expect(narrowRoleSet(outsiders, ["hr"], { roles: PACK.roles })).toEqual([]);
    // No category: nothing to limit.
    expect(narrowRoleSet(outsiders, [], PACK)).toEqual(outsiders);
  });

  it("a pack with no sensitivity map keeps every category for its approver", () => {
    const bare = packSensitivity({ approverRole: CLUB.approverRole });
    for (const c of CATEGORIES) expect(bare.roles[c]).toEqual([CLUB.approverRole]);
  });
});

describe("T6: the three planted cases are limited by rule alone, with the model off", () => {
  const gt = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "ground_truth.json"), "utf8")) as {
    sensitive: { id: string; case: string; category: SensitivityCategory; expectedRoles: RoleKey[]; stage: string; author: string; containsText: string }[];
  };
  const byRule = gt.sensitive.filter((s) => s.stage === "rule");

  it("the answer key holds cases A, B and C", () => {
    expect(new Set(byRule.map((s) => s.case))).toEqual(new Set(["A", "B", "C"]));
  });

  it.each(byRule.map((s) => [s.id, s] as const))("%s is sensitive and narrows to the planted roles", (_id, s) => {
    const d = one(s.containsText, { authorId: authorOf(s.author) });
    expect(d.outcome).toBe("sensitive");
    expect(d.stage).toBe("rule");
    expect(d.categories).toEqual([s.category]);
    expect(narrowRoleSet(ALL, d.categories, PACK)).toEqual(ALL.filter((r) => s.expectedRoles.includes(r)));
  });
});

describe("model stage, with an injected call", () => {
  const answer = (map: (id: string) => string): SensitivityModelCall => async (o) => {
    const ids = [...o.user.matchAll(/^\[(seg_[^\]]+)\]/gm)].map((m) => m[1]);
    return { ok: true, cached: false, data: { items: ids.map((id) => ({ segment_id: id, category: map(id) as "none" })) } };
  };
  const strong = () => seg("Kabir still owes Rs 1,500 to the club.");
  const weak = () => seg("Boards ordered, Rs 1,350, voucher filed.");
  const opts = { knownNames: NAMES, authorNames: AUTHORS };

  it("a category narrows the segment; none leaves it with the source role set", async () => {
    const a = weak();
    const b = weak();
    const { segments, report } = await classifySegments([a, b], PACK, { ...opts, call: answer((id) => (id === a.id ? "finance" : "none")) });
    expect(segments[0]).toMatchObject({ sensitivity: ["finance"], sensitivityStage: "model", roleSetOriginal: ALL });
    expect(segments[0].roleSet).toEqual(ALL.filter((r) => PACK.roles.finance.includes(r)));
    expect(segments[1]).toMatchObject({ sensitivity: [], sensitivityStage: null, roleSetOriginal: null, roleSet: ALL });
    expect(report).toMatchObject({ borderline: 2, byModel: 1, clearedByModel: 1, held: 0 });
  });

  it("fail closed: no call, a failed call, a thrown call or a missing answer holds the segment", async () => {
    const calls: (SensitivityModelCall | undefined)[] = [
      undefined,
      async () => ({ ok: false, error: "model timed out" }),
      async () => { throw new Error("boom"); },
      async () => ({ ok: true, cached: false, data: { items: [] } }),
      async () => ({ ok: true, cached: false, data: { items: [{ segment_id: "x", category: "widen" }] } as never }),
    ];
    for (const call of calls) {
      const { segments, report } = await classifySegments([weak()], PACK, { ...opts, call });
      expect(segments[0]).toMatchObject({ sensitivity: ["finance"], sensitivityStage: "held", sensitivityReason: REASONS.held });
      expect(segments[0].roleSet).toEqual(ALL.filter((r) => PACK.roles.finance.includes(r)));
      expect(report.held).toBe(1);
    }
  });

  it("the budget holds what was not asked in time", async () => {
    let t = 0;
    const { segments } = await classifySegments([weak()], PACK, { ...opts, call: answer(() => "none"), budgetMs: 10, now: () => (t += 20) });
    expect(segments[0].sensitivityStage).toBe("held");
  });

  it("T10: the model is never sent a strong hit, and an id outside the batch is ignored", async () => {
    const s = strong();
    const w = weak();
    const prompts: string[] = [];
    const call: SensitivityModelCall = async (o) => {
      prompts.push(o.user);
      return { ok: true, cached: false, data: { items: [{ segment_id: w.id, category: "none" }, { segment_id: s.id, category: "none" }, { segment_id: "seg_other", category: "health" }] } };
    };
    const { segments } = await classifySegments([s, w], PACK, { ...opts, call });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(w.id);
    expect(prompts[0]).not.toContain(s.id);
    expect(prompts[0]).not.toContain("owes");
    expect(segments[0]).toMatchObject({ sensitivity: ["finance"], sensitivityStage: "rule" });
    expect(segments[1].sensitivity).toEqual([]);
  });

  it("a batch never mixes sources or role sets, and prompts are the same for the same input", async () => {
    const narrow = ALL.slice(0, 4);
    const input = [weak(), seg("Boards ordered, Rs 900.", { roleSet: narrow }), seg("Boards ordered, Rs 700.", { sourceId: "src_other" })];
    const run = async () => {
      const prompts: string[] = [];
      await classifySegments(input, PACK, { ...opts, call: async (o) => { prompts.push(o.user); return { ok: false, error: "x" }; } });
      return prompts.sort();
    };
    const first = await run();
    expect(first).toHaveLength(3);
    expect(await run()).toEqual(first);
  });

  it("an R2 follow-up carries a hint, never the parent's text", () => {
    const parent = seg("I was diagnosed with dengue.");
    const child = seg("Get well soon");
    const [, d] = classifyByRules([parent, child], CTX);
    const prompt = sensitivityUserPrompt([{ seg: child, decision: d, follows: d.categories }]);
    expect(prompt).toContain("follows a message already limited as: health");
    expect(prompt).not.toContain("dengue");
  });

  it("a borderline segment whose role set no category would cut is not sent at all", async () => {
    let asked = 0;
    const call: SensitivityModelCall = async () => { asked++; return { ok: false, error: "x" }; };
    const { segments } = await classifySegments([seg("Boards ordered, Rs 900.", { roleSet: [...PACK.roles.finance] })], PACK, { ...opts, call });
    expect(asked).toBe(0);
    expect(segments[0].sensitivity).toEqual([]);
  });
});

describe("narrowForSensitivity (segments made outside ingest)", () => {
  it("a strong hit narrows, a borderline one is held, a clear one is untouched", () => {
    const strong = narrowForSensitivity("I am in hospital until Friday.", "answer", ALL, PACK, NAMES);
    expect(strong).toMatchObject({ categories: ["health"], stage: "rule", roleSetOriginal: ALL });
    expect(strong.roleSet).toEqual(ALL.filter((r) => PACK.roles.health.includes(r)));
    const held = narrowForSensitivity("The quote is Rs 18,400.", "answer", ALL, PACK, NAMES);
    expect(held).toMatchObject({ categories: ["finance"], stage: "held", reason: REASONS.held });
    const clear = narrowForSensitivity("Flash with the rollback flag.", "answer", ALL, PACK, NAMES);
    expect(clear).toEqual({ roleSet: ALL, categories: [], stage: null, reason: null, roleSetOriginal: null });
  });

  it("never returns a role that was not passed in, except the approver when nobody passed in may read it", () => {
    const two = ALL.slice(1, 3);
    const out = narrowForSensitivity("I am in hospital until Friday.", "answer", two, PACK, NAMES);
    expect(out.roleSet.every((r) => two.includes(r) || r === CLUB.approverRole)).toBe(true);
    // Health content is never left with roles outside the pack's health list (it used to be: fail open).
    expect(out.roleSet.every((r) => PACK.roles.health.includes(r))).toBe(true);
    expect(out.roleSet.length).toBeGreaterThan(0);
  });
});
