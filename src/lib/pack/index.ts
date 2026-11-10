// Setting-pack loader. Core code never branches on the setting; it reads the pack.
// The pack is read from packs/<id>.json once per process and validated with zod.
import fs from "node:fs";
import path from "node:path";
import { PackZ, type Pack } from "./schema";
import type { RoleKey, ResponsibilityKind, CheckDef } from "@/lib/types";

export { PackZ, type Pack } from "./schema";

const cache = new Map<string, Pack>();

export function packPath(id = "club"): string {
  return path.join(process.cwd(), "packs", `${id}.json`);
}

/** The validated setting pack (default: the robotics club). Throws a readable error if invalid. */
export function getPack(id = "club"): Pack {
  const hit = cache.get(id);
  if (hit) return hit;
  const file = packPath(id);
  if (!fs.existsSync(file)) throw new Error(`Setting pack not found: packs/${id}.json`);
  const parsed = PackZ.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Setting pack packs/${id}.json is invalid: ${first}`);
  }
  cache.set(id, parsed.data);
  return parsed.data;
}

export function roleLabel(role: RoleKey, pack: Pack = getPack()): string {
  return pack.roles.find((r) => r.key === role)?.label ?? role;
}

export function checklistFor(kind: ResponsibilityKind, pack: Pack = getPack()): CheckDef[] {
  return (pack.checklists[kind] ?? []) as CheckDef[];
}

export function entityLabel(key: string, pack: Pack = getPack()): string {
  return pack.entities.find((e) => e.key === key)?.label ?? key;
}

/** Pack authority of a source kind for an attribute (higher wins; 0 when unlisted). */
export function authority(attribute: string, kind: string, pack: Pack = getPack()): number {
  return pack.sourceAuthority[attribute]?.[kind] ?? 0;
}
