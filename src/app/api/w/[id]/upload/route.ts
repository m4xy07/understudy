// POST multipart/form-data: kind, files (multiple), optional roles (narrow who can see it).
// Every refusal is JSON { ok: false, error } with a sentence a person can act on.
import { getWorkspace } from "@/lib/db/queries";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import { ingestUpload, UPLOAD_KINDS, UPLOAD_KIND_LABEL, UPLOAD_LIMIT_BYTES, UPLOAD_LIMIT_MESSAGE, type IngestResult } from "@/lib/pipeline/ingest";
import { exclusive } from "@/lib/pipeline/guard";
import { viewingRole } from "@/lib/session";
import type { RoleKey, SourceKind } from "@/lib/types";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    if (!(await getWorkspace(id))) return refuse("Workspace not found.", 404);
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > UPLOAD_LIMIT_BYTES + 64 * 1024) return refuse(UPLOAD_LIMIT_MESSAGE, 413);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return refuse("Could not read the upload. Choose the file again and press Upload.");
    }
    const kind = String(form.get("kind") ?? "") as SourceKind;
    if (!UPLOAD_KINDS.includes(kind)) return refuse("Pick a source type.");
    const files: { path: string; content: string }[] = [];
    let bytes = 0;
    for (const entry of form.getAll("files")) {
      if (typeof entry === "string") continue;
      bytes += entry.size;
      if (bytes > UPLOAD_LIMIT_BYTES) return refuse(UPLOAD_LIMIT_MESSAGE, 413);
      const path = (entry as File & { webkitRelativePath?: string }).webkitRelativePath || entry.name;
      files.push({ path: path.split(String.fromCharCode(92)).join("/"), content: await entry.text() });
    }
    const pack = await getWorkspacePack(id);
    const narrow = form.getAll("roles").map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
    const actor = await viewingRole(id);
    // One ingest at a time per workspace: two uploads at once would number new people in parallel.
    const busy: IngestResult = { ok: false, error: "Another upload to this workspace is still being read. Wait a few seconds and press Upload again." };
    const res = await exclusive(id, "ingest", () => ingestUpload(id, kind, files, { narrowRoles: narrow, actor, kindLabel: UPLOAD_KIND_LABEL[kind] }), busy, 60_000, 15_000);
    return Response.json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    console.error(`[upload ${id}] failed`, err);
    return refuse("The upload could not be stored. Nothing was saved; try again in a moment.", 500);
  }
}
