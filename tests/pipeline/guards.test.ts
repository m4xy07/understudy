// Guards against bad input and repeats: action leases, the spend cap, the model call context,
// upload checks and text validation. Database parts need a migrated database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { callJson, DEFERRED_ERROR, runWithModelContext } from "@/lib/model/client";
import { acquireLease, chargeModelCall, exclusive, leaseHeld, releaseLease, resetSpendMemo, SPEND_MESSAGE_GLOBAL, SPEND_MESSAGE_WORKSPACE, spendToday } from "@/lib/pipeline/guard";
import {
  createEmptyWorkspace, ingestUpload, looksBinary, uploadProblem, UPLOAD_LIMIT_BYTES, UPLOAD_LIMIT_MESSAGE, UPLOAD_MAX_SEGMENTS,
} from "@/lib/pipeline/ingest";
import { isRealDate, MAX_NOTE, MAX_OWNER, planProblem, reviewTextProblem } from "@/lib/pipeline/once";
import { listSources } from "@/lib/db/queries";
import { useFakeModel, type FakeModel } from "../helpers/fake-model";

const sql = db();
let ws = "";
let fake: FakeModel;

beforeAll(async () => {
  ws = await createEmptyWorkspace("guards test");
  fake = useFakeModel("fake-guards");
});

afterAll(async () => {
  delete process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY;
  delete process.env.MODEL_CALLS_PER_DAY;
  await fake.cleanup();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
  await sql.end();
});

describe("action leases", () => {
  it("of two identical actions at once, one runs and the other is told it is already in progress", async () => {
    let ran = 0;
    const work = async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 150));
      return "done";
    };
    const out = await Promise.all([exclusive(ws, "k1", work, "busy"), exclusive(ws, "k1", work, "busy"), exclusive(ws, "k1", work, "busy")]);
    expect(out.filter((x) => x === "done")).toHaveLength(1);
    expect(out.filter((x) => x === "busy")).toHaveLength(2);
    expect(ran).toBe(1);
    // Released when the work settles: the same action can run again afterwards.
    expect(await exclusive(ws, "k1", work, "busy")).toBe("done");
  });

  it("different keys do not block each other, and a thrown error still releases the lease", async () => {
    const [a, b] = await Promise.all([exclusive(ws, "k2", async () => "a", "busy"), exclusive(ws, "k3", async () => "b", "busy")]);
    expect([a, b]).toEqual(["a", "b"]);
    await expect(exclusive(ws, "k4", async () => { throw new Error("boom"); }, "busy")).rejects.toThrow("boom");
    expect(await leaseHeld(ws, "k4")).toBe(false);
  });

  it("a lease left by a request that died expires by itself", async () => {
    const holder = await acquireLease(ws, "k5", 300);
    expect(holder).not.toBeNull();
    expect(await acquireLease(ws, "k5", 300)).toBeNull();
    await new Promise((r) => setTimeout(r, 450));
    expect(await leaseHeld(ws, "k5")).toBe(false);
    const next = await acquireLease(ws, "k5", 1000);
    expect(next).not.toBeNull();
    await releaseLease(ws, "k5", holder!); // the dead holder cannot release the new holder's lease
    expect(await leaseHeld(ws, "k5")).toBe(true);
    await releaseLease(ws, "k5", next!);
  });

  it("with a wait, the second caller runs after the first instead of being refused", async () => {
    const order: string[] = [];
    const work = (name: string) => async () => {
      order.push(`${name} start`);
      await new Promise((r) => setTimeout(r, 200));
      order.push(`${name} end`);
      return name;
    };
    const out = await Promise.all([exclusive(ws, "k6", work("a"), "busy", 5000, 3000), exclusive(ws, "k6", work("b"), "busy", 5000, 3000)]);
    expect(out.sort()).toEqual(["a", "b"]);
    expect(order[1]).toMatch(/end$/); // never interleaved
  });
});

describe("spend cap", () => {
  it("parallel calls cannot pass the per-workspace cap together", async () => {
    process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY = "4";
    process.env.MODEL_CALLS_PER_DAY = "0";
    resetSpendMemo();
    const out = await Promise.all(Array.from({ length: 10 }, () => chargeModelCall(ws)));
    expect(out.filter((x) => x === null)).toHaveLength(4);
    expect(out.filter((x) => x === SPEND_MESSAGE_WORKSPACE)).toHaveLength(6);
    expect(await spendToday(ws)).toEqual({ calls: 4, cap: 4 });
    expect(SPEND_MESSAGE_WORKSPACE).toMatch(/Cached answers and the demo still work/);
  });

  it("the deployment-wide cap refuses with its own message", async () => {
    process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY = "0";
    process.env.MODEL_CALLS_PER_DAY = "1";
    resetSpendMemo();
    expect(await chargeModelCall(ws)).toBe(SPEND_MESSAGE_GLOBAL); // 4 calls already counted today
    process.env.MODEL_CALLS_PER_DAY = "0";
    resetSpendMemo();
    expect(await chargeModelCall(ws)).toBeNull();
  });
});

describe("model call context", () => {
  const schema = z.object({}).passthrough();
  const ask = (user: string) => callJson({ system: "guards test", user, schema, jsonSchemaName: "guards_test" });

  it("after the deadline no live call starts, but a cached answer is still served", async () => {
    fake.calls.length = 0;
    const first = await ask("question one");
    expect(first).toMatchObject({ ok: true, cached: false });
    const held = await runWithModelContext({ deadline: 0 }, async () => [await ask("question one"), await ask("question two")]);
    expect(held[0]).toMatchObject({ ok: true, cached: true });
    expect(held[1]).toEqual({ ok: false, error: DEFERRED_ERROR });
    expect(fake.calls).toEqual(["question one\n/no_think"]);
  });

  it("a gate can refuse a live call with its message, and outcomes are reported", async () => {
    const seen: string[] = [];
    const res = await runWithModelContext(
      { gate: async () => "no budget today", onResult: (_k, outcome) => seen.push(outcome) },
      async () => [await ask("question one"), await ask("question three")],
    );
    expect(res[0]).toMatchObject({ ok: true, cached: true });
    expect(res[1]).toMatchObject({ ok: false, error: "no budget today", refused: true });
    expect(seen).toEqual(["cached", "refused"]);
  });

  it("inside a context a passing failure is not retried in place (the run retries it in a later pass)", async () => {
    fake.failWhen = (u) => u.startsWith("always down");
    fake.calls.length = 0;
    const seen: boolean[] = [];
    const res = await runWithModelContext({ retries: 0, onResult: (_k, _o, info) => seen.push(info.transient === true) }, () => ask("always down A"));
    fake.failWhen = () => false;
    expect(res.ok).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(seen).toEqual([true]);
  });
});

describe("upload checks", () => {
  const md = (name: string, content: string) => ({ path: name, content });

  it("names the limit as 4.5 MB", () => {
    expect(UPLOAD_LIMIT_BYTES).toBe(Math.floor(4.5 * 1024 * 1024));
    expect(UPLOAD_LIMIT_MESSAGE).toBe("Upload is over 4.5 MB. Split it or trim it.");
    expect(uploadProblem("markdown", [md("big.md", "x".repeat(UPLOAD_LIMIT_BYTES + 1))])).toBe(UPLOAD_LIMIT_MESSAGE);
  });

  it("refuses no file, an empty file, a whitespace file and a binary file, each with its reason", () => {
    expect(uploadProblem("markdown", [])).toBe("Choose at least one file.");
    expect(uploadProblem("tasks_csv", [md("a.csv", "")])).toBe('"a.csv" is empty. Choose a file with content.');
    expect(uploadProblem("tasks_csv", [md("a.csv", " \n\t\n")])).toBe('"a.csv" is empty. Choose a file with content.');
    expect(uploadProblem("markdown", [md("a.md", ""), md("b.md", "")])).toBe("These files are all empty. Choose files with content.");
    const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xfffd, 0xfffd, 0, 0);
    expect(uploadProblem("tasks_csv", [md("photo.png", png)])).toMatch(/"photo.png" does not look like a text file/);
    expect(looksBinary("plain text\nwith lines\tand tabs")).toBe(false);
    expect(looksBinary("")).toBe(false);
  });

  it("refuses a file of the wrong shape with the parser's reason, for every source type", () => {
    expect(uploadProblem("tasks_csv", [md("a.csv", "foo,bar\n1,2\n")], "a task board CSV")).toMatch(/Nothing could be read from "a.csv" as a task board CSV: header must be exactly/);
    expect(uploadProblem("slack", [md("general.json", "{not json")])).toMatch(/Nothing could be read/);
    expect(uploadProblem("ics", [md("a.ics", "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:garbage\n")])).toMatch(/not a valid iCalendar file/);
    expect(uploadProblem("github", [md("commits.json", "[[[")])).toMatch(/commits.json is not valid JSON/);
    expect(uploadProblem("whatsapp", [md("chat.txt", "just some words without any message lines")])).toMatch(/Nothing could be read|Check that the source type/);
  });

  it("refuses more entries than one upload may add, and accepts a good file", () => {
    const many = Array.from({ length: UPLOAD_MAX_SEGMENTS + 5 }, (_, i) => `12/11/26, 10:${String(i % 60).padStart(2, "0")} - Asha: message ${i}`).join("\n");
    expect(uploadProblem("whatsapp", [md("chat.txt", many)])).toMatch(/the limit is 20,000 per upload/);
    expect(uploadProblem("markdown", [md("ok.md", "# Note\nThe owner of deploys is Arjun.")])).toBeNull();
  });

  it("a refused upload leaves no source behind; the same good upload twice adds its segments once", async () => {
    const bad = await ingestUpload(ws, "tasks_csv", [md("a.csv", "foo,bar\n1,2\n")]);
    expect(bad.ok).toBe(false);
    expect(await listSources(ws)).toHaveLength(0);
    const good = [md("ok.md", "# Note\nThe owner of deploys is Arjun.")];
    const one = await ingestUpload(ws, "markdown", good);
    const two = await ingestUpload(ws, "markdown", good);
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) {
      expect(one.sources[0].newSegments).toBe(1);
      expect(two.sources[0].newSegments).toBe(0);
    }
    expect(await listSources(ws)).toHaveLength(1);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM segments WHERE workspace_id = ${ws}`;
    expect(n).toBe(1);
  });
});

describe("text validation", () => {
  it("accepts real calendar dates only", () => {
    expect(isRealDate("2026-11-30")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "not-a-date", "30/11/2026", "2026-11-30T10:00", "", "0001-01-01"]) {
      expect(isRealDate(bad), bad).toBe(false);
    }
  });

  it("a plan entry needs all three fields, a real date and sane lengths", () => {
    expect(planProblem("Arjun", "2026-11-30", "Known gap.")).toBeNull();
    expect(planProblem("   ", "2026-11-30", "x")).toBe("Owner, due date and risk note are all required.");
    expect(planProblem("Arjun", "", "x")).toBe("Owner, due date and risk note are all required.");
    expect(planProblem("Arjun", "2026-02-31", "x")).toBe("Use a real date like 2026-11-30.");
    expect(planProblem("A".repeat(MAX_OWNER + 1), "2026-11-30", "x")).toMatch(/Keep the owner under 200 characters/);
    expect(planProblem("Arjun", "2026-11-30", "R".repeat(MAX_NOTE + 1))).toMatch(/Keep the risk note under 2000 characters/);
  });

  it("review notes and edited statements have a length limit", () => {
    expect(reviewTextProblem("fine", "fine")).toBeNull();
    expect(reviewTextProblem("n".repeat(MAX_NOTE + 1), "")).toMatch(/Keep the note under/);
    expect(reviewTextProblem("", "s".repeat(MAX_NOTE + 1))).toMatch(/Keep the statement under/);
  });
});
