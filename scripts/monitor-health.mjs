import "./config.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openRuntimeDatabase, closeRuntimeDatabase, closeRuntimePool } from "./runtime-db.mjs";
import { SOURCES } from "./sources.mjs";
import { latestCloudBackup, readBackup } from "./supabase-backup.mjs";
import { reportError, readErrorEvents } from "./monitor.mjs";
import { notify } from "./notify.mjs";
import { sourceIsRestricted } from "./source-controls.mjs";

const MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function evaluateSources(rows, now = Date.now()) {
  return Object.entries(SOURCES).map(([id, source]) => {
    const row = rows.find((row) => row.source === source.name);
    const time = Date.parse(row?.last_success_at);
    const fresh = Number.isFinite(time) && time <= now + 5 * 60 * 1000 && now - time <= MAX_AGE_MS;
    return { id, status: !fresh ? "stale" : row.last_status === "failed" ? "failed" : "ok", lastSuccessAt: Number.isFinite(time) ? new Date(time).toISOString() : null };
  });
}

export async function checkHealth({ now = Date.now(), open = openRuntimeDatabase, close = closeRuntimeDatabase, latestBackup = latestCloudBackup, loadBackup = readBackup, report = reportError } = {}) {
  const result = { checkedAt: new Date(now).toISOString(), status: "ok", database: "unavailable", sources: [], backup: "unavailable" };
  let db;
  try {
    db = await open();
    const rows = await db.prepare("SELECT source,last_status,last_success_at FROM source_status").all();
    const count = await db.prepare("SELECT COUNT(*) AS count FROM jobs").get();
    if (!Number.isSafeInteger(count.count) || count.count < 1) throw new Error("Recruitment data unavailable");
    result.database = "ok";
    result.sources = evaluateSources(rows, now);
    for (const source of result.sources) if (await sourceIsRestricted(db, source.id)) source.status = "paused";
    for (const source of result.sources.filter((source) => !["ok", "paused"].includes(source.status))) {
      await report(new Error("Source requires attention"), { operation: "health.sources", source: source.id, category: source.status === "stale" ? "stale" : "internal", severity: "warning" });
    }
  } catch (error) { await report(error, { operation: "health.database" }); }
  finally { close(db); }
  try {
    const snapshot = await loadBackup(await latestBackup());
    const age = now - Date.parse(snapshot.createdAt);
    const coversControls = snapshot.format === "campus-jobs-supabase-v2" && Array.isArray(snapshot.tables?.source_controls);
    result.backup = !coversControls ? "incomplete" : age >= -5 * 60 * 1000 && age <= MAX_AGE_MS ? "ok" : "stale";
    if (result.backup !== "ok") await report(new Error("Backup requires attention"), { operation: "health.backup", category: result.backup === "stale" ? "stale" : "internal", severity: "warning" });
  } catch (error) { await report(error, { operation: "health.backup" }); }
  if (result.database !== "ok" || result.backup !== "ok" || result.sources.some((source) => !["ok", "paused"].includes(source.status))) result.status = "degraded";
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !["--errors", "--notify"].includes(args[0]))) throw new Error("Invalid monitor command");
    if (args[0] === "--errors") console.log(JSON.stringify(await readErrorEvents(), null, 2));
    else {
      const result = await checkHealth();
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "ok") {
        process.exitCode = 1;
        if (args[0] === "--notify") {
          if (!process.env.FEISHU_WEBHOOK_URL) console.log("Feishu delivery is not configured; no alert was sent.");
          else await notify("校招雷达健康检查异常，请在本机查看故障记录。数据库：" + result.database + "；备份：" + result.backup + "；异常高校：" + result.sources.filter((source) => !["ok", "paused"].includes(source.status)).map((source) => source.id).join("、"));
        }
      }
    }
  } catch (error) { await reportError(error, { operation: "daily.pipeline" }); process.exitCode = 1; }
  finally { await closeRuntimePool(); }
}
