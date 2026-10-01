import "./config.mjs";
import { collectConfiguredSources } from "./collector-registry.mjs";
import { notify, notifyFailure } from "./notify.mjs";
import { createRuntimeBackup } from "./runtime-backup.mjs";
import { syncLocalToSupabase } from "./supabase-sync.mjs";

const summary = await collectConfiguredSources();
for (const result of summary.results) console.log(JSON.stringify(result));
for (const failure of summary.failures) console.error(`${failure.source}采集失败：`, failure.error.message);

if (summary.results.length) {
  try {
    const backup = await createRuntimeBackup();
    console.log(JSON.stringify({ backup: backup.destination, retention: backup.retention }));
  } catch (error) {
    console.error("采集成功，但数据库备份失败：", error.message);
    process.exitCode = 1;
    try { await notifyFailure(new Error(`数据库备份失败：${error.message}`)); }
    catch (noticeError) { console.error("备份故障通知失败：", noticeError.message); }
  }
  if (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL) {
    try { console.log(JSON.stringify({ supabaseSync: await syncLocalToSupabase() })); }
    catch (error) { console.error("本地采集成功，但 Supabase 同步失败：", error.message); process.exitCode = 1; }
  }
  const message = summary.results.map((result) => `${result.source}采集 ${result.count} 条，新增 ${result.newCount} 条`).join("；");
  try { await notify(`校招雷达日报：${message}。`); }
  catch (error) { console.error("采集成功，但通知失败：", error.message); }
}
if (summary.failures.length) {
  const error = new Error(summary.failures.map((failure) => `${failure.source}：${failure.error.message}`).join("；"));
  try { await notifyFailure(error); } catch (noticeError) { console.error("通知失败：", noticeError.message); }
  process.exitCode = 1;
}
