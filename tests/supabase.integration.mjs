import "../scripts/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresPool } from "../scripts/postgres.mjs";
import { postgresDatabase } from "../scripts/runtime-db.mjs";
import { openDatabase, closeDatabase } from "../scripts/db.mjs";
import { listJobs, getJobDetail, getSavedJobs } from "../scripts/jobs-service.mjs";
import { checkPostgresAuthorization, updatePostgresReview, listPostgresReviews } from "../scripts/postgres-reviews.mjs";
import { createDedupeKey } from "../scripts/dedupe.mjs";
import { syncRows } from "../scripts/supabase-sync.mjs";
import { APP_SCHEMA } from "../scripts/supabase-schema.mjs";
import { updateSourceControl, sourceIsRestricted } from "../scripts/source-controls.mjs";

const source = "北京航空航天大学";
const peer = "北京理工大学";
const columns = ["id", "source", "source_id", "company", "title", "job_type", "published_at", "deadline", "recruiting_numbers", "detail_url", "first_seen_at", "last_seen_at", "review_status", "dedupe_key", "location_checked_at"];

function fixture() {
  const job = (id, school, title, deadline) => ({
    id, source: school, source_id: `integration-${id}`, company: "测试公司", title, deadline,
    job_type: "校招", published_at: "2026-10-01", recruiting_numbers: "2",
    detail_url: school === source ? `https://career.buaa.edu.cn/test/${id}` : `https://job.bit.edu.cn/test/${id}`,
    first_seen_at: "2026-10-01T00:00:00.000Z", last_seen_at: "2026-10-01T00:00:00.000Z",
    review_status: "pending", dedupe_key: createDedupeKey({ company: "测试公司", title }), location_checked_at: "",
  });
  return {
    jobs: [job(1, source, "共同招聘", "2026-10-05"), job(2, peer, "共同招聘", "2026-10-05"), job(3, source, "独立招聘 ACME", ""), job(4, source, "隐藏招聘", "not-a-date")],
    jobLocations: [{ job_id: 1, location: "北京" }, { job_id: 2, location: "上海" }],
    jobIndustries: [{ job_id: 1, industry: "金融" }, { job_id: 2, industry: "金融" }],
    sourceRuns: [{ id: 1, source, started_at: "2026-10-01T00:00:00Z", finished_at: "2026-10-01T00:00:01Z", status: "success", fetched_count: 4, new_count: 4, error: null }],
    sourceStatus: [], reviewEvents: [], adminAuthLimits: [],
  };
}

async function isolatedDatabase(action) {
  const pool = createPostgresPool();
  let client;
  try {
    client = await pool.connect();
    client.on("error", () => {});
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_temp");
    const schema = APP_SCHEMA;
    for (const statement of schema.split(";")) {
      const start = statement.search(/create table if not exists/i);
      if (start !== -1) await client.query(statement.slice(start).replace(/create table if not exists/i, "CREATE TEMP TABLE"));
    }
    const tables = (await client.query("SELECT c.relname, c.relpersistence FROM pg_class c WHERE c.relnamespace=pg_my_temp_schema() AND c.relkind='r'")).rows;
    assert.equal(tables.length, 8);
    assert.ok(tables.every((row) => row.relpersistence === "t"));
    // Nested application transactions use savepoints under a rollback-only test transaction.
    const scoped = { query: (sql, params) => {
      if (sql === "BEGIN") return client.query("SAVEPOINT app_test");
      if (sql === "COMMIT") return client.query("RELEASE SAVEPOINT app_test");
      if (sql === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT app_test");
      return client.query(sql, params);
    } };
    await action(postgresDatabase(scoped), scoped);
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* The connection may already be lost. */ }
      client.release();
    }
    await pool.end();
  }
}

test("真实 Supabase 查询与 SQLite 一致，包含去重、筛选、详情、导出和异常日期", { timeout: 180000 }, async () => {
  await isolatedDatabase(async (db, client) => {
    const dir = await mkdtemp(join(tmpdir(), "campus-runtime-"));
    const local = await openDatabase(join(dir, "test.db"));
    try {
      const data = fixture();
      await syncRows(client, data);
      for (const row of data.jobs) local.prepare(`INSERT INTO jobs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((key) => row[key]));
      for (const row of data.jobLocations) local.prepare("INSERT INTO job_locations VALUES (?,?)").run(row.job_id, row.location);
      for (const row of data.jobIndustries) local.prepare("INSERT INTO job_industries VALUES (?,?)").run(row.job_id, row.industry);
      await client.query("UPDATE jobs SET review_status='hidden' WHERE id=4");
      local.prepare("UPDATE jobs SET review_status='hidden' WHERE id=4").run();
      for (const options of [{}, { source }, { city: "北京", industry: "金融" }, { q: "共同", limit: 1, offset: 1 }, { q: "acme" }, { deadline: "due7" }, { deadline: "unknown" }]) {
        const args = { ...options, now: Date.parse("2026-10-01T00:00:00Z") };
        const cloud = await listJobs(db, args);
        const sqlite = await listJobs(local, args);
        assert.equal(cloud.matchCount, sqlite.matchCount);
        assert.deepEqual(cloud.jobs, sqlite.jobs);
      }
      assert.deepEqual(await getJobDetail(db, { source, sourceId: "integration-1" }), await getJobDetail(local, { source, sourceId: "integration-1" }));
      assert.equal(await getJobDetail(db, { source, sourceId: "integration-4" }), null);
      const keys = [`${source}:integration-1`, `${source}:missing`, "invalid", `${source}:integration-3`];
      assert.deepEqual(await getSavedJobs(db, keys), await getSavedJobs(local, keys));
      await assert.rejects(listJobs(db, { city: "不存在城市" }), /未知工作城市/);
      await assert.rejects(listJobs(db, { deadline: "bad" }), /未知截止/);
      await client.query("UPDATE jobs SET review_status='pending' WHERE id=4");
      assert.equal((await listJobs(db, { deadline: "open", now: Date.parse("2026-10-01T00:00:00Z") })).matchCount, 1);
    } finally { closeDatabase(local); await rm(dir, { recursive: true, force: true }); }
  });
});

test("真实 Supabase 审核事务与持久化限速，审计失败时回滚", { timeout: 120000 }, async () => {
  await isolatedDatabase(async (db, client) => {
    await syncRows(client, fixture());
    const token = "integration-test-token-not-a-real-secret";
    for (let i = 0; i < 5; i++) assert.equal((await checkPostgresAuthorization(db, token, "wrong", 100000)).status, i === 4 ? 429 : 401);
    assert.equal((await checkPostgresAuthorization(db, token, "wrong", 100001)).retryAfter, 900);
    assert.equal((await checkPostgresAuthorization(db, token, "wrong", 1000000)).status, 401);
    assert.equal((await checkPostgresAuthorization(db, token, token)).authorized, true);
    assert.equal(Number((await client.query("SELECT COUNT(*) FROM admin_auth_limits")).rows[0].count), 0);
    assert.equal(await updatePostgresReview(db, { source, sourceId: "missing", status: "approved" }), 0);
    assert.equal(await updatePostgresReview(db, { source, sourceId: "integration-1", status: "approved" }), 1);
    const reviews = await listPostgresReviews(db);
    assert.equal(reviews.pendingCount, 3);
    assert.equal(reviews.recentReviews[0].oldStatus, "pending");
    await client.query("ALTER TABLE review_events ADD CONSTRAINT reject_hidden_test CHECK(new_status <> 'hidden')");
    await assert.rejects(updatePostgresReview(db, { source, sourceId: "integration-1", status: "hidden" }));
    assert.equal((await client.query("SELECT review_status FROM jobs WHERE id=1")).rows[0].review_status, "approved");
    assert.equal(Number((await client.query("SELECT COUNT(*) FROM review_events")).rows[0].count), 1);
  });
});

test("真实 Supabase 重复同步不覆盖云端审核、审计和限速，拒绝 ID 错配和空库", { timeout: 120000 }, async () => {
  await isolatedDatabase(async (db, client) => {
    const data = fixture();
    await syncRows(client, data);
    await updatePostgresReview(db, { source, sourceId: "integration-1", status: "hidden" });
    await client.query("INSERT INTO admin_auth_limits VALUES (1,100000,5)");
    await updateSourceControl(db, { id: "bit", action: "restrict", reason: "privacy" });
    await syncRows(client, data);
    assert.equal((await client.query("SELECT review_status FROM jobs WHERE id=1")).rows[0].review_status, "hidden");
    assert.equal(Number((await client.query("SELECT COUNT(*) FROM review_events")).rows[0].count), 1);
    assert.equal((await client.query("SELECT failures FROM admin_auth_limits WHERE id=1")).rows[0].failures, 5);
    assert.equal(await sourceIsRestricted(db, "bit"), true);
    await assert.rejects(syncRows(client, { ...data, jobs: data.jobs.map((row) => ({ ...row, id: row.id + 100 })) }), /IDs differ/);
    await assert.rejects(syncRows(client, { ...data, jobs: [] }), /empty/);
    assert.equal(Number((await client.query("SELECT COUNT(*) FROM job_locations")).rows[0].count), 2);
  });
});

test("真实 Supabase 来源下架覆盖全部查询，审计写入失败不改变状态，恢复不恢复单条隐藏", { timeout: 180000 }, async () => {
  await isolatedDatabase(async (db, client) => {
    await syncRows(client, fixture());
    await updatePostgresReview(db, { source, sourceId: "integration-4", status: "hidden" });
    await updateSourceControl(db, { id: "bit", action: "restrict", reason: "source_request" });
    const data = await listJobs(db);
    assert.equal(data.stats.total, 2);
    assert.equal(data.matchCount, 2);
    assert.ok(data.sources.every((row) => row.source !== peer));
    assert.ok(data.jobs.every((job) => job.sourceCount === 1 && job.sourceLinks.every((link) => link.source !== peer)));
    assert.ok(data.locations.every((row) => row.location !== "上海"));
    assert.equal(await getJobDetail(db, { source: peer, sourceId: "integration-2" }), null);
    assert.equal((await getSavedJobs(db, [`${peer}:integration-2`, `${source}:integration-1`])).length, 1);
    await client.query("ALTER TABLE source_controls ADD CONSTRAINT reject_restore_test CHECK(action <> 'restore')");
    await assert.rejects(updateSourceControl(db, { id: "bit", action: "restore", reason: "resolved" }));
    assert.equal(await sourceIsRestricted(db, "bit"), true);
    await client.query("ALTER TABLE source_controls DROP CONSTRAINT reject_restore_test");
    await updateSourceControl(db, { id: "bit", action: "restore", reason: "resolved" });
    assert.equal(await sourceIsRestricted(db, "bit"), false);
    assert.equal(await getJobDetail(db, { source, sourceId: "integration-4" }), null);
  });
});
