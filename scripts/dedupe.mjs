import { createHash } from "node:crypto";

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

export function createDedupeKey({ company, title, source, sourceId }) {
  const normalizedCompany = normalize(company);
  const normalizedTitle = normalize(title);
  const exactCampaign = normalizedCompany && normalizedTitle;
  const input = exactCampaign
    ? `campaign\0${normalizedCompany}\0${normalizedTitle}`
    : `record\0${String(source || "")}\0${String(sourceId || "")}`;
  return `${exactCampaign ? "campaign" : "record"}:v1:${createHash("sha256").update(input).digest("hex")}`;
}
