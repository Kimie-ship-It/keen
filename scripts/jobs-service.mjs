const STALE_AFTER_HOURS = 36;

export function listJobs(db, { q = "", limit = 100, offset = 0, now = Date.now() } = {}) {
  const search = String(q).trim().slice(0, 200);
  const like = `%${search}%`;
  const jobs = db.prepare(`SELECT source, source_id AS sourceId, company, title, job_type AS jobType, published_at AS publishedAt, deadline, recruiting_numbers AS recruitingNumbers, detail_url AS detailUrl, first_seen_at AS firstSeenAt, review_status AS reviewStatus
    FROM jobs WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?) ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).all(search, like, like, limit, offset);
  const matchCount = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?)").get(search, like, like).total;
  const stats = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT source) AS sources,
    SUM(CASE WHEN date(first_seen_at, '+8 hours') = date('now', '+8 hours') THEN 1 ELSE 0 END) AS todayNew,
    SUM(CASE WHEN deadline <> '' AND date(substr(deadline, 1, 10)) BETWEEN date('now', '+8 hours') AND date('now', '+8 hours', '+7 days') THEN 1 ELSE 0 END) AS dueSoon FROM jobs WHERE review_status <> 'hidden'`).get();
  const sourceRows = db.prepare(`WITH names AS (
      SELECT source FROM source_status WHERE last_status <> 'never'
      UNION SELECT source FROM jobs
    ), counts AS (
      SELECT source, COUNT(*) AS total FROM jobs WHERE review_status <> 'hidden' GROUP BY source
    )
    SELECT names.source, COALESCE(counts.total, 0) AS total,
      state.last_status AS lastStatus, state.last_finished_at AS lastFinishedAt,
      state.last_success_at AS lastSuccessfulAt, state.last_failure_at AS lastFailureAt
    FROM names LEFT JOIN counts ON counts.source=names.source
      LEFT JOIN source_status state ON state.source=names.source
    ORDER BY names.source`).all();
  const sources = sourceRows.map((source) => {
    const lastSuccessfulTime = source.lastSuccessfulAt ? Date.parse(source.lastSuccessfulAt) : Number.NaN;
    return {
      ...source,
      isStale: !Number.isFinite(lastSuccessfulTime) || Number(now) - lastSuccessfulTime > STALE_AFTER_HOURS * 60 * 60 * 1000,
    };
  });
  const runs = db.prepare("SELECT source, status, finished_at AS finishedAt, fetched_count AS fetchedCount, new_count AS newCount FROM source_runs ORDER BY id DESC LIMIT 20").all();
  const lastSuccessfulAt = db.prepare("SELECT MAX(finished_at) AS finishedAt FROM source_runs WHERE status='success'").get().finishedAt || null;
  const staleSources = sources.filter((source) => source.isStale).length;
  const failedSources = sources.filter((source) => source.lastStatus === "failed").length;
  const freshness = {
    lastSuccessfulAt,
    staleAfterHours: STALE_AFTER_HOURS,
    staleSources,
    failedSources,
    isStale: !lastSuccessfulAt || staleSources > 0 || failedSources > 0,
  };
  return {
    jobs,
    matchCount,
    stats: { ...stats, todayNew: stats.todayNew || 0, dueSoon: stats.dueSoon || 0 },
    sources,
    runs,
    freshness,
  };
}
