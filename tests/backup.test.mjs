import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createRuntimeBackup } from "../scripts/runtime-backup.mjs";

test("数据库定期备份、可读取并按数量保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-backup-"));
  const dbPath = join(dir, "source.db");
  const snapshotPath = join(dir, "snapshot.json");
  const backupRoot = join(dir, "backups");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO jobs (title) VALUES ('测试招聘')");
  db.close();
  await writeFile(snapshotPath, "[]\n");
  try {
    for (const day of [1, 2, 3]) {
      await createRuntimeBackup({ dbPath, snapshotPath, backupRoot, retention: 2, now: new Date(`2026-09-0${day}T00:00:00Z`) });
    }
    const backups = (await readdir(backupRoot)).sort();
    assert.deepEqual(backups, ["20260902T000000Z", "20260903T000000Z"]);
    const restored = new Database(join(backupRoot, backups[1], "campus-jobs.db"), { readonly: true });
    assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(restored.prepare("SELECT title FROM jobs").get().title, "测试招聘");
    restored.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
