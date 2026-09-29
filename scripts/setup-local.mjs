import { randomBytes } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";

const path = new URL("../.env.local", import.meta.url);
let current = "";
try { current = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
let updated = current.trimEnd();
if (!/^ADMIN_TOKEN=.+$/m.test(updated)) {
  const value = "ADMIN_TOKEN=" + randomBytes(32).toString("hex");
  updated = /^ADMIN_TOKEN=.*$/m.test(updated) ? updated.replace(/^ADMIN_TOKEN=.*$/m, value) : `${updated}\n${value}`;
}
if (!/^FEISHU_WEBHOOK_URL=/m.test(updated)) updated += "\nFEISHU_WEBHOOK_URL=";
if (!/^FEISHU_SIGN_SECRET=/m.test(updated)) updated += "\nFEISHU_SIGN_SECRET=";
updated = updated.replace(/^\s+/, "") + "\n";
if (updated !== current) await writeFile(path, updated, { mode: 0o600 });
console.log("Local configuration ready. Management token is stored only in .env.local.");
