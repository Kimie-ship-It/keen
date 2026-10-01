import "../scripts/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresPool } from "../scripts/postgres.mjs";
import { captureSnapshot, encodeBackup, decodeBackup, restoreDrill, restoreEmptyTarget } from "../scripts/supabase-backup.mjs";
import { APP_SCHEMA } from "../scripts/supabase-schema.mjs";

test("real PostgreSQL recovery preserves hidden/approved reviews, audit and limits without production writes", { timeout: 180000 }, async () => {
  const pool = createPostgresPool();
  let client;
  try {
    client = await pool.connect();
    client.on("error", () => {});
    const production = async () => (await client.query("SELECT (SELECT COUNT(*) FROM public.jobs) AS jobs, (SELECT COUNT(*) FROM public.review_events) AS events, (SELECT COUNT(*) FROM public.jobs WHERE review_status='hidden') AS hidden")).rows[0];
    const before = await production();
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_temp");
    const schema = APP_SCHEMA;
    await client.query(schema.replace(/create table if not exists/gi, "CREATE TEMP TABLE"));
    await client.query("INSERT INTO pg_temp.jobs (id,source,source_id,company,title,first_seen_at,last_seen_at,review_status) VALUES (1,'测试高校','a','测试公司','隐藏招聘','now','now','hidden'),(2,'测试高校','b','测试公司','核验通过招聘','now','now','approved')");
    await client.query("INSERT INTO pg_temp.job_locations VALUES (1,'北京'); INSERT INTO pg_temp.job_industries VALUES (1,'金融'); INSERT INTO pg_temp.source_runs (id,source,started_at,status) VALUES (1,'测试高校','now','success'); INSERT INTO pg_temp.source_status (source) VALUES ('测试高校'); INSERT INTO pg_temp.review_events (id,source,source_id,old_status,new_status,actor,created_at) VALUES (1,'测试高校','a','pending','hidden','管理员','now'); INSERT INTO pg_temp.admin_auth_limits VALUES (1,100000,5)");
    await client.query("INSERT INTO pg_temp.source_controls (id,source,action,reason,actor,created_at) VALUES (7,'测试高校','restrict','privacy','管理员','now')");
    const snapshot = await captureSnapshot(client, { schema: "pg_temp" });
    await client.query("ROLLBACK");
    const key = "3".repeat(64);
    const result = await restoreDrill(client, decodeBackup(encodeBackup(snapshot, key), key));
    assert.equal(result.contents, "identical");
    assert.equal(result.identitySequences, "verified");
    assert.equal(result.productionWrites, false);
    assert.equal(result.counts.review_events, 1);
    assert.equal(result.counts.admin_auth_limits, 1);
    assert.equal(result.counts.source_controls, 1);
    assert.equal(result.sourceRestrictions, "included");
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query(schema.replace(/create table if not exists/gi, "CREATE TEMP TABLE"));
    // Map the restore transaction to a savepoint; the outer transaction always rolls back.
    const isolated = { query: (sql, values) => client.query(sql === "BEGIN" ? "SAVEPOINT restore_test" : sql === "COMMIT" ? "RELEASE SAVEPOINT restore_test" : sql === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT restore_test" : sql, values) };
    const actualPath = await restoreEmptyTarget(isolated, snapshot, { schema: "pg_temp" });
    assert.equal(actualPath.contents, "identical");
    await assert.rejects(restoreEmptyTarget(isolated, snapshot, { schema: "pg_temp" }), /not empty/);
    assert.deepEqual((await captureSnapshot(client, { schema: "pg_temp" })).tables, snapshot.tables);
    assert.equal((await client.query("SELECT nextval(pg_get_serial_sequence('pg_temp.jobs','id')) AS id")).rows[0].id, "3");
    assert.equal((await client.query("SELECT nextval(pg_get_serial_sequence('pg_temp.source_controls','id')) AS id")).rows[0].id, "8");
    await client.query("ROLLBACK");
    assert.deepEqual(await production(), before);
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original test failure. */ }
      client.release();
    }
    await pool.end();
  }
});
