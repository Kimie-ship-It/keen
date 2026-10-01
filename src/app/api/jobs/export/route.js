import { NextResponse } from "next/server";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../../../../../scripts/runtime-db.mjs";
import { getSavedJobs } from "../../../../../scripts/jobs-service.mjs";

export const dynamic = "force-dynamic";

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

export async function GET(request) {
  const raw = new URL(request.url).searchParams.get("ids") || "";
  const keys = raw.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length > 500) return NextResponse.json({ error: "一次最多导出 500 条收藏" }, { status: 400 });
  let db;
  try {
    db = await openRuntimeDatabase();
    const jobs = (await getSavedJobs(db, keys));
    const header = ["收藏键", "公司", "招聘标题", "来源高校", "工作地点", "行业", "发布时间", "截止日期", "招聘人数", "审核状态", "官方公告"];
    const rows = jobs.map((job) => csvRow([
      job.savedKey,
      job.company,
      job.title,
      job.source,
      job.locations.join("；") || "未注明",
      job.industries.join("；") || "未分类",
      job.publishedAt || "未注明",
      job.deadline?.slice(0, 10) || "未注明",
      job.recruitingNumbers || "见官方公告",
      job.reviewStatus === "approved" ? "已人工核验" : "待人工核验",
      job.sourceLinks.map((link) => link.detailUrl).join("；"),
    ]));
    const csv = `\uFEFF${csvRow(header)}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="campus-jobs-saved-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "收藏导出暂时不可用，请稍后重试" }, { status: 503 });
  } finally {
    closeRuntimeDatabase(db);
  }
}
