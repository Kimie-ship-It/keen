import "./config.mjs";
import Database from "better-sqlite3";
import pg from "pg";
import { DB_PATH } from "./db.mjs";

const { Pool } = pg;
const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

function requiredConnectionString() {
  if (!connectionString) throw new Error("未配置 SUPABASE_DB_URL 或 DATABASE_URL，已跳过云端同步");
  return connectionString;
}

function readLocalDatabase(path = DB_PATH) {
  const db = new Database(path, { readonly: true });
  try {
    const read = (table) => db.prepare(`SELECT * FROM ${table}`).all();
    return {
      jobs: read("jobs"),
      jobLocations: read("job_locations"),
      jobIndustries: read("job_industries"),
      sourceRuns: read("source_runs"),
      sourceStatus: read("source_status"),
      reviewEvents: read("review_events"),
      adminAuthLimits: read("admin_auth_limits"),
    };
  } finally {
    db.close();
  }
}

async function syncRows(client, data) {
  await client.query("BEGIN");
  try {
    for (const row of data.jobs) {
      await client.query(`
        INSERT INTO jobs (id, source, source_id, company, title, job_type, published_at, deadline, recruiting_numbers, detail_url, first_seen_at, last_seen_at, review_status, dedupe_key, location_checked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (source, source_id) DO UPDATE SET company=EXCLUDED.company, title=EXCLUDED.title, job_type=EXCLUDED.job_type, published_at=EXCLUDED.published_at, deadline=EXCLUDED.deadline, recruiting_numbers=EXCLUDED.recruiting_numbers, detail_url=EXCLUDED.detail_url, first_seen_at=EXCLUDED.first_seen_at, last_seen_at=EXCLUDED.last_seen_at, review_status=EXCLUDED.review_status, dedupe_key=EXCLUDED.dedupe_key, location_checked_at=EXCLUDED.location_checked_at`,
        [row.id, row.source, row.source_id, row.company, row.title, row.job_type, row.published_at, row.deadline, row.recruiting_numbers, row.detail_url, row.first_seen_at, row.last_seen_at, row.review_status, row.dedupe_key, row.location_checked_at]);
    }
    await client.query("DELETE FROM job_locations");
    for (const row of data.jobLocations) await client.query("INSERT INTO job_locations (job_id, location) VALUES ($1,$2) ON CONFLICT DO NOTHING", [row.job_id, row.location]);
    await client.query("DELETE FROM job_industries");
    for (const row of data.jobIndustries) await client.query("INSERT INTO job_industries (job_id, industry) VALUES ($1,$2) ON CONFLICT DO NOTHING", [row.job_id, row.industry]);
    for (const row of data.sourceRuns) await client.query(`INSERT INTO source_runs (id, source, started_at, finished_at, status, fetched_count, new_count, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET source=EXCLUDED.source, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at, status=EXCLUDED.status, fetched_count=EXCLUDED.fetched_count, new_count=EXCLUDED.new_count, error=EXCLUDED.error`, [row.id, row.source, row.started_at, row.finished_at, row.status, row.fetched_count, row.new_count, row.error]);
    for (const row of data.sourceStatus) await client.query(`INSERT INTO source_status (source, last_started_at, last_finished_at, last_status, last_success_at, last_failure_at, last_error, fetched_count, new_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source) DO UPDATE SET last_started_at=EXCLUDED.last_started_at, last_finished_at=EXCLUDED.last_finished_at, last_status=EXCLUDED.last_status, last_success_at=EXCLUDED.last_success_at, last_failure_at=EXCLUDED.last_failure_at, last_error=EXCLUDED.last_error, fetched_count=EXCLUDED.fetched_count, new_count=EXCLUDED.new_count`, [row.source, row.last_started_at, row.last_finished_at, row.last_status, row.last_success_at, row.last_failure_at, row.last_error, row.fetched_count, row.new_count]);
    for (const row of data.reviewEvents) await client.query(`INSERT INTO review_events (id, source, source_id, old_status, new_status, actor, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET source=EXCLUDED.source, source_id=EXCLUDED.source_id, old_status=EXCLUDED.old_status, new_status=EXCLUDED.new_status, actor=EXCLUDED.actor, created_at=EXCLUDED.created_at`, [row.id, row.source, row.source_id, row.old_status, row.new_status, row.actor, row.created_at]);
    for (const row of data.adminAuthLimits) await client.query("INSERT INTO admin_auth_limits (id, window_started_at, failures) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET window_started_at=EXCLUDED.window_started_at, failures=EXCLUDED.failures", [row.id, row.window_started_at, row.failures]);
    await client.query("SELECT setval(pg_get_serial_sequence('jobs','id'), COALESCE((SELECT MAX(id) FROM jobs), 1), true)");
    await client.query("SELECT setval(pg_get_serial_sequence('source_runs','id'), COALESCE((SELECT MAX(id) FROM source_runs), 1), true)");
    await client.query("SELECT setval(pg_get_serial_sequence('review_events','id'), COALESCE((SELECT MAX(id) FROM review_events), 1), true)");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function syncLocalToSupabase({ dbPath = DB_PATH } = {}) {
  const pool = new Pool({ connectionString: requiredConnectionString(), max: 1, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    const data = readLocalDatabase(dbPath);
    await syncRows(client, data);
    return { jobs: data.jobs.length, jobLocations: data.jobLocations.length, jobIndustries: data.jobIndustries.length, sourceRuns: data.sourceRuns.length, sourceStatus: data.sourceStatus.length, reviewEvents: data.reviewEvents.length, adminAuthLimits: data.adminAuthLimits.length };
  } finally {
    client.release();
    await pool.end();
  }
}

export async function checkSupabaseConnection() {
  const pool = new Pool({ connectionString: requiredConnectionString(), max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const result = await pool.query("SELECT current_database() AS database, current_user AS user_name");
    return result.rows[0];
  } finally { await pool.end(); }
}

if (process.argv[1] && process.argv[1].endsWith("supabase-sync.mjs")) {
  const result = process.argv.includes("--check") ? await checkSupabaseConnection() : await syncLocalToSupabase();
  console.log(JSON.stringify(result));
}
