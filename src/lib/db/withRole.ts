// The compile boundary (docs/ARCHITECTURE.md section 5). Every role-scoped read
// (compile, successor test, gap questions, handover, export) runs inside withRole:
//   BEGIN; SET LOCAL ROLE us_reader;
//   SELECT set_config('request.jwt.claims', '{"workspace_id":"…","role_key":"…"}', true);
//   …fn…; COMMIT
// RLS policies on segments, claims, contacts and snapshot_claims then decide which rows exist.
import type { Sql, TransactionSql } from "postgres";
import { db } from "./client";
import type { RoleKey } from "@/lib/types";

export const ROLE_KEYS: readonly RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];

export function isRoleKey(x: unknown): x is RoleKey {
  return typeof x === "string" && (ROLE_KEYS as readonly string[]).includes(x);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(x: unknown): x is string {
  return typeof x === "string" && UUID_RE.test(x);
}

export type RoleTx = TransactionSql;

export async function withRole<T>(
  workspaceId: string,
  role: RoleKey,
  fn: (tx: RoleTx) => Promise<T>,
  sql: Sql = db(),
): Promise<T> {
  if (!isUuid(workspaceId)) throw new Error("withRole: workspaceId must be a uuid");
  if (!isRoleKey(role)) throw new Error("withRole: unknown role");
  const claims = JSON.stringify({ workspace_id: workspaceId, role_key: role });
  return (await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE us_reader`;
    await tx`SELECT set_config('request.jwt.claims', ${claims}, true)`;
    return fn(tx);
  })) as T;
}
