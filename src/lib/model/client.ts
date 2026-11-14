// OpenAI-compatible chat client with a content-addressed cache (docs/ARCHITECTURE.md section 0).
// Every model call in Understudy goes through callJson(). It never throws to callers:
// failures come back as { ok: false, error } so the step can continue on deterministic paths.
// The model never sets labels, roles, statuses, scores or approvals; callers validate output.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { z } from "zod";
import { db } from "@/lib/db/client";

export type CallResult<T> =
  | { ok: true; data: T; cached: boolean }
  | { ok: false; error: string; transient?: boolean; refused?: boolean };

/** What one callJson did, as reported to a ModelContext. */
export type CallOutcome = "cached" | "live" | "failed" | "deferred" | "refused";

/**
 * Limits for every callJson made inside runWithModelContext(ctx, fn), however deep (extraction,
 * support check, stand-in). Cached answers are always served; the limits only stop new live calls.
 *   deadline  no live call starts after this time: the call returns { ok: false, error: DEFERRED }.
 *   retries   replaces the per-call retry count (a sliced run retries across slices, not inside one).
 *   gate      asked before each live call; a string refuses the call with that message (spend cap).
 *   onResult  told the outcome of every call (progress counts).
 */
export interface ModelContext {
  deadline?: number;
  retries?: number;
  gate?: (key: string) => Promise<string | null>;
  onResult?: (key: string, outcome: CallOutcome, info: { error?: string; transient?: boolean }) => void;
}

export const DEFERRED_ERROR = "not in cache yet: the live model call was left for later";

const ctxStore = globalThis as unknown as { __usModelCtx?: AsyncLocalStorage<ModelContext> };
function contexts(): AsyncLocalStorage<ModelContext> {
  if (!ctxStore.__usModelCtx) ctxStore.__usModelCtx = new AsyncLocalStorage<ModelContext>();
  return ctxStore.__usModelCtx;
}

/** Run `fn` with limits on the live model calls it makes. Nested contexts replace the outer one. */
export function runWithModelContext<T>(ctx: ModelContext, fn: () => Promise<T>): Promise<T> {
  return contexts().run(ctx, fn);
}

export function currentModelContext(): ModelContext | undefined {
  return contexts().getStore();
}

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
  /** Per-request timeout (default DEFAULT_TIMEOUT_MS). Each retry gets the full timeout again. */
  timeoutMs?: number;
  /** Retries after a transient failure (timeout, 429, 5xx, network); default DEFAULT_RETRIES. */
  retries?: number;
}

/** OpenRouter can take well over a minute for a long JSON answer when its providers are busy. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Completion cap sent as max_tokens. Without it OpenRouter reserves the model's whole context
 * (~117k tokens) per request and answers HTTP 402 once the account's credit is low. The longest
 * answers (extraction of a 5,000-character batch) are ~2,000 tokens.
 */
export const DEFAULT_MAX_TOKENS = 4_096;
export const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
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

/**
 * The text a cache row holds for `output`: writeCache stores JSON.stringify(output) as a jsonb
 * *string*, and a demo's model_cache.json exports that string as read back. A string output is
 * therefore already this text and is not encoded again (scripts/seed.ts uses this).
 */
export function cacheOutputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/**
 * Decode a model_cache.output value back to the answer. Unwraps JSON text up to three levels:
 * rows seeded before the seed used cacheOutputText() were encoded twice and never matched a schema.
 */
export function decodeCacheOutput(value: unknown): unknown {
  let output = value;
  for (let i = 0; i < 3 && typeof output === "string"; i++) {
    try {
      output = JSON.parse(output);
    } catch {
      break; // a plain string answer: keep as is
    }
  }
  return output;
}

async function readCache(key: string): Promise<unknown | undefined> {
  if (memory.has(key)) return memory.get(key);
  try {
    const rows = await db()`SELECT output FROM model_cache WHERE input_hash = ${key}`;
    if (rows[0]) {
      const output = decodeCacheOutput(rows[0].output);
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

type ChatResult = { ok: true; content: string } | { ok: false; status: number; error: string; retryAfterMs?: number };

/** Failures worth another try with the same prompt: timeouts, rate limits, 5xx, dropped connections, empty replies. */
export function isTransientFailure(status: number, error: string): boolean {
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return true;
  if (status !== 0) return false;
  return /timed out|timeout|abort|fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|empty model response/i.test(error);
}

/** Exponential backoff with jitter (2 s, 4 s, 8 s ... capped), or the server's Retry-After when it is longer. */
export function backoffMs(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  const jittered = Math.round(exp * (0.75 + 0.5 * random()));
  return Math.min(RETRY_MAX_MS, Math.max(jittered, retryAfterMs ?? 0));
}

/** Seconds or an HTTP date, as in a Retry-After header; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Run `attempt` until it succeeds, fails for good, or `retries` transient failures were retried.
 * Same prompt every time, so a late success lands under the same cache key. Exported for tests.
 */
export async function withRetries(
  attempt: () => Promise<ChatResult>,
  opts: { retries: number; sleep?: (ms: number) => Promise<void>; random?: () => number },
): Promise<ChatResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let res = await attempt();
  for (let i = 0; i < opts.retries && !res.ok && isTransientFailure(res.status, res.error); i++) {
    await sleep(backoffMs(i, res.retryAfterMs, opts.random));
    res = await attempt();
  }
  return res;
}

async function chat(
  system: string,
  user: string,
  format: ResponseFormatMode,
  schemaName: string,
  jsonSchema: unknown,
  temperature: number,
  timeoutMs: number,
): Promise<ChatResult> {
  const { baseUrl, name, apiKey } = cfg();
  const body: Record<string, unknown> = {
    model: name,
    temperature,
    max_tokens: DEFAULT_MAX_TOKENS,
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      };
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
 * name) in memory and in model_cache. "/no_think" is appended to the user prompt. Each request
 * has its own timeout (default 120 s); transient failures (timeout, 429, 5xx, network) are retried
 * with backoff (default 3 retries); one more try on invalid JSON. Never throws.
 */
export async function callJson<T>(opts: CallOpts<T>): Promise<CallResult<T>> {
  const ctx = currentModelContext();
  const res = await callJsonInner(opts, ctx);
  if (rec.__usModelRecord || ctx?.onResult) {
    const user = opts.user.trimEnd().endsWith("/no_think") ? opts.user : `${opts.user.trimEnd()}\n/no_think`;
    const key = cacheKey(modelTag(), opts.system, user, opts.jsonSchemaName);
    if (rec.__usModelRecord) noteCall(key, res.ok ? (res.cached ? "cached" : "live") : "failed", res.ok ? undefined : res.error);
    if (ctx?.onResult) {
      try {
        if (res.ok) ctx.onResult(key, res.cached ? "cached" : "live", {});
        else {
          const outcome: CallOutcome = res.error === DEFERRED_ERROR ? "deferred" : res.refused ? "refused" : "failed";
          ctx.onResult(key, outcome, { error: res.error, transient: res.transient === true });
        }
      } catch {
        // a progress callback never fails a model call
      }
    }
  }
  return res;
}

async function callJsonInner<T>(opts: CallOpts<T>, ctx?: ModelContext): Promise<CallResult<T>> {
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
    // Limits of the surrounding run or action: only live calls are held back, never cached answers.
    if (ctx?.deadline !== undefined && Date.now() >= ctx.deadline) return { ok: false, error: DEFERRED_ERROR };
    if (ctx?.gate) {
      const refusal = await ctx.gate(key);
      if (refusal) return { ok: false, error: refusal, refused: true };
    }

    let jsonSchema: unknown = opts.jsonSchema;
    if (!jsonSchema) {
      try {
        jsonSchema = z.toJSONSchema(opts.schema as ZodType);
      } catch {
        jsonSchema = { type: "object" };
      }
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = Math.max(0, Math.floor(ctx?.retries ?? opts.retries ?? DEFAULT_RETRIES));
    const ask = () =>
      withRetries(
        () => chat(opts.system, user, preferredFormat, opts.jsonSchemaName, jsonSchema, opts.temperature ?? 0, timeoutMs),
        { retries },
      );
    let lastError = "invalid JSON";
    for (let attempt = 0; attempt < 2; attempt++) {
      let res = await ask();
      // Endpoints without json_schema support answer 400/422: fall back once, remember it.
      while (!res.ok && (res.status === 400 || res.status === 422) && preferredFormat !== "none") {
        preferredFormat = preferredFormat === "json_schema" ? "json_object" : "none";
        res = await ask();
      }
      if (!res.ok) return { ok: false, error: res.error, transient: isTransientFailure(res.status, res.error) };
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
