import "./config.mjs";
import { createPostgresPool } from "./postgres.mjs";
import { SOURCE_SCHEMA } from "./supabase-schema.mjs";
import { captureSnapshot, persistBackup, snapshotCounts } from "./supabase-backup.mjs";
import { reportError } from "./monitor.mjs";

if (process.argv.slice(2).join(" ") !== "--apply") throw new Error("Use --apply for the additive source-controls migration");
const pool = createPostgresPool();
let client;
try {
  client = await pool.connect();
  client.on("error", () => {});
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const exists = (await client.query("SELECT to_regclass('public.source_controls') AS name")).rows[0].name;
  const before = await captureSnapshot(client, { legacy: !exists });
  await client.query("COMMIT");
  const backup = await persistBackup(before);
  console.log(JSON.stringify({ preMigrationBackup: backup.destination, counts: backup.counts }));
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path TO public");
  await client.query(SOURCE_SCHEMA);
  const rls = (await client.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.source_controls'::regclass")).rows[0].relrowsecurity;
  if (!rls) throw new Error("Source control RLS must be enabled");
  await client.query("COMMIT");
  const after = await captureSnapshot(client);
  const counts = snapshotCounts(after);
  for (const [name, count] of Object.entries(snapshotCounts(before))) if (counts[name] !== count) throw new Error("Unexpected row-count change during migration");
  console.log(JSON.stringify({ migration: "0002_source_controls", rls, counts, existingRowsPreserved: true }));
} catch (error) {
  try { await client?.query("ROLLBACK"); } catch { /* Preserve original error. */ }
  await reportError(error, { operation: "database.sync" });
  console.error("Source-controls migration failed; inspect sanitized records. Credentials were not printed.");
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
