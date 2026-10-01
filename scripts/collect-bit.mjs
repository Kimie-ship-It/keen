import "./config.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPlatformSource } from "./collect-platform.mjs";

export function collectBit(options = {}) {
  return collectPlatformSource("bit", options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await collectBit();
    console.log(`已采集${result.source}招聘信息 ${result.count} 条，新增 ${result.newCount} 条`);
  } catch (error) {
    const { reportError } = await import("./monitor.mjs");
    await reportError(error, { operation: "collection", source: "bit" });
    process.exitCode = 1;
  }
}
