import crypto from "node:crypto";

/**
 * Binary format: [MAGIC 4B][SALT 32B][IV 12B][AUTH_TAG 16B][CIPHERTEXT ...]
 * Total header: 64 bytes before ciphertext
 */
const MAGIC = Buffer.from("B2EN");
const SALT_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;

const SCRYPT_KEYLEN = 32; // AES-256
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function deriveKey(applicationKey: string, salt: Buffer): Buffer {
  return crypto.scryptSync(applicationKey, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
}

export function encrypt(plaintext: Uint8Array, applicationKey: string): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(applicationKey, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, salt, iv, authTag, encrypted]);
}

export function decrypt(data: Buffer, applicationKey: string): Buffer {
  if (!isEncrypted(data)) {
    throw new Error("Data is not encrypted (missing B2EN header)");
  }

  let offset = MAGIC.length;
  const salt = data.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = data.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const authTag = data.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const ciphertext = data.subarray(offset);

  const key = deriveKey(applicationKey, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isEncrypted(data: Buffer): boolean {
  if (data.length < HEADER_LEN) return false;
  return data.subarray(0, MAGIC.length).equals(MAGIC);
}
