// POST multipart/form-data: kind, files (multiple), optional roles (narrow who can see it).
import { getWorkspace } from "@/lib/db/queries";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import { ingestUpload, UPLOAD_KINDS, UPLOAD_LIMIT_BYTES } from "@/lib/pipeline/ingest";
import { viewingRole } from "@/lib/session";
import type { RoleKey, SourceKind } from "@/lib/types";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!(await getWorkspace(id))) return Response.json({ ok: false, error: "Workspace not found." }, { status: 404 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > UPLOAD_LIMIT_BYTES + 64 * 1024) {
    return Response.json({ ok: false, error: "Upload is over 5 MB. Split it or trim it." }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Could not read the upload." }, { status: 400 });
  }
  const kind = String(form.get("kind") ?? "") as SourceKind;
  if (!UPLOAD_KINDS.includes(kind)) return Response.json({ ok: false, error: "Pick a source type." }, { status: 400 });
  const files: { path: string; content: string }[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string") continue;
    const path = (entry as File & { webkitRelativePath?: string }).webkitRelativePath || entry.name;
    files.push({ path: path.split(String.fromCharCode(92)).join("/"), content: await entry.text() });
  }
  const pack = await getWorkspacePack(id);
  const narrow = form.getAll("roles").map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
  const res = await ingestUpload(id, kind, files, { narrowRoles: narrow, actor: await viewingRole(id) });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
