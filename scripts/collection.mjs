import { getSource, officialUrl } from "./sources.mjs";
import { createDedupeKey } from "./dedupe.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestJson(url, options = {}, settings = {}) {
  const { fetchImpl = fetch, wait = sleep, timeout = 15000, retries = 3 } = settings;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const error = new Error("接口返回 HTTP " + response.status);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt + 1 === retries) break;
      await wait(500 * 2 ** attempt);
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

export function normalizeItem(sourceId, item, now) {
  const source = getSource(sourceId);
  if (!item || !item.id || !item.title) throw new Error("接口记录缺少招聘 ID 或标题");
  const fallback = "/f/recruitmentinfo/show?recruitmentId=" + encodeURIComponent(item.id);
  // The school sometimes emits paths beginning with two slashes.
  const value = String(item.detailsUrl || item.url || fallback);
  const candidate = value.startsWith("//") ? "/" + value.replace(/^\/+/, "") : value;
  // Some schools put an external article in `url`. Keep the record, but only
  // expose the school's own detail page so public links remain on the allowlist.
  const detailUrl = officialUrl(source.id, candidate) || officialUrl(source.id, fallback);
  if (!detailUrl) throw new Error("招聘来源链接不合法");
  return {
    source: source.name, sourceId: String(item.id), company: String(item.corporationName || item.corporationinfo?.name || ""),
    title: String(item.title), jobType: String(item.positionType || ""), publishedAt: String(item.startTime || ""),
    deadline: String(item.endTime || ""), recruitingNumbers: String(item.recruitingNumbers ?? ""),
    detailUrl, fetchedAt: now,
  };
}

export function saveRows(db, sourceId, rows) {
  const source = getSource(sourceId);
  const upsert = db.prepare(`INSERT INTO jobs (source, source_id, company, title, job_type, published_at, deadline, recruiting_numbers, detail_url, dedupe_key, first_seen_at, last_seen_at)
    VALUES (@source, @sourceId, @company, @title, @jobType, @publishedAt, @deadline, @recruitingNumbers, @detailUrl, @dedupeKey, @fetchedAt, @fetchedAt)
    ON CONFLICT(source, source_id) DO UPDATE SET company=excluded.company, title=excluded.title, job_type=excluded.job_type,
    published_at=excluded.published_at, deadline=excluded.deadline, recruiting_numbers=excluded.recruiting_numbers,
    detail_url=excluded.detail_url, dedupe_key=excluded.dedupe_key, last_seen_at=excluded.last_seen_at`);
  return db.transaction(() => {
    const ids = new Set(db.prepare("SELECT source_id FROM jobs WHERE source=?").all(source.name).map((row) => row.source_id));
    let newCount = 0;
    for (const row of rows) {
      if (!ids.has(row.sourceId)) { newCount += 1; ids.add(row.sourceId); }
      upsert.run({ ...row, dedupeKey: createDedupeKey(row) });
    }
    return newCount;
  })();
}
