// Workspaces and ingest (admin path, runs as the app user and is audited).
// Parsing and masking are pure Tether code; this file stores the results.
import { db } from "@/lib/db/client";
import { segmentRow, toPerson } from "@/lib/db/mappers";
import { audit } from "@/lib/db/queries";
import { getPack } from "@/lib/pack";
import { ingestAll, type IngestInput } from "@/lib/tether/ingest";
import { PersonRegistry } from "@/lib/tether/identity";
import { loadDemoSources } from "@/lib/tether/demo";
import { fetchPublicRepo, GithubFetchError } from "@/lib/tether/github-fetch";
import { sha256Hex } from "@/lib/text/norm";
import type { AdapterResult, Person, RoleKey, SourceKind } from "@/lib/types";

export const UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
export const UPLOAD_KINDS: SourceKind[] = ["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics"];

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
  const pack = getPack();
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
  const stored: StoredSource[] = [];
  for (const s of out.sources) stored.push(await storeResult(ws, s, origin));
  return stored;
}

export async function createEmptyWorkspace(name = "My handover"): Promise<string> {
  const [row] = await db()`INSERT INTO workspaces (name, kind) VALUES (${name}, 'empty') RETURNING id`;
  const id = String(row.id);
  await audit(id, "system", "create_workspace", { kind: "empty" });
  return id;
}

/** A private copy of the robotics-club demo: workspace + all demo sources stored. */
export async function createDemoWorkspace(): Promise<{ id: string; sources: StoredSource[] }> {
  const pack = getPack();
  const [row] = await db()`INSERT INTO workspaces (name, kind, pack_id) VALUES (${pack.name + " (demo)"}, 'demo', ${pack.id}) RETURNING id`;
  const id = String(row.id);
  const demo = loadDemoSources();
  const sources = await ingestSources(id, demo.map((d) => ({ kind: d.kind, name: d.name, roleSet: d.roleSet, files: d.files })), "demo");
  await audit(id, "system", "create_workspace", { kind: "demo", sources: sources.length });
  return { id, sources };
}

/** Role set for an upload: the pack default, optionally narrowed by the uploader (never widened). */
export function uploadRoleSet(narrow?: RoleKey[]): RoleKey[] {
  const base = getPack().uploadDefaults.roleSet as RoleKey[];
  if (!narrow?.length) return [...base];
  return base.filter((r) => narrow.includes(r));
}

export async function ingestUpload(
  ws: string, kind: SourceKind, files: { path: string; content: string }[], opts: { narrowRoles?: RoleKey[]; name?: string; actor?: string } = {},
): Promise<IngestResult> {
  if (!UPLOAD_KINDS.includes(kind)) return { ok: false, error: "Pick a source type." };
  if (!files.length) return { ok: false, error: "Choose at least one file." };
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  if (bytes > UPLOAD_LIMIT_BYTES) return { ok: false, error: "Upload is over 5 MB. Split it or trim it." };
  const roleSet = uploadRoleSet(opts.narrowRoles);
  if (!roleSet.length) return { ok: false, error: "Pick at least one role who can see this source." };
  const name = opts.name?.trim() || (files.length === 1 ? files[0].path.split("/").pop()! : `${kind} upload (${files.length} files)`);
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
    const roleSet = uploadRoleSet(opts.narrowRoles);
    const sources = await ingestSources(ws, [{ kind: "github", name: name || url, roleSet, files }], "github");
    await audit(ws, opts.actor ?? "uploader", "github_import", { url, files: files.length });
    return { ok: true, sources };
  } catch (err) {
    if (err instanceof GithubFetchError) return { ok: false, error: err.message };
    return { ok: false, error: `GitHub import failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
