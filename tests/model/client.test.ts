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
  backoffMs,
  isTransientFailure,
  parseRetryAfter,
  withRetries,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
} from "@/lib/model/client";

describe("model client retries", () => {
  type R = { ok: true; content: string } | { ok: false; status: number; error: string; retryAfterMs?: number };
  const seq = (...rs: R[]) => {
    let i = 0;
    return vi.fn(async () => rs[Math.min(i++, rs.length - 1)]);
  };
  const noSleep = vi.fn(async () => {});

  it("defaults: 120 s per request, 3 retries", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_RETRIES).toBe(3);
  });

  it("classifies timeouts, 408/429/5xx and network drops as transient; 400/401/422 and bad JSON are not", () => {
    expect(isTransientFailure(0, "model timed out")).toBe(true);
    expect(isTransientFailure(0, "fetch failed")).toBe(true);
    expect(isTransientFailure(0, "empty model response")).toBe(true);
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isTransientFailure(s, `HTTP ${s}`)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isTransientFailure(s, `HTTP ${s}`)).toBe(false);
    expect(isTransientFailure(0, "no JSON in model output")).toBe(false);
  });

  it("backs off exponentially with jitter, capped, and honours a longer Retry-After", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 10].map((a) => backoffMs(a, undefined, mid))).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(backoffMs(0, undefined, () => 0)).toBe(1500);
    expect(backoffMs(0, 9000, mid)).toBe(9000);
    expect(backoffMs(0, 120_000, mid)).toBe(30_000);
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("retries transient failures until one succeeds", async () => {
    const attempt = seq(
      { ok: false, status: 0, error: "model timed out" },
      { ok: false, status: 429, error: "HTTP 429", retryAfterMs: 1000 },
      { ok: false, status: 503, error: "HTTP 503" },
      { ok: true, content: "{}" },
    );
    const sleep = vi.fn(async () => {});
    const res = await withRetries(attempt, { retries: 3, sleep, random: () => 0.5 });
    expect(res).toEqual({ ok: true, content: "{}" });
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([2000, 4000, 8000]);
  });

  it("gives up after the retry budget and returns the last failure", async () => {
    const attempt = seq({ ok: false, status: 0, error: "model timed out" });
    const res = await withRetries(attempt, { retries: 2, sleep: noSleep });
    expect(res).toMatchObject({ ok: false, error: "model timed out" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("never retries a permanent failure", async () => {
    const attempt = seq({ ok: false, status: 401, error: "HTTP 401" });
    await withRetries(attempt, { retries: 3, sleep: noSleep });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

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
