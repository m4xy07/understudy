// The "Viewing as" role lives in a cookie per workspace: us_role_<workspaceId>.
// Server-side checks always read it from here (never from client input).
import { cookies } from "next/headers";
import { isRoleKey } from "@/lib/db/withRole";
import type { RoleKey } from "@/lib/types";

export const DEFAULT_ROLE: RoleKey = "president";

export function roleCookieName(ws: string): string {
  return `us_role_${ws}`;
}

export async function getRole(ws: string): Promise<RoleKey> {
  const value = (await cookies()).get(roleCookieName(ws))?.value;
  return isRoleKey(value) ? value : DEFAULT_ROLE;
}
