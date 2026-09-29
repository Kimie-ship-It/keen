import { NextResponse } from "next/server";
import { openDatabase, closeDatabase } from "../../../../../scripts/db.mjs";
import { checkAdminAuthorization, listPendingReviews, readBearerToken, updateReview, validateReviewInput } from "../../../../../scripts/reviews.mjs";
import { parsePagination } from "../../../../../scripts/query.mjs";

export const dynamic = "force-dynamic";

function accessDenied(auth) {
  return NextResponse.json({ error: auth.status === 429 ? "口令连续输入错误，请稍后重试" : "未授权或未配置管理口令" }, {
    status: auth.status,
    headers: auth.retryAfter ? { "Retry-After": String(auth.retryAfter) } : {},
  });
}

export async function GET(request) {
  const db = await openDatabase();
  try {
    const auth = checkAdminAuthorization(db, process.env.ADMIN_TOKEN, readBearerToken(request.headers.get("authorization") || ""));
    if (!auth.authorized) return accessDenied(auth);
    let pagination;
    try { pagination = parsePagination(new URL(request.url).searchParams); }
    catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
    return NextResponse.json(listPendingReviews(db, pagination));
  } finally { closeDatabase(db); }
}

export async function POST(request) {
  const db = await openDatabase();
  try {
    const auth = checkAdminAuthorization(db, process.env.ADMIN_TOKEN, readBearerToken(request.headers.get("authorization") || ""));
    if (!auth.authorized) return accessDenied(auth);
    let input;
    try { input = await request.json(); } catch { return NextResponse.json({ error: "无效请求" }, { status: 400 }); }
    try { validateReviewInput(input); } catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
    if (!updateReview(db, input)) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } finally { closeDatabase(db); }
}
