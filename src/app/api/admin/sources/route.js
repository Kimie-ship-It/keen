import { NextResponse } from "next/server";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../../../../../scripts/runtime-db.mjs";
import { checkAdminAuthorization, readBearerToken } from "../../../../../scripts/runtime-reviews.mjs";
import { listSourceControls, updateSourceControl, validateSourceControl } from "../../../../../scripts/source-controls.mjs";
import { reportError } from "../../../../../scripts/monitor.mjs";

export const dynamic = "force-dynamic";

async function handle(request) {
  let db;
  try {
    db = await openRuntimeDatabase();
    const auth = await checkAdminAuthorization(db, process.env.ADMIN_TOKEN, readBearerToken(request.headers.get("authorization") || ""));
    if (!auth.authorized) return NextResponse.json({ error: auth.status === 429 ? "口令连续输入错误，请稍后重试" : "未授权或未配置管理口令" }, { status: auth.status, headers: auth.retryAfter ? { "Retry-After": String(auth.retryAfter) } : {} });
    if (request.method === "POST") {
      let input;
      try { input = validateSourceControl(await request.json()); }
      catch { return NextResponse.json({ error: "无效来源、操作或原因" }, { status: 400 }); }
      await updateSourceControl(db, input);
    }
    return NextResponse.json(await listSourceControls(db), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const event = await reportError(error, { operation: request.method === "POST" ? "sources.write" : "sources.read", method: request.method });
    return NextResponse.json({ error: "来源管理暂时不可用，请稍后重试" }, { status: 503, headers: { "X-Error-Id": event.id } });
  } finally { closeRuntimeDatabase(db); }
}

export const GET = handle;
export const POST = handle;
