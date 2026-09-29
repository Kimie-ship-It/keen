import "./config.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, closeDatabase } from "./db.mjs";
import { BASE_URL, SOURCE, requestJson, normalizeItem, saveRows, sleep } from "./collection.mjs";
import { refreshSourceStatus } from "./source-status.mjs";

const PAGE_SIZE = 100;
const OUTPUT = new URL("../data/buaa-recruitments.json", import.meta.url);
const TIMEOUT_MS = Number(process.env.COLLECT_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.COLLECT_RETRIES || 3);

function form(pageNo) {
  return new URLSearchParams({
    pageNo: String(pageNo), pageSize: String(PAGE_SIZE), positionType: "", city: "",
    title: "", corporationNature: "", "corporationinfo.industry": "",
  });
}

export async function collectBuaa(options = {}) {
  const db = await openDatabase(options.dbPath);
  const startedAt = new Date().toISOString();
  let run;
  try {
    run = db.transaction(() => {
      db.prepare("UPDATE source_runs SET status='failed', finished_at=?, error='上次进程中断或运行超过两小时' WHERE source=? AND status='running' AND started_at<?")
        .run(startedAt, SOURCE, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
      if (db.prepare("SELECT id FROM source_runs WHERE source=? AND status='running'").get(SOURCE)) throw new Error("同一来源的采集正在运行，请勿重复启动");
      const inserted = db.prepare("INSERT INTO source_runs (source, started_at, status) VALUES (?, ?, 'running')").run(SOURCE, startedAt);
      refreshSourceStatus(db, SOURCE);
      return inserted;
    })();
  } catch (error) { closeDatabase(db); throw error; }
  try {
    const request = (path, init) => requestJson(`${BASE_URL}${path}`, {
      ...init, headers: { "User-Agent": "CampusJobsRadar/0.1", ...(init?.headers || {}) },
    }, { fetchImpl: options.fetchImpl, wait: options.wait || sleep, timeout: TIMEOUT_MS, retries: RETRIES });
    const tokenPayload = await request("/f/ajaxHome/getToken");
    const token = tokenPayload.data;
    if (!token || typeof token !== "string") throw new Error("高校接口没有返回有效 token");
    async function getPage(pageNo) {
      const payload = await request(`/f/recruitmentinfo/ajax_frontRecruitinfoXzgg?ts=${Date.now()}`, {
        method: "POST", headers: { token, "Content-Type": "application/x-www-form-urlencoded" }, body: form(pageNo),
      });
      if (payload.state !== 1 || !Array.isArray(payload.object?.list)) throw new Error(payload.msg || "列表接口格式异常");
      return payload.object;
    }
    const first = await getPage(1);
    if (!Number.isInteger(first.totalPage) || first.totalPage < 1 || first.totalPage > 100) throw new Error("分页信息异常或超过单次安全上限");
    const pages = [first];
    for (let page = 2; page <= first.totalPage; page += 1) {
      pages.push(await getPage(page));
      if (page < first.totalPage) await (options.wait || sleep)(250);
    }
    const now = new Date().toISOString();
    const rows = pages.flatMap((page) => page.list).map((item) => normalizeItem(item, now));
    if (!rows.length) throw new Error("接口返回空列表，保留现有数据并等待人工确认");
    const newCount = saveRows(db, rows);
    db.transaction(() => {
      db.prepare("UPDATE source_runs SET finished_at=?, status='success', fetched_count=?, new_count=? WHERE id=?")
        .run(now, rows.length, newCount, run.lastInsertRowid);
      refreshSourceStatus(db, SOURCE);
    })();
    if (!options.skipSnapshot) {
      try {
        await mkdir(new URL("../data/", import.meta.url), { recursive: true });
        await writeFile(OUTPUT, JSON.stringify({ source: SOURCE, fetchedAt: now, count: rows.length, rows }, null, 2), "utf8");
      } catch (error) { console.warn("数据库已更新，但 JSON 快照写入失败：", error.message); }
    }
    return { source: SOURCE, count: rows.length, newCount, fetchedAt: now };
  } catch (error) {
    db.transaction(() => {
      db.prepare("UPDATE source_runs SET finished_at=?, status='failed', error=? WHERE id=?")
        .run(new Date().toISOString(), String(error?.message || error), run.lastInsertRowid);
      refreshSourceStatus(db, SOURCE);
    })();
    throw error;
  } finally { closeDatabase(db); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await collectBuaa();
  console.log(`已采集${result.source}招聘信息 ${result.count} 条，新增 ${result.newCount} 条`);
}
