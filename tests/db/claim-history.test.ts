// Claim history under RLS (src/lib/attest/history.ts, db/migrations/0014_claim_history.sql).
// A role reads a claim's events only when it can see the claim, and an event never carries text
// from a claim or a segment the role cannot open. Runs once per pack, with role keys from the pack.
// Needs a migrated database: pnpm db:up && pnpm db:migrate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { getClaimHistory } from "@/lib/attest/history";
import { getPack, listDemoPacks } from "@/lib/pack";

const sql = db();

const PACKS = listDemoPacks().map((p) => {
  const pack = getPack(p.id);
  const special = new Set([pack.approverRole, pack.successorRole, pack.leaverRole, ...pack.restrictedAudienceRoles]);
  const other = pack.roleOrder.find((r) => !special.has(r));
  if (!other) throw new Error(`pack ${p.id}: the history suite needs one role with no flag`);
  return {
    id: p.id,
    all: pack.roleOrder,
    approver: pack.approverRole,
    leaver: pack.leaverRole,
    least: pack.restrictedAudienceRoles[0],
    narrow: [pack.approverRole, other],
  };
});

const SECRET_STATEMENT = "The finance holder keeps the account PIN CANARY-H1ST.";
const OLD_STATEMENT = "OLD-STATEMENT the PIN sits in the drawer.";
const REVIEW_NOTE = "REVIEW-NOTE checked against the bank letter.";
const RULE_NOTE = "Superseded: the task board owns deadlines (updated on 2026-01-05)";

describe.each(PACKS)("claim history with the role keys of pack $id", (P) => {
  let ws = "";

  const claim = (id: string, statement: string, roles: string[], flag: string[] | null = null) => sql`
    INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust,
      role_set, flag_role_set, valid_from, origin)
    VALUES (${ws}, ${id}, ${"e-" + id}, ${"Entity " + id}, 'deadline', 'v', ${statement},
      ${JSON.stringify([{ segmentId: "seg_public", quote: null, accepted: true, exact: false }])}::jsonb, 'from_record',
      ${roles}::text[], ${flag}::text[], now(), 'structured')`;
  const event = (claimId: string, ev: string, at: string, data: object, actor = "system") => sql`
    INSERT INTO claim_events (workspace_id, claim_id, event, data, actor, created_at)
    VALUES (${ws}, ${claimId}, ${ev}, ${JSON.stringify(data)}::jsonb, ${actor}, ${at}::timestamptz)`;

  beforeAll(async () => {
    const [w] = await sql`INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role)
      VALUES ('history fixture', 'empty', ${P.id}, ${P.approver}, ${P.leaver}) RETURNING id`;
    ws = String(w.id);
    await sql`INSERT INTO sources (workspace_id, id, kind, name, role_set) VALUES
      (${ws}, 'src_board', 'tasks_csv', 'board.csv', ${P.all}::text[]),
      (${ws}, 'src_fin', 'markdown', 'finance.md', ${P.narrow}::text[])`;
    await sql`INSERT INTO segments (workspace_id, id, source_id, source_kind, kind, ts, thread, text, text_hash, role_set) VALUES
      (${ws}, 'seg_public', 'src_board', 'tasks_csv', 'task', now(), 'board', 'Room booking due Friday', 'h1', ${P.all}::text[]),
      (${ws}, 'seg_finance', 'src_fin', 'markdown', 'note', now(), 'finance.md', ${SECRET_STATEMENT}, 'h2', ${P.narrow}::text[])`;

    await claim("clm_public", "The room booking is due on Friday.", P.all);
    await claim("clm_finance", SECRET_STATEMENT, P.narrow);
    await claim("clm_flagged", "The deadline moved to Monday.", P.all, P.narrow);
    await claim("clm_quiet", "Sam books the room.", P.all);
    await claim("clm_bare", "The lab key is at the desk.", P.all);

    // clm_public: inserted out of time order on purpose; the superseded event names the narrow claim.
    await event("clm_public", "created", "2026-01-01T09:00:00Z", { origin: "structured", trust: "from_record", value: "Friday", segmentId: "seg_finance", roleSet: P.all });
    await event("clm_public", "superseded", "2026-01-05T09:00:00Z", {
      changes: { state: { from: "active", to: "superseded" }, supersededBy: { from: null, to: "clm_finance" } },
      note: RULE_NOTE, rule: 1, olderId: "clm_public", newerId: "clm_finance",
    });
    await event("clm_public", "verified", "2026-01-03T09:00:00Z", { changes: { trust: { from: "inferred", to: "from_record" } } });
    await event("clm_public", "claim_approved", "2026-01-07T09:00:00Z", { tier: "B", note: "Looks right.", evidenceOpened: true }, P.approver);

    // clm_finance: an edit that stores the older statement and a reviewer's note.
    await event("clm_finance", "created", "2026-01-02T09:00:00Z", { origin: "extracted", trust: "from_record", value: "PIN" });
    await event("clm_finance", "claim_edited", "2026-01-04T09:00:00Z", {
      tier: "C", note: REVIEW_NOTE, evidenceOpened: true,
      before: { review: "pending", value: "PIN", statement: OLD_STATEMENT },
      after: { review: "edited", value: "PIN", statement: SECRET_STATEMENT },
    }, P.approver);

    await event("clm_flagged", "conflicting", "2026-01-06T09:00:00Z", { note: "Conflicting: CANARY-FLAG disagrees.", rule: 4, olderId: "clm_flagged", newerId: "clm_finance" });
    await event("clm_quiet", "created", "2026-01-01T10:00:00Z", { origin: "structured", trust: "from_record" });
  });

  afterAll(async () => {
    if (!ws) return;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  });

  it("a restricted role reads no history for a claim outside its role set", async () => {
    expect(await getClaimHistory(ws, "clm_finance", P.least)).toBeNull();
    // The policy itself, not only the function: the rows do not exist for this role.
    const raw = await withRole(ws, P.least, (tx) => tx`SELECT claim_id, data FROM claim_events WHERE workspace_id = ${ws}`);
    expect(raw.map((r) => r.claim_id)).not.toContain("clm_finance");
    expect(JSON.stringify(raw)).not.toContain("REVIEW-NOTE");
  });

  it("a claim hidden by its conflict flag has no readable history either", async () => {
    expect(await getClaimHistory(ws, "clm_flagged", P.least)).toBeNull();
    const raw = await withRole(ws, P.least, (tx) => tx`SELECT 1 FROM claim_events WHERE workspace_id = ${ws} AND claim_id = 'clm_flagged'`);
    expect(raw.length).toBe(0);
  });

  it("returns events in time order, not insertion order", async () => {
    const h = await getClaimHistory(ws, "clm_public", P.approver);
    expect(h?.entries.map((e) => e.kind)).toEqual(["created", "verified", "superseded", "approved"]);
    const times = h!.entries.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(h?.changes).toBe(3);
    expect(h?.entries[3].actor).toBe(P.approver);
    expect(h?.entries[0].actor).toBeNull();
  });

  it("names the rule that fired for a superseded event", async () => {
    const h = await getClaimHistory(ws, "clm_public", P.least);
    const sup = h?.entries.find((e) => e.kind === "superseded");
    expect(sup?.rule).toBe("the task board owns deadlines (updated on 2026-01-05)");
  });

  it("never shows a restricted role the text or id of a claim or segment it cannot open", async () => {
    const h = await getClaimHistory(ws, "clm_public", P.least);
    expect(h).not.toBeNull();
    expect(h?.entries.find((e) => e.kind === "superseded")?.related).toBeNull();
    expect(h?.entries.find((e) => e.kind === "created")?.segmentId).toBeNull();
    const text = JSON.stringify(h);
    for (const s of ["CANARY", "clm_finance", "seg_finance", "OLD-STATEMENT", "REVIEW-NOTE"]) expect(text).not.toContain(s);
  });

  it("the approver sees the winning claim and the cited segment", async () => {
    const h = await getClaimHistory(ws, "clm_public", P.approver);
    const sup = h?.entries.find((e) => e.kind === "superseded");
    expect(sup?.related).toEqual({ id: "clm_finance", statement: SECRET_STATEMENT, relation: "Replaced by" });
    expect(h?.entries.find((e) => e.kind === "created")?.segmentId).toBe("seg_finance");
  });

  it("an older statement and a reviewer's note show only to a role that can see the claim", async () => {
    const h = await getClaimHistory(ws, "clm_finance", P.approver);
    const edit = h?.entries.find((e) => e.kind === "edited");
    expect(edit?.lines).toContain(`Before: "${OLD_STATEMENT}"`);
    expect(edit?.lines).toContain(`Reviewer's note: "${REVIEW_NOTE}"`);
  });

  it("empty state: a claim with only its creation, and a claim with no events, have no changes", async () => {
    const quiet = await getClaimHistory(ws, "clm_quiet", P.least);
    expect(quiet?.entries.map((e) => e.kind)).toEqual(["created"]);
    expect(quiet?.changes).toBe(0);
    const bare = await getClaimHistory(ws, "clm_bare", P.least);
    expect(bare?.entries).toEqual([]);
    expect(bare?.changes).toBe(0);
  });

  it("an unknown or malformed claim id, or a role of no pack, gets null", async () => {
    expect(await getClaimHistory(ws, "clm_nope", P.approver)).toBeNull();
    expect(await getClaimHistory(ws, "../clm_public", P.approver)).toBeNull();
    expect(await getClaimHistory(ws, "clm_public", "nobody_role")).toBeNull();
  });

  it("the reader cannot write claim_events, and the admin path still reads every event", async () => {
    await expect(withRole(ws, P.approver, (tx) =>
      tx`INSERT INTO claim_events (workspace_id, claim_id, event) VALUES (${ws}, 'clm_public', 'created')`)).rejects.toThrow(/permission denied/i);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM claim_events WHERE workspace_id = ${ws}`;
    expect(n).toBe(8);
  });
});
