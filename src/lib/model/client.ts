// OpenAI-compatible chat client with a content-addressed cache (docs/ARCHITECTURE.md section 0).
// Every model call in Understudy goes through callJson(). It never throws to callers:
// failures come back as { ok: false, error } so the step can continue on deterministic paths.
// The model never sets labels, roles, statuses, scores or approvals; callers validate output.
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { z } from "zod";
import { db } from "@/lib/db/client";

export type CallResult<T> =
  | { ok: true; data: T; cached: boolean }
  | { ok: false; error: string };

export interface CallOpts<T> {
  system: string;
  user: string;
  schema: ZodType<T>;
  jsonSchemaName: string;
  /** Hand-written JSON Schema sent as response_format json_schema; when absent one is derived from `schema`. */
  jsonSchema?: Record<string, unknown>;
  temperature?: 0;
  /** Skip the network: return a cached answer or { ok: false } (used for replay-only runs). */
  cacheOnly?: boolean;
}

const TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TTL_MS = 30_000;

/**
 * MODEL_DISABLED=1 (set for every vitest run): never touch the network. callJson answers from the
 * cache or returns { ok: false, error: "model disabled in tests" }; modelAvailable() is false.
 */
export function modelDisabled(): boolean {
  const v = (process.env.MODEL_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function cfg() {
  return {
    baseUrl: (process.env.MODEL_BASE_URL ?? "").replace(/\/+$/, ""),
    name: process.env.MODEL_NAME ?? "",
    apiKey: process.env.MODEL_API_KEY ?? "",
  };
}

/** `${MODEL_NAME}@${host}`: part of every cache key, so a different model never reuses answers. */
export function modelTag(): string {
  const { baseUrl, name } = cfg();
  let host = "unset";
  try {
    host = baseUrl ? new URL(baseUrl).host : "unset";
  } catch {
    host = baseUrl || "unset";
  }
  return `${name || "unset"}@${host}`;
}

export function cacheKey(tag: string, system: string, user: string, schemaName: string): string {
  return createHash("sha256").update(`${tag}\n${system}\n${user}\n${schemaName}`).digest("hex");
}

const memory = new Map<string, unknown>();

/** Every callJson in this process, while scripts/precompute.ts records (keys to export, hit counts). */
export interface CallRecord {
  keys: Set<string>;
  calls: number;
  cached: number;
  live: number;
  failed: number;
  errors: string[];
}

const rec = globalThis as unknown as { __usModelRecord?: CallRecord | null };

/** Start recording every callJson cache key and outcome (scripts only). */
export function startRecording(): CallRecord {
  rec.__usModelRecord = { keys: new Set(), calls: 0, cached: 0, live: 0, failed: 0, errors: [] };
  return rec.__usModelRecord;
}

export function stopRecording(): CallRecord {
  const r = rec.__usModelRecord ?? { keys: new Set<string>(), calls: 0, cached: 0, live: 0, failed: 0, errors: [] };
  rec.__usModelRecord = null;
  return r;
}

function noteCall(key: string, outcome: "cached" | "live" | "failed", error?: string): void {
  const r = rec.__usModelRecord;
  if (!r) return;
  r.keys.add(key);
  r.calls++;
  r[outcome]++;
  if (error && r.errors.length < 10 && !r.errors.includes(error)) r.errors.push(error);
}

async function readCache(key: string): Promise<unknown | undefined> {
  if (memory.has(key)) return memory.get(key);
  try {
    const rows = await db()`SELECT output FROM model_cache WHERE input_hash = ${key}`;
    if (rows[0]) {
      // writeCache/seed store JSON.stringify(output) as a jsonb *string*; decode it back.
      let output: unknown = rows[0].output;
      if (typeof output === "string") {
        try {
          output = JSON.parse(output);
        } catch {
          // a plain string answer: keep as is
        }
      }
      memory.set(key, output);
      return output;
    }
  } catch {
    // cache table unavailable: behave as a miss
  }
  return undefined;
}

async function writeCache(key: string, tag: string, output: unknown): Promise<void> {
  memory.set(key, output);
  try {
    await db()`
      INSERT INTO model_cache (input_hash, model_tag, output)
      VALUES (${key}, ${tag}, ${JSON.stringify(output)}::jsonb)
      ON CONFLICT (input_hash) DO NOTHING`;
  } catch {
    // a failed cache write never fails the call
  }
}

/** Removes <think>…</think> blocks and code fences, then extracts the outermost JSON value. */
export function extractJson(text: string): unknown {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error("no JSON in model output");
  }
}

type ResponseFormatMode = "json_schema" | "json_object" | "none";
let preferredFormat: ResponseFormatMode = "json_schema";

async function chat(
  system: string,
  user: string,
  format: ResponseFormatMode,
  schemaName: string,
  jsonSchema: unknown,
  temperature: number,
): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  const { baseUrl, name, apiKey } = cfg();
  const body: Record<string, unknown> = {
    model: name,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (format === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64), strict: false, schema: jsonSchema },
    };
  } else if (format === "json_object") {
    body.response_format = { type: "json_object" };
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, status: 0, error: "empty model response" };
    return { ok: true, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: /timeout|abort/i.test(msg) ? "model timed out" : msg };
  }
}

/**
 * Ask the model for JSON matching `schema`. Cached by sha256(model tag + system + user + schema
 * name) in memory and in model_cache. "/no_think" is appended to the user prompt. One retry
 * on invalid JSON. Never throws.
 */
export async function callJson<T>(opts: CallOpts<T>): Promise<CallResult<T>> {
  const res = await callJsonInner(opts);
  if (rec.__usModelRecord) {
    const user = opts.user.trimEnd().endsWith("/no_think") ? opts.user : `${opts.user.trimEnd()}\n/no_think`;
    noteCall(cacheKey(modelTag(), opts.system, user, opts.jsonSchemaName), res.ok ? (res.cached ? "cached" : "live") : "failed", res.ok ? undefined : res.error);
  }
  return res;
}

async function callJsonInner<T>(opts: CallOpts<T>): Promise<CallResult<T>> {
  try {
    const tag = modelTag();
    const user = opts.user.trimEnd().endsWith("/no_think") ? opts.user : `${opts.user.trimEnd()}\n/no_think`;
    const key = cacheKey(tag, opts.system, user, opts.jsonSchemaName);

    const hit = await readCache(key);
    if (hit !== undefined) {
      const parsed = opts.schema.safeParse(hit);
      if (parsed.success) return { ok: true, data: parsed.data, cached: true };
    }
    if (opts.cacheOnly) return { ok: false, error: "not in cache" };
    if (modelDisabled()) return { ok: false, error: "model disabled in tests" };
    if (!cfg().baseUrl || !cfg().name) return { ok: false, error: "model not configured" };

    let jsonSchema: unknown = opts.jsonSchema;
    if (!jsonSchema) {
      try {
        jsonSchema = z.toJSONSchema(opts.schema as ZodType);
      } catch {
        jsonSchema = { type: "object" };
      }
    }

    let lastError = "invalid JSON";
    for (let attempt = 0; attempt < 2; attempt++) {
      let res = await chat(opts.system, user, preferredFormat, opts.jsonSchemaName, jsonSchema, opts.temperature ?? 0);
      // Endpoints without json_schema support answer 400/422: fall back once, remember it.
      while (!res.ok && (res.status === 400 || res.status === 422) && preferredFormat !== "none") {
        preferredFormat = preferredFormat === "json_schema" ? "json_object" : "none";
        res = await chat(opts.system, user, preferredFormat, opts.jsonSchemaName, jsonSchema, opts.temperature ?? 0);
      }
      if (!res.ok) return { ok: false, error: res.error };
      try {
        const raw = extractJson(res.content);
        const parsed = opts.schema.safeParse(raw);
        if (parsed.success) {
          await writeCache(key, tag, parsed.data);
          return { ok: true, data: parsed.data, cached: false };
        }
        lastError = `schema mismatch: ${parsed.error.issues[0]?.message ?? "invalid"}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "invalid JSON";
      }
    }
    return { ok: false, error: lastError };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let probe: { at: number; ok: boolean } | null = null;

/** Quick reachability probe of the model endpoint (3 s timeout), memoised for 30 s. */
export async function modelAvailable(): Promise<boolean> {
  if (modelDisabled()) return false;
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
  const { baseUrl, apiKey } = cfg();
  let ok = false;
  if (baseUrl) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
  }
  probe = { at: Date.now(), ok };
  return ok;
}
