// One postgres.js pool per process. Safe for `next dev` hot reload (kept on globalThis)
// and for Vercel functions (small pool, prepare: false for transaction-mode poolers).
import postgres, { type Options, type Sql } from "postgres";

const globalForDb = globalThis as unknown as { __usSql?: Sql };

/** Seconds any one query may wait for a connection and run before it rejects with QUERY_TIMEOUT. */
export const QUERY_TIMEOUT_S = 20;

/** The pool options the app uses. Exported so tests build pools that behave like production. */
export function poolOptions(url: string): Options<Record<string, postgres.PostgresType>> {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return {
    prepare: false,
    max: 5,
    // One query in flight per connection. postgres.js pipelines up to 100 queries on a
    // connection by default; Supabase's transaction pooler (Supavisor, port 6543) never answers
    // pipelined queries, so a page whose layout and Suspense boundaries query concurrently hung
    // forever and left the pool's connections stuck for later requests. See the postgres.js
    // README section on Supavisor.
    max_pipeline: 1,
    // Backstop: a pooler that stops answering rejects the query (and the pool reconnects)
    // instead of holding the response stream open until the function times out.
    query_timeout: QUERY_TIMEOUT_S,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: local ? false : "require",
    onnotice: () => {},
    // Keep `date` columns as ISO strings ("2026-11-20"): no time-zone shifts.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
  };
}

function create(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local or set it in the host.");
  }
  return postgres(url, poolOptions(url)) as unknown as Sql;
}

/** The shared pool. Created lazily so builds without DATABASE_URL still compile. */
export function db(): Sql {
  if (!globalForDb.__usSql) globalForDb.__usSql = create();
  return globalForDb.__usSql;
}

export type { Sql };
