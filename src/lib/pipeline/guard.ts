// Guards that keep the app standing when the same thing is asked twice (a double click, a second
// tab, a retry after a slow answer) and when someone runs up the model bill.
//   * Action leases: one holder at a time per (workspace, key). A repeat is refused with a
//     friendly note instead of doing the work twice. A lease expires by itself, so a crashed
//     request can never block the workspace for long. No session locks: safe on a transaction pooler.
//   * Spend cap: live model calls per workspace per day (and for the whole deployment).
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { ModelContext } from "@/lib/model/client";

// ---------------------------------------------------------------------------------------------
// Action leases

/**
 * The time a server action may take (the pages export maxDuration = 300): no live model call
 * starts after ACTION_BUDGET_MS, none runs past ACTION_HARD_MS, and every action lease lives at
 * least ACTION_LEASE_MS, so a lease can never expire while its action is still working.
 */
export const ACTION_MAX_DURATION_S = 300;
export const ACTION_BUDGET_MS = 150_000;
export const ACTION_HARD_MS = 270_000;
export const ACTION_LEASE_MS = ACTION_MAX_DURATION_S * 1000;

/** Ids the app itself makes (uuid, gq_…, clm_…, step ids): short, no spaces, no control characters. */
export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,159}$/.test(value);
}

/**
 * The stored form of a lease key. Keys made of a fixed word are kept readable; anything longer
 * or with unexpected characters (a key built from a form value) is stored as its hash, so a
 * client string can never grow the table's key or carry odd characters into it.
 */
export function leaseKey(key: string): string {
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(key) ? key : `h:${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
}

/** Take the lease; null when someone else holds it and it has not expired. */
export async function acquireLease(ws: string, rawKey: string, ttlMs = 120_000): Promise<string | null> {
  const key = leaseKey(rawKey);
  const holder = randomUUID();
  const rows = await db()`
    INSERT INTO action_leases (workspace_id, key, holder, expires_at)
    VALUES (${ws}, ${key}, ${holder}, now() + make_interval(secs => ${ttlMs / 1000}))
    ON CONFLICT (workspace_id, key) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
      WHERE action_leases.expires_at < now()
    RETURNING holder`;
  return rows.length ? holder : null;
}

export async function releaseLease(ws: string, rawKey: string, holder: string): Promise<void> {
  const key = leaseKey(rawKey);
  await db()`DELETE FROM action_leases WHERE workspace_id = ${ws} AND key = ${key} AND holder = ${holder}`.catch(() => {});
}

/** True while an unexpired lease with this key exists. */
export async function leaseHeld(ws: string, rawKey: string): Promise<boolean> {
  const key = leaseKey(rawKey);
  const rows = await db()`
    SELECT 1 FROM action_leases WHERE workspace_id = ${ws} AND key = ${key} AND expires_at > now()`;
  return rows.length > 0;
}

/**
 * Run `fn` unless the same action is already in progress for this workspace (in another tab, or
 * from the first of two clicks): then return `busy` and do nothing. The lease is released when
 * `fn` settles, and expires by itself after `ttlMs` if the request dies.
 * Fails closed: when the lease table cannot be reached, `fn` does not run unguarded (two tabs
 * could then both do the work); the caller gets `busy` (or `opts.onError`) and the user retries.
 */
export async function exclusive<T>(
  ws: string, key: string, fn: () => Promise<T>, busy: T, ttlMs = 120_000, waitMs = 0,
  opts: { /** Returned instead of `busy` when the lease could not be read or written. */ onError?: T } = {},
): Promise<T> {
  let holder: string | null;
  try {
    holder = await acquireLease(ws, key, ttlMs);
    // Optionally wait for the other holder to finish (short work, e.g. two uploads at once).
    for (const until = Date.now() + waitMs; !holder && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 250));
      holder = await acquireLease(ws, key, ttlMs);
    }
  } catch (err) {
    console.error(`[guard ${ws}] lease ${leaseKey(key)} unavailable; the action was not run`, err);
    return opts.onError !== undefined ? opts.onError : busy;
  }
  if (!holder) return busy;
  try {
    return await fn();
  } finally {
    await releaseLease(ws, key, holder);
  }
}

// ---------------------------------------------------------------------------------------------
// Spend cap

function capFrom(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Live model calls allowed per day. 0 means no cap. Set with the two environment values. */
export function spendCaps(): { perWorkspace: number; global: number } {
  return {
    perWorkspace: capFrom("MODEL_CALLS_PER_WORKSPACE_PER_DAY", 400),
    global: capFrom("MODEL_CALLS_PER_DAY", 4000),
  };
}

export const SPEND_MESSAGE_WORKSPACE =
  "This workspace has used its live model budget for today. Cached answers and the demo still work; live calls start again tomorrow.";
export const SPEND_MESSAGE_GLOBAL =
  "The demo's live model budget for today is used. Cached answers and the demo still work; live calls start again tomorrow.";

let globalSeen: { at: number; calls: number } | null = null;
const GLOBAL_TTL_MS = 10_000;

async function globalCallsToday(): Promise<number> {
  if (globalSeen && Date.now() - globalSeen.at < GLOBAL_TTL_MS) return globalSeen.calls;
  const [row] = await db()`SELECT coalesce(sum(calls), 0)::int AS n FROM model_spend WHERE day = current_date`;
  globalSeen = { at: Date.now(), calls: Number(row?.n ?? 0) };
  return globalSeen.calls;
}

/** For tests: forget the memoised deployment-wide count. */
export function resetSpendMemo(): void {
  globalSeen = null;
}

/**
 * Count one live model call against the workspace's budget for today. Returns null when the call
 * may go ahead, or the message to show when a cap is reached. Atomic: parallel calls cannot pass
 * the cap together. If the counter cannot be reached the call is allowed (the cap is a guard).
 */
export async function chargeModelCall(ws: string): Promise<string | null> {
  const caps = spendCaps();
  try {
    if (caps.global > 0 && (await globalCallsToday()) >= caps.global) return SPEND_MESSAGE_GLOBAL;
    if (caps.perWorkspace > 0) {
      const rows = await db()`
        INSERT INTO model_spend (workspace_id, day, calls) VALUES (${ws}, current_date, 1)
        ON CONFLICT (workspace_id, day) DO UPDATE SET calls = model_spend.calls + 1
          WHERE model_spend.calls < ${caps.perWorkspace}
        RETURNING calls`;
      if (!rows.length) return SPEND_MESSAGE_WORKSPACE;
    } else {
      await db()`
        INSERT INTO model_spend (workspace_id, day, calls) VALUES (${ws}, current_date, 1)
        ON CONFLICT (workspace_id, day) DO UPDATE SET calls = model_spend.calls + 1`;
    }
    if (globalSeen) globalSeen.calls++;
    return null;
  } catch (err) {
    console.error(`[guard ${ws}] spend counter unavailable`, err);
    return null;
  }
}

/** Live model calls this workspace has made today, and its cap (0 = none). */
export async function spendToday(ws: string): Promise<{ calls: number; cap: number }> {
  const [row] = await db()`SELECT calls FROM model_spend WHERE workspace_id = ${ws} AND day = current_date`;
  return { calls: Number(row?.calls ?? 0), cap: spendCaps().perWorkspace };
}

/**
 * The model context of a server action: every live call is charged to the workspace's budget, no
 * live call starts after `budgetMs`, and none runs past the action's hard limit (so the action
 * always answers inside the page's maxDuration).
 */
export function actionContext(ws: string, budgetMs = ACTION_BUDGET_MS): ModelContext {
  const now = Date.now();
  return spendContext(ws, { deadline: now + budgetMs, hardDeadline: now + Math.max(budgetMs, ACTION_HARD_MS) });
}

/** A model context that charges every live call to the workspace's budget. */
export function spendContext(ws: string, extra: Omit<ModelContext, "gate"> = {}): ModelContext {
  return { ...extra, gate: () => chargeModelCall(ws) };
}
