// The pool must not hang behind Supabase's transaction pooler (Supavisor, port 6543).
// postgres.js pipelines queries on one connection by default and Supavisor never answers
// pipelined queries, so pages whose layout and Suspense boundaries query at the same time
// streamed forever. Needs a migrated database: pnpm db:up && pnpm db:migrate.
// Set POOLER_TEST_URL to a transaction-pooler URL to also run the cold-pool check through it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { db, poolOptions } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";

/** Rejects if `p` has not settled within `ms`: a hang becomes a test failure, not a timeout. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)),
  ]);
}

/** The query mix a cold workspace page fires at once: layout header + page boundary + role reads. */
function coldPageMix(sql: Sql, ws: string) {
  return [
    sql`SELECT * FROM workspaces WHERE id = ${ws}`,
    sql`SELECT * FROM workspaces WHERE id = ${ws}`,
    sql`SELECT * FROM runs WHERE workspace_id = ${ws} ORDER BY started_at DESC LIMIT 1`,
    sql`SELECT * FROM sources WHERE workspace_id = ${ws} ORDER BY imported_at, name`,
    sql`SELECT (SELECT count(*)::int FROM claims WHERE workspace_id = ${ws}) AS claims`,
    sql`SELECT * FROM runs WHERE workspace_id = ${ws} ORDER BY started_at DESC LIMIT 1`,
    sql`SELECT * FROM people WHERE workspace_id = ${ws} ORDER BY id`,
    withRole(ws, "president", (tx) => tx`SELECT * FROM claims WHERE workspace_id = ${ws}`, sql),
    withRole(ws, "new_member", (tx) => tx`SELECT * FROM segments WHERE workspace_id = ${ws}`, sql),
  ];
}

const shared = db();
let ws = "";

beforeAll(async () => {
  const [w] = await shared`INSERT INTO workspaces (name, kind) VALUES ('pool fixture', 'empty') RETURNING id`;
  ws = String(w.id);
});

afterAll(async () => {
  if (ws) {
    await shared.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await shared.end();
});

describe("db pool", () => {
  it("never pipelines and always times queries out", () => {
    expect(shared.options.max_pipeline).toBe(1);
    expect(shared.options.query_timeout).toBeGreaterThan(0);
  });

  it("finishes many concurrent withRole transactions and plain reads on a 2-connection pool", async () => {
    const url = process.env.DATABASE_URL!;
    const sql = postgres(url, { ...poolOptions(url), max: 2 }) as unknown as Sql;
    try {
      const jobs = Array.from({ length: 6 }, () => coldPageMix(sql, ws)).flat();
      const results = await within(Promise.all(jobs), 15_000, `${jobs.length} concurrent queries`);
      expect(results).toHaveLength(jobs.length);
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  it.skipIf(!process.env.POOLER_TEST_URL)("answers a cold page's concurrent queries through the transaction pooler", async () => {
    const url = process.env.POOLER_TEST_URL!;
    for (let round = 0; round < 3; round++) {
      // A fresh pool each round: the hang needed a cold pool, as on a new function instance.
      const sql = postgres(url, poolOptions(url)) as unknown as Sql;
      try {
        const [w] = await sql`SELECT id FROM workspaces ORDER BY created_at DESC LIMIT 1`;
        const target = w ? String(w.id) : ws;
        await within(Promise.all(coldPageMix(sql, target)), 15_000, `round ${round + 1}`);
      } finally {
        await sql.end({ timeout: 2 });
      }
    }
  });
});
