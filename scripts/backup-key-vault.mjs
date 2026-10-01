import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const FORMAT = "campus-jobs-key-v1";
const KDF = { name: "scrypt", N: 32768, r: 8, p: 1 };
const MAX_BYTES = 4096;

function validatePassword(password) {
  if (typeof password !== "string" || password.trim().length < 12 || Buffer.byteLength(password) > 1024) throw new Error("Use a password of at least 12 characters (maximum 1024 bytes)");
}

function binary(value, size) {
  if (typeof value !== "string") throw new Error("Invalid metadata");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== size || buffer.toString("base64") !== value) throw new Error("Invalid metadata");
  return buffer;
}

const aad = (salt) => Buffer.from(JSON.stringify({ format: FORMAT, kdf: KDF, salt }));
const passwordKey = (password, salt) => derive(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });

export async function encodeKeyBackup(key, password) {
  validatePassword(password);
  if (!/^[a-f0-9]{64}$/i.test(key || "")) throw new Error("Invalid existing backup key; refusing to replace it");
  const salt = randomBytes(32), nonce = randomBytes(12);
  const derived = await passwordKey(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    const encodedSalt = salt.toString("base64");
    cipher.setAAD(aad(encodedSalt));
    const data = Buffer.concat([cipher.update(Buffer.from(key, "hex")), cipher.final()]);
    return JSON.stringify({ format: FORMAT, kdf: KDF, salt: encodedSalt, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  } finally { derived.fill(0); }
}

export async function decodeKeyBackup(encoded, password) {
  validatePassword(password);
  let derived;
  try {
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("Too large");
    const envelope = JSON.parse(encoded);
    if (Object.keys(envelope).sort().join() !== "data,format,kdf,nonce,salt,tag" || envelope.format !== FORMAT || !envelope.kdf || Object.keys(envelope.kdf).sort().join() !== "N,name,p,r" || Object.entries(KDF).some(([key, value]) => envelope.kdf[key] !== value)) throw new Error("Unsupported metadata");
    const salt = binary(envelope.salt, 32), nonce = binary(envelope.nonce, 12), tag = binary(envelope.tag, 16), data = binary(envelope.data, 32);
    derived = await passwordKey(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", derived, nonce, { authTagLength: 16 });
    decipher.setAAD(aad(envelope.salt));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    try { return plaintext.toString("hex"); } finally { plaintext.fill(0); }
  } catch { throw new Error("Key backup unlock failed: wrong password, damaged file or unsupported format"); }
  finally { derived?.fill(0); }
}

export async function readKeyBackup(path, password) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("Invalid key backup file");
  return decodeKeyBackup(await readFile(path, "utf8"), password);
}

export async function writeKeyBackup(path, key, password) {
  const destination = resolve(path);
  // Reject redirected ancestors so an external backup cannot land in a linked folder.
  for (let parent = dirname(destination); ; parent = dirname(parent)) {
    try { if ((await lstat(parent)).isSymbolicLink()) throw new Error("Key backup directory must not be linked"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(parent) === parent) break;
  }
  const encoded = await encodeKeyBackup(key, password);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, encoded, { flag: "wx", mode: 0o600 });
  if (await readKeyBackup(destination, password) !== key.toLowerCase()) throw new Error("Written key backup does not match");
  return destination;
}
