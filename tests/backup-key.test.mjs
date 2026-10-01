import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeKeyBackup, encodeKeyBackup, readKeyBackup, writeKeyBackup } from "../scripts/backup-key-vault.mjs";
import { decodeBackup, encodeBackup, BACKUP_TABLES } from "../scripts/supabase-backup.mjs";
import { APP_SCHEMA, schemaHash } from "../scripts/supabase-schema.mjs";

const key = '12'.repeat(32), password = 'test-only-long-password';

test('portable key export round-trips with only password and ciphertext', async () => {
  const encoded = await encodeKeyBackup(key, password);
  assert.ok(!encoded.includes(key));
  assert.ok(!encoded.includes(password));
  assert.equal(await decodeKeyBackup(encoded, password), key);
  assert.notEqual(encoded, await encodeKeyBackup(key, password));
  const tables = Object.fromEntries(BACKUP_TABLES.map(table => [table.name, []]));
  tables.jobs = [Object.fromEntries(BACKUP_TABLES[0].columns.map(column => [column, column === 'id' ? '1' : 'fixture']))];
  const snapshot = { format: 'campus-jobs-supabase-v2', schemaHash: schemaHash(APP_SCHEMA), createdAt: new Date().toISOString(), tables };
  const backup = encodeBackup(snapshot, key);
  assert.deepEqual(decodeBackup(backup, await decodeKeyBackup(encoded, password)), snapshot);
});

test('key export rejects weak passwords, malformed metadata, tampering and wrong passwords', async () => {
  await assert.rejects(encodeKeyBackup(key, 'short'), /12 characters/);
  await assert.rejects(encodeKeyBackup('invalid', password), /Invalid existing/);
  const encoded = await encodeKeyBackup(key, password);
  await assert.rejects(decodeKeyBackup(encoded, 'different-long-password'), /unlock failed/);
  for (const field of ['salt', 'nonce', 'tag', 'data']) {
    const envelope = JSON.parse(encoded);
    envelope[field] = 'AAAA' + envelope[field].slice(4);
    await assert.rejects(decodeKeyBackup(JSON.stringify(envelope), password), /unlock failed/);
  }
  const envelope = JSON.parse(encoded);
  envelope.kdf.N = 1073741824;
  await assert.rejects(decodeKeyBackup(JSON.stringify(envelope), password), /unlock failed/);
  await assert.rejects(decodeKeyBackup('x'.repeat(5000), password), /unlock failed/);
});

test('key export reads disk back, never overwrites existing files, and rejects oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campus-key-test-'));
  try {
    const target = join(root, 'usb', 'test.cjkey');
    await writeKeyBackup(target, key, password);
    const original = await readFile(target, 'utf8');
    assert.equal(await readKeyBackup(target, password), key);
    await assert.rejects(writeKeyBackup(target, '34'.repeat(32), password), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), original);
    await writeFile(join(root, 'oversized.cjkey'), 'x'.repeat(5000));
    await assert.rejects(readKeyBackup(join(root, 'oversized.cjkey'), password), /Invalid key backup file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
