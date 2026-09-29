import "./config.mjs";
import { collectBuaa } from "./collect-buaa.mjs";
import { notify, notifyFailure } from "./notify.mjs";

try {
  const result = await collectBuaa();
  console.log(JSON.stringify(result));
  try { await notify("校招雷达日报：北航采集 " + result.count + " 条，本次新增 " + result.newCount + " 条。"); }
  catch (error) { console.error("采集成功，但通知失败：", error.message); }
} catch (error) {
  console.error("采集失败：", error.message);
  try { await notifyFailure(error); } catch (noticeError) { console.error("通知失败：", noticeError.message); }
  process.exitCode = 1;
}
