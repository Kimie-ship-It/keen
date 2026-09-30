const LABEL_RE = /(?:工作地点|工作地|工作城市|工作地域|工作区域|工作地址|勤務地)\s*[：:：]?\s*([\s\S]{0,2000}?)(?=(?:工作内容|招聘岗位|岗位职责|职位描述|任职要求|岗位要求|专业要求|技能要求|招聘流程|投递方式|联系方式|福利待遇|发布时间|浏览量)\s*[：:：]?|$)/gi;

function clean(value) {
  return String(value || "").replace(/[\u00a0\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeLocation(value) {
  const text = clean(value).replace(/[、，,；;|/\\]+$/g, "").trim();
  if (!text) return "";
  if (text === "全国" || text.includes("全国多地") || text.includes("全国各地") || text.includes("全国范围")) return "全国";
  return text
    .replace(/特别行政区$/, "")
    .replace(/自治区$/, "")
    .replace(/省$/, "")
    .replace(/市$/, "")
    .replace(/壮族自治区$/, "")
    .replace(/回族自治区$/, "")
    .replace(/维吾尔自治区$/, "")
    .trim();
}

function referenceAliases(reference) {
  return [...new Set((reference || []).flatMap((item) => {
    const raw = clean(typeof item === "string" ? item : item.name);
    const normalized = normalizeLocation(raw);
    return [raw, normalized].filter((value) => value && value.length >= 2);
  }))].sort((a, b) => b.length - a.length);
}

function collectFromText(text, aliases, locations) {
  const value = clean(text);
  if (!value) return;
  if (/全国(?:多地|各地|范围|主要城市|100多个)/.test(value)) locations.add("全国");
  for (const alias of aliases) {
    if (value.includes(alias)) locations.add(normalizeLocation(alias));
  }
}

export function extractLocations({ content = "", structured = [], reference = [] } = {}) {
  const aliases = referenceAliases(reference);
  const locations = new Set();
  for (const item of structured || []) collectFromText(item, aliases, locations);
  const text = clean(content);
  let match;
  while ((match = LABEL_RE.exec(text))) collectFromText(match[1], aliases, locations);
  LABEL_RE.lastIndex = 0;
  return [...locations].filter(Boolean).slice(0, 40);
}

export function extractNankaiLocations(html, reference = []) {
  const text = clean(html).replace(/<[^>]+>/g, " ");
  return extractLocations({ content: text, reference });
}
