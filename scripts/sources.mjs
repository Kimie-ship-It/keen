export const SOURCES = Object.freeze({
  buaa: Object.freeze({
    id: "buaa",
    name: "北京航空航天大学",
    baseUrl: "https://career.buaa.edu.cn",
    officialHosts: Object.freeze(["career.buaa.edu.cn"]),
    collector: "buaa",
  }),
});

const SOURCES_BY_NAME = new Map(Object.values(SOURCES).map((source) => [source.name, source]));

export function getSource(id) {
  if (!Object.hasOwn(SOURCES, id)) throw new Error(`未知高校来源：${id}`);
  return SOURCES[id];
}

export function officialUrl(sourceId, value) {
  const source = getSource(sourceId);
  let url;
  try { url = new URL(String(value), source.baseUrl); }
  catch { return ""; }
  if (!["https:", "http:"].includes(url.protocol)
    || !source.officialHosts.includes(url.hostname.toLowerCase())
    || url.username || url.password || url.port) return "";
  url.protocol = "https:";
  url.pathname = "/" + url.pathname.replace(/^\/+/, "");
  return url.href;
}

export function officialUrlForSourceName(sourceName, value) {
  const source = SOURCES_BY_NAME.get(sourceName);
  return source ? officialUrl(source.id, value) : "";
}
