// Validates the research-group setting pack (packs/lab.json) and its synthetic corpus (data/lab).
// Run from the repo root: pnpm tsx scripts/check-lab.ts
//
// Unlike scripts/check-demo.ts (which is written for the club data), nothing here names a role,
// an entity or a person: roles, flags, checklists, the leaver and the data folder all come from the
// pack, so the same script checks any pack:  pnpm tsx scripts/check-lab.ts --pack <id>
//
// What it proves:
//   1. the pack has the version 2 shape (spec 03, A3) and passes its loader rules;
//   2. every source file is well formed (Slack JSON, commits.json, task CSV header, ICS, notes);
//   3. every source goes through the real Tether adapters with 0 rejected rows, the planted secrets
//      and contacts are masked, and credential names survive;
//   4. canary tokens sit only in sources (and segments) whose role set the answer key allows;
//   5. every answer-key "contains" string is in its file verbatim and in a masked segment;
//   6. planted coverage per check agrees with the gaps list, for the successor and per restricted check;
//   7. the leaver footprint and the inventory (real code) give exactly the answer key's responsibilities.
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import matter from "gray-matter";
import ICAL from "ical.js";
import type { Person, Segment } from "../src/lib/types";
import { ingestAll, type IngestInput } from "../src/lib/tether/ingest";
import { readSourceFiles } from "../src/lib/tether/demo";
import { computeFootprint } from "../src/lib/tether/footprint";
import { buildInventory } from "../src/lib/lacuna/core/inventory";
import { dropFinishedFootprint } from "../src/lib/lacuna/adapt";

const ROOT = process.cwd();
const argPack = process.argv.indexOf("--pack");
const PACK_ID = argPack > 0 ? process.argv[argPack + 1] : "lab";

const ATTRS = ["owner", "status", "deadline", "location", "procedure", "access", "decision", "reason", "dependency", "contact", "risk"];
const SOURCE_KINDS = ["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics", "interview"];
const RESP_KINDS = ["deploy_operate", "external_relationship", "recurring_obligation", "open_decision", "unfinished_work"];
const TASK_HEADER = "id,title,status,owner,owner_email,due,labels,updated_at,description";
const CANARY_RE = /CANARY-[A-Z0-9]{4}/g;
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

const errors: string[] = [];
const fail = (msg: string): void => { errors.push(msg); };
const check = (cond: unknown, msg: string): void => { if (!cond) fail(msg); };

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (x: Json): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: Json): x is string => typeof x === "string" && x.length > 0;
const isStrArr = (x: Json): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v) => b.includes(v));
const subset = (a: readonly string[], b: readonly string[]): boolean => a.every((v) => b.includes(v));
const readJson = (p: string): Json => JSON.parse(fs.readFileSync(p, "utf8")) as Json;
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");
const arr = (x: Json): Json[] => (Array.isArray(x) ? x : []);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------- 1. pack
const packPath = path.join(ROOT, "packs", `${PACK_ID}.json`);
const packRaw = readJson(packPath);
if (!isObj(packRaw)) throw new Error(`${rel(packPath)} is not an object`);
const pack = packRaw;

interface Role { key: string; label: string; short?: string; approver?: boolean; successor?: boolean; leaver?: boolean; restrictedAudience?: boolean }
const roles: Role[] = [];
for (const r of arr(pack.roles)) {
  if (!isObj(r) || !isStr(r.key) || !ROLE_KEY_RE.test(r.key) || !isStr(r.label)) { fail(`pack: bad role ${JSON.stringify(r)}`); continue; }
  check(!roles.some((x) => x.key === r.key), `roles: duplicate key "${r.key}"`);
  roles.push(r as unknown as Role);
}
const ROLE_KEYS = roles.map((r) => r.key);
const isRoleSet = (x: Json): x is string[] => isStrArr(x) && x.length > 0 && x.every((r) => ROLE_KEYS.includes(r));
const flagged = (f: "approver" | "successor" | "leaver") => roles.filter((r) => r[f] === true).map((r) => r.key);
check(flagged("approver").length === 1 && flagged("successor").length === 1 && flagged("leaver").length === 1
  && new Set([...flagged("approver"), ...flagged("successor"), ...flagged("leaver")]).size === 3,
  "roles: need exactly one approver, one successor and one leaver");
const APPROVER = flagged("approver")[0] ?? "";
const SUCCESSOR = flagged("successor")[0] ?? "";
const LEAVER = flagged("leaver")[0] ?? "";
const RESTRICTED_AUDIENCE = roles.filter((r) => r.restrictedAudience === true).map((r) => r.key);
check(RESTRICTED_AUDIENCE.length >= 1 && !RESTRICTED_AUDIENCE.includes(APPROVER) && !RESTRICTED_AUDIENCE.includes(LEAVER),
  "roles: flag at least one restrictedAudience role");
const TEST_ROLES = [...new Set([SUCCESSOR, ...RESTRICTED_AUDIENCE])];
for (const [legacy, flag] of [["approverRole", APPROVER], ["successorRole", SUCCESSOR], ["leaverRole", LEAVER]] as const) {
  if (pack[legacy] !== undefined) check(pack[legacy] === flag, `${legacy} disagrees with the role flagged ${legacy.replace("Role", "")}`);
}
check(pack.id === PACK_ID && isStr(pack.name), `pack: id must be "${PACK_ID}" and name a string`);
check(isRoleSet(pack.contactsRoles), "contactsRoles: unknown role");
const leaverPerson = isObj(pack.leaverPerson) ? pack.leaverPerson : {};
check(isStr(leaverPerson.name), "pack: leaverPerson.name missing");
const LEAVER_NAME = isStr(leaverPerson.name) ? leaverPerson.name : "";
if (isObj(pack.roleHolders)) {
  for (const [k, v] of Object.entries(pack.roleHolders)) check(ROLE_KEYS.includes(k) && isStrArr(v), `roleHolders: unknown role "${k}"`);
}
if (isObj(pack.sensitivity)) {
  for (const [k, v] of Object.entries(pack.sensitivity)) check(isRoleSet(v), `sensitivity.${k}: unknown role`);
}
const ud = isObj(pack.uploadDefaults) ? pack.uploadDefaults : {};
check(isRoleSet(ud.roleSet) && (ud.roleSet as string[]).includes(APPROVER), "uploadDefaults.roleSet must include the approver");

interface Entity { key: string; label: string; aliases: string[]; partOf?: string }
const entities: Entity[] = [];
for (const e of arr(pack.entities)) {
  if (!isObj(e) || !isStr(e.key) || !isStr(e.label) || !isStrArr(e.aliases) || e.aliases.length === 0) { fail(`pack: bad entity ${JSON.stringify(e)}`); continue; }
  check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.key), `pack: entity key ${e.key} must be kebab-case`);
  check(!entities.some((x) => x.key === e.key), `pack: duplicate entity ${e.key}`);
  entities.push(e as unknown as Entity);
}
const entityKeys = new Set(entities.map((e) => e.key));
for (const e of entities) if (e.partOf !== undefined) check(entityKeys.has(e.partOf), `pack: entity ${e.key} partOf unknown ${e.partOf}`);
check(entities.length >= 12 && entities.length <= 20, `pack: expected 12-20 entities, got ${entities.length}`);

const sa = isObj(pack.sourceAuthority) ? pack.sourceAuthority : {};
check(sameSet(Object.keys(sa), ATTRS), "pack: sourceAuthority must cover exactly the 11 attributes");
for (const a of ATTRS) {
  const row = sa[a];
  if (!isObj(row)) { fail(`pack: sourceAuthority.${a} missing`); continue; }
  check(subset(SOURCE_KINDS, Object.keys(row)), `pack: sourceAuthority.${a} must cover the 7 source kinds`);
  const vals = Object.values(row);
  check(vals.every((n) => typeof n === "number" && n >= 0), `pack: sourceAuthority.${a} values must be numbers`);
  check(row.interview === Math.min(...(vals as number[])), `pack: interview must be lowest for ${a}`);
}

interface CheckDef { key: string; label: string; wTag: string; weight: number; attributes: string[]; keywords?: string[] }
const checklist = new Map<string, CheckDef[]>();
const cl = isObj(pack.checklists) ? pack.checklists : {};
check(sameSet(Object.keys(cl), RESP_KINDS), "pack: checklists must have the five kinds");
for (const kind of RESP_KINDS) {
  const list: CheckDef[] = [];
  for (const c of arr(cl[kind])) {
    if (!isObj(c) || !isStr(c.key) || !isStr(c.label) || !isStrArr(c.attributes) || c.attributes.length === 0
      || !["WHO", "WHERE", "HOW", "WHY", "WHEN"].includes(String(c.wTag)) || ![1, 3, 5].includes(Number(c.weight))) {
      fail(`pack: bad check in ${kind}: ${JSON.stringify(c)}`);
      continue;
    }
    check(subset(c.attributes, ATTRS), `pack: ${kind}.${c.key} has unknown attributes`);
    check(!list.some((x) => x.key === c.key), `pack: duplicate check ${kind}.${c.key}`);
    list.push(c as unknown as CheckDef);
  }
  check(list.length >= 4, `pack: checklist ${kind} needs at least four checks`);
  check(list.some((c) => c.weight === 5), `pack: checklist ${kind} needs a blocking check`);
  checklist.set(kind, list);
}
if (isObj(pack.kindLabels)) check(sameSet(Object.keys(pack.kindLabels), RESP_KINDS), "pack: kindLabels must name the five kinds");
if (isObj(pack.kindOverrides)) {
  for (const [k, v] of Object.entries(pack.kindOverrides)) check(RESP_KINDS.includes(String(v)), `pack: kindOverrides.${k} bad kind`);
}

const roleTemplates = isObj(pack.roleTemplates) ? pack.roleTemplates : {};
for (const [role, list] of Object.entries(roleTemplates)) {
  check(ROLE_KEYS.includes(role), `roleTemplates: unknown role "${role}"`);
  for (const t of arr(list)) {
    if (!isObj(t) || !isStr(t.key) || !isStr(t.title) || !RESP_KINDS.includes(String(t.kind)) || !isStrArr(t.entities)) { fail(`pack: bad role template ${JSON.stringify(t)}`); continue; }
    for (const e of t.entities) check(entityKeys.has(e), `roleTemplates: unknown entity "${e}"`);
  }
}
check(Array.isArray(roleTemplates[SUCCESSOR]), "pack: no role template for the successor role");

const fp = isObj(pack.footprint) ? pack.footprint : {};
check(["repeatMin", "distinctWeeksMin", "ownershipShare", "windowMonths"].every((k) => typeof fp[k] === "number"), "pack: footprint thresholds missing");

const readbackKeys: string[] = [];
for (const r of arr(pack.readback)) {
  if (!isObj(r) || !isStr(r.key) || !isStr(r.label) || !isStr(r.entity) || !isStr(r.attribute)) { fail(`pack: bad readback ${JSON.stringify(r)}`); continue; }
  check(["date", "text", "contact", "command"].includes(String(r.type)), `pack: readback ${r.key} bad type`);
  check(entityKeys.has(r.entity), `readback: unknown entity "${r.entity}"`);
  check(ATTRS.includes(r.attribute), `pack: readback ${r.key} unknown attribute`);
  readbackKeys.push(r.key);
}
check(readbackKeys.length === 5, "pack: readback must have exactly five items");

const extraction = isObj(pack.extraction) ? pack.extraction : {};
check(isObj(extraction.examples) && sameSet(Object.keys(extraction.examples), ATTRS) && Object.values(extraction.examples).every(isStr),
  "pack: extraction.examples must give one example per attribute");
check(isStr(extraction.entityHint) && isStr(extraction.contactExample), "pack: extraction.entityHint and contactExample");

const demo = isObj(pack.demo) ? pack.demo : {};
check(isStr(demo.dataDir) && isStr(demo.today) && isStr(demo.title) && isStr(demo.button) && isStr(demo.blurb), "pack: demo block needs dataDir, today, title, button, blurb");
const DATA = path.join(ROOT, isStr(demo.dataDir) ? demo.dataDir : `data/${PACK_ID}`);
if (!fs.existsSync(path.join(DATA, "sources.json"))) throw new Error("demo.dataDir not found");
const NOW = isStr(demo.today) ? demo.today : "2026-11-11T12:00:00+05:30";
const TODAY_MS = Date.parse(NOW);
check(isStrArr(pack.forbiddenInCore) && pack.forbiddenInCore.length > 0, "pack: forbiddenInCore missing");

// ---------------------------------------------------------------- 2. raw source files
interface SourceEntry { kind: string; name: string; path: string; roleSet: string[] }
const sources: SourceEntry[] = [];
for (const s of arr(readJson(path.join(DATA, "sources.json")))) {
  if (!isObj(s) || !SOURCE_KINDS.includes(String(s.kind)) || !isStr(s.name) || !isStr(s.path) || !isRoleSet(s.roleSet)) { fail(`sources.json: bad entry ${JSON.stringify(s)}`); continue; }
  if (!fs.existsSync(path.join(ROOT, s.path))) { fail(`sources.json: path not found ${s.path}`); continue; }
  check(s.roleSet.includes(APPROVER) && s.roleSet.includes(LEAVER), `sources.json: ${s.name} must be visible to the approver and the leaver`);
  sources.push(s as unknown as SourceEntry);
}

const fileRoles = new Map<string, string[]>(); // effective role set per file (notes may narrow)
const counts: Record<string, number | string> = {};
const openCards: string[] = [];
const isRestrictedSet = (rs: string[]) => !TEST_ROLES.some((r) => rs.includes(r)); // hidden from every tested role

for (const s of sources) {
  const abs = path.join(ROOT, s.path);
  const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
  for (const f of files) fileRoles.set(f, s.roleSet);

  if (s.kind === "slack") {
    const usersPath = path.join(abs, "users.json");
    const users = fs.existsSync(usersPath) ? readJson(usersPath) : null;
    const ids = new Set<string>();
    if (!Array.isArray(users)) fail(`slack ${s.path}: users.json missing or not an array`);
    else for (const u of users) {
      if (!isObj(u) || !isStr(u.id) || !isStr(u.real_name) || !isObj(u.profile) || !isStr(u.profile.email)) { fail(`slack ${s.path}: bad user ${JSON.stringify(u)}`); continue; }
      ids.add(u.id);
    }
    const channels = fs.readdirSync(abs).filter((f) => f.endsWith(".json") && f !== "users.json");
    check(channels.length > 0, `slack ${s.path}: no channel file`);
    for (const ch of channels) {
      const msgs = readJson(path.join(abs, ch));
      if (!Array.isArray(msgs)) { fail(`slack ${s.path}/${ch}: not an array`); continue; }
      const seen = new Set<string>();
      for (const m of msgs) {
        if (!isObj(m) || !isStr(m.ts) || !/^\d{10}\.\d{6}$/.test(m.ts) || !isStr(m.user) || typeof m.text !== "string") { fail(`slack ${s.path}/${ch}: bad message ${JSON.stringify(m)}`); continue; }
        check(ids.has(m.user), `slack ${s.path}/${ch}: unknown user ${m.user}`);
        if (m.thread_ts !== undefined) check(isStr(m.thread_ts) && seen.has(m.thread_ts), `slack ${s.path}/${ch}: thread_ts ${String(m.thread_ts)} has no earlier parent`);
        check(!seen.has(m.ts), `slack ${s.path}/${ch}: duplicate ts ${m.ts}`);
        seen.add(m.ts);
        // A channel hidden from every tested role: each message carries a canary token.
        if (isRestrictedSet(s.roleSet)) check(new RegExp(CANARY_RE.source).test(m.text), `slack ${s.path}/${ch}: restricted message without canary: ${m.text}`);
      }
      counts[`raw slack #${path.basename(ch, ".json")} messages`] = msgs.length;
    }
  }

  if (s.kind === "github") {
    const raw = readJson(path.join(abs, "commits.json"));
    const shas = new Set<string>();
    if (!Array.isArray(raw)) fail("github: commits.json not an array");
    else for (const c of raw) {
      if (!isObj(c) || !isStr(c.sha) || !/^[0-9a-f]{40}$/.test(c.sha) || !isStr(c.author_name) || !isStr(c.author_email)
        || !isStr(c.date) || Number.isNaN(Date.parse(c.date)) || !isStr(c.message) || !Array.isArray(c.files)) { fail(`github: bad commit ${JSON.stringify(c)}`); continue; }
      check(!shas.has(c.sha), `github: duplicate sha ${c.sha}`);
      shas.add(c.sha);
      for (const f of c.files) check(isObj(f) && isStr(f.path) && ["added", "modified", "removed", "renamed"].includes(String(f.status)), `github: bad file entry in ${c.sha}`);
    }
    check(fs.existsSync(path.join(abs, "files")) && walk(path.join(abs, "files")).length > 0, "github: files/ is empty");
    counts["raw github commits"] = shas.size;
    counts["raw github files"] = walk(path.join(abs, "files")).length;
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
      check(/^T-\d{3}$/.test(id) && !taskIds.has(id), `tasks: bad or duplicate id ${id}`);
      taskIds.add(id);
      check(title !== "" && status !== "", `tasks: ${id} needs title and status`);
      check(due === "" || /^\d{4}-\d{2}-\d{2}$/.test(due), `tasks: ${id} bad due ${due}`);
      check(!Number.isNaN(Date.parse(updatedAt)), `tasks: ${id} bad updated_at`);
      if (status !== "Done" || TODAY_MS - Date.parse(updatedAt) <= 30 * 86_400_000) openCards.push(id);
    });
    counts["raw task rows"] = rows.length;
  }

  if (s.kind === "markdown") {
    const notes = files.filter((f) => f.endsWith(".md"));
    for (const f of notes) {
      const fm = matter(fs.readFileSync(f, "utf8"));
      const data = fm.data as Record<string, unknown>;
      check(isStr(data.title) && data.date !== undefined && isStr(data.author) && isStr(data.author_email), `notes: ${rel(f)} front matter needs title, date, author, author_email`);
      if (data.roles !== undefined) {
        const narrowed = String(data.roles).split(",").map((r) => r.trim()).filter((r) => r !== "");
        if (!isRoleSet(narrowed) || !subset(narrowed, s.roleSet)) fail(`notes: ${rel(f)} bad roles ${String(data.roles)}`);
        else {
          fileRoles.set(f, narrowed);
          if (isRestrictedSet(narrowed)) {
            for (const sec of fm.content.split(/^(?=#{1,6} )/m).filter((x) => x.trim() !== "")) {
              check(new RegExp(CANARY_RE.source).test(sec), `notes: ${rel(f)} restricted section without canary: ${sec.split("\n")[0]}`);
            }
          }
        }
      }
    }
    counts["raw notes"] = notes.length;
  }

  if (s.kind === "ics") {
    const icsText = fs.readFileSync(abs, "utf8");
    check(/^BEGIN:VCALENDAR\r?\n/.test(icsText) && /END:VCALENDAR\s*$/.test(icsText), "ics: VCALENDAR wrapper");
    try {
      const cal = new ICAL.Component(ICAL.parse(icsText));
      const evs = cal.getAllSubcomponents("vevent");
      for (const e of evs) check(e.getFirstPropertyValue("uid") && e.getFirstPropertyValue("dtstart") && e.getFirstPropertyValue("summary"), "ics: VEVENT needs UID, DTSTART, SUMMARY");
      check(evs.some((e) => e.getFirstPropertyValue("rrule")), "ics: at least one recurring event");
      counts["raw ics events"] = evs.length;
    } catch (e) {
      fail(`ics: does not parse: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- 3. real adapters
const inputs: IngestInput[] = sources.map((s, i) => ({
  kind: s.kind as IngestInput["kind"], name: s.name, roleSet: s.roleSet as IngestInput["roleSet"],
  files: readSourceFiles(path.join(ROOT, s.path)), sourceId: `${PACK_ID}-${i + 1}`,
}));
const ingest = ingestAll(inputs, { identityKey: "check-identity-key", contactsKey: "check-contacts-key", now: NOW });
const segments: Segment[] = ingest.sources.flatMap((s) => s.result.segments);
const people: Person[] = ingest.people;
let totalRejected = 0;
let totalSecrets = 0;
let totalContacts = 0;
console.log("source".padEnd(48), "segments rejected maskedSecrets maskedContacts");
for (const s of ingest.sources) {
  const r = s.result;
  totalRejected += r.rejected.length;
  totalSecrets += r.maskedSecrets;
  totalContacts += r.maskedContacts;
  console.log(s.name.padEnd(48), String(r.segments.length).padStart(8), String(r.rejected.length).padStart(8), String(r.maskedSecrets).padStart(13), String(r.maskedContacts).padStart(14));
  check(r.segments.length > 0, `adapters: ${s.name} produced no segments`);
  for (const rej of r.rejected) fail(`adapters: ${s.name} rejected line ${rej.line}: ${rej.reason}`);
}
console.log("total".padEnd(48), String(segments.length).padStart(8), String(totalRejected).padStart(8), String(totalSecrets).padStart(13), String(totalContacts).padStart(14), "\n");
check(segments.length >= 150 && segments.length <= 200, `adapters: expected 150-200 segments, got ${segments.length}`);
check(new Set(segments.map((s) => s.id)).size === segments.length, "adapters: duplicate segment ids");
const allText = segments.map((s) => `${s.text}\n${JSON.stringify(s.meta)}`).join("\n")
  + "\n" + people.map((p) => `${p.displayName} ${p.aliases.join(" ")}`).join("\n");

// ---------------------------------------------------------------- 4. answer key: canaries, secrets
const gtRaw = readJson(path.join(DATA, "ground_truth.json"));
const gt: Obj = isObj(gtRaw) ? gtRaw : {};
if (!isObj(gtRaw)) fail("ground_truth.json is not an object");

const tokens = new Map<string, { roleSet: string[]; where: string }>();
for (const t of arr(gt.restricted)) {
  if (!isObj(t) || !isStr(t.token) || !isRoleSet(t.roleSet) || !isStr(t.where)) { fail(`gt: bad restricted ${JSON.stringify(t)}`); continue; }
  tokens.set(t.token, { roleSet: t.roleSet, where: t.where });
}
const tokenSeen = new Set<string>();
for (const [file, fRoles] of fileRoles) {
  for (const tok of fs.readFileSync(file, "utf8").match(CANARY_RE) ?? []) {
    const t = tokens.get(tok);
    if (!t) { fail(`canary: ${tok} in ${rel(file)} is not listed in ground_truth.restricted`); continue; }
    check(subset(fRoles, t.roleSet), `canary: ${tok} appears in ${rel(file)} visible to [${fRoles.join(", ")}], wider than [${t.roleSet.join(", ")}]`);
    if (rel(file) === t.where) tokenSeen.add(tok);
  }
}
for (const tok of tokens.keys()) check(tokenSeen.has(tok), `canary: ${tok} not found in its 'where' file`);
// the same rule on what the adapters actually produced
for (const seg of segments) {
  for (const tok of `${seg.text} ${JSON.stringify(seg.meta)}`.match(CANARY_RE) ?? []) {
    const t = tokens.get(tok);
    check(t && subset(seg.roleSet, t.roleSet), `canary: ${tok} in segment ${seg.id} (${seg.thread}) visible to [${seg.roleSet.join(", ")}]`);
  }
}
const SKIP_NON_SOURCE = ["ground_truth.json", "sources.json", "model_cache.json", "EVAL_NOTES.md"];
for (const f of walk(DATA)) {
  const name = rel(f);
  if (fileRoles.has(f) || SKIP_NON_SOURCE.some((x) => name.endsWith(x))) continue;
  check(!new RegExp(CANARY_RE.source).test(fs.readFileSync(f, "utf8")), `canary: token in a file that is not a source: ${name}`);
}
// tokens of this pack must not appear in any other pack's data
for (const other of fs.readdirSync(path.join(ROOT, "data"), { withFileTypes: true })) {
  if (!other.isDirectory() || path.join(ROOT, "data", other.name) === DATA) continue;
  for (const f of walk(path.join(ROOT, "data", other.name))) {
    const text = fs.readFileSync(f, "utf8");
    for (const tok of tokens.keys()) check(!text.includes(tok), `canary: ${tok} also appears in ${rel(f)}`);
  }
}

const secrets = arr(gt.secrets);
for (const s of secrets) {
  if (!isObj(s) || !isStr(s.where) || !isStr(s.type) || !isStr(s.value)) { fail(`gt: bad secret ${JSON.stringify(s)}`); continue; }
  const file = path.join(ROOT, s.where);
  check(fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(s.value), `secrets: ${s.type} value not found in ${s.where}`);
  check(!allText.includes(s.value), `secrets: planted ${s.type} survives masking (${s.value.slice(0, 6)}...)`);
  // push protection: planted values must not have the exact shape of a real provider key
  check(!/^gh[pousr]_[A-Za-z0-9]{36}$/.test(s.value) && !/^xox[baprs]-\d+-\d+-[A-Za-z0-9]+$/.test(s.value) && !/^sk-[A-Za-z0-9]{48}$/.test(s.value),
    `secrets: ${s.type} value has the exact format of a real provider key; use an obviously fake one`);
}
const plantedSecretCount = secrets.filter((s) => isObj(s) && !String(s.type).startsWith("contact_")).length;
const plantedContactCount = secrets.length - plantedSecretCount;
check(totalSecrets >= plantedSecretCount, `masking: ${totalSecrets} secrets masked, ${plantedSecretCount} planted`);
check(totalContacts >= plantedContactCount, `masking: ${totalContacts} contacts masked, ${plantedContactCount} planted`);
for (const name of arr(gt.keptCredentialNames)) check(isStr(name) && allText.includes(name), `masking: credential name ${String(name)} did not survive`);

// ---------------------------------------------------------------- 5. answer key: responsibilities, claims
interface GtResp { key: string; title: string; kind: string; origin: string; entities: string[]; dueDate: string | null }
const gtResps: GtResp[] = [];
for (const r of arr(gt.responsibilities)) {
  if (!isObj(r) || !isStr(r.key) || !isStr(r.title) || !RESP_KINDS.includes(String(r.kind))
    || !["task_board", "footprint", "role_template"].includes(String(r.origin)) || !isStr(r.originDetail) || !isStrArr(r.entities)) { fail(`gt: bad responsibility ${JSON.stringify(r)}`); continue; }
  check(r.dueDate === null || (typeof r.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate)), `gt: ${r.key} bad dueDate`);
  for (const e of r.entities) check(entityKeys.has(e), `gt: ${r.key} unknown entity ${e}`);
  gtResps.push(r as unknown as GtResp);
}
check(gtResps.length === 10, `gt: expected 10 responsibilities, got ${gtResps.length}`);
const respByKey = new Map(gtResps.map((r) => [r.key, r]));
const checkDef = (resp: string, key: string) => checklist.get(respByKey.get(resp)?.kind ?? "")?.find((c) => c.key === key);

interface GtClaim { id: string; entity: string; attribute: string; value: string; roleSet: string[]; state: string; kind: string; check: { responsibility: string; checkKey: string } | null }
const claims: GtClaim[] = [];
for (const c of arr(gt.claims)) {
  if (!isObj(c) || !isStr(c.id) || !isStr(c.entity) || !isStr(c.attribute) || !isStr(c.value) || !isStrArr(c.keywords) || !isObj(c.source) || !isRoleSet(c.roleSet)) { fail(`gt: bad claim ${JSON.stringify(c)}`); continue; }
  const src = c.source;
  check(!claims.some((x) => x.id === c.id), `gt: duplicate claim id ${c.id}`);
  check(entityKeys.has(c.entity), `gt: ${c.id} unknown entity ${c.entity}`);
  check(ATTRS.includes(c.attribute), `gt: ${c.id} unknown attribute ${c.attribute}`);
  check(c.keywords.length > 0 && c.keywords.every((k) => k === k.toLowerCase()), `gt: ${c.id} keywords must be lowercase`);
  check(SOURCE_KINDS.includes(String(src.kind)), `gt: ${c.id} bad source kind`);
  const file = isStr(src.path) ? path.join(ROOT, src.path) : "";
  if (!file || !fs.existsSync(file)) { fail(`gt: ${c.id} source file missing ${String(src.path)}`); continue; }
  const fileText = fs.readFileSync(file, "utf8");
  check(isStr(src.contains) && fileText.includes(src.contains), `gt: ${c.id} contains not found verbatim in ${String(src.path)}`);
  const fRoles = fileRoles.get(file);
  check(fRoles !== undefined && sameSet(fRoles, c.roleSet), `gt: ${c.id} roleSet does not match its source file`);
  // the planted sentence must also survive the adapters: one masked segment of that source kind,
  // with exactly the claim's role set, holds it (segmentContains overrides for composed task text)
  const needle = isStr(src.segmentContains) ? src.segmentContains : String(src.contains);
  const claimRoles: string[] = c.roleSet;
  const hit = segments.find((sg) => sg.sourceKind === src.kind && sg.text.includes(needle) && sameSet(sg.roleSet, claimRoles));
  check(hit, `gt: ${c.id} planted text not found in any masked ${String(src.kind)} segment: "${needle.slice(0, 60)}"`);
  let chk: GtClaim["check"] = null;
  if (c.check !== null) {
    const def = isObj(c.check) && isStr(c.check.responsibility) && isStr(c.check.checkKey) ? checkDef(c.check.responsibility, c.check.checkKey) : undefined;
    if (!def || !isObj(c.check)) fail(`gt: ${c.id} bad check ${JSON.stringify(c.check)}`);
    else {
      chk = { responsibility: String(c.check.responsibility), checkKey: String(c.check.checkKey) };
      check(def.attributes.includes(c.attribute), `gt: ${c.id} attribute ${c.attribute} cannot satisfy ${chk.responsibility}.${chk.checkKey}`);
      // a WHO check is answered only by a person (owner or contact); see toLacunaPack
      if (def.wTag === "WHO") check(["owner", "contact"].includes(c.attribute), `gt: ${c.id} a WHO check needs an owner or contact claim`);
      check(respByKey.get(chk.responsibility)?.entities.includes(c.entity), `gt: ${c.id} entity ${c.entity} is not an entity of ${chk.responsibility}`);
      if (def.keywords?.length) check(def.keywords.some((k) => `${c.value} ${String(src.contains)}`.toLowerCase().includes(k.toLowerCase())), `gt: ${c.id} mentions none of the keywords of ${chk.checkKey}`);
    }
  }
  check(["active", "superseded", "conflicting"].includes(String(c.state)), `gt: ${c.id} bad state`);
  claims.push({ id: c.id, entity: c.entity, attribute: c.attribute, value: c.value, roleSet: c.roleSet, state: String(c.state), kind: String(src.kind), check: chk });
}
check(claims.length >= 60 && claims.length <= 85, `gt: expected 60-85 claims, got ${claims.length}`);
const claimById = new Map(claims.map((c) => [c.id, c]));
for (const r of gtResps) {
  const n = claims.filter((c) => r.entities.includes(c.entity)).length;
  check(n >= 4 && n <= 10, `gt: ${r.key} has ${n} planted claims (want 4 to 10)`);
}
check(claims.filter((c) => c.kind === "github").length >= 6, "gt: at least six claims from repository files");

// ---------------------------------------------------------------- 6. planted coverage against the gaps list
const gaps = arr(gt.gaps).filter(isObj);
let blocking = 0;
for (const r of gtResps) {
  for (const def of checklist.get(r.kind) ?? []) {
    const gap = gaps.find((g) => g.responsibility === r.key && g.checkKey === def.key);
    const forCheck = claims.filter((c) => c.check?.responsibility === r.key && c.check.checkKey === def.key);
    const visible = forCheck.filter((c) => c.roleSet.includes(SUCCESSOR));
    const visibleActive = visible.filter((c) => c.state === "active");
    if (!gap) {
      check(visibleActive.length > 0, `coverage: ${r.key}.${def.key} has no gap but no active claim visible to ${SUCCESSOR}`);
      continue;
    }
    const cov = String(gap.coverage);
    check(gap.blocking === (def.weight === 5), `gaps: ${r.key}.${def.key} blocking flag must match weight`);
    if (def.weight === 5) blocking++;
    if (cov === "restricted") check(visible.length === 0 && forCheck.length > 0, `coverage: ${r.key}.${def.key} restricted needs evidence only for other roles`);
    else if (cov === "missing") check(forCheck.length === 0, `coverage: ${r.key}.${def.key} marked missing but has planted claims`);
    else if (cov === "conflicting") check(visible.filter((c) => c.state === "conflicting").length >= 2, `coverage: ${r.key}.${def.key} conflicting needs two visible conflicting claims`);
    else if (cov === "partial") check(visibleActive.length > 0, `coverage: ${r.key}.${def.key} partial needs some visible evidence`);
    else fail(`gaps: ${r.key}.${def.key} bad coverage ${cov}`);
  }
}
for (const g of gaps) check(checkDef(String(g.responsibility), String(g.checkKey)) && isStr(g.why), `gaps: bad gap ${JSON.stringify(g)}`);
const expectedBlocking = gt.expectedSuccessorBlockingGaps;
check(blocking === expectedBlocking, `gaps: ${blocking} blocking gaps but expectedSuccessorBlockingGaps = ${String(expectedBlocking)}`);

const restrictedChecks = arr(gt.restrictedChecks);
for (const r of restrictedChecks) {
  if (!isObj(r) || !checkDef(String(r.responsibility), String(r.checkKey)) || !isRoleSet(r.visibleTo)) { fail(`gt: bad restrictedCheck ${JSON.stringify(r)}`); continue; }
  const forCheck = claims.filter((c) => c.check?.responsibility === r.responsibility && c.check?.checkKey === r.checkKey);
  check(forCheck.length > 0, `restrictedChecks: ${String(r.responsibility)}.${String(r.checkKey)} has no planted claim`);
  for (const role of ROLE_KEYS.filter((k) => !(r.visibleTo as string[]).includes(k))) {
    check(!forCheck.some((c) => c.roleSet.includes(role)), `restrictedChecks: ${String(r.responsibility)}.${String(r.checkKey)} is visible to ${role}`);
  }
  check(TEST_ROLES.some((t) => !(r.visibleTo as string[]).includes(t)), `restrictedChecks: ${String(r.responsibility)}.${String(r.checkKey)} is visible to every tested role`);
}

const sup = arr(gt.supersessions);
for (const s of sup) {
  if (!isObj(s) || !entityKeys.has(String(s.entity)) || !ATTRS.includes(String(s.attribute)) || !(s.rule === 1 || s.rule === 2) || !isObj(s.claims)) { fail(`gt: bad supersession ${JSON.stringify(s)}`); continue; }
  const olds = isStrArr(s.claims.old) ? s.claims.old : [];
  const news = isStrArr(s.claims.new) ? s.claims.new : [];
  check(olds.length > 0 && olds.every((id) => claimById.get(id)?.state === "superseded" && claimById.get(id)?.entity === s.entity && claimById.get(id)?.attribute === s.attribute), `gt: supersession ${String(s.entity)} old claims must be superseded claims of that entity and attribute`);
  check(news.length > 0 && news.every((id) => claimById.get(id)?.state === "active" && claimById.get(id)?.entity === s.entity), `gt: supersession ${String(s.entity)} new claims must be active`);
}
check(claims.filter((c) => c.state === "superseded").every((c) => sup.some((s) => isObj(s) && isObj(s.claims) && isStrArr(s.claims.old) && s.claims.old.includes(c.id))), "gt: every superseded claim belongs to a supersession");
const conf = arr(gt.conflicts);
for (const c of conf) {
  if (!isObj(c) || !isStrArr(c.values) || c.values.length < 2 || !isStrArr(c.claims)) { fail(`gt: bad conflict ${JSON.stringify(c)}`); continue; }
  check(c.claims.length >= 2 && c.claims.every((id) => claimById.get(id)?.state === "conflicting" && claimById.get(id)?.entity === c.entity), `gt: conflict ${String(c.entity)} claims must be conflicting claims of that entity`);
}
check(claims.filter((c) => c.state === "conflicting").every((c) => conf.some((x) => isObj(x) && isStrArr(x.claims) && x.claims.includes(c.id))), "gt: every conflicting claim belongs to a conflict");

const corroborated = arr(gt.corroborated);
for (const group of corroborated) {
  const cs = isStrArr(group) ? group.map((id) => claimById.get(id)) : [];
  check(cs.length >= 2 && cs.every(Boolean) && new Set(cs.map((c) => c?.kind)).size >= 2 && new Set(cs.map((c) => `${c?.entity}|${c?.attribute}`)).size === 1,
    `gt: corroborated group ${JSON.stringify(group)} must be one fact from two source kinds`);
}
check(corroborated.length >= 12, `gt: at least 12 corroborated facts, got ${corroborated.length}`);

const rbGt = arr(gt.readback).filter(isObj);
check(sameSet(rbGt.map((r) => String(r.key)), readbackKeys), "gt: readback keys must match the pack");
for (const r of rbGt) {
  const def = arr(pack.readback).filter(isObj).find((x) => x.key === r.key);
  const ids = isStrArr(r.claims) ? r.claims : [];
  check(isStr(r.expected), `gt: readback ${String(r.key)} needs expected`);
  check(ids.some((id) => claimById.get(id)?.roleSet.includes(SUCCESSOR) && claimById.get(id)?.state === "active"), `gt: readback ${String(r.key)} must be backed by an active claim visible to ${SUCCESSOR}`);
  check(ids.every((id) => claimById.get(id)?.entity === def?.entity && claimById.get(id)?.attribute === def?.attribute), `gt: readback ${String(r.key)} claims must be on ${String(def?.entity)}.${String(def?.attribute)}`);
}
for (const o of arr(gt.offBoard)) check(isObj(o) && respByKey.has(String(o.responsibility)) && isStr(o.rule) && isStr(o.evidence), `gt: bad offBoard ${JSON.stringify(o)}`);
for (const p of arr(gt.sensitivityPlaceholders)) {
  if (!isObj(p) || !isStr(p.where) || !isStr(p.contains)) { fail(`gt: bad sensitivityPlaceholder ${JSON.stringify(p)}`); continue; }
  const text = fs.readFileSync(path.join(ROOT, p.where), "utf8");
  check(text.includes(p.contains), `gt: sensitivity placeholder not found in ${p.where}`);
}
for (const key of ["firstWeeks", "demoAnswer"]) check(isObj(gt[key]), `gt: ${key} missing`);
const fw = isObj(gt.firstWeeks) && isObj(gt.firstWeeks.example) ? gt.firstWeeks.example : {};
check(gaps.some((g) => g.responsibility === fw.responsibility && g.checkKey === fw.checkKey) && isStr(fw.note) && /^\d{4}-\d{2}-\d{2}$/.test(String(fw.date)), "gt: firstWeeks.example must close a listed gap and carry a date and a note");
const da = isObj(gt.demoAnswer) ? gt.demoAnswer : {};
check(gaps.some((g) => g.responsibility === da.responsibility && g.checkKey === da.checkKey) && isStr(da.text), "gt: demoAnswer must answer a listed gap");

// ---------------------------------------------------------------- 7. footprint and inventory (real code)
const words = (s: string) => s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const leaverWord = words(LEAVER_NAME)[0] ?? "";
const leaverIds = people.filter((p) => [p.displayName, ...p.aliases].some((x) => words(x).includes(leaverWord))).map((p) => p.id);
check(leaverIds.length > 0, `footprint: no person record matches leaverPerson.name "${LEAVER_NAME}"`);
const thresholds = fp as unknown as Parameters<typeof computeFootprint>[3];
const rawFootprint = computeFootprint(segments, people, leaverIds, thresholds, entities, { now: NOW });
const tasks = segments.filter((s) => s.kind === "task").map((t) => ({ ...t, meta: { ...t.meta, id: t.meta.id ?? t.meta.taskId, updated_at: t.meta.updated_at ?? t.meta.updatedAt } }));
type LPack = Parameters<typeof dropFinishedFootprint>[3];
const lpack = { entities, checklists: Object.fromEntries(checklist), roleTemplates, footprint: fp, kindOverrides: pack.kindOverrides } as unknown as LPack;
const segById = new Map(segments.map((s) => [s.id, s]));
const { kept, dropped } = dropFinishedFootprint(rawFootprint, tasks, segById, lpack, NOW);
const inventory = buildInventory({
  workspaceId: "check", tasks, footprint: kept, pack: lpack, successorRole: SUCCESSOR as Parameters<typeof buildInventory>[0]["successorRole"], today: NOW,
});
// same due-date fill as src/lib/lacuna/index.ts: the next occurrence of a schedule everyone can see
for (const item of inventory) {
  if (item.dueDate) continue;
  const next = kept
    .filter((c) => c.rule === "schedule" && item.entities.includes(c.entityKey))
    .flatMap((c) => c.evidenceSegmentIds).map((id) => segById.get(id))
    .filter((sg): sg is Segment => !!sg && sg.kind === "event" && ROLE_KEYS.every((r) => (sg.roleSet as string[]).includes(r)))
    .flatMap((sg) => [...((sg.meta.occurrences as string[] | undefined) ?? []), String(sg.meta.start ?? "")])
    .map((d) => d.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= NOW.slice(0, 10)).sort()[0];
  if (next) item.dueDate = next;
}

console.log("footprint candidates kept:");
for (const c of kept) console.log(`  ${c.rule.padEnd(13)} ${c.entityKey.padEnd(20)} ${c.detail.slice(0, 110)}`);
console.log("footprint candidates dropped:");
for (const d of dropped) console.log(`  ${d.entityKey.padEnd(20)} ${d.reason}`);
console.log("inventory:");
for (const r of inventory) console.log(`  ${r.key} ${r.kind.padEnd(22)} ${r.origin.padEnd(13)} ${String(r.dueDate).padEnd(10)} ${r.title} [${r.entities.join(", ")}]`);
console.log("");

const respEntities = new Set(gtResps.flatMap((r) => r.entities));
for (const c of kept) check(respEntities.has(c.entityKey), `footprint: candidate ${c.rule} on "${c.entityKey}" is not an entity of any planted responsibility (${c.detail.slice(0, 80)})`);
for (const n of arr(gt.footprintNoise)) {
  if (!isObj(n) || !isStr(n.entity) || !isStr(n.why)) { fail(`gt: bad footprintNoise ${JSON.stringify(n)}`); continue; }
  if (/expected dropped/i.test(n.why)) check(dropped.some((d) => d.entityKey === n.entity), `footprint: noise on ${n.entity} was expected to be dropped as finished work`);
}
check(inventory.length === gtResps.length, `inventory: ${inventory.length} responsibilities, the answer key has ${gtResps.length}`);
for (const r of gtResps) {
  const got = inventory.find((x) => x.key === r.key);
  if (!got) { fail(`inventory: ${r.key} missing`); continue; }
  check(got.title === r.title, `inventory: ${r.key} title "${got.title}" != "${r.title}"`);
  check(got.kind === r.kind, `inventory: ${r.key} kind ${got.kind} != ${r.kind}`);
  check(sameSet(got.entities, r.entities), `inventory: ${r.key} entities [${got.entities.join(", ")}] != [${r.entities.join(", ")}]`);
  check(got.origin === r.origin, `inventory: ${r.key} origin ${got.origin} != ${r.origin}`);
  check(got.dueDate === r.dueDate, `inventory: ${r.key} dueDate ${String(got.dueDate)} != ${String(r.dueDate)}`);
}
// open or recently active cards are exactly the task-board responsibilities
check(openCards.length === gtResps.filter((r) => r.origin === "task_board").length, `tasks: ${openCards.length} open or recently active cards (${openCards.join(", ")}) but ${gtResps.filter((r) => r.origin === "task_board").length} task-board responsibilities`);
// each off-board duty is found by the rule the answer key names
const RULE_OF: Record<string, string> = { ownership_share: "ownership", sole_external_contact: "sole_contact", schedule: "schedule", repeat: "repeat" };
for (const o of arr(gt.offBoard)) {
  if (!isObj(o)) continue;
  const r = respByKey.get(String(o.responsibility));
  const rule = RULE_OF[String(o.rule)];
  if (!r) continue;
  if (rule) check(kept.some((c) => c.rule === rule && r.entities.includes(c.entityKey)), `footprint: ${r.key} expected rule ${rule} did not fire`);
  else check(!kept.some((c) => r.entities.includes(c.entityKey)), `footprint: ${r.key} is listed as ${String(o.rule)} only but the footprint also found it`);
}

// ---------------------------------------------------------------- report
const summary: Record<string, string | number> = {
  ...counts,
  "segments (adapters)": segments.length,
  "rejected rows": totalRejected,
  "masked secrets": totalSecrets,
  "masked contacts": totalContacts,
  "gt claims": claims.length,
  "gt claims active/superseded/conflicting": ["active", "superseded", "conflicting"].map((s) => claims.filter((c) => c.state === s).length).join(" / "),
  "gt gaps": gaps.length,
  [`gt blocking gaps (${SUCCESSOR})`]: blocking,
  "gt restricted checks": restrictedChecks.length,
  "gt supersessions": sup.length,
  "gt conflicts": conf.length,
  "gt corroborated facts": corroborated.length,
  "canary tokens": tokens.size,
  "planted secrets + contacts": `${plantedSecretCount} + ${plantedContactCount}`,
  "responsibilities (inventory)": inventory.length,
};
for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(44)} ${String(v)}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\ncheck-lab (${PACK_ID}): OK`);
