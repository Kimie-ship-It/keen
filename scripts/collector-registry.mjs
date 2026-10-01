import { collectBuaa } from "./collect-buaa.mjs";
import { collectBit } from "./collect-bit.mjs";
import { collectBjtu } from "./collect-bjtu.mjs";
import { collectNankai } from "./collect-nankai.mjs";
import { getSource, SOURCES } from "./sources.mjs";
import { assertCollectionAllowed, collectionAllowed } from "./source-controls.mjs";

const collectors = Object.freeze({ buaa: collectBuaa, bit: collectBit, bjtu: collectBjtu, nankai: collectNankai });

export async function collectSource(id, options = {}, adapters = collectors) {
  const source = getSource(id);
  if (adapters === collectors) await assertCollectionAllowed(id);
  const collector = adapters[source.collector];
  if (typeof collector !== "function") throw new Error(`高校来源缺少采集器：${id}`);
  const result = await collector(options);
  if (result?.source !== source.name || !Number.isSafeInteger(result.count) || result.count < 0 ||
    !Number.isSafeInteger(result.newCount) || result.newCount < 0 || result.newCount > result.count ||
    !Number.isFinite(Date.parse(result.fetchedAt))) throw new Error(`采集器返回格式异常：${id}`);
  return result;
}

export async function collectConfiguredSources({ ids = Object.keys(SOURCES), optionsById = {}, allowed } = {}, adapters = collectors) {
  const policy = allowed || (adapters === collectors ? collectionAllowed : async () => true);
  const results = [];
  const failures = [];
  const skipped = [];
  for (const id of ids) {
    try {
      if (!(await policy(id))) { skipped.push({ id, source: getSource(id).name, reason: "withdrawn" }); continue; }
      results.push(await collectSource(id, optionsById[id] || {}, adapters));
    }
    catch (error) { failures.push({ id, source: getSource(id).name, error }); }
  }
  return { results, failures, skipped };
}
