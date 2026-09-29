import { collectBuaa } from "./collect-buaa.mjs";
import { notifyFailure } from "./notify.mjs";

const interval = Number(process.env.COLLECT_INTERVAL_MS || 60 * 60 * 1000);
let stopping = false;
let timer;
let wake;
function stop() { stopping = true; clearTimeout(timer); wake?.(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (!Number.isFinite(interval) || interval < 60000) throw new Error("定时间隔不得小于 60 秒");

async function run() {
  try { console.log(await collectBuaa()); } catch (error) {
    console.error("采集失败：", error?.stack || error);
    try { await notifyFailure(error); } catch (noticeError) { console.error("通知失败：", noticeError?.message || noticeError); }
  }
}

await run();
while (!stopping) {
  await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, interval); });
  if (!stopping) await run();
}
