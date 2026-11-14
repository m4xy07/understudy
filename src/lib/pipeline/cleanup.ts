// Scheduled cleanup of old workspaces (Round 2 fix d). The rule lives in the database function
// purge_stale_workspaces (db/migrations/0010_fixes.sql):
//   demo copy                        deleted when created more than DEMO days ago
//   started empty, no snapshot       deleted after IDLE days without activity
//   locked, or has a snapshot        never deleted by the cleanup
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/withRole";

function days(name: string, fallback: number): number {
  const n = Number((process.env[name] ?? "").trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Retention in days: PURGE_DEMO_DAYS (default 7) and PURGE_IDLE_DAYS (default 14). */
export function retention(): { demoDays: number; idleDays: number } {
  return { demoDays: days("PURGE_DEMO_DAYS", 7), idleDays: days("PURGE_IDLE_DAYS", 14) };
}

export const PURGE_BATCH = 200;

export interface PurgeResult {
  dry: boolean;
  count: number;
  /** True when a full batch was found: more may remain for the next call. */
  more: boolean;
  demoDays: number;
  idleDays: number;
}

/** Delete (or, with dry, only count) one batch of stale workspaces. Never touches model_cache. */
export async function purgeStale(opts: { dry?: boolean; max?: number } = {}): Promise<PurgeResult> {
  const { demoDays, idleDays } = retention();
  const max = Math.max(1, Math.min(opts.max ?? PURGE_BATCH, 1000));
  const dry = opts.dry === true;
  const rows = await db()`SELECT purge_stale_workspaces(${demoDays}, ${idleDays}, ${max}, ${dry}) AS id`;
  return { dry, count: rows.length, more: rows.length >= max, demoDays, idleDays };
}

/** Note that a workspace is in use. At most one write an hour per workspace; never throws. */
export async function touchWorkspace(ws: string): Promise<void> {
  if (!isUuid(ws)) return;
  try {
    await db()`
      UPDATE workspaces SET last_active_at = now()
      WHERE id = ${ws} AND last_active_at < now() - interval '1 hour'`;
  } catch {
    // an activity stamp never fails a page
  }
}
