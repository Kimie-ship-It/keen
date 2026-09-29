import { getSource } from "./sources.mjs";

const buaa = getSource("buaa");
export const SOURCE = buaa.name;
export const BASE_URL = buaa.baseUrl;
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

export function normalizeItem(item, now) {
  if (!item || !item.id || !item.title) throw new Error("接口记录缺少招聘 ID 或标题");
  // The school sometimes emits paths beginning with two slashes.
  const value = String(item.detailsUrl || item.url || "/f/recruitmentinfo/show?recruitmentId=" + encodeURIComponent(item.id));
  const url = new URL(value.startsWith("//") ? "/" + value.replace(/^\/+/, "") : value, BASE_URL);
  if (!["https:", "http:"].includes(url.protocol) || url.hostname !== new URL(BASE_URL).hostname) throw new Error("招聘来源链接不合法");
  url.protocol = "https:";
  url.pathname = "/" + url.pathname.replace(/^\/+/, "");
  return {
    source: SOURCE, sourceId: String(item.id), company: String(item.corporationName || item.corporationinfo?.name || ""),
    title: String(item.title), jobType: String(item.positionType || ""), publishedAt: String(item.startTime || ""),
    deadline: String(item.endTime || ""), recruitingNumbers: String(item.recruitingNumbers ?? ""),
    detailUrl: url.href, fetchedAt: now,
  };
}

export function saveRows(db, rows) {
  const upsert = db.prepare(`INSERT INTO jobs (source, source_id, company, title, job_type, published_at, deadline, recruiting_numbers, detail_url, first_seen_at, last_seen_at)
    VALUES (@source, @sourceId, @company, @title, @jobType, @publishedAt, @deadline, @recruitingNumbers, @detailUrl, @fetchedAt, @fetchedAt)
    ON CONFLICT(source, source_id) DO UPDATE SET company=excluded.company, title=excluded.title, job_type=excluded.job_type,
    published_at=excluded.published_at, deadline=excluded.deadline, recruiting_numbers=excluded.recruiting_numbers,
    detail_url=excluded.detail_url, last_seen_at=excluded.last_seen_at`);
  return db.transaction(() => {
    const ids = new Set(db.prepare("SELECT source_id FROM jobs WHERE source=?").all(SOURCE).map((row) => row.source_id));
    let newCount = 0;
    for (const row of rows) {
      if (!ids.has(row.sourceId)) { newCount += 1; ids.add(row.sourceId); }
      upsert.run(row);
    }
    return newCount;
  })();
}
