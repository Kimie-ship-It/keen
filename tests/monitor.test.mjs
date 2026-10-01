import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createErrorEvent, errorCategory, reportError, readErrorEvents, MAX_LOG_BYTES, LOG_RETENTION } from "../scripts/monitor.mjs";
import { checkHealth, evaluateSources } from "../scripts/monitor-health.mjs";
import { runDaily } from "../scripts/collect-daily.mjs";
import { SOURCES } from "../scripts/sources.mjs";

const NOW = Date.parse("2026-10-01T10:00:00Z");
const SECRET = "monitor-test-secret-do-not-persist";
const secretError = () => Object.assign(new Error(`postgresql://user:${SECRET}@host/db`), { code: "ECONNREFUSED" });
const freshRows = () => Object.values(SOURCES).map((source) => ({ source: source.name, last_status: "success", last_success_at: new Date(NOW - 1000).toISOString() }));

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "campus-monitor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("error events allow only fixed metadata and never store secrets", () => {
  const event = createErrorEvent(secretError(), { operation: "jobs.list", source: "buaa", method: "GET", route: SECRET, headers: SECRET, message: SECRET, query: SECRET, ip: SECRET }, new Date(NOW));
  assert.equal(event.route, "/api/jobs");
  assert.equal(event.category, "connection");
  assert.equal(event.source, "buaa");
  assert.match(event.id, /^[a-f0-9-]{36}$/);
  assert.ok(!JSON.stringify(event).includes(SECRET));
  const unknown = createErrorEvent(secretError(), { operation: SECRET, source: "__proto__", method: SECRET });
  assert.equal(unknown.operation, "server.request");
  assert.ok(!Object.hasOwn(unknown, "source"));
  assert.ok(!Object.hasOwn(unknown, "method"));
  for (const [code, expected] of [["57014", "timeout"], ["28P01", "authentication"], ["CERT_HAS_EXPIRED", "certificate"], ["23505", "constraint"], ["mystery", "internal"]]) {
    assert.equal(errorCategory({ code }), expected);
  }
});

test("parallel error writes are complete, sanitized, and readable", async (t) => {
  const root = await temporary(t);
  const output = [];
  const events = await Promise.all(Array.from({ length: 30 }, () => reportError(secretError(), { operation: "jobs.export" }, { root, env: {}, log: (value) => output.push(value), now: new Date(NOW) })));
  assert.equal(new Set(events.map((event) => event.id)).size, 30);
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const stored = await readFile(join(root, files[0]), "utf8");
  assert.equal(stored.trim().split("\n").length, 30);
  assert.ok(!stored.includes(SECRET));
  assert.ok(!output.join().includes(SECRET));
  assert.equal((await readErrorEvents({ root })).length, 30);
  assert.equal((await readErrorEvents({ root, limit: 2 })).length, 2);
  await assert.rejects(readErrorEvents({ root, limit: 501 }));
});

test("logs rotate by date, retain 14 files, and preserve unrelated files", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "keep.txt"), SECRET);
  for (let day = 1; day <= 16; day++) {
    await reportError(new Error(), {}, { root, env: {}, log: () => {}, now: new Date(Date.UTC(2026, 8, day)) });
  }
  const names = await readdir(root);
  assert.equal(names.filter((name) => name.endsWith(".ndjson")).length, LOG_RETENTION);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), SECRET);
  assert.equal((await readErrorEvents({ root })).length, 14);
});

test("logs rotate before crossing the size cap and ignore oversized files", async (t) => {
  const root = await temporary(t);
  await reportError(new Error(), {}, { root, env: {}, log: () => {}, now: new Date(NOW) });
  const first = join(root, (await readdir(root))[0]);
  await writeFile(first, "x".repeat(MAX_LOG_BYTES));
  await reportError(new Error(), {}, { root, env: {}, log: () => {}, now: new Date(NOW + 1) });
  assert.equal((await readdir(root)).length, 2);
  await writeFile(first, "x".repeat(MAX_LOG_BYTES + 1));
  assert.equal((await readErrorEvents({ root })).length, 1);
  const second = (await readdir(root)).find((name) => join(root, name) !== first);
  assert.ok((await stat(join(root, second))).size <= MAX_LOG_BYTES);
});

test("reader ignores malformed records and removes injected secret fields", async (t) => {
  const root = await temporary(t);
  const event = await reportError(new Error(), {}, { root, env: {}, log: () => {}, now: new Date(NOW) });
  const path = join(root, (await readdir(root))[0]);
  await writeFile(path, `${JSON.stringify({ ...event, message: SECRET, headers: SECRET })}\nnot-json\n{"format":`);
  const read = await readErrorEvents({ root });
  assert.deepEqual(read, [event]);
  assert.ok(!JSON.stringify(read).includes(SECRET));
  assert.deepEqual(await readErrorEvents({ root: join(root, "missing") }), []);
});

test("Vercel writes only sanitized console records, and local logging failures do not throw", async (t) => {
  const root = await temporary(t);
  const output = [];
  await reportError(secretError(), {}, { root, env: { VERCEL: "1" }, log: (line) => output.push(line) });
  assert.deepEqual(await readdir(root), []);
  const blocked = join(root, "file");
  await writeFile(blocked, "file");
  const event = await reportError(secretError(), {}, { root: blocked, env: {}, log: (line) => output.push(line) });
  assert.ok(output.some((line) => line.includes("log-write-failed") && line.includes(event.id)));
  assert.ok(!output.join().includes(SECRET));
  await reportError(secretError(), {}, { root, env: { VERCEL: "1" }, log: () => { throw secretError(); } });
});

test("monitor rejects symlink log roots without writing through them", async (t) => {
  const root = await temporary(t);
  const target = join(root, "target");
  await mkdir(target);
  const { symlink } = await import("node:fs/promises");
  const alias = join(root, "alias");
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  const output = [];
  await reportError(new Error(), {}, { root: alias, env: {}, log: (line) => output.push(line) });
  assert.deepEqual(await readdir(target), []);
  assert.ok(output.some((line) => line.includes("log-write-failed")));
  await assert.rejects(readErrorEvents({ root: alias }));
});

test("source health checks missing, stale, future, and latest failed updates", () => {
  assert.ok(evaluateSources(freshRows(), NOW).every((source) => source.status === "ok"));
  const rows = freshRows();
  rows[0].last_success_at = new Date(NOW - 37 * 3600000).toISOString();
  rows[1].last_status = "failed";
  rows[2].last_success_at = new Date(NOW + 6 * 60000).toISOString();
  rows.pop();
  assert.deepEqual(evaluateSources(rows, NOW).map((source) => source.status), ["stale", "failed", "stale", "stale"]);
});

function healthFixture(overrides = {}) {
  const records = [];
  let closed = false;
  const db = { prepare: (sql) => ({ all: async () => freshRows(), get: async () => sql.includes("source_controls") ? undefined : ({ count: 4919 }) }) };
  return {
    records, closed: () => closed,
    options: { now: NOW, open: async () => db, close: () => { closed = true; }, latestBackup: async () => "fake.cjbackup", loadBackup: async () => ({ format: "campus-jobs-supabase-v2", tables: { source_controls: [] }, createdAt: new Date(NOW).toISOString() }), report: async (error, context) => { const event = createErrorEvent(error, context); records.push(event); return event; }, ...overrides },
  };
}

test("health verifies database, all sources, and backup while releasing database handles", async () => {
  const fixture = healthFixture();
  const result = await checkHealth(fixture.options);
  assert.equal(result.status, "ok");
  assert.equal(result.database, "ok");
  assert.equal(result.backup, "ok");
  assert.equal(result.sources.length, 4);
  assert.equal(fixture.closed(), true);
  assert.deepEqual(fixture.records, []);
});

test("database outage still checks backup and emits only sanitized records", async () => {
  const fixture = healthFixture({ open: async () => { throw secretError(); } });
  const result = await checkHealth(fixture.options);
  assert.equal(result.status, "degraded");
  assert.equal(result.database, "unavailable");
  assert.equal(result.backup, "ok");
  assert.equal(fixture.closed(), true);
  assert.equal(fixture.records[0].operation, "health.database");
  assert.ok(!JSON.stringify(fixture.records).includes(SECRET));
});

test("empty database and unreadable backups are detected", async () => {
  const fixture = healthFixture({ open: async () => ({ prepare: () => ({ all: () => freshRows(), get: () => ({ count: 0 }) }) }), loadBackup: async () => { throw secretError(); } });
  const result = await checkHealth(fixture.options);
  assert.equal(result.status, "degraded");
  assert.deepEqual(fixture.records.map((event) => event.operation), ["health.database", "health.backup"]);
});

test("stale backups and failed source updates make health degraded", async () => {
  const rows = freshRows();
  rows[1].last_status = "failed";
  const fixture = healthFixture({ open: async () => ({ prepare: () => ({ all: () => rows, get: () => ({ count: 4919 }) }) }), loadBackup: async () => ({ format: "campus-jobs-supabase-v2", tables: { source_controls: [] }, createdAt: new Date(NOW - 37 * 3600000).toISOString() }) });
  const result = await checkHealth(fixture.options);
  assert.equal(result.status, "degraded");
  assert.equal(result.backup, "stale");
  assert.equal(result.sources[1].status, "failed");
  assert.deepEqual(fixture.records.map((event) => event.operation), ["health.sources", "health.backup"]);
  assert.equal(fixture.records[0].source, "bit");
});

test("legacy backups without withdrawal history are incomplete even when fresh", async () => {
  const fixture = healthFixture({ loadBackup: async () => ({ format: "campus-jobs-supabase-v1", createdAt: new Date(NOW).toISOString() }) });
  const result = await checkHealth(fixture.options);
  assert.equal(result.backup, "incomplete");
  assert.equal(result.status, "degraded");
  assert.equal(fixture.records[0].operation, "health.backup");
});

function dailyFixture(overrides = {}) {
  const calls = [], records = [], output = [], notices = [];
  return {
    calls, records, output, notices,
    options: {
      env: { SUPABASE_DB_URL: SECRET, FEISHU_WEBHOOK_URL: SECRET },
      collect: async () => ({ results: [{ source: SOURCES.buaa.name, count: 1, newCount: 0 }], failures: [] }),
      backupLocal: async () => { calls.push("local"); return { destination: "test", retention: 14 }; },
      sync: async () => { calls.push("sync"); return { jobs: 1 }; },
      backupCloud: async () => { calls.push("cloud"); return { jobs: 1 }; },
      health: async () => { calls.push("health"); return { status: "ok" }; },
      report: async (error, context) => { const event = createErrorEvent(error, context); records.push(event); return event; },
      send: async (message) => notices.push(message), log: (message) => output.push(message), ...overrides,
    },
  };
}

test("daily success attempts local backup, sync, cloud backup, and health in order", async () => {
  const fixture = dailyFixture();
  assert.equal((await runDaily(fixture.options)).status, "ok");
  assert.deepEqual(fixture.calls, ["local", "sync", "cloud", "health"]);
  assert.equal(fixture.notices.length, 1);
});

test("all collectors failing still attempts cloud backup and health", async () => {
  const fixture = dailyFixture({ collect: async () => ({ results: [], failures: [{ id: "bit", error: secretError() }] }) });
  const result = await runDaily(fixture.options);
  assert.equal(result.status, "degraded");
  assert.deepEqual(fixture.calls, ["cloud", "health"]);
  assert.equal(fixture.records[0].source, "bit");
  assert.ok(!JSON.stringify([result, fixture.records, fixture.output, fixture.notices]).includes(SECRET));
});

test("unexpected collector exceptions do not skip cloud protection", async () => {
  const fixture = dailyFixture({ collect: async () => { throw secretError(); } });
  assert.equal((await runDaily(fixture.options)).status, "degraded");
  assert.deepEqual(fixture.calls, ["cloud", "health"]);
  assert.equal(fixture.records[0].operation, "daily.pipeline");
});

test("backup, sync, and notification failures are recorded without hiding later checks", async () => {
  const fixture = dailyFixture({ backupLocal: async () => { throw secretError(); }, sync: async () => { throw secretError(); }, backupCloud: async () => { throw secretError(); }, send: async () => { throw secretError(); } });
  const result = await runDaily(fixture.options);
  assert.equal(result.status, "degraded");
  assert.deepEqual(fixture.calls, ["health"]);
  assert.deepEqual(fixture.records.map((event) => event.operation), ["backup.local", "database.sync", "notification", "backup.cloud", "notification"]);
  assert.ok(!JSON.stringify([result, fixture.records, fixture.output]).includes(SECRET));
});

test("degraded health makes the daily result non-successful", async () => {
  const fixture = dailyFixture({ health: async () => ({ status: "degraded" }) });
  const result = await runDaily(fixture.options);
  assert.equal(result.status, "degraded");
  assert.equal(result.failures[0].operation, "health-check");
});

test("local-only daily runs do not attempt cloud operations", async () => {
  const fixture = dailyFixture({ env: {} });
  assert.equal((await runDaily(fixture.options)).status, "ok");
  assert.deepEqual(fixture.calls, ["local"]);
});

test("offsite upload follows the new encrypted backup and a failure does not hide health checks", async () => {
  const fixture = dailyFixture({
    env: { SUPABASE_DB_URL: SECRET, BAIDU_OFFSITE_ENABLED: "1" },
    backupCloud: async () => { fixture.calls.push("cloud"); return { destination: "new.cjbackup" }; },
    uploadOffsite: async (path) => { assert.equal(path, "new.cjbackup"); fixture.calls.push("offsite"); throw secretError(); },
  });
  const result = await runDaily(fixture.options);
  assert.equal(result.status, "degraded");
  assert.deepEqual(fixture.calls, ["local", "sync", "cloud", "offsite", "health"]);
  assert.deepEqual(fixture.records.map((event) => event.operation), ["backup.offsite"]);
  assert.ok(!JSON.stringify([result, fixture.records, fixture.output]).includes(SECRET));
});

test("offsite upload is not attempted when encrypted backup generation fails", async () => {
  const fixture = dailyFixture({
    env: { SUPABASE_DB_URL: SECRET, BAIDU_OFFSITE_ENABLED: "1" },
    backupCloud: async () => { throw secretError(); },
    uploadOffsite: async () => { fixture.calls.push("offsite"); },
  });
  const result = await runDaily(fixture.options);
  assert.equal(result.status, "degraded");
  assert.deepEqual(fixture.calls, ["local", "sync", "health"]);
  assert.deepEqual(fixture.records.map((event) => event.operation), ["backup.cloud", "backup.offsite"]);
});

test("enabled offsite backup without a cloud connection cannot silently succeed", async () => {
  const fixture = dailyFixture({ env: { BAIDU_OFFSITE_ENABLED: "1" } });
  const result = await runDaily(fixture.options);
  assert.equal(result.status, "degraded");
  assert.deepEqual(fixture.calls, ["local"]);
  assert.deepEqual(fixture.records.map((event) => event.operation), ["backup.offsite"]);
});

test("offsite remains disabled by default and uploads only when explicitly enabled", async () => {
  const fixture = dailyFixture({ uploadOffsite: async () => { throw new Error("Disabled upload was attempted"); } });
  assert.equal((await runDaily(fixture.options)).status, "ok");
  assert.deepEqual(fixture.calls, ["local", "sync", "cloud", "health"]);
});
