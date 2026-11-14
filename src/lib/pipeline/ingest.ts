// Workspaces and ingest (admin path, runs as the app user and is audited).
// Parsing and masking are pure Tether code; this file stores the results.
import { db } from "@/lib/db/client";
import { segmentRow, toPerson } from "@/lib/db/mappers";
import { audit } from "@/lib/db/queries";
import { defaultPackId, getPack, getWorkspacePack, type ResolvedPack } from "@/lib/pack";
import { ingestAll, type IngestInput } from "@/lib/tether/ingest";
import { PersonRegistry } from "@/lib/tether/identity";
import { loadDemoSources } from "@/lib/tether/demo";
import { fetchPublicRepo, GithubFetchError } from "@/lib/tether/github-fetch";
import { sha256Hex } from "@/lib/text/norm";
import { syncRoleHolders } from "@/lib/roles";
import type { AdapterResult, Person, RoleKey, SourceKind } from "@/lib/types";

// The live host refuses a request body over about 4.5 MB before our code runs, so the limit and
// every message say 4.5 MB.
export const UPLOAD_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);
export const UPLOAD_LIMIT_MESSAGE = "Upload is over 4.5 MB. Split it or trim it.";
/** One upload may add this many segments (messages, rows, sections). Larger exports are split. */
export const UPLOAD_MAX_SEGMENTS = 20_000;
export const UPLOAD_MAX_FILES = 200;
export const UPLOAD_KINDS: SourceKind[] = ["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics"];
/** How an upload kind is named in messages ("Nothing could be read from a.txt as a WhatsApp chat"). */
export const UPLOAD_KIND_LABEL: Partial<Record<SourceKind, string>> = {
  whatsapp: "a WhatsApp chat export",
  slack: "a Slack export",
  github: "a GitHub export",
  tasks_csv: "a task board CSV",
  markdown: "Markdown notes",
  ics: "a calendar (.ics) file",
};

export interface StoredSource {
  id: string;
  kind: SourceKind;
  name: string;
  segments: number;
  newSegments: number;
  rejected: number;
  maskedSecrets: number;
  maskedContacts: number;
}

export type IngestResult = { ok: true; sources: StoredSource[] } | { ok: false; error: string };

function keys() {
  const identityKey = process.env.IDENTITY_KEY ?? "";
  const contactsKey = process.env.CONTACTS_KEY ?? "";
  if (!identityKey || !contactsKey) throw new Error("IDENTITY_KEY and CONTACTS_KEY must be set (see .env.example)");
  return { identityKey, contactsKey };
}

export function sourceIdFor(kind: SourceKind, name: string): string {
  return "src_" + sha256Hex(`${kind}|${name}`).slice(0, 12);
}

/**
 * A registry that continues the workspace's numbering, so new people get fresh p-<n> ids and
 * exact-email matches merge with people already stored.
 * TODO(tether): replace the field writes with a public PersonRegistry.seed() when it exists.
 */
async function registryFor(ws: string, identityKey: string): Promise<{ reg: PersonRegistry; existing: Person[] }> {
  const reg = new PersonRegistry(identityKey);
  const existing = (await db()`SELECT * FROM people WHERE workspace_id = ${ws}`).map(toPerson)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  if (!existing.length) return { reg, existing };
  const seedable = reg as unknown as { seed?: (p: Person[]) => void };
  if (typeof seedable.seed === "function") {
    seedable.seed(existing);
  } else {
    const internals = reg as unknown as { people: Person[]; byHmac: Map<string, Person>; contactCounter: number };
    internals.people = existing.map((p) => ({ ...p, aliases: [...p.aliases] }));
    for (const p of internals.people) if (p.emailHmac) internals.byHmac.set(p.emailHmac, p);
    const [{ n }] = await db()`
      SELECT coalesce(max(substring(token from 'c-([0-9]+)')::int), 0) AS n FROM contacts WHERE workspace_id = ${ws}`;
    internals.contactCounter = Number(n);
  }
  return { reg, existing };
}

async function storeResult(
  ws: string, src: { sourceId: string; kind: SourceKind; name: string; roleSet: RoleKey[]; result: AdapterResult }, origin: string,
): Promise<StoredSource> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const r = src.result;
  await sql`
    INSERT INTO sources (workspace_id, id, kind, name, role_set, segment_count, rejected, masked_secrets, masked_contacts, origin)
    VALUES (${ws}, ${src.sourceId}, ${src.kind}, ${src.name}, ${src.roleSet}::text[], ${r.segments.length},
      ${JSON.stringify(r.rejected)}::jsonb, ${r.maskedSecrets}, ${r.maskedContacts}, ${origin})
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      role_set = EXCLUDED.role_set, segment_count = EXCLUDED.segment_count, rejected = EXCLUDED.rejected,
      masked_secrets = EXCLUDED.masked_secrets, masked_contacts = EXCLUDED.masked_contacts, imported_at = now()`;

  let newSegments = 0;
  const rows = r.segments.map((s) => segmentRow({ ...s, sourceId: src.sourceId }, ws));
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    const res = await sql`INSERT INTO segments ${sql(chunk)} ON CONFLICT (workspace_id, id, version) DO NOTHING RETURNING id`;
    newSegments += res.length;
  }

  const contactRoles = src.roleSet.filter((x) => (pack.contactsRoles as RoleKey[]).includes(x));
  for (const c of r.contacts ?? []) {
    await sql`
      INSERT INTO contacts (workspace_id, token, kind, person_id, value_enc, role_set, source_id)
      VALUES (${ws}, ${c.token}, ${c.kind}, ${c.personId}, ${c.valueEnc}, ${contactRoles}::text[], ${src.sourceId})
      ON CONFLICT (workspace_id, token, kind) DO NOTHING`;
  }

  return {
    id: src.sourceId, kind: src.kind, name: src.name, segments: r.segments.length, newSegments,
    rejected: r.rejected.length, maskedSecrets: r.maskedSecrets, maskedContacts: r.maskedContacts,
  };
}

async function storePeople(ws: string, people: Person[]): Promise<void> {
  for (const p of people) {
    await db()`
      INSERT INTO people (workspace_id, id, display_name, email_hmac, aliases)
      VALUES (${ws}, ${p.id}, ${p.displayName}, ${p.emailHmac}, ${p.aliases}::text[])
      ON CONFLICT (workspace_id, id) DO UPDATE SET aliases = EXCLUDED.aliases,
        email_hmac = coalesce(people.email_hmac, EXCLUDED.email_hmac)`;
  }
}

/** Parse and store several sources with one shared PersonRegistry. */
export async function ingestSources(ws: string, inputs: IngestInput[], origin: string): Promise<StoredSource[]> {
  const { identityKey, contactsKey } = keys();
  const { reg } = await registryFor(ws, identityKey);
  const out = ingestAll(
    inputs.map((s) => ({ ...s, sourceId: s.sourceId ?? sourceIdFor(s.kind, s.name) })),
    { identityKey, contactsKey, registry: reg },
  );
  await storePeople(ws, out.people);
  // New sources can bring new person records: match the pack's role holders to them.
  await syncRoleHolders(ws);
  const stored: StoredSource[] = [];
  for (const s of out.sources) stored.push(await storeResult(ws, s, origin));
  return stored;
}

/**
 * The workspace row. The pack id and the pack's approver and leaver roles are written once, here,
 * and never change (database guard): the database enforces "only the approver approves, never
 * the leaver" from these columns, without knowing any role key.
 */
async function insertWorkspace(name: string, kind: "demo" | "empty", pack: ResolvedPack): Promise<string> {
  const [row] = await db()`
    INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role)
    VALUES (${name}, ${kind}, ${pack.id}, ${pack.approverRole}, ${pack.leaverRole}) RETURNING id`;
  return String(row.id);
}

/** An empty workspace of the given setting (default: the default pack of packs/index.json). */
export async function createEmptyWorkspace(name = "My handover", packId: string = defaultPackId()): Promise<string> {
  const pack = getPack(packId);
  const id = await insertWorkspace(name, "empty", pack);
  await audit(id, "system", "create_workspace", { kind: "empty", pack: pack.id });
  return id;
}

/** A private copy of a pack's demo: workspace + all demo sources stored + role holders matched. */
export async function createDemoWorkspace(packId: string): Promise<{ id: string; sources: StoredSource[] }> {
  const pack = getPack(packId);
  if (!pack.demo) throw new Error(`Setting pack "${pack.id}" has no demo.`);
  const id = await insertWorkspace(pack.name + " (demo)", "demo", pack);
  const demo = loadDemoSources(pack.demo.dataDir);
  const sources = await ingestSources(id, demo.map((d) => ({ kind: d.kind, name: d.name, roleSet: d.roleSet, files: d.files })), "demo");
  await audit(id, "system", "create_workspace", { kind: "demo", pack: pack.id, sources: sources.length });
  return { id, sources };
}

/** Role set for an upload: the pack default, optionally narrowed by the uploader (never widened). */
export function uploadRoleSet(pack: Pick<ResolvedPack, "uploadDefaults">, narrow?: RoleKey[]): RoleKey[] {
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  if (!narrow?.length) return [...base];
  return base.filter((r) => narrow.includes(r));
}

/** A file read as text that is really an image, a PDF, a zip: NUL bytes or many undecodable bytes. */
export function looksBinary(content: string): boolean {
  const sample = content.slice(0, 8000);
  if (!sample.length) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c === 0xfffd || (c < 9) || (c > 13 && c < 32 && c !== 27)) bad++;
  }
  return bad / sample.length > 0.02;
}

/**
 * Checks on an upload before anything is stored. Returns the message to show, or null.
 * Pure apart from one throwaway parse, so a refused upload leaves no source row behind.
 */
export function uploadProblem(kind: SourceKind, files: { path: string; content: string }[], label: string = kind): string | null {
  if (!files.length) return "Choose at least one file.";
  if (files.length > UPLOAD_MAX_FILES) return `That is ${files.length} files; the limit is ${UPLOAD_MAX_FILES} per upload. Upload them in parts.`;
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  if (bytes > UPLOAD_LIMIT_BYTES) return UPLOAD_LIMIT_MESSAGE;
  const named = (f: { path: string }) => f.path.split("/").pop() || "the file";
  if (files.every((f) => !f.content.trim())) {
    return files.length === 1 ? `"${named(files[0])}" is empty. Choose a file with content.` : "These files are all empty. Choose files with content.";
  }
  const binary = files.find((f) => looksBinary(f.content));
  if (binary) return `"${named(binary)}" does not look like a text file. Upload the exported text, CSV, JSON, Markdown or .ics file.`;
  let parsed;
  try {
    const { identityKey, contactsKey } = keys();
    parsed = ingestAll([{ kind, name: "check", roleSet: [], files }], { identityKey, contactsKey, registry: new PersonRegistry(identityKey) }).sources[0]?.result;
  } catch (err) {
    return `Could not read ${files.length === 1 ? `"${named(files[0])}"` : "these files"} as ${label}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const segments = parsed?.segments.length ?? 0;
  if (segments === 0) {
    const why = parsed?.rejected[0]?.reason;
    return `Nothing could be read from ${files.length === 1 ? `"${named(files[0])}"` : "these files"} as ${label}${why ? `: ${why}` : ""}. Check that the source type matches the file.`;
  }
  if (segments > UPLOAD_MAX_SEGMENTS) {
    return `This upload has ${segments.toLocaleString("en")} entries; the limit is ${UPLOAD_MAX_SEGMENTS.toLocaleString("en")} per upload. Split the export (for example by month) and upload the parts.`;
  }
  return null;
}

export async function ingestUpload(
  ws: string, kind: SourceKind, files: { path: string; content: string }[],
  opts: { narrowRoles?: RoleKey[]; name?: string; actor?: string; kindLabel?: string } = {},
): Promise<IngestResult> {
  if (!UPLOAD_KINDS.includes(kind)) return { ok: false, error: "Pick a source type." };
  const problem = uploadProblem(kind, files, opts.kindLabel ?? kind);
  if (problem) return { ok: false, error: problem };
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  const roleSet = uploadRoleSet(await getWorkspacePack(ws), opts.narrowRoles);
  if (!roleSet.length) return { ok: false, error: "Pick at least one role who can see this source." };
  const name = (opts.name?.trim() || (files.length === 1 ? files[0].path.split("/").pop()! : `${kind} upload (${files.length} files)`)).slice(0, 200);
  try {
    const sources = await ingestSources(ws, [{ kind, name, roleSet, files }], "upload");
    await audit(ws, opts.actor ?? "uploader", "upload", { kind, name, files: files.length, bytes, roleSet });
    return { ok: true, sources };
  } catch (err) {
    return { ok: false, error: `Could not read these files as ${kind}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function ingestGithubUrl(ws: string, url: string, opts: { narrowRoles?: RoleKey[]; actor?: string } = {}): Promise<IngestResult> {
  try {
    const files = await fetchPublicRepo(url);
    const name = url.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    const roleSet = uploadRoleSet(await getWorkspacePack(ws), opts.narrowRoles);
    const sources = await ingestSources(ws, [{ kind: "github", name: name || url, roleSet, files }], "github");
    await audit(ws, opts.actor ?? "uploader", "github_import", { url, files: files.length });
    return { ok: true, sources };
  } catch (err) {
    if (err instanceof GithubFetchError) return { ok: false, error: err.message };
    return { ok: false, error: `GitHub import failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
