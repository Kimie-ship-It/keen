import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "../scripts/db.mjs";
import { collectBuaa } from "../scripts/collect-buaa.mjs";
import { collectBit } from "../scripts/collect-bit.mjs";
import { collectBjtu } from "../scripts/collect-bjtu.mjs";
import { collectNankai, parseNankaiPage } from "../scripts/collect-nankai.mjs";
import { normalizeItem, requestJson } from "../scripts/collection.mjs";
import { getJobDetail, getSavedJobs, listJobs } from "../scripts/jobs-service.mjs";
import { checkAdminAuthorization, isAuthorized, listPendingReviews, readBearerToken, updateReview, validateReviewInput } from "../scripts/reviews.mjs";
import { notify } from "../scripts/notify.mjs";
import { parsePagination } from "../scripts/query.mjs";
import { getSource, officialUrl, officialUrlForSourceName, SOURCES } from "../scripts/sources.mjs";
import { collectConfiguredSources, collectSource } from "../scripts/collector-registry.mjs";
import { refreshSourceStatus } from "../scripts/source-status.mjs";
import { createDedupeKey } from "../scripts/dedupe.mjs";
import { extractLocations, normalizeLocation } from "../scripts/locations.mjs";
import { classifyIndustries } from "../scripts/industries.mjs";

async function buaaFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/buaa/${name}.json`, import.meta.url), "utf8"));
}

async function bitFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/bit/${name}.json`, import.meta.url), "utf8"));
}

async function bjtuFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/bjtu/${name}.json`, import.meta.url), "utf8"));
}

async function nankaiFixture(name) {
  return readFile(new URL(`./fixtures/nankai/${name}.html`, import.meta.url), "utf8");
}

function jsonResponse(payload) {
  return { ok: true, json: async () => structuredClone(payload) };
}

function textResponse(payload) {
  return { ok: true, text: async () => payload };
}

test("高校来源配置集中管理", () => {
  assert.equal(getSource("buaa").name, "北京航空航天大学");
  assert.equal(getSource("buaa").baseUrl, "https://career.buaa.edu.cn");
  assert.deepEqual(getSource("buaa").officialHosts, ["career.buaa.edu.cn"]);
  assert.equal(getSource("bit").name, "北京理工大学");
  assert.equal(getSource("bit").baseUrl, "https://job.bit.edu.cn");
  assert.deepEqual(getSource("bit").officialHosts, ["job.bit.edu.cn"]);
  assert.equal(getSource("bit").pageDelayMs, 250);
  assert.equal(getSource("bjtu").name, "北京交通大学");
  assert.equal(getSource("bjtu").baseUrl, "https://job.bjtu.edu.cn");
  assert.equal(getSource("bjtu").listPath, "/f/recruitmentinfo/ajax_frontRecruitinfo");
  assert.deepEqual(getSource("bjtu").officialHosts, ["job.bjtu.edu.cn"]);
  assert.equal(getSource("nankai").name, "南开大学");
  assert.equal(getSource("nankai").baseUrl, "https://career.nankai.edu.cn");
  assert.equal(getSource("nankai").listPath, "/correcruit/index.html");
  assert.deepEqual(getSource("nankai").officialHosts, ["career.nankai.edu.cn"]);
  assert.equal(Object.keys(SOURCES).length, 4);
  assert.throws(() => getSource("unknown"), /未知高校来源/);
  assert.throws(() => getSource("constructor"), /未知高校来源/);
});

test("来源官方域名白名单拒绝伪装链接", () => {
  const relative = "/f/recruitmentinfo/show?recruitmentId=1";
  assert.equal(officialUrl("buaa", relative), `https://career.buaa.edu.cn${relative}`);
  assert.equal(officialUrl("buaa", "http://career.buaa.edu.cn/f/test"), "https://career.buaa.edu.cn/f/test");
  assert.equal(officialUrlForSourceName("北京航空航天大学", relative), `https://career.buaa.edu.cn${relative}`);
  assert.equal(officialUrl("bit", relative), `https://job.bit.edu.cn${relative}`);
  assert.equal(officialUrl("bjtu", relative), `https://job.bjtu.edu.cn${relative}`);
  assert.equal(officialUrl("nankai", "/correcruit/content/id/1.html"), "https://career.nankai.edu.cn/correcruit/content/id/1.html");
  assert.equal(officialUrl("buaa", "https://career.buaa.edu.cn.evil.example/f/test"), "");
  assert.equal(officialUrl("buaa", "https://user@career.buaa.edu.cn/f/test"), "");
  assert.equal(officialUrl("buaa", "https://career.buaa.edu.cn:444/f/test"), "");
  assert.equal(officialUrl("buaa", "javascript:alert(1)"), "");
  assert.equal(officialUrlForSourceName("未知大学", "https://career.buaa.edu.cn/f/test"), "");
});

test("采集器接口按来源调度并校验结果", async () => {
  const options = { skipSnapshot: true };
  const result = { source: "北京航空航天大学", count: 3, newCount: 1, fetchedAt: "2026-09-29T00:00:00Z" };
  assert.deepEqual(await collectSource("buaa", options, { buaa: async (received) => {
    assert.equal(received, options);
    return result;
  } }), result);
  await assert.rejects(collectSource("unknown", {}, {}), /未知高校来源/);
  await assert.rejects(collectSource("buaa", {}, {}), /缺少采集器/);
  await assert.rejects(collectSource("buaa", {}, { buaa: async () => ({ ...result, count: 0 }) }), /格式异常/);
  await assert.rejects(collectSource("buaa", {}, { buaa: async () => { throw new Error("采集失败"); } }), /采集失败/);
  const order = [];
  const summary = await collectConfiguredSources({ ids: ["buaa", "bit", "bjtu", "nankai"] }, {
    buaa: async () => { order.push("buaa"); return result; },
    bit: async () => { order.push("bit"); throw new Error("第二来源失败"); },
    bjtu: async () => { order.push("bjtu"); return { ...result, source: "北京交通大学" }; },
    nankai: async () => { order.push("nankai"); return { ...result, source: "南开大学" }; },
  });
  assert.deepEqual(order, ["buaa", "bit", "bjtu", "nankai"]);
  assert.equal(summary.results.length, 3);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].source, "北京理工大学");
});

test("采集去重、审核状态保留、失败不丢数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-"));
  const path = join(dir, "test.db");
  const token = await buaaFixture("token");
  const pages = { "1": await buaaFixture("page-1"), "2": await buaaFixture("page-2") };
  const delays = [];
  const fakeFetch = async (url, options) => {
    if (url.includes("getToken")) return jsonResponse(token);
    assert.equal(options.body.get("pageSize"), "100");
    return jsonResponse(pages[options.body.get("pageNo")]);
  };
  try {
    const options = { dbPath: path, fetchImpl: fakeFetch, skipSnapshot: true, wait: async (ms) => { delays.push(ms); } };
    const firstRun = await collectBuaa(options);
    assert.equal(firstRun.count, 2);
    assert.equal(firstRun.newCount, 2);
    assert.deepEqual(delays, [250]);
    const db = await openDatabase(path);
    const firstSuccess = db.prepare("SELECT last_status AS status, last_success_at AS successAt, fetched_count AS fetchedCount FROM source_status WHERE source=?").get("北京航空航天大学");
    assert.equal(firstSuccess.status, "success");
    assert.equal(firstSuccess.fetchedCount, 2);
    db.prepare("UPDATE jobs SET review_status='approved' WHERE source_id='fixture-a'").run();
    closeDatabase(db);
    delays.length = 0;
    assert.equal((await collectBuaa(options)).newCount, 0);
    assert.deepEqual(delays, [250]);
    await assert.rejects(collectBuaa({ ...options, fetchImpl: async () => { throw new Error("network down"); } }), /network down/);
    const result = await openDatabase(path);
    assert.equal(result.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2);
    assert.equal(result.prepare("SELECT review_status FROM jobs WHERE source_id='fixture-a'").get().review_status, "approved");
    assert.equal(result.prepare("SELECT status FROM source_runs ORDER BY id DESC LIMIT 1").get().status, "failed");
    assert.equal(result.prepare("SELECT detail_url FROM jobs WHERE source_id='fixture-a'").get().detail_url, "https://career.buaa.edu.cn/f/recruitmentinfo/show?recruitmentId=fixture-a");
    assert.equal(result.prepare("SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key<>''").get().n, 2);
    const failedState = result.prepare("SELECT last_status AS status, last_success_at AS successAt, last_failure_at AS failureAt, last_error AS error FROM source_status WHERE source=?").get("北京航空航天大学");
    assert.equal(failedState.status, "failed");
    assert.ok(failedState.successAt >= firstSuccess.successAt);
    assert.ok(failedState.failureAt);
    assert.match(failedState.error, /network down/);
    closeDatabase(result);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("北京理工大学夹具覆盖字段映射、多校去重和失败保护", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-bit-"));
  const path = join(dir, "test.db");
  const buaaToken = await buaaFixture("token");
  const buaaPages = { "1": await buaaFixture("page-1"), "2": await buaaFixture("page-2") };
  const bitToken = await bitFixture("token");
  const bitPage = await bitFixture("page-1");
  try {
    await collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => url.includes("getToken")
        ? jsonResponse(buaaToken)
        : jsonResponse(buaaPages[options.body.get("pageNo")]),
    });
    const result = await collectBit({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => {
        if (url.includes("getToken")) return jsonResponse(bitToken);
        assert.equal(options.body.get("pageSize"), "100");
        return jsonResponse(bitPage);
      },
    });
    assert.equal(result.source, "北京理工大学");
    assert.equal(result.count, 2);
    assert.equal(result.newCount, 2);
    const db = await openDatabase(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source='北京理工大学'").get().n, 2);
    assert.equal(db.prepare("SELECT detail_url FROM jobs WHERE source_id='bit-fixture-b'").get().detail_url, "https://job.bit.edu.cn/f/recruitmentinfo/show?recruitmentId=bit-fixture-b");
    const publicData = listJobs(db);
    assert.equal(publicData.matchCount, 3);
    const merged = publicData.jobs.find((job) => job.company === "示例科技有限公司");
    assert.equal(merged.sourceCount, 2);
    assert.equal(merged.duplicateCount, 2);
    assert.deepEqual(merged.sourceLinks.map((link) => link.source).sort(), ["北京理工大学", "北京航空航天大学"]);
    closeDatabase(db);
    await assert.rejects(collectBit({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async () => { throw new Error("bit network down"); },
    }), /bit network down/);
    const afterFailure = await openDatabase(path);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 4);
    assert.equal(afterFailure.prepare("SELECT last_status FROM source_status WHERE source='北京理工大学'").get().last_status, "failed");
    closeDatabase(afterFailure);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("北京交通大学夹具覆盖独立接口、字段映射、去重和失败保护", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-bjtu-"));
  const path = join(dir, "test.db");
  const buaaToken = await buaaFixture("token");
  const buaaPages = { "1": await buaaFixture("page-1"), "2": await buaaFixture("page-2") };
  const bjtuToken = await bjtuFixture("token");
  const bjtuPage = await bjtuFixture("page-1");
  try {
    await collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => url.includes("getToken")
        ? jsonResponse(buaaToken)
        : jsonResponse(buaaPages[options.body.get("pageNo")]),
    });
    const result = await collectBjtu({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => {
        if (url.includes("getToken")) return jsonResponse(bjtuToken);
        assert.equal(url.includes("ajax_frontRecruitinfo?"), true);
        assert.equal(options.body.get("pageSize"), "100");
        return jsonResponse(bjtuPage);
      },
    });
    assert.equal(result.source, "北京交通大学");
    assert.equal(result.count, 2);
    assert.equal(result.newCount, 2);
    const db = await openDatabase(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source='北京交通大学'").get().n, 2);
    assert.equal(db.prepare("SELECT detail_url FROM jobs WHERE source_id='bjtu-fixture-b'").get().detail_url, "https://job.bjtu.edu.cn/f/recruitmentinfo/show?recruitmentId=bjtu-fixture-b");
    const publicData = listJobs(db);
    assert.equal(publicData.matchCount, 3);
    const merged = publicData.jobs.find((job) => job.company === "示例科技有限公司");
    assert.equal(merged.sourceCount, 2);
    assert.deepEqual(merged.sourceLinks.map((link) => link.source).sort(), ["北京交通大学", "北京航空航天大学"]);
    closeDatabase(db);
    await assert.rejects(collectBjtu({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async () => { throw new Error("bjtu network down"); },
    }), /bjtu network down/);
    const afterFailure = await openDatabase(path);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 4);
    assert.equal(afterFailure.prepare("SELECT last_status FROM source_status WHERE source='北京交通大学'").get().last_status, "failed");
    closeDatabase(afterFailure);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("南开大学 HTML 夹具覆盖分页解析、字段映射、去重和失败保护", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-nankai-"));
  const path = join(dir, "test.db");
  const buaaToken = await buaaFixture("token");
  const buaaPages = { "1": await buaaFixture("page-1"), "2": await buaaFixture("page-2") };
  const page1 = await nankaiFixture("page-1");
  const page2 = await nankaiFixture("page-2");
  const parsed = parseNankaiPage(page1, "2026-09-30T00:00:00Z");
  assert.equal(parsed.totalPage, 2);
  assert.equal(parsed.rows[0].company, "示例科技有限公司");
  assert.equal(parsed.rows[0].publishedAt, "2026-09-29");
  assert.equal(parsed.rows[0].detailUrl, "https://career.nankai.edu.cn/correcruit/content/id/2001.html");
  const delays = [];
  try {
    await collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => url.includes("getToken")
        ? jsonResponse(buaaToken)
        : jsonResponse(buaaPages[options.body.get("pageNo")]),
    });
    const result = await collectNankai({
      dbPath: path, skipSnapshot: true, wait: async (ms) => { delays.push(ms); },
      fetchImpl: async (url) => textResponse(url.endsWith("/correcruit/index.html") ? page1 : page2),
    });
    assert.equal(result.source, "南开大学");
    assert.equal(result.count, 2);
    assert.equal(result.newCount, 2);
    assert.deepEqual(delays, [250]);
    const db = await openDatabase(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source='南开大学'").get().n, 2);
    assert.equal(db.prepare("SELECT detail_url FROM jobs WHERE source_id='2002'").get().detail_url, "https://career.nankai.edu.cn/correcruit/content/id/2002.html");
    const publicData = listJobs(db);
    assert.equal(publicData.matchCount, 3);
    const merged = publicData.jobs.find((job) => job.company === "示例科技有限公司");
    assert.equal(merged.sourceCount, 2);
    assert.deepEqual(merged.sourceLinks.map((link) => link.source).sort(), ["北京航空航天大学", "南开大学"]);
    closeDatabase(db);
    await assert.rejects(collectNankai({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async () => { throw new Error("nankai network down"); },
    }), /nankai network down/);
    const afterFailure = await openDatabase(path);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 4);
    assert.equal(afterFailure.prepare("SELECT last_status FROM source_status WHERE source='南开大学'").get().last_status, "failed");
    closeDatabase(afterFailure);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("旧数据库的高校运行记录补入来源状态表", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-migration-"));
  const path = join(dir, "legacy.db");
  try {
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL, fetched_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0, error TEXT)`);
    const insert = legacy.prepare("INSERT INTO source_runs (source, started_at, finished_at, status, fetched_count, new_count, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("北京航空航天大学", "2026-09-29T00:00:00Z", "2026-09-29T00:01:00Z", "success", 12, 2, null);
    insert.run("北京航空航天大学", "2026-09-30T00:00:00Z", "2026-09-30T00:01:00Z", "failed", 0, 0, "旧错误详情");
    legacy.close();
    const db = await openDatabase(path);
    const status = db.prepare("SELECT * FROM source_status WHERE source=?").get("北京航空航天大学");
    assert.equal(status.last_status, "failed");
    assert.equal(status.last_success_at, "2026-09-29T00:01:00Z");
    assert.equal(status.last_failure_at, "2026-09-30T00:01:00Z");
    assert.equal(status.last_error, "旧错误详情");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_status").get().count, 4);
    closeDatabase(db);
    const reopened = await openDatabase(path);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM source_status").get().count, 4);
    closeDatabase(reopened);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("超时重试、非重试 HTTP 错误和恶意链接夹具", async () => {
  let calls = 0;
  const result = await requestJson("https://career.buaa.edu.cn/test", {}, {
    fetchImpl: async () => { calls++; if (calls < 3) throw new Error("temporary"); return { ok: true, json: async () => ({ ok: true }) }; },
    wait: async () => {},
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(requestJson("https://career.buaa.edu.cn/test", {}, { fetchImpl: async () => { calls++; return { ok: false, status: 403 }; }, wait: async () => {} }), /403/);
  assert.equal(calls, 1);
  const malicious = await buaaFixture("malicious-link");
  const normalized = normalizeItem("buaa", malicious.object.list[0], new Date().toISOString());
  assert.equal(normalized.detailUrl, `https://career.buaa.edu.cn/f/recruitmentinfo/show?recruitmentId=${malicious.object.list[0].id}`);
  assert.equal(normalized.detailUrl.includes("evil.example"), false);
});

test("空列表和分页中途失败不写入半成品", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-partial-"));
  const path = join(dir, "test.db");
  const tokenResponse = jsonResponse(await buaaFixture("token"));
  const firstPage = await buaaFixture("page-1");
  const emptyPage = await buaaFixture("empty-page");
  try {
    await assert.rejects(collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => {
        if (url.includes("getToken")) return tokenResponse;
        const page = options.body.get("pageNo");
        if (page === "1") return jsonResponse(firstPage);
        throw new Error("second page failed");
      },
    }), /second page failed/);
    await assert.rejects(collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url) => url.includes("getToken") ? tokenResponse : jsonResponse(emptyPage),
    }), /空列表/);
    const db = await openDatabase(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_runs WHERE status='failed'").get().count, 2);
    assert.equal(db.prepare("SELECT last_status FROM source_status WHERE source='北京航空航天大学'").get().last_status, "failed");
    assert.equal(db.prepare("SELECT last_success_at FROM source_status WHERE source='北京航空航天大学'").get().last_success_at, null);
    closeDatabase(db);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("分页参数边界与非法输入", () => {
  assert.deepEqual(parsePagination(new URLSearchParams()), { limit: 100, offset: 0 });
  assert.deepEqual(parsePagination(new URLSearchParams("limit=999&offset=999999")), { limit: 500, offset: 100000 });
  assert.throws(() => parsePagination(new URLSearchParams("limit=-1")), /非负整数/);
  assert.throws(() => parsePagination(new URLSearchParams("offset=1.5")), /非负整数/);
});

test("公开接口只返回来源白名单内的官方链接", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-links-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const insert = db.prepare(`INSERT INTO jobs (source, source_id, company, title, detail_url, first_seen_at, last_seen_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    insert.run("北京航空航天大学", "good", "甲公司", "官方链接", "https://career.buaa.edu.cn/f/good", now, now, "2026-09-29");
    insert.run("北京航空航天大学", "bad", "乙公司", "伪装链接", "https://career.buaa.edu.cn.evil.example/f/bad", now, now, "2026-09-28");
    insert.run("未知大学", "unknown", "丙公司", "未知来源", "https://career.buaa.edu.cn/f/unknown", now, now, "2026-09-27");
    const jobs = listJobs(db).jobs;
    assert.equal(jobs.find((job) => job.sourceId === "good").detailUrl, "https://career.buaa.edu.cn/f/good");
    assert.equal(jobs.find((job) => job.sourceId === "bad").detailUrl, "");
    assert.equal(jobs.find((job) => job.sourceId === "unknown").detailUrl, "");
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("多高校重复招聘合并展示但保留原始记录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-dedupe-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const insert = db.prepare(`INSERT INTO jobs (source, source_id, company, title, detail_url, dedupe_key, first_seen_at, last_seen_at, published_at, review_status)
      VALUES (@source, @sourceId, @company, @title, @detailUrl, @dedupeKey, @now, @now, @publishedAt, @reviewStatus)`);
    const now = new Date().toISOString();
    const shared = { company: "示例科技（中国）有限公司", title: "2027 届校园招聘", detailUrl: "", now, reviewStatus: "pending" };
    insert.run({ ...shared, source: "北京航空航天大学", sourceId: "a", detailUrl: "https://career.buaa.edu.cn/f/a", publishedAt: "2026-09-29", dedupeKey: createDedupeKey({ ...shared, source: "北京航空航天大学", sourceId: "a" }) });
    insert.run({ ...shared, source: "北京理工大学", sourceId: "b", detailUrl: "https://job.bit.edu.cn/f/b", title: "2027届校园招聘！", publishedAt: "2026-09-30", reviewStatus: "approved", dedupeKey: createDedupeKey({ ...shared, title: "2027届校园招聘！", source: "北京理工大学", sourceId: "b" }) });
    const distinct = { ...shared, source: "北京理工大学", sourceId: "c", detailUrl: "https://job.bit.edu.cn/f/c", title: "2027届实习生招聘", publishedAt: "2026-09-28" };
    insert.run({ ...distinct, dedupeKey: createDedupeKey(distinct) });
    const response = listJobs(db, { limit: 1 });
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM jobs").get().total, 3);
    assert.equal(response.matchCount, 2);
    assert.equal(response.stats.total, 3);
    assert.equal(response.stats.uniqueTotal, 2);
    assert.equal(response.jobs.length, 1);
    assert.equal(response.jobs[0].source, "北京理工大学");
    assert.equal(response.jobs[0].reviewStatus, "approved");
    assert.equal(response.jobs[0].sourceCount, 2);
    assert.equal(response.jobs[0].duplicateCount, 2);
    assert.deepEqual(response.jobs[0].sourceLinks.map((link) => link.source), ["北京理工大学", "北京航空航天大学"]);
    assert.equal(listJobs(db, { limit: 1, offset: 1 }).jobs[0].sourceId, "c");
    const filtered = listJobs(db, { source: "北京航空航天大学" });
    assert.equal(filtered.jobs.length, 1);
    assert.equal(filtered.jobs[0].source, "北京航空航天大学");
    assert.equal(filtered.jobs[0].sourceCount, 1);
    assert.equal(filtered.jobs[0].duplicateCount, 1);
    assert.deepEqual(filtered.jobs[0].sourceLinks.map((link) => link.source), ["北京航空航天大学"]);
    assert.equal(filtered.matchCount, 1);
    assert.equal(filtered.stats.total, 1);
    assert.equal(filtered.stats.uniqueTotal, 1);
    assert.equal(filtered.stats.sources, 1);
    assert.equal(listJobs(db, { source: "北京理工大学", q: "实习生" }).jobs[0].sourceId, "c");
    assert.throws(() => listJobs(db, { source: "不存在大学" }), /未知高校来源/);
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("查询隐藏过滤、搜索、分页和空列表", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-query-"));
  const path = join(dir, "test.db");
  const db = await openDatabase(path);
  try {
    const insert = db.prepare(`INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at, published_at, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    insert.run("甲大学", "1", "甲公司", "研发招聘", now, now, "2026-09-29", "pending");
    insert.run("乙大学", "2", "乙公司", "产品招聘", now, now, "2026-09-28", "approved");
    insert.run("乙大学", "3", "隐藏公司", "隐藏招聘", now, now, "2026-09-27", "hidden");
    db.prepare("INSERT INTO source_runs (source, started_at, finished_at, status, fetched_count, new_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("甲大学", "2026-09-29T00:00:00Z", "2026-09-29T00:00:00Z", "success", 2, 2);
    db.prepare("INSERT INTO source_runs (source, started_at, finished_at, status, fetched_count, new_count, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("甲大学", now, now, "failed", 0, 0, "内部路径不应公开");
    refreshSourceStatus(db, "甲大学");
    assert.equal(listJobs(db, { limit: 1 }).jobs.length, 1);
    assert.equal(listJobs(db, { limit: 1 }).matchCount, 2);
    assert.equal(Object.hasOwn(listJobs(db).runs[0], "error"), false);
    const nextDay = listJobs(db, { now: Date.parse("2026-09-30T00:00:00Z") });
    assert.equal(nextDay.freshness.isStale, true);
    assert.equal(nextDay.freshness.failedSources, 1);
    assert.equal(nextDay.sources.find((source) => source.source === "甲大学").lastStatus, "failed");
    assert.equal(nextDay.sources.find((source) => source.source === "乙大学").isStale, true);
    assert.ok(!JSON.stringify(nextDay).includes("内部路径不应公开"));
    assert.equal(listJobs(db, { now: Date.parse("2026-10-02T00:00:01Z") }).freshness.staleSources, 2);
    assert.equal(listJobs(db).freshness.lastSuccessfulAt, "2026-09-29T00:00:00Z");
    assert.equal(listJobs(db, { q: "乙公司" }).jobs[0].sourceId, "2");
    assert.deepEqual(listJobs(db, { q: "不存在" }).jobs, []);
    assert.equal(listJobs(db, { offset: 1 }).jobs[0].sourceId, "2");
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("工作地点提取和城市筛选", async () => {
  assert.equal(normalizeLocation("北京市"), "北京");
  assert.deepEqual(extractLocations({
    content: "三、招聘岗位 工作地点：北京/广东/江苏/山东/重庆等 工作内容：参与项目管理",
    reference: ["北京市", "广东省", "江苏省", "山东省", "重庆市"],
  }), ["北京", "广东", "江苏", "山东", "重庆"]);
  assert.deepEqual(extractLocations({
    structured: ["北京市,天津市,河北省"],
    reference: ["北京市", "天津市", "河北省"],
  }), ["北京", "天津", "河北"]);

  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-location-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at, published_at, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const a = insert.run("北京航空航天大学", "city-a", "甲公司", "北京岗位", now, now, "2026-09-30", "pending").lastInsertRowid;
    const b = insert.run("北京理工大学", "city-b", "乙公司", "上海岗位", now, now, "2026-09-29", "pending").lastInsertRowid;
    db.prepare("INSERT INTO job_locations (job_id, location) VALUES (?, ?), (?, ?)").run(a, "北京", b, "上海");
    const beijing = listJobs(db, { city: "北京" });
    assert.equal(beijing.matchCount, 1);
    assert.equal(beijing.stats.total, 1);
    assert.equal(beijing.stats.uniqueTotal, 1);
    assert.equal(beijing.jobs[0].source, "北京航空航天大学");
    assert.deepEqual(beijing.jobs[0].locations, ["北京"]);
    assert.equal(listJobs(db, { city: "北京", source: "北京航空航天大学", q: "北京岗位" }).jobs.length, 1);
    assert.throws(() => listJobs(db, { city: "不存在城市" }), /未知工作城市/);
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("行业分类和行业筛选", async () => {
  assert.deepEqual(classifyIndustries({ company: "招商银行股份有限公司", title: "金融科技管培生" }), ["金融"]);
  assert.deepEqual(classifyIndustries({ company: "未知公司", title: "综合岗位" }), ["未分类"]);
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-industry-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at, published_at, review_status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const finance = insert.run("北京航空航天大学", "industry-a", "招商银行", "金融科技岗位", now, now, "2026-09-30", "pending", "industry-a").lastInsertRowid;
    const tech = insert.run("北京理工大学", "industry-b", "某信息技术公司", "软件工程师", now, now, "2026-09-29", "pending", "industry-b").lastInsertRowid;
    db.prepare("INSERT INTO job_industries (job_id, industry) VALUES (?, ?), (?, ?)").run(finance, "金融", tech, "信息技术/互联网");
    const result = listJobs(db, { industry: "金融" });
    assert.equal(result.matchCount, 1);
    assert.equal(result.jobs[0].company, "招商银行");
    assert.equal(listJobs(db, { industry: "金融", source: "北京航空航天大学" }).jobs.length, 1);
    assert.throws(() => listJobs(db, { industry: "不存在行业" }), /未知行业/);
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("截止日期筛选和组合查询", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-deadline-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at, published_at, deadline, review_status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const open = insert.run("北京航空航天大学", "deadline-a", "甲科技", "开放岗位", now, now, "2026-09-30", "2026-10-20", "pending", "deadline-a").lastInsertRowid;
    const due = insert.run("北京航空航天大学", "deadline-b", "乙科技", "近期岗位", now, now, "2026-09-30", "2026-10-05", "pending", "deadline-b").lastInsertRowid;
    const expired = insert.run("北京理工大学", "deadline-c", "丙科技", "过期岗位", now, now, "2026-09-30", "2026-09-01", "pending", "deadline-c").lastInsertRowid;
    const unknown = insert.run("北京理工大学", "deadline-d", "丁科技", "无日期岗位", now, now, "2026-09-30", "", "pending", "deadline-d").lastInsertRowid;
    db.prepare("INSERT INTO job_industries (job_id, industry) VALUES (?, ?), (?, ?), (?, ?), (?, ?)").run(open, "信息技术/互联网", due, "信息技术/互联网", expired, "信息技术/互联网", unknown, "信息技术/互联网");
    assert.equal(listJobs(db, { deadline: "open", now: Date.parse("2026-09-30T00:00:00Z") }).matchCount, 2);
    assert.equal(listJobs(db, { deadline: "due7", now: Date.parse("2026-09-30T00:00:00Z") }).jobs[0].sourceId, "deadline-b");
    assert.equal(listJobs(db, { deadline: "expired", now: Date.parse("2026-09-30T00:00:00Z") }).jobs[0].sourceId, "deadline-c");
    assert.equal(listJobs(db, { deadline: "unknown", industry: "信息技术/互联网", source: "北京理工大学", now: Date.parse("2026-09-30T00:00:00Z") }).matchCount, 1);
    assert.throws(() => listJobs(db, { deadline: "bad" }), /未知截止日期筛选/);
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("招聘详情保留合并来源、地点、行业和官方链接", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-detail-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at, published_at, deadline, detail_url, review_status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const first = insert.run("北京航空航天大学", "detail-a", "甲科技", "联合招聘", now, now, "2026-09-30", "2026-10-15", "https://career.buaa.edu.cn/f/a", "pending", "same-detail").lastInsertRowid;
    const second = insert.run("北京理工大学", "detail-b", "甲科技", "联合招聘", now, now, "2026-09-29", "2026-10-15", "https://job.bit.edu.cn/f/b", "approved", "same-detail").lastInsertRowid;
    db.prepare("INSERT INTO job_locations (job_id, location) VALUES (?, ?), (?, ?)").run(first, "北京", second, "上海");
    db.prepare("INSERT INTO job_industries (job_id, industry) VALUES (?, ?), (?, ?)").run(first, "信息技术/互联网", second, "信息技术/互联网");
    const detail = getJobDetail(db, { source: "北京航空航天大学", sourceId: "detail-a" });
    assert.equal(detail.title, "联合招聘");
    assert.equal(detail.reviewStatus, "approved");
    assert.equal(detail.sourceCount, 2);
    assert.deepEqual(detail.locations, ["北京", "上海"]);
    assert.deepEqual(detail.industries, ["信息技术/互联网"]);
    assert.deepEqual(detail.sourceLinks.map((link) => link.source).sort(), ["北京理工大学", "北京航空航天大学"]);
    assert.equal(getJobDetail(db, { source: "未知大学", sourceId: "detail-a" }), null);
    assert.equal(getSavedJobs(db, ["北京航空航天大学:detail-a", "无效键", "未知大学:x"]).length, 1);
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("收藏导出按收藏键读取全部记录并忽略失效收藏", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-export-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at, detail_url, review_status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("北京航空航天大学", "export-a", "甲公司", "可导出岗位", now, now, "https://career.buaa.edu.cn/f/a", "pending", "export-a");
    const jobs = getSavedJobs(db, ["北京航空航天大学:export-a", "北京航空航天大学:missing", "bad-key"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].savedKey, "北京航空航天大学:export-a");
    assert.equal(jobs[0].sourceLinks[0].detailUrl, "https://career.buaa.edu.cn/f/a");
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("逐高校更新时间独立判断，不被其他高校成功更新掩盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-source-view-"));
  const db = await openDatabase(join(dir, "test.db"));
  try {
    const insert = db.prepare("INSERT INTO source_runs (source, started_at, finished_at, status, fetched_count, new_count, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("甲大学", "2026-09-27T00:00:00Z", "2026-09-27T00:01:00Z", "success", 2, 2, null);
    insert.run("乙大学", "2026-09-30T00:00:00Z", "2026-09-30T00:01:00Z", "success", 1, 1, null);
    insert.run("丙大学", "2026-09-30T00:00:00Z", "2026-09-30T00:01:00Z", "failed", 0, 0, "secret-path");
    for (const source of ["甲大学", "乙大学", "丙大学"]) refreshSourceStatus(db, source);
    const response = listJobs(db, { now: Date.parse("2026-09-30T01:00:00Z") });
    assert.equal(response.sources.length, 3);
    assert.equal(response.sources.find((source) => source.source === "甲大学").isStale, true);
    assert.equal(response.sources.find((source) => source.source === "乙大学").isStale, false);
    assert.equal(response.sources.find((source) => source.source === "丙大学").lastStatus, "failed");
    assert.equal(response.freshness.staleSources, 2);
    assert.equal(response.freshness.failedSources, 1);
    assert.equal(response.freshness.lastSuccessfulAt, "2026-09-30T00:01:00Z");
    assert.equal(response.freshness.isStale, true);
    assert.ok(!JSON.stringify(response).includes("secret-path"));
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("管理授权和审核状态持久化", async () => {
  const token = "a".repeat(32);
  assert.equal(isAuthorized(token, token), true);
  assert.equal(isAuthorized(token, "b".repeat(32)), false);
  assert.equal(isAuthorized("short", "short"), false);
  assert.equal(readBearerToken(`Bearer ${token}`), token);
  assert.equal(readBearerToken(`Basic ${token}`), "");
  assert.throws(() => validateReviewInput({ source: "x", sourceId: "1", status: "deleted" }), /无效/);
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-review-"));
  const path = join(dir, "test.db");
  const db = await openDatabase(path);
  try {
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO jobs (source, source_id, company, title, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 1; index <= 101; index += 1) insert.run("测试大学", String(index), "测试公司", `测试招聘${index}`, now, now);
    assert.equal(listPendingReviews(db).jobs.length, 100);
    assert.equal(listPendingReviews(db).hasMore, true);
    assert.equal(listPendingReviews(db, { limit: 100, offset: 100 }).jobs.length, 1);
    assert.equal(listPendingReviews(db, { limit: 100, offset: 100 }).hasMore, false);
    assert.equal(updateReview(db, { source: "测试大学", sourceId: "1", status: "approved" }), 1);
    assert.equal(listPendingReviews(db).pendingCount, 100);
    assert.equal(db.prepare("SELECT review_status FROM jobs WHERE source_id='1'").get().review_status, "approved");
    assert.equal(updateReview(db, { source: "测试大学", sourceId: "1", status: "hidden" }), 1);
    assert.equal(updateReview(db, { source: "测试大学", sourceId: "missing", status: "hidden" }), 0);
    const events = listPendingReviews(db).recentReviews;
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(({ oldStatus, newStatus }) => [oldStatus, newStatus]), [["approved", "hidden"], ["pending", "approved"]]);
    assert.equal(events[0].actor, "admin");
    assert.ok(!JSON.stringify(events).includes(token));
    assert.ok(Number.isFinite(Date.parse(events[0].createdAt)));
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("管理口令连续失败限速、到期恢复和正确口令解锁", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-auth-"));
  const db = await openDatabase(join(dir, "test.db"));
  const token = "a".repeat(32);
  const start = Date.parse("2026-09-29T00:00:00Z");
  try {
    for (let i = 0; i < 4; i += 1) assert.equal(checkAdminAuthorization(db, token, "bad", start).status, 401);
    assert.deepEqual(checkAdminAuthorization(db, token, "bad", start), { authorized: false, status: 429, retryAfter: 900 });
    assert.equal(checkAdminAuthorization(db, token, "bad", start + 1000).retryAfter, 899);
    assert.equal(checkAdminAuthorization(db, token, token, start + 2000).authorized, true);
    assert.equal(checkAdminAuthorization(db, token, "bad", start + 3000).status, 401);
    for (let i = 0; i < 4; i += 1) checkAdminAuthorization(db, token, "bad", start + 3000);
    assert.equal(checkAdminAuthorization(db, token, "bad", start + 15 * 60 * 1000 + 3000).status, 401);
    assert.equal(db.prepare("SELECT failures FROM admin_auth_limits WHERE id=1").get().failures, 1);
  } finally { closeDatabase(db); await rm(dir, { recursive: true, force: true }); }
});

test("飞书通知签名、响应和未配置跳过", async () => {
  const oldWebhook = process.env.FEISHU_WEBHOOK_URL;
  const oldSecret = process.env.FEISHU_SIGN_SECRET;
  try {
    delete process.env.FEISHU_WEBHOOK_URL;
    let calls = 0;
    await notify("跳过", async () => { calls += 1; });
    assert.equal(calls, 0);
    process.env.FEISHU_WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/test";
    process.env.FEISHU_SIGN_SECRET = "secret";
    await notify("测试消息", async (url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(url.hostname, "open.feishu.cn");
      assert.equal(body.msg_type, "text");
      assert.equal(body.content.text, "测试消息");
      assert.equal(body.timestamp, "1700000000");
      assert.equal(body.sign, "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=");
      return { ok: true, json: async () => ({ code: 0 }) };
    }, () => 1700000000000);
    assert.equal(calls, 1);
    await assert.rejects(notify("失败", async () => ({ ok: true, json: async () => ({ code: 19021, msg: "sign match fail" }) })), /sign match fail/);
  } finally {
    if (oldWebhook === undefined) delete process.env.FEISHU_WEBHOOK_URL; else process.env.FEISHU_WEBHOOK_URL = oldWebhook;
    if (oldSecret === undefined) delete process.env.FEISHU_SIGN_SECRET; else process.env.FEISHU_SIGN_SECRET = oldSecret;
  }
});
