import { mkdir, writeFile } from "node:fs/promises";
import { openDatabase, closeDatabase } from "./db.mjs";
import { requestJson, normalizeItem, saveRows, sleep } from "./collection.mjs";
import { refreshSourceStatus } from "./source-status.mjs";
import { getSource } from "./sources.mjs";

const TIMEOUT_MS = Number(process.env.COLLECT_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.COLLECT_RETRIES || 3);

function form(pageNo, pageSize) {
  return new URLSearchParams({
    pageNo: String(pageNo), pageSize: String(pageSize), positionType: "", city: "",
    title: "", corporationNature: "", "corporationinfo.industry": "",
  });
}

export async function collectPlatformSource(sourceId, options = {}) {
  const source = getSource(sourceId);
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
    const request = (path, init) => requestJson(`${source.baseUrl}${path}`, {
      ...init, headers: { "User-Agent": "CampusJobsRadar/0.1", ...(init?.headers || {}) },
    }, { fetchImpl: options.fetchImpl, wait: options.wait || sleep, timeout: TIMEOUT_MS, retries: RETRIES });
    const tokenPayload = await request(source.tokenPath);
    const token = tokenPayload.data;
    if (!token || typeof token !== "string") throw new Error("高校接口没有返回有效 token");
    async function getPage(pageNo) {
      const payload = await request(`${source.listPath}?ts=${Date.now()}`, {
        method: "POST", headers: { token, "Content-Type": "application/x-www-form-urlencoded" }, body: form(pageNo, source.pageSize),
      });
      if (payload.state !== 1 || !Array.isArray(payload.object?.list)) throw new Error(payload.msg || "列表接口格式异常");
      return payload.object;
    }
    const first = await getPage(1);
    if (!Number.isInteger(first.totalPage) || first.totalPage < 1 || first.totalPage > source.maxPages) throw new Error("分页信息异常或超过单次安全上限");
    const pages = [first];
    for (let page = 2; page <= first.totalPage; page += 1) {
      await (options.wait || sleep)(source.pageDelayMs);
      pages.push(await getPage(page));
    }
    const now = new Date().toISOString();
    const rows = pages.flatMap((page) => page.list).map((item) => normalizeItem(sourceId, item, now));
    if (!rows.length) throw new Error("接口返回空列表，保留现有数据并等待人工确认");
    const newCount = saveRows(db, sourceId, rows);
    db.transaction(() => {
      db.prepare("UPDATE source_runs SET finished_at=?, status='success', fetched_count=?, new_count=? WHERE id=?")
        .run(now, rows.length, newCount, run.lastInsertRowid);
      refreshSourceStatus(db, source.name);
    })();
    if (!options.skipSnapshot) {
      try {
        await mkdir(new URL("../data/", import.meta.url), { recursive: true });
        await writeFile(new URL(`../data/${source.id}-recruitments.json`, import.meta.url), JSON.stringify({ source: source.name, fetchedAt: now, count: rows.length, rows }, null, 2), "utf8");
      } catch (error) { console.warn("数据库已更新，但 JSON 快照写入失败：", error.message); }
    }
    return { source: source.name, count: rows.length, newCount, fetchedAt: now };
  } catch (error) {
    db.transaction(() => {
      db.prepare("UPDATE source_runs SET finished_at=?, status='failed', error=? WHERE id=?")
        .run(new Date().toISOString(), String(error?.message || error), run.lastInsertRowid);
      refreshSourceStatus(db, source.name);
    })();
    throw error;
  } finally { closeDatabase(db); }
}
