// Setting-pack loader. Core code never branches on the setting; it reads the pack.
// A pack is read from packs/<id>.json once per process, validated with zod, then resolved:
// the role flags become approverRole, successorRole, leaverRole, restrictedAudienceRoles,
// testRoles and roleOrder. Core learns which packs exist from packs/index.json, never from a literal.
import fs from "node:fs";
import path from "node:path";
import { ATTRIBUTE_KEYS } from "./attributes";
import { PACK_ID_RE, PackZ, ROLE_KEY_RE, type Pack, type PackRole } from "./schema";
import type { RoleKey, ResponsibilityKind, CheckDef } from "@/lib/types";

export { PackZ, type Pack, type PackRole } from "./schema";

/** A validated pack plus the role facts derived from its flags. */
export interface ResolvedPack extends Pack {
  approverRole: RoleKey;
  successorRole: RoleKey;
  leaverRole: RoleKey;
  /** Roles flagged "sees least": a claim hidden from any of them is sensitive. */
  restrictedAudienceRoles: RoleKey[];
  /** Roles the stand-in successor test runs as: the successor, then every restricted audience role. */
  testRoles: RoleKey[];
  /** Canonical order of a role set: the order of `roles` in the pack. */
  roleOrder: RoleKey[];
  /** Role holders by full name; an empty object when the pack names none. */
  roleHolders: Record<RoleKey, string[]>;
}

export class PackError extends Error {}

const cache = new Map<string, ResolvedPack>();

export function packPath(id: string): string {
  return path.join(process.cwd(), "packs", `${id}.json`);
}

/**
 * Validate a raw pack object and derive the role facts. Throws PackError with a readable message.
 * `opts.checkFiles` (default true) also checks that demo.dataDir exists and holds sources.json.
 */
export function resolvePack(raw: unknown, opts: { checkFiles?: boolean } = {}): ResolvedPack {
  const parsed = PackZ.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new PackError(first);
  }
  const pack = parsed.data;
  const keys = pack.roles.map((r) => r.key);
  const known = new Set(keys);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new PackError(`roles: duplicate key "${dup}"`);

  const flagged = (flag: (r: PackRole) => boolean | undefined) => pack.roles.filter((r) => flag(r) === true).map((r) => r.key);
  const approvers = flagged((r) => r.approver);
  const successors = flagged((r) => r.successor);
  const leavers = flagged((r) => r.leaver);
  const restricted = flagged((r) => r.restrictedAudience);
  if (approvers.length !== 1 || successors.length !== 1 || leavers.length !== 1 ||
      new Set([approvers[0], successors[0], leavers[0]]).size !== 3) {
    throw new PackError("roles: need exactly one approver, one successor and one leaver");
  }
  const [approverRole, successorRole, leaverRole] = [approvers[0], successors[0], leavers[0]];
  if (!restricted.length || restricted.includes(approverRole) || restricted.includes(leaverRole)) {
    throw new PackError("roles: flag at least one restrictedAudience role");
  }
  const legacy = [["approverRole", approverRole], ["successorRole", successorRole], ["leaverRole", leaverRole]] as const;
  for (const [key, value] of legacy) {
    if (pack[key] !== undefined && pack[key] !== value) {
      throw new PackError(`${key} disagrees with the role flagged ${key.replace(/Role$/, "")}`);
    }
  }

  const lists: [string, readonly string[]][] = [
    ["contactsRoles", pack.contactsRoles],
    ["uploadDefaults.roleSet", pack.uploadDefaults.roleSet],
    ["roleTemplates", Object.keys(pack.roleTemplates)],
    ["roleHolders", Object.keys(pack.roleHolders ?? {})],
    ...Object.entries(pack.sensitivity ?? {}).map(([k, v]) => [`sensitivity.${k}`, v] as [string, readonly string[]]),
  ];
  for (const [name, list] of lists) {
    const bad = list.find((k) => !known.has(k));
    if (bad !== undefined) throw new PackError(`${name}: unknown role "${bad}"`);
  }
  if (!pack.uploadDefaults.roleSet.includes(approverRole)) {
    throw new PackError("uploadDefaults.roleSet must include the approver");
  }

  const entities = new Set(pack.entities.map((e) => e.key));
  for (const item of pack.readback) {
    if (!entities.has(item.entity)) throw new PackError(`readback: unknown entity "${item.entity}"`);
  }
  for (const [role, templates] of Object.entries(pack.roleTemplates)) {
    for (const t of templates) {
      const bad = t.entities.find((e) => !entities.has(e));
      if (bad !== undefined) throw new PackError(`roleTemplates.${role}: unknown entity "${bad}"`);
    }
  }
  const badExample = Object.keys(pack.extraction?.examples ?? {}).find((a) => !ATTRIBUTE_KEYS.includes(a));
  if (badExample !== undefined) throw new PackError(`extraction.examples: unknown attribute "${badExample}"`);

  if (pack.demo && opts.checkFiles !== false) {
    const dir = path.resolve(process.cwd(), pack.demo.dataDir);
    if (!fs.existsSync(path.join(dir, "sources.json"))) throw new PackError("demo.dataDir not found");
  }

  return {
    ...pack,
    approverRole,
    successorRole,
    leaverRole,
    restrictedAudienceRoles: restricted,
    testRoles: [...new Set([successorRole, ...restricted])],
    roleOrder: keys,
    roleHolders: pack.roleHolders ?? {},
  };
}

/** The validated, resolved setting pack with this id. Throws a readable error if missing or invalid. */
export function getPack(id: string): ResolvedPack {
  const hit = cache.get(id);
  if (hit) return hit;
  if (!PACK_ID_RE.test(id)) throw new PackError(`Setting pack not found: ${JSON.stringify(id)}`);
  const file = packPath(id);
  if (!fs.existsSync(file)) throw new PackError(`Setting pack not found: packs/${id}.json`);
  let pack: ResolvedPack;
  try {
    pack = resolvePack(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    throw new PackError(`Setting pack packs/${id}.json is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pack.id !== id) throw new PackError(`Setting pack packs/${id}.json is invalid: id is "${pack.id}"`);
  cache.set(id, pack);
  return pack;
}

interface PackIndex { default: string; demos: string[] }

let indexCache: PackIndex | null = null;

/** packs/index.json: the default pack for an empty workspace and the packs offered as demos. */
function packIndex(): PackIndex {
  if (indexCache) return indexCache;
  const file = path.join(process.cwd(), "packs", "index.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PackIndex>;
  if (typeof raw.default !== "string" || !Array.isArray(raw.demos)) {
    throw new PackError('packs/index.json must look like { "default": "<pack id>", "demos": ["<pack id>"] }');
  }
  indexCache = { default: raw.default, demos: raw.demos.map(String) };
  return indexCache;
}

/** The pack an empty workspace gets when the visitor picks none. */
export function defaultPackId(): string {
  return packIndex().default;
}

type DemoBlock = NonNullable<Pack["demo"]>;

export interface PackListing {
  id: string;
  name: string;
  /** The demo block when the pack is offered as a demo, else null. */
  demo: DemoBlock | null;
}

/** Every pack named in packs/index.json (the default first, then the demos in file order). */
export function listPacks(): PackListing[] {
  const index = packIndex();
  return [...new Set([index.default, ...index.demos])].map((id) => {
    const pack = getPack(id);
    return { id, name: pack.name, demo: index.demos.includes(id) ? (pack.demo ?? null) : null };
  });
}

/** Packs offered as a demo on the landing page: listed under "demos" and carrying a `demo` block. */
export function listDemoPacks(): (PackListing & { demo: DemoBlock })[] {
  return listPacks().filter((p): p is PackListing & { demo: DemoBlock } => p.demo !== null);
}

const byWorkspace = new Map<string, string>();

/**
 * The pack of a workspace (workspaces.pack_id). A workspace never changes setting (database
 * guard), so the id is remembered per process.
 */
export async function getWorkspacePack(ws: string): Promise<ResolvedPack> {
  const known = byWorkspace.get(ws);
  if (known) return getPack(known);
  const { db } = await import("@/lib/db/client");
  const [row] = await db()`SELECT pack_id FROM workspaces WHERE id = ${ws}`;
  if (!row) throw new PackError("Workspace not found.");
  const id = String(row.pack_id);
  let pack: ResolvedPack;
  try {
    pack = getPack(id);
  } catch (err) {
    console.error(`[pack] workspace ${ws}:`, err);
    throw new PackError("This workspace uses a setting that is no longer available.");
  }
  byWorkspace.set(ws, id);
  return pack;
}

/** Format check only (a key no row lists sees nothing under RLS). Membership: isRoleOf. */
export function isRoleKeyFormat(x: unknown): x is RoleKey {
  return typeof x === "string" && ROLE_KEY_RE.test(x);
}

/** True when `x` is a role of this pack. Use at every edge where a role key enters the system. */
export function isRoleOf(pack: Pick<Pack, "roles">, x: unknown): x is RoleKey {
  return typeof x === "string" && pack.roles.some((r) => r.key === x);
}

export function roleLabel(role: RoleKey, pack: Pick<Pack, "roles">): string {
  return pack.roles.find((r) => r.key === role)?.label ?? role;
}

/** How copy names a role inside a sentence; the label when the pack gives no short form. */
export function roleShort(role: RoleKey, pack: Pick<Pack, "roles">): string {
  const r = pack.roles.find((x) => x.key === role);
  return r?.short ?? r?.label ?? role;
}

/** The role facts the approval rules need (ApprovalRoles in relay/core/labels). */
export function approvalRoles(pack: ResolvedPack): { approver: RoleKey; leaver: RoleKey; approverLabel: string } {
  return { approver: pack.approverRole, leaver: pack.leaverRole, approverLabel: roleLabel(pack.approverRole, pack) };
}

export function checklistFor(kind: ResponsibilityKind, pack: Pick<Pack, "checklists">): CheckDef[] {
  return (pack.checklists[kind] ?? []) as CheckDef[];
}

export function entityLabel(key: string, pack: Pick<Pack, "entities">): string {
  return pack.entities.find((e) => e.key === key)?.label ?? key;
}

/** Pack authority of a source kind for an attribute (higher wins; 0 when unlisted). */
export function authority(attribute: string, kind: string, pack: Pick<Pack, "sourceAuthority">): number {
  return pack.sourceAuthority[attribute]?.[kind] ?? 0;
}
