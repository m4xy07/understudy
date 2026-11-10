// WALKING-SKELETON STUB: replaced by the Attest builder.
//
// Public entry points the pipeline calls (keep these names and shapes):
//   reconstruct(ws) -> ReconstructResult   build/refresh claims from the workspace's segments
//   verify(ws)      -> VerifyResult        apply the citation rules and set trust/state
//
// What this stub really does (deterministic, no model):
//   * reconstruct: every task-board segment (kind "task") becomes claims for owner, status and
//     deadline from its meta. The citation quote is the task text itself (exact quote).
//   * verify: the exact-quote rule from docs/ARCHITECTURE.md section 4: a citation is accepted iff
//     its segment exists in this workspace; trust from_record iff norm(quote) is a substring of
//     norm(segment); accepted without exact quote -> inferred; no accepted citation -> dropped.
//     No supersession, conflicts, corroboration or model support check yet.
// Every change writes a claim_events row (append-only).
import { db } from "@/lib/db/client";
import { claimRow, toClaim, toSegment } from "@/lib/db/mappers";
import { getPack, type Pack } from "@/lib/pack";
import { norm, sha256Hex } from "@/lib/text/norm";
import type { Attribute, Citation, Claim, Importance, ReviewTier, RoleKey, Segment, Trust } from "@/lib/types";

export interface ReconstructResult {
  claims: number;        // claims created in this pass
  total: number;         // claims in the workspace after the pass
  modelUsed: boolean;
  modelNote: string | null;
}

export interface VerifyResult {
  checked: number;
  fromRecord: number;
  inferred: number;
  dropped: number;
  superseded: number;
  conflicting: number;
}

export function claimId(entity: string, attribute: string, value: string, segmentIds: string[]): string {
  return "clm_" + sha256Hex(`${entity}|${attribute}|${norm(value)}|${[...segmentIds].sort().join(",")}`).slice(0, 16);
}

/** Pack entity whose key, label or alias appears in the text; else a slug of the fallback. */
export function matchEntity(text: string, fallback: string, pack: Pack): { key: string; label: string } {
  const t = norm(text);
  for (const e of pack.entities) {
    const names = [e.key.replace(/-/g, " "), e.label, ...(e.aliases ?? [])].map(norm).filter(Boolean);
    if (names.some((n) => n.length >= 3 && t.includes(n))) return { key: e.key, label: e.label };
  }
  const slug = norm(fallback).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "untitled";
  return { key: slug, label: fallback.trim() || slug };
}

export function intersectRoles(sets: RoleKey[][]): RoleKey[] {
  if (!sets.length) return [];
  return sets.reduce((acc, s) => acc.filter((r) => s.includes(r)));
}

export function tierFor(c: Pick<Claim, "roleSet" | "state" | "importance" | "trust">): ReviewTier {
  if (!c.roleSet.includes("new_member") || c.state === "conflicting" || c.importance === "blocking") return "C";
  if (c.trust === "corroborated" && c.importance === "normal") return "A";
  return "B";
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

function taskClaims(seg: Segment, ws: string, pack: Pack): Claim[] {
  const m = seg.meta ?? {};
  const title = str(m.title) || seg.text.split("\n")[0];
  const entity = matchEntity(`${title} ${str(m.labels)} ${str(m.description)}`, title, pack);
  const fields: { attribute: Attribute; value: string; statement: string; importance: Importance }[] = [];
  const owner = str(m.owner);
  const status = str(m.status);
  const due = str(m.due);
  if (owner) fields.push({ attribute: "owner", value: owner, statement: `${owner} owns "${title}".`, importance: "important" });
  if (status) fields.push({ attribute: "status", value: status, statement: `"${title}" is ${status}.`, importance: "normal" });
  if (due) fields.push({ attribute: "deadline", value: due, statement: `"${title}" is due ${due}.`, importance: "important" });
  const fieldName: Partial<Record<Attribute, string>> = { owner: "owner", status: "status", deadline: "due" };
  return fields.map((f) => {
    // Quote the exact "field: value" text from the task row when present, else the whole row.
    const esc = f.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hit = new RegExp(`${fieldName[f.attribute] ?? f.attribute}\\s*:\\s*${esc}`, "i").exec(seg.text);
    const quote = hit ? hit[0] : seg.text;
    const citations: Citation[] = [{ segmentId: seg.id, quote, accepted: false, exact: false }];
    const claim: Claim = {
      id: claimId(entity.key, f.attribute, f.value, [seg.id]),
      workspaceId: ws,
      entity: entity.key,
      entityLabel: entity.label,
      attribute: f.attribute,
      value: f.value,
      statement: f.statement,
      citations,
      trust: "inferred",
      state: "active",
      stateNote: null,
      supersededBy: null,
      roleSet: [...seg.roleSet],
      validFrom: seg.ts,
      authorId: seg.authorId,
      sourceKinds: [seg.sourceKind],
      importance: f.importance,
      tier: "B",
      review: "pending",
      reviewNote: null,
      origin: "structured",
      supportCheck: null,
    };
    claim.tier = tierFor(claim);
    return claim;
  });
}

/** Build claims from the workspace's segments. Idempotent: existing claim ids are kept. */
export async function reconstruct(ws: string): Promise<ReconstructResult> {
  const sql = db();
  const pack = getPack();
  const rows = await sql`
    SELECT DISTINCT ON (id) * FROM segments
    WHERE workspace_id = ${ws} AND kind = 'task'
    ORDER BY id, version DESC`;
  const claims = rows.map(toSegment).flatMap((s) => taskClaims(s, ws, pack));
  let created = 0;
  for (const c of claims) {
    const row = claimRow(c, []);
    const res = await sql`INSERT INTO claims ${sql(row)} ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`;
    if (res.length) {
      created++;
      await sql`
        INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
        VALUES (${ws}, ${c.id}, 'created', ${JSON.stringify({ origin: c.origin, attribute: c.attribute, value: c.value })}::jsonb, 'system')`;
    }
  }
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM claims WHERE workspace_id = ${ws}`;
  return { claims: created, total: Number(n), modelUsed: false, modelNote: "Stub extractor: task board only (no model call)." };
}

/** Apply the citation rules to every non-answer claim and record the outcome. */
export async function verify(ws: string): Promise<VerifyResult> {
  const sql = db();
  const claims = (await sql`SELECT * FROM claims WHERE workspace_id = ${ws}`).map(toClaim);
  const segRows = await sql`SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws} ORDER BY id, version DESC`;
  const segs = new Map(segRows.map((r) => [String(r.id), toSegment(r)]));
  const out: VerifyResult = { checked: 0, fromRecord: 0, inferred: 0, dropped: 0, superseded: 0, conflicting: 0 };

  for (const c of claims) {
    if (c.origin === "leaver_answer") continue; // trust leaver_said is set at answer time
    out.checked++;
    const citations: Citation[] = c.citations.map((cit) => {
      const seg = segs.get(cit.segmentId);
      const accepted = Boolean(seg);
      const exact = Boolean(seg && cit.quote && norm(cit.quote) && norm(seg.text).includes(norm(cit.quote)));
      return { ...cit, accepted, exact };
    });
    const accepted = citations.filter((x) => x.accepted);
    let trust: Trust = c.trust;
    let state = c.state;
    let note = c.stateNote;
    if (!accepted.length) {
      state = "dropped";
      note = "Dropped: no citation points to a segment in this workspace";
    } else if (accepted.some((x) => x.exact)) {
      trust = "from_record";
    } else {
      trust = "inferred";
      note = "Inferred: cited segment found, but the quote is not in it";
    }
    const roleSet = accepted.length
      ? intersectRoles(accepted.map((x) => segs.get(x.segmentId)!.roleSet))
      : c.roleSet;
    if (state === "dropped") out.dropped++;
    else if (trust === "from_record") out.fromRecord++;
    else out.inferred++;
    const tier = tierFor({ roleSet, state, importance: c.importance, trust });
    const changed = trust !== c.trust || state !== c.state || JSON.stringify(citations) !== JSON.stringify(c.citations);
    await sql`
      UPDATE claims SET citations = ${JSON.stringify(citations)}::jsonb, trust = ${trust}, state = ${state},
        state_note = ${note}, role_set = ${roleSet}::text[], tier = ${tier}, updated_at = now()
      WHERE workspace_id = ${ws} AND id = ${c.id}`;
    if (changed) {
      await sql`
        INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
        VALUES (${ws}, ${c.id}, 'verified', ${JSON.stringify({ trust, state, note })}::jsonb, 'system')`;
    }
  }
  return out;
}
