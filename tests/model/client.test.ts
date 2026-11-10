// Tests never call the live model: vitest.config.mts sets MODEL_DISABLED=1 for every run.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  cacheKey,
  cacheOutputText,
  callJson,
  decodeCacheOutput,
  modelAvailable,
  modelDisabled,
  modelTag,
} from "@/lib/model/client";

afterAll(async () => {
  vi.unstubAllGlobals();
  await db().end();
});

describe("model client in tests", () => {
  it("is disabled: no probe, no network, a fast typed failure on a cache miss", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(process.env.MODEL_DISABLED).toBe("1");
    expect(modelDisabled()).toBe(true);
    expect(await modelAvailable()).toBe(false);
    const res = await callJson({
      system: "test system",
      user: `a prompt no cache holds ${Date.now()} ${Math.random()}`,
      schema: z.object({ ok: z.boolean() }),
      jsonSchemaName: "model_disabled_probe",
    });
    expect(res).toEqual({ ok: false, error: "model disabled in tests" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Regression: production seeded data/demo/model_cache.json with JSON.stringify(output), where output
// was already the JSON text read back from the table. Every seeded row was encoded twice, failed the
// schema on read, counted as a miss, and ON CONFLICT DO NOTHING kept the broken row: each fresh demo
// read 23 batches with 0 from the cache.
describe("model cache rows from db:seed", () => {
  const schema = z.object({ claims: z.array(z.object({ value: z.string() })) });
  const answer = { claims: [{ value: "Lab B-204" }] };
  const hashes: string[] = [];

  afterAll(async () => {
    if (hashes.length) await db()`DELETE FROM model_cache WHERE input_hash = ANY(${hashes}::text[])`;
  });

  async function seeded(text: string) {
    const user = `seeded row probe ${Date.now()} ${Math.random()}`;
    const key = cacheKey(modelTag(), "seed system", `${user}\n/no_think`, "seed_probe");
    hashes.push(key);
    await db()`INSERT INTO model_cache (input_hash, model_tag, output) VALUES (${key}, ${modelTag()}, ${text}::jsonb)`;
    return callJson({ system: "seed system", user, schema, jsonSchemaName: "seed_probe", cacheOnly: true });
  }

  it("replays a row stored the way db:seed stores an exported output", async () => {
    const exported = JSON.stringify(answer); // what model_cache.json holds: the JSON text
    expect(await seeded(cacheOutputText(exported))).toEqual({ ok: true, data: answer, cached: true });
  });

  it("replays a row an older seed encoded twice", async () => {
    expect(await seeded(JSON.stringify(JSON.stringify(answer)))).toEqual({ ok: true, data: answer, cached: true });
  });

  it("decodes every committed demo row to an object after the seed round trip", () => {
    const file = path.join(process.cwd(), "data", "demo", "model_cache.json");
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { input_hash: string; output: unknown }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const out = decodeCacheOutput(cacheOutputText(r.output));
      expect(typeof out, r.input_hash).toBe("object");
      expect(out, r.input_hash).not.toBeNull();
    }
  });
});
