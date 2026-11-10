// WALKING-SKELETON STUB: replaced by the Relay builder.
//
// Public entry points (keep these names and shapes):
//   reviewClaim(ws, claimId, decision, actor, opts?)  -> ActionResult    approve / edit / reject one claim
//   bulkApprove(ws, actor, tiers?)                    -> ActionResult & { approved }
//   approveSnapshot(ws, actor)                        -> ActionResult & { snapshot? }  hash + release rule
//   compileHandover(ws, role)                         -> Handover        per-role view read under RLS
//   canonicalJson(value)                              -> string          stable key order (hash input)
//   stubLine(n, pack?)                                -> string          the exact restricted-stub text
//
// What this stub really does:
//   * approver must be pack.approverRole (president); the leaver can never approve (server check).
//   * release rule: when B > 0, every open blocking gap needs owner, due date and risk note.
//   * snapshot = sha256 of canonical JSON (approved claim statements + evidence segment ids and
//     versions + continuation plan), versioned v1, v2, ...; rows copied to snapshot_claims.
//   * compileHandover reads snapshot_claims inside withRole(ws, role), groups by attribute, and
//     takes the withheld count from count_withheld() (SECURITY DEFINER, integer only).
//   * NOT yet: tiers C evidence-opened check, I-PASS layout, timeline, read-back, canary panel.
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { toClaim, toSnapshot } from "@/lib/db/mappers";
import { audit, getLatestTestRun, listPlanItems } from "@/lib/db/queries";
import { getPack, roleLabel, type Pack } from "@/lib/pack";
import { listBlockingGaps, planComplete } from "@/lib/lacuna";
import { sha256Hex } from "@/lib/text/norm";
import type { Attribute, ReviewState, ReviewTier, RoleKey, Scores, Snapshot, Trust } from "@/lib/types";

export type ActionResult = { ok: true } | { ok: false; error: string };

function approverCheck(actor: RoleKey, pack: Pack): ActionResult {
  if (actor === pack.leaverRole) return { ok: false, error: "The leaver can never approve. Switch to the Club President." };
  if (actor !== pack.approverRole) return { ok: false, error: `Only the approver (${roleLabel(pack.approverRole, pack)}) can do this.` };
  return { ok: true };
}

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Exactly: "N restricted items. Ask the approver (Club President)." */
export function stubLine(n: number, pack: Pack = getPack()): string {
  return `${n} restricted items. Ask the approver (${roleLabel(pack.approverRole, pack)}).`;
}

export async function reviewClaim(
  ws: string, claimId: string, decision: Exclude<ReviewState, "pending">, actor: RoleKey,
  opts: { note?: string; statement?: string } = {},
): Promise<ActionResult> {
  const pack = getPack();
  const gate = approverCheck(actor, pack);
  if (!gate.ok) return gate;
  const sql = db();
  const [row] = await sql`SELECT * FROM claims WHERE workspace_id = ${ws} AND id = ${claimId}`;
  if (!row) return { ok: false, error: "Claim not found." };
  const claim = toClaim(row);
  const note = (opts.note ?? "").trim();
  if (claim.tier === "C" && decision !== "rejected" && !note) {
    return { ok: false, error: "Tier C claims need a written reason. Open the evidence, then write why it is right." };
  }
  const statement = decision === "edited" && opts.statement?.trim() ? opts.statement.trim() : claim.statement;
  await sql`
    UPDATE claims SET review = ${decision}, review_note = ${note || null}, statement = ${statement}, updated_at = now()
    WHERE workspace_id = ${ws} AND id = ${claimId}`;
  await sql`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
    VALUES (${ws}, ${claimId}, 'reviewed', ${JSON.stringify({ decision, note: note || null })}::jsonb, ${actor})`;
  await audit(ws, actor, "review_claim", { claimId, decision });
  return { ok: true };
}

/** Approve every pending, non-dropped claim in the given tiers (never tier C). */
export async function bulkApprove(ws: string, actor: RoleKey, tiers: ReviewTier[] = ["A"]): Promise<ActionResult & { approved?: number }> {
  const pack = getPack();
  const gate = approverCheck(actor, pack);
  if (!gate.ok) return gate;
  const allowed = tiers.filter((t) => t !== "C");
  const sql = db();
  const rows = await sql`
    UPDATE claims SET review = 'approved', updated_at = now()
    WHERE workspace_id = ${ws} AND review = 'pending' AND state <> 'dropped' AND tier = ANY(${allowed}::text[])
    RETURNING id`;
  for (const r of rows) {
    await sql`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
      VALUES (${ws}, ${String(r.id)}, 'reviewed', ${JSON.stringify({ decision: "approved", bulk: true })}::jsonb, ${actor})`;
  }
  await audit(ws, actor, "bulk_approve", { tiers: allowed, count: rows.length });
  return { ok: true, approved: rows.length };
}

export async function approveSnapshot(ws: string, actor: RoleKey): Promise<ActionResult & { snapshot?: Snapshot }> {
  const pack = getPack();
  const gate = approverCheck(actor, pack);
  if (!gate.ok) return gate;
  const sql = db();

  const run = await getLatestTestRun(ws, pack.successorRole);
  const openBlocking = run?.scores.b ?? 0;
  const gaps = await listBlockingGaps(ws);
  const unplanned = gaps.filter((g) => !planComplete(g.plan));
  if (openBlocking > 0 && unplanned.length > 0) {
    return {
      ok: false,
      error: `B is ${openBlocking}: ${unplanned.length} open blocking gap(s) still need an owner, a due date and a risk note.`,
    };
  }

  const claims = (await sql`
    SELECT * FROM claims WHERE workspace_id = ${ws} AND review IN ('approved', 'edited') AND state = 'active'
    ORDER BY id`).map(toClaim);
  if (!claims.length) return { ok: false, error: "Approve at least one claim before approving a snapshot." };

  const segIds = [...new Set(claims.flatMap((c) => c.citations.filter((x) => x.accepted).map((x) => x.segmentId)))];
  const versions = new Map<string, number>();
  if (segIds.length) {
    const rows = await sql`
      SELECT id, max(version)::int AS v FROM segments WHERE workspace_id = ${ws} AND id = ANY(${segIds}::text[]) GROUP BY id`;
    for (const r of rows) versions.set(String(r.id), Number(r.v));
  }
  const plan = (await listPlanItems(ws)).sort((a, b) =>
    `${a.responsibilityId}|${a.checkKey}`.localeCompare(`${b.responsibilityId}|${b.checkKey}`));
  const [{ v: maxVersion }] = await sql`SELECT coalesce(max(version), 0)::int AS v FROM snapshots WHERE workspace_id = ${ws}`;
  const version = Number(maxVersion) + 1;

  const payload = {
    workspace: ws,
    version,
    claims: claims.map((c) => ({
      id: c.id,
      entity: c.entity,
      attribute: c.attribute,
      statement: c.statement,
      evidence: c.citations.filter((x) => x.accepted)
        .map((x) => ({ segment: x.segmentId, version: versions.get(x.segmentId) ?? 1 })),
    })),
    plan,
    openBlocking,
  };
  const hash = sha256Hex(canonicalJson(payload));
  const id = `snap_v${version}`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, claim_ids, open_blocking, plan, payload)
      VALUES (${ws}, ${id}, ${version}, ${hash}, ${pack.approverRole}, ${claims.map((c) => c.id)}::text[], ${openBlocking},
        ${JSON.stringify(plan)}::jsonb, ${canonicalJson(payload)}::jsonb)`;
    for (const c of claims) {
      await tx`
        INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, entity_label, attribute, statement, trust, valid_from, citations, role_set)
        VALUES (${ws}, ${id}, ${c.id}, ${c.entity}, ${c.entityLabel}, ${c.attribute}, ${c.statement}, ${c.trust}, ${c.validFrom},
          ${JSON.stringify(c.citations)}::jsonb, ${c.roleSet}::text[])`;
    }
  });
  await audit(ws, actor, "approve_snapshot", { version, hash, claims: claims.length, openBlocking });
  const [row] = await sql`SELECT * FROM snapshots WHERE workspace_id = ${ws} AND id = ${id}`;
  return { ok: true, snapshot: toSnapshot(row) };
}

export const ATTRIBUTE_ORDER: { attribute: Attribute; label: string }[] = [
  { attribute: "status", label: "Status" },
  { attribute: "owner", label: "Owners" },
  { attribute: "deadline", label: "Deadlines" },
  { attribute: "procedure", label: "How to do it" },
  { attribute: "location", label: "Where things live" },
  { attribute: "access", label: "Access (credential names only)" },
  { attribute: "contact", label: "Contacts" },
  { attribute: "dependency", label: "Dependencies" },
  { attribute: "decision", label: "Decisions" },
  { attribute: "reason", label: "Reasons" },
  { attribute: "risk", label: "Risks" },
];

export interface HandoverItem {
  claimId: string;
  entityLabel: string;
  statement: string;
  trust: Trust;
}

export interface Handover {
  role: RoleKey;
  snapshot: Snapshot | null;
  groups: { attribute: Attribute; label: string; items: HandoverItem[] }[];
  withheld: number;
  stubLine: string | null;      // null when nothing is withheld
  releaseLine: string | null;   // "Released with N open blocking gaps" when B > 0
  scores: Scores | null;
}

/** The handover for one role, compiled from the latest approved snapshot under RLS. */
export async function compileHandover(ws: string, role: RoleKey): Promise<Handover> {
  const pack = getPack();
  const [snapRow] = await db()`SELECT * FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
  const scores = (await getLatestTestRun(ws, role))?.scores ?? null;
  if (!snapRow) return { role, snapshot: null, groups: [], withheld: 0, stubLine: null, releaseLine: null, scores };
  const snapshot = toSnapshot(snapRow);

  const { rows, withheld } = await withRole(ws, role, async (tx) => {
    const rows = await tx`
      SELECT claim_id, entity_label, attribute, statement, trust FROM snapshot_claims
      WHERE workspace_id = ${ws} AND snapshot_id = ${snapshot.id}
      ORDER BY entity_label, claim_id`;
    const [w] = await tx`SELECT count_withheld(${ws}::uuid, ${role}, 'all') AS n`;
    return { rows, withheld: Number(w?.n ?? 0) };
  });

  const groups = ATTRIBUTE_ORDER.map(({ attribute, label }) => ({
    attribute,
    label,
    items: rows.filter((r) => r.attribute === attribute).map((r) => ({
      claimId: String(r.claim_id),
      entityLabel: String(r.entity_label),
      statement: String(r.statement),
      trust: r.trust as Trust,
    })),
  })).filter((g) => g.items.length > 0);

  return {
    role,
    snapshot,
    groups,
    withheld,
    stubLine: withheld > 0 ? stubLine(withheld, pack) : null,
    releaseLine: snapshot.openBlocking > 0 ? `Released with ${snapshot.openBlocking} open blocking gaps` : null,
    scores,
  };
}
