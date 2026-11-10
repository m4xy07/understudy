// Role-scoped reads for the claim ledger (all through withRole, so RLS decides what exists).
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import type { RoleKey } from "@/lib/types";

export interface DroppedItem {
  id: string;
  sourceId: string;
  sourceName: string;
  reason: string;
  entity: string;
  attribute: string;
  statement: string;
}

/** Drafts the verifier dropped that this role may see (role set of the batch the model read). */
export async function listDropped(ws: string, role: RoleKey): Promise<DroppedItem[]> {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await withRole(ws, role, (tx) =>
      tx`SELECT id, source_id, reason, entity, attribute, statement FROM attest_dropped
         WHERE workspace_id = ${ws} ORDER BY source_id, entity, attribute`);
  } catch {
    return []; // table missing (migration not applied): show nothing rather than fail the page
  }
  const names = new Map<string, string>();
  for (const s of await db()`SELECT id, name FROM sources WHERE workspace_id = ${ws}`) names.set(String(s.id), String(s.name));
  return rows.map((r) => ({
    id: String(r.id),
    sourceId: String(r.source_id),
    sourceName: names.get(String(r.source_id)) ?? String(r.source_id),
    reason: String(r.reason),
    entity: String(r.entity),
    attribute: String(r.attribute),
    statement: String(r.statement),
  }));
}

/** The latest extraction note (model used / unavailable / failed batches). No claim content. */
export async function extractionNote(ws: string): Promise<{ note: string | null; failed: number; batches: number } | null> {
  try {
    const [r] = await db()`SELECT model_note, batches FROM attest_runs WHERE workspace_id = ${ws}`;
    if (!r) return null;
    const batches = (r.batches as { ok: boolean }[]) ?? [];
    return { note: (r.model_note as string | null) ?? null, failed: batches.filter((b) => !b.ok).length, batches: batches.length };
  } catch {
    return null;
  }
}
