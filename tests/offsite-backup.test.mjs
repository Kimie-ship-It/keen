import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { credentialPath, uploadEncryptedBackup } from "../scripts/offsite-backup.mjs";

const NAME = "20261001T101036628Z-60c0a06d.cjbackup";
const hash = (value) => createHash("md5").update(value).digest("hex");

async function fixture(fn, { failAt, expired = false, content = Buffer.from("encrypted-backup-fixture") } = {}) {
  const root = await mkdtemp(join(tmpdir(), "campus-offsite-"));
  const backup = join(root, NAME), auth = join(root, "baidu-oauth.json"), data = content;
  const parts = [];
  for (let offset = 0; offset < data.length; offset += 4 * 1024 * 1024) parts.push(data.subarray(offset, offset + 4 * 1024 * 1024));
  await writeFile(backup, data);
  await writeFile(auth, JSON.stringify({ appName: "校招雷达备份", clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: expired ? 1 : Date.now() + 86400000 }));
  const calls = [], path = `/apps/校招雷达备份/${NAME}`;
  const request = async (url, options = {}) => {
    const parsed = new URL(url), step = parsed.searchParams.get("method") || parsed.searchParams.get("grant_type");
    calls.push(step);
    assert.equal(options.redirect, "error");
    if (step === failAt) return new Response(JSON.stringify({ errno: 31024 }), { status: 200 });
    if (step === "refresh_token") return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 2592000 });
    assert.equal(parsed.searchParams.get("access_token"), expired ? "new-access" : "access");
    if (step === "precreate") {
      assert.equal(options.body.get("path"), path);
      assert.equal(options.body.get("size"), String(data.length));
      assert.equal(options.body.get("rtype"), "0");
      assert.deepEqual(JSON.parse(options.body.get("block_list")), parts.map(hash));
      return Response.json({ errno: 0, uploadid: "upload-id", block_list: parts.map((_, index) => index) });
    }
    if (step === "locateupload") return Response.json({ error_code: 0, servers: [{ server: "https://c3.pcs.baidu.com" }] });
    if (step === "upload") {
      assert.equal(parsed.hostname, "c3.pcs.baidu.com");
      const part = parts[Number(parsed.searchParams.get("partseq"))];
      assert.deepEqual(Buffer.from(await options.body.get("file").arrayBuffer()), part);
      return Response.json({ md5: hash(part) });
    }
    if (step === "create") {
      assert.equal(options.body.get("rtype"), "0");
      return Response.json({ errno: 0, path, size: data.length, fs_id: 123, md5: hash(data) });
    }
    throw new Error("Unexpected API request");
  };
  try { await fn({ root, backup, auth, data, calls, request, path }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("uploads only the generated encrypted file without overwriting a remote copy", async () => fixture(async ({ root, backup, auth, data, calls, request, path }) => {
  const result = await uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => {} });
  assert.deepEqual(calls, ["precreate", "locateupload", "upload", "create"]);
  assert.equal(result.path, path);
  assert.equal(result.size, data.length);
  assert.equal(result.sha256, createHash("sha256").update(data).digest("hex"));
  assert.equal(result.verification, "download-required");
  assert.deepEqual(await readFile(backup), data);
}));

test("refreshes an expiring token and persists the replacement for the next day", async () => fixture(async ({ root, backup, auth, request, calls }) => {
  await uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => {} });
  assert.equal(calls[0], "refresh_token");
  assert.equal(JSON.parse(await readFile(auth, "utf8")).refreshToken, "new-refresh");
}, { expired: true }));

test("remote upload error leaves the old backup and original file untouched", async () => fixture(async ({ root, backup, auth, request, calls, data }) => {
  await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => {} }), /Baidu pre-upload rejected/);
  assert.deepEqual(calls, ["precreate"]);
  assert.deepEqual(await readFile(backup), data);
}, { failAt: "precreate" }));

test("rejects a raw file even when a valid backup is nearby", async () => fixture(async ({ root, auth, request, calls }) => {
  await assert.rejects(uploadEncryptedBackup(join(root, "raw.db"), { backupRoot: root, credentialFile: auth, request }), /Only a generated encrypted backup/);
  assert.deepEqual(calls, []);
}));

test("supports multiple 4 MiB parts in order with consistent hashes", async () => fixture(async ({ root, backup, auth, data, request, calls }) => {
  const result = await uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => {} });
  assert.deepEqual(calls, ["precreate", "locateupload", "upload", "locateupload", "upload", "create"]);
  assert.equal(result.size, data.length);
}, { content: Buffer.alloc(4 * 1024 * 1024 + 100, 7) }));

test("backup validation failure never transmits data or authorization", async () => fixture(async ({ root, backup, auth, request, calls }) => {
  await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => { throw new Error("Invalid encryption"); } }), /Invalid encryption/);
  assert.deepEqual(calls, []);
}));

test("credential override is supported but repository storage is rejected", () => {
  const path = join(tmpdir(), "campus-auth", "baidu-oauth.json");
  assert.equal(credentialPath({ BAIDU_OFFSITE_CREDENTIAL_FILE: path }), resolve(path));
  assert.throws(() => credentialPath({ BAIDU_OFFSITE_CREDENTIAL_FILE: fileURLToPath(new URL("../baidu-oauth.json", import.meta.url)) }), /outside the project/);
});

test("malformed credentials are rejected before any request", async () => fixture(async ({ root, backup, auth, request, calls }) => {
  const value = JSON.parse(await readFile(auth, "utf8"));
  await writeFile(auth, JSON.stringify({ ...value, refreshToken: { secret: "not-a-string" } }));
  await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => {} }), /not configured/);
  assert.deepEqual(calls, []);
}));

test("invalid refresh leaves the saved authorization unchanged", async () => fixture(async ({ root, backup, auth, request }) => {
  const original = await readFile(auth, "utf8");
  const badRefresh = async (url, options) => {
    await request(url, options);
    return Response.json({ access_token: "new", refresh_token: "new", expires_in: -1 });
  };
  await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request: badRefresh, validate: async () => {} }), /refresh is incomplete/);
  assert.equal(await readFile(auth, "utf8"), original);
}, { expired: true }));

for (const stage of ["locateupload", "upload", "create"]) {
  test(`${stage} failure preserves the local backup and does not delete remote files`, async () => fixture(async ({ root, backup, auth, request, calls, data }) => {
    await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request, validate: async () => {} }));
    assert.ok(!calls.includes("delete"));
    if (stage !== "create") assert.ok(!calls.includes("create"));
    assert.deepEqual(await readFile(backup), data);
  }, { failAt: stage }));
}

test("untrusted upload destinations never receive credentials or file bytes", async () => fixture(async ({ root, backup, auth, request, calls }) => {
  const malicious = async (url, options) => {
    const response = await request(url, options);
    if (new URL(url).searchParams.get("method") === "locateupload") return Response.json({ error_code: 0, servers: [{ server: "https://pcs.baidu.com.evil.invalid" }, { server: "http://c3.pcs.baidu.com" }, { server: "https://c3.pcs.baidu.com:444" }] });
    return response;
  };
  await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request: malicious, validate: async () => {} }), /trusted HTTPS upload host/);
  assert.deepEqual(calls, ["precreate", "locateupload"]);
}));

test("corrupt uploaded parts are never assembled into a backup", async () => fixture(async ({ root, backup, auth, request, calls }) => {
  const corrupt = async (url, options) => {
    const response = await request(url, options);
    return new URL(url).searchParams.get("method") === "upload" ? Response.json({ md5: "0".repeat(32) }) : response;
  };
  await assert.rejects(uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request: corrupt, validate: async () => {} }), /checksum mismatch/);
  assert.ok(!calls.includes("create"));
}));

test("cloud checksum metadata is not reported as a download verification", async () => fixture(async ({ root, backup, auth, request }) => {
  const alteredMetadata = async (url, options) => {
    const response = await request(url, options);
    if (new URL(url).searchParams.get("method") !== "create") return response;
    return Response.json({ ...await response.json(), md5: "0".repeat(32) });
  };
  const result = await uploadEncryptedBackup(backup, { backupRoot: root, credentialFile: auth, request: alteredMetadata, validate: async () => {} });
  assert.equal(result.verification, "download-required");
  assert.equal(result.remoteMd5, "0".repeat(32));
}));
