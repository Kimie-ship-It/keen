import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { SOURCES } from "./sources.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv.slice(2).join(" ").trim();
if (!name) throw new Error("请提供步骤名称，例如：npm run backup:step -- 完成采集过期提示");

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "step";
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const backupRoot = resolve(root, "..", "campus-jobs-backups");
const destination = join(backupRoot, `${stamp}-${slug(name)}`);
await mkdir(destination, { recursive: true });

const dbPath = join(root, "data", "campus-jobs.db");
if (existsSync(dbPath)) {
  const dbBackup = join(destination, "campus-jobs.db");
  const db = new Database(dbPath, { readonly: true });
  await db.backup(dbBackup);
  db.close();
}
const snapshots = [];
for (const id of Object.keys(SOURCES)) {
  const snapshot = join(root, "data", `${id}-recruitments.json`);
  if (!existsSync(snapshot)) continue;
  const filename = `${id}-recruitments.json`;
  await copyFile(snapshot, join(destination, filename));
  snapshots.push(filename);
}

let commit = "未创建 Git 提交";
try {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (status) {
    execFileSync("git", ["commit", "-m", `checkpoint: ${name}`], { cwd: root, stdio: "ignore" });
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } else {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  }
} catch (error) {
  throw new Error(`Git 版本快照失败：${error.message}`);
}

await writeFile(join(destination, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), step: name, gitCommit: commit }, null, 2) + "\n");
console.log(JSON.stringify({ destination, gitCommit: commit, database: existsSync(dbPath), snapshots }, null, 2));
