// The whole product on every demo pack, with the model off and the pack's committed model cache.
// One suite, run once per id in packs/index.json: a second setting is one more row, not a special
// case. Nothing below names a role, a person or an entity: every expectation is read from the pack
// (packs/<id>.json) or from the demo's answer key (<demo.dataDir>/ground_truth.json).
// Needs a migrated database (pnpm db:up && pnpm db:migrate). Seeds the pack's cache rows itself.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { getExtraction } from "@/lib/attest";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import { getLatestTestRun, listClaims, listGapQuestions } from "@/lib/db/queries";
import { answerQuestion, listBlockingGaps, savePlanItem } from "@/lib/lacuna";
import { approveSnapshot, bulkApprove, compileHandover, reviewClaim, stubLine } from "@/lib/relay";
import { checkHandoverReadback, exportMarkdown, resolveReadbackItems, runLeakCheck } from "@/lib/relay/handover";
import { cacheOutputText, modelTag } from "@/lib/model/client";
import { getPack, getWorkspacePack, listDemoPacks, roleLabel } from "@/lib/pack";

interface AnswerKey {
  responsibilities: { key: string; title: string; kind: string; entities: string[] }[];
  claims: { id: string }[];
  restricted: { token: string; roleSet: string[] }[];
  secrets: { type: string; value: string }[];
  readback: { key: string; expected: string }[];
  demoAnswer?: { text: string };
}
interface CacheRow { input_hash: string; model_tag: string; output: unknown }

const sql = db();
const cacheFile = (dataDir: string) => path.join(process.cwd(), dataDir, "model_cache.json");
// A pack takes part once its demo has a committed cache (written by scripts/precompute.ts --pack <id>).
const PACKS = listDemoPacks().filter((p) => fs.existsSync(cacheFile(p.demo.dataDir))).map((p) => ({ id: p.id }));

afterAll(async () => {
  await sql.end();
});

describe.each(PACKS)("pipeline on the $id pack: model off, committed cache", ({ id }) => {
  const pack = getPack(id);
  const key = JSON.parse(fs.readFileSync(path.join(process.cwd(), pack.demo!.dataDir, "ground_truth.json"), "utf8")) as AnswerKey;
  const approver = pack.approverRole;
  const successor = pack.successorRole;
  const leaver = pack.leaverRole;
  const least = pack.restrictedAudienceRoles[0];
  const approverLabel = roleLabel(approver, pack);
  let ws = "";

  beforeAll(async () => {
    const rows = JSON.parse(fs.readFileSync(cacheFile(pack.demo!.dataDir), "utf8")) as CacheRow[];
    expect(rows.length).toBeGreaterThan(0);
    // The committed answers must be for the model tag the tests run under, or nothing replays.
    expect(new Set(rows.map((r) => r.model_tag))).toEqual(new Set([modelTag()]));
    for (const r of rows) {
      await sql`
        INSERT INTO model_cache (input_hash, model_tag, output)
        VALUES (${r.input_hash}, ${r.model_tag}, ${cacheOutputText(r.output)}::jsonb)
        ON CONFLICT (input_hash) DO UPDATE SET output = EXCLUDED.output, model_tag = EXCLUDED.model_tag
          WHERE model_cache.output IS DISTINCT FROM EXCLUDED.output`;
    }
    ws = (await createDemoWorkspace(id)).id;
    const { runId } = await startRun(ws);
    const run = await executeRun(ws, runId);
    expect(run?.status).toBe("done");
  }, 180_000);

  afterAll(async () => {
    if (!ws) return;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  });

  it("the workspace knows its pack and its approver", async () => {
    expect((await getWorkspacePack(ws)).id).toBe(id);
    const [w] = await sql`SELECT pack_id, approver_role, leaver_role FROM workspaces WHERE id = ${ws}`;
    expect([w.pack_id, w.approver_role, w.leaver_role]).toEqual([id, approver, leaver]);
  });

  it("every extraction batch replays from the committed cache; no planted secret is stored", async () => {
    const batches = (await getExtraction(ws))?.batches ?? [];
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.filter((b) => !b.ok).map((b) => b.thread)).toEqual([]);
    expect(batches.filter((b) => !b.cached).map((b) => b.thread)).toEqual([]);
    const segs = await sql`SELECT text FROM segments WHERE workspace_id = ${ws}`;
    const claims = await sql`SELECT value, statement FROM claims WHERE workspace_id = ${ws}`;
    const stored = [...segs.map((s) => String(s.text)), ...claims.map((c) => `${c.value} ${c.statement}`)].join("\n");
    for (const s of key.secrets.filter((x) => !x.type.startsWith("contact_"))) {
      expect(stored.includes(s.value), `planted ${s.type} is stored unmasked`).toBe(false);
    }
  });

  it("claims are cited and only use this pack's roles", async () => {
    const claims = await listClaims(ws);
    expect(claims.length).toBeGreaterThan(key.claims.length / 2);
    expect(claims.every((c) => c.citations.length > 0)).toBe(true);
    const roles = new Set(pack.roleOrder);
    expect(claims.flatMap((c) => c.roleSet).filter((r) => !roles.has(r))).toEqual([]);
    const entities = new Set(pack.entities.map((e) => e.key));
    expect(claims.filter((c) => entities.has(c.entity)).length).toBeGreaterThan(claims.length / 2);
  });

  it("the inventory finds the answer key's responsibilities", async () => {
    const rows = await sql`SELECT key, title, kind, entities FROM responsibilities WHERE workspace_id = ${ws} ORDER BY key`;
    expect(rows.length).toBe(key.responsibilities.length);
    const sig = (r: { kind?: unknown; entities?: unknown }) => `${String(r.kind)}:${[...(r.entities as string[])].sort().join(",")}`;
    expect(rows.map((r) => sig(r)).sort()).toEqual(key.responsibilities.map(sig).sort());
  });

  it("every tested role has a test run with B, C, K; at most ten questions, none leaking a token", async () => {
    for (const role of pack.testRoles) {
      const run = await getLatestTestRun(ws, role);
      expect(run, role).not.toBeNull();
      expect(run!.scores.b).toBeGreaterThanOrEqual(0);
      expect(run!.scores.c).toBeGreaterThanOrEqual(0);
    }
    const qs = await listGapQuestions(ws);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(10);
    expect(qs.map((q) => q.text).join("\n")).not.toMatch(/CANARY-/i);
  });

  it("the evaluation reads this pack's answer key; no secret and no restricted token leaks", async () => {
    const e = await evaluateWorkspace(ws);
    expect(e.report.recall.den).toBe(key.claims.length);
    expect(e.report.recall.num).toBeGreaterThan(0);
    expect(e.report.secretsLeaked.count).toBe(0);
    expect(e.report.restrictedViolations.count).toBe(0);
    expect(e.failedBatches).toBe(0);
  });

  it("only the leaver answers; the answer raises C and never K", async () => {
    const [q] = (await listGapQuestions(ws)).filter((x) => !x.answeredClaimId);
    expect((await answerQuestion(ws, q.id, "Some answer", approver)).ok).toBe(false);
    expect((await answerQuestion(ws, q.id, "Some answer", successor)).ok).toBe(false);
    const text = key.demoAnswer?.text ?? String(pack.demo!.sampleAnswer ?? "I handed it over in person. Ask the new owner.");
    const res = await answerQuestion(ws, q.id, text, leaver);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.after.c).toBeGreaterThanOrEqual(res.before!.c);
    if (res.before!.k !== null && res.after.k !== null) expect(res.after.k).toBeLessThanOrEqual(res.before!.k);
    expect((await listClaims(ws)).find((c) => c.id === res.claimId)!.trust).toBe("leaver_said");
  });

  it("the leaver can never approve, and nobody but the approver can", async () => {
    for (const role of pack.roleOrder.filter((r) => r !== approver)) {
      expect((await approveSnapshot(ws, role)).ok, role).toBe(false);
      expect((await bulkApprove(ws, role, ["A", "B"])).ok, role).toBe(false);
    }
  });

  it("review, plan, snapshot; per-role handover with the pack's stub text", async () => {
    expect((await bulkApprove(ws, approver, ["A", "B"])).ok).toBe(true);
    const tierC = (await listClaims(ws)).filter((c) => c.tier === "C" && c.review === "pending" && (c.state === "active" || c.state === "conflicting"));
    for (const c of tierC) {
      expect((await reviewClaim(ws, c.id, "approved", approver)).ok).toBe(false); // tier C needs a reason and the evidence opened
      expect((await reviewClaim(ws, c.id, "approved", approver, { note: "Checked the evidence.", evidenceOpened: true })).ok).toBe(true);
    }
    const gaps = await listBlockingGaps(ws);
    if (gaps.length) expect((await approveSnapshot(ws, approver)).ok).toBe(false); // open blocking gaps and no plan yet
    for (const g of gaps) {
      const saved = await savePlanItem(ws, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: roleLabel(successor, pack), dueDate: "2026-11-30", riskNote: "Known gap." }, approver);
      expect(saved.ok).toBe(true);
    }
    const snap = await approveSnapshot(ws, approver);
    expect(snap.ok).toBe(true);
    expect(snap.snapshot!.hash).toMatch(/^[0-9a-f]{64}$/);

    const full = (await compileHandover(ws, approver)).groups.flatMap((g) => g.items).length;
    for (const role of pack.roleOrder) {
      const h = await compileHandover(ws, role);
      const items = h.groups.flatMap((g) => g.items).length;
      expect(h.withheld, role).toBe(full - items);
      if (h.withheld > 0) {
        expect(h.stubLine, role).toBe(stubLine(h.withheld, pack));
        expect(h.stubLine, role).toContain(`Ask the approver (${approverLabel}).`);
      }
      // Canary tokens: a role's handover and export hold only the tokens the answer key allows it.
      const md = await exportMarkdown(ws, role);
      const text = JSON.stringify(h) + (md.ok ? md.markdown : "");
      for (const t of key.restricted.filter((x) => !x.roleSet.includes(role))) {
        expect(text.includes(t.token), `${t.token} leaked to ${role}`).toBe(false);
      }
    }
    expect((await compileHandover(ws, least)).withheld).toBeGreaterThan(0);
  });

  it("RLS: a role reads no stored row that carries a token outside its set", async () => {
    for (const role of pack.roleOrder) {
      const rows = await withRole(ws, role, (tx) => tx`
        SELECT text FROM segments WHERE workspace_id = ${ws}
        UNION ALL SELECT statement FROM claims WHERE workspace_id = ${ws}
        UNION ALL SELECT statement FROM snapshot_claims WHERE workspace_id = ${ws}`);
      const text = rows.map((r) => String(r.text)).join("\n");
      for (const t of key.restricted) {
        if (!t.roleSet.includes(role)) expect(text.includes(t.token), `${t.token} readable by ${role}`).toBe(false);
      }
    }
  });

  it("the leak check uses the pack's tokens and passes on every surface for every role", async () => {
    const leak = await runLeakCheck(ws);
    expect(leak.source).toBe("ground_truth");
    expect(leak.tokenCount).toBe(key.restricted.length);
    expect(leak.roles.map((r) => r.key)).toEqual(pack.roleOrder);
    expect(leak.cells.filter((c) => c.leaks > 0)).toEqual([]);
    expect(leak.allPass).toBe(true);
  });

  it("read-back asks the pack's items; the answer key's values are accepted where a claim answers", async () => {
    const [snap] = await sql`SELECT id FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
    const resolved = await resolveReadbackItems(ws, String(snap.id));
    expect(resolved.items.map((i) => i.key)).toEqual(pack.readback.map((r) => r.key));
    expect(resolved.items.map((i) => i.label)).toEqual(pack.readback.map((r) => r.label));
    const typed = Object.fromEntries(key.readback.map((r) => [r.key, r.expected]));
    const check = await checkHandoverReadback(ws, successor, typed);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.verdicts.length).toBe(pack.readback.length);
    // At least one typed answer from the key must be graded a match against the snapshot.
    expect(check.verdicts.filter((v) => v.verdict === "match").length).toBeGreaterThan(0);
  });
});
