import { NextResponse } from "next/server";
import { openDatabase, closeDatabase } from "../../../../scripts/db.mjs";
import { parsePagination } from "../../../../scripts/query.mjs";
import { listJobs } from "../../../../scripts/jobs-service.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q")?.trim() || "").slice(0, 200);
  let pagination;
  try { pagination = parsePagination(url.searchParams); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const { limit, offset } = pagination;
  const db = await openDatabase();
  try {
    return NextResponse.json(listJobs(db, { q, limit, offset }));
  } finally {
    closeDatabase(db);
  }
}
