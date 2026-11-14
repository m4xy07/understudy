// POST JSON { url, roles? }: import a public GitHub repository as a `github` source.
// Every refusal is JSON { ok: false, error } with a sentence a person can act on.
import { getWorkspace } from "@/lib/db/queries";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import { ingestGithubUrl, type IngestResult } from "@/lib/pipeline/ingest";
import { exclusive } from "@/lib/pipeline/guard";
import { viewingRole } from "@/lib/session";
import type { RoleKey } from "@/lib/types";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
const MAX_URL = 300;

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    if (!(await getWorkspace(id))) return refuse("Workspace not found.", 404);
    let body: { url?: unknown; roles?: unknown } | null;
    try {
      body = await req.json();
    } catch {
      return refuse("Send JSON { url }.");
    }
    const url = body && typeof body === "object" && typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return refuse("Paste a public GitHub repository URL.");
    if (url.length > MAX_URL) return refuse("That is too long to be a GitHub repository URL. Use https://github.com/<owner>/<repo>.");
    const pack = await getWorkspacePack(id);
    const roles = body && Array.isArray(body.roles) ? body.roles : [];
    const narrow = roles.map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
    const actor = await viewingRole(id);
    const busy: IngestResult = { ok: false, error: "Another import to this workspace is still being read. Wait a few seconds and try again." };
    const res = await exclusive(id, "ingest", () => ingestGithubUrl(id, url, { narrowRoles: narrow, actor }), busy, 60_000, 15_000);
    return Response.json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    console.error(`[github ${id}] failed`, err);
    return refuse("The repository could not be imported. Nothing was saved; try again in a moment.", 500);
  }
}
