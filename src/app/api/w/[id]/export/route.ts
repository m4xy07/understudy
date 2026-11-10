// GET: the handover as Markdown for the role in the cookie (same compile as the page, read under
// RLS, rendered by renderMarkdown). Refused if the leak check finds a token the role may not see.
import { getWorkspace } from "@/lib/db/queries";
import { getRole } from "@/lib/session";
import { exportMarkdown } from "@/lib/relay";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const text = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (!(await getWorkspace(id))) return new Response("Workspace not found.", { status: 404, headers: text });
  const role = await getRole(id);
  const res = await exportMarkdown(id, role);
  if (!res.ok) return new Response(res.error, { status: res.status, headers: text });
  return new Response(res.markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${res.filename}"`,
      "cache-control": "no-store",
    },
  });
}
