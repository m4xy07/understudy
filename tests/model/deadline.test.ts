// Review findings 4 and 9: a model call made inside a slice or a server action cannot run past
// that slice's or action's limit. The request timeout is cut to what is left before the hard
// deadline, and the second try (after invalid JSON, or a retry) does not start after the deadline.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { callJson, MIN_REQUEST_MS, runWithModelContext, withRetries } from "@/lib/model/client";

const NAME = "fake-deadline";
const saved = { ...process.env };
let calls = 0;
let delayMs = 0;
let reply: () => Response = () => json({ choices: [{ message: { content: "{\"wrong\": true}" } }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const schema = z.strictObject({ answer: z.string() });
let n = 0;
const ask = () => callJson({ system: "s", user: `deadline test ${Date.now()} ${n++}`, schema, jsonSchemaName: "deadline_test", retries: 0 });

beforeAll(() => {
  process.env.MODEL_DISABLED = "0";
  process.env.MODEL_BASE_URL = "http://fake-model.test/v1";
  process.env.MODEL_NAME = NAME;
  process.env.MODEL_API_KEY = "";
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    // Like a real slow endpoint: answers after delayMs unless the request is aborted first.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      });
    });
    return reply();
  });
});

afterEach(() => {
  calls = 0;
  delayMs = 0;
  reply = () => json({ choices: [{ message: { content: "{\"wrong\": true}" } }] });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of ["MODEL_DISABLED", "MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await db()`DELETE FROM model_cache WHERE model_tag = ${`${NAME}@fake-model.test`}`;
  await db().end();
});

describe("a model call inside a slice or an action", () => {
  it("without a context: invalid JSON is tried once more (two requests), as before", async () => {
    const res = await ask();
    expect(res.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it("the second try does not start once the deadline has passed", async () => {
    delayMs = 80;
    const res = await runWithModelContext({ deadline: Date.now() + 40, retries: 0 }, ask);
    expect(res.ok).toBe(false);
    expect(calls).toBe(1); // it used to be 2: a second request of up to 120 s after the slice's time was up
  });

  it("a request is cut off at the hard deadline, not at its own 120 s timeout", async () => {
    delayMs = 5_000;
    const started = Date.now();
    const res = await runWithModelContext({ deadline: started + 10_000, hardDeadline: started + MIN_REQUEST_MS + 300, retries: 0 }, ask);
    const took = Date.now() - started;
    expect(res).toMatchObject({ ok: false, error: "model timed out", transient: true });
    expect(took).toBeLessThan(3_000);
    expect(calls).toBe(1);
  });

  it("with less than a second left before the hard deadline no request is sent at all", async () => {
    const res = await runWithModelContext({ deadline: Date.now() + 10_000, hardDeadline: Date.now() + 200, retries: 0 }, ask);
    expect(res).toMatchObject({ ok: false, error: "model timed out" });
    expect(calls).toBe(0);
  });

  it("a valid answer inside the limits is returned and cached as usual", async () => {
    reply = () => json({ choices: [{ message: { content: "{\"answer\": \"yes\"}" } }] });
    const now = Date.now();
    const res = await runWithModelContext({ deadline: now + 10_000, hardDeadline: now + 20_000, retries: 0 }, ask);
    expect(res).toMatchObject({ ok: true, data: { answer: "yes" }, cached: false });
    expect(calls).toBe(1);
  });

  it("no retry starts when its backoff would end after the deadline", async () => {
    let attempts = 0;
    const failing = async () => {
      attempts++;
      return { ok: false as const, status: 503, error: "HTTP 503" };
    };
    await withRetries(failing, { retries: 3, sleep: async () => {}, until: Date.now() + 100 });
    expect(attempts).toBe(1); // the first backoff is 1.5 s or more
    attempts = 0;
    await withRetries(failing, { retries: 3, sleep: async () => {} });
    expect(attempts).toBe(4); // no deadline: unchanged
  });
});
