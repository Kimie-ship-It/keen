import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "../scripts/db.mjs";
import { collectBuaa } from "../scripts/collect-buaa.mjs";
import { normalizeItem, requestJson } from "../scripts/collection.mjs";
import { listJobs } from "../scripts/jobs-service.mjs";
import { isAuthorized, listPendingReviews, readBearerToken, updateReview, validateReviewInput } from "../scripts/reviews.mjs";
import { notify } from "../scripts/notify.mjs";
import { parsePagination } from "../scripts/query.mjs";

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
    closeDatabase(result);
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
    db.prepare("INSERT INTO source_runs (source, started_at, finished_at, status, fetched_count, new_count, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("甲大学", now, now, "failed", 0, 0, "内部路径不应公开");
    assert.equal(listJobs(db, { limit: 1 }).jobs.length, 1);
    assert.equal(listJobs(db, { limit: 1 }).matchCount, 2);
    assert.equal(Object.hasOwn(listJobs(db).runs[0], "error"), false);
    assert.equal(listJobs(db, { q: "乙公司" }).jobs[0].sourceId, "2");
    assert.deepEqual(listJobs(db, { q: "不存在" }).jobs, []);
    assert.equal(listJobs(db, { offset: 1 }).jobs[0].sourceId, "2");
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
