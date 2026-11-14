// Validates one setting pack and its synthetic demo dataset against the demo's answer key, before
// any model runs. Works for any pack: roles, folders and dates come from the pack; what a given demo
// must contain comes from its answer key (<demo.dataDir>/ground_truth.json) and from the optional
// `demo.expect` block of the pack (counts, the task cards that stay active, footprint evidence).
// Run from the repo root: pnpm tsx scripts/check-demo.ts [--pack <id>]   (default: packs/index.json)
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

// A token is source-level (the whole source is restricted) or content-level (`level: "content"`: the source
// is open and the classifier must limit the one message). Content-level tokens are tied to gt.sensitive.
const tokens = new Map<string, { roleSet: RoleKey[]; where: string; content: boolean }>();
for (const t of Array.isArray(gtObj.restricted) ? gtObj.restricted : []) {
  if (!isObj(t) || !isStr(t.token) || !isRoleSet(t.roleSet) || !isStr(t.where)) { fail(`gt: bad restricted ${JSON.stringify(t)}`); continue; }
  check(t.level === undefined || t.level === "content", `gt: restricted ${t.token} level must be "content" when present`);
  tokens.set(t.token, { roleSet: t.roleSet, where: t.where, content: t.level === "content" });
}

const CATEGORIES = ["finance", "hr", "health"];
interface Sensitive { id: string; where: string; category: string; expectedRoles: RoleKey[]; containsText: string; canary: string | null }
const sensitive: Sensitive[] = [];
for (const x of Array.isArray(gtObj.sensitive) ? gtObj.sensitive : []) {
  if (!isObj(x) || !isStr(x.id) || !isStr(x.where) || !isStr(x.containsText) || !isRoleSet(x.expectedRoles)
    || !CATEGORIES.includes(String(x.category)) || !(x.canary === null || isStr(x.canary))) {
    fail(`gt: bad sensitive ${JSON.stringify(x)}`);
    continue;
  }
  sensitive.push({ id: x.id, where: x.where, category: String(x.category), expectedRoles: x.expectedRoles, containsText: x.containsText, canary: x.canary });
}
const linesOf = (relPath: string): string[] =>
  fs.existsSync(path.join(ROOT, relPath)) ? fs.readFileSync(path.join(ROOT, relPath), "utf8").split(/\r?\n/) : [];

const tokenSeen = new Set<string>();
for (const [file, roles] of fileRoles) {
  const text = fs.readFileSync(file, "utf8");
  for (const tok of text.match(CANARY_RE) ?? []) {
    const t = tokens.get(tok);
    if (!t) { fail(`canary: ${tok} in ${rel(file)} is not listed in ground_truth.restricted`); continue; }
    if (t.content) {
      check(rel(file) === t.where, `canary: content-level ${tok} found outside its 'where' file, in ${rel(file)}`);
      if (rel(file) === t.where) tokenSeen.add(tok);
      continue;
    }
    check(subset(roles, t.roleSet), `canary: ${tok} appears in ${rel(file)} visible to [${roles.join(", ")}], wider than [${t.roleSet.join(", ")}]`);
    if (rel(file) === t.where) tokenSeen.add(tok);
  }
}
for (const tok of tokens.keys()) check(tokenSeen.has(tok), `canary: ${tok} not found in its 'where' file`);
// Content-level tokens: every line that carries one is a listed sensitive message with the token's exact role set.
for (const [tok, t] of tokens) {
  if (!t.content) continue;
  for (const line of linesOf(t.where).filter((l) => l.includes(tok))) {
    const hit = sensitive.find((x) => x.where === t.where && line.includes(x.containsText));
    if (!hit) { fail(`canary: ${tok} sits in a line that is not listed in ground_truth.sensitive: ${line.slice(0, 80)}`); continue; }
    check(hit.canary === tok && sameSet(hit.expectedRoles, t.roleSet), `canary: ${tok} and sensitive ${hit.id} disagree on token or role set`);
  }
}
for (const f of walk(DEMO)) {
  const name = rel(f);
  // probes.json restates restricted facts on purpose and names the token of each original.
  if (fileRoles.has(f) || name.endsWith("ground_truth.json") || name.endsWith("sources.json") || name.endsWith("model_cache.json") || name.endsWith("probes.json")) continue;
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
/** True when the claim is in a planted conflict that also has a side the tech lead cannot read. */
const hiddenSideConflict = (claimId: string): boolean =>
  conflictsRaw.some((c) => isStrArr(c.claims) && c.claims.includes(claimId)
    && c.claims.some((id) => claims.find((x) => x.id === id)?.roleSet.includes("tech_lead") === false));

// Planted coverage for the successor (tech_lead) must agree with the gaps list.
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
      // A visible claim is allowed only as one side of a conflict whose other side is hidden from the tech lead
      // (the role then gets a stub: no flag, no value).
      const halfHidden = visible.every((c) => c.state === "conflicting" && hiddenSideConflict(c.id));
      check(forCheck.length > visible.length && halfHidden, `coverage: ${resp}.${def.key} restricted needs evidence only for other roles`);
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
  if (s.type === "github_token") check(/^ghp_[A-Za-z0-9]{36}$/.test(s.value), "secrets: github token must be ghp_ + 36 alphanumerics");
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

// ---------------------------------------------------------------- Round 3: sensitive content and decoys
const rolesOfSource = (relPath: string): RoleKey[] | undefined => fileRoles.get(path.join(ROOT, relPath));
const sensitiveIds = new Set<string>();
for (const x of sensitive) {
  check(!sensitiveIds.has(x.id), `sensitive: duplicate id ${x.id}`);
  sensitiveIds.add(x.id);
  const roles = rolesOfSource(x.where);
  if (!roles) { fail(`sensitive: ${x.id} 'where' is not a source file: ${x.where}`); continue; }
  const hits = linesOf(x.where).filter((l) => l.includes(x.containsText));
  check(hits.length === 1, `sensitive: ${x.id} containsText must match exactly one line, got ${hits.length}`);
  check(subset(x.expectedRoles, roles) && x.expectedRoles.length < roles.length, `sensitive: ${x.id} expectedRoles must be narrower than its source`);
  const lineTokens = hits.flatMap((l) => l.match(new RegExp(CANARY_RE.source, "g")) ?? []);
  if (x.canary === null) check(lineTokens.length === 0, `sensitive: ${x.id} lists no canary but its line carries one`);
  else {
    const t = tokens.get(x.canary);
    check(t !== undefined && t.content && sameSet(t.roleSet, x.expectedRoles), `sensitive: ${x.id} canary ${x.canary} must be a content-level token with the same role set`);
    check(lineTokens.length === 1 && lineTokens[0] === x.canary, `sensitive: ${x.id} line must carry exactly its canary ${x.canary}`);
  }
}
check(sensitive.length >= 8, `sensitive: expected at least 8 planted messages, got ${sensitive.length}`);
for (const cat of CATEGORIES) check(sensitive.some((x) => x.category === cat), `sensitive: no planted ${cat} case`);

const decoys = Array.isArray(gtObj.decoys) ? gtObj.decoys.filter(isObj) : [];
const DECOY_GROUPS = ["spec_decoy", "open_follow_up", "open_conflict_side", "false_positive"];
for (const d of decoys) {
  if (!isStr(d.where) || !isStr(d.containsText) || !isStr(d.tempts) || !DECOY_GROUPS.includes(String(d.group))) { fail(`decoys: bad entry ${JSON.stringify(d)}`); continue; }
  const roles = rolesOfSource(d.where);
  check(roles !== undefined && sameSet(roles, ROLE_KEYS), `decoys: '${d.containsText.slice(0, 40)}' must sit in a source open to every role`);
  const hits = linesOf(d.where).filter((l) => l.includes(d.containsText as string));
  check(hits.length === 1, `decoys: '${d.containsText.slice(0, 40)}' must match exactly one line, got ${hits.length}`);
  for (const l of hits) {
    check(!new RegExp(CANARY_RE.source).test(l), `decoys: '${d.containsText.slice(0, 40)}' line carries a canary token`);
    check(!sensitive.some((x) => x.where === d.where && l.includes(x.containsText)), `decoys: '${d.containsText.slice(0, 40)}' is also listed as sensitive`);
  }
  if (d.group === "false_positive") {
    check(d.expected === "limited_by_rule_then_widened" && isRoleSet(d.expectedRolesBeforeWiden) && isRoleSet(d.expectedRolesAfterWiden)
      && sameSet(d.expectedRolesAfterWiden, ROLE_KEYS) && d.expectedRolesBeforeWiden.length < ROLE_KEYS.length,
    "decoys: the false positive must be limited by rule, then widened to every role");
  } else check(d.expected === "open", `decoys: '${d.containsText.slice(0, 40)}' must be expected open`);
}
check(decoys.filter((d) => d.group === "spec_decoy").length === 8, "decoys: exactly eight spec decoys that stay open");
check(decoys.filter((d) => d.group === "false_positive").length === 1, "decoys: exactly one deliberate false positive");

// A conflict with one hidden side: the flag is for roles that read every side, a stub for roles that read only some.
const hiddenSide = conflictsRaw.filter((c) => c.oneSideHidden === true);
check(hiddenSide.length >= 1, "conflicts: at least one conflict with one hidden side");
for (const c of hiddenSide) {
  const sides = (isStrArr(c.claims) ? c.claims : []).map((id) => claims.find((x) => x.id === id));
  if (sides.length < 2 || sides.some((x) => !x)) { fail(`conflicts: hidden-side conflict has unknown claims ${JSON.stringify(c.claims)}`); continue; }
  const sets = sides.map((x) => (x as GtClaim).roleSet);
  check(sides.every((x) => (x as GtClaim).state === "conflicting"), `conflicts: every side of ${String(c.entity)} must be conflicting`);
  const all = ROLE_KEYS.filter((r) => sets.every((s) => s.includes(r)));
  const some = ROLE_KEYS.filter((r) => sets.some((s) => s.includes(r)) && !sets.every((s) => s.includes(r)));
  check(isRoleSet(c.flagVisibleTo) && sameSet(c.flagVisibleTo, all), `conflicts: ${String(c.entity)} flagVisibleTo must be [${all.join(", ")}]`);
  check(isStrArr(c.stubFor) && sameSet(c.stubFor, some) && some.includes("tech_lead"), `conflicts: ${String(c.entity)} stubFor must be [${some.join(", ")}]`);
}

// ---------------------------------------------------------------- Round 3: probes (reworded restricted facts)
// Reference form of the key-term check in spec 02 section 9.4. The real check lives in src/lib/relay/core/probes.ts.
const MONTH_NUM: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function probeNorm(text: string, isoDates: boolean): string {
  let t = text.toLowerCase();
  t = t.replace(/₹/g, " ").replace(/\b(rs\.?|inr|rupees)(?=\s*\d)/g, " ");
  t = t.replace(/(\d),(?=\d{3}\b)/g, "$1");
  t = t.replace(/\b(\d+(?:\.\d+)?)\s?k\b/g, (_m, n: string) => String(Math.round(Number(n) * 1000)));
  if (isoDates) {
    t = t.replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/g,
      (_m, d: string, mo: string, y: string) => `${y}-${MONTH_NUM[mo]}-${d.padStart(2, "0")}`);
  }
  t = t.replace(/[^a-z0-9.\-\s]/g, " ").replace(/(?<!\d)[.\-]|[.\-](?!\d)/g, " ");
  const words = t.split(/\s+/).filter((w) => w !== "").map((w) => (w.length >= 5 && /^[a-z]+$/.test(w) ? w.replace(/(ing|ed|s)$/, "") : w));
  return ` ${words.join(" ")} `;
}
interface ProbeFact { id: string; roleSet: RoleKey[]; termGroups: string[][]; mustGroups: number[]; minGroups: number }
function probeHit(fact: ProbeFact, text: string): boolean {
  const variants = [probeNorm(text, false), probeNorm(text, true)];
  const matched = fact.termGroups.map((group) =>
    group.some((term) => [probeNorm(term, false), probeNorm(term, true)].some((tt) => variants.some((v) => v.includes(tt)))));
  return matched.filter(Boolean).length >= fact.minGroups && fact.mustGroups.every((g) => matched[g]);
}

const probesPath = path.join(DEMO, "probes.json");
const probeFacts: ProbeFact[] = [];
let evalCount = 0;
let evalPos = 0;
if (!fs.existsSync(probesPath)) fail("probes: data/demo/probes.json is missing");
else {
  const probes = readJson(probesPath);
  const allSourceText = [...fileRoles.keys()].map((f) => fs.readFileSync(f, "utf8")).join("\n");
  if (!isObj(probes) || probes.version !== 1 || !Array.isArray(probes.facts) || !Array.isArray(probes.evalSegments)) fail("probes: need version 1, facts[] and evalSegments[]");
  else {
    for (const f of probes.facts) {
      if (!isObj(f) || !isStr(f.id) || !/^pf-\d{2}$/.test(f.id) || !CATEGORIES.includes(String(f.category)) || !isStr(f.fact) || !isRoleSet(f.roleSet)
        || !Array.isArray(f.termGroups) || !f.termGroups.every((g) => isStrArr(g) && g.length > 0) || !Array.isArray(f.mustGroups)
        || typeof f.minGroups !== "number" || !isStrArr(f.rewordings) || !isStrArr(f.hardRewordings)) {
        fail(`probes: bad fact ${JSON.stringify(f).slice(0, 120)}`);
        continue;
      }
      const groups = f.termGroups as string[][];
      const must = f.mustGroups as Json[];
      check(!probeFacts.some((p) => p.id === f.id), `probes: duplicate fact ${f.id}`);
      check(f.roleSet.length < ROLE_KEYS.length, `probes: ${f.id} roleSet must exclude at least one role`);
      check(groups.length >= 2 && groups.flat().every((t) => t === t.toLowerCase()), `probes: ${f.id} needs two or more lowercase term groups`);
      check(must.every((g) => typeof g === "number" && Number.isInteger(g) && g >= 0 && g < groups.length), `probes: ${f.id} mustGroups must be zero-based indexes into termGroups`);
      check(f.minGroups >= 1 && f.minGroups <= groups.length && f.minGroups >= 2, `probes: ${f.id} minGroups must be between 2 and the number of groups`);
      check(f.rewordings.length >= 3, `probes: ${f.id} needs three or more rewordings`);
      if (f.canary !== null && f.canary !== undefined) {
        const t = isStr(f.canary) ? tokens.get(f.canary) : undefined;
        check(t !== undefined && sameSet(t.roleSet, f.roleSet), `probes: ${f.id} canary must be a listed token with the same role set`);
      }
      const fact: ProbeFact = { id: f.id, roleSet: f.roleSet, termGroups: groups, mustGroups: must as number[], minGroups: f.minGroups };
      probeFacts.push(fact);
      check(probeHit(fact, f.fact), `probes: ${f.id} key terms do not find the fact sentence itself`);
      for (const r of f.rewordings) check(probeHit(fact, r), `probes: ${f.id} key terms miss a rewording marked catchable: ${r}`);
      for (const r of f.hardRewordings) {
        check(!probeHit(fact, r), `probes: ${f.id} hard rewording is caught by key terms, so it is not hard: ${r}`);
        check(!allSourceText.includes(r), `probes: ${f.id} hard rewording must not appear in the live demo sources`);
      }
    }
    const evalIds = new Set<string>();
    const negatives: string[] = [];
    for (const e of probes.evalSegments) {
      if (!isObj(e) || !isStr(e.id) || !isStr(e.kind) || !isStr(e.thread) || !isStr(e.author) || !isStr(e.text)
        || !["sensitive", "open"].includes(String(e.expect)) || !["rule", "model", "hard"].includes(String(e.difficulty))) {
        fail(`probes: bad evalSegment ${JSON.stringify(e).slice(0, 120)}`);
        continue;
      }
      check(!evalIds.has(e.id), `probes: duplicate evalSegment ${e.id}`);
      evalIds.add(e.id);
      evalCount++;
      check(e.factId === null || probeFacts.some((p) => p.id === e.factId), `probes: ${e.id} unknown factId ${String(e.factId)}`);
      if (e.expect === "sensitive") {
        evalPos++;
        check(CATEGORIES.includes(String(e.category)), `probes: ${e.id} a positive needs a category`);
        if (e.difficulty === "hard") check(!allSourceText.includes(e.text), `probes: ${e.id} is hard, so it must not appear in the live demo sources`);
      } else {
        check(e.category === null && e.factId === null, `probes: ${e.id} a negative has no category and no fact`);
        negatives.push(e.text);
      }
    }
    check(evalPos >= 15 && negatives.length >= 20, `probes: evaluation set needs 15+ positives and 20+ negatives, got ${evalPos} and ${negatives.length}`);
    for (const d of decoys.filter((x) => x.group === "spec_decoy" || x.group === "false_positive")) {
      check(negatives.some((n) => n.includes(String(d.containsText))), `probes: decoy missing from the evaluation negatives: ${String(d.containsText).slice(0, 40)}`);
    }
    // No key-term false alarm on content a role may read: every source line, minus the messages limited away from that role.
    for (const role of ROLE_KEYS) {
      for (const [file, roles] of fileRoles) {
        if (!roles.includes(role)) continue;
        const hidden = sensitive.filter((x) => x.where === rel(file) && !x.expectedRoles.includes(role));
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
          if (hidden.some((x) => line.includes(x.containsText))) continue;
          for (const fact of probeFacts) {
            if (fact.roleSet.includes(role)) continue;
            check(!probeHit(fact, line), `probes: ${fact.id} fires for ${role} on open content in ${rel(file)}: ${line.trim().slice(0, 90)}`);
          }
        }
      }
    }
    const ref = gtObj.probes;
    check(isObj(ref) && ref.file === "data/demo/probes.json" && isStrArr(ref.facts) && sameSet(ref.facts, probeFacts.map((p) => p.id))
      && ref.evalSegments === evalCount && ref.evalPositives === evalPos && ref.evalNegatives === negatives.length
      && isStrArr(ref.liveRewordings) && ref.liveRewordings.every((id) => sensitiveIds.has(id)),
    "gt: probes reference must match data/demo/probes.json (facts, counts, live rewordings)");
  }
}

// ---------------------------------------------------------------- Round 3: CI run history
interface Run { id: number; run_number: number; run_attempt: number; rerun_of: number | null; status: string; failed_step: string | null; started_at: string; duration_s: number; head_sha: string; actor_name: string; actor_email: string }
const githubDir = sources.find((s) => s.kind === "github")?.path ?? "data/demo/github";
const runsPath = path.join(ROOT, githubDir, "runs.json");
const WORKFLOW_FILE = ".github/workflows/deploy.yml";
const workflowText = fs.existsSync(path.join(ROOT, githubDir, "files", WORKFLOW_FILE)) ? fs.readFileSync(path.join(ROOT, githubDir, "files", WORKFLOW_FILE), "utf8") : "";
const workflowSteps = [...workflowText.matchAll(/^\s*- (?:run|uses): (.+?)\s*$/gm)].map((m) => m[1]);
const rawCommits = (fs.existsSync(path.join(ROOT, githubDir, "commits.json")) ? readJson(path.join(ROOT, githubDir, "commits.json")) : []) as
  { sha: string; author_name: string; author_email: string; date: string; message: string; files: { path: string }[] }[];
const commitBySha = new Map(rawCommits.map((c) => [c.sha, c]));
const commitByPrefix = (p: string) => rawCommits.find((c) => c.sha.startsWith(p));
const runs: Run[] = [];
if (!fs.existsSync(runsPath)) fail("runs: github/runs.json is missing");
else {
  const rawRuns = readJson(runsPath);
  if (!Array.isArray(rawRuns)) fail("runs: runs.json must be an array");
  else {
    const authors = new Map(rawCommits.map((c) => [c.author_email, c.author_name]));
    const wfName = /^name:\s*(.+?)\s*$/m.exec(workflowText)?.[1];
    for (const r of rawRuns) {
      if (!isObj(r) || typeof r.id !== "number" || typeof r.run_number !== "number" || typeof r.run_attempt !== "number"
        || !(r.rerun_of === null || typeof r.rerun_of === "number") || !["success", "failure"].includes(String(r.status))
        || !(r.failed_step === null || isStr(r.failed_step)) || !isStr(r.started_at) || Number.isNaN(Date.parse(r.started_at))
        || typeof r.duration_s !== "number" || r.duration_s <= 0 || !isStr(r.head_sha) || !isStr(r.actor_name) || !isStr(r.actor_email)) {
        fail(`runs: bad run ${JSON.stringify(r).slice(0, 160)}`);
        continue;
      }
      check(r.workflow_file === WORKFLOW_FILE && r.name === wfName && r.event === "push" && r.head_branch === "main",
        `runs: run ${r.run_number} must be a push to main of ${WORKFLOW_FILE} named ${String(wfName)}`);
      const c = commitBySha.get(r.head_sha);
      check(c !== undefined, `runs: run ${r.run_number} head_sha is not in commits.json`);
      check((r.status === "failure") === (r.failed_step !== null), `runs: run ${r.run_number} needs failed_step exactly when it failed`);
      if (r.failed_step !== null) check(workflowSteps.includes(r.failed_step), `runs: run ${r.run_number} failed_step '${r.failed_step}' is not a step line of the workflow file`);
      check(authors.get(r.actor_email) === r.actor_name, `runs: run ${r.run_number} actor is not a known commit author`);
      if (c) {
        const lag = (Date.parse(r.started_at) - Date.parse(c.date)) / 60_000;
        if (r.run_attempt === 1) {
          check(lag > 0 && lag <= 10 && r.rerun_of === null, `runs: run ${r.run_number} must start within ten minutes after its commit`);
          check(r.actor_email === c.author_email, `runs: run ${r.run_number} first attempt must be started by the commit author`);
        } else {
          const firstTry = runs.find((x) => x.id === r.rerun_of);
          check(firstTry !== undefined && firstTry.head_sha === r.head_sha && firstTry.status === "failure" && Date.parse(firstTry.started_at) < Date.parse(r.started_at),
            `runs: run ${r.run_number} must re-run an earlier failed run of the same commit`);
        }
      }
      const prev = runs[runs.length - 1];
      if (prev) check(r.id > prev.id && r.run_number === prev.run_number + 1 && Date.parse(r.started_at) > Date.parse(prev.started_at), `runs: run ${r.run_number} is out of order`);
      runs.push(r as unknown as Run);
    }
    check(runs.length >= 20 && runs.length <= 40, `runs: expected a small history of 20 to 40 runs, got ${runs.length}`);
    check(new Set(runs.map((r) => r.id)).size === runs.length, "runs: duplicate run id");
    // One run per push to main since the workflow exists; the registration form lives on a feature branch.
    const firstWf = rawCommits.filter((c) => c.files.some((f) => f.path === WORKFLOW_FILE)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
    for (const c of rawCommits) {
      const onMain = firstWf !== undefined && Date.parse(c.date) >= Date.parse(firstWf.date) && !c.files.some((f) => /^website\/register\./.test(f.path));
      const n = runs.filter((r) => r.head_sha === c.sha).length;
      check(onMain ? n >= 1 : n === 0, `runs: commit ${c.sha.slice(0, 7)} should have ${onMain ? "at least one run" : "no run"}, has ${n}`);
    }
  }
}

// ---------------------------------------------------------------- Round 3: recovery answer key
const knownPeople = new Set<string>(whatsappMsgs.map((m) => m.author));
for (const s of sources.filter((x) => x.kind === "slack")) {
  const users = readJson(path.join(ROOT, s.path, "users.json"));
  for (const u of Array.isArray(users) ? users : []) if (isObj(u) && isStr(u.real_name)) knownPeople.add(u.real_name);
}
const isGapRef = (x: Json): x is Record<string, Json> => isObj(x) && checkDef(String(x.responsibility), String(x.checkKey)) !== undefined;
const isPeople = (x: Json): x is string[] => isStrArr(x) && x.every((n) => knownPeople.has(n));
const recovery = isObj(gtObj.recovery) ? gtObj.recovery : null;
let ciGapSummary = "missing";
if (!recovery) fail("gt: recovery section missing");
else {
  const holders = isObj(recovery.roleHolders) ? recovery.roleHolders : {};
  check(sameSet(Object.keys(holders), ROLE_KEYS) && Object.values(holders).every(isPeople), "recovery: roleHolders must list known people for the five roles");
  const roleOf = (person: string): string | undefined => Object.keys(holders).find((r) => (holders[r] as string[]).includes(person));

  const neighbours = Array.isArray(recovery.neighbours) ? recovery.neighbours : [];
  check(neighbours.length >= 8, "recovery: neighbours must cover the open gaps of the tech lead");
  for (const n of neighbours) {
    if (!isGapRef(n) || !isPeople(n.asked) || !isPeople(n.skippedNoAccess) || !isPeople(n.noSeat) || !isStr(n.trace) || !isStr(n.endState)) {
      fail(`recovery: bad neighbours entry ${JSON.stringify(n).slice(0, 140)}`);
      continue;
    }
    const gap = gaps.find((g) => g.responsibility === n.responsibility && g.checkKey === n.checkKey);
    check(gap !== undefined && gap.coverage !== "restricted", `recovery: ${String(n.responsibility)}.${String(n.checkKey)} must be an open, non-restricted gap`);
    for (const p of [...n.asked, ...n.skippedNoAccess]) check(roleOf(p) !== undefined && roleOf(p) !== "leaver", `recovery: ${p} is asked or skipped but holds no role`);
    for (const p of n.noSeat) check(roleOf(p) === undefined, `recovery: ${p} is listed as no role but holds one`);
  }
  for (const g of gaps.filter((x) => x.coverage !== "restricted")) {
    check(neighbours.some((n) => isObj(n) && n.responsibility === g.responsibility && n.checkKey === g.checkKey),
      `recovery: open gap ${String(g.responsibility)}.${String(g.checkKey)} has no neighbours entry`);
  }

  const skips = Array.isArray(recovery.skips) ? recovery.skips : [];
  check(skips.length >= 2, "recovery: at least two planted skips");
  for (const s of skips) {
    if (!isGapRef(s) || !isStr(s.person) || !isStr(s.role) || s.status !== "skipped_no_access" || !isStr(s.why)) { fail(`recovery: bad skip ${JSON.stringify(s)}`); continue; }
    check(roleOf(s.person) === s.role, `recovery: skip ${s.person} must hold the role ${s.role}`);
    const n = neighbours.find((x) => isObj(x) && x.responsibility === s.responsibility && x.checkKey === s.checkKey);
    check(isObj(n) && isStrArr(n.skippedNoAccess) && n.skippedNoAccess.includes(s.person), `recovery: skip ${s.person} is not in the neighbours entry of its gap`);
    // The skipped role is walled off: at least one claim on the responsibility's check is hidden from it.
    const forCheck = claims.filter((c) => c.check !== null && c.check.responsibility === s.responsibility && c.check.checkKey === s.checkKey);
    check(forCheck.some((c) => !c.roleSet.includes(s.role as RoleKey)), `recovery: skip ${s.person} needs a claim on that check hidden from ${s.role}`);
  }

  const pf = isObj(recovery.plantedFacts) ? recovery.plantedFacts : {};
  const infraPath = sources.find((s) => s.kind === "slack" && s.path.endsWith("/infra"))?.path ?? "";
  const infraMsgs = (infraPath ? readJson(path.join(ROOT, infraPath, "infra.json")) : []) as { ts: string; user: string; text: string; thread_ts?: string }[];
  const f2 = isObj(pf.F2) && isStrArr(pf.F2.parents) ? pf.F2.parents : [];
  check(f2.length === 2 && f2.every((p) => infraMsgs.some((m) => m.user === "U04ARJUN" && m.thread_ts === p && (m.text === "ok" || m.text === "saving this"))),
    "recovery F2: Arjun's 'ok' and 'saving this' must be thread replies under the listed parents");
  const f3 = isObj(pf.F3) ? pf.F3 : {};
  check(infraMsgs.some((m) => m.user === "U04ARJUN" && m.text === f3.containsText && m.thread_ts === f3.parent
    && infraMsgs.some((p) => p.ts === m.thread_ts && /NameHarbor dashboard/.test(p.text))), "recovery F3: Arjun's reply under the NameHarbor renewal message");
  const f4Commit = isObj(pf.F4) && isStr(pf.F4.commit) ? commitBySha.get(pf.F4.commit) : undefined;
  check(isObj(pf.F4) && isStr(pf.F4.containsText) && workflowText.includes(pf.F4.containsText) && /secrets\.OTA_PASSWORD/.test(workflowText)
    && f4Commit !== undefined && f4Commit.author_name === "Priya Nair" && f4Commit.message === pf.F4.commitMessage
    && f4Commit.files.some((f) => f.path === WORKFLOW_FILE) && f4Commit.date.startsWith("2026-08"),
  "recovery F4: the workflow reads OTA_PASSWORD from the repository secrets, added by Priya's August commit");

  const traces = Array.isArray(recovery.traces) ? recovery.traces : [];
  check(["workflow", "ci_runs", "commit_sequence", "calendar"].every((k) => traces.some((t) => isObj(t) && t.kind === k)), "recovery: traces must list every trace kind");
  for (const t of traces) {
    if (!isObj(t) || !isStr(t.kind) || !isStr(t.artefact) || !Array.isArray(t.serves) || !t.serves.every(isGapRef)) { fail(`recovery: bad trace ${JSON.stringify(t).slice(0, 140)}`); continue; }
    for (const q of isStrArr(t.quotedSteps) ? t.quotedSteps : []) check(workflowText.includes(q), `recovery: workflow trace quote not found verbatim: ${q}`);
    for (const p of isStrArr(t.commits) ? t.commits : []) check(commitByPrefix(p) !== undefined, `recovery: trace commit ${p} is not in commits.json`);
    if (isStr(t.unfinishedCommit)) check(/WIP|not wired/.test(commitByPrefix(t.unfinishedCommit)?.message ?? ""), "recovery: the unfinished commit must carry an open-work marker");
  }

  for (const a of [...(Array.isArray(recovery.sampleAnswers) ? recovery.sampleAnswers : []), recovery.declineSample]) {
    check(isGapRef(a) && isStr(a.person) && roleOf(a.person) !== undefined && isStr(a.text), `recovery: bad sample answer ${JSON.stringify(a).slice(0, 120)}`);
  }

  // The gap that only the run history and the workflow file answer.
  const ci = isObj(recovery.ciRuns) ? recovery.ciRuns : {};
  const gap = isObj(ci.gap) ? ci.gap : {};
  check(ci.file === rel(runsPath) && ci.workflowFile === WORKFLOW_FILE && ci.count === runs.length && ci.failures === runs.filter((r) => r.status === "failure").length,
    "recovery.ciRuns: file, workflow file, count and failures must match runs.json");
  if (!isGapRef(gap)) fail("recovery.ciRuns.gap: must name a responsibility and a check");
  else if (runs.length > 0) {
    const listed = gaps.find((g) => g.responsibility === gap.responsibility && g.checkKey === gap.checkKey);
    check(listed !== undefined && listed.coverage === "partial" && listed.blocking === false, "recovery.ciRuns.gap: must be listed in gaps as partial and non-blocking");
    check(checkDef(String(gap.responsibility), String(gap.checkKey))?.attributes.includes(String(gap.attribute)), "recovery.ciRuns.gap: attribute cannot satisfy the check");
    const lastGreen = [...runs].reverse().find((r) => r.status === "success");
    const red = lastGreen ? runs.filter((r) => r.run_number > lastGreen.run_number) : [];
    check(lastGreen !== undefined && red.length >= 3 && red.every((r) => r.status === "failure" && r.failed_step === gap.failedStep),
      "recovery.ciRuns.gap: the history must end in three or more failures at the same step");
    check(lastGreen !== undefined && gap.lastGreenRunNumber === lastGreen.run_number && gap.lastGreenRunId === lastGreen.id && gap.lastGreenSha === lastGreen.head_sha
      && gap.lastGreenStartedAt === lastGreen.started_at && isStrArr(gap.failingRunNumbers) === false && Array.isArray(gap.failingRunNumbers)
      && sameSet(gap.failingRunNumbers.map(String), red.map((r) => String(r.run_number))) && gap.firstFailingSha === red[0]?.head_sha
      && gap.latestSha === runs[runs.length - 1].head_sha, "recovery.ciRuns.gap: last green run and failing runs must match runs.json");
    // The workflow file carries the other half: the failing step comes before the build and the release.
    const order = [String(gap.failedStep), "pio run -e esp32dev", "softprops/action-gh-release@v2"].map((s) => workflowSteps.indexOf(s));
    check(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], "recovery.ciRuns.gap: the workflow must run the failing step before the build and the release");
    for (const q of isStrArr(gap.workflowQuotes) ? gap.workflowQuotes : []) check(workflowText.includes(q), `recovery.ciRuns.gap: workflow quote not found verbatim: ${q}`);
    // version.h has not changed since the last version commit, so the documented boot banner check cannot tell the builds apart.
    const versionCommits = rawCommits.filter((c) => c.files.some((f) => f.path === "firmware/src/version.h")).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const lastVersion = versionCommits[versionCommits.length - 1];
    check(lastVersion !== undefined && isStr(gap.versionCommit) && lastVersion.sha.startsWith(gap.versionCommit) && lastGreen !== undefined
      && Date.parse(lastVersion.date) < Date.parse(lastGreen.started_at), "recovery.ciRuns.gap: the last version bump must precede the last green run");
    // Nobody stated it: the failing step and the last green commit appear in no chat, note, task or document.
    const stated = [...fileRoles.keys()].filter((f) => f !== runsPath && !rel(f).endsWith(WORKFLOW_FILE) && !rel(f).endsWith("commits.json"));
    for (const needle of [...(isStrArr(gap.mustNotAppearInChat) ? gap.mustNotAppearInChat : []), String(gap.lastGreenSha).slice(0, 7)]) {
      for (const f of stated) check(!fs.readFileSync(f, "utf8").includes(needle), `recovery.ciRuns.gap: '${needle}' is stated in ${rel(f)}, so the run history is not the only answer`);
    }
    const trig = isObj(gap.trigger) ? gap.trigger : {};
    check(isStr(trig.where) && isStr(trig.containsText) && linesOf(trig.where).some((l) => l.includes(String(trig.containsText))), "recovery.ciRuns.gap: trigger message not found");
    ciGapSummary = `${String(gap.responsibility)}.${String(gap.checkKey)}: last green run ${String(gap.lastGreenRunNumber)}, ${red.length} failures at '${String(gap.failedStep)}'`;
  }
  for (const seq of Array.isArray(ci.otherSequences) ? ci.otherSequences : []) {
    check(isObj(seq) && isStr(seq.name) && isStr(seq.reading) && Array.isArray(seq.runNumbers) && seq.runNumbers.every((n) => runs.some((r) => r.run_number === n)),
      `recovery.ciRuns: bad sequence ${JSON.stringify(seq).slice(0, 100)}`);
  }
  const secretSeq = (Array.isArray(ci.otherSequences) ? ci.otherSequences : []).find((s) => isObj(s) && s.name === "secret_added");
  if (isObj(secretSeq) && Array.isArray(secretSeq.runNumbers)) {
    const seqRuns = secretSeq.runNumbers.map((n) => runs.find((r) => r.run_number === n)).filter((r): r is Run => r !== undefined);
    const lastOne = seqRuns[seqRuns.length - 1];
    check(seqRuns.length >= 2 && seqRuns.slice(0, -1).every((r) => r.status === "failure" && r.failed_step === "pio run -e esp32dev")
      && lastOne.status === "success" && lastOne.run_attempt === 2 && lastOne.head_sha === seqRuns[seqRuns.length - 2].head_sha
      && isObj(pf.F4) && lastOne.head_sha === pf.F4.commit, "recovery.ciRuns: secret_added must end in a green re-run of the F4 commit after build failures");
  } else fail("recovery.ciRuns: the secret_added sequence is missing");
}

// ---------------------------------------------------------------- Round 3: the demo finding
const finding = isObj(gtObj.finding) ? gtObj.finding : null;
if (!finding) fail("gt: finding section missing");
else if (!isGapRef(finding) || !isStr(finding.date) || !/^\d{4}-\d{2}-\d{2}$/.test(finding.date) || !isStr(finding.note) || !isStr(finding.confirmedBy)) fail("finding: needs responsibility, checkKey, date, note, confirmedBy");
else {
  const gap = gaps.find((g) => g.responsibility === finding.responsibility && g.checkKey === finding.checkKey);
  check(gap !== undefined && gap.coverage === "missing" && gap.blocking === true && finding.expectedBlockingDelta === -1,
    "finding: must close an open blocking gap that is missing today, so B moves by one");
  const when = new Date(`${finding.date}T00:00:00+05:30`);
  check(when.getTime() > TODAY.getTime(), "finding: the date must be after the demo today");
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${finding.date}T12:00:00Z`).getUTCDay()];
  check(finding.weekday === weekday && finding.note.includes(weekday), `finding: ${finding.date} is a ${weekday}; weekday and note must agree`);
  check(knownPeople.has(finding.confirmedBy) && finding.note.includes(finding.confirmedBy), "finding: confirmedBy must be a person in the record and named in the note");
  check(finding.entity === "lab-late-access" && checkDef(String(finding.responsibility), String(finding.checkKey))?.attributes.includes(String(finding.attribute)),
    "finding: entity and attribute must fit the check");
  // Only the finding knows the date: no source line states it (in any common form) next to late access or Mr. Pawar.
  // The same day may appear for an unrelated matter, such as another card's due date.
  const [y, mo, d] = finding.date.split("-");
  const monthName = Object.keys(MONTH_NUM).find((k) => MONTH_NUM[k] === mo) ?? "";
  const forms = [finding.date, `${y}${mo}${d}`, `${d}/${mo}/${y.slice(2)}`, `${d}/${mo}/${y}`, new RegExp(`\\b${Number(d)}(st|nd|rd|th)? ${monthName}`, "i"), new RegExp(`\\b${monthName}[a-z]* ${Number(d)}\\b`, "i")];
  for (const [file] of fileRoles) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!/late|pawar|lab 3/i.test(line)) continue;
      for (const f of forms) check(!(typeof f === "string" ? line.includes(f) : f.test(line)), `finding: ${rel(file)} already states the late-access date: ${line.slice(0, 90)}`);
    }
  }
  check(!claims.some((c) => c.entity === "lab-late-access" && c.check?.checkKey === finding.checkKey && c.roleSet.includes("tech_lead")),
    "finding: no claim may already answer the late-access date for the tech lead");
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
  "sensitive messages": sensitive.length,
  "decoys (incl. false positive)": decoys.length,
  "probe facts": probeFacts.length,
  "probe eval segments": `${evalCount} (${evalPos} positive)`,
  "ci runs": `${runs.length} (${runs.filter((r) => r.status === "failure").length} failed)`,
  "ci-run gap": ciGapSummary,
  finding: finding ? `${String(finding.responsibility)}.${String(finding.checkKey)} on ${String(finding.date)}` : "missing",
};
console.log(`pack ${PACK_ID} (${PACK_FILE}), demo data in ${rel(DEMO)}\n`);
for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(30)} ${String(v)}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\ncheck-demo: OK (${PACK_ID})`);
