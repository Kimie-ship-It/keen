export const SOURCES = Object.freeze({
  buaa: Object.freeze({
    id: "buaa",
    name: "北京航空航天大学",
    baseUrl: "https://career.buaa.edu.cn",
    officialHosts: Object.freeze(["career.buaa.edu.cn"]),
    collector: "buaa",
    tokenPath: "/f/ajaxHome/getToken",
    listPath: "/f/recruitmentinfo/ajax_frontRecruitinfoXzgg",
    pageSize: 100,
    maxPages: 100,
    pageDelayMs: 250,
  }),
  bit: Object.freeze({
    id: "bit",
    name: "北京理工大学",
    baseUrl: "https://job.bit.edu.cn",
    officialHosts: Object.freeze(["job.bit.edu.cn"]),
    collector: "bit",
    tokenPath: "/f/ajaxHome/getToken",
    listPath: "/f/recruitmentinfo/ajax_frontRecruitinfoXzgg",
    pageSize: 100,
    maxPages: 100,
    pageDelayMs: 250,
  }),
  bjtu: Object.freeze({
    id: "bjtu",
    name: "北京交通大学",
    baseUrl: "https://job.bjtu.edu.cn",
    officialHosts: Object.freeze(["job.bjtu.edu.cn"]),
    collector: "bjtu",
    tokenPath: "/f/ajaxHome/getToken",
    listPath: "/f/recruitmentinfo/ajax_frontRecruitinfo",
    pageSize: 100,
    maxPages: 100,
    pageDelayMs: 250,
  }),
  nankai: Object.freeze({
    id: "nankai",
    name: "南开大学",
    baseUrl: "https://career.nankai.edu.cn",
    officialHosts: Object.freeze(["career.nankai.edu.cn"]),
    collector: "nankai",
    listPath: "/correcruit/index.html",
    pageSize: 20,
    maxPages: 50,
    pageDelayMs: 250,
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
