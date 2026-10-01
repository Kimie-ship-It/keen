import "./config.mjs";
import Database from "better-sqlite3";
import { DB_PATH } from "./db.mjs";
import { createPostgresPool } from "./postgres.mjs";


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

export async function syncRows(client, data) {
  const insertBatches = async (rows, table, columns, valuesFor, conflict) => {
    for (let offset = 0; offset < rows.length; offset += 200) {
      const part = rows.slice(offset, offset + 200);
      const params = [];
      const values = part.map((row) => {
        const rowValues = valuesFor(row);
        return "(" + rowValues.map((value) => { params.push(value); return "$" + params.length; }).join(",") + ")";
      }).join(",");
      await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values} ${conflict}`, params);
    }
  };
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(72461002)");
    if (!data.jobs.length) throw new Error("Refusing to synchronize an empty local database");
    const existing = (await client.query("SELECT id, source, source_id FROM jobs")).rows;
    const localIds = new Map(data.jobs.map((row) => [`${row.source}:${row.source_id}`, row.id]));
    for (const row of existing) {
      const localId = localIds.get(`${row.source}:${row.source_id}`);
      if (localId !== undefined && localId !== Number(row.id)) throw new Error("Local/cloud job IDs differ; synchronization aborted");
    }
    // Cloud reviews and authentication limits are authoritative, never collector-owned.
    await insertBatches(data.jobs, "jobs", ["id", "source", "source_id", "company", "title", "job_type", "published_at", "deadline", "recruiting_numbers", "detail_url", "first_seen_at", "last_seen_at", "review_status", "dedupe_key", "location_checked_at"], (row) => [row.id, row.source, row.source_id, row.company, row.title, row.job_type, row.published_at, row.deadline, row.recruiting_numbers, row.detail_url, row.first_seen_at, row.last_seen_at, "pending", row.dedupe_key, row.location_checked_at], "ON CONFLICT (source, source_id) DO UPDATE SET company=EXCLUDED.company, title=EXCLUDED.title, job_type=EXCLUDED.job_type, published_at=EXCLUDED.published_at, deadline=EXCLUDED.deadline, recruiting_numbers=EXCLUDED.recruiting_numbers, detail_url=EXCLUDED.detail_url, first_seen_at=EXCLUDED.first_seen_at, last_seen_at=EXCLUDED.last_seen_at, dedupe_key=EXCLUDED.dedupe_key, location_checked_at=EXCLUDED.location_checked_at");
    await client.query("DELETE FROM job_locations");
    await insertBatches(data.jobLocations, "job_locations", ["job_id", "location"], (row) => [row.job_id, row.location], "ON CONFLICT DO NOTHING");
    await client.query("DELETE FROM job_industries");
    await insertBatches(data.jobIndustries, "job_industries", ["job_id", "industry"], (row) => [row.job_id, row.industry], "ON CONFLICT DO NOTHING");
    for (const row of data.sourceRuns) await client.query(`INSERT INTO source_runs (id, source, started_at, finished_at, status, fetched_count, new_count, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET source=EXCLUDED.source, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at, status=EXCLUDED.status, fetched_count=EXCLUDED.fetched_count, new_count=EXCLUDED.new_count, error=EXCLUDED.error`, [row.id, row.source, row.started_at, row.finished_at, row.status, row.fetched_count, row.new_count, row.error]);
    for (const row of data.sourceStatus) await client.query(`INSERT INTO source_status (source, last_started_at, last_finished_at, last_status, last_success_at, last_failure_at, last_error, fetched_count, new_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source) DO UPDATE SET last_started_at=EXCLUDED.last_started_at, last_finished_at=EXCLUDED.last_finished_at, last_status=EXCLUDED.last_status, last_success_at=EXCLUDED.last_success_at, last_failure_at=EXCLUDED.last_failure_at, last_error=EXCLUDED.last_error, fetched_count=EXCLUDED.fetched_count, new_count=EXCLUDED.new_count`, [row.source, row.last_started_at, row.last_finished_at, row.last_status, row.last_success_at, row.last_failure_at, row.last_error, row.fetched_count, row.new_count]);
    await client.query("SELECT setval(pg_get_serial_sequence('jobs','id'), COALESCE((SELECT MAX(id) FROM jobs), 1), true)");
    await client.query("SELECT setval(pg_get_serial_sequence('source_runs','id'), COALESCE((SELECT MAX(id) FROM source_runs), 1), true)");
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original sync error. */ }
    throw error;
  }
}

export async function syncLocalToSupabase({ dbPath = DB_PATH } = {}) {
  const pool = createPostgresPool();
  let client;
  try {
    client = await pool.connect();
    client.on("error", () => {});
    const data = readLocalDatabase(dbPath);
    await syncRows(client, data);
    return { jobs: data.jobs.length, jobLocations: data.jobLocations.length, jobIndustries: data.jobIndustries.length, sourceRuns: data.sourceRuns.length, sourceStatus: data.sourceStatus.length, reviewState: "cloud-owned" };
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function checkSupabaseConnection() {
  const pool = createPostgresPool();
  try {
    const result = await pool.query("SELECT current_database() AS database, current_user AS user_name");
    return result.rows[0];
  } finally { await pool.end(); }
}

if (process.argv[1] && process.argv[1].endsWith("supabase-sync.mjs")) {
  const result = process.argv.includes("--check") ? await checkSupabaseConnection() : await syncLocalToSupabase();
  console.log(JSON.stringify(result));
}
