// Proves the claim in docs/round3/ZERO_CORE_CHANGES.md from the git history, not from a promise:
// "adding the second setting needed no setting-specific core code".
//
// The document names three commits and the pack that was added:
//   Base   the last commit before the pack's branch was merged
//   Pack   the tip of the pack's branch (setting data only)
//   Head   the commit at which the second setting ran end to end
// Checks, over core = src/, db/migrations/ and next.config.ts:
//   1. the pack's branch (Base..Pack) changed no core file and no script the app runs on;
//   2. every core file changed in Base..Head is listed in the document with its reason;
//   3. no line ADDED to core in Base..Head holds a role key, the pack id or a proper noun of the
//      added pack (the same scanner as scripts/check-literals.ts, with that pack's vocabulary only);
//   4. no migration was added or changed in Base..Head.
// A shallow clone that lacks the commits skips with exit 0 and says so.
// Usage: pnpm tsx scripts/check-zero-core.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packVocabulary, scanText } from "./check-literals";

export interface ZeroCoreReport {
  skipped: string | null;
  base: string;
  pack: string;
  head: string;
  packId: string;
  packBranchCore: string[];      // core files the pack's branch touched (must be empty)
  coreChanged: string[];         // core files changed in Base..Head
  undocumented: string[];        // of those, not named in the document
  hits: string[];                // added core lines holding the pack's vocabulary
  migrations: string[];          // migrations touched in Base..Head (must be empty)
  addedLines: number;
  problems: string[];
}

const CORE = ["src", "db/migrations", "next.config.ts"];
const DOC = "docs/round3/ZERO_CORE_CHANGES.md";

export function checkZeroCore(root: string): ZeroCoreReport {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const doc = fs.readFileSync(path.join(root, DOC), "utf8");
  const field = (name: string) => new RegExp(`^- ${name}: \`([^\`]+)\``, "m").exec(doc)?.[1] ?? "";
  const r: ZeroCoreReport = {
    skipped: null, base: field("Base"), pack: field("Pack"), head: field("Head"), packId: field("Pack id"),
    packBranchCore: [], coreChanged: [], undocumented: [], hits: [], migrations: [], addedLines: 0, problems: [],
  };
  for (const [k, v] of [["Base", r.base], ["Pack", r.pack], ["Head", r.head], ["Pack id", r.packId]]) {
    if (!v) r.problems.push(`${DOC}: missing "- ${k}: \`...\`"`);
  }
  if (r.problems.length) return r;
  for (const sha of [r.base, r.pack, r.head]) {
    try {
      git("cat-file", "-e", `${sha}^{commit}`);
    } catch {
      r.skipped = `commit ${sha} is not in this clone (shallow checkout)`;
      return r;
    }
  }
  const names = (...range: string[]) => git("diff", "--name-only", ...range, "--", ...CORE).split("\n").map((s) => s.trim()).filter(Boolean);

  // Three dots: what the pack's branch itself changed since it forked, not what main changed meanwhile.
  r.packBranchCore = git("diff", "--name-only", `${r.base}...${r.pack}`, "--", ...CORE, "scripts/seed.ts", "scripts/migrate.ts")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (r.packBranchCore.length) r.problems.push(`the pack's branch changed core files: ${r.packBranchCore.join(", ")}`);

  r.coreChanged = names(r.base, r.head);
  r.undocumented = r.coreChanged.filter((f) => !doc.includes(`\`${f}\``));
  if (r.undocumented.length) r.problems.push(`core files changed but not explained in ${DOC}: ${r.undocumented.join(", ")}`);

  r.migrations = r.coreChanged.filter((f) => f.startsWith("db/migrations/"));
  if (r.migrations.length) r.problems.push(`migrations changed: ${r.migrations.join(", ")}`);

  const vocab = packVocabulary(root, [r.packId]);
  if (!vocab.packIds.length) r.problems.push(`packs/${r.packId}.json not found`);
  const diff = git("diff", "-U0", r.base, r.head, "--", ...CORE);
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.slice(6).trim(); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    r.addedLines++;
    for (const h of scanText(file, line.slice(1), vocab)) r.hits.push(`${file}: ${h.kind} ${JSON.stringify(h.token)} in "${h.text}"`);
  }
  if (r.hits.length) r.problems.push(`${r.hits.length} added core line(s) hold vocabulary of the "${r.packId}" pack`);
  return r;
}

function main(): void {
  const r = checkZeroCore(process.cwd());
  if (r.skipped) {
    console.log(`check-zero-core: skipped, ${r.skipped}.`);
    return;
  }
  console.log(`base ${r.base}, pack branch ${r.pack}, head ${r.head}, pack "${r.packId}"`);
  console.log(`core files the pack's branch changed: ${r.packBranchCore.length}`);
  console.log(`core files changed base..head: ${r.coreChanged.length} (${r.addedLines} added lines)`);
  for (const f of r.coreChanged) console.log(`  ${f}`);
  console.log(`added core lines naming the pack: ${r.hits.length}`);
  for (const h of r.hits) console.error(`  ${h}`);
  if (r.problems.length) {
    for (const p of r.problems) console.error(`check-zero-core: ${p}`);
    process.exit(1);
  }
  console.log("check-zero-core: ok. The second setting needed no setting-specific core code.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
