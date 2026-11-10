// Markdown notes: optional front matter (title, date, author, author_email, roles). `roles`
// narrows the source role set (intersection, never widens). Split into segments by heading.
import matter from "gray-matter";
import type { AdapterResult, RoleKey } from "@/lib/types";
import { parseDateLoose } from "../ids";
import { EPOCH_IST, posix, ResultBuilder, splitMarkdown, stripBom, type AdapterContext, type SourceFile } from "./common";

function rolesFrom(v: unknown): string[] | null {
  if (v === undefined || v === null || v === "") return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}

export function parseMarkdown(files: SourceFile[], ctx: AdapterContext): AdapterResult {
  const b = new ResultBuilder(ctx, "markdown");
  const sorted = [...files].sort((a, c) => posix(a.path).localeCompare(posix(c.path)));
  for (const file of sorted) {
    if (!/\.(md|markdown|txt)$/i.test(file.path)) continue;
    const thread = posix(file.path);
    let fm: Record<string, unknown> = {};
    let body: string;
    try {
      const parsed = matter(stripBom(file.content), {});
      fm = (parsed.data ?? {}) as Record<string, unknown>;
      body = parsed.content;
    } catch (e) {
      b.reject(1, thread, `front matter is not valid YAML: ${(e as Error).message}`);
      continue;
    }

    let roleSet: RoleKey[] = [...ctx.roleSet];
    const narrowed = rolesFrom(fm.roles);
    if (narrowed) roleSet = ctx.roleSet.filter((r) => narrowed.includes(r));

    let ts = EPOCH_IST;
    if (fm.date !== undefined) {
      const d = parseDateLoose(fm.date);
      if (d) ts = d;
      else b.reject(1, `date: ${String(fm.date)}`, `${thread}: bad front matter date, note left undated`);
    }

    const authorName = typeof fm.author === "string" ? fm.author : null;
    const authorEmail = typeof fm.author_email === "string" ? fm.author_email : null;
    const author = authorName || authorEmail
      ? ctx.people.resolve({ displayName: b.mask(authorName || "unknown"), email: authorEmail, scope: ctx.sourceId })
      : null;
    const title = typeof fm.title === "string" ? b.mask(fm.title) : null;

    for (const chunk of splitMarkdown(body)) {
      b.add({
        kind: "note",
        ts,
        thread,
        rawText: chunk.text,
        authorId: author?.id ?? null,
        roleSet,
        meta: {
          path: thread,
          title,
          section: chunk.heading ? b.maskSilent(chunk.heading) : null,
          undated: ts === EPOCH_IST,
          ...(narrowed ? { rolesNarrowed: roleSet } : {}),
        },
      });
    }
  }
  return b.result();
}
