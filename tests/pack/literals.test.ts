// The no-setting-literals check, checked: the tree is clean, a role key put back into core code
// is caught, ordinary words that merely contain a key are not, and the allow-list cannot be used
// to silence a hit quietly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkLiterals, coreFiles, packVocabulary, scanText } from "../../scripts/check-literals";

const ROOT = process.cwd();
const vocab = packVocabulary(ROOT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "us-literals-"));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A throwaway project root: the real packs, plus the given core files. */
function fixture(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "packs"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "packs"))) fs.copyFileSync(path.join(ROOT, "packs", f), path.join(root, "packs", f));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe("no setting literals in core code", () => {
  it("reads role keys, pack ids and proper nouns from every pack file", () => {
    expect(vocab.packIds).toContain("club");
    expect(vocab.roleKeys).toEqual(expect.arrayContaining(["president", "tech_lead", "new_member", "treasurer", "leaver"]));
    expect(vocab.nouns).toEqual(expect.arrayContaining(["Club President", "Priya", "Rohan Mehta", "RoboLeague"]));
  });

  it("covers src/, db/migrations/ and next.config.ts, and nothing else", () => {
    const files = coreFiles(ROOT).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(files).toContain("next.config.ts");
    expect(files).toContain("db/migrations/0006_packs.sql");
    expect(files).toContain("src/lib/types.ts");
    expect(files.every((f) => f.startsWith("src/") || f.startsWith("db/migrations/") || f === "next.config.ts")).toBe(true);
  });

  it("the tree is clean: no role key, pack id or pack noun in core code", () => {
    const r = checkLiterals({ root: ROOT });
    expect(r.hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.token}`)).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.files).toBeGreaterThan(80);
  });

  it("fails when a role key literal is put back into a core file", () => {
    const root = fixture("planted", { "src/lib/x.ts": 'export const who = "new_member";\n' });
    const r = checkLiterals({ root, allow: [] });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ file: "src/lib/x.ts", line: 1, token: "new_member", kind: "role key" });
  });

  it("catches single quotes and backticks, pack ids, SQL, and nouns in any case, also in comments", () => {
    const hits = (text: string) => scanText("f", text, vocab).map((h) => `${h.kind}:${h.token}`);
    expect(hits("const a = 'president';")).toEqual(["role key:president"]);
    expect(hits("const a = `tech_lead`;")).toEqual(["role key:tech_lead"]);
    expect(hits('getPack("club")')).toEqual(["pack id:club"]);
    expect(hits("CHECK (approved_by = 'president')")).toEqual(["role key:president"]);
    expect(hits("// ask the club president about it")).toEqual(["pack noun:Club President"]);
    expect(hits("// what PRIYA actually did")).toEqual(["pack noun:Priya"]);
  });

  it("passes words that only contain a key: leaver_said, leaverRole, a sentence about the leaver", () => {
    const root = fixture("clean", {
      "src/lib/y.ts": [
        'export const t = "leaver_said";',
        "export const leaverRole = pack.leaverRole;",
        'const msg = "The leaver can never approve the handover.";',
        "const x = { leaver: true, president: 1 };",
        'const kind = "clubhouse";',
      ].join("\n"),
    });
    expect(checkLiterals({ root, allow: [] }).hits).toEqual([]);
  });

  it("an allow-list entry needs a reason, and one that matches nothing must be removed", () => {
    const root = fixture("allow", { "db/migrations/0001_x.sql": "pack_id text NOT NULL DEFAULT 'club',\n" });
    const ok = checkLiterals({ root, allow: [{ file: "db/migrations/0001_x.sql", token: "club", reason: "historic default" }] });
    expect(ok.hits).toEqual([]);
    expect(ok.allowed).toHaveLength(1);
    expect(ok.problems).toEqual([]);

    const noReason = checkLiterals({ root, allow: [{ file: "db/migrations/0001_x.sql", token: "club", reason: " " }] });
    expect(noReason.hits).toHaveLength(1);
    expect(noReason.problems.join(" ")).toMatch(/has no reason/);

    const stale = checkLiterals({ root, allow: [
      { file: "db/migrations/0001_x.sql", token: "club", reason: "historic default" },
      { file: "src/gone.ts", token: "leaver", reason: "was needed once" },
    ] });
    expect(stale.problems.join(" ")).toMatch(/matches nothing/);
  });
});
