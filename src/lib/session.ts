// The "Viewing as" role lives in a cookie per workspace: us_role_<workspaceId>.
// Server-side checks always read it from here (never from client input).
import { cookies } from "next/headers";
import { getWorkspacePack, isRoleOf, type ResolvedPack } from "@/lib/pack";
import type { RoleKey } from "@/lib/types";

export function roleCookieName(ws: string): string {
  return `us_role_${ws}`;
}

/** Pure part of getRole: a cookie value that is not a role of this pack counts as no cookie. */
export function roleFromCookie(value: unknown, pack: Pick<ResolvedPack, "roles" | "approverRole">): RoleKey {
  return isRoleOf(pack, value) ? value : pack.approverRole;
}

/**
 * The viewing role of this workspace. A missing cookie, or one that holds a key of another pack,
 * gives the pack's approver role (the role a fresh workspace opens as).
 */
export async function getRole(ws: string, pack: Pick<ResolvedPack, "roles" | "approverRole">): Promise<RoleKey> {
  return roleFromCookie((await cookies()).get(roleCookieName(ws))?.value, pack);
}

/** getRole for callers that have not loaded the pack yet (server actions, route handlers). */
export async function viewingRole(ws: string): Promise<RoleKey> {
  return getRole(ws, await getWorkspacePack(ws));
}
