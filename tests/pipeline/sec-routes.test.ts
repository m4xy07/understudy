// Security review regressions at the route and action layer (no database: the modules the routes
// call are replaced, so each test checks only what the route itself is responsible for).
//   S3  uploads and GitHub imports run under the workspace's spend cap
//   S7  the role cookie is Secure in production; the unguarded legacy actions are gone
//   S9  the run status sent to a browser carries no raw error text
//   upload: the 4.5 MB limit holds when Content-Length is missing
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStatus } from "@/lib/db/mappers";
import type { ModelContext } from "@/lib/model/client";

const WS = "11111111-1111-4111-8111-111111111111";
const seen: { ctx: ModelContext | undefined; calls: number } = { ctx: undefined, calls: 0 };
const cookieSet = vi.fn();
let storedRun: RunStatus | null = null;

vi.mock("@/lib/session", () => ({
  viewingRole: async () => "president",
  roleCookieName: (ws: string) => `role_${ws}`,
}));
vi.mock("@/lib/pack", () => ({
  getWorkspacePack: async () => ({ roles: [{ key: "president" }] }),
  isRoleOf: (_p: unknown, r: string) => r === "president",
}));
vi.mock("@/lib/db/queries", () => ({
  getWorkspace: async (id: string) => (id === WS ? { id: WS, kind: "demo" } : null),
  getRunStatus: async () => storedRun,
}));
vi.mock("@/lib/db/withRole", () => ({ isUuid: () => true }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/lib/pipeline/run", () => ({ startRun: async () => ({ runId: "r", alreadyRunning: true, resumed: false }), executeRun: async () => null }));
vi.mock("@/lib/pipeline/rejudge", () => ({ REJUDGE_KEY: "rejudge" }));
vi.mock("@/lib/pipeline/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pipeline/guard")>("@/lib/pipeline/guard");
  return {
    ...actual,
    exclusive: async <T>(_ws: string, _key: string, fn: () => Promise<T>) => fn(),
    leaseHeld: async () => false,
  };
});
vi.mock("@/lib/pipeline/ingest", async () => {
  const { currentModelContext } = await vi.importActual<typeof import("@/lib/model/client")>("@/lib/model/client");
  const record = async () => {
    seen.ctx = currentModelContext();
    seen.calls++;
    return { ok: true, sources: [] };
  };
  return {
    ingestUpload: record,
    ingestGithubUrl: record,
    UPLOAD_KINDS: ["notes"],
    UPLOAD_KIND_LABEL: { notes: "Notes" },
    UPLOAD_LIMIT_BYTES: Math.floor(4.5 * 1024 * 1024),
    UPLOAD_LIMIT_MESSAGE: "Upload is over 4.5 MB. Split it or trim it.",
  };
});

const ctx = { params: Promise.resolve({ id: WS }) };

beforeEach(() => {
  seen.ctx = undefined;
  seen.calls = 0;
  cookieSet.mockClear();
  storedRun = null;
});
afterEach(() => vi.unstubAllEnvs());

function uploadForm(text: string): FormData {
  const form = new FormData();
  form.set("kind", "notes");
  form.append("files", new File([text], "notes.md", { type: "text/markdown" }));
  return form;
}

describe("S3: ingest routes charge live classifier calls to the workspace", () => {
  it("the upload route runs ingestUpload inside a model context with the spend gate", async () => {
    const { POST } = await import("@/app/api/w/[id]/upload/route");
    const res = await POST(new Request(`http://x/api/w/${WS}/upload`, { method: "POST", body: uploadForm("hello") }), ctx);
    expect(res.status).toBe(200);
    expect(seen.calls).toBe(1);
    expect(typeof seen.ctx?.gate).toBe("function");
  });

  it("the GitHub route runs ingestGithubUrl inside a model context with the spend gate", async () => {
    const { POST } = await import("@/app/api/w/[id]/github/route");
    const res = await POST(new Request(`http://x/api/w/${WS}/github`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://github.com/club/firmware" }),
    }), ctx);
    expect(res.status).toBe(200);
    expect(seen.calls).toBe(1);
    expect(typeof seen.ctx?.gate).toBe("function");
  });
});

describe("upload: the size limit is enforced on the bytes read", () => {
  it("a streamed body with no Content-Length is refused with 413 once it passes the limit, and nothing is ingested", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 64 MB if nobody stops it; the route must stop reading soon after 4.5 MB.
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const req = new Request(`http://x/api/w/${WS}/upload`, {
      method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const { POST } = await import("@/app/api/w/[id]/upload/route");
    const res = await POST(req, ctx);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/4\.5 MB/);
    expect(seen.calls).toBe(0);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(10);
  });

  it("readBodyWithin returns the bytes of a body under the limit", async () => {
    const { readBodyWithin } = await import("@/lib/pipeline/body-limit");
    const out = await readBodyWithin(new Response("abc").body, 10);
    expect(out).not.toBe("too_large");
    expect(new TextDecoder().decode(out as Uint8Array)).toBe("abc");
    expect(await readBodyWithin(new Response("abcdef").body, 5)).toBe("too_large");
    expect(await readBodyWithin(null, 5)).toHaveLength(0);
  });
});

describe("S9: run status for the browser", () => {
  const raw = 'Reconstruct claims: relation "claims" does not exist at character 15 (host db.internal:5432)';
  const run = (over: Partial<RunStatus> = {}): RunStatus => ({
    id: "run1", workspaceId: WS, status: "failed", error: raw, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z",
    slices: 1, progress: null, resumable: false,
    steps: [
      { key: "connect", label: "Connect sources", status: "done", counts: { sources: 2 }, note: null, startedAt: null, finishedAt: null },
      { key: "reconstruct", label: "Reconstruct claims", status: "failed", counts: {}, note: raw.slice(0, 300), startedAt: null, finishedAt: null },
      { key: "verify", label: "Verify citations", status: "done", counts: {}, note: "Read 3 of 3 support checks.", startedAt: null, finishedAt: null },
    ],
    ...over,
  });

  it("publicRun replaces raw failure text and keeps everything else", async () => {
    const { publicRun, RUN_FAILED_MESSAGE, STEP_FAILED_NOTE } = await import("@/lib/pipeline/public-run");
    const out = publicRun(run())!;
    expect(JSON.stringify(out)).not.toMatch(/does not exist|db\.internal|character 15/);
    expect(out.error).toBe(RUN_FAILED_MESSAGE);
    expect(out.steps[1].note).toBe(STEP_FAILED_NOTE);
    expect(out.steps[1].status).toBe("failed");
    expect(out.steps[2].note).toBe("Read 3 of 3 support checks.");
    expect(out.steps[0].counts).toEqual({ sources: 2 });
    expect(publicRun(null)).toBeNull();
    expect(publicRun(run({ status: "done", error: null, steps: [] }))!.error).toBeNull();
  });

  it("the pipeline's own slice-limit sentence is kept", async () => {
    const { publicRun } = await import("@/lib/pipeline/public-run");
    const own = "The run was stopped after 40 slices. What was read so far is kept; press Run again to continue.";
    expect(publicRun(run({ error: `${own}\n${raw}` }))!.error).toBe(own);
  });

  it("GET /api/w/[id]/run sends the public form", async () => {
    storedRun = run();
    const { GET } = await import("@/app/api/w/[id]/run/route");
    const res = await GET(new Request(`http://x/api/w/${WS}/run`), ctx);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/does not exist|db\.internal/);
    expect(JSON.parse(text).run.status).toBe("failed");
  });
});

describe("S7 and S4: src/app/w/actions.ts", () => {
  it("exports only setRole: the unguarded legacy actions cannot be called", async () => {
    const mod = await import("@/app/w/actions");
    expect(Object.keys(mod).sort()).toEqual(["setRole"]);
  });

  it("sets the role cookie Secure in production and not in development", async () => {
    const { setRole } = await import("@/app/w/actions");
    vi.stubEnv("NODE_ENV", "production");
    await setRole(WS, "president");
    expect(cookieSet).toHaveBeenLastCalledWith(`role_${WS}`, "president", expect.objectContaining({ secure: true, httpOnly: true, sameSite: "lax" }));
    vi.stubEnv("NODE_ENV", "development");
    await setRole(WS, "president");
    expect(cookieSet).toHaveBeenLastCalledWith(`role_${WS}`, "president", expect.objectContaining({ secure: false }));
    cookieSet.mockClear();
    await setRole(WS, "nobody");
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
