import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { openDatabase, closeDatabase } from "../scripts/db.mjs";
import { SOURCES } from "../scripts/sources.mjs";
import { createDedupeKey } from "../scripts/dedupe.mjs";

const root = await mkdtemp(join(tmpdir(), "campus-source-http-"));
const dbPath = join(root, "test.db");
const db = await openDatabase(dbPath);
const token = "isolated-http-test-not-production-secret";
const source = SOURCES.buaa.name, peer = SOURCES.bit.name;
for (const [index, school] of [source, peer].entries()) {
  db.prepare("INSERT INTO jobs (source,source_id,company,title,published_at,first_seen_at,last_seen_at,dedupe_key,detail_url) VALUES (?,?,?,?,?,?,?,?,?)").run(school, "test", "测试公司", "测试招聘", "2026-10-01", "2026-10-01", "2026-10-01", createDedupeKey({ company: "测试公司", title: "测试招聘" }), `https://${index ? "job.bit.edu.cn" : "career.buaa.edu.cn"}/test`);
  db.prepare("INSERT INTO job_locations VALUES (?,?)").run(index + 1, index ? "上海" : "北京");
  db.prepare("INSERT INTO job_industries VALUES (?,?)").run(index + 1, index ? "金融" : "技术");
}
closeDatabase(db);
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, VERCEL: "", CAMPUS_JOBS_STORAGE: "sqlite", CAMPUS_JOBS_DB: dbPath, ADMIN_TOKEN: token, PRIVACY_CONTACT_EMAIL: "" },
});
let ready = false, browser;
server.stdout.on("data", (chunk) => { if (chunk.toString().includes("Ready")) ready = true; });
server.stderr.resume();
const control = (method, body, authorized = true) => fetch(`${base}/api/admin/sources`, { method, signal: AbortSignal.timeout(15000), headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const detail = (school) => `${base}/jobs/${encodeURIComponent(school)}/test`;
try {
  for (let i = 0; i < 100 && !ready; i++) { if (server.exitCode !== null) throw new Error("Test website stopped"); await sleep(100); }
  assert.ok(ready);
  assert.equal((await control("GET", undefined, false)).status, 401);
  for (const body of [{ id: "unknown", action: "restrict", reason: "privacy" }, { id: "bit", action: "restore", reason: "privacy" }]) assert.equal((await control("POST", body)).status, 400);
  assert.equal((await (await fetch(`${base}/api/jobs`)).json()).stats.total, 2);
  assert.equal((await fetch(detail(peer))).status, 200);
  assert.equal((await control("POST", { id: "bit", action: "restrict", reason: "privacy" })).status, 200);
  const result = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(result.stats.total, 1);
  assert.equal(result.jobs[0].sourceCount, 1);
  assert.ok(!JSON.stringify(result).includes(peer));
  assert.equal((await fetch(detail(peer))).status, 404);
  assert.equal((await fetch(detail(source))).status, 200);
  const csv = await (await fetch(`${base}/api/jobs/export?ids=${encodeURIComponent(`${source}:test,${peer}:test`)}`)).text();
  assert.ok(csv.includes(source) && !csv.includes(peer));
  const privacy = await (await fetch(`${base}/privacy`)).text();
  assert.ok(privacy.includes("下架不等于彻底删除") && privacy.includes("尚未配置对外联系邮箱"));

  if (process.env.CAMPUS_JOBS_PLAYWRIGHT_PATH) {
    const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.CAMPUS_JOBS_PLAYWRIGHT_PATH);
    browser = await chromium.launch({ headless: true, ...(process.env.CAMPUS_JOBS_BROWSER_PATH ? { executablePath: process.env.CAMPUS_JOBS_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const screenshots = resolve("data/test-qa/source-controls");
    await mkdir(screenshots, { recursive: true });
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/privacy`);
      await page.getByRole("heading", { name: "隐私与来源处理" }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(screenshots, `privacy-${name}.png`), fullPage: true });
      await page.goto(`${base}/admin`);
      await page.getByLabel("管理口令").fill(token);
      await page.getByRole("button", { name: "读取待审核" }).click();
      await page.getByLabel(`${peer}公开展示`).waitFor();
      assert.equal(await page.getByLabel(`${peer}公开展示`).isChecked(), false);
      assert.equal(await page.getByLabel(`${peer}下架原因`).inputValue(), "privacy");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(screenshots, `admin-${name}.png`), fullPage: true });
    }
    page.once("dialog", (dialog) => dialog.accept());
    const [restored] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/admin/sources") && response.request().method() === "POST"),
      page.getByLabel(`${peer}公开展示`).click(),
    ]);
    assert.equal(restored.status(), 200);
    await page.waitForFunction(() => document.querySelector('input[aria-label="北京理工大学公开展示"]')?.checked === true);
    assert.equal((await (await fetch(`${base}/api/jobs`)).json()).stats.total, 2);
    await page.goto(base);
    await page.evaluate((key) => localStorage.setItem("campus-jobs:saved", JSON.stringify([key])), `${source}:test`);
    await page.reload();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "清空收藏" }).click();
    await page.waitForFunction(() => localStorage.getItem("campus-jobs:saved") === "[]");
    await page.getByRole("link", { name: "隐私与来源处理" }).click();
    await page.getByRole("heading", { name: "隐私与来源处理" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: "passed", screenshots, mobileWidth: 390, desktopWidth: 1440 }));
  } else assert.equal((await control("POST", { id: "bit", action: "restore", reason: "resolved" })).status, 200);
  assert.equal((await (await fetch(`${base}/api/jobs`)).json()).stats.total, 2);
  const audit = await (await control("GET")).json();
  assert.equal(audit.recent.length, 2);
  console.log(JSON.stringify({ isolatedHttp: "passed", unauthorized: 401, invalid: 400, withdrawnDetail: 404, listExport: "filtered", restoration: "verified", productionWrites: false }));
} finally {
  await browser?.close();
  if (server.exitCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
  await rm(root, { recursive: true, force: true });
}
