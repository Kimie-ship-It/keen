import pg from "pg";

export function createPostgresPool(env = process.env) {
  const connectionString = env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing Supabase database configuration");
  // URI SSL flags must not override the explicitly selected TLS policy.
  const url = new URL(connectionString);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  const pool = new pg.Pool({
    connectionString: url.toString(), max: 3,
    connectionTimeoutMillis: 15000, idleTimeoutMillis: 10000,
    query_timeout: 30000, statement_timeout: 25000,
    ssl: { rejectUnauthorized: env.SUPABASE_SSL_INSECURE !== "1", ...(env.SUPABASE_SSL_CA ? { ca: env.SUPABASE_SSL_CA.replaceAll("\\n", "\n") } : {}) },
  });
  pool.on("error", () => console.error("PostgreSQL idle connection lost"));
  return pool;
}
