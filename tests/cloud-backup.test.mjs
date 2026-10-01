import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_TABLES, captureSnapshot, encodeBackup, decodeBackup, persistBackup, readBackup, restoreDrill, restoreEmptyTarget, assertSeparateRestoreTarget, latestCloudBackup } from "../scripts/supabase-backup.mjs";
import { LEGACY_SCHEMA, schemaHash } from "../scripts/supabase-schema.mjs";

const key = "1".repeat(64);

test("legacy encrypted backups remain readable but cannot publish without withdrawal reconciliation", async () => {
  const snapshot = await fixture();
  snapshot.format = "campus-jobs-supabase-v1";
  snapshot.schemaHash = schemaHash(LEGACY_SCHEMA);
  delete snapshot.tables.source_controls;
  assert.deepEqual(decodeBackup(encodeBackup(snapshot, key), key), snapshot);
  const calls = [];
  await assert.rejects(restoreEmptyTarget({ query: async (sql) => calls.push(sql) }, snapshot), /no source restrictions/);
  assert.deepEqual(calls, []);
  const envelope = JSON.parse(encodeBackup(snapshot, key));
  envelope.format = "campus-jobs-supabase-v2";
  assert.throws(() => decodeBackup(JSON.stringify(envelope), key), /verification failed/);
});
async function fixture(now = new Date("2026-10-01T00:00:00Z")) {
  return captureSnapshot({ query: async (sql) => {
    const name = sql.match(/FROM public\.(\w+)/)[1];
    const table = BACKUP_TABLES.find((table) => table.name === name);
    const job = Object.fromEntries(table.columns.map((column) => [column, ""]));
    if (name === "jobs") Object.assign(job, { id: "9007199254740993", source: "测试高校", source_id: "1", title: "测试招聘", review_status: "hidden" });
    return { fields: table.columns.map((name) => ({ name })), rows: name === "jobs" ? [job] : [] };
  } }, { now });
}

test("cloud snapshot encrypts content, preserves bigint IDs and rejects wrong keys/tampering", async () => {
  const snapshot = await fixture();
  const encoded = encodeBackup(snapshot, key);
  assert.ok(!encoded.includes("测试招聘"));
  assert.ok(!encoded.includes("9007199254740993"));
  assert.deepEqual(decodeBackup(encoded, key), snapshot);
  assert.notEqual(encodeBackup(snapshot, key), encoded);
  assert.throws(() => decodeBackup(encoded, "2".repeat(64)), /verification failed/);
  const envelope = JSON.parse(encoded);
  envelope.data = "AAAA" + envelope.data.slice(4);
  assert.throws(() => decodeBackup(JSON.stringify(envelope), key), /verification failed/);
  assert.throws(() => encodeBackup(snapshot, "short"), /64-character/);
  assert.throws(() => encodeBackup({ ...snapshot, schemaHash: "unknown" }, key), /schema version/);
  const empty = structuredClone(snapshot);
  empty.tables.jobs = [];
  assert.throws(() => encodeBackup(empty, key), /empty/);
  const mismatch = structuredClone(snapshot);
  mismatch.tables.jobs[0].secret = "unexpected";
  assert.throws(() => encodeBackup(mismatch, key), /column mismatch/);
});

test("cloud backup retention keeps valid copies and leaves unrelated/partial/corrupt files untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "campus-cloud-backup-"));
  try {
    const corrupt = "20260101T000000000Z-aaaaaaaa.cjbackup";
    await writeFile(join(root, corrupt), "damaged");
    await writeFile(join(root, "notes.txt"), "keep");
    await writeFile(join(root, "incomplete.cjbackup.partial"), "keep");
    let latest;
    for (const day of [1, 2, 3]) {
      latest = await persistBackup(await fixture(new Date(`2026-10-0${day}T00:00:00Z`)), { backupRoot: root, retention: 2, key });
    }
    const files = await readdir(root);
    assert.equal(files.filter((file) => file.endsWith(".cjbackup")).length, 3);
    assert.ok(files.some((file) => file.startsWith("20261002")));
    assert.ok(files.includes(corrupt));
    assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "keep");
    assert.equal((await readBackup(latest.destination, key)).tables.jobs[0].review_status, "hidden");
    assert.equal(await latestCloudBackup(root), latest.destination);
    for (const retention of [0, -1, 1.5, 366, NaN]) await assert.rejects(persistBackup(await fixture(), { backupRoot: root, retention, key }), /retention/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cloud export rejects unexpected columns and recovery failures always roll back temporary work", async () => {
  await assert.rejects(captureSnapshot({ query: async () => ({ fields: [{ name: "unexpected" }], rows: [] }) }), /schema changed/);
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.startsWith("SELECT relname")) return { rows: BACKUP_TABLES.map((table) => ({ relname: table.name })) };
    if (sql.startsWith("INSERT")) throw new Error("restore fixture failure");
    return { rows: [] };
  } };
  await assert.rejects(restoreDrill(client, await fixture()), /fixture failure/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(statements.includes("SET LOCAL search_path TO pg_temp"));
  assert.ok(statements.find((sql) => sql.startsWith("INSERT")).startsWith("INSERT INTO pg_temp.jobs"));
  assert.ok(!statements.includes("COMMIT"));
});

test("restore refuses the live Supabase project even through a different pooler endpoint", () => {
  const source = "postgresql://postgres:example@db.testref.supabase.co:5432/postgres";
  assert.throws(() => assertSeparateRestoreTarget(source, "postgresql://postgres.testref:example@aws-0-us-east-1.pooler.supabase.com:6543/postgres"), /different database/);
  assert.doesNotThrow(() => assertSeparateRestoreTarget(source, "postgresql://postgres.otherref:example@aws-0-us-east-1.pooler.supabase.com:6543/postgres"));
  assert.throws(() => assertSeparateRestoreTarget("postgres://one:example@localhost/a", "postgres://two:example@localhost:5432/a"), /different database/);
  assert.throws(() => assertSeparateRestoreTarget(source, "postgresql://postgres:example@aws-0-us-east-1.pooler.supabase.com/postgres"), /identify/);
  assert.throws(() => assertSeparateRestoreTarget(source, "not a uri"), /Invalid/);
});

test("empty-target restore refuses existing rows, disabled RLS and rolls back insert failures", async () => {
  for (const failure of ["nonempty", "rls", "insert"]) {
    const statements = [];
    const client = { query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith("SELECT *")) {
        const name = sql.match(/FROM public\.(\w+)/)[1];
        return { fields: BACKUP_TABLES.find((table) => table.name === name).columns.map((name) => ({ name })), rows: failure === "nonempty" ? [{}] : [] };
      }
      if (sql.startsWith("SELECT relname")) return { rows: BACKUP_TABLES.map((table) => ({ relname: table.name, relrowsecurity: failure !== "rls" })) };
      if (sql.startsWith("INSERT")) throw new Error("insert failed");
      return { rows: [] };
    } };
    await assert.rejects(restoreEmptyTarget(client, await fixture()), failure === "nonempty" ? /not empty/ : failure === "rls" ? /RLS/ : /insert failed/);
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.ok(!statements.includes("COMMIT"));
    assert.ok(statements.some((sql) => sql.startsWith("LOCK TABLE public.jobs")));
    if (failure !== "insert") assert.ok(!statements.some((sql) => sql.startsWith("INSERT")));
  }
});

test("snapshot reads bounded ordered batches without skipping rows", async () => {
  const snapshot = await fixture();
  const jobs = Array.from({ length: 401 }, (_, index) => ({ ...snapshot.tables.jobs[0], id: String(index + 1) }));
  const offsets = [];
  const result = await captureSnapshot({ query: async (sql) => {
    const name = sql.match(/FROM public\.(\w+)/)[1];
    const offset = Number(sql.match(/OFFSET (\d+)/)[1]);
    if (name === "jobs") offsets.push(offset);
    const columns = BACKUP_TABLES.find((table) => table.name === name).columns;
    return { fields: columns.map((name) => ({ name })), rows: name === "jobs" ? jobs.slice(offset, offset + 200) : [] };
  } });
  assert.deepEqual(offsets, [0, 200, 400]);
  assert.deepEqual(result.tables.jobs, jobs);
});
