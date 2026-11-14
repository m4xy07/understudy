// Seeds a demo workspace with the planted claims of data/demo/ground_truth.json, as a perfect
// extractor would produce them: each claim cites the demo segment that contains its text, trust
// from_record, role set = the segment's role set, state as planted. Not a test file.
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { listSegments } from "@/lib/db/queries";
import { getPack, entityLabel } from "@/lib/pack";
import { norm, sha256Hex } from "@/lib/text/norm";
import type { RoleKey, Segment } from "@/lib/types";
import { flagRoleSets } from "@/lib/attest/core/flags";

export interface GtClaim {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  keywords?: string[];
  source: { kind: string; path: string; contains: string };
  roleSet: RoleKey[];
  check?: { responsibility: string; checkKey: string };
  state: "active" | "superseded" | "conflicting" | "dropped";
}

export interface GroundTruth {
  today: string;
  responsibilities: { key: string; title: string; kind: string; origin: string; entities: string[]; dueDate: string | null }[];
  claims: GtClaim[];
  gaps: { responsibility: string; checkKey: string; coverage: string; blocking: boolean; why: string }[];
  restrictedChecks: { responsibility: string; checkKey: string; visibleTo: RoleKey[] }[];
  footprintNoise: { entity: string; rule: string; why: string }[];
  expectedTechLeadBlockingGaps: number;
  conflicts?: { claims: string[]; rule: number }[];
}

export function loadGroundTruth(): GroundTruth {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "demo", "ground_truth.json"), "utf8")) as GroundTruth;
}

function findSegment(segs: Segment[], c: GtClaim): Segment | null {
  const want = norm(c.source.contains);
  const sameKind = segs.filter((s) => s.sourceKind === c.source.kind);
  const exact = sameKind.find((s) => norm(s.text).includes(want));
  if (exact) return exact;
  const kws = (c.keywords ?? []).map(norm).filter(Boolean);
  if (kws.length === 0) return null;
  return sameKind.find((s) => kws.every((k) => norm(s.text).includes(k))) ?? null;
}

/** Inserts the planted claims; returns how many were placed and which could not be matched to a segment. */
export async function seedGroundTruthClaims(ws: string): Promise<{ seeded: number; unmatched: string[] }> {
  const sql = db();
  const pack = getPack("club");
  const gt = loadGroundTruth();
  const segs = await listSegments(ws);
  const unmatched: string[] = [];
  const placed: { id: string; gtId: string; roleSet: RoleKey[] }[] = [];
  let seeded = 0;
  for (const c of gt.claims) {
    const seg = findSegment(segs, c);
    if (!seg) {
      unmatched.push(c.id);
      continue;
    }
    // A perfect extractor quotes the segment exactly: use the planted text when it is in the
    // segment, else the keywords that located it.
    const want = norm(c.source.contains);
    const quote = norm(seg.text).includes(want) ? c.source.contains : (c.keywords ?? []).find((k) => norm(seg.text).includes(norm(k))) ?? null;
    const id = `clm_gt_${sha256Hex(`${ws}|${c.id}`).slice(0, 12)}`;
    const roleSet = seg.roleSet;
    const importance = "normal";
    const sensitive = pack.restrictedAudienceRoles.some((r) => !roleSet.includes(r));
    const tier = sensitive || c.state === "conflicting" ? "C" : "B";
    await sql`
      INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state,
        state_note, role_set, valid_from, author_id, source_kinds, importance, tier, review, origin, source_ids)
      VALUES (${ws}, ${id}, ${c.entity}, ${entityLabel(c.entity, pack)}, ${c.attribute}, ${c.value},
        ${`${entityLabel(c.entity, pack)}: ${c.value}`},
        ${JSON.stringify([{ segmentId: seg.id, quote, accepted: true, exact: Boolean(quote) }])}::jsonb,
        ${quote ? "from_record" : "inferred"}, ${c.state}, ${c.state === "active" ? null : `Planted: ${c.state}`},
        ${roleSet}::text[], ${seg.ts}, ${seg.authorId}, ${[seg.sourceKind]}::text[], ${importance}, ${tier}, 'pending',
        'extracted', ${[seg.sourceId]}::text[])
      ON CONFLICT (workspace_id, id) DO NOTHING`;
    seeded++;
    placed.push({ id, gtId: c.id, roleSet });
  }
  // Flag visibility, as verify() writes it: a planted conflict with a side a role cannot read
  // hides every side from that role.
  const idOf = new Map(placed.map((p) => [p.gtId, p.id]));
  const firings = (gt.conflicts ?? [])
    .filter((c) => c.claims.length === 2 && c.claims.every((x) => idOf.has(x)))
    .map((c) => ({ rule: 3 as const, olderId: idOf.get(c.claims[0])!, newerId: idOf.get(c.claims[1])! }));
  for (const [id, flag] of flagRoleSets(placed, firings)) {
    if (flag) await sql`UPDATE claims SET flag_role_set = ${flag}::text[] WHERE workspace_id = ${ws} AND id = ${id}`;
  }
  return { seeded, unmatched };
}
