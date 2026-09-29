import { NextResponse } from "next/server";
import { openDatabase, closeDatabase } from "../../../../../scripts/db.mjs";
import { isAuthorized, listPendingReviews, readBearerToken, updateReview, validateReviewInput } from "../../../../../scripts/reviews.mjs";
import { parsePagination } from "../../../../../scripts/query.mjs";

export const dynamic = "force-dynamic";

function authorized(request) {
  return isAuthorized(process.env.ADMIN_TOKEN, readBearerToken(request.headers.get("authorization") || ""));
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "未授权或未配置管理口令" }, { status: 401 });
  let pagination;
  try { pagination = parsePagination(new URL(request.url).searchParams); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const db = await openDatabase();
  try {
    return NextResponse.json(listPendingReviews(db, pagination));
  } finally { closeDatabase(db); }
}

export async function POST(request) {
  if (!authorized(request)) return NextResponse.json({ error: "未授权或未配置管理口令" }, { status: 401 });
  let input;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "无效请求" }, { status: 400 }); }
  try { validateReviewInput(input); } catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const db = await openDatabase();
  try {
    if (!updateReview(db, input)) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } finally { closeDatabase(db); }
}
