// "Zero core code changes" for the second setting, proven from the git history
// (docs/round3/ZERO_CORE_CHANGES.md names the commits). Skips on a shallow clone.
import { describe, expect, it } from "vitest";
import { checkZeroCore } from "../../scripts/check-zero-core";
import { packVocabulary, scanText } from "../../scripts/check-literals";

const report = checkZeroCore(process.cwd());

describe("adding the second setting needed no setting-specific core code", () => {
  it("the document names the base, the pack branch, the head and the pack", () => {
    expect([report.base, report.pack, report.head, report.packId].every(Boolean)).toBe(true);
  });

  it.skipIf(Boolean(report.skipped))("the pack's branch changed no core file", () => {
    expect(report.packBranchCore).toEqual([]);
  });

  it.skipIf(Boolean(report.skipped))("every core file changed since the base is explained in the document", () => {
    expect(report.undocumented).toEqual([]);
    expect(report.migrations).toEqual([]);
  });

  it.skipIf(Boolean(report.skipped))("no line added to core names the pack, its roles or its people", () => {
    expect(report.addedLines).toBeGreaterThan(0);
    expect(report.hits).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it("the scanner would catch a line that names the added pack", () => {
    const vocab = packVocabulary(process.cwd(), [report.packId]);
    const role = vocab.roleKeys[0];
    expect(scanText("src/x.ts", `if (role === "${role}") return true;`, vocab).length).toBe(1);
    expect(scanText("src/x.ts", `if (pack.id === "${report.packId}") return true;`, vocab).length).toBe(1);
    expect(scanText("src/x.ts", "if (role === pack.approverRole) return true;", vocab)).toEqual([]);
  });
});
