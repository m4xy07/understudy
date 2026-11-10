// Validates the demo setting pack and the synthetic robotics-club dataset.
// Run from the repo root: pnpm tsx scripts/check-demo.ts
// Contract: docs/ARCHITECTURE.md sections 1a, 2, 4 and 7a.
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import matter from "gray-matter";
import type { Attribute, RoleKey, SourceKind } from "../src/lib/types";

const ROOT = process.cwd();
const DEMO = path.join(ROOT, "data", "demo");
const TODAY = new Date("2026-11-11T00:00:00+05:30");

const ROLE_KEYS: readonly RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
const ATTRS: readonly Attribute[] = [
  "owner", "status", "deadline", "location", "procedure", "access",
  "decision", "reason", "dependency", "contact", "risk",
];
const KINDS: readonly SourceKind[] = ["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics", "interview"];
const RESP_KINDS = ["deploy_operate", "external_relationship", "recurring_obligation", "open_decision", "unfinished_work"] as const;
type RespKind = (typeof RESP_KINDS)[number];
const TASK_HEADER = "id,title,status,owner,owner_email,due,labels,updated_at,description";
const CANARY_RE = /CANARY-[A-Z0-9]{4}/g;

// Section 4 of ARCHITECTURE.md: [key, wTag, weight]
const EXPECTED_CHECKS: Record<RespKind, [string, string, number][]> = {
  deploy_operate: [["access_path", "WHERE", 3], ["steps", "HOW", 3], ["how_to_verify", "HOW", 3], ["rollback", "HOW", 5], ["credential_owner", "WHO", 5]],
  external_relationship: [["contact_person", "WHO", 5], ["last_interaction", "WHEN", 1], ["open_commitments", "WHY", 3], ["next_date", "WHEN", 3]],
  recurring_obligation: [["cadence", "WHEN", 3], ["next_due_date", "WHEN", 5], ["how_to_do_it", "HOW", 3], ["consequence_if_missed", "WHY", 1]],
  open_decision: [["current_state", "WHERE", 3], ["options_considered", "WHY", 1], ["owner", "WHO", 5], ["deadline", "WHEN", 3]],
  unfinished_work: [["where_it_lives", "WHERE", 3], ["last_state", "WHERE", 3], ["next_concrete_step", "HOW", 5], ["who_reviews_it", "WHO", 1]],
};

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
const pack = readJson(path.join(ROOT, "packs", "club.json"));
const entityKeys = new Set<string>();
const checklist = new Map<RespKind, { key: string; weight: number; attributes: string[] }[]>();
const readbackKeys: string[] = [];

if (!isObj(pack)) {
  fail("packs/club.json is not an object");
} else {
  check(pack.id === "club" && isStr(pack.name), "pack: id must be 'club' and name a string");
  const labels: Record<RoleKey, string> = {
    president: "Club President", tech_lead: "Incoming tech lead", new_member: "New member",
    treasurer: "Treasurer", leaver: "Priya (outgoing tech lead)",
  };
  const roles = Array.isArray(pack.roles) ? pack.roles : [];
  check(roles.length === 5, "pack: exactly five roles");
  for (const r of roles) {
    if (!isObj(r) || !isStr(r.key) || !(ROLE_KEYS as readonly string[]).includes(r.key)) {
      fail(`pack: bad role ${JSON.stringify(r)}`);
      continue;
    }
    check(r.label === labels[r.key as RoleKey], `pack: role ${r.key} label must be "${labels[r.key as RoleKey]}"`);
  }
  check(pack.approverRole === "president" && pack.successorRole === "tech_lead" && pack.leaverRole === "leaver",
    "pack: approver/successor/leaver roles");
  check(isRoleSet(pack.contactsRoles) && sameSet(pack.contactsRoles, ["president", "tech_lead", "treasurer", "leaver"]),
    "pack: contactsRoles must be president, tech_lead, treasurer, leaver");

  for (const e of Array.isArray(pack.entities) ? pack.entities : []) {
    if (!isObj(e) || !isStr(e.key) || !isStr(e.label) || !isStrArr(e.aliases) || e.aliases.length === 0) {
      fail(`pack: bad entity ${JSON.stringify(e)}`);
      continue;
    }
    check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.key), `pack: entity key ${e.key} must be kebab-case`);
    check(!entityKeys.has(e.key), `pack: duplicate entity ${e.key}`);
    entityKeys.add(e.key);
  }
  check(entityKeys.size >= 12 && entityKeys.size <= 16, `pack: expected 12-16 entities, got ${entityKeys.size}`);

  const sa = pack.sourceAuthority;
  if (!isObj(sa)) fail("pack: sourceAuthority missing");
  else {
    check(sameSet(Object.keys(sa), ATTRS), "pack: sourceAuthority must cover exactly the 11 attributes");
    for (const a of ATTRS) {
      const row = sa[a];
      if (!isObj(row)) { fail(`pack: sourceAuthority.${a} missing`); continue; }
      check(sameSet(Object.keys(row), KINDS), `pack: sourceAuthority.${a} must cover the 7 source kinds`);
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
      const expected = EXPECTED_CHECKS[kind];
      check(list.length === expected.length, `pack: checklist ${kind} must have ${expected.length} checks`);
      list.forEach((c, i) => {
        const exp = expected[i];
        if (!isObj(c) || !isStr(c.key) || !isStr(c.label) || !isStrArr(c.attributes) || c.attributes.length === 0) {
          fail(`pack: bad check in ${kind}: ${JSON.stringify(c)}`);
          return;
        }
        if (exp) {
          check(c.key === exp[0] && c.wTag === exp[1] && c.weight === exp[2],
            `pack: ${kind}[${i}] must be ${exp.join("/")}, got ${String(c.key)}/${String(c.wTag)}/${String(c.weight)}`);
        }
        check(subset(c.attributes, ATTRS), `pack: ${kind}.${c.key} has unknown attributes`);
        parsed.push({ key: c.key, weight: Number(c.weight), attributes: c.attributes });
      });
      checklist.set(kind, parsed);
    }
  }

  const rt = isObj(pack.roleTemplates) ? pack.roleTemplates.tech_lead : undefined;
  if (!Array.isArray(rt)) fail("pack: roleTemplates.tech_lead missing");
  else {
    check(sameSet(rt.map((t) => (isObj(t) ? String(t.key) : "")), ["R02", "R03", "R10"]),
      "pack: roleTemplates.tech_lead must be R02, R03, R10");
    for (const t of rt) {
      if (!isObj(t) || !isStr(t.title) || !(RESP_KINDS as readonly string[]).includes(String(t.kind)) || !isStrArr(t.entities)) {
        fail(`pack: bad role template ${JSON.stringify(t)}`);
        continue;
      }
      for (const e of t.entities) check(entityKeys.has(e), `pack: role template ${String(t.key)} uses unknown entity ${e}`);
    }
  }

  const fp = pack.footprint;
  check(isObj(fp) && fp.repeatMin === 3 && fp.distinctWeeksMin === 2 && fp.ownershipShare === 0.8 && fp.windowMonths === 6,
    "pack: footprint thresholds must be 3 / 2 / 0.8 / 6");

  const rb = Array.isArray(pack.readback) ? pack.readback : [];
  check(rb.length === 5, "pack: readback must have exactly five items");
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
  check(sameSet(readbackKeys, ["competition_date", "firmware_rollback", "sponsor_contact", "domain_renewal_date", "lab_booking_day"]),
    "pack: readback keys");
  const ud = pack.uploadDefaults;
  check(isObj(ud) && isRoleSet(ud.roleSet) && sameSet(ud.roleSet, ROLE_KEYS), "pack: uploadDefaults.roleSet must be all roles");
}

// ---------------------------------------------------------------- sources
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
    if (!fs.existsSync(path.join(ROOT, s.path))) { fail(`sources.json: path not found ${s.path}`); continue; }
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
  const abs = path.join(ROOT, s.path);
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
        // Restricted channels (hidden from tech_lead and new_member): every message carries a canary token.
        if (!s.roleSet.includes("tech_lead") && !s.roleSet.includes("new_member")) {
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
      check(/^T-\d{3}$/.test(id) && !taskIds.has(id), `tasks: bad or duplicate id ${id}`);
      taskIds.add(id);
      check(title !== "" && status !== "", `tasks: ${id} needs title and status`);
      check(due === "" || /^\d{4}-\d{2}-\d{2}$/.test(due), `tasks: ${id} bad due ${due}`);
      check(!Number.isNaN(Date.parse(updatedAt)), `tasks: ${id} bad updated_at`);
    });
    counts["tasks"] = rows.length;
    counts["tasks open"] = rows.filter((r) => r[2] !== "Done").length;
    // Inventory takes open cards plus Done cards updated within 30 days: keep that set to the planted R-cards.
    const active = rows.filter((r) => r[2] !== "Done" || TODAY.getTime() - Date.parse(r[7]) <= 30 * 86_400_000).map((r) => r[0]);
    check(sameSet(active, ["T-018", "T-024", "T-031", "T-036"]), `tasks: open or recently active cards must be T-018, T-024, T-031, T-036; got ${active.join(", ")}`);
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
check(respKind.size === 10, `gt: expected 10 responsibilities, got ${respKind.size}`);
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
check(claims.length >= 60 && claims.length <= 80, `gt: expected 60-80 claims, got ${claims.length}`);

// Planted coverage for the successor (tech_lead) must agree with the gaps list.
const gaps = Array.isArray(gtObj.gaps) ? gtObj.gaps.filter(isObj) : [];
let blocking = 0;
for (const [resp, kind] of respKind) {
  for (const def of checklist.get(kind) ?? []) {
    const gap = gaps.find((g) => g.responsibility === resp && g.checkKey === def.key);
    const forCheck = claims.filter((c) => c.check?.responsibility === resp && c.check.checkKey === def.key);
    const visible = forCheck.filter((c) => c.roleSet.includes("tech_lead"));
    const visibleActive = visible.filter((c) => c.state === "active");
    if (!gap) {
      check(visibleActive.length > 0, `coverage: ${resp}.${def.key} has no gap but no active claim visible to tech_lead`);
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
check(blocking === gtObj.expectedTechLeadBlockingGaps, `gaps: ${blocking} blocking gaps but expectedTechLeadBlockingGaps = ${String(gtObj.expectedTechLeadBlockingGaps)}`);

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
  check(ids.some((id) => claims.find((c) => c.id === id)?.roleSet.includes("tech_lead")),
    `gt: readback ${String(r.key)} must be backed by a claim visible to tech_lead`);
}
const offBoard = Array.isArray(gtObj.offBoard) ? gtObj.offBoard : [];
for (const o of offBoard) check(isObj(o) && respKind.has(String(o.responsibility)) && isStr(o.rule) && isStr(o.evidence), `gt: bad offBoard ${JSON.stringify(o)}`);

// ---------------------------------------------------------------- footprint thresholds
const windowStart = new Date(TODAY);
windowStart.setMonth(windowStart.getMonth() - 6);
const inWindow = commits.filter((c) => new Date(c.date) >= windowStart);
const shareOf = (prefix: string) => {
  const touching = inWindow.filter((c) => c.files.some((f) => f.path.startsWith(prefix)));
  const priya = touching.filter((c) => c.author_name === "Priya Nair");
  return { share: touching.length ? priya.length / touching.length : 0, n: touching.length, priya: priya.length,
    weeks: new Set(priya.map((c) => weekKey(new Date(c.date)))).size };
};
const fw = shareOf("firmware/");
const wf = shareOf(".github/workflows/deploy.yml");
const dns = shareOf("dns/");
check(fw.share >= 0.8 && fw.weeks >= 2, `footprint: Priya firmware/ share ${fw.priya}/${fw.n}`);
check(wf.share >= 0.8 && wf.weeks >= 2, `footprint: Priya deploy.yml share ${wf.priya}/${wf.n}`);
check(dns.share >= 0.8, `footprint: Priya dns/ share ${dns.priya}/${dns.n}`);
const late = whatsappMsgs.filter((m) => m.author === "Priya Nair" && /^Pawar sir,/.test(m.text) && /late/i.test(m.text));
const lateWeeks = new Set(late.map((m) => weekKey(m.ts))).size;
check(late.length >= 3 && lateWeeks >= 2, `footprint: late-access requests ${late.length} in ${lateWeeks} weeks`);
const bookings = icsText.split("BEGIN:VEVENT").slice(1).filter((e) => /SUMMARY:Book Workshop Lab 3/.test(e));
const bookingWeeks = new Set(bookings.map((e) => {
  const m = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(e);
  return m ? weekKey(new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)) : -1;
})).size;
check(bookings.length >= 3 && bookingWeeks >= 3, `footprint: lab bookings ${bookings.length} in ${bookingWeeks} weeks`);

// ---------------------------------------------------------------- report
const summary = {
  ...counts,
  "gt claims": claims.length,
  "gt gaps": gaps.length,
  "gt blocking gaps (tech_lead)": blocking,
  "gt supersessions": sup.length,
  "gt conflicts": conf.length,
  "canary tokens": tokens.size,
  secrets: secrets.length,
  "footprint firmware/": `${fw.priya}/${fw.n}`,
  "footprint deploy.yml": `${wf.priya}/${wf.n}`,
  "footprint dns/": `${dns.priya}/${dns.n}`,
  "footprint late access": `${late.length} requests, ${lateWeeks} weeks`,
  "footprint lab bookings": `${bookings.length} events, ${bookingWeeks} weeks`,
};
for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(30)} ${String(v)}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("\ncheck-demo: OK");
