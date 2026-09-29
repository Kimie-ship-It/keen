export function refreshSourceStatus(db, source) {
  const latest = db.prepare(`SELECT started_at AS startedAt, finished_at AS finishedAt, status,
    fetched_count AS fetchedCount, new_count AS newCount, error
    FROM source_runs WHERE source=? ORDER BY id DESC LIMIT 1`).get(source);
  if (!latest) return;
  const lastSuccessAt = db.prepare("SELECT MAX(finished_at) AS time FROM source_runs WHERE source=? AND status='success'").get(source).time;
  const lastFailureAt = db.prepare("SELECT MAX(finished_at) AS time FROM source_runs WHERE source=? AND status='failed'").get(source).time;
  db.prepare(`INSERT INTO source_status
    (source, last_started_at, last_finished_at, last_status, last_success_at, last_failure_at, last_error, fetched_count, new_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      last_started_at=excluded.last_started_at, last_finished_at=excluded.last_finished_at,
      last_status=excluded.last_status, last_success_at=excluded.last_success_at,
      last_failure_at=excluded.last_failure_at, last_error=excluded.last_error,
      fetched_count=excluded.fetched_count, new_count=excluded.new_count`)
    .run(source, latest.startedAt, latest.finishedAt, latest.status, lastSuccessAt, lastFailureAt,
      latest.status === "failed" ? latest.error : null, latest.fetchedCount, latest.newCount);
}
