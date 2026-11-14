// Opening a demo under load: the first attempt to copy the demo can be cancelled by a busy
// database (a statement timeout). The action tries once more; if that fails too, the visitor gets
// one plain sentence, never the raw database error. No database here: the modules are replaced.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  attempts: 0,
  failFirst: 0,
  started: [] as string[],
  redirected: null as string | null,
}));

vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    state.redirected = to;
  },
}));
vi.mock("@/lib/pack", () => ({ listDemoPacks: () => [{ id: "club" }, { id: "lab" }] }));
vi.mock("@/lib/pipeline/run", () => ({
  startRun: async (ws: string) => {
    state.started.push(ws);
    return { runId: "run-1", alreadyRunning: false, resumed: false };
  },
  executeRun: async () => null,
}));
vi.mock("@/lib/pipeline/ingest", () => ({
  createDemoWorkspace: async (packId: string) => {
    state.attempts++;
    if (state.attempts <= state.failFirst) throw new Error("canceling statement due to statement timeout");
    return { id: `ws-${packId}-${state.attempts}` };
  },
  createEmptyWorkspace: async () => "ws-empty",
}));

import { openDemo } from "@/app/actions";

beforeEach(() => {
  state.attempts = 0;
  state.failFirst = 0;
  state.started = [];
  state.redirected = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("openDemo", () => {
  it("opens the demo on the first attempt when nothing fails", async () => {
    expect(await openDemo("club")).toBeUndefined();
    expect(state.attempts).toBe(1);
    expect(state.redirected).toBe("/w/ws-club-1/connect");
  });

  it("tries once more when the first attempt is cancelled, and the visitor never sees the error", async () => {
    state.failFirst = 1;
    const res = await openDemo("club");
    expect(res).toBeUndefined();
    expect(state.attempts).toBe(2);
    // The run starts once, for the copy that was made.
    expect(state.started).toEqual(["ws-club-2"]);
    expect(state.redirected).toBe("/w/ws-club-2/connect");
  });

  it("after two failures says the server was busy in plain words, with no database text", async () => {
    state.failFirst = 2;
    const res = await openDemo("club");
    expect(state.attempts).toBe(2); // one retry, not a loop
    expect(res).toEqual({ error: "The demo could not be opened just now because the server was busy. Press the button again." });
    expect(JSON.stringify(res)).not.toMatch(/statement|timeout|cancel/i);
    expect(state.started).toEqual([]);
    expect(state.redirected).toBeNull();
  });

  it("refuses a demo that is not in the list without touching the database", async () => {
    expect(await openDemo("nope")).toEqual({ error: "That demo is not available." });
    expect(state.attempts).toBe(0);
  });
});
