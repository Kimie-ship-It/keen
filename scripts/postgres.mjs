import pg from "pg";
import { SUPABASE_CA } from "./supabase-ca.mjs";

export function createPostgresPool(env = process.env) {
  if (env.VERCEL === "1" && env.SUPABASE_SSL_INSECURE === "1") throw new Error("Insecure database TLS is forbidden on Vercel");
  const connectionString = env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing Supabase database configuration");
  // URI SSL flags must not override the explicitly selected TLS policy.
  const url = new URL(connectionString);
  const supabaseHost = url.hostname.endsWith(".pooler.supabase.com") || url.hostname.endsWith(".supabase.co");
  const ca = env.SUPABASE_SSL_CA?.replaceAll("\\n", "\n") || (supabaseHost ? SUPABASE_CA : undefined);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  const pool = new pg.Pool({
    connectionString: url.toString(), max: 3,
    connectionTimeoutMillis: 15000, idleTimeoutMillis: 10000,
    query_timeout: 30000, statement_timeout: 25000,
    ssl: { rejectUnauthorized: env.SUPABASE_SSL_INSECURE !== "1", ...(ca ? { ca } : {}) },
  });
  pool.on("error", () => console.error("PostgreSQL idle connection lost"));
  return pool;
}
