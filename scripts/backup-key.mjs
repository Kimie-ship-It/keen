import "./config.mjs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readKeyBackup, writeKeyBackup } from "./backup-key-vault.mjs";
import { verifyCloudBackup } from "./supabase-backup.mjs";

export async function runKeyBackup(mode, destination, snapshot, password) {
  if (!["export", "verify"].includes(mode) || !destination || !snapshot) throw new Error("Specify export/verify, key destination and encrypted database snapshot");
  let keyFile = resolve(destination);
  if (mode === "export") {
    const name = new Date().toISOString().replace(/[-:.]/g, "") + "-" + randomBytes(4).toString("hex") + ".cjkey";
    keyFile = await writeKeyBackup(join(keyFile, name), process.env.SUPABASE_BACKUP_KEY, password);
  }
  // The restore drill receives only the key reread from external storage, never a local fallback.
  const recovered = await readKeyBackup(keyFile, password);
  const verification = await verifyCloudBackup(snapshot, { key: recovered });
  return { keyFile, verifiedUsing: "external-key-file", ...verification };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("Exactly three command arguments are required");
    if (process.stdin.isTTY) throw new Error("Use the local hidden-password dialog");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 4096) throw new Error("Input too large");
    }
    const { password } = JSON.parse(input);
    input = "";
    const result = await runKeyBackup(...process.argv.slice(2), password);
    console.log(JSON.stringify(result));
  } catch {
    console.error("Key export/verification failed. Existing keys and production rows were not replaced. Check password, USB drive and database connectivity; an encrypted file may exist without a completed drill.");
    process.exitCode = 1;
  }
}
