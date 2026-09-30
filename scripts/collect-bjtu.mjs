import "./config.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPlatformSource } from "./collect-platform.mjs";

export function collectBjtu(options = {}) {
  return collectPlatformSource("bjtu", options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await collectBjtu();
  console.log(`已采集${result.source}招聘信息 ${result.count} 条，新增 ${result.newCount} 条`);
}
