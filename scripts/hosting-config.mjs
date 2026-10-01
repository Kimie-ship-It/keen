import { storageMode } from "./runtime-db.mjs";

export function validateHostingConfig(env = process.env) {
  if (storageMode(env) !== "supabase") throw new Error("Set CAMPUS_JOBS_STORAGE=supabase before hosting");
  if (env.SUPABASE_SSL_INSECURE === "1") throw new Error("Disable the insecure database TLS exception before hosting");
  const connectionString = env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing server-side database configuration");
  let url;
  try { url = new URL(connectionString); } catch { throw new Error("Invalid database configuration"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error("Invalid database configuration");
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.trim().length < 24) throw new Error("ADMIN_TOKEN must have at least 24 characters");
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && /(?:ADMIN_TOKEN|DATABASE_URL|SUPABASE_DB_URL|FEISHU_)/.test(key)) throw new Error("Server secrets must not use NEXT_PUBLIC_ variables");
  }
}
