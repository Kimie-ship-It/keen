export function parsePagination(params) {
  const rawLimit = params.get("limit") ?? "100";
  const rawOffset = params.get("offset") ?? "0";
  if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) throw new Error("分页参数必须是非负整数");
  return { limit: Math.min(Math.max(Number(rawLimit), 1), 500), offset: Math.min(Number(rawOffset), 100000) };
}
