import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = process.env.CAMPUS_JOBS_DB || resolve(ROOT, "data", "campus-jobs.db");

export async function openDatabase(path = DB_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      job_type TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL DEFAULT '',
      deadline TEXT NOT NULL DEFAULT '',
      recruiting_numbers TEXT NOT NULL DEFAULT '',
      detail_url TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    );
    CREATE TABLE IF NOT EXISTS source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS review_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_auth_limits (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      window_started_at INTEGER NOT NULL,
      failures INTEGER NOT NULL
    );
  `);
  const columns = db.pragma("table_info(jobs)").map((column) => column.name);
  if (!columns.includes("review_status")) db.exec("ALTER TABLE jobs ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at); CREATE INDEX IF NOT EXISTS idx_runs_source ON source_runs(source, id); CREATE INDEX IF NOT EXISTS idx_review_events_id ON review_events(id)");
  return db;
}

export function closeDatabase(db) {
  if (db?.open) db.close();
}
