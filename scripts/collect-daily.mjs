import "./config.mjs";
import { collectConfiguredSources } from "./collector-registry.mjs";
import { notify } from "./notify.mjs";
import { createRuntimeBackup } from "./runtime-backup.mjs";
import { syncLocalToSupabase } from "./supabase-sync.mjs";
import { createCloudBackup } from "./supabase-backup.mjs";
import { uploadEncryptedBackup } from "./offsite-backup.mjs";
import { reportError } from "./monitor.mjs";
import { checkHealth } from "./monitor-health.mjs";
import { closeRuntimePool } from "./runtime-db.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runDaily({ collect = collectConfiguredSources, backupLocal = createRuntimeBackup, sync = syncLocalToSupabase, backupCloud = createCloudBackup, uploadOffsite = uploadEncryptedBackup, report = reportError, health = checkHealth, send = notify, log = console.log, env = process.env } = {}) {
  const failures = [];
  const record = async (error, operation, source) => {
    const event = await report(error, { operation, source });
    failures.push({ operation, id: event.id });
  };
  let summary = { results: [], failures: [] };
  try { summary = await collect(); }
  catch (error) { await record(error, "daily.pipeline"); }
  for (const result of summary.results) log(JSON.stringify(result));
  for (const skipped of summary.skipped || []) log(JSON.stringify({ collectionSkipped: skipped }));
  for (const failure of summary.failures) await record(failure.error, "collection", failure.id);

  const cloud = Boolean(env.SUPABASE_DB_URL || env.DATABASE_URL);
  if (env.BAIDU_OFFSITE_ENABLED === "1" && !cloud) await record(new Error("A cloud database connection is required for offsite backup"), "backup.offsite");
  if (summary.results.length) {
    try { const backup = await backupLocal(); log(JSON.stringify({ backup: backup.destination, retention: backup.retention })); }
    catch (error) { await record(error, "backup.local"); }
    if (cloud) {
      try { log(JSON.stringify({ supabaseSync: await sync() })); }
      catch (error) { await record(error, "database.sync"); }
    }
    const message = summary.results.map((result) => `${result.source}采集 ${result.count} 条，新增 ${result.newCount} 条`).join("；");
    try { await send(`校招雷达日报：${message}。`); }
    catch (error) { await record(error, "notification"); }
  }
  // Cloud review changes must be protected even if every collector fails.
  if (cloud) {
    let backup;
    try { backup = await backupCloud(); log(JSON.stringify({ supabaseBackup: backup })); }
    catch (error) { await record(error, "backup.cloud"); }
    if (env.BAIDU_OFFSITE_ENABLED === "1") {
      if (backup?.destination) {
        try { log(JSON.stringify({ offsiteBackup: await uploadOffsite(backup.destination) })); }
        catch (error) { await record(error, "backup.offsite"); }
      } else await record(new Error("A valid cloud backup is required for offsite upload"), "backup.offsite");
    }
    try {
      const result = await health();
      log(JSON.stringify({ health: result }));
      if (result.status !== "ok") failures.push({ operation: "health-check", id: "see-health-records" });
    } catch (error) { await record(error, "daily.pipeline"); }
  }
  if (failures.length && env.FEISHU_WEBHOOK_URL) {
    try { await send("校招雷达流程异常，请查看故障记录：" + failures.map((failure) => `${failure.operation}（${failure.id}）`).join("；")); }
    catch (error) { await record(error, "notification"); }
  }
  return { status: failures.length ? "degraded" : "ok", failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runDaily(); console.log(JSON.stringify({ dailyStatus: result })); if (result.status !== "ok") process.exitCode = 1; }
  catch (error) { await reportError(error, { operation: "daily.pipeline" }); process.exitCode = 1; }
  finally { await closeRuntimePool(); }
}
