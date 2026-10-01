import { isAuthorized, validateReviewInput } from "./reviews.mjs";

async function transaction(db, action) {
  await db.client.query("BEGIN");
  try {
    const result = await action(db.client);
    await db.client.query("COMMIT");
    return result;
  } catch (error) {
    try { await db.client.query("ROLLBACK"); } catch { db.failed = true; }
    throw error;
  }
}

export async function checkPostgresAuthorization(db, configured, supplied, now = Date.now()) {
  return transaction(db, async (client) => {
    // Serializes the singleton limiter, including when no row exists yet.
    await client.query("SELECT pg_advisory_xact_lock(72461001)");
    if (isAuthorized(configured, supplied)) {
      await client.query("DELETE FROM admin_auth_limits WHERE id=1");
      return { authorized: true, status: 200 };
    }
    const { rows } = await client.query("SELECT window_started_at, failures FROM admin_auth_limits WHERE id=1");
    const current = rows[0];
    const active = current && now >= Number(current.window_started_at) && now - Number(current.window_started_at) < 900000;
    const startedAt = active ? Number(current.window_started_at) : now;
    const failures = (active ? current.failures : 0) + 1;
    await client.query("INSERT INTO admin_auth_limits (id, window_started_at, failures) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET window_started_at=EXCLUDED.window_started_at, failures=EXCLUDED.failures", [startedAt, failures]);
    return failures >= 5
      ? { authorized: false, status: 429, retryAfter: Math.ceil((900000 - (now - startedAt)) / 1000) }
      : { authorized: false, status: 401 };
  });
}

export async function listPostgresReviews(db, { limit = 100, offset = 0 } = {}) {
  const client = db.client;
  const jobs = (await client.query('SELECT source, source_id AS "sourceId", company, title, review_status AS "reviewStatus" FROM jobs WHERE review_status=\'pending\' ORDER BY first_seen_at DESC, id DESC LIMIT $1 OFFSET $2', [limit, offset])).rows;
  const pendingCount = Number((await client.query("SELECT COUNT(*) AS total FROM jobs WHERE review_status='pending'")).rows[0].total);
  const counts = (await client.query("SELECT review_status AS status, COUNT(*) AS count FROM jobs GROUP BY review_status ORDER BY review_status")).rows.map((row) => ({ ...row, count: Number(row.count) }));
  const recentReviews = (await client.query('SELECT source, source_id AS "sourceId", old_status AS "oldStatus", new_status AS "newStatus", actor, created_at AS "createdAt" FROM review_events ORDER BY id DESC LIMIT 20')).rows;
  return { jobs, counts, pendingCount, limit, offset, hasMore: offset + jobs.length < pendingCount, recentReviews };
}

export async function updatePostgresReview(db, input) {
  const { source, sourceId, status } = validateReviewInput(input);
  return transaction(db, async (client) => {
    const { rows } = await client.query("SELECT review_status FROM jobs WHERE source=$1 AND source_id=$2 FOR UPDATE", [source, sourceId]);
    if (!rows.length) return 0;
    await client.query("UPDATE jobs SET review_status=$1 WHERE source=$2 AND source_id=$3", [status, source, sourceId]);
    await client.query("INSERT INTO review_events (source, source_id, old_status, new_status, actor, created_at) VALUES ($1,$2,$3,$4,'admin',$5)", [source, sourceId, rows[0].review_status, status, new Date().toISOString()]);
    return 1;
  });
}
