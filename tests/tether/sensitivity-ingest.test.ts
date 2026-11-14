// Content classifier at ingest (database). Spec 02 section 14, tests T7 to T12.
// Needs a migrated database: pnpm db:up && pnpm db:migrate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { reconstruct, verify } from "@/lib/attest";
import { createDemoWorkspace, createEmptyWorkspace, ingestSources } from "@/lib/pipeline/ingest";
import { packSensitivity, CLASSIFIER_VERSION, type SensitivityModelCall } from "@/lib/tether/sensitivity";
import { reclassify, setSegmentVisibility } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { CLUB, CLUB_ID } from "../helpers/club";

const sql = db();
const made: string[] = [];
const ALL: RoleKey[] = [...CLUB.roleOrder];
const PACK = packSensitivity(CLUB);
const HEALTH = ALL.filter((r) => PACK.roles.health.includes(r));
const FINANCE = ALL.filter((r) => PACK.roles.finance.includes(r));
const OUTSIDERS = ALL.filter((r) => !HEALTH.includes(r));

const SURGERY = "Guys, I am having knee surgery on 17 Nov and will be out for two weeks.";
const CHAT = [
  `01/11/26, 10:00 - Dev Malhotra: ${SURGERY}`,
  "01/11/26, 10:02 - Kabir Sethi: Get well soon Dev",
  "01/11/26, 10:05 - Rohan Mehta: Build day is Saturday at 5 pm in Lab 3.",
  "01/11/26, 10:40 - Priya Nair: Spare boards ordered, Rs 1,350, voucher filed.",
  "01/11/26, 11:00 - Ananya Iyer: Kabir still owes Rs 1,500 for the season fee.",
  "01/11/26, 11:30 - Priya Nair: The rollback command is in the README.",
].join("\n");
const input = [{ kind: "whatsapp" as const, name: "Core chat", roleSet: ALL, files: [{ path: "Core chat.txt", content: CHAT }] }];

/** A classifier fake: the follow-up is health, everything else is routine. Records its prompts. */
function fakeClassifier(prompts: string[]): SensitivityModelCall {
  return async (o) => {
    prompts.push(o.user);
    const items = [...o.user.matchAll(/^\[(seg_[0-9a-f]+)\] (.*)$/gm)].map((m) => ({
      segment_id: m[1], category: /get well/i.test(m[2]) ? ("health" as const) : ("none" as const),
    }));
    return { ok: true, cached: false, data: { items } };
  };
}

async function workspace(call: SensitivityModelCall | null): Promise<string> {
  const ws = await createEmptyWorkspace("sensitivity fixture", CLUB_ID);
  made.push(ws);
  await ingestSources(ws, input, "upload", { sensitivityCall: call });
  return ws;
}

const rowsOf = (ws: string) => sql`
  SELECT id, version, text, role_set, role_set_original, sensitivity, sensitivity_stage, sensitivity_reason, classifier_version
  FROM segments WHERE workspace_id = ${ws} ORDER BY ts, version`;
const find = (rows: Awaited<ReturnType<typeof rowsOf>>, needle: string) => rows.filter((r) => String(r.text).includes(needle));

afterAll(async () => {
  for (const ws of made) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("ingest narrows sensitive content before the first write", () => {
  let ws = "";
  const classifierPrompts: string[] = [];
  beforeAll(async () => {
    ws = await workspace(fakeClassifier(classifierPrompts));
  });

  it("T8: the first stored version already has the narrowed role set, with the source role set kept beside it", async () => {
    const rows = await rowsOf(ws);
    expect(rows.every((r) => Number(r.version) === 1)).toBe(true);
    const [surgery] = find(rows, "knee surgery");
    expect(surgery.role_set).toEqual(HEALTH);
    expect(surgery.role_set_original).toEqual(ALL);
    expect(surgery).toMatchObject({ sensitivity: ["health"], sensitivity_stage: "rule", classifier_version: CLASSIFIER_VERSION });
    const [owes] = find(rows, "still owes");
    expect(owes.role_set).toEqual(FINANCE);
    expect(owes.sensitivity).toEqual(["finance"]);
    const [build] = find(rows, "Build day");
    expect(build.role_set).toEqual(ALL);
    expect(build.role_set_original).toBeNull();
    expect(build.sensitivity).toEqual([]);
  });

  it("T9: the model's category narrows a borderline segment, and its none leaves the source role set", async () => {
    const rows = await rowsOf(ws);
    const [wish] = find(rows, "Get well");
    expect(wish).toMatchObject({ sensitivity: ["health"], sensitivity_stage: "model" });
    expect(wish.role_set).toEqual(HEALTH);
    const [boards] = find(rows, "Spare boards");
    expect(boards.role_set).toEqual(ALL);
    expect(boards.sensitivity).toEqual([]);
  });

  it("T10: the classifier model never sees a strong hit, only borderline segments", () => {
    expect(classifierPrompts.length).toBe(1);
    const all = classifierPrompts.join("\n");
    expect(all).toContain("Get well soon");
    expect(all).toContain("Spare boards");
    expect(all).not.toContain("surgery");
    expect(all).not.toContain("owes");
    expect(all).toContain("follows a message already limited as: health");
  });

  it("a role outside the category cannot read the row under RLS, and the count function says how many", async () => {
    for (const role of OUTSIDERS) {
      const seen = await withRole(ws, role, (tx) => tx`SELECT text FROM segments WHERE workspace_id = ${ws}`);
      expect(seen.map((r) => r.text).join("\n")).not.toContain("surgery");
      expect(seen.map((r) => r.text).join("\n")).not.toContain("Get well");
    }
    const approver = await withRole(ws, CLUB.approverRole, (tx) => tx`SELECT text FROM segments WHERE workspace_id = ${ws}`);
    expect(approver.map((r) => r.text).join("\n")).toContain("surgery");
  });

  it("the audit row holds counts only", async () => {
    const [a] = await sql`SELECT detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'classify_sensitivity'`;
    const detail = typeof a.detail === "string" ? JSON.parse(a.detail) : a.detail;
    expect(detail).toMatchObject({ segments: 6, byRule: 2, byModel: 1, held: 0, narrowed: 3 });
    expect(JSON.stringify(detail)).not.toMatch(/surgery|seg_|health/);
  });

  it("T7: no model call for a wider role set contains a limited segment, and every call holds one role set", async () => {
    const rows = await rowsOf(ws);
    const roleSetOf = new Map(rows.map((r) => [String(r.id), (r.role_set as RoleKey[]).join(",")]));
    const limited = rows.filter((r) => (r.sensitivity as string[]).length > 0);
    expect(limited.length).toBe(3);
    const calls: { system: string; user: string }[] = [];
    const spy = async (o: { system: string; user: string }) => {
      calls.push({ system: o.system, user: o.user });
      return { ok: true as const, cached: false, data: { claims: [] } };
    };
    await reconstruct(ws, { call: spy as never });
    await verify(ws, { call: spy as never });
    expect(calls.length).toBeGreaterThanOrEqual(3);   // one batch per role set of the one thread
    for (const c of calls) {
      const ids = [...new Set([...c.user.matchAll(/seg_[0-9a-f]{16}/g)].map((m) => m[0]))];
      expect(ids.length).toBeGreaterThan(0);
      const sets = new Set(ids.map((id) => roleSetOf.get(id)));
      expect(sets.size, "one role set per model call").toBe(1);
      const callRoles = [...sets][0]!.split(",");
      for (const seg of limited) {
        const allowed = seg.role_set as RoleKey[];
        const wider = callRoles.some((r) => !allowed.includes(r));
        if (!wider) continue;
        expect(c.user).not.toContain(String(seg.id));
        expect(c.user).not.toContain(String(seg.text).slice(0, 30));
      }
    }
    // The open batch really was sent, without the medical message.
    const open = calls.find((c) => c.user.includes("Build day"))!;
    expect(open.user).not.toContain("surgery");
    expect(open.user).not.toContain("Get well");
  });

  it("T11: re-ingesting the same files changes nothing and keeps an approver's widening", async () => {
    const before = await rowsOf(ws);
    const [owes] = find(before, "still owes");
    const widened = await setSegmentVisibility(ws, String(owes.id), { action: "widen", roles: "source", reason: "Routine fee reminder, fine for everyone." }, CLUB.approverRole);
    expect(widened.ok).toBe(true);
    const stored = await ingestSources(ws, input, "upload", { sensitivityCall: null });
    expect(stored[0].newSegments).toBe(0);
    const after = await rowsOf(ws);
    expect(after.length).toBe(before.length + 1);
    const versions = find(after, "still owes");
    expect(versions.map((r) => Number(r.version))).toEqual([1, 2]);
    expect(versions[1].role_set).toEqual(ALL);
    expect(versions[1].sensitivity_stage).toBe("widened");
    const seen = await withRole(ws, OUTSIDERS[0], (tx) => tx`SELECT version FROM segments WHERE workspace_id = ${ws} AND id = ${String(owes.id)}`);
    expect(seen.map((r) => Number(r.version))).toEqual([2]);
  });
});

describe("T9: fail closed when the model cannot be asked", () => {
  it("borderline segments are held for the candidate category; strong hits are still limited by rule", async () => {
    for (const call of [null, (async () => ({ ok: false as const, error: "model timed out" })) as SensitivityModelCall]) {
      const ws = await workspace(call);
      const rows = await rowsOf(ws);
      const [wish] = find(rows, "Get well");
      expect(wish).toMatchObject({ sensitivity: ["health"], sensitivity_stage: "held", sensitivity_reason: "could not be checked" });
      expect(wish.role_set).toEqual(HEALTH);
      const [boards] = find(rows, "Spare boards");
      expect(boards).toMatchObject({ sensitivity: ["finance"], sensitivity_stage: "held" });
      expect(boards.role_set).toEqual(FINANCE);
      expect(find(rows, "knee surgery")[0].sensitivity_stage).toBe("rule");
      expect(find(rows, "Build day")[0].role_set).toEqual(ALL);
    }
  });
});

describe("T12: reclassify after a rules version bump", () => {
  it("narrows a newly flagged segment as version 2, never widens, and leaves the approver's decisions alone", async () => {
    const ws = await createEmptyWorkspace("reclassify fixture", CLUB_ID);
    made.push(ws);
    await sql`INSERT INTO sources (workspace_id, id, kind, name, role_set) VALUES (${ws}, 'src_old', 'whatsapp', 'old chat', ${ALL}::text[])`;
    const old = async (id: string, text: string, extra: { stage?: string; sensitivity?: string[]; roles?: RoleKey[]; original?: RoleKey[] | null } = {}) => sql`
      INSERT INTO segments (workspace_id, id, source_id, source_kind, kind, ts, thread, text, text_hash, role_set,
        sensitivity, sensitivity_stage, role_set_original, classifier_version)
      VALUES (${ws}, ${id}, 'src_old', 'whatsapp', 'message', now(), 'old chat', ${text}, ${id}, ${extra.roles ?? ALL}::text[],
        ${extra.sensitivity ?? []}::text[], ${extra.stage ?? null}, ${extra.original ?? null}::text[], 0)`;
    await old("seg_old_strong", "My mother is in hospital, I am away this week.");
    await old("seg_old_clear", "Build day is Saturday.");
    await old("seg_old_weak", "Boards ordered, Rs 900.");
    await old("seg_old_widened", "Kabir still owes Rs 1,500 for the season fee.", { stage: "widened", sensitivity: ["finance"], original: ALL });
    await old("seg_old_limited", "Lunch is at one.", { stage: "rule", sensitivity: ["health"], roles: HEALTH, original: ALL });
    await sql`INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, role_set, valid_from, origin) VALUES
      (${ws}, 'clm_old', 'team', 'Team', 'status', 'away', 'A member is away this week.',
       ${JSON.stringify([{ segmentId: "seg_old_strong", quote: null, accepted: true, exact: false }])}::jsonb, 'from_record', ${ALL}::text[], now(), 'extracted')`;

    const first = await reclassify(ws);
    expect(first).toEqual({ looked: 4, narrowed: 1 });
    const head = async (id: string) => (await sql`SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${id} ORDER BY version DESC LIMIT 1`)[0];
    const strong = await head("seg_old_strong");
    expect(strong).toMatchObject({ version: 2, sensitivity: ["health"], sensitivity_stage: "rule", classifier_version: CLASSIFIER_VERSION });
    expect(strong.role_set).toEqual(HEALTH);
    expect(strong.role_set_original).toEqual(ALL);
    // The claim derived from it is narrowed in the same step.
    const [claim] = await sql`SELECT role_set FROM claims WHERE workspace_id = ${ws} AND id = 'clm_old'`;
    expect(claim.role_set).toEqual(HEALTH);
    // Borderline and clear segments get no new version; a limited one the rules would now clear is not widened.
    expect(Number((await head("seg_old_clear")).version)).toBe(1);
    expect(Number((await head("seg_old_weak")).version)).toBe(1);
    expect((await head("seg_old_limited")).role_set).toEqual(HEALTH);
    // The approver's widening stands, although the rules would limit that text.
    const widened = await head("seg_old_widened");
    expect(Number(widened.version)).toBe(1);
    expect(widened.role_set).toEqual(ALL);
    // A second pass has nothing to look at.
    expect(await reclassify(ws)).toEqual({ looked: 0, narrowed: 0 });
  });
});

describe("the club demo", () => {
  it("done-when 1: the planted cases are limited at ingest with the model switched off", async () => {
    const { id } = await createDemoWorkspace(CLUB_ID, { sensitivityCall: null });
    made.push(id);
    const rows = await sql`
      SELECT text, role_set, sensitivity, sensitivity_stage FROM segments
      WHERE workspace_id = ${id} AND text ~ 'CANARY-(M2DV|F9KS|H7RC)' ORDER BY ts`;
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.sensitivity_stage).toBe("rule");
      const category = (r.sensitivity as string[])[0] as keyof typeof PACK.roles;
      expect(r.role_set).toEqual(ALL.filter((x) => PACK.roles[category].includes(x)));
    }
    for (const role of CLUB.restrictedAudienceRoles) {
      const seen = await withRole(id, role, (tx) => tx`SELECT text FROM segments WHERE workspace_id = ${id}`);
      expect(seen.map((r) => r.text).join("\n")).not.toMatch(/CANARY-(M2DV|F9KS|H7RC)/);
    }
  });

  it("with the committed cache, the classifier limits exactly the planted messages and the one false positive", async () => {
    const { id } = await createDemoWorkspace(CLUB_ID);
    made.push(id);
    const rows = await sql`
      SELECT text, sensitivity_stage FROM segments
      WHERE workspace_id = ${id} AND sensitivity <> '{}' AND role_set_original IS NOT NULL ORDER BY ts`;
    expect(rows.filter((r) => r.sensitivity_stage === "held")).toEqual([]);
    expect(rows.length).toBe(9);
    expect(rows.filter((r) => r.sensitivity_stage === "rule").length).toBe(8);
    expect(rows.filter((r) => r.sensitivity_stage === "model").map((r) => String(r.text))).toEqual([expect.stringContaining("Get well soon Dev")]);
  });
});
