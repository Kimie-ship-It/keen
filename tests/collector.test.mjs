import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "../scripts/db.mjs";
import { collectBuaa } from "../scripts/collect-buaa.mjs";
import { normalizeItem, requestJson } from "../scripts/collection.mjs";
import { listJobs } from "../scripts/jobs-service.mjs";
import { checkAdminAuthorization, isAuthorized, listPendingReviews, readBearerToken, updateReview, validateReviewInput } from "../scripts/reviews.mjs";
import { notify } from "../scripts/notify.mjs";
import { parsePagination } from "../scripts/query.mjs";
import { getSource, SOURCES } from "../scripts/sources.mjs";
import { collectSource } from "../scripts/collector-registry.mjs";
import { refreshSourceStatus } from "../scripts/source-status.mjs";

test("高校来源配置集中管理", () => {
  assert.equal(getSource("buaa").name, "北京航空航天大学");
  assert.equal(getSource("buaa").baseUrl, "https://career.buaa.edu.cn");
  assert.equal(Object.keys(SOURCES).length, 1);
  assert.throws(() => getSource("unknown"), /未知高校来源/);
  assert.throws(() => getSource("constructor"), /未知高校来源/);
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
});

test("采集去重、审核状态保留、失败不丢数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-"));
  const path = join(dir, "test.db");
  let current = "a";
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => url.includes("getToken")
      ? { data: "test-token" }
      : { state: 1, object: { totalPage: 1, list: [{
        id: current, title: "测试招聘", corporationName: "测试公司",
        detailsUrl: "//f/recruitmentinfo/show?recruitmentId=" + current,
      }] } },
  });
  try {
    const options = { dbPath: path, fetchImpl: fakeFetch, skipSnapshot: true, wait: async () => {} };
    assert.equal((await collectBuaa(options)).newCount, 1);
    const db = await openDatabase(path);
    const firstSuccess = db.prepare("SELECT last_status AS status, last_success_at AS successAt, fetched_count AS fetchedCount FROM source_status WHERE source=?").get("北京航空航天大学");
    assert.equal(firstSuccess.status, "success");
    assert.equal(firstSuccess.fetchedCount, 1);
    db.prepare("UPDATE jobs SET review_status='approved' WHERE source_id='a'").run();
    closeDatabase(db);
    assert.equal((await collectBuaa(options)).newCount, 0);
    current = "b";
    assert.equal((await collectBuaa(options)).newCount, 1);
    await assert.rejects(collectBuaa({ ...options, fetchImpl: async () => { throw new Error("network down"); } }), /network down/);
    const result = await openDatabase(path);
    assert.equal(result.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2);
    assert.equal(result.prepare("SELECT review_status FROM jobs WHERE source_id='a'").get().review_status, "approved");
    assert.equal(result.prepare("SELECT status FROM source_runs ORDER BY id DESC LIMIT 1").get().status, "failed");
    assert.equal(result.prepare("SELECT detail_url FROM jobs WHERE source_id='a'").get().detail_url, "https://career.buaa.edu.cn/f/recruitmentinfo/show?recruitmentId=a");
    const failedState = result.prepare("SELECT last_status AS status, last_success_at AS successAt, last_failure_at AS failureAt, last_error AS error FROM source_status WHERE source=?").get("北京航空航天大学");
    assert.equal(failedState.status, "failed");
    assert.ok(failedState.successAt >= firstSuccess.successAt);
    assert.ok(failedState.failureAt);
    assert.match(failedState.error, /network down/);
    closeDatabase(result);
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
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_status").get().count, 1);
    closeDatabase(db);
    const reopened = await openDatabase(path);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM source_status").get().count, 1);
    closeDatabase(reopened);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("超时重试与非重试 HTTP 错误", async () => {
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
  assert.throws(() => normalizeItem({ id: "a", title: "x", detailsUrl: "https://evil.example/redirect" }, new Date().toISOString()), /不合法/);
});

test("空列表和分页中途失败不写入半成品", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campus-jobs-partial-"));
  const path = join(dir, "test.db");
  const tokenResponse = { ok: true, json: async () => ({ data: "test-token" }) };
  try {
    await assert.rejects(collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url, options) => {
        if (url.includes("getToken")) return tokenResponse;
        const page = options.body.get("pageNo");
        if (page === "1") return { ok: true, json: async () => ({ state: 1, object: { totalPage: 2, list: [{ id: "a", title: "第一页记录" }] } }) };
        throw new Error("second page failed");
      },
    }), /second page failed/);
    await assert.rejects(collectBuaa({
      dbPath: path, skipSnapshot: true, wait: async () => {},
      fetchImpl: async (url) => url.includes("getToken") ? tokenResponse : ({ ok: true, json: async () => ({ state: 1, object: { totalPage: 1, list: [] } }) }),
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
