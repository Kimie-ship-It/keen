import { getSource, SOURCES } from "./sources.mjs";

export const SOURCE_REASONS = Object.freeze({ source_request: "来源方要求", privacy: "隐私问题", copyright: "内容权利问题", inaccurate: "信息有误", resolved: "问题已处理" });

export function availableSourceSQL(alias) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("Invalid SQL alias");
  return `COALESCE((SELECT control.action FROM source_controls control WHERE control.source=${alias}.source ORDER BY control.id DESC LIMIT 1), 'restore') <> 'restrict'`;
}

export const visibleJobSQL = (alias = "jobs") => `${alias}.review_status <> 'hidden' AND ${availableSourceSQL(alias)}`;

export function validateSourceControl(input) {
  if (!input || !Object.hasOwn(SOURCES, input.id) || !["restrict", "restore"].includes(input.action) || !Object.hasOwn(SOURCE_REASONS, input.reason)) throw new Error("无效来源、操作或原因");
  if ((input.action === "restore") !== (input.reason === "resolved")) throw new Error("恢复与下架原因不匹配");
  return input;
}

export async function listSourceControls(db) {
  const recent = await db.prepare("SELECT id, source, action, reason, actor, created_at FROM source_controls ORDER BY id DESC LIMIT 50").all();
  const sources = [];
  for (const [id, source] of Object.entries(SOURCES)) {
    const latest = await db.prepare("SELECT action, reason, created_at FROM source_controls WHERE source=? ORDER BY id DESC LIMIT 1").get(source.name);
    sources.push({ id, source: source.name, restricted: latest?.action === "restrict", reason: latest?.reason || "", changedAt: latest?.created_at || null });
  }
  return { sources, recent };
}

export async function updateSourceControl(db, input) {
  validateSourceControl(input);
  const values = [getSource(input.id).name, input.action, input.reason, "管理员", new Date().toISOString()];
  // A single append is both the authoritative state transition and its audit record.
  if (db.dialect === "postgres") {
    await db.client.query("BEGIN");
    try {
      await db.client.query("INSERT INTO source_controls (source,action,reason,actor,created_at) VALUES ($1,$2,$3,$4,$5)", values);
      await db.client.query("COMMIT");
    } catch (error) {
      try { await db.client.query("ROLLBACK"); } catch { db.failed = true; }
      throw error;
    }
  } else db.prepare("INSERT INTO source_controls (source,action,reason,actor,created_at) VALUES (?,?,?,?,?)").run(...values);
}

export async function sourceIsRestricted(db, id) {
  const source = getSource(id);
  const latest = await db.prepare("SELECT action FROM source_controls WHERE source=? ORDER BY id DESC LIMIT 1").get(source.name);
  return latest?.action === "restrict";
}

export async function collectionAllowed(id) {
  const { openRuntimeDatabase, closeRuntimeDatabase } = await import("./runtime-db.mjs");
  let db;
  try { db = await openRuntimeDatabase(); return !(await sourceIsRestricted(db, id)); }
  finally { closeRuntimeDatabase(db); }
}

export async function assertCollectionAllowed(id) {
  if (!(await collectionAllowed(id))) throw new Error("Source withdrawn; collection refused");
}
