import { collectConfiguredSources } from "./collector-registry.mjs";
import { notify } from "./notify.mjs";
import { reportError } from "./monitor.mjs";

const interval = Number(process.env.COLLECT_INTERVAL_MS || 60 * 60 * 1000);
let stopping = false;
let timer;
let wake;
function stop() { stopping = true; clearTimeout(timer); wake?.(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (!Number.isFinite(interval) || interval < 60000) throw new Error("定时间隔不得小于 60 秒");

async function run() {
  try {
    const summary = await collectConfiguredSources();
    for (const result of summary.results) console.log(result);
    const ids = [];
    for (const failure of summary.failures) {
      const event = await reportError(failure.error, { operation: "collection", source: failure.id });
      ids.push(event.id);
    }
    if (ids.length && process.env.FEISHU_WEBHOOK_URL) {
      try { await notify("校招雷达采集异常，请查看故障记录：" + ids.join("；")); }
      catch (error) { await reportError(error, { operation: "notification" }); }
    }
  } catch (error) {
    await reportError(error, { operation: "daily.pipeline" });
  }
}

await run();
while (!stopping) {
  await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, interval); });
  if (!stopping) await run();
}
