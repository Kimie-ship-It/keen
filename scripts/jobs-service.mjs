import { getSourceByName, officialUrlForSourceName } from "./sources.mjs";

const STALE_AFTER_HOURS = 36;
const GROUP_KEY_SQL = `CASE WHEN dedupe_key <> '' AND EXISTS (
  SELECT 1 FROM jobs AS peer WHERE peer.review_status <> 'hidden'
    AND peer.dedupe_key=jobs.dedupe_key AND peer.source<>jobs.source
) THEN dedupe_key ELSE 'record:row:' || jobs.id END`;

function hydrateJob(db, rows) {
  if (!rows.length) return null;
  const representative = [...rows].sort((a, b) => {
    const review = (a.reviewStatus === "approved" ? 0 : 1) - (b.reviewStatus === "approved" ? 0 : 1);
    return review || String(b.publishedAt).localeCompare(String(a.publishedAt)) || b.id - a.id;
  })[0];
  const memberIds = rows.map((row) => row.id);
  const placeholders = memberIds.map(() => "?").join(",");
  const locationRows = db.prepare(`SELECT job_id AS jobId, location FROM job_locations WHERE job_id IN (${placeholders}) ORDER BY location`).all(...memberIds);
  const industryRows = db.prepare(`SELECT job_id AS jobId, industry FROM job_industries WHERE job_id IN (${placeholders}) ORDER BY industry`).all(...memberIds);
  const locationsByJob = new Map();
  const industriesByJob = new Map();
  for (const row of locationRows) locationsByJob.set(row.jobId, [...(locationsByJob.get(row.jobId) || []), row.location]);
  for (const row of industryRows) industriesByJob.set(row.jobId, [...(industriesByJob.get(row.jobId) || []), row.industry]);
  const sourceLinks = rows.map((row) => ({
    source: row.source,
    sourceId: row.sourceId,
    publishedAt: row.publishedAt,
    detailUrl: officialUrlForSourceName(row.source, row.detailUrl),
  })).filter((row) => row.detailUrl);
  return {
    source: representative.source,
    sourceId: representative.sourceId,
    company: representative.company,
    title: representative.title,
    jobType: representative.jobType,
    publishedAt: representative.publishedAt,
    deadline: representative.deadline,
    recruitingNumbers: representative.recruitingNumbers,
    detailUrl: officialUrlForSourceName(representative.source, representative.detailUrl) || sourceLinks[0]?.detailUrl || "",
    firstSeenAt: representative.firstSeenAt,
    reviewStatus: representative.reviewStatus,
    sourceCount: new Set(rows.map((row) => row.source)).size || 1,
    duplicateCount: rows.length,
    locations: [...new Set(rows.flatMap((row) => locationsByJob.get(row.id) || []))],
    industries: [...new Set(rows.flatMap((row) => industriesByJob.get(row.id) || []))],
    sourceLinks,
  };
}

export function getJobDetail(db, { source, sourceId } = {}) {
  const sourceName = String(source || "").trim().slice(0, 100);
  const id = String(sourceId || "").trim().slice(0, 200);
  if (!sourceName || !id || !getSourceByName(sourceName)) return null;
  const target = db.prepare(`SELECT ${GROUP_KEY_SQL} AS groupKey FROM jobs WHERE source=? AND source_id=? AND review_status <> 'hidden'`).get(sourceName, id);
  if (!target) return null;
  const rows = db.prepare(`SELECT id, source, source_id AS sourceId, company, title, job_type AS jobType,
      published_at AS publishedAt, deadline, recruiting_numbers AS recruitingNumbers, detail_url AS detailUrl,
      first_seen_at AS firstSeenAt, review_status AS reviewStatus
    FROM jobs WHERE review_status <> 'hidden' AND ${GROUP_KEY_SQL}=? ORDER BY published_at DESC, id DESC`).all(target.groupKey);
  return hydrateJob(db, rows);
}

export function getSavedJobs(db, keys = []) {
  const uniqueKeys = [...new Set(keys.map((key) => String(key || "").trim()).filter(Boolean))].slice(0, 500);
  const jobs = [];
  for (const key of uniqueKeys) {
    const separator = key.indexOf(":");
    if (separator < 1 || separator === key.length - 1) continue;
    const job = getJobDetail(db, { source: key.slice(0, separator), sourceId: key.slice(separator + 1) });
    if (job) jobs.push({ ...job, savedKey: key });
  }
  return jobs;
}

export function listJobs(db, { q = "", source = "", city = "", industry = "", deadline = "", limit = 100, offset = 0, now = Date.now() } = {}) {
  const search = String(q).trim().slice(0, 200);
  const sourceName = String(source).trim().slice(0, 100);
  const cityName = String(city).trim().slice(0, 100);
  const industryName = String(industry).trim().slice(0, 100);
  const deadlineName = String(deadline).trim().slice(0, 20);
  const validDeadlineFilters = new Set(["", "open", "due7", "due30", "expired", "unknown"]);
  if (sourceName && !getSourceByName(sourceName)) throw new Error(`未知高校来源：${sourceName}`);
  if (cityName && !db.prepare("SELECT 1 FROM job_locations WHERE location=? LIMIT 1").get(cityName)) throw new Error(`未知工作城市：${cityName}`);
  if (industryName && !db.prepare("SELECT 1 FROM job_industries WHERE industry=? LIMIT 1").get(industryName)) throw new Error(`未知行业：${industryName}`);
  if (!validDeadlineFilters.has(deadlineName)) throw new Error(`未知截止日期筛选：${deadlineName}`);
  const like = `%${search}%`;
  const sourceFilter = sourceName ? " AND source = ?" : "";
  const sourceParams = sourceName ? [sourceName] : [];
  const cityFilter = cityName ? " AND EXISTS (SELECT 1 FROM job_locations AS location_filter WHERE location_filter.job_id=jobs.id AND location_filter.location=?)" : "";
  const cityParams = cityName ? [cityName] : [];
  const industryFilter = industryName ? " AND EXISTS (SELECT 1 FROM job_industries AS industry_filter WHERE industry_filter.job_id=jobs.id AND industry_filter.industry=?)" : "";
  const industryParams = industryName ? [industryName] : [];
  const today = new Date(Number(now)).toISOString().slice(0, 10);
  const deadlineSql = {
    "": "",
    open: " AND deadline <> '' AND date(substr(deadline, 1, 10)) >= date(?)",
    due7: " AND deadline <> '' AND date(substr(deadline, 1, 10)) BETWEEN date(?) AND date(?, '+7 days')",
    due30: " AND deadline <> '' AND date(substr(deadline, 1, 10)) BETWEEN date(?) AND date(?, '+30 days')",
    expired: " AND deadline <> '' AND date(substr(deadline, 1, 10)) < date(?)",
    unknown: " AND deadline = ''",
  }[deadlineName];
  const deadlineFilter = deadlineSql;
  const deadlineParams = deadlineName === "due7" || deadlineName === "due30" ? [today, today] : ["open", "expired"].includes(deadlineName) ? [today] : [];
  const groupKeySql = sourceName ? "'record:row:' || jobs.id" : GROUP_KEY_SQL;
  const rows = db.prepare(`WITH normalized AS (
      SELECT id, source, source_id AS sourceId, company, title, job_type AS jobType, published_at AS publishedAt,
        deadline, recruiting_numbers AS recruitingNumbers, detail_url AS detailUrl, first_seen_at AS firstSeenAt,
        review_status AS reviewStatus, ${groupKeySql} AS groupKey
      FROM jobs WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?)${sourceFilter}${cityFilter}${industryFilter}${deadlineFilter}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY groupKey ORDER BY
        CASE reviewStatus WHEN 'approved' THEN 0 ELSE 1 END, publishedAt DESC, id DESC) AS rank
      FROM normalized
    )
    SELECT source, sourceId, company, title, jobType, publishedAt, deadline, recruitingNumbers,
      detailUrl, firstSeenAt, reviewStatus, groupKey
    FROM ranked WHERE rank=1 ORDER BY publishedAt DESC, id DESC LIMIT ? OFFSET ?`).all(search, like, like, ...sourceParams, ...cityParams, ...industryParams, ...deadlineParams, limit, offset);
  const matchCount = db.prepare(`SELECT COUNT(DISTINCT ${groupKeySql}) AS total FROM jobs
    WHERE review_status <> 'hidden' AND (? = '' OR company LIKE ? OR title LIKE ?)${sourceFilter}${cityFilter}${industryFilter}${deadlineFilter}`).get(search, like, like, ...sourceParams, ...cityParams, ...industryParams, ...deadlineParams).total;
  const memberRows = rows.length ? db.prepare(`SELECT source, source_id AS sourceId, published_at AS publishedAt,
      detail_url AS detailUrl, id AS jobId, ${groupKeySql} AS groupKey
    FROM jobs WHERE review_status <> 'hidden' AND ${groupKeySql} IN (${rows.map(() => "?").join(",")})${sourceFilter}${cityFilter}${industryFilter}${deadlineFilter}
    ORDER BY published_at DESC, id DESC`).all(...rows.map((row) => row.groupKey), ...sourceParams, ...cityParams, ...industryParams, ...deadlineParams) : [];
  const locationRows = memberRows.length ? db.prepare(`SELECT job_id AS jobId, location FROM job_locations WHERE job_id IN (${memberRows.map(() => "?").join(",")}) ORDER BY location`).all(...memberRows.map((row) => row.jobId)) : [];
  const locationsByJob = new Map();
  for (const row of locationRows) locationsByJob.set(row.jobId, [...(locationsByJob.get(row.jobId) || []), row.location]);
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
      locations: [...new Set(members.flatMap((member) => locationsByJob.get(member.jobId) || []))],
      detailUrl: officialUrlForSourceName(job.source, job.detailUrl) || sourceLinks[0]?.detailUrl || "",
      sourceCount: sources.size || 1,
      duplicateCount: members.length || 1,
      sourceLinks,
    };
  });
  const stats = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT source) AS sources,
    SUM(CASE WHEN date(first_seen_at, '+8 hours') = date('now', '+8 hours') THEN 1 ELSE 0 END) AS todayNew,
    SUM(CASE WHEN deadline <> '' AND date(substr(deadline, 1, 10)) BETWEEN date('now', '+8 hours') AND date('now', '+8 hours', '+7 days') THEN 1 ELSE 0 END) AS dueSoon FROM jobs WHERE review_status <> 'hidden'${sourceFilter}${cityFilter}${industryFilter}${deadlineFilter}`).get(...sourceParams, ...cityParams, ...industryParams, ...deadlineParams);
  stats.uniqueTotal = db.prepare(`SELECT COUNT(DISTINCT ${groupKeySql}) AS total FROM jobs WHERE review_status <> 'hidden'${sourceFilter}${cityFilter}${industryFilter}${deadlineFilter}`).get(...sourceParams, ...cityParams, ...industryParams, ...deadlineParams).total;
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
  const locationOptions = db.prepare(`SELECT location, COUNT(*) AS total FROM job_locations
    INNER JOIN jobs ON jobs.id=job_locations.job_id WHERE jobs.review_status <> 'hidden'
    GROUP BY location ORDER BY total DESC, location`).all().map((row) => ({ location: row.location, total: row.total }));
  const industryOptions = db.prepare(`SELECT industry, COUNT(*) AS total FROM job_industries
    INNER JOIN jobs ON jobs.id=job_industries.job_id WHERE jobs.review_status <> 'hidden'
    GROUP BY industry ORDER BY CASE industry WHEN '未分类' THEN 1 ELSE 0 END, total DESC, industry`).all().map((row) => ({ industry: row.industry, total: row.total }));
  return {
    jobs,
    matchCount,
    stats: { ...stats, todayNew: stats.todayNew || 0, dueSoon: stats.dueSoon || 0 },
    sources,
    runs,
    freshness,
    locations: locationOptions,
    industries: industryOptions,
  };
}
