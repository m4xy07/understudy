"use server";
// The role switcher's action. Everything else a page can do lives in that page's own actions.ts,
// behind its lease, deadline and spend cap; the older copies that used to live here (with none of
// those guards) are gone, so they can no longer be called as server actions.
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { roleCookieName } from "@/lib/session";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";

export async function setRole(ws: string, role: string): Promise<void> {
  if (!isUuid(ws) || !(await getWorkspace(ws))) return;
  // Only a role of this workspace's pack can be picked.
  if (!isRoleOf(await getWorkspacePack(ws), role)) return;
  (await cookies()).set(roleCookieName(ws), role, {
    path: "/", sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 7,
  });
  refresh();
}
