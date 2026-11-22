import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, type KeyObject } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const VERSION = 1;
const SCRYPT_OPTIONS = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface EncryptedSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedSyncPayload {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function decodeKey(key: Buffer | Uint8Array): Buffer {
  const normalized = Buffer.from(key);
  if (normalized.length !== KEY_BYTES) throw new Error("Invalid sync encryption key");
  return normalized;
}

function encryptBytes(plaintext: Buffer, key: Buffer, aad?: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, decodeKey(key), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptBytes(payload: EncryptedSecret, key: Buffer, aad?: string): Buffer {
  if (!payload || payload.version !== VERSION || typeof payload.iv !== "string" || payload.iv.length > 24
    || typeof payload.tag !== "string" || payload.tag.length > 32
    || typeof payload.ciphertext !== "string" || payload.ciphertext.length > 36 * 1024 * 1024) throw new Error("Unsupported sync ciphertext");
  const iv = Buffer.from(payload.iv, "base64url");
  const tag = Buffer.from(payload.tag, "base64url");
  const ciphertext = Buffer.from(payload.ciphertext, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new Error("Invalid sync ciphertext");
  }
  const decipher = createDecipheriv(ALGORITHM, decodeKey(key), iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypt a remote node login credential under the local private sync key. */
export function encryptSyncSecret(secret: string, key: Buffer | Uint8Array): EncryptedSecret {
  return encryptBytes(Buffer.from(secret, "utf8"), decodeKey(key));
}

export function decryptSyncSecret(payload: EncryptedSecret, key: Buffer | Uint8Array): string {
  return decryptBytes(payload, decodeKey(key)).toString("utf8");
}

function derivePasswordKey(password: string, salt: Buffer): Buffer {
  if (!password) throw new Error("Pi Web password is required for sync");
  return scryptSync(password, salt, KEY_BYTES, SCRYPT_OPTIONS);
}

/** Encrypt with the ephemeral exchange secret; login passwords authenticate HTTP only. */
export function encryptSyncPayload(value: unknown, exchangeSecret: string, aad: string): EncryptedSyncPayload {
  const salt = randomBytes(SALT_BYTES);
  const key = derivePasswordKey(exchangeSecret, salt);
  const encrypted = encryptBytes(Buffer.from(JSON.stringify(value), "utf8"), key, aad);
  return { ...encrypted, salt: salt.toString("base64url") };
}

/** No ambient-password fallback: every message must belong to an exchange. */
export function decryptSyncPayload(
  payload: EncryptedSyncPayload,
  aad: string,
  exchangeSecret: string,
): unknown {
  if (!exchangeSecret) throw new Error("Synchronization exchange secret is required");
  if (!payload || payload.version !== VERSION || typeof payload.salt !== "string" || payload.salt.length > 32) throw new Error("Unsupported sync ciphertext");
  const salt = Buffer.from(payload.salt, "base64url");
  if (salt.length !== SALT_BYTES) throw new Error("Invalid sync ciphertext");
  const encrypted: EncryptedSecret = {
    version: VERSION,
    iv: payload.iv,
    tag: payload.tag,
    ciphertext: payload.ciphertext,
  };
  try { return JSON.parse(decryptBytes(encrypted, derivePasswordKey(exchangeSecret, salt), aad).toString("utf8")) as unknown; }
  catch { throw new Error("Invalid encrypted synchronization payload"); }
}

export function generateSyncKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Per-request X25519 keys. Private keys stay in memory and expire with the nonce. */
export function createSyncExchange(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url") };
}

export function syncExchangeSecret(privateKey: KeyObject, peerPublicKey: string, nonce: string): string {
  if (typeof peerPublicKey !== "string" || peerPublicKey.length > 100) throw new Error("Invalid sync exchange key");
  try {
    const publicKey = createPublicKey({ key: Buffer.from(peerPublicKey, "base64url"), format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "x25519") throw new Error();
    const shared = diffieHellman({ privateKey, publicKey });
    return Buffer.from(hkdfSync("sha256", shared, nonce, "pi-web-sync:v1", 32)).toString("base64url");
  } catch { throw new Error("Invalid sync exchange key"); }
}
