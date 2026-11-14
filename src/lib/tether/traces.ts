// Trace reader (pure): procedures and states read back from what the leaver left behind.
// Contract: docs/ARCHITECTURE.md section 4, "Recovery".
//
// Four artefacts: workflow files, the CI run history, commit sequences and calendar entries.
// Every step cites the segment it came from. A "quoted" step carries a quote that must be found
// word for word in that segment (Attest checks it); a "derived" step is worked out from several
// segments and carries no quote. The reader works on masked text, so a secret value can never
// appear: secrets show up by name only. A trace only ever combines segments that share one
// identical role set, so its role set is exact.
import type { Attribute, Person, RoleKey, Segment } from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";
import { isoWeek, matchEntities, type FootprintEntity, type FootprintThresholds } from "./footprint";
import { toIstIso } from "./ids";

export type TraceKind = "workflow" | "run_history" | "commit_sequence" | "calendar";

export interface TraceStep {
  n: number;
  text: string;
  kind: "quoted" | "derived";
  citations: { segmentId: string; quote: string | null }[];
  path?: string;
  sha?: string;
}

export interface Trace {
  id: string;
  kind: TraceKind;
  entityKey: string;
  /** The claim attribute this trace can fill. */
  attribute: Attribute;
  title: string;
  sourceLabel: string;
  /** One line that sums the trace up; becomes the claim value. */
  value: string;
  steps: TraceStep[];
  roleSet: RoleKey[];
  /** Calendar cadence only: the next date the pattern implies (ISO date), when it can be worked out. */
  impliedNext?: string;
}

const MAX_COMMITS = 8;
const MAX_RUN_BLOCK = 300;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Calendar date of an instant as the sources show it (the adapters write +05:30). */
function isoDay(ts: string): string {
  const t = timeOf(ts);
  return t ? toIstIso(t).slice(0, 10) : ts.slice(0, 10);
}

/** "3 Nov 2026" */
export function plainDate(ts: string): string {
  const d = isoDay(ts);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function traceId(kind: TraceKind, entityKey: string, segmentIds: string[]): string {
  return `trc_${sha256Hex(`${kind}|${entityKey}|${[...new Set(segmentIds)].sort().join(",")}`).slice(0, 12)}`;
}

function number(steps: Omit<TraceStep, "n">[]): TraceStep[] {
  return steps.map((s, i) => ({ n: i + 1, ...s }));
}

function roleKey(roleSet: readonly RoleKey[]): string {
  return [...roleSet].sort().join(",");
}

// ---------------------------------------------------------------------------
// Workflow files
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  /** What to show: the step's name when it has one, else the command or the action. */
  display: string;
  run: string | null;
  uses: string | null;
  workingDirectory: string | null;
  /** 0-based line index of the run/uses line; that line, trimmed, is the quote. */
  line: number;
}

export interface WorkflowDoc {
  name: string | null;
  triggers: { summary: string; line: number }[];
  jobs: { id: string; steps: WorkflowStep[] }[];
  matrix: { values: string[]; line: number }[];
  secrets: { name: string; line: number }[];
  lines: string[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, "");
}

function inlineList(value: string): string[] {
  const m = /^\[(.*)\]$/.exec(value.trim());
  if (!m) return value.trim() ? [unquote(value)] : [];
  return m[1].split(",").map(unquote).filter(Boolean);
}

/** Lines of a block: everything after `start` that is indented deeper than `indent` (blank lines kept). */
function blockEnd(lines: string[], start: number, indent: number): number {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) break;
    end = i + 1;
  }
  return end;
}

/**
 * A line based scan of a workflow file. No YAML library: the quote of every step must be the
 * original line anyway, and a file that is not valid YAML still gives what can be read.
 */
export function parseWorkflow(fileText: string): WorkflowDoc {
  const lines = fileText.replace(/\r\n?/g, "\n").split("\n");
  const doc: WorkflowDoc = { name: null, triggers: [], jobs: [], matrix: [], secrets: [], lines };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || indentOf(line) !== 0) continue;
    const top = /^(['"]?)([A-Za-z_-]+)\1\s*:\s*(.*)$/.exec(line);
    if (!top) continue;
    const key = top[2];
    const rest = top[3].trim();
    const end = blockEnd(lines, i, 0);

    if (key === "name" && rest) doc.name = unquote(rest);

    if (key === "on" || key === "true") {
      if (rest) {
        for (const ev of inlineList(rest)) doc.triggers.push({ summary: triggerSummary(ev, null), line: i });
      }
      let event: { name: string; line: number; indent: number; detail: boolean } | null = null;
      const flush = () => {
        if (event && !event.detail) doc.triggers.push({ summary: triggerSummary(event.name, null), line: event.line });
      };
      for (let j = i + 1; j < end; j++) {
        if (isBlank(lines[j])) continue;
        const ind = indentOf(lines[j]);
        const t = lines[j].trim();
        const ev = /^([a-z_]+)\s*:\s*(.*)$/.exec(t);
        if (ev && (!event || ind <= event.indent)) {
          flush();
          event = { name: ev[1], line: j, indent: ind, detail: false };
          continue;
        }
        if (!event) continue;
        const branches = /^branches\s*:\s*(.+)$/.exec(t);
        const cron = /^-\s*cron\s*:\s*(.+)$/.exec(t);
        if (branches) {
          doc.triggers.push({ summary: triggerSummary(event.name, inlineList(branches[1]).join(", ")), line: j });
          event.detail = true;
        } else if (cron) {
          doc.triggers.push({ summary: triggerSummary(event.name, unquote(cron[1])), line: j });
          event.detail = true;
        }
      }
      flush();
    }

    if (key === "jobs") {
      let job: { id: string; steps: WorkflowStep[] } | null = null;
      let jobIndent = -1;
      for (let j = i + 1; j < end; j++) {
        if (isBlank(lines[j])) continue;
        const ind = indentOf(lines[j]);
        const t = lines[j].trim();
        if (jobIndent === -1) jobIndent = ind;
        if (ind === jobIndent) {
          const id = /^([A-Za-z0-9_-]+)\s*:/.exec(t);
          if (id) {
            job = { id: id[1], steps: [] };
            doc.jobs.push(job);
          }
          continue;
        }
        if (!job) continue;
        if (/^matrix\s*:/.test(t)) {
          const mEnd = blockEnd(lines, j, ind);
          for (let k = j + 1; k < mEnd; k++) {
            const kv = /^([A-Za-z0-9_-]+)\s*:\s*(\[.*\])\s*$/.exec(lines[k].trim());
            if (kv) doc.matrix.push({ values: inlineList(kv[2]), line: k });
          }
          continue;
        }
        if (/^steps\s*:/.test(t)) {
          const sEnd = blockEnd(lines, j, ind);
          let k = j + 1;
          while (k < sEnd) {
            if (isBlank(lines[k]) || !lines[k].trim().startsWith("- ")) {
              k++;
              continue;
            }
            const itemIndent = indentOf(lines[k]);
            let itemEnd = k + 1;
            while (itemEnd < sEnd && (isBlank(lines[itemEnd]) || indentOf(lines[itemEnd]) > itemIndent)) itemEnd++;
            const step = readStep(lines, k, itemEnd);
            if (step) job.steps.push(step);
            k = itemEnd;
          }
          j = sEnd - 1;
        }
      }
    }
  }

  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (line.trim().startsWith("#")) return;
    for (const m of line.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      doc.secrets.push({ name: m[1], line: i });
    }
  });
  return doc;
}

function triggerSummary(event: string, detail: string | null): string {
  if (event === "push") return detail ? `a push to ${detail}` : "a push";
  if (event === "pull_request") return detail ? `a pull request to ${detail}` : "a pull request";
  if (event === "schedule") return detail ? `a schedule (cron ${detail})` : "a schedule";
  if (event === "workflow_dispatch") return "a manual start";
  return event.replace(/_/g, " ");
}

function readStep(lines: string[], start: number, end: number): WorkflowStep | null {
  let name: string | null = null;
  let run: string | null = null;
  let uses: string | null = null;
  let workingDirectory: string | null = null;
  let line = -1;
  for (let i = start; i < end; i++) {
    if (isBlank(lines[i])) continue;
    const t = lines[i].trim().replace(/^-\s+/, "");
    const kv = /^([a-z-]+)\s*:\s*(.*)$/.exec(t);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "name") name = unquote(value);
    else if (key === "working-directory") workingDirectory = unquote(value);
    else if (key === "uses") {
      uses = unquote(value);
      if (line === -1) line = i;
    } else if (key === "run") {
      if (/^[|>][+-]?$/.test(value.trim())) {
        const ind = indentOf(lines[i]);
        const body: string[] = [];
        let first = -1;
        for (let j = i + 1; j < end; j++) {
          if (isBlank(lines[j])) continue;
          if (indentOf(lines[j]) <= ind) break;
          if (first === -1) first = j;
          body.push(lines[j].trim());
        }
        run = body.join("; ").slice(0, MAX_RUN_BLOCK);
        line = first === -1 ? i : first;
      } else {
        run = value.trim();
        line = i;
      }
    }
  }
  if (line === -1 || (!run && !uses)) return null;
  const what = run ?? `uses ${uses}`;
  const display = `${name ? `${name}: ${what}` : what}${workingDirectory ? ` (in ${workingDirectory})` : ""}`;
  return { display, run, uses, workingDirectory, line };
}

function isWorkflowPath(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
}

interface AssembledFile {
  path: string;
  text: string;
  /** line index -> id of the segment that holds the line */
  segmentAt: string[];
  segments: Segment[];
}

/** File segments reassembled per path, in position order, remembering which segment holds each line. */
function assembleFiles(fileSegments: readonly Segment[], keep: (path: string) => boolean): AssembledFile[] {
  const byPath = new Map<string, Segment[]>();
  for (const s of fileSegments) {
    if (s.kind !== "file") continue;
    const path = String(s.meta.path ?? s.thread);
    if (!keep(path)) continue;
    byPath.set(path, [...(byPath.get(path) ?? []), s]);
  }
  const out: AssembledFile[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const segments = byPath.get(path)!.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
    const lines: string[] = [];
    const segmentAt: string[] = [];
    for (const s of segments) {
      for (const l of s.text.replace(/\r\n?/g, "\n").split("\n")) {
        lines.push(l);
        segmentAt.push(s.id);
      }
    }
    out.push({ path, text: lines.join("\n"), segmentAt, segments });
  }
  return out;
}

function pickEntity(texts: string[], entities: FootprintEntity[]): FootprintEntity | null {
  for (const t of texts) {
    const hit = matchEntities(t, entities)[0];
    if (hit) return hit;
  }
  return null;
}

/** One trace per workflow file: trigger, matrix, the steps in file order, and the secrets by name. */
export function workflowTraces(fileSegments: readonly Segment[], entities: FootprintEntity[] = []): Trace[] {
  const out: Trace[] = [];
  for (const file of assembleFiles(fileSegments, isWorkflowPath)) {
    const doc = parseWorkflow(file.text);
    const stepsFound = doc.jobs.flatMap((j) => j.steps);
    if (stepsFound.length === 0) continue;
    const cite = (line: number) => ({ segmentId: file.segmentAt[line], quote: doc.lines[line].trim() });
    const steps: Omit<TraceStep, "n">[] = [];
    if (doc.triggers.length > 0) {
      steps.push({
        text: `Runs on ${doc.triggers.map((t) => t.summary).join(" and ")}`,
        kind: "quoted",
        citations: doc.triggers.map((t) => cite(t.line)),
        path: file.path,
      });
    }
    for (const m of doc.matrix) {
      steps.push({ text: `Runs once for each of: ${m.values.join(", ")}`, kind: "quoted", citations: [cite(m.line)], path: file.path });
    }
    for (const s of stepsFound) steps.push({ text: s.display, kind: "quoted", citations: [cite(s.line)], path: file.path });
    if (doc.secrets.length > 0) {
      steps.push({
        text: `Needs these secrets by name: ${doc.secrets.map((s) => s.name).join(", ")}`,
        kind: "quoted",
        citations: doc.secrets.map((s) => cite(s.line)),
        path: file.path,
      });
    }
    const entity = pickEntity([`${file.path} ${doc.name ?? ""}`, file.text], entities);
    const commands = stepsFound.map((s) => s.run ?? s.uses ?? "").filter(Boolean);
    const value = `${doc.triggers.length ? `On ${doc.triggers.map((t) => t.summary).join(" and ")}: ` : ""}${commands.join(", then ")}`.slice(0, 600);
    out.push({
      id: traceId("workflow", entity?.key ?? "", file.segments.map((s) => s.id)),
      kind: "workflow",
      entityKey: entity?.key ?? "",
      attribute: "procedure",
      title: `Rebuilt from ${file.path}`,
      sourceLabel: file.path,
      value,
      steps: number(steps),
      roleSet: [...file.segments[0].roleSet],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CI run history
// ---------------------------------------------------------------------------

interface RunRow {
  seg: Segment;
  number: number;
  attempt: number;
  status: string;
  failedStep: string | null;
  sha: string;
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

/**
 * One trace per workflow that has a run history: the last green run, the runs that have failed
 * since, where in the workflow file the failing step sits, and what therefore did not run.
 */
export function runHistoryTraces(
  runSegments: readonly Segment[],
  fileSegments: readonly Segment[],
  entities: FootprintEntity[] = [],
): Trace[] {
  const byWorkflow = new Map<string, RunRow[]>();
  for (const s of runSegments) {
    if (s.kind !== "run") continue;
    const wf = String(s.meta.workflowFile ?? "");
    if (!wf) continue;
    const row: RunRow = {
      seg: s,
      number: Number(s.meta.runNumber ?? 0),
      attempt: Number(s.meta.runAttempt ?? 1),
      status: String(s.meta.status ?? "unknown"),
      failedStep: typeof s.meta.failedStep === "string" ? s.meta.failedStep : null,
      sha: String(s.meta.sha ?? "").slice(0, 7),
    };
    byWorkflow.set(wf, [...(byWorkflow.get(wf) ?? []), row]);
  }
  const files = new Map(assembleFiles(fileSegments, isWorkflowPath).map((f) => [f.path, f]));
  const out: Trace[] = [];
  for (const wf of [...byWorkflow.keys()].sort()) {
    const runs = byWorkflow.get(wf)!.sort((a, b) => a.number - b.number || a.attempt - b.attempt || timeOf(a.seg.ts) - timeOf(b.seg.ts));
    const latest = runs[runs.length - 1];
    let firstFail = runs.length;
    while (firstFail > 0 && runs[firstFail - 1].status === "failure") firstFail--;
    const streak = runs.slice(firstFail);
    const lastGreen = [...runs.slice(0, firstFail)].reverse().find((r) => r.status === "success") ?? null;
    const steps: Omit<TraceStep, "n">[] = [];
    const name = String(latest.seg.meta.workflowName ?? "") || wf;

    if (lastGreen) {
      steps.push({
        text: `Last green run: run ${lastGreen.number} on ${plainDate(lastGreen.seg.ts)}, commit ${lastGreen.sha}`,
        kind: "quoted",
        citations: [{ segmentId: lastGreen.seg.id, quote: firstLine(lastGreen.seg.text) }],
        sha: lastGreen.sha,
      });
    }
    const failedSteps = [...new Set(streak.map((r) => r.failedStep).filter((x): x is string => !!x))];
    for (const r of streak.slice(-5)) {
      steps.push({
        text: `Run ${r.number} on ${plainDate(r.seg.ts)} failed${r.failedStep ? ` at "${r.failedStep}"` : ""} (commit ${r.sha})`,
        kind: "quoted",
        citations: [{ segmentId: r.seg.id, quote: r.failedStep ? `Failed step: ${r.failedStep}` : firstLine(r.seg.text) }],
        sha: r.sha,
      });
    }
    const file = files.get(wf);
    let skipped: string[] = [];
    if (file && failedSteps.length === 1) {
      const doc = parseWorkflow(file.text);
      const all = doc.jobs.flatMap((j) => j.steps);
      const at = all.findIndex((s) => norm(s.run ?? s.uses ?? "") === norm(failedSteps[0]) || norm(s.display) === norm(failedSteps[0]));
      if (at !== -1) {
        steps.push({
          text: `In ${wf} this is step ${at + 1} of ${all.length}: ${all[at].display}`,
          kind: "quoted",
          citations: [{ segmentId: file.segmentAt[all[at].line], quote: doc.lines[all[at].line].trim() }],
          path: wf,
        });
        skipped = all.slice(at + 1).map((s) => s.run ?? s.uses ?? s.display);
        if (skipped.length > 0) {
          steps.push({
            text: `The steps after it did not run in those runs: ${skipped.join(", ")}`,
            kind: "derived",
            citations: [...new Set(all.slice(at + 1).map((s) => file.segmentAt[s.line]))].map((segmentId) => ({ segmentId, quote: null })),
            path: wf,
          });
        }
      }
    }
    let value: string;
    if (streak.length > 0) {
      const since = plainDate(streak[0].seg.ts);
      const where = failedSteps.length === 1 ? ` at "${failedSteps[0]}"` : "";
      steps.push({
        text: lastGreen
          ? `${streak.length} ${streak.length === 1 ? "run has" : "runs in a row have"} failed since ${since}. Nothing after run ${lastGreen.number} has passed.`
          : `${streak.length} ${streak.length === 1 ? "run has" : "runs in a row have"} failed since ${since}. No run has passed yet.`,
        kind: "derived",
        citations: [...streak, ...(lastGreen ? [lastGreen] : [])].map((r) => ({ segmentId: r.seg.id, quote: null })),
      });
      value = `Failing since ${since}: the last ${streak.length} ${streak.length === 1 ? "run" : "runs"} of ${name} failed${where}.`
        + (lastGreen ? ` Last green run: ${lastGreen.number} on ${plainDate(lastGreen.seg.ts)} (commit ${lastGreen.sha}).` : " No run has passed yet.")
        + (skipped.length ? ` Not run since: ${skipped.join(", ")}.` : "");
    } else {
      steps.push({
        text: `The latest run passed, so ${name} was working on ${plainDate(latest.seg.ts)}.`,
        kind: "derived",
        citations: [{ segmentId: latest.seg.id, quote: null }],
      });
      value = `Passing: run ${latest.number} of ${name} on ${plainDate(latest.seg.ts)} (commit ${latest.sha}).`;
    }
    const entity = pickEntity([`${wf} ${name}`, file?.text ?? ""], entities);
    const cited = steps.flatMap((s) => s.citations.map((c) => c.segmentId));
    out.push({
      id: traceId("run_history", entity?.key ?? "", cited),
      kind: "run_history",
      entityKey: entity?.key ?? "",
      attribute: "status",
      title: `Rebuilt from the run history of ${wf}`,
      sourceLabel: `the run history of ${wf}`,
      value: value.slice(0, 900),
      steps: number(steps),
      roleSet: [...latest.seg.roleSet],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commit sequences
// ---------------------------------------------------------------------------

const OPEN_WORK = /\b(WIP|TODO|not wired|not yet|draft|testing)\b/i;

function commitPaths(s: Segment): string[] {
  return Array.isArray(s.meta.files) ? (s.meta.files as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

/** The folder most of the paths share ("website/"), or the one path when there is only one. */
function commonPlace(paths: string[]): string {
  const uniq = [...new Set(paths)];
  if (uniq.length === 0) return "the repository";
  if (uniq.length === 1) return uniq[0];
  const counts = new Map<string, number>();
  for (const p of uniq) {
    const top = p.includes("/") ? `${p.split("/")[0]}/` : p;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/**
 * What changed, in what order, on the paths of an entity: the newest 8 commits about it, oldest
 * first, plus what changes together and whether the last change was left unfinished.
 * `indexed` holds ids of commit segments Attest already tied to the entity.
 */
export function commitSequenceTrace(
  commits: readonly Segment[],
  entity: FootprintEntity,
  people: readonly Person[],
  indexed: ReadonlySet<string> = new Set(),
): Trace | null {
  const all = commits.filter((s) => s.kind === "commit");
  const direct = new Set(
    all.filter((s) => indexed.has(s.id) || matchEntities(`${commitPaths(s).join(" ")} ${s.text}`, [entity]).length > 0).map((s) => s.id),
  );
  // The entity's paths: a path that names the entity, with any extension (register.html and register.js).
  const stem = (p: string) => p.replace(/\.[^./]+$/, "");
  const stems = new Set(
    all.filter((s) => direct.has(s.id)).flatMap(commitPaths).filter((p) => matchEntities(p, [entity]).length > 0).map(stem),
  );
  const about = all
    .filter((s) => direct.has(s.id) || commitPaths(s).some((p) => stems.has(stem(p))))
    .sort((a, b) => timeOf(a.ts) - timeOf(b.ts) || (a.id < b.id ? -1 : 1));
  if (about.length < 2) return null;
  const picked = about.slice(-MAX_COMMITS);
  const nameOf = new Map(people.map((p) => [p.id, p.displayName]));
  const steps: Omit<TraceStep, "n">[] = picked.map((c) => {
    const paths = commitPaths(c);
    const message = firstLine(c.text);
    const who = c.authorId ? nameOf.get(c.authorId) ?? "someone" : "someone";
    return {
      text: `${plainDate(c.ts)} ${who}: ${message}${paths.length ? ` (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""})` : ""}`,
      kind: "quoted" as const,
      citations: [{ segmentId: c.id, quote: message }],
      sha: String(c.meta.sha ?? "").slice(0, 10) || undefined,
      path: paths[0],
    };
  });

  // What changes together: the same author touched both paths within 48 hours, on two occasions or more.
  const occasions: { paths: Set<string>; ids: string[]; author: string | null; start: number }[] = [];
  for (const c of picked) {
    const last = occasions[occasions.length - 1];
    if (last && last.author === c.authorId && timeOf(c.ts) - last.start <= 2 * DAY_MS) {
      for (const p of commitPaths(c)) last.paths.add(p);
      last.ids.push(c.id);
    } else {
      occasions.push({ paths: new Set(commitPaths(c)), ids: [c.id], author: c.authorId, start: timeOf(c.ts) });
    }
  }
  const pairs = new Map<string, { n: number; ids: string[] }>();
  for (const o of occasions) {
    const ps = [...o.paths].sort();
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const k = `${ps[i]}\u0000${ps[j]}`;
        const cur = pairs.get(k) ?? { n: 0, ids: [] };
        cur.n += 1;
        cur.ids.push(...o.ids);
        pairs.set(k, cur);
      }
    }
  }
  const together = [...pairs.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)).slice(0, 2);
  for (const [k, v] of together) {
    const [a, b] = k.split("\u0000");
    steps.push({
      text: `${a} and ${b} were changed together ${v.n} times`,
      kind: "derived",
      citations: [...new Set(v.ids)].map((segmentId) => ({ segmentId, quote: null })),
    });
  }

  const newest = picked[picked.length - 1];
  const newestMessage = firstLine(newest.text);
  const unfinished = OPEN_WORK.test(newest.text);
  if (unfinished) {
    steps.push({
      text: `The last change on this path was left unfinished: ${newestMessage}`,
      kind: "quoted",
      citations: [{ segmentId: newest.id, quote: newestMessage }],
      sha: String(newest.meta.sha ?? "").slice(0, 10) || undefined,
    });
  }

  const place = commonPlace(picked.flatMap(commitPaths));
  const sourceLabel = `${picked.length} commits to ${place}`;
  const messages = picked.map((c) => firstLine(c.text));
  const value = (unfinished
    ? `Left unfinished: ${newestMessage}. Before that, in order: ${messages.slice(0, -1).join("; ")}`
    : `In order: ${messages.join("; ")}`).slice(0, 700);
  return {
    id: traceId("commit_sequence", entity.key, picked.map((c) => c.id)),
    kind: "commit_sequence",
    entityKey: entity.key,
    attribute: "procedure",
    title: `Rebuilt from ${sourceLabel}`,
    sourceLabel,
    value,
    steps: number(steps),
    roleSet: [...picked[0].roleSet],
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function words3(summary: string): string {
  return summary.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 3).join(" ");
}

function eventDay(s: Segment): string {
  return isoDay(String(s.meta.start ?? s.ts));
}

/**
 * Cadence and next occurrence for recurring events; cadence for one-off events that repeat
 * (three or more with the same first three words, in two or more weeks: the pack's thresholds).
 */
export function calendarTraces(
  events: readonly Segment[],
  entities: FootprintEntity[],
  thresholds: FootprintThresholds,
  today: string,
): Trace[] {
  const out: Trace[] = [];
  const todayDay = isoDay(today);
  const list = events.filter((s) => s.kind === "event").sort((a, b) => timeOf(a.ts) - timeOf(b.ts) || (a.id < b.id ? -1 : 1));
  const calendarName = (s: Segment) => String(s.meta.calendar ?? s.thread ?? "the calendar");

  for (const s of list) {
    const recurring = Boolean(s.meta.recurring) || Boolean(s.meta.rrule);
    if (!recurring) continue;
    const summary = String(s.meta.summary ?? "");
    const entity = pickEntity([summary], entities);
    if (!entity) continue;
    const repeats = String(s.meta.repeats ?? "").trim();
    const occurrences = (Array.isArray(s.meta.occurrences) ? (s.meta.occurrences as unknown[]) : [])
      .filter((x): x is string => typeof x === "string").map(isoDay).filter((d) => d >= todayDay).sort();
    const next = occurrences[0] ?? null;
    const steps: Omit<TraceStep, "n">[] = [];
    if (repeats && repeats !== "no") {
      const quote = `repeats: ${repeats}`;
      steps.push({ text: `Repeats ${repeats}`, kind: norm(s.text).includes(norm(quote)) ? "quoted" : "derived", citations: [{ segmentId: s.id, quote }] });
    }
    if (next) {
      const inText = s.text.includes(next);
      steps.push({ text: `Next: ${next}`, kind: inText ? "quoted" : "derived", citations: [{ segmentId: s.id, quote: inText ? next : null }] });
    }
    if (steps.length === 0) continue;
    out.push({
      id: traceId("calendar", entity.key, [s.id]),
      kind: "calendar",
      entityKey: entity.key,
      attribute: "deadline",
      title: `Rebuilt from ${calendarName(s)}`,
      sourceLabel: calendarName(s),
      value: [repeats && repeats !== "no" ? repeats : null, next ? `next ${next}` : null].filter(Boolean).join("; "),
      steps: number(steps),
      roleSet: [...s.roleSet],
    });
  }

  const groups = new Map<string, Segment[]>();
  for (const s of list) {
    if (Boolean(s.meta.recurring) || Boolean(s.meta.rrule)) continue;
    const key = words3(String(s.meta.summary ?? ""));
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!.sort((a, b) => (eventDay(a) < eventDay(b) ? -1 : 1));
    const weeks = new Set(group.map((s) => isoWeek(String(s.meta.start ?? s.ts))));
    if (group.length < thresholds.repeatMin || weeks.size < thresholds.distinctWeeksMin) continue;
    const entity = pickEntity([String(group[0].meta.summary ?? ""), key], entities);
    if (!entity) continue;
    const steps: Omit<TraceStep, "n">[] = group.map((s) => {
      const summary = String(s.meta.summary ?? "");
      return { text: `${eventDay(s)}: ${summary}`, kind: "quoted" as const, citations: [{ segmentId: s.id, quote: summary }] };
    });
    const days = group.map((s) => Date.parse(`${eventDay(s)}T00:00:00Z`));
    const gapsDays = days.slice(1).map((d, i) => Math.round((d - days[i]) / DAY_MS));
    const gapsWeeks = gapsDays.map((d) => Math.max(1, Math.round(d / 7)));
    const gapText = gapsWeeks.length === 1 ? `${gapsWeeks[0]}` : `${gapsWeeks.slice(0, -1).join(", ")} and ${gapsWeeks[gapsWeeks.length - 1]}`;
    steps.push({
      text: `Happened ${group.length} times, ${gapText} weeks apart`,
      kind: "derived",
      citations: group.map((s) => ({ segmentId: s.id, quote: null })),
    });
    const mean = Math.round(gapsDays.reduce((a, b) => a + b, 0) / Math.max(1, gapsDays.length));
    const implied = new Date(days[days.length - 1] + mean * DAY_MS).toISOString().slice(0, 10);
    const cal = calendarName(group[0]);
    out.push({
      id: traceId("calendar", entity.key, group.map((s) => s.id)),
      kind: "calendar",
      entityKey: entity.key,
      attribute: "deadline",
      title: `Rebuilt from ${cal}`,
      sourceLabel: cal,
      value: `Happened ${group.length} times, ${gapText} weeks apart`,
      steps: number(steps),
      roleSet: [...group[0].roleSet],
      ...(mean > 0 && implied >= todayDay ? { impliedNext: implied } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// All traces
// ---------------------------------------------------------------------------

export interface ReadTraceOptions {
  today: string;
  thresholds: FootprintThresholds;
  /** entity key -> ids of segments Attest tied to the entity (commit segments are used). */
  entityIndex?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Build commit sequences only for these entity keys. Default: every entity. */
  commitEntities?: readonly string[];
}

/**
 * Read every trace the segments hold. Segments are grouped by identical role set first, so a
 * trace never mixes role sets (the same rule as Attest's batching).
 */
export function readTraces(
  segments: readonly Segment[],
  entities: FootprintEntity[],
  people: readonly Person[],
  opts: ReadTraceOptions,
): Trace[] {
  const groups = new Map<string, Segment[]>();
  for (const s of segments) {
    const k = roleKey(s.roleSet);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const out: Trace[] = [];
  for (const k of [...groups.keys()].sort()) {
    const group = groups.get(k)!;
    const files = group.filter((s) => s.kind === "file");
    const runs = group.filter((s) => s.kind === "run");
    const commits = group.filter((s) => s.kind === "commit");
    const events = group.filter((s) => s.kind === "event");
    out.push(...workflowTraces(files, entities));
    if (runs.length > 0) out.push(...runHistoryTraces(runs, files, entities));
    const wanted = opts.commitEntities ? entities.filter((e) => opts.commitEntities!.includes(e.key)) : entities;
    for (const e of wanted) {
      const t = commitSequenceTrace(commits, e, people, opts.entityIndex?.get(e.key) ?? new Set());
      if (t) out.push(t);
    }
    out.push(...calendarTraces(events, entities, opts.thresholds, opts.today));
  }
  const seen = new Set<string>();
  return out
    .filter((t) => t.entityKey && t.steps.length > 0 && !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
