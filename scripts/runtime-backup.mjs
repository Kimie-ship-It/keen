import Database from "better-sqlite3";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "./db.mjs";
import { SOURCES } from "./sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BACKUP_ROOT = resolve(ROOT, "..", "campus-jobs-backups", "daily");

function readRetention(value) {
  const parsed = Number(value ?? 14);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) throw new Error("备份保留数量必须是 1 到 365 的整数");
  return parsed;
}

function backupName(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function createRuntimeBackup(options = {}) {
  const dbPath = options.dbPath || DB_PATH;
  const snapshotPaths = options.snapshotPaths || (options.snapshotPath
    ? [options.snapshotPath]
    : Object.keys(SOURCES).map((id) => resolve(ROOT, "data", `${id}-recruitments.json`)));
  const backupRoot = options.backupRoot || DEFAULT_BACKUP_ROOT;
  const retention = options.retention ?? readRetention(process.env.BACKUP_RETENTION_COUNT);
  const now = options.now || new Date();
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  const safeRoot = resolve(backupRoot);
  const destination = resolve(safeRoot, backupName(now));
  if (!destination.startsWith(safeRoot + sep)) throw new Error("备份目录超出允许范围");
  await mkdir(destination, { recursive: true });

  const targetDb = join(destination, "campus-jobs.db");
  const db = new Database(dbPath, { readonly: true });
  try { await db.backup(targetDb); } finally { db.close(); }
  const snapshots = [];
  for (const snapshotPath of snapshotPaths) {
    if (!existsSync(snapshotPath)) continue;
    const filename = snapshotPath.split(/[\\/]/).at(-1);
    await copyFile(snapshotPath, join(destination, filename));
    snapshots.push(filename);
  }
  await writeFile(join(destination, "manifest.json"), JSON.stringify({ createdAt: now.toISOString(), sourceDatabase: dbPath, snapshots }, null, 2) + "\n");

  const entries = (await readdir(safeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removed = [];
  for (const name of entries.slice(retention)) {
    const target = resolve(safeRoot, name);
    if (!target.startsWith(safeRoot + sep)) throw new Error("拒绝删除备份目录以外的路径");
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { destination, retention, removed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await createRuntimeBackup(), null, 2)); }
  catch (error) {
    const { reportError } = await import("./monitor.mjs");
    await reportError(error, { operation: "backup.local" });
    process.exitCode = 1;
  }
}
