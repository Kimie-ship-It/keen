import { test } from "node:test";
import assert from "node:assert/strict";
import { storageMode, postgresQuery, postgresDatabase } from "../scripts/runtime-db.mjs";
import { createPostgresPool } from "../scripts/postgres.mjs";

test("存储模式明确选择，未知配置拒绝而非静默回退", () => {
  assert.equal(storageMode({}), "sqlite");
  assert.equal(storageMode({ CAMPUS_JOBS_STORAGE: "supabase" }), "supabase");
  assert.throws(() => storageMode({ CAMPUS_JOBS_STORAGE: "typo" }), /Invalid/);
  assert.throws(() => createPostgresPool({}), /Missing/);
});

test("PostgreSQL 参数编号和别名转换不改动字符串常量", () => {
  assert.equal(postgresQuery("SELECT '?' AS sourceId, ? AS jobType WHERE sourceId=?"), 'SELECT \'?\' AS "sourceId", $1 AS "jobType" WHERE "sourceId"=$2');
  assert.equal(postgresQuery("SELECT 'it''s ? sourceId', \"sourceId\" WHERE title=?"), 'SELECT \'it\'\'s ? sourceId\', "sourceId" WHERE title=$1');
});

test("PostgreSQL 数量字段转为安全整数，拒绝精度损失", async () => {
  const db = postgresDatabase({ query: async (sql, params) => {
    assert.equal(sql, 'SELECT COUNT(*) AS total WHERE source=$1');
    assert.deepEqual(params, ["source"]);
    return { rows: [{ total: "42" }], fields: [{ name: "total", dataTypeID: 20 }] };
  } });
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS total WHERE source=?").get("source"), { total: 42 });
  const unsafe = postgresDatabase({ query: async () => ({ rows: [{ id: "9007199254740993" }], fields: [{ name: "id", dataTypeID: 20 }] }) });
  await assert.rejects(unsafe.prepare("SELECT id").get(), /safe range/);
});

test("数据库默认验证 TLS 证书，URI 参数不能关闭验证", async () => {
  const secure = createPostgresPool({ SUPABASE_DB_URL: "postgresql://user:fake@localhost/db?sslmode=no-verify" });
  const compat = createPostgresPool({ SUPABASE_DB_URL: "postgresql://user:fake@localhost/db", SUPABASE_SSL_INSECURE: "1" });
  assert.equal(secure.options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(secure.options.connectionString).searchParams.has("sslmode"), false);
  assert.equal(compat.options.ssl.rejectUnauthorized, false);
  await secure.end();
  await compat.end();
});
