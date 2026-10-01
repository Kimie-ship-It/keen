import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "./sources.mjs";

export const MONITOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/logs/errors");
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const LOG_RETENTION = 14;
const PATTERN = /^errors-\d{8}T\d{9}Z-[a-f0-9-]{36}\.ndjson$/;
const OPERATIONS = new Set(["jobs.list", "jobs.export", "admin.read", "admin.write", "sources.read", "sources.write", "server.request", "collection", "database.sync", "backup.local", "backup.cloud", "backup.offsite", "notification", "daily.pipeline", "health.database", "health.sources", "health.backup", "postgres.connection"]);
const ROUTES = { "jobs.list": "/api/jobs", "jobs.export": "/api/jobs/export", "admin.read": "/api/admin/reviews", "admin.write": "/api/admin/reviews", "sources.read": "/api/admin/sources", "sources.write": "/api/admin/sources" };
const CATEGORIES = new Set(["connection", "timeout", "authentication", "certificate", "constraint", "configuration", "stale", "internal"]);
const activeFiles = new Map();
let writing = Promise.resolve();

export function errorCategory(error) {
  const code = error?.code;
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "08000", "08006", "57P01"].includes(code)) return "connection";
  if (["ETIMEDOUT", "57014"].includes(code) || ["TimeoutError", "AbortError"].includes(error?.name) || /query read timeout|connection.*timeout/i.test(error?.message || "")) return "timeout";
  if (["28P01", "28000"].includes(code)) return "authentication";
  if (["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"].includes(code)) return "certificate";
  if (["23505", "23503", "23514", "23502"].includes(code)) return "constraint";
  return "internal";
}

export function createErrorEvent(error, context = {}, now = new Date()) {
  const operation = OPERATIONS.has(context.operation) ? context.operation : "server.request";
  return {
    format: "campus-jobs-error-v1", id: randomUUID(), occurredAt: now.toISOString(),
    severity: context.severity === "warning" ? "warning" : "error",
    operation, category: CATEGORIES.has(context.category) ? context.category : errorCategory(error),
    ...(Object.hasOwn(SOURCES, context.source) ? { source: context.source } : {}),
    ...(ROUTES[operation] ? { route: ROUTES[operation] } : {}),
    ...(["GET", "POST"].includes(context.method) ? { method: context.method } : {}),
  };
}

async function safeRoot(root, create = false) {
  if (create) await mkdir(root, { recursive: true });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid monitor log directory");
}

async function writeEvent(event, root) {
  await safeRoot(root, true);
  const line = JSON.stringify(event) + "\n";
  const day = event.occurredAt.slice(0, 10);
  let current = activeFiles.get(root);
  if (current?.day === day) {
    try {
      const stat = await lstat(current.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid monitor log file");
      if (stat.size + Buffer.byteLength(line) > MAX_LOG_BYTES) current = undefined;
    } catch (error) { if (error.code === "ENOENT") current = undefined; else throw error; }
  } else current = undefined;
  if (!current) {
    const name = `errors-${event.occurredAt.replace(/[-:.]/g, "")}-${randomUUID()}.ndjson`;
    current = { day, path: join(root, name) };
    await appendFile(current.path, line, { flag: "ax", mode: 0o600 });
    activeFiles.set(root, current);
  } else await appendFile(current.path, line);
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && PATTERN.test(entry.name)).map((entry) => entry.name).sort().reverse();
  for (const name of entries.slice(LOG_RETENTION)) {
    const target = resolve(root, name);
    if (dirname(target) !== root) throw new Error("Unsafe log retention target");
    try { await unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function reportError(error, context = {}, { root = MONITOR_ROOT, env = process.env, log = console.error, now = new Date() } = {}) {
  const event = createErrorEvent(error, context, now);
  try { log(JSON.stringify(event)); } catch { /* Monitoring must not replace the original error. */ }
  if (env.VERCEL !== "1") {
    // Runtime logs are external state, never deployment assets.
    const task = writing.then(() => writeEvent(event, resolve(/* turbopackIgnore: true */ root)));
    writing = task.catch(() => {});
    try { await task; } catch {
      try { log(JSON.stringify({ format: "campus-jobs-monitor-v1", status: "log-write-failed", eventId: event.id })); } catch { /* Keep the application available. */ }
    }
  }
  return event;
}

function validEvent(event) {
  if (event?.format !== "campus-jobs-error-v1" || !/^[a-f0-9-]{36}$/.test(event.id || "") || !Number.isFinite(Date.parse(event.occurredAt)) || !OPERATIONS.has(event.operation) || !CATEGORIES.has(event.category) || !["error", "warning"].includes(event.severity)) return null;
  // Only return known fields even if a local file was manually edited.
  return { format: event.format, id: event.id, occurredAt: new Date(event.occurredAt).toISOString(), operation: event.operation, category: event.category, severity: event.severity,
    ...(Object.hasOwn(SOURCES, event.source) ? { source: event.source } : {}),
    ...(ROUTES[event.operation] ? { route: ROUTES[event.operation] } : {}),
    ...(["GET", "POST"].includes(event.method) ? { method: event.method } : {}) };
}

export async function readErrorEvents({ root = MONITOR_ROOT, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid monitor result limit");
  root = resolve(/* turbopackIgnore: true */ root);
  try { await safeRoot(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const names = (await readdir(/* turbopackIgnore: true */ root, { withFileTypes: true })).filter((entry) => entry.isFile() && PATTERN.test(entry.name)).map((entry) => entry.name).sort().reverse().slice(0, LOG_RETENTION);
  const events = [];
  for (const name of names) {
    const path = join(root, name);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LOG_BYTES) continue;
    const lines = (await readFile(path, "utf8")).split("\n");
    for (const line of lines) {
      try { const event = validEvent(JSON.parse(line)); if (event) events.push(event); } catch { /* Ignore incomplete or invalid records. */ }
    }
  }
  return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit);
}
