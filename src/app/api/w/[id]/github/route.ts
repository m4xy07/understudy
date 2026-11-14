// POST JSON { url, roles? }: import a public GitHub repository as a `github` source.
import { getWorkspace } from "@/lib/db/queries";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import { ingestGithubUrl } from "@/lib/pipeline/ingest";
import { viewingRole } from "@/lib/session";
import type { RoleKey } from "@/lib/types";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!(await getWorkspace(id))) return Response.json({ ok: false, error: "Workspace not found." }, { status: 404 });
  let body: { url?: unknown; roles?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Send JSON { url }." }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return Response.json({ ok: false, error: "Paste a public GitHub repository URL." }, { status: 400 });
  const pack = await getWorkspacePack(id);
  const narrow = (Array.isArray(body.roles) ? body.roles : []).map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
  const res = await ingestGithubUrl(id, url, { narrowRoles: narrow, actor: await viewingRole(id) });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
