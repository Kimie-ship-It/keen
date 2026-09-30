import "./config.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { openDatabase, closeDatabase } from "./db.mjs";
import { requestText, saveRows, sleep } from "./collection.mjs";
import { refreshSourceStatus } from "./source-status.mjs";
import { getSource, officialUrl } from "./sources.mjs";

const SOURCE_ID = "nankai";
const TIMEOUT_MS = Number(process.env.COLLECT_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.COLLECT_RETRIES || 3);

export function parseNankaiPage(html, fetchedAt) {
  const source = getSource(SOURCE_ID);
  const $ = cheerio.load(html);
  const rows = [];
  $(".content ul > li").each((_, element) => {
    const link = $(element).find('.title1 a[href*="/correcruit/content/id/"]').first();
    const href = link.attr("href") || "";
    const id = href.match(/\/correcruit\/content\/id\/(\d+)\.html/)?.[1];
    const title = link.text().replace(/\s+/g, " ").trim();
    if (!id || !title) return;
    const company = $(element).find(".company a").first().text().replace(/[【】]/g, "").replace(/\s+/g, " ").trim();
    const yearMonth = $(element).find(".date .year").first().text().trim();
    const day = $(element).find(".date .day").first().text().trim().padStart(2, "0");
    const publishedAt = /^\d{4}\.\d{2}$/.test(yearMonth) && /^\d{2}$/.test(day)
      ? `${yearMonth.replace(".", "-")}-${day}`
      : "";
    const detailUrl = officialUrl(SOURCE_ID, href);
    if (!detailUrl) throw new Error("招聘来源链接不合法");
    rows.push({
      source: source.name,
      sourceId: id,
      company,
      title,
      jobType: "招聘信息",
      publishedAt,
      deadline: "",
      recruitingNumbers: "",
      detailUrl,
      fetchedAt,
    });
  });
  const pageLinks = $(".page a").map((_, element) => Number(($(element).attr("href") || "").match(/\/p\/(\d+)\.html/)?.[1])).get();
  const totalPage = Math.max(1, ...pageLinks.filter(Number.isSafeInteger));
  return { totalPage, rows };
}

export async function collectNankai(options = {}) {
  const source = getSource(SOURCE_ID);
  const db = await openDatabase(options.dbPath);
  const startedAt = new Date().toISOString();
  let run;
  try {
    run = db.transaction(() => {
      db.prepare("UPDATE source_runs SET status='failed', finished_at=?, error='上次进程中断或运行超过两小时' WHERE source=? AND status='running' AND started_at<?")
        .run(startedAt, source.name, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
      if (db.prepare("SELECT id FROM source_runs WHERE source=? AND status='running'").get(source.name)) throw new Error("同一来源的采集正在运行，请勿重复启动");
      const inserted = db.prepare("INSERT INTO source_runs (source, started_at, status) VALUES (?, ?, 'running')").run(source.name, startedAt);
      refreshSourceStatus(db, source.name);
      return inserted;
    })();
  } catch (error) { closeDatabase(db); throw error; }

  try {
    const request = (path) => requestText(`${source.baseUrl}${path}`, {
      headers: { "User-Agent": "CampusJobsRadar/0.1" },
    }, { fetchImpl: options.fetchImpl, wait: options.wait || sleep, timeout: TIMEOUT_MS, retries: RETRIES });
    const first = parseNankaiPage(await request(source.listPath), startedAt);
    if (!Number.isSafeInteger(first.totalPage) || first.totalPage < 1 || first.totalPage > source.maxPages) throw new Error("分页信息异常或超过单次安全上限");
    const rows = [...first.rows];
    for (let page = 2; page <= first.totalPage; page += 1) {
      await (options.wait || sleep)(source.pageDelayMs);
      rows.push(...parseNankaiPage(await request(`/correcruit/index/p/${page}.html`), startedAt).rows);
    }
    if (!rows.length) throw new Error("页面没有可识别的招聘列表，保留现有数据并等待人工确认");
    const fetchedAt = new Date().toISOString();
    for (const row of rows) row.fetchedAt = fetchedAt;
    const newCount = saveRows(db, SOURCE_ID, rows);
    db.transaction(() => {
      db.prepare("UPDATE source_runs SET finished_at=?, status='success', fetched_count=?, new_count=? WHERE id=?")
        .run(fetchedAt, rows.length, newCount, run.lastInsertRowid);
      refreshSourceStatus(db, source.name);
    })();
    if (!options.skipSnapshot) {
      try {
        await mkdir(new URL("../data/", import.meta.url), { recursive: true });
        await writeFile(new URL("../data/nankai-recruitments.json", import.meta.url), JSON.stringify({ source: source.name, fetchedAt, count: rows.length, rows }, null, 2), "utf8");
      } catch (error) { console.warn("数据库已更新，但 JSON 快照写入失败：", error.message); }
    }
    return { source: source.name, count: rows.length, newCount, fetchedAt };
  } catch (error) {
    db.transaction(() => {
      db.prepare("UPDATE source_runs SET finished_at=?, status='failed', error=? WHERE id=?")
        .run(new Date().toISOString(), String(error?.message || error), run.lastInsertRowid);
      refreshSourceStatus(db, source.name);
    })();
    throw error;
  } finally { closeDatabase(db); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await collectNankai();
  console.log(`已采集${result.source}招聘信息 ${result.count} 条，新增 ${result.newCount} 条`);
}
