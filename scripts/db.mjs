import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "./sources.mjs";
import { refreshSourceStatus } from "./source-status.mjs";
import { createDedupeKey } from "./dedupe.mjs";
import { classifyIndustries } from "./industries.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = process.env.CAMPUS_JOBS_DB || resolve(ROOT, "data", "campus-jobs.db");

export async function openDatabase(path = DB_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  const hadSourceStatus = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_status'").get();
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
    CREATE TABLE IF NOT EXISTS job_locations (
      job_id INTEGER NOT NULL,
      location TEXT NOT NULL,
      PRIMARY KEY (job_id, location),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS job_industries (
      job_id INTEGER NOT NULL,
      industry TEXT NOT NULL,
      PRIMARY KEY (job_id, industry),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
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
    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'never',
      last_success_at TEXT,
      last_failure_at TEXT,
      last_error TEXT,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS source_controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('restrict', 'restore')),
      reason TEXT NOT NULL CHECK (reason IN ('source_request', 'privacy', 'copyright', 'inaccurate', 'resolved')),
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_controls_source ON source_controls (source, id DESC);
  `);
  const columns = db.pragma("table_info(jobs)").map((column) => column.name);
  if (!columns.includes("review_status")) db.exec("ALTER TABLE jobs ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'");
  if (!columns.includes("dedupe_key")) db.exec("ALTER TABLE jobs ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''");
  if (!columns.includes("location_checked_at")) db.exec("ALTER TABLE jobs ADD COLUMN location_checked_at TEXT NOT NULL DEFAULT ''");
  const missingDedupeKeys = db.prepare("SELECT id, source, source_id AS sourceId, company, title FROM jobs WHERE dedupe_key='' OR dedupe_key IS NULL").all();
  if (missingDedupeKeys.length) {
    const updateDedupeKey = db.prepare("UPDATE jobs SET dedupe_key=? WHERE id=?");
    db.transaction(() => {
      for (const row of missingDedupeKeys) updateDedupeKey.run(createDedupeKey(row), row.id);
    })();
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at); CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key); CREATE INDEX IF NOT EXISTS idx_runs_source ON source_runs(source, id); CREATE INDEX IF NOT EXISTS idx_review_events_id ON review_events(id); CREATE INDEX IF NOT EXISTS idx_job_locations_location ON job_locations(location, job_id); CREATE INDEX IF NOT EXISTS idx_job_industries_industry ON job_industries(industry, job_id)");
  const unclassifiedJobs = db.prepare("SELECT jobs.id, jobs.company, jobs.title, jobs.job_type AS jobType FROM jobs LEFT JOIN job_industries ON job_industries.job_id=jobs.id WHERE job_industries.job_id IS NULL").all();
  if (unclassifiedJobs.length) {
    const addIndustry = db.prepare("INSERT OR IGNORE INTO job_industries (job_id, industry) VALUES (?, ?)");
    db.transaction(() => {
      for (const job of unclassifiedJobs) for (const industry of classifyIndustries(job)) addIndustry.run(job.id, industry);
    })();
  }
  db.transaction(() => {
    const seed = db.prepare("INSERT OR IGNORE INTO source_status (source) VALUES (?)");
    for (const source of Object.values(SOURCES)) seed.run(source.name);
    if (!hadSourceStatus) {
      for (const { source } of db.prepare("SELECT DISTINCT source FROM source_runs").all()) refreshSourceStatus(db, source);
    }
  })();
  return db;
}

export function closeDatabase(db) {
  if (db?.open) db.close();
}
