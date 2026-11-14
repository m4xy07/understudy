// Review findings 4, 11 and 13 and security findings S4, S5 and S7 at the action layer: time
// limits and lease lengths that fit together, the lease that fails closed, lease keys that cannot
// carry a client string, and the model note that tells a used budget from an unusable answer.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { standinErrorNote } from "@/lib/lacuna";
import { currentModelContext, DEFERRED_ERROR, runWithModelContext } from "@/lib/model/client";
import {
  ACTION_BUDGET_MS, ACTION_HARD_MS, ACTION_LEASE_MS, ACTION_MAX_DURATION_S, actionContext, exclusive, isSafeId, leaseHeld, leaseKey,
  SPEND_MESSAGE_WORKSPACE,
} from "@/lib/pipeline/guard";
import { createEmptyWorkspace } from "@/lib/pipeline/ingest";
import { DEFAULT_TIMEOUT_MS } from "@/lib/model/client";
import { SLICE_BUDGET_MS } from "@/lib/pipeline/run";

const sql = db();
let ws = "";
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

beforeAll(async () => {
  ws = await createEmptyWorkspace("action limits test");
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
  await sql.end();
});

describe("finding 4: deadlines, route limits and lease lengths fit together", () => {
  it("the pages whose actions call the model allow 300 s", () => {
    for (const page of ["ask", "review", "first-weeks", "test"]) {
      expect(read(`src/app/w/[id]/${page}/page.tsx`)).toMatch(new RegExp(`^export const maxDuration = ${ACTION_MAX_DURATION_S};$`, "m"));
    }
  });

  it("an action stops starting calls, then stops waiting for them, before the route limit; its lease lasts at least as long", () => {
    expect(ACTION_BUDGET_MS).toBeLessThan(ACTION_HARD_MS);
    expect(ACTION_HARD_MS).toBeLessThan(ACTION_MAX_DURATION_S * 1000);
    expect(ACTION_LEASE_MS).toBeGreaterThanOrEqual(ACTION_MAX_DURATION_S * 1000);
    // A pipeline slice: the budget plus one request timeout stays inside the run route's 300 s.
    expect(SLICE_BUDGET_MS + DEFAULT_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("actionContext carries the deadline, the hard deadline and the spend gate", async () => {
    const before = Date.now();
    const ctx = actionContext(ws);
    expect(ctx.deadline).toBeGreaterThanOrEqual(before + ACTION_BUDGET_MS);
    expect(ctx.hardDeadline).toBeGreaterThanOrEqual(before + ACTION_HARD_MS);
    expect(typeof ctx.gate).toBe("function");
    const seen = await runWithModelContext(actionContext(ws, 5), async () => currentModelContext());
    expect(seen?.deadline).toBeLessThan(Date.now() + 1000);
  });

  it("no action passes a model context without a deadline, or a lease shorter than the route limit", () => {
    for (const file of ["ask", "review", "first-weeks", "test"]) {
      const src = read(`src/app/w/[id]/${file}/actions.ts`);
      expect(src).not.toMatch(/spendContext\(ws\)/); // the bare context has no deadline
      expect(src).not.toMatch(/, 1[28]0_000/); // the old 120 s / 180 s leases
    }
    expect(read("src/lib/pipeline/rejudge.ts")).toMatch(/const REJUDGE_TTL_S = ACTION_LEASE_MS \/ 1000;/);
  });
});

describe("finding 13 and S4: the probe run is exclusive and metered", () => {
  it("runProbesAction takes the probes lease and runs under the spend cap", () => {
    const src = read("src/app/w/[id]/probes/actions.ts");
    expect(src).toMatch(/exclusive<ActionState>\(ws, "probes"/);
    expect(src).toMatch(/spendContext\(ws, \{ deadline: deadline - 3_000, hardDeadline: deadline \}\)/);
  });
});

describe("S5: the lease fails closed and its key cannot carry a client string", () => {
  it("when the lease table cannot be reached the work does not run unguarded", async () => {
    let ran = 0;
    const work = async () => { ran++; return "done"; };
    // Not a uuid: the lease statement throws, as it would with the database away.
    expect(await exclusive("not-a-workspace", "k", work, "busy")).toBe("busy");
    expect(await exclusive("not-a-workspace", "k", work, "busy", 1000, 0, { onError: "try again" })).toBe("try again");
    expect(ran).toBe(0); // it used to run: two tabs could both do the work
  });

  it("fixed keys stay readable; anything long or odd is stored as a short hash", async () => {
    expect(leaseKey("rejudge")).toBe("rejudge");
    expect(leaseKey("review:clm_12ab")).toBe("review:clm_12ab");
    const long = `answer:${"x".repeat(5000)}`;
    expect(leaseKey(long)).toMatch(/^h:[0-9a-f]{48}$/);
    expect(leaseKey("review:a b\u0000c")).toMatch(/^h:[0-9a-f]{48}$/);
    expect(leaseKey(long)).toBe(leaseKey(long));
    let inside = false;
    await exclusive(ws, long, async () => {
      inside = await leaseHeld(ws, long);
      const [row] = await sql`SELECT max(length(key)) AS n FROM action_leases WHERE workspace_id = ${ws}`;
      expect(Number(row.n)).toBeLessThanOrEqual(80);
    }, undefined);
    expect(inside).toBe(true);
    expect(await leaseHeld(ws, long)).toBe(false);
  });

  it("form ids are checked before they are used", () => {
    for (const ok of ["gq_0123456789ab", "clm_ab12", "3f2b1c9e-1a2b-4c3d-8e9f-001122334455", "rs_a:b|c.d-1"]) expect(isSafeId(ok)).toBe(true);
    for (const bad of ["", " ", "a b", "x".repeat(200), "a\nb", "'; DROP TABLE claims; --", "../etc", "\u0000"]) expect(isSafeId(bad)).toBe(false);
    for (const file of ["ask", "review", "first-weeks"]) expect(read(`src/app/w/[id]/${file}/actions.ts`)).toMatch(/isSafeId\(/);
  });
});

describe("S7: the role cookie", () => {
  it("is Secure in production on the Ask page too", () => {
    expect(read("src/app/w/[id]/ask/actions.ts")).toMatch(/secure: process\.env\.NODE_ENV === "production"/);
  });
});

describe("finding 11: the model note says what really happened", () => {
  const e = (responsibilityKey: string, error: string) => ({ responsibilityKey, error });

  it("a used budget is not reported as an unusable answer", () => {
    const note = standinErrorNote([e("R1", SPEND_MESSAGE_WORKSPACE), e("R2", SPEND_MESSAGE_WORKSPACE)])!;
    expect(note).toBe("Today's live model budget is used: the model was not asked for 2 responsibilities. Deterministic reading used.");
    expect(note).not.toMatch(/unusable/);
  });

  it("a call left for later is named as such", () => {
    const note = standinErrorNote([e("R1", DEFERRED_ERROR)])!;
    expect(note).toMatch(/was not asked for 1 responsibility in the time allowed; press Re-run test/);
    expect(note).not.toMatch(/unusable|unavailable/);
  });

  it("unreachable and unusable are still told apart, and mixed causes are all named", () => {
    expect(standinErrorNote([e("R1", "model timed out"), e("R2", "HTTP 503: busy")])).toBe("Model unavailable for 2 responsibilities. Deterministic reading used.");
    expect(standinErrorNote([e("R3", "schema mismatch: invalid")])).toBe("Model answer unusable for R3. Deterministic reading used.");
    const mixed = standinErrorNote([e("R1", SPEND_MESSAGE_WORKSPACE), e("R2", "not in cache"), e("R3", "no JSON in model output")])!;
    expect(mixed).toMatch(/budget is used/);
    expect(mixed).toMatch(/Model unavailable for 1 responsibility\./);
    expect(mixed).toMatch(/Model answer unusable for R3\./);
    expect(standinErrorNote([])).toBeNull();
  });
});
