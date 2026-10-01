import "../scripts/config.mjs";
import assert from "node:assert/strict";
import { openRuntimeDatabase, closeRuntimeDatabase, closeRuntimePool, storageMode } from "../scripts/runtime-db.mjs";
import { getSavedJobs } from "../scripts/jobs-service.mjs";

const base = process.env.CAMPUS_TEST_URL || "http://localhost:3002";
const headers = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
async function request(path, options) {
  return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(90000) });
}

if (process.argv.includes("--outage")) {
  const ids = new Set();
  for (const [path, method] of [["/api/jobs", "GET"], ["/api/jobs/export?ids=test", "GET"], ["/api/admin/reviews", "GET"], ["/api/admin/reviews", "POST"]]) {
    const response = await request(path, { headers, method });
    assert.equal(response.status, 503);
    const id = response.headers.get("x-error-id");
    assert.match(id, /^[a-f0-9-]{36}$/);
    ids.add(id);
    const body = await response.text();
    for (const secret of [process.env.SUPABASE_DB_URL, process.env.ADMIN_TOKEN]) {
      if (secret) assert.ok(!body.includes(secret));
    }
    assert.ok(!/postgresql|127\.0\.0\.1|ECONNREFUSED/i.test(body));
  }
  assert.equal(ids.size, 4);
  console.log(JSON.stringify({ outageChecks: "passed", errorIds: [...ids], requests: 4 }));
} else {
  assert.equal(storageMode(), "supabase");
  const response = await request("/api/jobs?limit=5");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.sources.length, 4);
  assert.ok(data.jobs.length > 0);
  const sample = data.jobs[0];
  const key = `${sample.source}:${sample.sourceId}`;
  for (const query of ["source=invalid", "deadline=invalid", "offset=-1", "city=invalid", "industry=invalid"]) {
    assert.equal((await request(`/api/jobs?${query}`)).status, 400);
  }
  const filters = new URLSearchParams({ source: sample.source, city: sample.locations[0] || "", q: sample.company, deadline: "open", limit: "5" });
  const filtered = await request(`/api/jobs?${filters}`);
  assert.equal(filtered.status, 200);
  const results = await filtered.json();
  assert.ok(results.jobs.every((job) => job.source === sample.source));
  const page = await request(`/jobs/${encodeURIComponent(sample.source)}/${encodeURIComponent(sample.sourceId)}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(sample.company));
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/admin")).status, 200);
  const exported = await request(`/api/jobs/export?${new URLSearchParams({ ids: key })}`);
  assert.equal(exported.status, 200);
  assert.ok(exported.headers.get("content-type").includes("text/csv"));
  const csv = await exported.text();
  assert.ok(csv.includes(sample.sourceLinks[0].detailUrl));
  assert.ok(csv.includes(sample.company));
  const denied = await request("/api/admin/reviews");
  assert.ok([401, 429].includes(denied.status));
  const reviews = await request("/api/admin/reviews?limit=2", { headers });
  assert.equal(reviews.status, 200);
  const queue = await reviews.json();
  assert.equal((await request("/api/admin/reviews", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ source: sample.source, sourceId: "__missing_runtime_verification__", status: "approved" }) })).status, 404);
  assert.equal((await request("/api/admin/reviews", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({}) })).status, 400);
  let db;
  try {
    db = await openRuntimeDatabase();
    const targets = await db.prepare("SELECT source, source_id AS sourceId FROM jobs WHERE review_status <> 'hidden' ORDER BY id LIMIT 500").all();
    const keys = targets.map((row) => `${row.source}:${row.sourceId}`);
    const jobs = await getSavedJobs(db, keys);
    assert.equal(jobs.length, 500);
    assert.deepEqual(jobs.map((job) => job.savedKey), keys);
  } finally {
    closeRuntimeDatabase(db);
    await closeRuntimePool();
  }
  console.log(JSON.stringify({ total: data.stats.total, uniqueTotal: data.matchCount, sources: data.sources.length, pending: queue.pendingCount, savedBatch: 500, httpChecks: "passed" }));
}
