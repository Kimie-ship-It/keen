import Database from "better-sqlite3";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = resolve(root, "..", "campus-jobs-backups", "daily");
if (!existsSync(backupRoot)) throw new Error("尚未找到每日数据库备份");

const backups = (await readdir(backupRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .reverse();
if (!backups.length) throw new Error("每日备份目录中没有可恢复的数据库");

const source = join(backupRoot, backups[0], "campus-jobs.db");
if (!existsSync(source)) throw new Error("最新备份缺少数据库文件");
const temporary = await mkdtemp(join(tmpdir(), "campus-jobs-restore-"));
const restoredPath = join(temporary, "campus-jobs.db");

try {
  await copyFile(source, restoredPath);
  const db = new Database(restoredPath, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const jobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
  const sources = db.prepare("SELECT COUNT(DISTINCT source) AS count FROM jobs").get().count;
  const latestRun = db.prepare("SELECT source, status, finished_at AS finishedAt FROM source_runs ORDER BY id DESC LIMIT 1").get();
  db.close();
  if (integrity !== "ok") throw new Error(`数据库完整性检查失败：${integrity}`);
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), backup: source, integrity, jobs, sources, latestRun }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
