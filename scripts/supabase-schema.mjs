import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const LEGACY_SCHEMA = (await readFile(new URL("../supabase/migrations/0001_initial_schema.sql", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
export const SOURCE_SCHEMA = (await readFile(new URL("../supabase/migrations/0002_source_controls.sql", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
export const APP_SCHEMA = LEGACY_SCHEMA + "\n" + SOURCE_SCHEMA;
export const schemaHash = (schema) => createHash("sha256").update(schema).digest("hex");
