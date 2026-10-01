import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "../scripts/db.mjs";
import { SOURCES } from "../scripts/sources.mjs";
import { createDedupeKey } from "../scripts/dedupe.mjs";
import { listJobs, getJobDetail, getSavedJobs } from "../scripts/jobs-service.mjs";
import { updateSourceControl, listSourceControls, sourceIsRestricted, validateSourceControl } from "../scripts/source-controls.mjs";
import { collectConfiguredSources } from "../scripts/collector-registry.mjs";
import { evaluateSources, checkHealth } from "../scripts/monitor-health.mjs";
import { publicContact } from "../scripts/privacy-config.mjs";
import { enrichLocations } from "../scripts/enrich-locations.mjs";

test("SQLite withdrawal suppresses list, detail, exports, dedupe, options and source history without deleting rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "campus-controls-"));
  const db = await openDatabase(join(root, "test.db"));
  const buaa = SOURCES.buaa.name, bit = SOURCES.bit.name;
  try {
    for (const [index, school] of [buaa, bit].entries()) {
      db.prepare("INSERT INTO jobs (source,source_id,company,title,first_seen_at,last_seen_at,dedupe_key,detail_url) VALUES (?,?,?,?,?,?,?,?)").run(school, "1", "公司", "校招", "2026-10-01", "2026-10-01", createDedupeKey({ company: "公司", title: "校招" }), `https://${index ? "job.bit.edu.cn" : "career.buaa.edu.cn"}/1`);
      db.prepare("INSERT INTO job_locations VALUES (?,?)").run(index + 1, index ? "上海" : "北京");
      db.prepare("INSERT INTO job_industries VALUES (?,?)").run(index + 1, index ? "金融" : "技术");
      db.prepare("INSERT INTO source_runs (source,started_at,finished_at,status) VALUES (?,?,?,?)").run(school, "2026-10-01", "2026-10-01", "success");
    }
    assert.equal((await listJobs(db)).jobs[0].sourceCount, 2);
    await updateSourceControl(db, { id: "bit", action: "restrict", reason: "privacy" });
    const data = await listJobs(db);
    assert.equal(data.stats.total, 1);
    assert.equal(data.jobs[0].sourceCount, 1);
    assert.deepEqual(data.jobs[0].sourceLinks.map((row) => row.source), [buaa]);
    assert.deepEqual(data.locations.map((row) => row.location), ["北京"]);
    assert.deepEqual(data.industries.map((row) => row.industry), ["技术"]);
    assert.ok(data.sources.every((row) => row.source !== bit));
    assert.ok(data.runs.every((row) => row.source !== bit));
    assert.equal((await listJobs(db, { source: bit })).matchCount, 0);
    await assert.rejects(listJobs(db, { city: "上海" }), /未知工作城市/);
    await assert.rejects(listJobs(db, { industry: "金融" }), /未知行业/);
    assert.equal(await getJobDetail(db, { source: bit, sourceId: "1" }), null);
    assert.deepEqual(await getSavedJobs(db, [`${bit}:1`]), []);
    assert.equal((await getJobDetail(db, { source: buaa, sourceId: "1" })).sourceCount, 1);
    db.prepare("UPDATE jobs SET review_status='hidden' WHERE source=?").run(bit);
    await updateSourceControl(db, { id: "bit", action: "restore", reason: "resolved" });
    assert.equal(await sourceIsRestricted(db, "bit"), false);
    assert.equal(await getJobDetail(db, { source: bit, sourceId: "1" }), null);
    assert.equal((await listSourceControls(db)).recent.length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2);
    db.exec("CREATE TRIGGER reject_control BEFORE INSERT ON source_controls BEGIN SELECT RAISE(ABORT,'fixture'); END");
    await assert.rejects(updateSourceControl(db, { id: "bit", action: "restrict", reason: "privacy" }), /fixture/);
    assert.equal(await sourceIsRestricted(db, "bit"), false);
  } finally { closeDatabase(db); await rm(root, { recursive: true, force: true }); }
});

test("collection skips withdrawn sources and fails closed when controls cannot be read", async () => {
  const called = [];
  const adapters = { buaa: async () => { called.push("buaa"); return { source: SOURCES.buaa.name, count: 1, newCount: 0, fetchedAt: new Date().toISOString() }; } };
  const skipped = await collectConfiguredSources({ ids: ["buaa"], allowed: async () => false }, adapters);
  assert.equal(skipped.skipped.length, 1);
  assert.equal(skipped.failures.length, 0);
  assert.deepEqual(called, []);
  const failed = await collectConfiguredSources({ ids: ["buaa"], allowed: async () => { throw new Error("offline"); } }, adapters);
  assert.equal(failed.failures.length, 1);
  assert.deepEqual(called, []);
});

test("invalid source controls and public contact configuration are rejected", () => {
  for (const input of [{}, { id: "unknown", action: "restrict", reason: "privacy" }, { id: "buaa", action: "delete", reason: "privacy" }, { id: "buaa", action: "restore", reason: "privacy" }, { id: "buaa", action: "restrict", reason: "resolved" }]) assert.throws(() => validateSourceControl(input));
  assert.equal(publicContact({}), null);
  assert.equal(publicContact({ PRIVACY_CONTACT_EMAIL: "public@example.com" }), "public@example.com");
  for (const email of ["bad", "public@example.com?body=secret", "public@example.com\nBcc:bad", "<script>@example.com"]) assert.throws(() => publicContact({ PRIVACY_CONTACT_EMAIL: email }));
});

test("location enrichment never fetches when withdrawn or policy is unreadable", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error("Unexpected request"); };
  assert.deepEqual(await enrichLocations({ ids: ["buaa"], allowed: async () => false, fetchImpl }), []);
  await assert.rejects(enrichLocations({ ids: ["buaa"], allowed: async () => { throw new Error("offline"); }, fetchImpl }), /offline/);
  assert.equal(requests, 0);
});

test("health marks deliberately withdrawn sources paused instead of raising stale alerts", async () => {
  const rows = Object.values(SOURCES).map((source) => ({ source: source.name, last_status: "success", last_success_at: new Date().toISOString() }));
  rows[0].last_success_at = "2000-01-01";
  assert.equal(evaluateSources(rows)[0].status, "stale");
  const db = { prepare: (sql) => ({ all: () => rows, get: (source) => sql.includes("source_controls") ? source === SOURCES.buaa.name ? { action: "restrict" } : undefined : { count: 1 } }) };
  const records = [];
  const result = await checkHealth({ open: async () => db, close: () => {}, latestBackup: async () => "fixture", loadBackup: async () => ({ format: "campus-jobs-supabase-v2", tables: { source_controls: [] }, createdAt: new Date().toISOString() }), report: async (error, context) => records.push(context) });
  assert.equal(result.status, "ok");
  assert.equal(result.sources[0].status, "paused");
  assert.deepEqual(records, []);
});
