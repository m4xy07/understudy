// Relay against the local database: review rules, release rule, hashed snapshots, per-role compile
// under RLS, read-back and append-only acknowledgements. Needs a migrated database
// (pnpm db:up && pnpm db:migrate) and data/demo.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { countWithheld, listClaims } from "@/lib/db/queries";
import { listBlockingGaps, savePlanItem } from "@/lib/lacuna";
import {
  acknowledgeHandover, approveSnapshot, bulkApprove, checkHandoverReadback, compileHandover, effectiveTier,
  exportMarkdown, getReleaseInfo, listAcknowledgements, listSnapshotHistory, parsePayload, previewSnapshotPayload,
  reviewClaim, runLeakCheck,
} from "@/lib/relay";
import { hashSnapshot, verifySnapshot } from "@/lib/relay/core/snapshot";
import { renderMarkdown } from "@/lib/relay/core/compile";
import type { RoleKey } from "@/lib/types";

const sql = db();
let ws = "";
const ALL: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
const CANARIES = (JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "demo", "ground_truth.json"), "utf8")) as {
  restricted: { token: string; roleSet: RoleKey[] }[];
}).restricted;

const ID = { canary: "clm_test_canary", rollback: "clm_test_rollback", domain: "clm_test_domain" };
const COMMAND = "./scripts/flash.sh --rollback v2.3.1";
const OPENED = { evidenceOpened: true, note: "Opened the evidence and checked it." };

async function plant(id: string, f: {
  entity: string; label: string; attribute: string; value: string; statement: string; roles: RoleKey[]; segment: string;
}) {
  await sql`
    INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state,
      role_set, valid_from, importance, tier, review, origin)
    VALUES (${ws}, ${id}, ${f.entity}, ${f.label}, ${f.attribute}, ${f.value}, ${f.statement},
      ${JSON.stringify([{ segmentId: f.segment, quote: null, accepted: true, exact: false }])}::jsonb, 'from_record', 'active',
      ${f.roles}::text[], now(), 'normal', 'B', 'pending', 'extracted')`;
}

beforeAll(async () => {
  ws = (await createDemoWorkspace()).id;
  const { runId } = await startRun(ws);
  expect((await executeRun(ws, runId))?.status).toBe("done");

  const [anySeg] = await sql`SELECT id FROM segments WHERE workspace_id = ${ws} ORDER BY id LIMIT 1`;
  const [finance] = await sql`SELECT id FROM segments WHERE workspace_id = ${ws} AND text LIKE ${`%${CANARIES[0].token}%`} LIMIT 1`;
  // A restricted claim that carries a canary token, plus two read-back answers (one restricted).
  await plant(ID.canary, {
    entity: "club-budget", label: "Club budget", attribute: "risk", segment: String((finance ?? anySeg).id),
    value: `Budget code ${CANARIES[0].token}`, statement: `The budget code ${CANARIES[0].token} must not be shared.`,
    roles: CANARIES[0].roleSet,
  });
  await plant(ID.rollback, {
    entity: "firmware-rollback", label: "Firmware rollback", attribute: "procedure", segment: String(anySeg.id),
    value: COMMAND, statement: `Roll back with \`${COMMAND}\`.`, roles: ["president", "tech_lead", "leaver"],
  });
  await plant(ID.domain, {
    entity: "domain-dns", label: "Club domain and DNS", attribute: "deadline", segment: String(anySeg.id),
    value: "yearly on 2 Dec, next 2026-12-02", statement: "The club domain renews yearly; next renewal 2026-12-02.",
    roles: ALL,
  });
}, 120_000);

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("Relay review", () => {
  it("the leaver can never review or approve; nobody but the president can", async () => {
    const leaver = await reviewClaim(ws, ID.domain, "approved", "leaver", OPENED);
    expect(leaver.ok).toBe(false);
    if (!leaver.ok) expect(leaver.error).toMatch(/leaver can never/i);
    expect((await bulkApprove(ws, "leaver")).ok).toBe(false);
    const snap = await approveSnapshot(ws, "leaver");
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.code).toBe("leaver_cannot_approve");
    expect((await approveSnapshot(ws, "tech_lead")).ok).toBe(false);
    expect((await reviewClaim(ws, ID.domain, "approved", "treasurer")).ok).toBe(false);
  });

  it("tier C needs the evidence opened and a written reason; every action is logged", async () => {
    const tierC = (await listClaims(ws)).find((c) => c.id === ID.canary)!;
    expect(effectiveTier(tierC)).toBe("C"); // sensitive: new_member is not in the role set
    const noEvidence = await reviewClaim(ws, ID.canary, "approved", "president", { note: "Checked the finance thread." });
    expect(noEvidence.ok).toBe(false);
    const shortReason = await reviewClaim(ws, ID.canary, "approved", "president", { evidenceOpened: true, note: "ok" });
    expect(shortReason.ok).toBe(false);
    expect((await reviewClaim(ws, ID.canary, "approved", "president", OPENED)).ok).toBe(true);
    expect((await reviewClaim(ws, ID.rollback, "approved", "president", OPENED)).ok).toBe(true);

    const events = await sql`SELECT event, data, actor FROM claim_events WHERE workspace_id = ${ws} AND claim_id = ${ID.canary}`;
    const data = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown>;
    expect(events.some((e) => e.event === "claim_approved" && e.actor === "president" && data(e.data).evidenceOpened === true)).toBe(true);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = ${ws} AND action = 'review_claim'`;
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("an edit keeps citations and trust and is labelled as edited", async () => {
    const before = (await listClaims(ws)).find((c) => c.id === ID.domain)!;
    const res = await reviewClaim(ws, ID.domain, "edited", "president", {
      statement: "The club domain renews every year; the next renewal is 2026-12-02.",
    });
    expect(res.ok).toBe(true);
    const after = (await listClaims(ws)).find((c) => c.id === ID.domain)!;
    expect(after.review).toBe("edited");
    expect(after.citations).toEqual(before.citations);
    expect(after.trust).toBe(before.trust);
    expect(after.statement).toMatch(/every year/);
  });

  it("bulk approve takes pending tier A claims only", async () => {
    const pending = (await listClaims(ws)).filter((c) =>
      c.review === "pending" && c.state === "active" && !c.id.startsWith("clm_test") && effectiveTier({ ...c, tier: "A" }) === "A");
    const promoted = pending.filter((c) => c.tier !== "A").slice(0, 2).map((c) => c.id);
    expect(promoted.length).toBe(2);
    await sql`UPDATE claims SET tier = 'A' WHERE workspace_id = ${ws} AND id = ANY(${promoted}::text[])`;
    // Real extraction already yields tier A claims (corroborated, normal, no flags): the expected set
    // is every pending active claim whose effective tier is A, including the two promoted above.
    const before = await listClaims(ws);
    const expectedA = before
      .filter((c) => c.review === "pending" && c.state === "active" && effectiveTier(c) === "A")
      .map((c) => c.id).sort();
    expect(expectedA).toEqual(expect.arrayContaining(promoted));
    const otherPending = before.filter((c) => c.review === "pending" && !expectedA.includes(c.id)).map((c) => c.id).sort();
    expect(otherPending.length).toBeGreaterThan(0);
    const res = await bulkApprove(ws, "president", ["A", "B"]);
    expect(res.ok).toBe(true);
    expect(res.approved).toBe(expectedA.length);
    const claims = await listClaims(ws);
    for (const id of expectedA) expect(claims.find((c) => c.id === id)!.review).toBe("approved");
    // Tiers B and C (and non-active claims) are never bulk-approved: all of them are still pending.
    expect(claims.filter((c) => c.review === "pending").map((c) => c.id).sort()).toEqual(otherPending);
  });
});

describe("Relay snapshot", () => {
  it("the release rule blocks approval until every open blocking gap is planned", async () => {
    const gaps = await listBlockingGaps(ws);
    expect(gaps.length).toBeGreaterThan(0);
    const blocked = await approveSnapshot(ws, "president");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("release_blocked");
      expect(blocked.error).toMatch(/owner, a due date and a risk note/);
    }
    expect((await getReleaseInfo(ws)).blockers.length).toBeGreaterThan(0);
    for (const g of gaps) {
      const r = await savePlanItem(ws, {
        responsibilityId: g.responsibilityId, checkKey: g.checkKey,
        owner: "Incoming tech lead", dueDate: "2026-11-30", riskNote: "Known gap; the president checks in weekly.",
      }, "president");
      expect(r.ok).toBe(true);
    }
    const info = await getReleaseInfo(ws);
    expect(info.blockers).toEqual([]);
    const ok = await approveSnapshot(ws, "president");
    expect(ok.ok).toBe(true);
    expect(ok.snapshot!.version).toBe(1);
    expect(ok.snapshot!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.label).toBe(info.state.label);
    expect(ok.label).not.toMatch(/complete/i);
    const [run] = await sql`SELECT provisional FROM test_runs WHERE workspace_id = ${ws} AND role = 'tech_lead' ORDER BY created_at DESC LIMIT 1`;
    expect(run.provisional).toBe(false);
  });

  it("the snapshot hash is stable and verifiable; versions diff", async () => {
    const [row] = await sql`SELECT hash, payload FROM snapshots WHERE workspace_id = ${ws} AND version = 1`;
    const payload = parsePayload(row.payload)!;
    expect(payload).not.toBeNull();
    expect(verifySnapshot(payload, String(row.hash))).toBe(true);
    expect(hashSnapshot(await previewSnapshotPayload(ws, 1))).toBe(String(row.hash)); // same content, same hash
    expect(verifySnapshot({ ...payload, openBlocking: payload.openBlocking + 1 }, String(row.hash))).toBe(false);
    const ids = payload.claims.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([ID.canary, ID.rollback, ID.domain]));

    const v2 = await approveSnapshot(ws, "president");
    expect(v2.ok).toBe(true);
    expect(v2.snapshot!.version).toBe(2);
    expect(v2.snapshot!.hash).not.toBe(String(row.hash)); // the version is part of the payload
    const history = await listSnapshotHistory(ws);
    expect(history.map((h) => h.snapshot.version)).toEqual([2, 1]);
    expect(history.every((h) => h.verified)).toBe(true);
    expect(history[0].diff).toMatchObject({ fromVersion: 1, toVersion: 2, added: [], removed: [], changed: [] });
  });
});

describe("Relay handover", () => {
  it("new_member's compile never contains a canary and takes its stub count from count_withheld", async () => {
    const h = await compileHandover(ws, "new_member");
    expect(h.doc).not.toBeNull();
    const text = `${JSON.stringify(h)}\n${renderMarkdown(h.doc!)}`;
    for (const c of CANARIES) expect(text).not.toContain(c.token);
    const n = await countWithheld(ws, "new_member", "all");
    expect(n).toBeGreaterThanOrEqual(2);
    expect(h.withheld).toBe(n);
    expect(h.stubLine).toBe(`${n} restricted items. Ask the approver (Club President).`);
    const stubs = h.doc!.sections.flatMap((s) => s.lines.filter((l) => l.kind === "stub").map((l) => l.text));
    expect(stubs.length).toBeGreaterThan(0);
    for (const s of stubs) expect(s).toMatch(/^\d+ restricted items?\. Ask the approver \(Club President\)\.$/);
    expect(text).not.toContain(COMMAND);

    const ex = await exportMarkdown(ws, "new_member");
    expect(ex.ok).toBe(true);
    if (ex.ok) for (const c of CANARIES) expect(ex.markdown).not.toContain(c.token);
  });

  it("roles that may see a token see it; the leak check passes for every role and surface", async () => {
    const treasurer = await compileHandover(ws, "treasurer");
    expect(renderMarkdown(treasurer.doc!)).toContain(CANARIES[0].token);
    const lead = await compileHandover(ws, "tech_lead");
    expect(renderMarkdown(lead.doc!)).toContain("edited by reviewer");
    expect(renderMarkdown(lead.doc!)).not.toContain(CANARIES[0].token);
    const report = await runLeakCheck(ws);
    expect(report.source).toBe("ground_truth");
    expect(report.cells.length).toBe(5 * 6);
    expect(report.allPass).toBe(true);
  });

  it("read-back gives match, mismatch and not_visible per item", async () => {
    const lead = await checkHandoverReadback(ws, "tech_lead", {
      firmware_rollback: `  ${COMMAND} `,
      domain_renewal_date: "2 December 2026",
    });
    expect(lead.ok).toBe(true);
    if (!lead.ok) return;
    const v = Object.fromEntries(lead.verdicts.map((x) => [x.key, x]));
    expect(v.firmware_rollback.verdict).toBe("match");
    expect(v.domain_renewal_date.verdict).toBe("match");
    expect(v.domain_renewal_date.expected).toBe("2026-12-02");

    const member = await checkHandoverReadback(ws, "new_member", {
      firmware_rollback: COMMAND,
      domain_renewal_date: "2026-12-03",
    });
    expect(member.ok).toBe(true);
    if (!member.ok) return;
    const m = Object.fromEntries(member.verdicts.map((x) => [x.key, x]));
    expect(m.firmware_rollback.verdict).toBe("not_visible");
    expect(m.firmware_rollback.expected).toBeNull();
    expect(m.domain_renewal_date.verdict).toBe("mismatch");
    const doc = (await compileHandover(ws, "new_member")).doc!;
    expect(doc.readbackForm.map((i) => i.key)).not.toContain("firmware_rollback");
  });

  it("acknowledgements are append-only", async () => {
    const typed = { firmware_rollback: COMMAND, domain_renewal_date: "2026-12-02" };
    expect((await acknowledgeHandover(ws, "leaver", typed)).ok).toBe(false);
    const a = await acknowledgeHandover(ws, "tech_lead", typed);
    expect(a.ok).toBe(true);
    const b = await acknowledgeHandover(ws, "tech_lead", { ...typed, domain_renewal_date: "2026-12-09" });
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const rows = await listAcknowledgements(ws);
    expect(rows.length).toBe(2);
    // Newest first. Read-back items left blank but visible to the tech lead count as mismatches in
    // both rows (real claims answer them); the second ack adds exactly the wrong renewal date.
    type Verdicts = { verdicts: { key: string; verdict: string }[] };
    const verdict = (ack: Verdicts, key: string) => ack.verdicts.find((v) => v.key === key)!.verdict;
    expect(verdict(a.ack, "domain_renewal_date")).toBe("match");
    expect(verdict(b.ack, "domain_renewal_date")).toBe("mismatch");
    const mismatches = (ack: Verdicts) => ack.verdicts.filter((v) => v.verdict === "mismatch").length;
    expect(rows[1].mismatch).toBe(mismatches(a.ack));
    expect(rows[0].mismatch).toBe(mismatches(b.ack));
    expect(rows[0].mismatch).toBe(rows[1].mismatch + 1);
    expect(rows[0].match).toBe(rows[1].match - 1);
    expect(rows.every((r) => r.snapshotHash.length === 64)).toBe(true);
    await expect(sql`UPDATE acknowledgements SET role = 'president' WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM acknowledgements WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
    expect((await listAcknowledgements(ws)).length).toBe(2);
  });
});
