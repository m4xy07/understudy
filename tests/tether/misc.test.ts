import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLevel } from "@/lib/tether/data-level";
import { fetchPublicRepo, GithubFetchError, parseRepoUrl } from "@/lib/tether/github-fetch";
import { loadDemoSources } from "@/lib/tether/demo";
import { ingestAll } from "@/lib/tether/ingest";
import { parseSource } from "@/lib/tether/adapters";
import { ctx, KEYS } from "./helpers";

describe("dataLevel", () => {
  it("climbs L0..L3", () => {
    expect(dataLevel([])).toBe("L0");
    expect(dataLevel(["interview"])).toBe("L0");
    expect(dataLevel(["tasks_csv"])).toBe("L1");
    expect(dataLevel(["tasks_csv", "whatsapp"])).toBe("L2");
    expect(dataLevel(["tasks_csv", "markdown", "slack"])).toBe("L2");
    expect(dataLevel(["tasks_csv", "slack", "github", "ics"])).toBe("L3");
  });
});

function mockFetch(routes: Record<string, { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key] : { status: 404, body: { message: "Not Found" } };
    const body = r.text ?? JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
}

describe("github-fetch", () => {
  it("parses repo urls", () => {
    expect(parseRepoUrl("https://github.com/club/firmware")).toEqual({ owner: "club", repo: "firmware" });
    expect(parseRepoUrl("github.com/club/firmware.git")).toEqual({ owner: "club", repo: "firmware" });
    expect(parseRepoUrl("https://github.com/club/firmware/tree/main/docs")).toEqual({ owner: "club", repo: "firmware" });
    expect(() => parseRepoUrl("https://gitlab.com/x/y")).toThrow(GithubFetchError);
  });

  it("reports missing/private repos and rate limits clearly", async () => {
    await expect(fetchPublicRepo("club/nope", { fetchImpl: mockFetch({}), token: "" })).rejects.toMatchObject({ code: "not_found" });
    const limited = mockFetch({ "https://api.github.com/repos/club/x": { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } } });
    await expect(fetchPublicRepo("club/x", { fetchImpl: limited, token: "" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("produces the demo github folder shape, parseable by the adapter", async () => {
    const api = "https://api.github.com/repos/club/fw";
    const f = mockFetch({
      [`${api}/commits?`]: { body: [
        { sha: "a".repeat(40), commit: { message: "firmware: deploy", author: { name: "Priya", email: "p@club.example", date: "2026-09-01T10:00:00Z" } } },
        { sha: "b".repeat(40), commit: { message: "docs", author: { name: "Arjun", email: "a@club.example", date: "2026-09-02T10:00:00Z" } } },
      ] },
      [`${api}/commits/${"a".repeat(40)}`]: { body: { files: [{ filename: "firmware/deploy.sh", status: "added" }] } },
      [`${api}/commits/${"b".repeat(40)}`]: { body: { files: [{ filename: "docs/x.md", status: "added" }] } },
      [`${api}/git/trees/`]: { body: { tree: [
        { path: "README.md", type: "blob", size: 100 },
        { path: ".github/workflows/ci.yml", type: "blob", size: 100 },
        { path: "docs/x.md", type: "blob", size: 100 },
        { path: "big.json", type: "blob", size: 900_000 },
        { path: "img.png", type: "blob", size: 10 },
      ] } },
      [api]: { body: { default_branch: "main", private: false } },
      "https://raw.githubusercontent.com/club/fw/main/README.md": { text: "# FW\n\nhello" },
      "https://raw.githubusercontent.com/club/fw/main/.github/workflows/ci.yml": { text: "on:\n  push: {}\n" },
      "https://raw.githubusercontent.com/club/fw/main/docs/x.md": { text: "# X\n\ny" },
    });
    const files = await fetchPublicRepo("https://github.com/club/fw", { fetchImpl: f, token: "" });
    expect(files.map((x) => x.path)).toEqual(["commits.json", "files/README.md", "files/.github/workflows/ci.yml", "files/docs/x.md"]);
    const commits = JSON.parse(files[0].content);
    expect(commits[0]).toMatchObject({ author_email: "p@club.example", files: [{ path: "firmware/deploy.sh", status: "added" }] });
    const r = parseSource("github", files, ctx());
    expect(r.segments.filter((s) => s.kind === "commit")).toHaveLength(2);
    expect(r.segments.some((s) => s.thread === "docs/x.md")).toBe(true);
  });
});

const DEMO = join(process.cwd(), "data", "demo", "sources.json");
describe.skipIf(!existsSync(DEMO))("demo pack", () => {
  it("parses every demo source and leaks no planted secret", async () => {
    const sources = loadDemoSources();
    const out = ingestAll(sources.map((s, i) => ({ ...s, sourceId: `demo-${i + 1}` })), KEYS);
    const text = out.sources.flatMap((s) => s.result.segments).map((s) => `${s.text}\n${JSON.stringify(s.meta)}`).join("\n");
    expect(out.sources.every((s) => s.result.segments.length > 0)).toBe(true);
    const gtPath = join(process.cwd(), "data", "demo", "ground_truth.json");
    if (existsSync(gtPath)) {
      const { readFileSync } = await import("node:fs");
      const gt = JSON.parse(readFileSync(gtPath, "utf8")) as { secrets?: (string | { value?: string })[] };
      for (const s of gt.secrets ?? []) {
        const v = typeof s === "string" ? s : s.value;
        if (v) expect(text.includes(v), `secret leaked: ${v.slice(0, 6)}...`).toBe(false);
      }
    }
  });
});
