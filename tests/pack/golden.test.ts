// Golden values for the demos. The club's Round 2 values were first recorded on main at dc1041b
// BEFORE the pack refactor; Round 3 added the two-pass prompt ("v2", the default) and the second demo.
// The model cache key is sha256(model tag, system prompt, user prompt, schema name), so if these
// hashes hold, every extraction answer in <demo.dataDir>/model_cache.json still replays, for the
// shipped variant and for the Round 2 fallback (ATTEST_PROMPT=r2).
//
// When a hash changes: stop. A prompt, a pack example, an entity or the demo data changed, and the
// committed cache no longer answers the demo. Either undo the change, or (only with the team's
// planned precompute) re-run scripts/precompute.ts (once per variant) and then refresh the values with
//   UPDATE_GOLDEN=1 pnpm vitest run tests/pack/golden.test.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACT_MAX_CHARS, EXTRACT_MAX_CHARS_V2, extractionPack } from "@/lib/attest";
import { planBatches } from "@/lib/attest/core/extract";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/attest/core/prompts";
import { DEFAULT_PROMPT_VARIANT, schemaNameFor, type PromptVariant } from "@/lib/attest/core/schema";
import { cacheKey, decodeCacheOutput } from "@/lib/model/client";
import { classifySegments, nameParts, packSensitivity, type SensitivityModelCall } from "@/lib/tether/sensitivity";
import { getPack, listDemoPacks } from "@/lib/pack";
import { sourceIdFor } from "@/lib/pipeline/ingest";
import { loadDemoSources } from "@/lib/tether/demo";
import { ingestAll } from "@/lib/tether/ingest";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const VARIANTS: readonly PromptVariant[] = ["r2", "v2"];

/** The prompts of one extraction variant: the batch size is part of the variant. */
interface VariantGolden {
  systemPromptSha256: string;
  userPromptSha256: string[];
  batchIds: string[];
}

/** The Round 2 prompt's values stay at the top level (the shape recorded before Round 3). */
interface Golden extends VariantGolden {
  segmentIdsSha256: string;
  segmentCount: number;
  /** Ids and narrowed role sets of the segments the content classifier limits (rules, then the cached model answers). */
  limitedSha256: string;
  limitedCount: number;
  /** The two-pass prompt (the default variant). */
  v2: VariantGolden;
}

const goldenFile = (packId: string) => path.join(process.cwd(), "tests", "pack", `golden.${packId}.json`);
const cacheFile = (packId: string) => path.join(process.cwd(), getPack(packId).demo!.dataDir, "model_cache.json");

/** The classifier's model call, answered only from the committed cache file (no database, no network). */
function committedCacheCall(packId: string): SensitivityModelCall {
  const rows = JSON.parse(fs.readFileSync(cacheFile(packId), "utf8")) as { input_hash: string; model_tag: string; output: unknown }[];
  const byHash = new Map(rows.map((r) => [r.input_hash, r]));
  const tag = rows[0]?.model_tag ?? "";
  return async (o) => {
    const row = byHash.get(cacheKey(tag, o.system, `${o.user.trimEnd()}\n/no_think`, o.jsonSchemaName));
    if (!row) return { ok: false, error: "not in the committed cache" };
    return { ok: true, cached: true, data: decodeCacheOutput(row.output) as never };
  };
}

async function current(packId: string) {
  const pack = getPack(packId);
  const xpack = extractionPack(pack);
  const demo = loadDemoSources(pack.demo!.dataDir);
  const out = ingestAll(
    demo.map((d) => ({ kind: d.kind, name: d.name, roleSet: d.roleSet, files: d.files, sourceId: sourceIdFor(d.kind, d.name) })),
    { identityKey: "test-identity-key", contactsKey: "test-contacts-key" },
  );
  const names = Object.fromEntries(out.people.map((p) => [p.id, p.displayName]));
  // The pipeline reads segments back from Postgres, where `ts` is a timestamptz: it comes back as
  // Date.toISOString(). The prompt prints that form, so the same conversion is applied here.
  const parsed = out.sources.flatMap((s) =>
    s.result.segments.map((seg) => ({ ...seg, sourceId: s.sourceId, ts: new Date(seg.ts).toISOString() })),
  );
  // The pipeline narrows sensitive segments before it stores them, so the batches extraction
  // plans are the batches of the narrowed role sets. Same classifier, answers from the cache file.
  const authorNames = Object.fromEntries(out.people.map((p) => [p.id, nameParts([p.displayName, ...p.aliases])]));
  const classified = await classifySegments(parsed, packSensitivity(pack), {
    knownNames: nameParts(out.people.flatMap((p) => [p.displayName, ...p.aliases])), authorNames, call: committedCacheCall(packId),
  });
  const segments = classified.segments;
  const limited = segments.filter((s) => s.roleSetOriginal).map((s) => `${s.id}:${s.roleSet.join(",")}:${s.sensitivityStage}`).sort();
  const perVariant = (variant: PromptVariant) => {
    const system = buildSystemPrompt(xpack, variant);
    const batches = planBatches(segments, { roleOrder: pack.roleOrder, maxChars: variant === "v2" ? EXTRACT_MAX_CHARS_V2 : EXTRACT_MAX_CHARS });
    const users = batches.map((b) => buildUserPrompt(b, { authorLabel: (id) => (id ? (names[id] ?? id) : "unknown"), variant }));
    const golden: VariantGolden = { systemPromptSha256: sha(system), userPromptSha256: users.map(sha), batchIds: batches.map((b) => b.id) };
    return { system, users, golden };
  };
  const r2 = perVariant("r2");
  const v2 = perVariant("v2");
  const golden: Golden = {
    ...r2.golden,
    segmentIdsSha256: sha(segments.map((s) => s.id).sort().join(",")),
    segmentCount: segments.length,
    limitedSha256: sha(limited.join("|")),
    limitedCount: limited.length,
    v2: v2.golden,
  };
  return { prompts: { r2, v2 }, golden, held: classified.report.held };
}

it("the shipped extraction variant is the two-pass prompt, and both variants are guarded here", () => {
  expect(DEFAULT_PROMPT_VARIANT).toBe("v2");
  expect(VARIANTS).toContain(DEFAULT_PROMPT_VARIANT);
});

for (const { id: packId } of listDemoPacks()) {
  const now = await current(packId);

  describe(`${packId} demo golden hashes (model cache keys stay stable)`, () => {
    if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(goldenFile(packId), JSON.stringify(now.golden, null, 2) + "\n");
    const golden = JSON.parse(fs.readFileSync(goldenFile(packId), "utf8")) as Golden;
    const recorded = (variant: PromptVariant): VariantGolden => (variant === "v2" ? golden.v2 : golden);

    it("the demo's segments are the recorded ones", () => {
      expect(now.golden.segmentCount).toBe(golden.segmentCount);
      expect(now.golden.segmentIdsSha256).toBe(golden.segmentIdsSha256);
    });

    it("the content classifier limits the recorded segments, with every borderline answer in the committed cache", () => {
      expect(now.held).toBe(0);
      expect(now.golden.limitedCount).toBe(golden.limitedCount);
      expect(now.golden.limitedSha256).toBe(golden.limitedSha256);
    });

    for (const variant of VARIANTS) {
      const label = variant === DEFAULT_PROMPT_VARIANT ? `${variant} (shipped)` : `${variant} (fallback)`;

      it(`${label}: the extraction system prompt is byte for byte the recorded one`, () => {
        expect(now.prompts[variant].golden.systemPromptSha256).toBe(recorded(variant).systemPromptSha256);
      });

      it(`${label}: the batches and user prompts are the recorded ones`, () => {
        expect(now.prompts[variant].golden.batchIds).toEqual(recorded(variant).batchIds);
        expect(now.prompts[variant].golden.userPromptSha256).toEqual(recorded(variant).userPromptSha256);
      });

      it(`${label}: every extraction batch has its answer in the committed model cache`, () => {
        const rows = JSON.parse(fs.readFileSync(cacheFile(packId), "utf8")) as { input_hash: string; model_tag: string }[];
        const tags = [...new Set(rows.map((r) => r.model_tag))];
        expect(tags.length).toBe(1);
        const have = new Set(rows.map((r) => r.input_hash));
        const { system, users } = now.prompts[variant];
        const keys = users.map((u) => cacheKey(tags[0], system, u, schemaNameFor(variant)));
        const missing = keys.filter((k) => !have.has(k));
        expect(keys.length).toBeGreaterThan(10);
        expect(missing).toEqual([]);
      });
    }
  });
}
