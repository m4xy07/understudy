// Role holders: which person records hold which role in a workspace.
//
// The app has roles, not people: a role decides what someone may see. For "who could I ask
// instead of the leaver" the product also needs to know which people sit in which role. The pack
// states that by full name (pack.roleHolders); this file matches those names to the person
// records Tether found in the sources and stores the result in `role_holders`.
//
// A role nobody holds (for example a generic "new member" audience) has no rows.
// Admin path only: the table is not readable by the role-scoped reader.
import { db } from "@/lib/db/client";
import { getWorkspacePack, type ResolvedPack } from "@/lib/pack";
import type { Person, RoleKey } from "@/lib/types";

export interface RoleHolder {
  roleKey: RoleKey;
  personId: string;
  displayName: string;
  /** Who stated it: the pack's roleHolders, or the approver in the app. */
  source: "pack" | "approver";
}

/** Lower case, single spaces, no punctuation at the ends: "Rohan  Mehta." equals "rohan mehta". */
function nameKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Pure matching. A person record holds a role when its display name or one of its aliases equals
 * a holder name the pack lists for that role (compared without case or punctuation). The leaver
 * role also takes every record that matches pack.leaverPerson (name or aliases, as a word), the
 * same rule Lacuna uses for the leaver's footprint.
 */
export function matchRoleHolders(
  pack: Pick<ResolvedPack, "roleHolders" | "leaverRole" | "leaverPerson">,
  people: readonly Person[],
): { roleKey: RoleKey; personId: string }[] {
  const out: { roleKey: RoleKey; personId: string }[] = [];
  const seen = new Set<string>();
  const add = (roleKey: RoleKey, personId: string) => {
    const k = `${roleKey}\u0000${personId}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ roleKey, personId });
  };
  for (const [roleKey, names] of Object.entries(pack.roleHolders ?? {})) {
    const wanted = new Set(names.map(nameKey).filter(Boolean));
    for (const p of people) {
      if ([p.displayName, ...p.aliases].some((x) => wanted.has(nameKey(x)))) add(roleKey, p.id);
    }
  }
  const leaverWords = [pack.leaverPerson.name, ...(pack.leaverPerson.aliases ?? [])]
    .map((x) => nameKey(x).split(" ")[0])
    .filter(Boolean);
  for (const p of people) {
    const words = [p.displayName, ...p.aliases].flatMap((x) => nameKey(x).split(" "));
    if (leaverWords.some((w) => words.includes(w))) add(pack.leaverRole, p.id);
  }
  return out;
}

/**
 * Match the pack's role holders to the workspace's person records and store them. Called when a
 * workspace is created and after every ingest (new sources bring new person records). Idempotent:
 * existing rows are kept, including any the approver set by hand.
 */
export async function syncRoleHolders(ws: string, pack?: ResolvedPack): Promise<number> {
  const sql = db();
  const p = pack ?? (await getWorkspacePack(ws));
  const people = (await sql`SELECT id, display_name, email_hmac, aliases FROM people WHERE workspace_id = ${ws}`).map(
    (r): Person => ({
      id: String(r.id),
      displayName: String(r.display_name),
      emailHmac: (r.email_hmac as string | null) ?? null,
      aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
    }),
  );
  const rows = matchRoleHolders(p, people).map((m) => ({ workspace_id: ws, role_key: m.roleKey, person_id: m.personId, source: "pack" }));
  if (!rows.length) return 0;
  const res = await sql`INSERT INTO role_holders ${sql(rows)} ON CONFLICT (workspace_id, role_key, person_id) DO NOTHING RETURNING person_id`;
  return res.length;
}

/** Every role holder of the workspace, in pack role order, then by person id. */
export async function listRoleHolders(ws: string): Promise<RoleHolder[]> {
  const pack = await getWorkspacePack(ws);
  const rows = await db()`
    SELECT h.role_key, h.person_id, h.source, coalesce(p.display_name, h.person_id) AS display_name
    FROM role_holders h
    LEFT JOIN people p ON p.workspace_id = h.workspace_id AND p.id = h.person_id
    WHERE h.workspace_id = ${ws}`;
  const order = (k: string) => {
    const i = pack.roleOrder.indexOf(k);
    return i === -1 ? pack.roleOrder.length : i;
  };
  return rows
    .map((r): RoleHolder => ({
      roleKey: String(r.role_key),
      personId: String(r.person_id),
      displayName: String(r.display_name),
      source: r.source === "approver" ? "approver" : "pack",
    }))
    .sort((a, b) => order(a.roleKey) - order(b.roleKey) || a.personId.localeCompare(b.personId, "en", { numeric: true }));
}

/** role key -> person ids, and person id -> role keys. */
export interface RoleHolderIndex {
  byRole: Map<RoleKey, string[]>;
  byPerson: Map<string, RoleKey[]>;
}

/** Make sure the holders are matched (cheap and idempotent), then return them as an index. */
export async function ensureRoleHolders(ws: string): Promise<RoleHolderIndex> {
  await syncRoleHolders(ws);
  const byRole = new Map<RoleKey, string[]>();
  const byPerson = new Map<string, RoleKey[]>();
  for (const h of await listRoleHolders(ws)) {
    byRole.set(h.roleKey, [...(byRole.get(h.roleKey) ?? []), h.personId]);
    byPerson.set(h.personId, [...(byPerson.get(h.personId) ?? []), h.roleKey]);
  }
  return { byRole, byPerson };
}
