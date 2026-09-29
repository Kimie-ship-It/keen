import { createHash, timingSafeEqual } from "node:crypto";

export function isAuthorized(configured, supplied) {
  if (!configured || !supplied || configured.length < 24) return false;
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expected, actual);
}

export function readBearerToken(header = "") {
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;

export function checkAdminAuthorization(db, configured, supplied, now = Date.now()) {
  return db.transaction(() => {
    if (isAuthorized(configured, supplied)) {
      db.prepare("DELETE FROM admin_auth_limits WHERE id=1").run();
      return { authorized: true, status: 200 };
    }
    const current = db.prepare("SELECT window_started_at AS startedAt, failures FROM admin_auth_limits WHERE id=1").get();
    const active = current && now >= current.startedAt && now - current.startedAt < AUTH_WINDOW_MS;
    const startedAt = active ? current.startedAt : now;
    const failures = (active ? current.failures : 0) + 1;
    db.prepare("INSERT INTO admin_auth_limits (id, window_started_at, failures) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET window_started_at=excluded.window_started_at, failures=excluded.failures")
      .run(startedAt, failures);
    return failures >= AUTH_MAX_FAILURES
      ? { authorized: false, status: 429, retryAfter: Math.ceil((AUTH_WINDOW_MS - (now - startedAt)) / 1000) }
      : { authorized: false, status: 401 };
  })();
}

export function listPendingReviews(db, { limit = 100, offset = 0 } = {}) {
  const jobs = db.prepare("SELECT source, source_id AS sourceId, company, title, review_status AS reviewStatus FROM jobs WHERE review_status='pending' ORDER BY first_seen_at DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset);
  const pendingCount = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE review_status='pending'").get().total;
  const counts = db.prepare("SELECT review_status AS status, COUNT(*) AS count FROM jobs GROUP BY review_status ORDER BY review_status").all();
  const recentReviews = db.prepare("SELECT source, source_id AS sourceId, old_status AS oldStatus, new_status AS newStatus, actor, created_at AS createdAt FROM review_events ORDER BY id DESC LIMIT 20").all();
  return { jobs, counts, pendingCount, limit, offset, hasMore: offset + jobs.length < pendingCount, recentReviews };
}

export function validateReviewInput(input) {
  if (!input || typeof input.source !== "string" || typeof input.sourceId !== "string" || !["pending", "approved", "hidden"].includes(input.status)) {
    throw new Error("无效审核操作");
  }
  return { source: input.source, sourceId: input.sourceId, status: input.status };
}

export function updateReview(db, input) {
  const { source, sourceId, status } = validateReviewInput(input);
  return db.transaction(() => {
    const current = db.prepare("SELECT review_status AS status FROM jobs WHERE source=? AND source_id=?").get(source, sourceId);
    if (!current) return 0;
    db.prepare("UPDATE jobs SET review_status=? WHERE source=? AND source_id=?").run(status, source, sourceId);
    db.prepare("INSERT INTO review_events (source, source_id, old_status, new_status, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(source, sourceId, current.status, status, "admin", new Date().toISOString());
    return 1;
  })();
}
