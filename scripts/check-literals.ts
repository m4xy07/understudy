// The no-setting-literals check. Core code must not know any setting: no role key, no pack id and
// no proper noun of any pack may appear in src/, db/migrations/ or next.config.ts.
// A second setting is then proven to need zero core changes by the diff, not by a promise.
//
// What is flagged, per line of every core file (comments included: fix the comment):
//   1. a whole quoted string that equals a role key or a pack id of any pack   "president", 'lab'
//   2. a pack proper noun as a whole word, any case: role labels and short names, leaverPerson
//      name and aliases, roleHolders names, and every pack's forbiddenInCore list
// Only whole quoted strings count for keys, so `leaver_said`, `leaverRole` and the word "leaver"
// in a sentence are fine.
//
// scripts/literals-allow.json lists the few accepted hits as { file, token, reason }. An entry
// without a reason fails the check, and so does an entry that no longer matches anything.
//
// Usage: pnpm check:literals        (also the first half of `pnpm test`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LiteralHit {
  file: string;      // posix path relative to the root
  line: number;
  token: string;
  kind: "role key" | "pack id" | "pack noun";
  text: string;
}

export interface AllowEntry {
  file: string;
  token: string;
  reason?: string;
}

export interface LiteralReport {
  hits: LiteralHit[];        // not allow-listed: these fail the check
  allowed: LiteralHit[];     // matched an allow-list entry
  problems: string[];        // allow-list entries without a reason, or that match nothing
  files: number;
  vocabulary: { roleKeys: string[]; packIds: string[]; nouns: string[] };
}

interface RawPack {
  id?: unknown;
  roles?: { key?: unknown; label?: unknown; short?: unknown }[];
  leaverPerson?: { name?: unknown; aliases?: unknown };
  roleHolders?: Record<string, unknown>;
  forbiddenInCore?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Role keys, pack ids and proper nouns of every packs/*.json (index.json is not a pack). */
export function packVocabulary(root: string): LiteralReport["vocabulary"] {
  const dir = path.join(root, "packs");
  const roleKeys = new Set<string>();
  const packIds = new Set<string>();
  const nouns = new Set<string>();
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name === "index.json") continue;
    const pack = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RawPack;
    packIds.add(typeof pack.id === "string" ? pack.id : name.replace(/\.json$/, ""));
    for (const r of pack.roles ?? []) {
      if (typeof r.key === "string") roleKeys.add(r.key);
      if (typeof r.label === "string") nouns.add(r.label);
      if (typeof r.short === "string") nouns.add(r.short);
    }
    if (typeof pack.leaverPerson?.name === "string") nouns.add(pack.leaverPerson.name);
    for (const a of strings(pack.leaverPerson?.aliases)) nouns.add(a);
    for (const list of Object.values(pack.roleHolders ?? {})) for (const n of strings(list)) nouns.add(n);
    for (const n of strings(pack.forbiddenInCore)) nouns.add(n);
  }
  const clean = (s: Set<string>) => [...s].map((x) => x.trim()).filter((x) => x.length > 1).sort();
  return { roleKeys: clean(roleKeys), packIds: clean(packIds), nouns: clean(nouns) };
}

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** Core files: src/**\/*.{ts,tsx}, db/migrations/*.sql, next.config.ts. Not tests, scripts, packs, data or docs. */
export function coreFiles(root: string): string[] {
  const files = [
    ...walk(path.join(root, "src"), (f) => /\.(ts|tsx)$/.test(f)),
    ...walk(path.join(root, "db", "migrations"), (f) => f.endsWith(".sql")),
  ];
  const config = path.join(root, "next.config.ts");
  if (fs.existsSync(config)) files.push(config);
  return files;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const QUOTED = /(["'`])((?:(?!\1)[^\\\n])*)\1/g;

/** Scan text for setting literals. Pure: used by the CLI and by the tests. */
export function scanText(file: string, text: string, vocab: LiteralReport["vocabulary"]): LiteralHit[] {
  const roleKeys = new Set(vocab.roleKeys);
  const packIds = new Set(vocab.packIds);
  const nounRes = vocab.nouns.map((n) => ({ noun: n, re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(n)}(?![\\p{L}\\p{N}_])`, "iu") }));
  const hits: LiteralHit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const seen = new Set<string>();
    const add = (token: string, kind: LiteralHit["kind"]) => {
      if (seen.has(token)) return;
      seen.add(token);
      hits.push({ file, line: i + 1, token, kind, text: line.trim().slice(0, 160) });
    };
    for (const m of line.matchAll(QUOTED)) {
      if (roleKeys.has(m[2])) add(m[2], "role key");
      else if (packIds.has(m[2])) add(m[2], "pack id");
    }
    for (const { noun, re } of nounRes) if (re.test(line)) add(noun, "pack noun");
  });
  return hits;
}

export function checkLiterals(opts: { root: string; files?: string[]; allow?: AllowEntry[] }): LiteralReport {
  const root = opts.root;
  const vocabulary = packVocabulary(root);
  const files = opts.files ?? coreFiles(root);
  const allowFile = path.join(root, "scripts", "literals-allow.json");
  const allow: AllowEntry[] = opts.allow ?? (fs.existsSync(allowFile) ? (JSON.parse(fs.readFileSync(allowFile, "utf8")) as AllowEntry[]) : []);

  const problems: string[] = [];
  for (const a of allow) {
    if (!a.reason || !a.reason.trim()) problems.push(`allow-list entry ${a.file} "${a.token}" has no reason`);
  }
  const used = new Set<AllowEntry>();
  const hits: LiteralHit[] = [];
  const allowed: LiteralHit[] = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    for (const hit of scanText(rel, fs.readFileSync(abs, "utf8"), vocabulary)) {
      const entry = allow.find((a) => a.file === rel && a.token === hit.token && a.reason && a.reason.trim());
      if (entry) {
        used.add(entry);
        allowed.push(hit);
      } else {
        hits.push(hit);
      }
    }
  }
  for (const a of allow) {
    if (a.reason && a.reason.trim() && !used.has(a)) problems.push(`allow-list entry ${a.file} "${a.token}" matches nothing: remove it`);
  }
  return { hits, allowed, problems, files: files.length, vocabulary };
}

function main(): void {
  const root = process.cwd();
  const r = checkLiterals({ root });
  for (const h of r.hits) console.error(`${h.file}:${h.line}: ${h.kind} ${JSON.stringify(h.token)}   ${h.text}`);
  for (const p of r.problems) console.error(p);
  const v = r.vocabulary;
  const summary = `${r.files} core files; ${v.roleKeys.length} role keys, ${v.packIds.length} pack ids, ${v.nouns.length} pack nouns; ${r.allowed.length} allow-listed`;
  if (r.hits.length || r.problems.length) {
    console.error(`check-literals: FAILED with ${r.hits.length} setting literal(s) in core code and ${r.problems.length} allow-list problem(s) (${summary}).`);
    console.error("Core code reads the pack: take the value from getWorkspacePack(ws) instead of naming it.");
    process.exit(1);
  }
  console.log(`check-literals: ok (${summary}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
