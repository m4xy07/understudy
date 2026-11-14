// GitHub folder: commits.json + repository files under files/ + an optional runs.json (CI run
// history). One `commit` segment per commit; each file becomes `file` segments split by markdown
// heading or top-level YAML key; each CI run becomes one `run` segment (read only by recovery).
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

/** One CI run as the demo export and the code host's run list give it (flat array in runs.json). */
interface RawRun {
  id?: number | string;
  run_number?: number;
  run_attempt?: number;
  rerun_of?: number | string | null;
  workflow_file?: string;
  name?: string;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  status?: string;
  failed_step?: string | null;
  started_at?: string;
  duration_s?: number;
  actor_name?: string;
  actor_email?: string;
}

/** The text of a run segment: one fact per line, so the trace reader can quote a line word for word. */
export function runText(r: RawRun, rerunOfNumber: number | null): string {
  const lines = [
    `CI run ${r.run_number ?? "?"} (attempt ${r.run_attempt ?? 1}) of ${r.name || "workflow"}: ${r.status || "unknown"}`,
    `Workflow file: ${posix(r.workflow_file || "")}`,
    `Trigger: ${r.event || "unknown"} to ${r.head_branch || "?"} at commit ${(r.head_sha || "").slice(0, 7)}`,
  ];
  if (r.failed_step) lines.push(`Failed step: ${r.failed_step}`);
  if (r.rerun_of != null) lines.push(rerunOfNumber != null ? `Re-run of run ${rerunOfNumber}, same commit` : "Re-run of an earlier run, same commit");
  if (typeof r.duration_s === "number") lines.push(`Took ${r.duration_s} s`);
  return lines.join("\n");
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

  // CI run history, after commits and files so every earlier segment and person id stays the same.
  const runsFile = files.find((f) => /(^|\/)runs\.json$/i.test(posix(f.path)) && !/(^|\/)files\//.test(posix(f.path)));
  if (runsFile) {
    let list: unknown;
    try {
      list = JSON.parse(stripBom(runsFile.content));
    } catch (e) {
      b.reject(0, runsFile.path, `runs.json is not valid JSON: ${(e as Error).message}`);
      list = [];
    }
    const runs = Array.isArray(list) ? (list as RawRun[]) : [];
    const numberById = new Map(runs.filter((r) => r && r.id != null).map((r) => [String(r.id), Number(r.run_number)]));
    runs.forEach((r, i) => {
      const line = i + 1;
      if (!r || typeof r !== "object") return b.reject(line, String(r), "run is not an object");
      if (!r.workflow_file || typeof r.run_number !== "number") {
        return b.reject(line, JSON.stringify(r).slice(0, 300), "run has no workflow_file or run_number");
      }
      const ts = parseDateLoose(r.started_at);
      if (!ts) return b.reject(line, JSON.stringify(r).slice(0, 300), `run ${r.run_number} has a bad started_at`);
      const person = r.actor_name || r.actor_email
        ? ctx.people.resolve({ displayName: b.mask(r.actor_name || "unknown"), email: r.actor_email ?? null, scope: ctx.sourceId })
        : null;
      const rerunOf = r.rerun_of != null ? numberById.get(String(r.rerun_of)) ?? null : null;
      b.add({
        kind: "run",
        ts,
        thread: `runs:${posix(r.workflow_file)}`,
        rawText: runText(r, rerunOf != null && Number.isFinite(rerunOf) ? rerunOf : null),
        authorId: person?.id ?? null,
        meta: {
          runId: r.id != null ? String(r.id) : null,
          runNumber: r.run_number,
          runAttempt: r.run_attempt ?? 1,
          rerunOf: r.rerun_of != null ? String(r.rerun_of) : null,
          workflowFile: posix(r.workflow_file),
          workflowName: b.maskSilent(r.name ?? ""),
          event: r.event ?? null,
          headBranch: r.head_branch ?? null,
          sha: r.head_sha ?? null,
          status: r.status ?? "unknown",
          failedStep: r.failed_step ? b.maskSilent(r.failed_step) : null,
          durationS: typeof r.duration_s === "number" ? r.duration_s : null,
        },
      });
    });
  }
  return b.result();
}
