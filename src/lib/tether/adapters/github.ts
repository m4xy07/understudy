// GitHub folder: commits.json + repository files under files/. One `commit` segment per commit;
// each file becomes `file` segments split by markdown heading or top-level YAML key.
import type { AdapterResult } from "@/lib/types";
import { parseDateLoose } from "../ids";
import {
  EPOCH_IST,
  posix,
  ResultBuilder,
  splitMarkdown,
  splitPlain,
  splitYamlTopLevel,
  stripBom,
  type AdapterContext,
  type SourceFile,
} from "./common";

interface RawCommit {
  sha?: string;
  author_name?: string;
  author_email?: string;
  date?: string;
  message?: string;
  files?: ({ path?: string; filename?: string; status?: string } | string)[];
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|bin|hex|elf|so|dll|exe|woff2?|ttf|mp[34]|mov)$/i;

export function parseGithub(files: SourceFile[], ctx: AdapterContext): AdapterResult {
  const b = new ResultBuilder(ctx, "github");
  const commitsFile = files.find((f) => /(^|\/)commits\.json$/i.test(posix(f.path)));
  // path -> newest commit touching it
  const lastTouch = new Map<string, { ts: string; authorId: string | null; sha: string }>();
  let newestTs: string | null = null;

  if (commitsFile) {
    let list: unknown;
    try {
      list = JSON.parse(stripBom(commitsFile.content));
    } catch (e) {
      b.reject(0, commitsFile.path, `commits.json is not valid JSON: ${(e as Error).message}`);
      list = [];
    }
    const commits = Array.isArray(list) ? (list as RawCommit[]) : [];
    commits.forEach((c, i) => {
      const line = i + 1;
      if (!c || typeof c !== "object") return b.reject(line, String(c), "commit is not an object");
      if (!c.sha) return b.reject(line, JSON.stringify(c).slice(0, 300), "commit has no sha");
      const ts = parseDateLoose(c.date);
      if (!ts) return b.reject(line, JSON.stringify(c).slice(0, 300), `commit ${c.sha.slice(0, 7)} has a bad date`);
      const person = c.author_name || c.author_email
        ? ctx.people.resolve({ displayName: b.mask(c.author_name || "unknown"), email: c.author_email ?? null, scope: ctx.sourceId })
        : null;
      const paths = (c.files ?? [])
        .map((f) => (typeof f === "string" ? f : f?.path ?? f?.filename ?? ""))
        .filter((p): p is string => !!p)
        .map(posix);
      const statuses = (c.files ?? []).map((f) => (typeof f === "string" ? "modified" : f?.status ?? "modified"));
      b.add({
        kind: "commit",
        ts,
        thread: "commits",
        rawText: (c.message ?? "").trim() || "(no commit message)",
        authorId: person?.id ?? null,
        meta: { sha: c.sha, files: paths, fileStatuses: statuses },
      });
      if (!newestTs || ts > newestTs) newestTs = ts;
      for (const p of paths) {
        const prev = lastTouch.get(p);
        if (!prev || ts > prev.ts) lastTouch.set(p, { ts, authorId: person?.id ?? null, sha: c.sha });
      }
    });
  }

  const repoFiles = files
    .map((f) => ({ ...f, rel: posix(f.path) }))
    .filter((f) => f !== commitsFile && /(^|\/)files\//.test(f.rel))
    .map((f) => ({ ...f, rel: f.rel.replace(/^(.*?\/)?files\//, "") }))
    .sort((a, c) => a.rel.localeCompare(c.rel));

  for (const f of repoFiles) {
    if (BINARY_EXT.test(f.rel) || f.content.includes("\u0000")) {
      b.reject(0, f.rel, "binary file skipped");
      continue;
    }
    const touch = lastTouch.get(f.rel);
    const ts = touch?.ts ?? newestTs ?? EPOCH_IST;
    const content = stripBom(f.content);
    let chunks: { section: string | null; text: string }[];
    if (/\.(md|markdown|mdx)$/i.test(f.rel)) chunks = splitMarkdown(content).map((c) => ({ section: c.heading, text: c.text }));
    else if (/\.ya?ml$/i.test(f.rel)) chunks = splitYamlTopLevel(content).map((c) => ({ section: c.key, text: c.text }));
    else chunks = splitPlain(content).map((t) => ({ section: null, text: t }));
    for (const c of chunks) {
      b.add({
        kind: "file",
        ts,
        thread: f.rel,
        rawText: c.text,
        authorId: touch?.authorId ?? null,
        meta: { path: f.rel, section: c.section ? b.maskSilent(c.section) : null, lastCommitSha: touch?.sha ?? null },
      });
    }
  }
  return b.result();
}
