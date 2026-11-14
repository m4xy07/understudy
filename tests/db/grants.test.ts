// The Supabase Data API roles (anon, authenticated) hold nothing in public: no table privilege,
// no sequence privilege, no EXECUTE on any function (db/migrations/0012_grants.sql and the
// blanket revoke at the end of scripts/migrate.ts). Needs a migrated database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { getPack, listDemoPacks } from "@/lib/pack";
import { BLANKET_REVOKE_SQL } from "../../scripts/migrate";

const sql = db();
const API_ROLES = ["anon", "authenticated"] as const;
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** Functions of the public schema that are ours (not an extension's). */
async function publicFunctions(): Promise<{ sig: string; secdef: boolean; config: string[] }[]> {
  const rows = await sql`
    SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, coalesce(p.proconfig, '{}') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1`;
  return rows.map((r) => ({ sig: String(r.sig), secdef: Boolean(r.secdef), config: (r.config as string[]) ?? [] }));
}

async function publicTables(): Promise<string[]> {
  const rows = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
  return rows.map((r) => String(r.tablename));
}

async function tableGrants(role: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of await publicTables()) {
    for (const priv of TABLE_PRIVILEGES) {
      const [r] = await sql`SELECT has_table_privilege(${role}, ${`public.${t}`}, ${priv}) AS ok`;
      if (r.ok) out.push(`${t}:${priv}`);
    }
  }
  return out;
}

async function functionGrants(role: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await publicFunctions()) {
    const [r] = await sql`SELECT has_function_privilege(${role}, ${f.sig}, 'EXECUTE') AS ok`;
    if (r.ok) out.push(f.sig);
  }
  return out;
}

async function purge(ws: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  }).catch(() => {});
}

let rolesReady = false;

beforeAll(async () => {
  // Plain Postgres has no anon / authenticated: create them (NOLOGIN, no grants), as Supabase has them.
  for (const r of API_ROLES) {
    const [have] = await sql`SELECT 1 AS x FROM pg_roles WHERE rolname = ${r}`;
    if (!have) {
      try {
        await sql.unsafe(`CREATE ROLE ${r} NOLOGIN`);
      } catch {
        // created by a parallel run, or this user may not create roles (then the suite is skipped below)
      }
    }
  }
  const rows = await sql`SELECT rolname FROM pg_roles WHERE rolname = ANY(${[...API_ROLES]}::text[])`;
  rolesReady = rows.length === API_ROLES.length;
});

afterAll(async () => {
  await sql`DROP TABLE IF EXISTS us_grants_probe`.catch(() => {});
  await sql`DROP FUNCTION IF EXISTS us_grants_probe_fn()`.catch(() => {});
});

describe("anon and authenticated hold nothing in public", () => {
  it("the two roles exist in the test database", () => {
    expect(rolesReady).toBe(true);
  });

  it.each(API_ROLES)("%s has no privilege on any table", async (role) => {
    expect(await tableGrants(role)).toEqual([]);
  });

  it.each(API_ROLES)("%s has no privilege on any sequence", async (role) => {
    const seqs = await sql`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`;
    const out: string[] = [];
    for (const s of seqs) {
      for (const priv of ["USAGE", "SELECT", "UPDATE"]) {
        const [r] = await sql`SELECT has_sequence_privilege(${role}, ${`public.${String(s.sequencename)}`}, ${priv}) AS ok`;
        if (r.ok) out.push(`${String(s.sequencename)}:${priv}`);
      }
    }
    expect(out).toEqual([]);
  });

  it.each(API_ROLES)("%s cannot execute any function", async (role) => {
    expect((await publicFunctions()).length).toBeGreaterThan(5);
    expect(await functionGrants(role)).toEqual([]);
  });

  it("the blanket revoke of scripts/migrate.ts removes Supabase-style default grants from a new table and function", async () => {
    await sql`CREATE TABLE IF NOT EXISTS us_grants_probe (id integer PRIMARY KEY)`;
    await sql`CREATE OR REPLACE FUNCTION us_grants_probe_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'`;
    try {
      for (const r of API_ROLES) {
        await sql.unsafe(`GRANT ALL ON us_grants_probe TO ${r}`);
        await sql.unsafe(`GRANT EXECUTE ON FUNCTION us_grants_probe_fn() TO ${r}`);
      }
      expect(await tableGrants("anon")).toContain("us_grants_probe:SELECT");
      expect(await functionGrants("authenticated")).toContain("us_grants_probe_fn()");
      await sql.unsafe(BLANKET_REVOKE_SQL).simple();
      for (const r of API_ROLES) {
        expect(await tableGrants(r)).toEqual([]);
        expect(await functionGrants(r)).toEqual([]);
      }
    } finally {
      await sql`DROP TABLE IF EXISTS us_grants_probe`;
      await sql`DROP FUNCTION IF EXISTS us_grants_probe_fn()`;
    }
  });
});

describe("functions and admin-only tables", () => {
  it("every SECURITY DEFINER function has a fixed search_path", async () => {
    const definer = (await publicFunctions()).filter((f) => f.secdef);
    expect(definer.map((f) => f.sig)).toEqual(expect.arrayContaining([
      "claim_meta(uuid)", "count_limited(uuid,text)", "count_withheld(uuid,text,text)", "us_segment_head(uuid,text)",
    ]));
    expect(definer.filter((f) => !f.config.some((c) => c.startsWith("search_path="))).map((f) => f.sig)).toEqual([]);
  });

  it("no function is executable by PUBLIC; us_reader keeps only what the role-scoped path calls", async () => {
    const rows = await sql`
      SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`;
    expect(rows.map((r) => String(r.sig))).toEqual([]);
    expect((await functionGrants("us_reader")).sort()).toEqual([
      "claim_meta(uuid)", "count_limited(uuid,text)", "count_withheld(uuid,text,text)", "us_can_see(text,text[],text[])",
      "us_claim(text)", "us_segment_head(uuid,text)",
    ]);
  });

  it("snapshot_changes, action_leases and model_spend have forced row level security and no reader grant", async () => {
    const rows = await sql`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('snapshot_changes', 'action_leases', 'model_spend') ORDER BY 1`;
    expect(rows.map((r) => [String(r.relname), Boolean(r.relrowsecurity), Boolean(r.relforcerowsecurity)])).toEqual([
      ["action_leases", true, true], ["model_spend", true, true], ["snapshot_changes", true, true],
    ]);
    for (const t of ["snapshot_changes", "action_leases", "model_spend"]) {
      const [r] = await sql`SELECT has_table_privilege('us_reader', ${`public.${t}`}, 'SELECT') AS ok`;
      expect(r.ok).toBe(false);
    }
  });

  it("the admin path still reads and writes the three tables", async () => {
    const pack = getPack(listDemoPacks()[0].id);
    const [w] = await sql`
      INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role)
      VALUES ('grants fixture', 'empty', ${pack.id}, ${pack.approverRole}, ${pack.leaverRole}) RETURNING id`;
    const ws = String(w.id);
    try {
      await sql`INSERT INTO action_leases (workspace_id, key, holder, expires_at) VALUES (${ws}, 'k', gen_random_uuid(), now() + interval '1 minute')`;
      await sql`INSERT INTO model_spend (workspace_id, calls) VALUES (${ws}, 1)`;
      expect((await sql`SELECT 1 FROM action_leases WHERE workspace_id = ${ws}`).length).toBe(1);
      expect((await sql`SELECT 1 FROM model_spend WHERE workspace_id = ${ws}`).length).toBe(1);
      expect((await sql`SELECT 1 FROM snapshot_changes WHERE workspace_id = ${ws}`).length).toBe(0);
    } finally {
      await purge(ws);
    }
  });

  it("count_withheld answers for the workspace in the request claims only", async () => {
    const pack = getPack(listDemoPacks()[0].id);
    const reader = pack.successorRole;
    const mk = async () => {
      const [w] = await sql`
        INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role)
        VALUES ('grants fixture', 'empty', ${pack.id}, ${pack.approverRole}, ${pack.leaverRole}) RETURNING id`;
      const ws = String(w.id);
      await sql`INSERT INTO snapshots (workspace_id, id, version, hash, payload, approved_by)
        VALUES (${ws}, 'snap_1', 1, 'h', '{}'::jsonb, ${pack.approverRole})`;
      return ws;
    };
    let a = "";
    let b = "";
    try {
      a = await mk();
      b = await mk();
      // One frozen claim in workspace b that the reader may not see.
      await sql`
        INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, attribute, statement, trust, role_set)
        VALUES (${b}, 'snap_1', 'clm_x', 'e', 'access', 's', 'recorded', ${[pack.approverRole]}::text[])`;
      const [own] = await withRole(b, reader, (tx) => tx`SELECT count_withheld(${b}::uuid, ${reader}, 'all') AS n`);
      expect(Number(own.n)).toBe(1);
      // The same question asked from inside workspace a: nothing about b comes back.
      const [other] = await withRole(a, reader, (tx) => tx`SELECT count_withheld(${b}::uuid, ${reader}, 'all') AS n`);
      expect(Number(other.n)).toBe(0);
      // The admin path (no request claims) still counts.
      const [admin] = await sql`SELECT count_withheld(${b}::uuid, ${reader}, 'all') AS n`;
      expect(Number(admin.n)).toBe(1);
    } finally {
      for (const ws of [a, b]) if (ws) await purge(ws);
    }
  });
});
