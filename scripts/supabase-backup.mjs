import "./config.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresPool } from "./postgres.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLOUD_BACKUP_ROOT = resolve(ROOT, "..", "campus-jobs-backups", "supabase");
const SCHEMA = (await readFile(new URL("../supabase/migrations/0001_initial_schema.sql", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const SCHEMA_HASH = createHash("sha256").update(SCHEMA).digest("hex");
const FORMAT = "campus-jobs-supabase-v1";
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ROWS = 250000;
const BATCH_ROWS = 200;
const FILE_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{8}\.cjbackup$/;

export const BACKUP_TABLES = [
  { name: "jobs", columns: "id source source_id company title job_type published_at deadline recruiting_numbers detail_url first_seen_at last_seen_at review_status dedupe_key location_checked_at", order: "id" },
  { name: "job_locations", columns: "job_id location", order: "job_id, location" },
  { name: "job_industries", columns: "job_id industry", order: "job_id, industry" },
  { name: "source_runs", columns: "id source started_at finished_at status fetched_count new_count error", order: "id" },
  { name: "source_status", columns: "source last_started_at last_finished_at last_status last_success_at last_failure_at last_error fetched_count new_count", order: "source" },
  { name: "review_events", columns: "id source source_id old_status new_status actor created_at", order: "id" },
  { name: "admin_auth_limits", columns: "id window_started_at failures", order: "id" },
].map((table) => ({ ...table, columns: table.columns.split(" ") }));

function encryptionKey(key) {
  if (!/^[a-f0-9]{64}$/i.test(key || "")) throw new Error("Configure a 64-character hex SUPABASE_BACKUP_KEY; never print it");
  return Buffer.from(key, "hex");
}

export function validateSnapshot(snapshot) {
  if (snapshot?.format !== FORMAT || snapshot.schemaHash !== SCHEMA_HASH || !Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error("Unsupported backup format or schema version");
  if (!snapshot.tables || Object.keys(snapshot.tables).sort().join() !== BACKUP_TABLES.map((table) => table.name).sort().join()) throw new Error("Backup must include exactly seven application tables");
  for (const table of BACKUP_TABLES) {
    const rows = snapshot.tables[table.name];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error("Invalid backup row count");
    for (const row of rows) {
      if (!row || Object.keys(row).sort().join() !== [...table.columns].sort().join()) throw new Error("Backup column mismatch");
      if (Object.values(row).some((value) => value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value)))) throw new Error("Invalid backup cell type");
    }
  }
  if (!snapshot.tables.jobs.length) throw new Error("Refusing an empty recruitment backup");
  return snapshot;
}

export function encodeBackup(snapshot, key) {
  validateSnapshot(snapshot);
  const plaintext = Buffer.from(JSON.stringify(snapshot));
  if (plaintext.length > MAX_BYTES) throw new Error("Backup exceeds application snapshot size limit");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), nonce);
  cipher.setAAD(Buffer.from(FORMAT));
  const encrypted = Buffer.concat([cipher.update(gzipSync(plaintext)), cipher.final()]);
  return JSON.stringify({ format: FORMAT, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
}

export function decodeBackup(encoded, key) {
  const parsedKey = encryptionKey(key);
  try {
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("Too large");
    const envelope = JSON.parse(encoded);
    if (envelope.format !== FORMAT || ![envelope.nonce, envelope.tag, envelope.data].every((value) => typeof value === "string")) throw new Error("Invalid envelope");
    const nonce = Buffer.from(envelope.nonce, "base64"), tag = Buffer.from(envelope.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encryption metadata");
    const decipher = createDecipheriv("aes-256-gcm", parsedKey, nonce);
    decipher.setAAD(Buffer.from(FORMAT));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    return validateSnapshot(JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_BYTES }).toString("utf8")));
  } catch {
    throw new Error("Backup verification failed: wrong key, damaged file or unsupported schema");
  }
}

export async function captureSnapshot(client, { schema = "public", now = new Date() } = {}) {
  if (!["public", "pg_temp"].includes(schema)) throw new Error("Unsupported snapshot schema");
  const tables = {};
  for (const table of BACKUP_TABLES) {
    const rows = [];
    for (let offset = 0; ; offset += BATCH_ROWS) {
      const result = await client.query(`SELECT * FROM ${schema}.${table.name} ORDER BY ${table.order} LIMIT ${BATCH_ROWS} OFFSET ${offset}`);
      if (result.fields.map((field) => field.name).sort().join() !== [...table.columns].sort().join()) throw new Error("Live schema changed; update backup support before exporting");
      rows.push(...result.rows);
      if (rows.length > MAX_ROWS) throw new Error("Invalid backup row count");
      if (result.rows.length < BATCH_ROWS) break;
    }
    tables[table.name] = rows;
  }
  return validateSnapshot({ format: FORMAT, schemaHash: SCHEMA_HASH, createdAt: now.toISOString(), tables });
}

export function snapshotCounts(snapshot) {
  return Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, snapshot.tables[table.name].length]));
}

export async function readBackup(path, key = process.env.SUPABASE_BACKUP_KEY) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("Invalid backup file");
  return decodeBackup(await readFile(path, "utf8"), key);
}

export async function persistBackup(snapshot, { key = process.env.SUPABASE_BACKUP_KEY, backupRoot = CLOUD_BACKUP_ROOT, retention = Number(process.env.SUPABASE_BACKUP_RETENTION_COUNT || 14) } = {}) {
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw new Error("Cloud backup retention must be between 1 and 365");
  const encoded = encodeBackup(snapshot, key);
  const root = resolve(backupRoot);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Backup root must not be a symbolic link");
  const name = snapshot.createdAt.replace(/[-:.]/g, "") + "-" + randomBytes(4).toString("hex") + ".cjbackup";
  if (!FILE_PATTERN.test(name)) throw new Error("Invalid backup timestamp");
  const destination = join(root, name), temporary = destination + ".partial";
  try {
    await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
    await readBackup(temporary, key);
    await rename(temporary, destination);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && FILE_PATTERN.test(entry.name)).map((entry) => entry.name).sort().reverse();
  const valid = [];
  for (const entry of entries) {
    try { await readBackup(join(root, entry), key); valid.push(entry); } catch { /* Never delete damaged files or backups encrypted with another key. */ }
  }
  const removed = [];
  for (const entry of valid.slice(retention)) {
    const target = resolve(root, entry);
    if (dirname(target) !== root) throw new Error("Unsafe backup deletion target");
    await unlink(target);
    removed.push(entry);
  }
  return { destination, counts: snapshotCounts(snapshot), retention, removed };
}

export async function createCloudBackup(options = {}) {
  encryptionKey(options.key || process.env.SUPABASE_BACKUP_KEY);
  const pool = createPostgresPool();
  let client;
  try {
    client = await pool.connect();
    client.on("error", () => {});
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await captureSnapshot(client);
    await client.query("COMMIT");
    return await persistBackup(snapshot, options);
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      client.release();
    }
    await pool.end();
  }
}

export async function latestCloudBackup(backupRoot = CLOUD_BACKUP_ROOT) {
  const entries = (await readdir(backupRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && FILE_PATTERN.test(entry.name)).map((entry) => entry.name).sort().reverse();
  if (!entries.length) throw new Error("No cloud database backup found");
  return join(backupRoot, entries[0]);
}

async function restoreRows(client, snapshot, schema) {
  for (const table of BACKUP_TABLES) {
    const columns = table.columns.join(",");
    for (let offset = 0; offset < snapshot.tables[table.name].length; offset += BATCH_ROWS) {
      await client.query(`INSERT INTO ${schema}.${table.name} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${schema}.${table.name}, $1::jsonb)`, [JSON.stringify(snapshot.tables[table.name].slice(offset, offset + BATCH_ROWS))]);
    }
  }
  const restored = await captureSnapshot(client, { schema, now: new Date(snapshot.createdAt) });
  if (JSON.stringify(restored.tables) !== JSON.stringify(snapshot.tables)) throw new Error("Restored contents differ from backup");
  for (const name of ["jobs", "source_runs", "review_events"]) {
    const sequence = (await client.query("SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,'id')::regclass", [`${schema}.${name}`])).rows[0];
    if (!sequence || (schema === "public" ? sequence.nspname !== "public" : !sequence.nspname.startsWith("pg_temp_"))) throw new Error("Unsafe restore sequence target");
    const largest = snapshot.tables[name].reduce((max, row) => BigInt(row.id) > max ? BigInt(row.id) : max, 0n);
    const identifier = (value) => '"' + value.replaceAll('"', '""') + '"';
    // ALTER SEQUENCE is transactional, unlike setval on a persistent production sequence.
    await client.query(`ALTER SEQUENCE ${identifier(sequence.nspname)}.${identifier(sequence.relname)} RESTART WITH ${largest + 1n}`);
  }
  return { counts: snapshotCounts(restored), contents: "identical", identitySequences: "verified" };
}

export async function restoreDrill(client, snapshot) {
  validateSnapshot(snapshot);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query(SCHEMA.replace(/create table if not exists/gi, "CREATE TEMP TABLE"));
    const tables = (await client.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' AND relpersistence='t'")).rows;
    if (tables.length !== BACKUP_TABLES.length || BACKUP_TABLES.some((table) => !tables.some((row) => row.relname === table.name))) throw new Error("Restore isolation verification failed");
    const result = await restoreRows(client, snapshot, "pg_temp");
    for (const name of ["jobs", "source_runs", "review_events"]) {
      const next = (await client.query(`SELECT nextval(pg_get_serial_sequence('pg_temp.${name}','id')) AS id`)).rows[0].id;
      const largest = snapshot.tables[name].reduce((max, row) => BigInt(row.id) > max ? BigInt(row.id) : max, 0n);
      if (BigInt(next) <= largest) throw new Error("Restored identity sequence conflicts with existing rows");
    }
    return { ...result, productionWrites: false };
  } finally {
    await client.query("ROLLBACK");
  }
}

export function assertSeparateRestoreTarget(source, target) {
  const identity = (value) => {
    let url;
    try { url = new URL(value); } catch { throw new Error("Invalid restore database configuration"); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.password) throw new Error("Invalid restore database configuration");
    const direct = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (direct) return "supabase:" + direct[1] + url.pathname;
    if (url.hostname.endsWith(".pooler.supabase.com")) {
      const ref = decodeURIComponent(url.username).match(/\.([a-z0-9]+)$/)?.[1];
      if (!ref) throw new Error("Cannot identify Supabase restore project safely");
      return "supabase:" + ref + url.pathname;
    }
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  };
  if (identity(source) === identity(target)) throw new Error("Restore target must be a different database, not the live source");
}

export async function restoreEmptyTarget(client, snapshot, { schema = "public" } = {}) {
  validateSnapshot(snapshot);
  if (!["public", "pg_temp"].includes(schema)) throw new Error("Invalid restore schema");
  await client.query("BEGIN");
  try {
    await client.query(`LOCK TABLE ${BACKUP_TABLES.map((table) => `${schema}.${table.name}`).join(",")} IN ACCESS EXCLUSIVE MODE`);
    for (const table of BACKUP_TABLES) {
      const result = await client.query(`SELECT * FROM ${schema}.${table.name} LIMIT 1`);
      if (result.rows.length) throw new Error("Restore target is not empty; refusing to overwrite data");
      if (result.fields.map((field) => field.name).sort().join() !== [...table.columns].sort().join()) throw new Error("Restore schema mismatch");
    }
    const rls = (await client.query("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace=CASE WHEN $1='pg_temp' THEN pg_my_temp_schema() ELSE 'public'::regnamespace END AND relname=ANY($2::text[])", [schema, BACKUP_TABLES.map((table) => table.name)])).rows;
    if (rls.length !== 7 || rls.some((row) => !row.relrowsecurity)) throw new Error("Restore target must have RLS enabled on all application tables");
    const result = await restoreRows(client, snapshot, schema);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export async function verifyCloudBackup(path) {
  const selected = path || await latestCloudBackup();
  const snapshot = await readBackup(selected);
  const pool = createPostgresPool();
  let client;
  try {
    client = await pool.connect();
    client.on("error", () => {});
    const result = await restoreDrill(client, snapshot);
    return { backup: selected, verifiedAt: new Date().toISOString(), ...result };
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] && process.argv[2] !== "--verify") throw new Error("Unknown backup command");
    const result = process.argv[2] === "--verify" ? await verifyCloudBackup(process.argv[3]) : await createCloudBackup();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const { reportError } = await import("./monitor.mjs");
    await reportError(error, { operation: "backup.cloud" });
    console.error("Cloud backup/restore check failed; confirm configuration, key and connectivity. No production restore was performed.");
    process.exitCode = 1;
  }
}
