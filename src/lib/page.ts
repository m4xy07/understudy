// Shared loader for /w/[id]/* pages: workspace (404 when missing), viewing role, pack.
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/db/queries";
import { getRole } from "@/lib/session";
import { getPack, roleLabel } from "@/lib/pack";
import type { RoleKey } from "@/lib/types";

export type WsParams = Promise<{ id: string }>;
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function loadWorkspace(params: WsParams) {
  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  const role = await getRole(id);
  const pack = getPack();
  return { id, workspace, role, pack, roleName: roleLabel(role, pack) };
}

export function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export function roleOptions(pack: ReturnType<typeof getPack>): { key: RoleKey; label: string }[] {
  return pack.roles.map((r) => ({ key: r.key as RoleKey, label: r.label }));
}
