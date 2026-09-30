import { collectBuaa } from "./collect-buaa.mjs";
import { collectBit } from "./collect-bit.mjs";
import { getSource, SOURCES } from "./sources.mjs";

const collectors = Object.freeze({ buaa: collectBuaa, bit: collectBit });

export async function collectSource(id, options = {}, adapters = collectors) {
  const source = getSource(id);
  const collector = adapters[source.collector];
  if (typeof collector !== "function") throw new Error(`高校来源缺少采集器：${id}`);
  const result = await collector(options);
  if (result?.source !== source.name || !Number.isSafeInteger(result.count) || result.count < 0 ||
    !Number.isSafeInteger(result.newCount) || result.newCount < 0 || result.newCount > result.count ||
    !Number.isFinite(Date.parse(result.fetchedAt))) throw new Error(`采集器返回格式异常：${id}`);
  return result;
}

export async function collectConfiguredSources({ ids = Object.keys(SOURCES), optionsById = {} } = {}, adapters = collectors) {
  const results = [];
  const failures = [];
  for (const id of ids) {
    try { results.push(await collectSource(id, optionsById[id] || {}, adapters)); }
    catch (error) { failures.push({ id, source: getSource(id).name, error }); }
  }
  return { results, failures };
}
