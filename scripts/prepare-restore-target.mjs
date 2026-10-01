import "./config.mjs";
import { createPostgresPool } from "./postgres.mjs";
import { assertSeparateRestoreTarget } from "./supabase-backup.mjs";
import { LEGACY_SCHEMA, SOURCE_SCHEMA } from "./supabase-schema.mjs";

const names = ["jobs", "job_locations", "job_industries", "source_runs", "source_status", "review_events", "admin_auth_limits", "source_controls"];
let pool, client;
try {
  if (process.argv.slice(2).join(" ") !== "--confirm-empty-target") throw new Error("Explicit empty-target confirmation is required");
  const target = process.env.SUPABASE_RESTORE_DB_URL;
  assertSeparateRestoreTarget(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL, target);
  pool = createPostgresPool({ ...process.env, SUPABASE_DB_URL: target, SUPABASE_SSL_INSECURE: "0" });
  client = await pool.connect();
  client.on("error", () => {});
  const existing = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])", [names])).rows;
  if (existing.length) throw new Error("Restore target already has application tables; refusing migration");
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path TO public");
  await client.query(LEGACY_SCHEMA);
  await client.query(SOURCE_SCHEMA);
  const tables = (await client.query("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])", [names])).rows;
  if (tables.length !== names.length || tables.some((row) => !row.relrowsecurity)) throw new Error("Eight application tables must have RLS enabled");
  for (const name of names) {
    const count = (await client.query(`SELECT count(*)::int AS count FROM public.${name}`)).rows[0].count;
    if (count !== 0) throw new Error("Restore target is not empty");
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ prepared: true, separateTarget: true, tables: names.length, empty: true, rlsEnabled: true }));
} catch {
  try { await client?.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
  console.error("Target preparation refused or rolled back; check empty target, connection, and migration schema. No source tables were changed.");
  process.exitCode = 1;
} finally {
  client?.release();
  if (pool) await pool.end();
}
