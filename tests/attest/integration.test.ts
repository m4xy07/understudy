// Attest against the local database: reconstruct + verify on the demo pack with a fake model.
// Needs a migrated database (pnpm db:up && pnpm db:migrate). No network: the model is injected.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { listClaims } from "@/lib/db/queries";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { reconstruct, verify } from "@/lib/attest";
import type { ModelCall } from "@/lib/attest/core/schema";

const sql = db();
let ws = "";
let financeSegs = new Set<string>();

/** Parses `[seg_x] (author, ts, thread) text` lines from the extraction prompt. */
function promptSegments(user: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const line of user.split("\n")) {
    const m = /^\[(seg_[0-9a-f]+)\] \([^)]*\) (.*)$/.exec(line);
    if (m) out.push({ id: m[1], text: m[2] });
  }
  return out;
}

let modelCalls = 0;

/** Fake model: one claim per batch quoting its first segment, plus one claim citing a missing segment. */
const fakeExtract: ModelCall = async (opts) => {
  modelCalls++;
  const segs = promptSegments(opts.user).filter((s) => s.text.split(/\s+/).length >= 4);
  const claims: unknown[] = [];
  if (segs.length) {
    const words = segs[0].text.split(/\s+/).slice(0, 6).join(" ");
    claims.push({
      entity: "other", attribute: "risk", value: words.slice(0, 40), statement: `Someone wrote: ${words}`,
      citations: [{ segment_id: segs[0].id, quote: words }],
    });
    claims.push({
      entity: "other", attribute: "status", value: "invented", statement: "An invented fact.",
      citations: [{ segment_id: "seg_0000000000000000", quote: "nothing" }],
    });
  }
  return { ok: true, data: opts.schema.parse({ claims }), cached: false };
};

/** Fake support check: every claim is supported. */
const fakeSupport: ModelCall = async (opts) => {
  const ids = [...opts.user.matchAll(/^### (c\d+)$/gm)].map((m) => m[1]);
  return { ok: true, data: opts.schema.parse({ results: ids.map((id) => ({ id, verdict: "yes" })) }), cached: false };
};

beforeAll(async () => {
  ws = (await createDemoWorkspace()).id;
  const rows = await sql`
    SELECT s.id FROM segments s JOIN sources src ON src.workspace_id = s.workspace_id AND src.id = s.source_id
    WHERE s.workspace_id = ${ws} AND src.name ILIKE '%finance%'`;
  financeSegs = new Set(rows.map((r) => String(r.id)));
  await reconstruct(ws, { call: fakeExtract });
  await verify(ws, { call: fakeSupport });
}, 60_000);

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("Attest integration (local DB, fake model)", () => {
  it("writes structured and extracted claims with accepted exact citations", async () => {
    expect(modelCalls).toBeGreaterThan(0);
    const claims = await listClaims(ws);
    expect(claims.some((c) => c.origin === "structured" && c.attribute === "deadline")).toBe(true);
    const extracted = claims.filter((c) => c.origin === "extracted");
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted.every((c) => c.trust === "from_record" && c.citations.every((x) => x.accepted && x.exact))).toBe(true);
    expect(extracted.every((c) => c.supportCheck === "yes")).toBe(true);
    // The structured recurring event also yields a plain ISO next-date claim.
    expect(claims.some((c) => c.entity === "domain-dns" && c.attribute === "deadline" && /^\d{4}-\d{2}-\d{2}$/.test(c.value))).toBe(true);
  });

  it("drops drafts whose citation points nowhere, counted per source and role-scoped", async () => {
    const all = await sql`SELECT * FROM attest_dropped WHERE workspace_id = ${ws}`;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => String(r.reason).includes("cited segment not found"))).toBe(true);
    const asNew = await withRole(ws, "new_member", (tx) => tx`SELECT role_set FROM attest_dropped WHERE workspace_id = ${ws}`);
    expect(asNew.length).toBeGreaterThan(0);
    expect(asNew.length).toBeLessThan(all.length); // the #finance and handover-prep drops are hidden
    expect(asNew.every((r) => (r.role_set as string[]).includes("new_member"))).toBe(true);
  });

  it("role intersection: new_member never sees a #finance-derived claim", async () => {
    expect(financeSegs.size).toBeGreaterThan(0);
    const fromFinance = (c: { citations: { segmentId: string }[] }) => c.citations.some((x) => financeSegs.has(x.segmentId));
    const treasurer = await listClaims(ws, { role: "treasurer" });
    expect(treasurer.some(fromFinance)).toBe(true);
    const newMember = await listClaims(ws, { role: "new_member" });
    expect(newMember.length).toBeGreaterThan(0);
    expect(newMember.some(fromFinance)).toBe(false);
    for (const c of await listClaims(ws)) {
      if (fromFinance(c)) expect(c.roleSet).not.toContain("new_member");
    }
  });

  it("re-running verify keeps review work and adds no events when nothing changed", async () => {
    const [a, b] = (await listClaims(ws)).filter((c) => c.state !== "dropped");
    await sql`UPDATE claims SET review = 'approved', review_note = 'Checked the evidence.' WHERE workspace_id = ${ws} AND id = ${a.id}`;
    await sql`UPDATE claims SET review = 'edited', statement = 'Edited by the president.' WHERE workspace_id = ${ws} AND id = ${b.id}`;
    const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM claim_events WHERE workspace_id = ${ws}`;
    await reconstruct(ws, { call: fakeExtract });
    await verify(ws, { call: fakeSupport });
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM claim_events WHERE workspace_id = ${ws}`;
    expect(after).toBe(before);
    const again = new Map((await listClaims(ws)).map((c) => [c.id, c]));
    expect(again.get(a.id)).toMatchObject({ review: "approved", reviewNote: "Checked the evidence." });
    expect(again.get(b.id)).toMatchObject({ review: "edited", statement: "Edited by the president." });
  }, 60_000);

  it("logs every claim in claim_events", async () => {
    const [{ n }] = await sql`SELECT count(DISTINCT claim_id)::int AS n FROM claim_events WHERE workspace_id = ${ws} AND event = 'created'`;
    const [{ m }] = await sql`SELECT count(*)::int AS m FROM claims WHERE workspace_id = ${ws}`;
    expect(n).toBe(m);
  });
});
