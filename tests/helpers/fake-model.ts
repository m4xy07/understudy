// A fake OpenAI-compatible endpoint for tests that exercise the real model client (cache,
// retries, deadlines, spend cap) without a network. Install with useFakeModel(); it points the
// client at http://fake-model.test and stubs global fetch. Every answer is cached under a model
// tag unique to the test file, removed again by cleanup().
import { vi } from "vitest";
import { db } from "@/lib/db/client";

export interface FakeModel {
  /** Chat calls that reached the "network", in order (user prompt text). */
  calls: string[];
  /** Milliseconds each chat call takes. */
  delayMs: number;
  /** Prompts for which the endpoint answers HTTP 500 (a passing failure). */
  failWhen: (user: string) => boolean;
  /** Remove this fake's cache rows and restore fetch and the environment. */
  cleanup: () => Promise<void>;
}

export function useFakeModel(name: string): FakeModel {
  const saved = {
    disabled: process.env.MODEL_DISABLED,
    base: process.env.MODEL_BASE_URL,
    model: process.env.MODEL_NAME,
    key: process.env.MODEL_API_KEY,
  };
  process.env.MODEL_DISABLED = "0";
  process.env.MODEL_BASE_URL = "http://fake-model.test/v1";
  process.env.MODEL_NAME = name;
  process.env.MODEL_API_KEY = "";
  const fake: FakeModel = {
    calls: [],
    delayMs: 0,
    failWhen: () => false,
    cleanup: async () => {
      vi.unstubAllGlobals();
      for (const [k, v] of [["MODEL_DISABLED", saved.disabled], ["MODEL_BASE_URL", saved.base], ["MODEL_NAME", saved.model], ["MODEL_API_KEY", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await db()`DELETE FROM model_cache WHERE model_tag = ${`${name}@fake-model.test`}`;
    },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return json({ data: [] });
    if (!url.endsWith("/chat/completions")) return json({ error: "unknown" }, 404);
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    fake.calls.push(user);
    if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
    if (fake.failWhen(user)) return json({ error: "upstream busy" }, 500);
    // One deterministic claim per extraction batch, named after its thread; anything else gets
    // an empty object (callers then fall back to their rule-based paths).
    const thread = /^Thread: (.*)$/m.exec(user)?.[1];
    const content = thread
      ? { claims: [{ entity: "other", attribute: "status", value: `read ${thread}`, statement: `The note ${thread} was read.`, citations: [{ segment_id: "none", quote: null }] }] }
      : {};
    return json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  });
  return fake;
}
