// Golden values for the club demo, recorded on main at dc1041b BEFORE the pack refactor.
// The model cache key is sha256(model tag, system prompt, user prompt, schema name), so if these
// hashes hold, every extraction answer in data/demo/model_cache.json still replays.
//
// When a hash changes: stop. A prompt, a pack example, an entity or the demo data changed, and the
// committed cache no longer answers the demo. Either undo the change, or (only with the team's
// planned precompute) re-run scripts/precompute.ts and then refresh the values with
//   UPDATE_GOLDEN=1 pnpm vitest run tests/pack/golden.test.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACT_MAX_CHARS, extractionPack } from "@/lib/attest";
import { planBatches } from "@/lib/attest/core/extract";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/attest/core/prompts";
import { EXTRACTION_JSON_SCHEMA_NAME } from "@/lib/attest/core/schema";
import { cacheKey } from "@/lib/model/client";
import { getPack } from "@/lib/pack";
import { sourceIdFor } from "@/lib/pipeline/ingest";
import { loadDemoSources } from "@/lib/tether/demo";
import { ingestAll } from "@/lib/tether/ingest";

const GOLDEN_FILE = path.join(process.cwd(), "tests", "pack", "golden.club.json");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Golden {
  systemPromptSha256: string;
  userPromptSha256: string[];
  batchIds: string[];
  segmentIdsSha256: string;
  segmentCount: number;
}

function current() {
  const pack = getPack("club");
  const system = buildSystemPrompt(extractionPack(pack));
  const demo = loadDemoSources(pack.demo!.dataDir);
  const out = ingestAll(
    demo.map((d) => ({ kind: d.kind, name: d.name, roleSet: d.roleSet, files: d.files, sourceId: sourceIdFor(d.kind, d.name) })),
    { identityKey: "test-identity-key", contactsKey: "test-contacts-key" },
  );
  const names = Object.fromEntries(out.people.map((p) => [p.id, p.displayName]));
  // The pipeline reads segments back from Postgres, where `ts` is a timestamptz: it comes back as
  // Date.toISOString(). The prompt prints that form, so the same conversion is applied here.
  const segments = out.sources.flatMap((s) =>
    s.result.segments.map((seg) => ({ ...seg, sourceId: s.sourceId, ts: new Date(seg.ts).toISOString() })),
  );
  const batches = planBatches(segments, { roleOrder: pack.roleOrder, maxChars: EXTRACT_MAX_CHARS });
  const users = batches.map((b) => buildUserPrompt(b, { authorLabel: (id) => (id ? (names[id] ?? id) : "unknown") }));
  const golden: Golden = {
    systemPromptSha256: sha(system),
    userPromptSha256: users.map(sha),
    batchIds: batches.map((b) => b.id),
    segmentIdsSha256: sha(segments.map((s) => s.id).sort().join(",")),
    segmentCount: segments.length,
  };
  return { system, users, golden };
}

describe("club demo golden hashes (model cache keys stay stable)", () => {
  const now = current();
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN_FILE, JSON.stringify(now.golden, null, 2) + "\n");
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")) as Golden;

  it("the extraction system prompt for the club pack is byte for byte the recorded one", () => {
    expect(now.golden.systemPromptSha256).toBe(golden.systemPromptSha256);
  });

  it("the demo's segments, batches and user prompts are the recorded ones", () => {
    expect(now.golden.segmentCount).toBe(golden.segmentCount);
    expect(now.golden.segmentIdsSha256).toBe(golden.segmentIdsSha256);
    expect(now.golden.batchIds).toEqual(golden.batchIds);
    expect(now.golden.userPromptSha256).toEqual(golden.userPromptSha256);
  });

  it("every extraction batch of the club demo has its answer in the committed model cache", () => {
    const file = path.join(process.cwd(), getPack("club").demo!.dataDir, "model_cache.json");
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { input_hash: string; model_tag: string }[];
    const tags = [...new Set(rows.map((r) => r.model_tag))];
    expect(tags.length).toBe(1);
    const have = new Set(rows.map((r) => r.input_hash));
    const keys = now.users.map((u) => cacheKey(tags[0], now.system, u, EXTRACTION_JSON_SCHEMA_NAME));
    const missing = keys.filter((k) => !have.has(k));
    expect(keys.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
