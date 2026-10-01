import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../.env.local", import.meta.url);
const current = await readFile(path, "utf8");
const existing = current.match(/^SUPABASE_BACKUP_KEY=(.*)$/m)?.[1].trim();
if (existing && !/^[a-f0-9]{64}$/i.test(existing)) throw new Error("Existing backup key is invalid; refusing to replace it");
if (!existing) {
  const entry = "SUPABASE_BACKUP_KEY=" + randomBytes(32).toString("hex");
  const updated = /^SUPABASE_BACKUP_KEY=.*$/m.test(current) ? current.replace(/^SUPABASE_BACKUP_KEY=.*$/m, entry) : current.trimEnd() + "\n" + entry + "\n";
  await writeFile(path, updated, { mode: 0o600 });
}
console.log("Backup encryption key is stored only in .env.local. Preserve it separately; it is required for recovery.");
