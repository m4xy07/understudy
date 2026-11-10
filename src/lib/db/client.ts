// One postgres.js pool per process. Safe for `next dev` hot reload (kept on globalThis)
// and for Vercel functions (small pool, prepare: false for transaction-mode poolers).
import postgres, { type Sql } from "postgres";

const globalForDb = globalThis as unknown as { __usSql?: Sql };

function create(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local or set it in the host.");
  }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    prepare: false,
    max: 5,
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
  });
  return sql as unknown as Sql;
}

/** The shared pool. Created lazily so builds without DATABASE_URL still compile. */
export function db(): Sql {
  if (!globalForDb.__usSql) globalForDb.__usSql = create();
  return globalForDb.__usSql;
}

export type { Sql };
