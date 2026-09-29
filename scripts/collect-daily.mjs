import "./config.mjs";
import { collectSource } from "./collector-registry.mjs";
import { notify, notifyFailure } from "./notify.mjs";
import { createRuntimeBackup } from "./runtime-backup.mjs";

try {
  const result = await collectSource("buaa");
  console.log(JSON.stringify(result));
  try {
    const backup = await createRuntimeBackup();
    console.log(JSON.stringify({ backup: backup.destination, retention: backup.retention }));
  } catch (error) {
    console.error("采集成功，但数据库备份失败：", error.message);
    process.exitCode = 1;
    try { await notifyFailure(new Error(`数据库备份失败：${error.message}`)); }
    catch (noticeError) { console.error("备份故障通知失败：", noticeError.message); }
  }
  try { await notify("校招雷达日报：" + result.source + "采集 " + result.count + " 条，本次新增 " + result.newCount + " 条。"); }
  catch (error) { console.error("采集成功，但通知失败：", error.message); }
} catch (error) {
  console.error("采集失败：", error.message);
  try { await notifyFailure(error); } catch (noticeError) { console.error("通知失败：", noticeError.message); }
  process.exitCode = 1;
}
