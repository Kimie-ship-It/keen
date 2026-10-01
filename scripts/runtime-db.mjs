import { createPostgresPool } from "./postgres.mjs";

let pool;

export function storageMode(env = process.env) {
  const mode = env.CAMPUS_JOBS_STORAGE || "sqlite";
  if (!["sqlite", "supabase"].includes(mode)) throw new Error("Invalid database storage mode");
  return mode;
}

export function postgresQuery(sql) {
  let parameter = 0;
  const aliases = new Set(["jobId", "sourceId", "jobType", "publishedAt", "recruitingNumbers", "detailUrl", "firstSeenAt", "reviewStatus", "groupKey", "todayNew", "dueSoon", "lastStatus", "lastFinishedAt", "lastSuccessfulAt", "lastFailureAt", "finishedAt", "fetchedCount", "newCount"]);
  // Application SQL uses anonymous parameters only outside quoted literals.
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?|\b[A-Za-z_][A-Za-z0-9_]*\b/g, (token) => {
    if (token === "?") return `$${++parameter}`;
    return aliases.has(token) ? `"${token}"` : token;
  });
}

function numericRows(rows, fields) {
  const numbers = new Set(fields.filter((field) => [20, 1700].includes(field.dataTypeID)).map((field) => field.name));
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || !numbers.has(key)) return [key, value];
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds safe range");
    return [key, number];
  })));
}

export function postgresDatabase(client) {
  return {
    dialect: "postgres", client,
    prepare(sql) {
      const query = async (params) => {
        const result = await client.query(postgresQuery(sql), params);
        return numericRows(result.rows, result.fields);
      };
      return { all: (...params) => query(params), get: async (...params) => (await query(params))[0] };
    },
  };
}

export async function openRuntimeDatabase() {
  if (storageMode() === "sqlite") {
    const { openDatabase } = await import("./db.mjs");
    return openDatabase();
  }
  pool ||= createPostgresPool();
  const client = await pool.connect();
  const db = postgresDatabase(client);
  client.on("error", () => { db.failed = true; });
  return db;
}

export function closeRuntimeDatabase(db) {
  if (db?.dialect === "postgres") {
    db.client.removeAllListeners("error");
    db.client.release(db.failed);
  } else if (db?.open) db.close();
}

export async function closeRuntimePool() {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}
