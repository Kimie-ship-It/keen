import "../scripts/config.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { readErrorEvents } from "../scripts/monitor.mjs";
import { SOURCES } from "../scripts/sources.mjs";

const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const secret = "fault-test-secret-do-not-record";
const before = new Set((await readErrorEvents({ limit: 500 })).map((event) => event.id));
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, VERCEL: "", CAMPUS_JOBS_STORAGE: "supabase", SUPABASE_DB_URL: `postgresql://user:${secret}@127.0.0.1:1/postgres`, SUPABASE_SSL_INSECURE: "0" },
});
let ready = false;
server.stdout.on("data", (chunk) => { if (chunk.toString().includes("Ready")) ready = true; });
// Next.js may also emit its own stack; this test inspects only our structured records.
server.stderr.resume();
try {
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (server.exitCode !== null) throw new Error("Fault-test server stopped before ready");
    await sleep(100);
  }
  assert.ok(ready, "Fault-test server must become ready");
  const ids = [];
  const requests = [["/api/jobs?probe=" + secret, "GET", "jobs.list"], ["/api/jobs/export?ids=test", "GET", "jobs.export"], ["/api/admin/reviews", "GET", "admin.read"], ["/api/admin/reviews", "POST", "admin.write"], ["/api/admin/sources", "GET", "sources.read"], ["/api/admin/sources", "POST", "sources.write"]];
  for (const [path, method, operation] of requests) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "X-Probe-Secret": secret }, signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 503);
    const id = response.headers.get("x-error-id");
    assert.match(id, /^[a-f0-9-]{36}$/);
    ids.push({ id, operation });
    const body = await response.text();
    assert.ok(!body.includes(secret));
    assert.ok(!body.includes(process.env.ADMIN_TOKEN));
    assert.ok(!/postgresql|ECONNREFUSED|127\.0\.0\.1/i.test(body));
  }
  const detail = await fetch(`http://127.0.0.1:${port}/jobs/${encodeURIComponent(SOURCES.buaa.name)}/test?probe=${secret}`, { signal: AbortSignal.timeout(60000) });
  assert.equal(detail.status, 500);
  await detail.text();
  const records = (await readErrorEvents({ limit: 500 })).filter((event) => !before.has(event.id));
  for (const expected of ids) assert.ok(records.some((event) => event.id === expected.id && event.operation === expected.operation));
  assert.ok(records.some((event) => event.operation === "server.request"), "Next.js uncaught rendering errors must be recorded");
  assert.ok(!JSON.stringify(records).includes(secret));
  assert.ok(!JSON.stringify(records).includes(process.env.ADMIN_TOKEN));
  assert.equal(new Set(ids.map((event) => event.id)).size, 6);
  console.log(JSON.stringify({ faultInjection: "passed", apiFailures: 6, uncaughtRendering: "recorded", sanitized: true }));
} finally {
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
}
