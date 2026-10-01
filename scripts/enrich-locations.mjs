import "./config.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { openDatabase, closeDatabase } from "./db.mjs";
import { getSource, SOURCES } from "./sources.mjs";
import { extractLocations, extractNankaiLocations } from "./locations.mjs";
import { requestJson, requestText, sleep } from "./collection.mjs";
import { collectionAllowed } from "./source-controls.mjs";
import { closeRuntimePool } from "./runtime-db.mjs";

const USER_AGENT = "CampusJobsRadar/0.1";
const TIMEOUT_MS = Number(process.env.COLLECT_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.COLLECT_RETRIES || 3);
const PAGE_DELAY_MS = 250;

async function fetchPlatformReference(fetchImpl = fetch) {
  const source = getSource("buaa");
  const tokenPayload = await requestJson(`${source.baseUrl}${source.tokenPath}`, {}, { fetchImpl, timeout: TIMEOUT_MS, retries: RETRIES });
  const token = tokenPayload.data;
  const html = await (await fetch(`${source.baseUrl}/frontpage/buaa/html/recruitmentinfoListSchool.html`, { headers: { "User-Agent": USER_AGENT } })).text();
  const provinceMatches = [...html.matchAll(/<span[^>]+data-area="(\d{6})"[^>]*>\s*([^<]+?)\s*<\/span>/g)];
  const provinceIds = provinceMatches.map((match) => match[1]);
  const reference = provinceMatches.map((match) => match[2]);
  for (const parentid of [...new Set(provinceIds)]) {
    const payload = await requestJson(`${source.baseUrl}/f/treeData/ajax_getCity`, {
      method: "POST",
      headers: { token, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ parentid }),
    }, { fetchImpl, timeout: TIMEOUT_MS, retries: RETRIES });
    for (const item of payload.object || []) reference.push(item.name);
  }
  return [...new Set(reference)];
}

async function fetchPlatformDetail(source, token, sourceId, fetchImpl = fetch) {
  const payload = await requestJson(`${source.baseUrl}/f/recruitmentinfo/ajax_show`, {
    method: "POST",
    headers: { token, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ recruitmentId: sourceId }),
  }, { fetchImpl, timeout: TIMEOUT_MS, retries: RETRIES });
  if (payload.state !== 1 || !payload.object?.recruitmentinfo) throw new Error("招聘详情接口格式异常");
  const recruitment = payload.object.recruitmentinfo;
  const structured = (recruitment.recruitmentPositionList || []).map((item) => item.cityName || "");
  return { content: cheerio.load(recruitment.content || "").root().text(), structured };
}

async function fetchNankaiDetail(source, sourceId, fetchImpl = fetch) {
  const html = await requestText(`${source.baseUrl}/correcruit/content/id/${encodeURIComponent(sourceId)}.html`, {
    headers: { "User-Agent": USER_AGENT },
  }, { fetchImpl, timeout: TIMEOUT_MS, retries: RETRIES });
  const $ = cheerio.load(html);
  return { html: $.root().html() || "" };
}

async function enrichSource(db, sourceId, reference, options = {}) {
  const source = getSource(sourceId);
  const rows = db.prepare("SELECT id, source_id AS sourceId FROM jobs WHERE source=? AND location_checked_at='' ORDER BY id LIMIT ?").all(source.name, Number.isSafeInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : -1);
  if (!rows.length) return { source: source.name, checked: 0, locations: 0, failed: 0 };
  let token = "";
  if (source.collector !== "nankai") {
    const payload = await requestJson(`${source.baseUrl}${source.tokenPath}`, {}, { fetchImpl: options.fetchImpl, timeout: TIMEOUT_MS, retries: RETRIES });
    token = payload.data;
    if (!token || typeof token !== "string") throw new Error(`${source.name} 没有返回有效 token`);
  }
  const mark = db.prepare("UPDATE jobs SET location_checked_at=? WHERE id=?");
  const clear = db.prepare("DELETE FROM job_locations WHERE job_id=?");
  const add = db.prepare("INSERT OR IGNORE INTO job_locations (job_id, location) VALUES (?, ?)");
  let checked = 0;
  let locations = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const detail = source.collector === "nankai"
        ? await fetchNankaiDetail(source, row.sourceId, options.fetchImpl)
        : await fetchPlatformDetail(source, token, row.sourceId, options.fetchImpl);
      const found = source.collector === "nankai"
        ? extractNankaiLocations(detail.html, reference)
        : extractLocations({ content: detail.content, structured: detail.structured, reference });
      db.transaction(() => {
        clear.run(row.id);
        for (const location of found) add.run(row.id, location);
        mark.run(new Date().toISOString(), row.id);
      })();
      checked += 1;
      locations += found.length;
    } catch (error) {
      failed += 1;
      console.error(`${source.name} ${row.sourceId} 地点补充失败：${error.message}`);
    }
    if (options.wait !== false) await (options.wait || sleep)(PAGE_DELAY_MS);
    if (checked && checked % 100 === 0) console.log(JSON.stringify({ source: source.name, checked, remaining: rows.length - checked, locations, failed }));
  }
  return { source: source.name, checked, locations, failed };
}

export async function enrichLocations({ ids = Object.keys(SOURCES), dbPath, fetchImpl = fetch, wait = sleep, maxRows, allowed = collectionAllowed } = {}) {
  const active = [];
  for (const id of ids) if (await allowed(id)) active.push(id);
  if (!active.length) return [];
  const db = await openDatabase(dbPath);
  try {
    let reference = [];
    try {
      if (await allowed("buaa")) reference = await fetchPlatformReference(fetchImpl);
      await mkdir(new URL("../data/", import.meta.url), { recursive: true });
      await writeFile(new URL("../data/location-reference.json", import.meta.url), JSON.stringify({ fetchedAt: new Date().toISOString(), locations: reference }, null, 2), "utf8");
    } catch (error) {
      console.warn(`城市字典获取失败，将仅使用结构化地点：${error.message}`);
    }
    const results = [];
    for (const id of active) if (await allowed(id)) results.push(await enrichSource(db, id, reference, { fetchImpl, wait, maxRows }));
    return results;
  } finally { closeDatabase(db); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const results = await enrichLocations();
    for (const result of results) console.log(JSON.stringify(result));
  } catch (error) {
    const { reportError } = await import("./monitor.mjs");
    await reportError(error, { operation: "collection" });
    process.exitCode = 1;
  } finally { await closeRuntimePool(); }
}
