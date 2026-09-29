import { officialUrlForSourceName } from "./sources.mjs";

const STALE_AFTER_HOURS = 36;
const GROUP_KEY_SQL = `CASE WHEN dedupe_key <> '' AND EXISTS (
  SELECT 1 FROM jobs AS peer WHERE peer.review_status <> 'hidden'
    AND peer.dedupe_key=jobs.dedupe_key AND peer.source<>jobs.source
) THEN dedupe_key ELSE 'record:row:' || jobs.id END`;

export function listJobs(db, { q = "", limit = 100, offset = 0, now = Date.now() } = {}) {
  const search = String(q).trim().slice(0, 200);
  const like = `%${search}%`;
  const rows = db.prepare(`WITH normalized AS (
      SELECT id, source, source_id AS sourceId, company, title, job_type AS jobType, published_at AS publishedAt,
        deadline, recruiting_numbers AS recruitingNumbers, detail_url AS detailUrl, first_seen_at AS firstSeenAt,
        review_status AS reviewStatus, ${GROUP_KEY_SQL} AS groupKey
      FROM jobs WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?)
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY groupKey ORDER BY
        CASE reviewStatus WHEN 'approved' THEN 0 ELSE 1 END, publishedAt DESC, id DESC) AS rank
      FROM normalized
    )
    SELECT source, sourceId, company, title, jobType, publishedAt, deadline, recruitingNumbers,
      detailUrl, firstSeenAt, reviewStatus, groupKey
    FROM ranked WHERE rank=1 ORDER BY publishedAt DESC, id DESC LIMIT ? OFFSET ?`).all(search, like, like, limit, offset);
  const matchCount = db.prepare(`SELECT COUNT(DISTINCT ${GROUP_KEY_SQL}) AS total FROM jobs
    WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?)`).get(search, like, like).total;
  const memberRows = rows.length ? db.prepare(`SELECT source, source_id AS sourceId, published_at AS publishedAt,
      detail_url AS detailUrl, ${GROUP_KEY_SQL} AS groupKey
    FROM jobs WHERE review_status <> 'hidden' AND ${GROUP_KEY_SQL} IN (${rows.map(() => "?").join(",")})
    ORDER BY published_at DESC, id DESC`).all(...rows.map((row) => row.groupKey)) : [];
  const membersByGroup = new Map();
  for (const member of memberRows) {
    const members = membersByGroup.get(member.groupKey) || [];
    members.push(member);
    membersByGroup.set(member.groupKey, members);
  }
  const jobs = rows.map(({ groupKey, ...job }) => {
    const members = membersByGroup.get(groupKey) || [];
    const sourceLinks = members.map((member) => ({
      source: member.source,
      sourceId: member.sourceId,
      publishedAt: member.publishedAt,
      detailUrl: officialUrlForSourceName(member.source, member.detailUrl),
    })).filter((member) => member.detailUrl);
    const sources = new Set(members.map((member) => member.source));
    return {
      ...job,
      detailUrl: officialUrlForSourceName(job.source, job.detailUrl) || sourceLinks[0]?.detailUrl || "",
      sourceCount: sources.size || 1,
      duplicateCount: members.length || 1,
      sourceLinks,
    };
  });
  const stats = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT source) AS sources,
    SUM(CASE WHEN date(first_seen_at, '+8 hours') = date('now', '+8 hours') THEN 1 ELSE 0 END) AS todayNew,
    SUM(CASE WHEN deadline <> '' AND date(substr(deadline, 1, 10)) BETWEEN date('now', '+8 hours') AND date('now', '+8 hours', '+7 days') THEN 1 ELSE 0 END) AS dueSoon FROM jobs WHERE review_status <> 'hidden'`).get();
  stats.uniqueTotal = db.prepare(`SELECT COUNT(DISTINCT ${GROUP_KEY_SQL}) AS total FROM jobs WHERE review_status <> 'hidden'`).get().total;
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
