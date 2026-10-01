import "./config.mjs";
import Database from "better-sqlite3";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPostgresPool } from "./postgres.mjs";
import { postgresDatabase, closeRuntimePool } from "./runtime-db.mjs";
import { BACKUP_TABLES } from "./supabase-backup.mjs";
import { credentialPath, readOffsiteAuthorization } from "./offsite-backup.mjs";
import { runDaily } from "./collect-daily.mjs";

export const COLLECTOR_TABLES = BACKUP_TABLES.filter((table) =>
  ["jobs", "job_locations", "job_industries", "source_runs", "source_status"].includes(table.name));
const MAX_ROWS = 250000;

export function validateCloudCollectorConfig(env = process.env) {
  if (env.CAMPUS_JOBS_STORAGE !== "supabase" || env.VERCEL === "1") throw new Error("Use a dedicated Supabase collector worker, not the website runtime");
  if (env.SUPABASE_SSL_INSECURE === "1") throw new Error("Cloud collection requires verified database TLS");
  let url;
  try { url = new URL(env.SUPABASE_DB_URL || env.DATABASE_URL); }
  catch { throw new Error("Missing or invalid cloud database configuration"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error("Missing or invalid cloud database configuration");
  if (!isAbsolute(env.CAMPUS_JOBS_DB || "")) throw new Error("Configure the absolute path of the seeded collector database");
  if (!/^[a-f0-9]{64}$/i.test(env.SUPABASE_BACKUP_KEY || "")) throw new Error("Configure the existing cloud backup key before collection");
  if (env.BAIDU_OFFSITE_ENABLED !== "1" || !env.BAIDU_OFFSITE_CREDENTIAL_FILE) throw new Error("An accepted offsite backup configuration is required before cloud collection");
  return { dbPath: resolve(env.CAMPUS_JOBS_DB), authorization: credentialPath(env) };
}

function canonicalRows(rows, table) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error("Invalid collector baseline size");
  const columns = table.columns.filter((column) => column !== "review_status");
  const keys = [...table.columns].sort();
  const canonical = rows.map((row) => {
    if (!row || !isDeepStrictEqual(Object.keys(row).sort(), keys) ||
        Object.values(row).some((value) => value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value)))) throw new Error("Invalid collector baseline row");
    return JSON.stringify(columns.map((column) => row[column]));
  }).sort();
  if (new Set(canonical).size !== canonical.length) throw new Error("Duplicate collector baseline row");
  return canonical;
}

export function assertCollectorBaseline(local, cloud) {
  if (!local?.jobs?.length || !cloud?.jobs?.length) throw new Error("Seed the collector from current data; an empty baseline is not allowed");
  const counts = {};
  for (const table of COLLECTOR_TABLES) {
    // Website reviews remain cloud-owned and are deliberately not a startup equality condition.
    if (!isDeepStrictEqual(canonicalRows(local[table.name], table), canonicalRows(cloud[table.name], table))) throw new Error(`Collector baseline differs in ${table.name}; reconcile before starting`);
    counts[table.name] = local[table.name].length;
  }
  return counts;
}

export function readLocalCollectorState(dbPath) {
  const info = lstatSync(dbPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid collector database file");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Collector database integrity check failed");
      const tables = {};
      for (const table of COLLECTOR_TABLES) {
        tables[table.name] = db.prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.order} LIMIT ${MAX_ROWS + 1}`).all();
        canonicalRows(tables[table.name], table);
      }
      if (!tables.jobs.length) throw new Error("Seed the collector database before starting");
      return tables;
    })();
  } finally { db.close(); }
}

export async function readCloudCollectorState(pool) {
  let client;
  let failed = false;
  let problem;
  const tables = {};
  try {
    client = await pool.connect();
    client.on("error", () => { failed = true; });
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const db = postgresDatabase(client);
    for (const table of COLLECTOR_TABLES) {
      const rows = [];
      for (let offset = 0; ; offset += 200) {
        const batch = await db.prepare(`SELECT ${table.columns.join(", ")} FROM public.${table.name} ORDER BY ${table.order} LIMIT 200 OFFSET ${offset}`).all();
        rows.push(...batch);
        if (rows.length > MAX_ROWS) throw new Error("Collector baseline exceeds the supported size");
        if (batch.length < 200) break;
      }
      canonicalRows(rows, table);
      tables[table.name] = rows;
    }
    if (failed) throw new Error("Cloud collector connection failed during startup");
  } catch (error) {
    problem = error;
  } finally {
    try { if (client) await client.query("ROLLBACK"); }
    catch { failed = true; problem ||= new Error("Cloud collector startup transaction did not close"); }
    finally {
      try { client?.release(failed); }
      catch { problem ||= new Error("Cloud collector startup client did not release"); }
      try { await pool.end(); }
      catch { problem ||= new Error("Cloud collector startup connection did not close"); }
    }
  }
  if (problem) throw problem;
  return tables;
}

export async function checkCollectorBaseline({ dbPath, env = process.env, makePool = createPostgresPool } = {}) {
  const local = readLocalCollectorState(dbPath);
  const cloud = await readCloudCollectorState(makePool(env));
  return assertCollectorBaseline(local, cloud);
}

export async function runCloudDaily({ env = process.env, readAuthorization = readOffsiteAuthorization, checkBaseline = checkCollectorBaseline, daily = runDaily } = {}) {
  const enabled = env.CAMPUS_CLOUD_COLLECTOR_ENABLED;
  if (!enabled || enabled === "0") return { status: "disabled", collectionStarted: false };
  if (enabled !== "1") throw new Error("Invalid cloud collector enable flag");
  const config = validateCloudCollectorConfig(env);
  await readAuthorization(config.authorization);
  const baseline = await checkBaseline({ dbPath: config.dbPath, env });
  const result = await daily({ env });
  return { ...result, collectionStarted: true, baseline };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCloudDaily();
    console.log(JSON.stringify({ cloudDaily: result }));
    if (!["ok", "disabled"].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    const { reportError } = await import("./monitor.mjs");
    await reportError(error, { operation: "daily.pipeline" });
    console.error("Cloud collection stopped; check the sanitized error record. No startup failure is treated as success.");
    process.exitCode = 1;
  } finally { await closeRuntimePool(); }
}
