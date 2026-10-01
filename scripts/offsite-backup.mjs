import "./config.mjs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, basename, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_BACKUP_ROOT, readBackup } from "./supabase-backup.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function credentialPath(env = process.env) {
  const path = resolve(env.BAIDU_OFFSITE_CREDENTIAL_FILE || join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CampusJobsRadar", "baidu-oauth.json"));
  const within = relative(PROJECT_ROOT, path);
  if (!within || (!isAbsolute(within) && within !== ".." && !within.startsWith(".." + sep))) throw new Error("Keep Baidu authorization outside the project directory");
  return path;
}
const NAME = /^\d{8}T\d{9}Z-[a-f0-9]{8}\.cjbackup$/;
const CHUNK_BYTES = 4 * 1024 * 1024;

function credentials(value) {
  const validSecret = (secret) => typeof secret === "string" && secret.trim().length > 0 && secret.length <= 8192;
  if (!value || typeof value !== "object" || !/^[\p{L}\p{N}_ -]{1,64}$/u.test(value.appName || "") ||
      !validSecret(value.clientId) || !validSecret(value.clientSecret) || !validSecret(value.refreshToken) ||
      !validSecret(value.accessToken) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new Error("Baidu authorization is not configured");
  return value;
}

async function responseJson(response, step) {
  if (!response.ok) throw new Error(`Baidu ${step} failed (HTTP ${response.status})`);
  let data;
  try { data = await response.json(); } catch { throw new Error(`Baidu ${step} returned an invalid response`); }
  if (!data || typeof data !== "object" || ("errno" in data && data.errno !== 0) || ("error_code" in data && data.error_code !== 0) || data.error) {
    const code = Number.isInteger(data?.errno) ? data.errno : Number.isInteger(data?.error_code) ? data.error_code : "unknown";
    throw new Error(`Baidu ${step} rejected the request (code ${code})`);
  }
  return data;
}

async function currentToken(path, request, now) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Invalid Baidu authorization file");
  const state = credentials(JSON.parse(await readFile(path, "utf8")));
  if (state.expiresAt - now > 5 * 60 * 1000) return state;
  const url = new URL("https://openapi.baidu.com/oauth/2.0/token");
  url.search = new URLSearchParams({ grant_type: "refresh_token", refresh_token: state.refreshToken, client_id: state.clientId, client_secret: state.clientSecret }).toString();
  const refreshed = await responseJson(await request(url, { redirect: "error", signal: AbortSignal.timeout(30000) }), "authorization refresh");
  if (!refreshed.access_token || !refreshed.refresh_token || !Number.isSafeInteger(Number(refreshed.expires_in)) || Number(refreshed.expires_in) <= 0) throw new Error("Baidu authorization refresh is incomplete");
  const next = credentials({ ...state, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token, expiresAt: now + Number(refreshed.expires_in) * 1000 });
  const temporary = path + "." + randomBytes(6).toString("hex") + ".partial";
  try {
    await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return next;
}

async function api(request, method, url, body, step) {
  return responseJson(await request(url, { method, redirect: "error", ...(body ? { body } : {}), signal: AbortSignal.timeout(120000) }), step);
}

function endpoint(method, token) {
  const url = new URL("https://pan.baidu.com/rest/2.0/xpan/file");
  url.search = new URLSearchParams({ method, access_token: token }).toString();
  return url;
}

function uploadHost(result) {
  const selected = (Array.isArray(result.servers) ? result.servers : []).find((entry) => {
    try { const url = new URL(entry.server); return url.protocol === "https:" && url.hostname.endsWith(".pcs.baidu.com") && !url.username && !url.password && !url.port; }
    catch { return false; }
  })?.server;
  if (!selected) throw new Error("Baidu did not provide a trusted HTTPS upload host");
  return new URL(selected);
}

export async function uploadEncryptedBackup(path, { credentialFile = credentialPath(), backupRoot = CLOUD_BACKUP_ROOT, request = fetch, validate = readBackup, now = Date.now() } = {}) {
  credentialFile = credentialPath({ BAIDU_OFFSITE_CREDENTIAL_FILE: credentialFile });
  const selected = resolve(path);
  if (dirname(selected) !== resolve(backupRoot) || !NAME.test(basename(selected))) throw new Error("Only a generated encrypted backup can be uploaded");
  const rootStat = await lstat(resolve(backupRoot));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid encrypted backup directory");
  const stat = await lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024 * 1024) throw new Error("Invalid encrypted backup file");
  await validate(selected);
  const file = await readFile(selected);
  if (file.length !== stat.size) throw new Error("Encrypted backup changed during validation");
  const state = await currentToken(resolve(credentialFile), request, now);
  const remotePath = `/apps/${state.appName}/${basename(selected)}`;
  const blocks = [];
  for (let offset = 0; offset < file.length; offset += CHUNK_BYTES) blocks.push(createHash("md5").update(file.subarray(offset, offset + CHUNK_BYTES)).digest("hex"));
  const fields = { path: remotePath, size: String(file.length), isdir: "0", rtype: "0", block_list: JSON.stringify(blocks) };
  const precreate = await api(request, "POST", endpoint("precreate", state.accessToken), new URLSearchParams({ ...fields, autoinit: "1" }), "pre-upload");
  if (typeof precreate.uploadid !== "string" || !precreate.uploadid || !Array.isArray(precreate.block_list) || new Set(precreate.block_list).size !== precreate.block_list.length || precreate.block_list.some((index) => !Number.isInteger(index) || index < 0 || index >= blocks.length)) throw new Error("Baidu pre-upload result is invalid");
  for (const index of precreate.block_list) {
    const locate = new URL("https://d.pcs.baidu.com/rest/2.0/pcs/file");
    locate.search = new URLSearchParams({ method: "locateupload", appid: "250528", access_token: state.accessToken, path: remotePath, uploadid: precreate.uploadid, upload_version: "2.0" }).toString();
    const host = uploadHost(await api(request, "GET", locate, null, "upload host lookup"));
    host.pathname = "/rest/2.0/pcs/superfile2";
    host.search = new URLSearchParams({ method: "upload", type: "tmpfile", access_token: state.accessToken, path: remotePath, uploadid: precreate.uploadid, partseq: String(index) }).toString();
    const part = file.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const form = new FormData();
    form.append("file", new Blob([part]), basename(selected));
    const uploaded = await api(request, "POST", host, form, "part upload");
    if (uploaded.md5 !== blocks[index]) throw new Error("Baidu part checksum mismatch");
  }
  const created = await api(request, "POST", endpoint("create", state.accessToken), new URLSearchParams({ ...fields, uploadid: precreate.uploadid, rtype: "0" }), "file creation");
  if (created.path !== remotePath || Number(created.size) !== file.length || !Number.isSafeInteger(created.fs_id) || created.fs_id <= 0 || !/^[a-f0-9]{32}$/i.test(created.md5 || "")) throw new Error("Baidu file creation result is invalid");
  // Cloud MD5 is metadata, not an independent download-and-recovery check.
  return { path: remotePath, size: file.length, sha256: createHash("sha256").update(file).digest("hex"), remoteMd5: created.md5, verification: "download-required" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Provide exactly one generated .cjbackup path");
    console.log(JSON.stringify(await uploadEncryptedBackup(process.argv[2])));
  } catch (error) {
    const { reportError } = await import("./monitor.mjs");
    await reportError(error, { operation: "backup.offsite" });
    console.error("Offsite upload failed; no existing remote backup was deleted. Check the local sanitized error record.");
    process.exitCode = 1;
  }
}
