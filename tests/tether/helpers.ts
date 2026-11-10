import { join } from "node:path";
import type { RoleKey, SourceKind } from "@/lib/types";
import { readSourceFiles } from "@/lib/tether/demo";
import { ingestAll, type IngestInput } from "@/lib/tether/ingest";
import { PersonRegistry } from "@/lib/tether/identity";
import type { AdapterContext } from "@/lib/tether/adapters";

export const FIX = join(__dirname, "fixtures");
export const KEYS = { identityKey: "test-identity-key", contactsKey: "test-contacts-key" };
export const ALL_ROLES: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];

export function fixture(dir: string) {
  return readSourceFiles(join(FIX, dir));
}

export function ctx(over: Partial<AdapterContext> = {}): AdapterContext {
  return { sourceId: "src-test", roleSet: ALL_ROLES, ...KEYS, people: new PersonRegistry(KEYS.identityKey), ...over };
}

export function fixtureInputs(): IngestInput[] {
  const list: [SourceKind, string][] = [
    ["whatsapp", "whatsapp"], ["slack", "slack"], ["github", "github"],
    ["tasks_csv", "tasks"], ["markdown", "notes"], ["ics", "calendar"],
  ];
  return list.map(([kind, dir], i) => ({ kind, name: dir, roleSet: ALL_ROLES, files: fixture(dir), sourceId: `src-${i + 1}` }));
}

export function ingestFixtures() {
  return ingestAll(fixtureInputs(), KEYS);
}
