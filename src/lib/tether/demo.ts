// Loads the demo pack sources listed in data/demo/sources.json (server-side only).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RoleKey, SourceKind } from "@/lib/types";
import type { SourceFile } from "./adapters/common";

export interface DemoSource {
  kind: SourceKind;
  name: string;
  roleSet: RoleKey[];
  files: SourceFile[];
}

interface SourceEntry {
  kind: SourceKind;
  name?: string;
  path: string;
  roleSet?: RoleKey[];
  role_set?: RoleKey[];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function readSourceFiles(absPath: string): SourceFile[] {
  if (statSync(absPath).isDirectory()) {
    return walk(absPath).map((p) => ({ path: relative(absPath, p).replace(/\\/g, "/"), content: readFileSync(p, "utf8") }));
  }
  const name = absPath.replace(/\\/g, "/").split("/").pop() ?? absPath;
  return [{ path: name, content: readFileSync(absPath, "utf8") }];
}

export function loadDemoSources(rootDir = "data/demo"): DemoSource[] {
  const root = resolve(process.cwd(), rootDir);
  const raw = JSON.parse(readFileSync(join(root, "sources.json"), "utf8")) as SourceEntry[] | { sources: SourceEntry[] };
  const entries = Array.isArray(raw) ? raw : raw.sources;
  return entries.map((e) => ({
    kind: e.kind,
    name: e.name ?? e.path,
    roleSet: [...(e.roleSet ?? e.role_set ?? [])],
    // paths are relative to rootDir; fall back to the project root if written that way
    files: readSourceFiles(existsSync(resolve(root, e.path)) ? resolve(root, e.path) : resolve(process.cwd(), e.path)),
  }));
}
