import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../scripts/db.mjs";
import { COLLECTOR_TABLES, validateCloudCollectorConfig, assertCollectorBaseline, readLocalCollectorState, readCloudCollectorState, checkCollectorBaseline, runCloudDaily } from "../scripts/cloud-collector.mjs";
import { readOffsiteAuthorization } from "../scripts/offsite-backup.mjs";

const env = () => ({
  CAMPUS_CLOUD_COLLECTOR_ENABLED: "1", CAMPUS_JOBS_STORAGE: "supabase",
  SUPABASE_DB_URL: "postgresql://test:fake-password@db.example.test/postgres",
  CAMPUS_JOBS_DB: join(tmpdir(), "seeded-collector.db"), SUPABASE_BACKUP_KEY: "ab".repeat(32),
  BAIDU_OFFSITE_ENABLED: "1", BAIDU_OFFSITE_CREDENTIAL_FILE: join(tmpdir(), "cloud-credentials.json"),
});

function baseline() {
  const tables = Object.fromEntries(COLLECTOR_TABLES.map((table) => [table.name, []]));
  const row = (name, values) => ({ ...Object.fromEntries(COLLECTOR_TABLES.find((table) => table.name === name).columns.map((column) => [column, ""])), ...values });
  tables.jobs = [row("jobs", { id: 41, source: "北京航空航天大学", source_id: "notice", review_status: "pending" })];
  tables.job_locations = [row("job_locations", { job_id: 41, location: "北京" })];
  tables.job_industries = [row("job_industries", { job_id: 41, industry: "信息技术" })];
  tables.source_runs = [row("source_runs", { id: 7, source: "北京航空航天大学", started_at: "2026-10-01T00:00:00Z", status: "success", fetched_count: 1, new_count: 1 })];
  tables.source_status = [row("source_status", { source: "北京航空航天大学", fetched_count: 1, new_count: 1 })];
  return tables;
}

function fakePool(tables, { failAt, rollbackFailure = false } = {}) {
  const calls = [];
  const client = {
    on() {},
    async query(sql) {
      calls.push(sql);
      if (failAt && sql.includes(failAt)) throw new Error("simulated baseline failure");
      if (rollbackFailure && sql === "ROLLBACK") throw new Error("simulated rollback failure");
      const selected = sql.match(/FROM public\.([a-z_]+)/);
      if (!selected) return { rows: [], fields: [] };
      const table = COLLECTOR_TABLES.find((entry) => entry.name === selected[1]);
      const offset = Number(sql.match(/OFFSET (\d+)/)[1]);
      const rows = tables[table.name].slice(offset, offset + 200);
      return { rows, fields: table.columns.map((name) => ({ name, dataTypeID: ["id", "job_id", "fetched_count", "new_count"].includes(name) ? 20 : 25 })) };
    },
    release(discard) { calls.push(`release:${discard}`); },
  };
  return { calls, client, async connect() { return client; }, async end() { calls.push("end"); } };
}

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "campus-cloud-collector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("cloud collector is disabled by default without credentials, database reads or collection", async () => {
  for (const flag of [undefined, "0"]) {
    const unexpected = async () => { throw new Error("disabled entry performed work"); };
    assert.deepEqual(await runCloudDaily({ env: { CAMPUS_CLOUD_COLLECTOR_ENABLED: flag }, readAuthorization: unexpected, checkBaseline: unexpected, daily: unexpected }), { status: "disabled", collectionStarted: false });
  }
});

test("cloud collector rejects invalid flags and missing prerequisites before performing work", async () => {
  await assert.rejects(runCloudDaily({ env: { CAMPUS_CLOUD_COLLECTOR_ENABLED: "true" } }), /enable flag/);
  for (const patch of [
    { CAMPUS_JOBS_STORAGE: "sqlite" }, { VERCEL: "1" }, { SUPABASE_SSL_INSECURE: "1" },
    { SUPABASE_DB_URL: "invalid" }, { SUPABASE_DB_URL: "postgresql://user@host/db" },
    { CAMPUS_JOBS_DB: "relative.db" }, { SUPABASE_BACKUP_KEY: "weak" },
    { BAIDU_OFFSITE_ENABLED: "0" }, { BAIDU_OFFSITE_CREDENTIAL_FILE: "" },
    { BAIDU_OFFSITE_CREDENTIAL_FILE: join(process.cwd(), "data", "credentials.json") },
  ]) {
    const unexpected = async () => assert.fail("invalid configuration performed work");
    await assert.rejects(runCloudDaily({ env: { ...env(), ...patch }, readAuthorization: unexpected, checkBaseline: unexpected, daily: unexpected }));
  }
  assert.equal(validateCloudCollectorConfig(env()).dbPath, env().CAMPUS_JOBS_DB);
});

test("baseline comparison ignores cloud-owned reviews but retains all five collector tables", () => {
  const local = baseline(), cloud = structuredClone(local);
  cloud.jobs[0].review_status = "hidden";
  assert.deepEqual(assertCollectorBaseline(local, cloud), { jobs: 1, job_locations: 1, job_industries: 1, source_runs: 1, source_status: 1 });
  assert.equal(COLLECTOR_TABLES.length, 5);
  assert.ok(!COLLECTOR_TABLES.some((table) => ["review_events", "admin_auth_limits", "source_controls"].includes(table.name)));
});

test("startup rejects empty, old, mismatched and malformed baselines", () => {
  for (const patch of [
    (tables) => { tables.jobs = []; },
    (tables) => { tables.jobs[0].id = 1; },
    (tables) => { tables.jobs[0].source_id = "other"; },
    (tables) => { tables.job_locations = []; },
    (tables) => { tables.job_industries[0].industry = "other"; },
    (tables) => { tables.source_runs[0].started_at = "other"; },
    (tables) => { tables.source_status[0].new_count = 99; },
    (tables) => { tables.jobs[0].extra = "unknown-column"; },
    (tables) => { tables.jobs[0].id = Number.MAX_SAFE_INTEGER + 1; },
    (tables) => { tables.jobs.push({ ...tables.jobs[0] }); },
    (tables) => { delete tables.source_status; },
  ]) {
    const cloud = baseline(); patch(cloud);
    assert.throws(() => assertCollectorBaseline(baseline(), cloud));
  }
});

test("baseline comparison does not depend on row order", () => {
  const local = baseline();
  local.jobs.push({ ...local.jobs[0], id: 42, source_id: "next" });
  const cloud = structuredClone(local); cloud.jobs.reverse();
  assert.equal(assertCollectorBaseline(local, cloud).jobs, 2);
});

test("local startup reads an existing SQLite database without creating or mutating it", async (t) => {
  const root = await temporary(t), path = join(root, "state.db");
  const db = await openDatabase(path);
  db.prepare("INSERT INTO jobs (id, source, source_id, first_seen_at, last_seen_at) VALUES (41, ?, ?, ?, ?)").run("北京航空航天大学", "notice", "2026-10-01", "2026-10-01");
  db.close();
  const first = readLocalCollectorState(path);
  assert.equal(first.jobs[0].id, 41);
  assert.equal(first.source_status.length, 4);
  assert.deepEqual(readLocalCollectorState(path), first);
  const absent = join(root, "missing.db");
  assert.throws(() => readLocalCollectorState(absent));
  await assert.rejects(access(absent));
});

test("empty or damaged SQLite state fails before cloud connection is created", async (t) => {
  const root = await temporary(t), path = join(root, "empty.db");
  const db = await openDatabase(path); db.close();
  const makePool = () => assert.fail("invalid state connected to cloud");
  await assert.rejects(checkCollectorBaseline({ dbPath: path, makePool }), /Seed/);
  const damaged = join(root, "damaged.db");
  await writeFile(damaged, "not a database");
  await assert.rejects(checkCollectorBaseline({ dbPath: damaged, makePool }));
});

test("cloud startup uses a read-only repeatable snapshot and releases its connection", async () => {
  const pool = fakePool(baseline());
  assert.deepEqual(await readCloudCollectorState(pool), baseline());
  assert.equal(pool.calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.deepEqual(pool.calls.slice(-3), ["ROLLBACK", "release:false", "end"]);
  assert.ok(pool.calls.filter((sql) => sql.startsWith("SELECT")).every((sql) => !/review_events|admin_auth_limits|source_controls/.test(sql)));
  assert.ok(!pool.calls.some((sql) => /^(INSERT|UPDATE|DELETE|CREATE|ALTER)/.test(sql)));
});

test("cloud startup paginates and safely converts PostgreSQL identity integers", async () => {
  const tables = baseline();
  tables.jobs = Array.from({ length: 401 }, (_, index) => ({ ...tables.jobs[0], id: String(index + 1), source_id: String(index) }));
  const pool = fakePool(tables);
  const state = await readCloudCollectorState(pool);
  assert.equal(state.jobs.length, 401);
  assert.equal(state.jobs[400].id, 401);
  assert.equal(pool.calls.filter((sql) => sql.includes("FROM public.jobs")).length, 3);
  tables.jobs[0].id = "9007199254740992";
  await assert.rejects(readCloudCollectorState(fakePool(tables)), /safe range/);
});

test("cloud read and transaction cleanup errors cannot pass startup", async () => {
  const pool = fakePool(baseline(), { failAt: "FROM public.jobs" });
  await assert.rejects(readCloudCollectorState(pool), /simulated baseline failure/);
  assert.deepEqual(pool.calls.slice(-3), ["ROLLBACK", "release:false", "end"]);
  const rollbackPool = fakePool(baseline(), { rollbackFailure: true });
  await assert.rejects(readCloudCollectorState(rollbackPool), /did not close/);
  assert.deepEqual(rollbackPool.calls.slice(-3), ["ROLLBACK", "release:true", "end"]);
  const releasePool = fakePool(baseline());
  releasePool.client.release = () => { throw new Error("simulated release failure"); };
  await assert.rejects(readCloudCollectorState(releasePool), /did not release/);
  assert.equal(releasePool.calls.at(-1), "end");
  let ended = false;
  await assert.rejects(readCloudCollectorState({ async connect() { throw new Error("connection unavailable"); }, async end() { ended = true; } }), /connection unavailable/);
  assert.ok(ended);
});

test("invalid offsite credentials or baseline stop the daily flow before collection", async () => {
  const daily = async () => assert.fail("startup failure started collection");
  await assert.rejects(runCloudDaily({ env: env(), readAuthorization: async () => { throw new Error("missing authorization"); }, checkBaseline: daily, daily }), /missing authorization/);
  await assert.rejects(runCloudDaily({ env: env(), readAuthorization: async () => ({}), checkBaseline: async () => { throw new Error("baseline mismatch"); }, daily }), /baseline mismatch/);
});

test("accepted mock startup reuses the daily flow and preserves degraded results", async () => {
  const steps = [];
  const supplied = env();
  const result = await runCloudDaily({
    env: supplied,
    readAuthorization: async (path) => { assert.equal(path, supplied.BAIDU_OFFSITE_CREDENTIAL_FILE); steps.push("authorization"); },
    checkBaseline: async ({ env: received }) => { assert.equal(received, supplied); steps.push("baseline"); return { jobs: 41 }; },
    daily: async ({ env: received }) => { assert.equal(received, supplied); steps.push("daily"); return { status: "degraded", failures: [{ operation: "collection" }] }; },
  });
  assert.deepEqual(steps, ["authorization", "baseline", "daily"]);
  assert.equal(result.status, "degraded");
  assert.equal(result.collectionStarted, true);
  assert.deepEqual(result.baseline, { jobs: 41 });
});

test("authorization preparation validates the file without refreshing or modifying it", async (t) => {
  const root = await temporary(t), path = join(root, "credentials.json");
  await writeFile(path, JSON.stringify({ appName: "test", clientId: "fake", clientSecret: "fake", refreshToken: "fake", accessToken: "fake", expiresAt: 1 }));
  assert.equal((await readOffsiteAuthorization(path)).expiresAt, 1);
  await writeFile(path, "{}");
  await assert.rejects(readOffsiteAuthorization(path), /not configured/);
  await assert.rejects(readOffsiteAuthorization(root), /Invalid/);
});
