export function listJobs(db, { q = "", limit = 100, offset = 0 } = {}) {
  const search = String(q).trim().slice(0, 200);
  const like = `%${search}%`;
  const jobs = db.prepare(`SELECT source, source_id AS sourceId, company, title, job_type AS jobType, published_at AS publishedAt, deadline, recruiting_numbers AS recruitingNumbers, detail_url AS detailUrl, first_seen_at AS firstSeenAt, review_status AS reviewStatus
    FROM jobs WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?) ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).all(search, like, like, limit, offset);
  const matchCount = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?)").get(search, like, like).total;
  const stats = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT source) AS sources,
    SUM(CASE WHEN date(first_seen_at, '+8 hours') = date('now', '+8 hours') THEN 1 ELSE 0 END) AS todayNew,
    SUM(CASE WHEN deadline <> '' AND date(substr(deadline, 1, 10)) BETWEEN date('now', '+8 hours') AND date('now', '+8 hours', '+7 days') THEN 1 ELSE 0 END) AS dueSoon FROM jobs WHERE review_status <> 'hidden'`).get();
  const sources = db.prepare("SELECT source, COUNT(*) AS total FROM jobs WHERE review_status <> 'hidden' GROUP BY source ORDER BY source").all();
  const runs = db.prepare("SELECT source, status, finished_at AS finishedAt, fetched_count AS fetchedCount, new_count AS newCount FROM source_runs ORDER BY id DESC LIMIT 20").all();
  return {
    jobs,
    matchCount,
    stats: { ...stats, todayNew: stats.todayNew || 0, dueSoon: stats.dueSoon || 0 },
    sources,
    runs,
  };
}
