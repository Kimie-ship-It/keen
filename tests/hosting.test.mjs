import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateHostingConfig } from "../scripts/hosting-config.mjs";
import { storageMode } from "../scripts/runtime-db.mjs";
import { createPostgresPool } from "../scripts/postgres.mjs";
import { SUPABASE_CA } from "../scripts/supabase-ca.mjs";

const valid = { VERCEL: "1", CAMPUS_JOBS_STORAGE: "supabase", SUPABASE_DB_URL: "postgresql://user:fake@aws-0-us-east-1.pooler.supabase.com:6543/postgres", ADMIN_TOKEN: "a".repeat(32) };

test("hosting rejects missing storage, TLS exceptions and exposed secrets", () => {
  validateHostingConfig(valid);
  assert.throws(() => storageMode({ VERCEL: "1" }), /requires Supabase/);
  for (const overrides of [{ CAMPUS_JOBS_STORAGE: "sqlite" }, { SUPABASE_SSL_INSECURE: "1" }, { SUPABASE_DB_URL: "" }, { ADMIN_TOKEN: "short" }, { NEXT_PUBLIC_ADMIN_TOKEN: "secret" }, { NEXT_PUBLIC_SUPABASE_BACKUP_KEY: "secret" }, { NEXT_PUBLIC_SUPABASE_RESTORE_DB_URL: "secret" }]) {
    assert.throws(() => validateHostingConfig({ ...valid, ...overrides }));
  }
  assert.throws(() => validateHostingConfig({ ...valid, SUPABASE_DB_URL: "sensitive malformed value" }), (error) => !error.message.includes("sensitive"));
  assert.throws(() => createPostgresPool({ ...valid, SUPABASE_SSL_INSECURE: "1" }), /forbidden/);
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.buildCommand, "npm run build:hosting");
});

test("official Supabase CA is pinned and applied only to Supabase hosts", async () => {
  const cert = new X509Certificate(SUPABASE_CA);
  assert.equal(cert.fingerprint256, "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
  const supabase = createPostgresPool(valid);
  const other = createPostgresPool({ SUPABASE_DB_URL: "postgresql://user:fake@localhost/postgres" });
  const custom = createPostgresPool({ ...valid, SUPABASE_SSL_CA: "custom\\ncertificate" });
  assert.equal(supabase.options.ssl.ca, SUPABASE_CA);
  assert.equal(supabase.options.ssl.rejectUnauthorized, true);
  assert.equal(other.options.ssl.ca, undefined);
  assert.equal(custom.options.ssl.ca, "custom\ncertificate");
  await supabase.end();
  await other.end();
  await custom.end();
});
