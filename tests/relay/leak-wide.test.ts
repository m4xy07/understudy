// The wider leak check on the club demo: five roles, every surface, exact tokens and reworded
// facts. Spec 02 section 14, tests T26 to T28. Needs a migrated, seeded database and data/demo.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { reconstruct, verify } from "@/lib/attest";
import { listBlockingGaps, savePlanItem } from "@/lib/lacuna";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { approveSnapshot, compileHandover, exportMarkdown, latestProbeRun, runLeakCheck, runProbes } from "@/lib/relay";
import type { JudgeCall } from "@/lib/relay/probes";
import { EXTERNAL_SURFACES } from "@/lib/relay/surface-sources";
import { collectSurfaces, LEAK_SURFACES } from "@/lib/relay/surfaces";
import { setSegmentVisibility } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { CLUB, CLUB_DEMO_DIR, CLUB_ID } from "../helpers/club";

const sql = db();
let ws = "";
const ALL: RoleKey[] = [...CLUB.roleOrder];
const APPROVER = CLUB.approverRole;
// Recovery's four columns are wired in (surface-sources.ts) and empty while recovery is off.
const RECOVERY_COLUMNS = ["graph", "neighbour_questions", "traces", "ranked_options"];
const BUILT = LEAK_SURFACES.filter((s) => !RECOVERY_COLUMNS.includes(s));
const WIRED = { ...EXTERNAL_SURFACES };
const PROBES = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "probes.json"), "utf8")) as {
  facts: { id: string; fact: string; roleSet: RoleKey[]; rewordings: string[] }[];
};
const GT = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "ground_truth.json"), "utf8")) as {
  restricted: { token: string; roleSet: RoleKey[] }[];
  sensitive: { id: string; containsText: string }[];
};

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  const { runId } = await startRun(ws);
  expect((await executeRun(ws, runId))?.status).toBe("done");
  for (const g of await listBlockingGaps(ws)) {
    await savePlanItem(ws, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Rohan Mehta", dueDate: "2026-11-30", riskNote: "Open at handover." }, APPROVER);
  }
  // Test setup only: every live claim counts as reviewed, so the snapshot holds the whole ledger.
  await sql`UPDATE claims SET review = 'approved' WHERE workspace_id = ${ws} AND state NOT IN ('dropped', 'superseded')`;
  const snap = await approveSnapshot(ws, APPROVER);
  expect(snap.ok, snap.ok ? "" : snap.error).toBe(true);
}, 180_000);

afterAll(async () => {
  Object.assign(EXTERNAL_SURFACES, WIRED);
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("T26: the grid on the demo workspace", () => {
  it("five roles, every surface, both rows: zero leaks; every column is built, empty ones are not counted as passes", async () => {
    const r = await runLeakCheck(ws);
    expect(r.source).toBe("ground_truth");
    expect(r.tokenCount).toBe(GT.restricted.length);
    expect(r.factCount).toBe(PROBES.facts.length);
    expect(r.compiled).toBe(true);
    expect(r.rows).toEqual(["token", "probe"]);
    expect(r.surfaces.map((s) => s.key)).toEqual([...LEAK_SURFACES]);
    expect(r.cells.length).toBe(ALL.length * LEAK_SURFACES.length * 2);
    expect(r.findings).toEqual([]);
    expect(r.cells.filter((c) => c.leaks > 0)).toEqual([]);
    expect(r.allPass).toBe(true);
    expect(r.failed).toBe(0);

    for (const s of r.surfaces) expect(s.built, s.key).toBe(true);
    // Recovery is off in this workspace: its columns are built and have nothing to check.
    const recovery = r.cells.filter((c) => RECOVERY_COLUMNS.includes(c.surface));
    expect(recovery.every((c) => c.built && c.texts === 0)).toBe(true);
    const counted = r.cells.filter((c) => c.built && c.texts > 0);
    expect(r.checks).toBe(counted.length);
    expect(counted.some((c) => RECOVERY_COLUMNS.includes(c.surface))).toBe(false);

    // The check really read something on every built surface for the role that sees least.
    for (const role of CLUB.restrictedAudienceRoles) {
      for (const surface of BUILT) {
        const token = r.cells.find((c) => c.role === role && c.surface === surface && c.row === "token")!;
        expect(token.texts, `${role} ${surface}`).toBeGreaterThan(0);
      }
      expect(r.cells.find((c) => c.role === role && c.surface === "claims" && c.row === "token")!.texts).toBeGreaterThan(20);
    }
    // The approver may see every fact: the probe row has nothing to check for it.
    expect(r.cells.filter((c) => c.role === APPROVER && c.row === "probe").every((c) => c.texts === 0)).toBe(true);
    expect(r.roles.find((x) => x.key === APPROVER)).toMatchObject({ maySee: GT.restricted.length, maySeeFacts: PROBES.facts.length });
    expect(r.judge).toEqual({ used: false, at: null });
    expect(r.textsChecked).toBeGreaterThan(500);
  });

  it("each role's sensitive panel text holds only what that role may read", async () => {
    for (const role of ALL) {
      const surfaces = await collectSurfaces(ws, role, await compileHandover(ws, role));
      const panel = surfaces.find((s) => s.key === "sensitive_panel")!.texts.map((t) => t.text).join("\n");
      const mayHealth = CLUB.sensitivity!.health.includes(role);
      expect(panel.includes("knee surgery"), role).toBe(mayHealth);
      if (role !== APPROVER) expect(panel).toMatch(/limited to fewer roles\. Ask the approver/);
    }
  });

  it("a column whose module is not wired in reads Not built and is left out of the count", async () => {
    EXTERNAL_SURFACES.recoverySurfaces = undefined;
    EXTERNAL_SURFACES.changeTexts = undefined;
    try {
      const r = await runLeakCheck(ws);
      const off = [...RECOVERY_COLUMNS, "changes"];
      for (const s of r.surfaces) expect(s.built, s.key).toBe(!off.includes(s.key));
      expect(r.cells.filter((c) => off.includes(c.surface)).every((c) => !c.built && c.texts === 0)).toBe(true);
      expect(r.checks).toBe(r.cells.filter((c) => c.built && c.texts > 0).length);
      expect(r.allPass).toBe(true);
    } finally {
      Object.assign(EXTERNAL_SURFACES, WIRED);
    }
  });

  it("a registered surface is checked like any other, and a leak in it turns its column red", async () => {
    EXTERNAL_SURFACES.recoverySurfaces = async (_ws, role) => [
      { surface: "graph", text: "Arjun replied in 14 threads about firmware." },
      { surface: "traces", text: role === "new_member" ? `Trace cites ${GT.restricted[0].token}` : "Trace cites the workflow file." },
    ];
    EXTERNAL_SURFACES.changeTexts = async () => ["Late access: next due 18 Nov 2026."];
    try {
      const r = await runLeakCheck(ws);
      expect(r.surfaces.filter((s) => !s.built).map((s) => s.key)).toEqual([]);
      const bad = r.cells.filter((c) => c.leaks > 0);
      expect(bad.map((c) => `${c.role}/${c.surface}/${c.row}`)).toEqual(["new_member/traces/token"]);
      expect(r.cells.find((c) => c.role === "new_member" && c.surface === "graph" && c.row === "token")).toMatchObject({ built: true, texts: 1, leaks: 0 });
      expect(r.allPass).toBe(false);
    } finally {
      Object.assign(EXTERNAL_SURFACES, WIRED);
    }
  });
});

describe("the model judge in the grid (injected call)", () => {
  it("a stored judge finding with a real quote fails its cell; one with an invented quote is shown as unconfirmed only", async () => {
    const [fact, other] = PROBES.facts.filter((f) => !f.roleSet.includes("new_member"));
    let asked = 0;
    let invented = false;
    const judge: JudgeCall = async (o) => {
      if (o.kind === "verify") return { ok: true, cached: false, data: { reveals: true } };
      asked++;
      // "Reveals" the fact wherever the text names the release state; elsewhere invents a quote once.
      const m = /Released with \d+ open blocking gaps?/.exec(o.user);
      if (m && o.user.includes(`[${fact.id}]`)) return { ok: true, cached: false, data: { revealed: [{ fact_id: fact.id, quote: m[0] }] } };
      if (invented || !o.user.includes(`[${other.id}]`)) return { ok: true, cached: false, data: { revealed: [] } };
      invented = true;
      return { ok: true, cached: false, data: { revealed: [{ fact_id: other.id, quote: "words that are nowhere in the text" }] } };
    };
    const { run, report } = await runProbes(ws, APPROVER, { call: judge });
    expect(asked).toBeGreaterThan(10);
    expect(run.judgeUsed).toBe(true);
    expect(report.judge.used).toBe(true);
    const judged = report.findings.filter((f) => f.by === "judge");
    expect(judged.filter((f) => f.confirmed).length).toBeGreaterThan(0);
    expect(judged.filter((f) => !f.confirmed).length).toBe(1);
    expect(report.allPass).toBe(false);
    expect(report.cells.filter((c) => c.row === "token" && c.leaks > 0)).toEqual([]);
    // The invented quote is shown as unconfirmed and fails nothing: only cells with a real quote fail.
    expect(report.cells.reduce((n, c) => n + c.unconfirmed, 0)).toBe(1);
    expect(judged.find((f) => !f.confirmed)).toMatchObject({ item: other.id });
    expect(report.failed).toBe(report.cells.filter((c) => c.leaks > 0).length);
    expect(report.findings.filter((f) => f.confirmed).every((f) => f.item === fact.id)).toBe(true);

    // The page grid merges the stored judge findings; with the judge off it is the key-term result again.
    const stored = await latestProbeRun(ws);
    expect(stored?.id).toBe(run.id);
    const merged = await runLeakCheck(ws);
    expect(merged.judge.used).toBe(true);
    expect(merged.failed).toBe(report.failed);
    const plain = await runLeakCheck(ws, { judge: "off" });
    expect(plain.allPass).toBe(true);
    const [a] = await sql`SELECT detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'run_probes'`;
    expect(a).toBeTruthy();
    await sql`DELETE FROM probe_runs WHERE workspace_id = ${ws}`;
  });

  it("a judge that cannot be asked leaves the key-term result and says so", async () => {
    const { run, report } = await runProbes(ws, APPROVER, { call: async () => ({ ok: false, error: "model timed out" }) });
    expect(run.judgeUsed).toBe(false);
    expect(run.summary.judgeFailed).toBe(run.summary.judgeCalls);
    expect(report.allPass).toBe(true);
    await sql`DELETE FROM probe_runs WHERE workspace_id = ${ws}`;
  });
});

describe("T28: the export guard", () => {
  it("refuses an export that would contain a reworded restricted fact, with no token in it", async () => {
    const ok = await exportMarkdown(ws, "new_member");
    expect(ok.ok).toBe(true);
    const fact = PROBES.facts.find((f) => !f.roleSet.includes("new_member"))!;
    const [snap] = await sql`SELECT id FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
    await sql`INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, entity_label, attribute, statement, value, trust, role_set)
      VALUES (${ws}, ${String(snap.id)}, 'clm_reworded', 'team-selection', 'Drive team selection', 'risk', ${fact.rewordings[0]}, ${fact.rewordings[0]}, 'inferred', ${ALL}::text[])`;
    try {
      expect(fact.rewordings[0]).not.toMatch(/CANARY/i);
      const blocked = await exportMarkdown(ws, "new_member");
      expect(blocked).toMatchObject({ ok: false, status: 500, error: "Export blocked: the leak check found a restricted fact in this export." });
      const [a] = await sql`SELECT detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'export_blocked' ORDER BY id DESC LIMIT 1`;
      const detail = typeof a.detail === "string" ? JSON.parse(a.detail) : a.detail;
      expect(detail).toMatchObject({ role: "new_member", leaks: 0, reworded: 1 });
      // The grid sees the same thing: tokens stay green, the reworded-fact row goes red.
      const r = await runLeakCheck(ws);
      const cell = (row: "token" | "probe", surface: string) => r.cells.find((c) => c.role === "new_member" && c.surface === surface && c.row === row)!;
      expect(cell("token", "export").leaks).toBe(0);
      expect(cell("probe", "export").leaks).toBe(1);
      expect(cell("probe", "handover").leaks).toBe(1);
      expect(r.allPass).toBe(false);
      // A role that may see the fact still gets its export.
      expect((await exportMarkdown(ws, APPROVER)).ok).toBe(true);
    } finally {
      await sql`DELETE FROM snapshot_claims WHERE workspace_id = ${ws} AND claim_id = 'clm_reworded'`;
    }
    expect((await runLeakCheck(ws)).allPass).toBe(true);
  });
});

describe("T27: mutation check", () => {
  it("widening the medical message to everyone turns the grid red in both rows for the new member", async () => {
    const planted = GT.sensitive.find((x) => x.id === "sv-A1")!;
    const [seg] = await sql`SELECT id FROM segments WHERE workspace_id = ${ws} AND position(${planted.containsText} in text) > 0 LIMIT 1`;
    const segId = String(seg.id);
    const res = await setSegmentVisibility(ws, segId, { action: "widen", roles: "source", reason: "Mutation check: this must make the grid fail." }, APPROVER);
    expect(res.ok).toBe(true);
    // The re-run: extraction now reads the message in the open batch and writes a claim from it,
    // in its own words. (The model is off in tests, so the answer for that batch is injected.)
    const open = async (o: { user: string }) => ({
      ok: true as const, cached: false,
      data: {
        claims: o.user.includes(segId) ? [{
          entity: "team-selection", attribute: "risk", value: "Dev out from 17 Nov",
          statement: "Dev Malhotra has knee surgery on 17 Nov 2026 and misses his drive team trial (CANARY-M2DV).",
          citations: [{ segment_id: segId, quote: "I am having knee surgery on 17 Nov 2026" }],
        }] : [],
      },
    });
    await reconstruct(ws, { call: open as never });
    await verify(ws, { support: false });

    const r = await runLeakCheck(ws, { judge: "off" });
    expect(r.allPass).toBe(false);
    const bad = r.cells.filter((c) => c.role === "new_member" && c.leaks > 0);
    expect(bad.map((c) => `${c.surface}/${c.row}`).sort()).toEqual(["claims/probe", "claims/token"]);
    const finding = r.findings.find((f) => f.role === "new_member" && f.row === "probe")!;
    expect(finding).toMatchObject({ surface: "claims", item: "pf-01", by: "key_terms", confirmed: true });
    // Roles that may see the health case stay green.
    expect(r.cells.filter((c) => c.role === APPROVER && c.leaks > 0)).toEqual([]);

    // Limiting it again narrows the claim at once, with no re-run, and the grid is green again.
    const back = await setSegmentVisibility(ws, segId, { action: "limit", categories: ["health"], reason: "End of the mutation check." }, APPROVER);
    expect(back.ok).toBe(true);
    expect((await runLeakCheck(ws, { judge: "off" })).allPass).toBe(true);
  });
});
