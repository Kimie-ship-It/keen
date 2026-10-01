import "./config.mjs";
import { createPostgresPool } from "./postgres.mjs";
import { assertSeparateRestoreTarget, readBackup, restoreEmptyTarget } from "./supabase-backup.mjs";

let pool, client;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--confirm-empty-target") throw new Error("Explicit empty-target confirmation and backup file are required");
  const target = process.env.SUPABASE_RESTORE_DB_URL;
  assertSeparateRestoreTarget(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL, target);
  const snapshot = await readBackup(args[1]);
  pool = createPostgresPool({ ...process.env, SUPABASE_DB_URL: target, SUPABASE_SSL_INSECURE: "0" });
  client = await pool.connect();
  client.on("error", () => {});
  const result = await restoreEmptyTarget(client, snapshot);
  console.log(JSON.stringify({ ...result, target: "separate-empty-database", liveSourceOverwritten: false }, null, 2));
} catch {
  console.error("Restore refused or rolled back. Require a separate empty database, matching schema, backup key and explicit confirmation. Credentials are not printed.");
  process.exitCode = 1;
} finally {
  client?.release();
  if (pool) await pool.end();
}
