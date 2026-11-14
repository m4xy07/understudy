// Validates one setting pack and its synthetic demo dataset against the demo's answer key, before
// any model runs. Works for any pack: roles, folders and dates come from the pack; what a given demo
// must contain comes from its answer key (<demo.dataDir>/ground_truth.json) and from the optional
// `demo.expect` block of the pack (counts, the task cards that stay active, footprint evidence).
// Run from the repo root: pnpm tsx scripts/check-demo.ts [--pack <id>] [--adapters]   (default: packs/index.json)
// A pack with demo.expect.adapters (or --adapters) also runs scripts/check-demo-adapters.ts.
// Contract: docs/ARCHITECTURE.md sections 1, 1a, 2, 4 and 7a.
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import matter from "gray-matter";
import { defaultPackId, getPack } from "@/lib/pack";
import type { Attribute, RoleKey, SourceKind } from "../src/lib/types";

const ROOT = process.cwd();
const packArg = process.argv.indexOf("--pack");
const PACK_ID = packArg === -1 ? defaultPackId() : (process.argv[packArg + 1] ?? "");
// getPack validates the schema and every loader rule (role flags, known roles, entities, demo folder).
const resolved = getPack(PACK_ID);
if (!resolved.demo) throw new Error(`Setting pack "${PACK_ID}" has no demo to check.`);
const PACK_FILE = `packs/${PACK_ID}.json`;
const DEMO = path.join(ROOT, resolved.demo.dataDir);
const TODAY = new Date(resolved.demo.today);
const SUCCESSOR = resolved.successorRole;
/** Roles a "restricted" source is hidden from: the successor and every restricted audience role. */
const OUTSIDERS: readonly RoleKey[] = resolved.testRoles;
const LEAVER_NAMES: readonly string[] = resolved.roleHolders[resolved.leaverRole] ?? [resolved.leaverPerson.name];

/** Optional expectations about this demo, kept in the pack (setting data), never in this script. */
interface FootprintExpectation {
  label: string;
  source: "commits" | "whatsapp" | "ics";
  pathPrefix?: string;        // commits: share of commits touching this path that the leaver wrote
  pattern?: string;           // whatsapp: regex on the leaver's messages; ics: regex on the event SUMMARY
  minShare?: number;
  minCount?: number;
  minWeeks?: number;
}
interface DemoExpect {
  entities?: [number, number];
  responsibilities?: number;
  claims?: [number, number];
  readbackItems?: number;
  activeTaskIds?: string[];
  footprint?: FootprintExpectation[];
  /** Also run the second stage (scripts/check-demo-adapters.ts): real adapters, masking, footprint, inventory. */
  adapters?: boolean;
}
const EXPECT = ((resolved.demo as Record<string, unknown>).expect ?? {}) as DemoExpect;

const ROLE_KEYS: readonly RoleKey[] = resolved.roleOrder;
const ATTRS: readonly Attribute[] = [
  "owner", "status", "deadline", "location", "procedure", "access",
  "decision", "reason", "dependency", "contact", "risk",
];
const KINDS: readonly SourceKind[] = ["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics", "interview"];
/** Kinds a pack may also rank: a successor finding (never imported, so it is not in KINDS). */
const EXTRA_AUTHORITY_KINDS: readonly SourceKind[] = ["finding"];
const RESP_KINDS = ["deploy_operate", "external_relationship", "recurring_obligation", "open_decision", "unfinished_work"] as const;
type RespKind = (typeof RESP_KINDS)[number];
const TASK_HEADER = "id,title,status,owner,owner_email,due,labels,updated_at,description";
const CANARY_RE = /CANARY-[A-Z0-9]{4}/g;

const errors: string[] = [];
const fail = (msg: string): void => {
  errors.push(msg);
};
const check = (cond: unknown, msg: string): void => {
  if (!cond) fail(msg);
};

type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: Json): x is string => typeof x === "string" && x.length > 0;
const isStrArr = (x: Json): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");
const isRoleSet = (x: Json): x is RoleKey[] =>
  isStrArr(x) && x.length > 0 && x.every((r) => (ROLE_KEYS as readonly string[]).includes(r));
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v) => b.includes(v));
const subset = (a: readonly string[], b: readonly string[]): boolean => a.every((v) => b.includes(v));
const readJson = (p: string): Json => JSON.parse(fs.readFileSync(p, "utf8")) as Json;
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");
const weekKey = (d: Date): number => Math.floor((d.getTime() / 86_400_000 + 3) / 7); // Monday-based week index

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------- pack
const pack = readJson(path.join(ROOT, PACK_FILE));
const entityKeys = new Set<string>();
const checklist = new Map<RespKind, { key: string; weight: number; attributes: string[] }[]>();
const readbackKeys: string[] = [];

if (!isObj(pack)) {
  fail(`${PACK_FILE} is not an object`);
} else {
  check(pack.id === PACK_ID && isStr(pack.name), `pack: id must be '${PACK_ID}' and name a string`);
  // Roles, flags and every role reference were validated by the loader (getPack above).
  check(isRoleSet(pack.contactsRoles), "pack: contactsRoles must be roles of this pack");

  for (const e of Array.isArray(pack.entities) ? pack.entities : []) {
    if (!isObj(e) || !isStr(e.key) || !isStr(e.label) || !isStrArr(e.aliases) || e.aliases.length === 0) {
      fail(`pack: bad entity ${JSON.stringify(e)}`);
      continue;
    }
    check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.key), `pack: entity key ${e.key} must be kebab-case`);
    check(!entityKeys.has(e.key), `pack: duplicate entity ${e.key}`);
    entityKeys.add(e.key);
  }
  check(entityKeys.size > 0, "pack: no entities");
  if (EXPECT.entities) {
    check(entityKeys.size >= EXPECT.entities[0] && entityKeys.size <= EXPECT.entities[1],
      `pack: expected ${EXPECT.entities[0]}-${EXPECT.entities[1]} entities, got ${entityKeys.size}`);
  }

  const sa = pack.sourceAuthority;
  if (!isObj(sa)) fail("pack: sourceAuthority missing");
  else {
    check(sameSet(Object.keys(sa), ATTRS), "pack: sourceAuthority must cover exactly the 11 attributes");
    for (const a of ATTRS) {
      const row = sa[a];
      if (!isObj(row)) { fail(`pack: sourceAuthority.${a} missing`); continue; }
      check(subset(KINDS, Object.keys(row)) && subset(Object.keys(row), [...KINDS, ...EXTRA_AUTHORITY_KINDS]),
        `pack: sourceAuthority.${a} must cover the 7 source kinds (and may rank: ${EXTRA_AUTHORITY_KINDS.join(", ")})`);
      const nums = KINDS.map((k) => row[k]);
      if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
        fail(`pack: sourceAuthority.${a} values must be numbers`);
        continue;
      }
      const vals = nums as number[];
      check(vals[KINDS.indexOf("interview")] === Math.min(...vals), `pack: interview must be lowest for ${a}`);
    }
  }

  const cl = pack.checklists;
  if (!isObj(cl)) fail("pack: checklists missing");
  else {
    check(sameSet(Object.keys(cl), RESP_KINDS), "pack: checklists must have the five kinds");
    for (const kind of RESP_KINDS) {
      const list = cl[kind];
      if (!Array.isArray(list)) { fail(`pack: checklist ${kind} missing`); continue; }
      const parsed: { key: string; weight: number; attributes: string[] }[] = [];
      // A pack defines its own checks per kind; each needs a unique key, a W tag and a weight of 1, 3 or 5.
      check(list.length > 0, `pack: checklist ${kind} has no checks`);
      const keysSeen = new Set<string>();
      list.forEach((c) => {
        if (!isObj(c) || !isStr(c.key) || !isStr(c.label) || !isStrArr(c.attributes) || c.attributes.length === 0) {
          fail(`pack: bad check in ${kind}: ${JSON.stringify(c)}`);
          return;
        }
        check(!keysSeen.has(c.key), `pack: duplicate check ${kind}.${c.key}`);
        keysSeen.add(c.key);
        check(["WHO", "WHERE", "HOW", "WHY", "WHEN"].includes(String(c.wTag)) && [1, 3, 5].includes(Number(c.weight)),
          `pack: ${kind}.${c.key} needs a W tag and a weight of 1, 3 or 5`);
        check(subset(c.attributes, ATTRS), `pack: ${kind}.${c.key} has unknown attributes`);
        parsed.push({ key: c.key, weight: Number(c.weight), attributes: c.attributes });
      });
      checklist.set(kind, parsed);
    }
  }

  const rt = isObj(pack.roleTemplates) ? pack.roleTemplates[SUCCESSOR] : undefined;
  if (!Array.isArray(rt)) fail(`pack: roleTemplates.${SUCCESSOR} (the successor role) missing`);
  else {
    for (const t of rt) {
      if (!isObj(t) || !isStr(t.title) || !(RESP_KINDS as readonly string[]).includes(String(t.kind)) || !isStrArr(t.entities)) {
        fail(`pack: bad role template ${JSON.stringify(t)}`);
        continue;
      }
      for (const e of t.entities) check(entityKeys.has(e), `pack: role template ${String(t.key)} uses unknown entity ${e}`);
    }
  }

  const fp = pack.footprint;
  check(isObj(fp) && [fp.repeatMin, fp.distinctWeeksMin, fp.ownershipShare, fp.windowMonths].every((n) => typeof n === "number" && n > 0)
    && Number(fp.ownershipShare) <= 1, "pack: footprint needs repeatMin, distinctWeeksMin, ownershipShare (0 to 1] and windowMonths");

  const rb = Array.isArray(pack.readback) ? pack.readback : [];
  check(rb.length > 0, "pack: readback has no items");
  if (EXPECT.readbackItems !== undefined) check(rb.length === EXPECT.readbackItems, `pack: readback must have exactly ${EXPECT.readbackItems} items`);
  for (const r of rb) {
    if (!isObj(r) || !isStr(r.key) || !isStr(r.label) || !isStr(r.entity) || !isStr(r.attribute)) {
      fail(`pack: bad readback ${JSON.stringify(r)}`);
      continue;
    }
    check(["date", "text", "contact", "command"].includes(String(r.type)), `pack: readback ${r.key} bad type`);
    check(entityKeys.has(r.entity), `pack: readback ${r.key} unknown entity ${r.entity}`);
    check((ATTRS as readonly string[]).includes(r.attribute), `pack: readback ${r.key} unknown attribute`);
    readbackKeys.push(r.key);
  }
  check(new Set(readbackKeys).size === readbackKeys.length, "pack: duplicate readback key");
  const ud = pack.uploadDefaults;
  check(isObj(ud) && isRoleSet(ud.roleSet), "pack: uploadDefaults.roleSet must be roles of this pack");
}

// ---------------------------------------------------------------- sources
// A source path is relative to the demo folder, or to the project root (the first demo was written that way).
const sourcePath = (p: string): string => (fs.existsSync(path.join(DEMO, p)) ? path.join(DEMO, p) : path.join(ROOT, p));
interface SourceEntry { kind: SourceKind; name: string; path: string; roleSet: RoleKey[] }
const sourcesRaw = readJson(path.join(DEMO, "sources.json"));
const sources: SourceEntry[] = [];
if (!Array.isArray(sourcesRaw)) fail("sources.json must be an array");
else {
  for (const s of sourcesRaw) {
    if (!isObj(s) || !(KINDS as readonly string[]).includes(String(s.kind)) || !isStr(s.name) || !isStr(s.path) || !isRoleSet(s.roleSet)) {
      fail(`sources.json: bad entry ${JSON.stringify(s)}`);
      continue;
    }
    if (!fs.existsSync(sourcePath(s.path))) { fail(`sources.json: path not found ${s.path}`); continue; }
    sources.push({ kind: s.kind as SourceKind, name: s.name, path: s.path, roleSet: s.roleSet });
  }
}

// Effective role set per file (notes may narrow with front matter `roles:`).
const fileRoles = new Map<string, RoleKey[]>();
const counts: Record<string, number> = {};
const whatsappMsgs: { ts: Date; author: string; text: string }[] = [];
let commits: { author_name: string; date: string; files: { path: string }[] }[] = [];
let icsText = "";

const WA_MSG = /^(\d{2})\/(\d{2})\/(\d{2}), (\d{2}):(\d{2}) - ([^:]+?): (.*)$/;
const WA_SYS = /^(\d{2})\/(\d{2})\/(\d{2}), (\d{2}):(\d{2}) - (.*)$/;

for (const s of sources) {
  const abs = sourcePath(s.path);
  const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
  for (const f of files) fileRoles.set(f, s.roleSet);

  if (s.kind === "whatsapp") {
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    let msgs = 0;
    let started = false;
    lines.forEach((line, i) => {
      if (line === "" && i === lines.length - 1) return;
      const m = WA_MSG.exec(line);
      if (m) {
        msgs++;
        started = true;
        const [, dd, mm, yy, hh, mi, author, text] = m;
        whatsappMsgs.push({ ts: new Date(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi)), author, text });
        return;
      }
      if (WA_SYS.test(line)) { started = true; return; }
      check(started && line.trim() !== "", `whatsapp ${s.path}:${i + 1} is not a message, system or continuation line`);
    });
    counts[`whatsapp ${path.basename(abs, ".txt")}`] = msgs;
  }

  if (s.kind === "slack") {
    const usersPath = path.join(abs, "users.json");
    const users = fs.existsSync(usersPath) ? readJson(usersPath) : null;
    const ids = new Set<string>();
    if (!Array.isArray(users)) fail(`slack ${s.path}: users.json missing or not an array`);
    else {
      for (const u of users) {
        if (!isObj(u) || !isStr(u.id) || !isStr(u.real_name) || !isObj(u.profile) || !isStr(u.profile.email)) {
          fail(`slack ${s.path}: bad user ${JSON.stringify(u)}`);
          continue;
        }
        ids.add(u.id);
      }
    }
    const channels = fs.readdirSync(abs).filter((f) => f.endsWith(".json") && f !== "users.json");
    check(channels.length > 0, `slack ${s.path}: no channel file`);
    for (const ch of channels) {
      const msgs = readJson(path.join(abs, ch));
      if (!Array.isArray(msgs)) { fail(`slack ${s.path}/${ch}: not an array`); continue; }
      const seen = new Set<string>();
      for (const m of msgs) {
        if (!isObj(m) || !isStr(m.ts) || !/^\d{10}\.\d{6}$/.test(m.ts) || !isStr(m.user) || typeof m.text !== "string") {
          fail(`slack ${s.path}/${ch}: bad message ${JSON.stringify(m)}`);
          continue;
        }
        check(ids.has(m.user), `slack ${s.path}/${ch}: unknown user ${m.user}`);
        if (m.thread_ts !== undefined) {
          check(isStr(m.thread_ts) && seen.has(m.thread_ts), `slack ${s.path}/${ch}: thread_ts ${String(m.thread_ts)} has no earlier parent`);
        }
        check(!seen.has(m.ts), `slack ${s.path}/${ch}: duplicate ts ${m.ts}`);
        seen.add(m.ts);
        // Restricted channels (hidden from the successor and every restricted audience role): every message carries a canary token.
        if (OUTSIDERS.every((r) => !s.roleSet.includes(r))) {
          check(new RegExp(CANARY_RE.source).test(m.text), `slack ${s.path}/${ch}: restricted message without canary: ${m.text}`);
        }
      }
      counts[`slack #${path.basename(ch, ".json")}`] = msgs.length;
    }
  }

  if (s.kind === "github") {
    const raw = readJson(path.join(abs, "commits.json"));
    const shas = new Set<string>();
    if (!Array.isArray(raw)) fail("github: commits.json not an array");
    else {
      for (const c of raw) {
        if (!isObj(c) || !isStr(c.sha) || !/^[0-9a-f]{40}$/.test(c.sha) || !isStr(c.author_name) || !isStr(c.author_email)
          || !isStr(c.date) || Number.isNaN(Date.parse(c.date)) || !isStr(c.message) || !Array.isArray(c.files)) {
          fail(`github: bad commit ${JSON.stringify(c)}`);
          continue;
        }
        check(!shas.has(c.sha), `github: duplicate sha ${c.sha}`);
        shas.add(c.sha);
        for (const f of c.files) {
          check(isObj(f) && isStr(f.path) && ["added", "modified", "removed", "renamed"].includes(String(f.status)),
            `github: bad file entry in ${c.sha}`);
        }
      }
      commits = raw as typeof commits;
    }
    check(fs.existsSync(path.join(abs, "files")) && walk(path.join(abs, "files")).length > 0, "github: files/ is empty");
    counts["github commits"] = commits.length;
    counts["github files"] = walk(path.join(abs, "files")).length;
  }

  if (s.kind === "tasks_csv") {
    const text = fs.readFileSync(abs, "utf8");
    check(text.split(/\r?\n/)[0] === TASK_HEADER, `tasks: header must be exactly ${TASK_HEADER}`);
    const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });
    for (const e of parsed.errors) fail(`tasks: CSV parse error row ${String(e.row)}: ${e.message}`);
    const rows = parsed.data.slice(1);
    const taskIds = new Set<string>();
    rows.forEach((r, i) => {
      if (r.length !== 9) { fail(`tasks: row ${i + 2} has ${r.length} fields`); return; }
      const [id, title, status, , , due, , updatedAt] = r;
      check(id.trim() !== "" && !taskIds.has(id), `tasks: bad or duplicate id ${id}`);
      taskIds.add(id);
      check(title !== "" && status !== "", `tasks: ${id} needs title and status`);
      check(due === "" || /^\d{4}-\d{2}-\d{2}$/.test(due), `tasks: ${id} bad due ${due}`);
      check(!Number.isNaN(Date.parse(updatedAt)), `tasks: ${id} bad updated_at`);
    });
    counts["tasks"] = rows.length;
    counts["tasks open"] = rows.filter((r) => r[2] !== "Done").length;
    // Inventory takes open cards plus Done cards updated within 30 days: keep that set to the planted R-cards.
    const active = rows.filter((r) => r[2] !== "Done" || TODAY.getTime() - Date.parse(r[7]) <= 30 * 86_400_000).map((r) => r[0]);
    if (EXPECT.activeTaskIds) {
      check(sameSet(active, EXPECT.activeTaskIds), `tasks: open or recently active cards must be ${EXPECT.activeTaskIds.join(", ")}; got ${active.join(", ")}`);
    }
    counts["tasks active"] = active.length;
  }

  if (s.kind === "markdown") {
    const notes = files.filter((f) => f.endsWith(".md"));
    for (const f of notes) {
      const fm = matter(fs.readFileSync(f, "utf8"));
      const data = fm.data as Record<string, unknown>;
      check(isStr(data.title) && data.date !== undefined && isStr(data.author) && isStr(data.author_email),
        `notes: ${rel(f)} front matter needs title, date, author, author_email`);
      if (data.roles !== undefined) {
        const roles = String(data.roles).split(",").map((r) => r.trim()).filter((r) => r !== "");
        if (!isRoleSet(roles) || !subset(roles, s.roleSet)) fail(`notes: ${rel(f)} bad roles ${String(data.roles)}`);
        else {
          fileRoles.set(f, roles);
          // Narrowed notes: every heading section carries a canary token.
          const sections = fm.content.split(/^(?=#{1,6} )/m).filter((sec) => sec.trim() !== "");
          for (const sec of sections) {
            check(new RegExp(CANARY_RE.source).test(sec), `notes: ${rel(f)} restricted section without canary: ${sec.split("\n")[0]}`);
          }
        }
      }
    }
    counts["notes"] = notes.length;
  }

  if (s.kind === "ics") {
    icsText = fs.readFileSync(abs, "utf8");
    check(/^BEGIN:VCALENDAR\r?\n/.test(icsText) && /END:VCALENDAR\s*$/.test(icsText), "ics: VCALENDAR wrapper");
    const events = icsText.split("BEGIN:VEVENT").slice(1).map((e) => e.split("END:VEVENT")[0]);
    for (const e of events) check(/\nUID:/.test(e) && /\nDTSTART[;:]/.test(e) && /\nSUMMARY:/.test(e), "ics: VEVENT needs UID, DTSTART, SUMMARY");
    check(events.some((e) => /\nRRULE:/.test(e)), "ics: at least one recurring event");
    counts["ics events"] = events.length;
    counts["ics recurring"] = events.filter((e) => /\nRRULE:/.test(e)).length;
  }
}

// ---------------------------------------------------------------- canary tokens
const gt = readJson(path.join(DEMO, "ground_truth.json"));
const gtObj: Record<string, Json> = isObj(gt) ? gt : {};
if (!isObj(gt)) fail("ground_truth.json is not an object");

const tokens = new Map<string, { roleSet: RoleKey[]; where: string }>();
for (const t of Array.isArray(gtObj.restricted) ? gtObj.restricted : []) {
  if (!isObj(t) || !isStr(t.token) || !isRoleSet(t.roleSet) || !isStr(t.where)) { fail(`gt: bad restricted ${JSON.stringify(t)}`); continue; }
  tokens.set(t.token, { roleSet: t.roleSet, where: t.where });
}
const tokenSeen = new Set<string>();
for (const [file, roles] of fileRoles) {
  const text = fs.readFileSync(file, "utf8");
  for (const tok of text.match(CANARY_RE) ?? []) {
    const t = tokens.get(tok);
    if (!t) { fail(`canary: ${tok} in ${rel(file)} is not listed in ground_truth.restricted`); continue; }
    check(subset(roles, t.roleSet), `canary: ${tok} appears in ${rel(file)} visible to [${roles.join(", ")}], wider than [${t.roleSet.join(", ")}]`);
    if (rel(file) === t.where) tokenSeen.add(tok);
  }
}
for (const tok of tokens.keys()) check(tokenSeen.has(tok), `canary: ${tok} not found in its 'where' file`);
for (const f of walk(DEMO)) {
  const name = rel(f);
  if (fileRoles.has(f) || name.endsWith("ground_truth.json") || name.endsWith("sources.json") || name.endsWith("model_cache.json")) continue;
  check(!CANARY_RE.test(fs.readFileSync(f, "utf8")), `canary: token in a file that is not a source: ${name}`);
  CANARY_RE.lastIndex = 0;
}

// ---------------------------------------------------------------- ground truth
const respKind = new Map<string, RespKind>();
for (const r of Array.isArray(gtObj.responsibilities) ? gtObj.responsibilities : []) {
  if (!isObj(r) || !isStr(r.key) || !isStr(r.title) || !(RESP_KINDS as readonly string[]).includes(String(r.kind))
    || !["task_board", "footprint", "role_template"].includes(String(r.origin)) || !isStr(r.originDetail) || !isStrArr(r.entities)) {
    fail(`gt: bad responsibility ${JSON.stringify(r)}`);
    continue;
  }
  check(r.dueDate === null || (typeof r.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate)), `gt: ${r.key} bad dueDate`);
  for (const e of r.entities) check(entityKeys.has(e), `gt: ${r.key} unknown entity ${e}`);
  respKind.set(r.key, r.kind as RespKind);
}
check(respKind.size > 0, "gt: no responsibilities");
if (EXPECT.responsibilities !== undefined) check(respKind.size === EXPECT.responsibilities, `gt: expected ${EXPECT.responsibilities} responsibilities, got ${respKind.size}`);
const checkDef = (resp: string, key: string) => {
  const kind = respKind.get(resp);
  return kind ? checklist.get(kind)?.find((c) => c.key === key) : undefined;
};

interface GtClaim { id: string; entity: string; attribute: string; roleSet: RoleKey[]; state: string; check: { responsibility: string; checkKey: string } | null }
const claims: GtClaim[] = [];
const claimIds = new Set<string>();
for (const c of Array.isArray(gtObj.claims) ? gtObj.claims : []) {
  if (!isObj(c) || !isStr(c.id) || !isStr(c.entity) || !isStr(c.attribute) || !isStr(c.value) || !isStrArr(c.keywords)
    || !isObj(c.source) || !isRoleSet(c.roleSet)) {
    fail(`gt: bad claim ${JSON.stringify(c)}`);
    continue;
  }
  const src = c.source;
  check(!claimIds.has(c.id), `gt: duplicate claim id ${c.id}`);
  claimIds.add(c.id);
  check(entityKeys.has(c.entity), `gt: ${c.id} unknown entity ${c.entity}`);
  check((ATTRS as readonly string[]).includes(c.attribute), `gt: ${c.id} unknown attribute ${c.attribute}`);
  check(c.keywords.length > 0 && c.keywords.every((k) => k === k.toLowerCase()), `gt: ${c.id} keywords must be lowercase`);
  check((KINDS as readonly string[]).includes(String(src.kind)), `gt: ${c.id} bad source kind`);
  const file = isStr(src.path) ? path.join(ROOT, src.path) : "";
  if (!file || !fs.existsSync(file)) { fail(`gt: ${c.id} source file missing ${String(src.path)}`); continue; }
  check(isStr(src.contains) && fs.readFileSync(file, "utf8").includes(src.contains), `gt: ${c.id} contains not found verbatim in ${String(src.path)}`);
  const roles = fileRoles.get(file);
  check(roles !== undefined && sameSet(roles, c.roleSet), `gt: ${c.id} roleSet does not match its source file`);
  let chk: GtClaim["check"] = null;
  if (c.check !== null) {
    if (!isObj(c.check) || !isStr(c.check.responsibility) || !isStr(c.check.checkKey) || !checkDef(c.check.responsibility, c.check.checkKey)) {
      fail(`gt: ${c.id} bad check ${JSON.stringify(c.check)}`);
    } else {
      chk = { responsibility: c.check.responsibility, checkKey: c.check.checkKey };
      const def = checkDef(chk.responsibility, chk.checkKey);
      check(def?.attributes.includes(c.attribute), `gt: ${c.id} attribute ${c.attribute} cannot satisfy ${chk.responsibility}.${chk.checkKey}`);
    }
  }
  check(["active", "superseded", "conflicting"].includes(String(c.state)), `gt: ${c.id} bad state`);
  claims.push({ id: c.id, entity: c.entity, attribute: c.attribute, roleSet: c.roleSet, state: String(c.state), check: chk });
}
check(claims.length > 0, "gt: no planted claims");
if (EXPECT.claims) check(claims.length >= EXPECT.claims[0] && claims.length <= EXPECT.claims[1], `gt: expected ${EXPECT.claims[0]}-${EXPECT.claims[1]} claims, got ${claims.length}`);

const conflictsRaw = Array.isArray(gtObj.conflicts) ? gtObj.conflicts.filter(isObj) : [];
/** True when the claim is in a planted conflict that also has a side the successor cannot read. */
const hiddenSideConflict = (claimId: string): boolean =>
  conflictsRaw.some((c) => isStrArr(c.claims) && c.claims.includes(claimId)
    && c.claims.some((id) => claims.find((x) => x.id === id)?.roleSet.includes(SUCCESSOR) === false));

// Planted coverage for the successor must agree with the gaps list.
const gaps = Array.isArray(gtObj.gaps) ? gtObj.gaps.filter(isObj) : [];
let blocking = 0;
for (const [resp, kind] of respKind) {
  for (const def of checklist.get(kind) ?? []) {
    const gap = gaps.find((g) => g.responsibility === resp && g.checkKey === def.key);
    const forCheck = claims.filter((c) => c.check?.responsibility === resp && c.check.checkKey === def.key);
    const visible = forCheck.filter((c) => c.roleSet.includes(SUCCESSOR));
    const visibleActive = visible.filter((c) => c.state === "active");
    if (!gap) {
      check(visibleActive.length > 0, `coverage: ${resp}.${def.key} has no gap but no active claim visible to ${SUCCESSOR}`);
      continue;
    }
    const cov = String(gap.coverage);
    check(gap.blocking === (def.weight === 5), `gaps: ${resp}.${def.key} blocking flag must match weight`);
    if (def.weight === 5) blocking++;
    if (cov === "restricted") {
      check(visible.length === 0 && forCheck.length > 0, `coverage: ${resp}.${def.key} restricted needs evidence only for other roles`);
    } else if (cov === "missing") {
      check(visibleActive.length === 0, `coverage: ${resp}.${def.key} marked missing but has visible claims`);
    } else if (cov === "conflicting") {
      check(visible.filter((c) => c.state === "conflicting").length >= 2, `coverage: ${resp}.${def.key} conflicting needs two visible conflicting claims`);
    } else if (cov === "partial") {
      check(true, "");
    } else fail(`gaps: ${resp}.${def.key} bad coverage ${cov}`);
  }
}
for (const g of gaps) check(checkDef(String(g.responsibility), String(g.checkKey)) && isStr(g.why), `gaps: bad gap ${JSON.stringify(g)}`);
// The answer key states how many blocking gaps the successor has (older keys name the field after the club's successor).
const expectedBlocking = gtObj.expectedSuccessorBlockingGaps ?? gtObj.expectedTechLeadBlockingGaps;
check(blocking === expectedBlocking, `gaps: ${blocking} blocking gaps but the answer key expects ${String(expectedBlocking)}`);

for (const r of Array.isArray(gtObj.restrictedChecks) ? gtObj.restrictedChecks : []) {
  check(isObj(r) && checkDef(String(r.responsibility), String(r.checkKey)) && isRoleSet(r.visibleTo), `gt: bad restrictedCheck ${JSON.stringify(r)}`);
}
const sup = Array.isArray(gtObj.supersessions) ? gtObj.supersessions : [];
check(sup.length >= 3, "gt: at least three supersessions");
for (const s of sup) {
  check(isObj(s) && entityKeys.has(String(s.entity)) && (ATTRS as readonly string[]).includes(String(s.attribute)) && (s.rule === 1 || s.rule === 2),
    `gt: bad supersession ${JSON.stringify(s)}`);
}
const conf = Array.isArray(gtObj.conflicts) ? gtObj.conflicts : [];
check(conf.length >= 2, "gt: at least two conflicts");
for (const c of conf) check(isObj(c) && isStrArr(c.values) && c.values.length >= 2, `gt: bad conflict ${JSON.stringify(c)}`);

const secrets = Array.isArray(gtObj.secrets) ? gtObj.secrets : [];
for (const s of secrets) {
  if (!isObj(s) || !isStr(s.where) || !isStr(s.type) || !isStr(s.value)) { fail(`gt: bad secret ${JSON.stringify(s)}`); continue; }
  const file = path.join(ROOT, s.where);
  check(fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(s.value), `secrets: ${s.type} value not found in ${s.where}`);
  // the shape the masker recognises (src/lib/tether/mask.ts); the adapters stage proves it is masked
  if (s.type === "github_token") check(/^gh[pousr]_[A-Za-z0-9]{20,}$/.test(s.value), "secrets: github token must be gh?_ + at least 20 alphanumerics");
  if (s.type === "aws_access_key_id") check(/^AKIA[A-Z0-9]{16}$/.test(s.value), "secrets: AWS key id format");
}

const rbGt = Array.isArray(gtObj.readback) ? gtObj.readback.filter(isObj) : [];
check(sameSet(rbGt.map((r) => String(r.key)), readbackKeys), "gt: readback keys must match the pack");
for (const r of rbGt) {
  check(isStr(r.expected), `gt: readback ${String(r.key)} needs expected`);
  const ids = isStrArr(r.claims) ? r.claims : [];
  check(ids.some((id) => claims.find((c) => c.id === id)?.roleSet.includes(SUCCESSOR)),
    `gt: readback ${String(r.key)} must be backed by a claim visible to ${SUCCESSOR}`);
}
const offBoard = Array.isArray(gtObj.offBoard) ? gtObj.offBoard : [];
for (const o of offBoard) check(isObj(o) && respKind.has(String(o.responsibility)) && isStr(o.rule) && isStr(o.evidence), `gt: bad offBoard ${JSON.stringify(o)}`);

// ---------------------------------------------------------------- footprint evidence
// What the leaver did off the board must really be in the data, at the pack's own thresholds.
// Each expectation comes from the pack's demo.expect.footprint; the leaver is the pack's role holder.
const windowStart = new Date(TODAY);
windowStart.setMonth(windowStart.getMonth() - resolved.footprint.windowMonths);
const inWindow = commits.filter((c) => new Date(c.date) >= windowStart);
const isLeaver = (name: string) => LEAVER_NAMES.includes(name);
const footprintSummary: Record<string, string> = {};
for (const f of EXPECT.footprint ?? []) {
  if (f.source === "commits") {
    const touching = inWindow.filter((c) => c.files.some((x) => x.path.startsWith(f.pathPrefix ?? "")));
    const mine = touching.filter((c) => isLeaver(c.author_name));
    const share = touching.length ? mine.length / touching.length : 0;
    const weeks = new Set(mine.map((c) => weekKey(new Date(c.date)))).size;
    check(share >= (f.minShare ?? resolved.footprint.ownershipShare) && weeks >= (f.minWeeks ?? 0),
      `footprint: ${f.label}: leaver share ${mine.length}/${touching.length} in ${weeks} weeks`);
    footprintSummary[`footprint ${f.label}`] = `${mine.length}/${touching.length}`;
  } else if (f.source === "whatsapp") {
    const re = new RegExp(f.pattern ?? "", "i");
    const hits = whatsappMsgs.filter((m) => isLeaver(m.author) && re.test(m.text));
    const weeks = new Set(hits.map((m) => weekKey(m.ts))).size;
    check(hits.length >= (f.minCount ?? resolved.footprint.repeatMin) && weeks >= (f.minWeeks ?? resolved.footprint.distinctWeeksMin),
      `footprint: ${f.label}: ${hits.length} messages in ${weeks} weeks`);
    footprintSummary[`footprint ${f.label}`] = `${hits.length} messages, ${weeks} weeks`;
  } else if (f.source === "ics") {
    const re = new RegExp(`SUMMARY:.*${f.pattern ?? ""}`, "i");
    const events = icsText.split("BEGIN:VEVENT").slice(1).filter((e) => re.test(e));
    const weeks = new Set(events.map((e) => {
      const m = /DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})/.exec(e);
      return m ? weekKey(new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)) : -1;
    })).size;
    check(events.length >= (f.minCount ?? resolved.footprint.repeatMin) && weeks >= (f.minWeeks ?? resolved.footprint.distinctWeeksMin),
      `footprint: ${f.label}: ${events.length} events in ${weeks} weeks`);
    footprintSummary[`footprint ${f.label}`] = `${events.length} events, ${weeks} weeks`;
  } else {
    fail(`pack: demo.expect.footprint has an unknown source ${JSON.stringify(f)}`);
  }
}

// ---------------------------------------------------------------- report
const summary = {
  ...counts,
  "gt claims": claims.length,
  "gt gaps": gaps.length,
  [`gt blocking gaps (${SUCCESSOR})`]: blocking,
  "gt supersessions": sup.length,
  "gt conflicts": conf.length,
  "canary tokens": tokens.size,
  secrets: secrets.length,
  ...footprintSummary,
};
console.log(`pack ${PACK_ID} (${PACK_FILE}), demo data in ${rel(DEMO)}\n`);
for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(30)} ${String(v)}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\ncheck-demo: OK (${PACK_ID})`);

// Second stage: the same corpus through the real adapters, the masker, the footprint and the inventory.
if (EXPECT.adapters || process.argv.includes("--adapters")) {
  if (packArg === -1) process.argv.push("--pack", PACK_ID);
  console.log("\n--- adapters stage ---\n");
  import("./check-demo-adapters").catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
