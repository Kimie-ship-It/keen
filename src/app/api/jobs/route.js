import { NextResponse } from "next/server";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../../../../scripts/runtime-db.mjs";
import { parsePagination } from "../../../../scripts/query.mjs";
import { listJobs, QueryValidationError } from "../../../../scripts/jobs-service.mjs";
import { reportError } from "../../../../scripts/monitor.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q")?.trim() || "").slice(0, 200);
  const source = (url.searchParams.get("source")?.trim() || "").slice(0, 100);
  const city = (url.searchParams.get("city")?.trim() || "").slice(0, 100);
  const industry = (url.searchParams.get("industry")?.trim() || "").slice(0, 100);
  const deadline = (url.searchParams.get("deadline")?.trim() || "").slice(0, 20);
  let pagination;
  try { pagination = parsePagination(url.searchParams); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const { limit, offset } = pagination;
  let db;
  try {
    db = await openRuntimeDatabase();
    return NextResponse.json((await listJobs(db, { q, source, city, industry, deadline, limit, offset })));
  } catch (error) {
    if (error instanceof QueryValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    const event = await reportError(error, { operation: "jobs.list", method: "GET" });
    return NextResponse.json({ error: "招聘数据暂时无法读取，请稍后重试" }, { status: 503, headers: { "X-Error-Id": event.id } });
  } finally {
    closeRuntimeDatabase(db);
  }
}
