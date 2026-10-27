import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Passwort-Hash im Format scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, N, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/**
 * Verschlüsselung für Sicherungen: AES-256-GCM, Schlüssel per scrypt aus Passphrase.
 * Aufbau: "APB1" | salt(16) | iv(12) | tag(16) | daten
 */
const MAGIC = Buffer.from('APB1');

async function deriveKey(passphrase: string, salt: Buffer) {
  return scrypt(passphrase, salt, 32, PARAMS);
}

export async function encryptBuffer(data: Buffer, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]);
}

export async function decryptBuffer(blob: Buffer, passphrase: string): Promise<Buffer> {
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('Keine AperioPlan-Sicherung');
  const salt = blob.subarray(4, 20);
  const iv = blob.subarray(20, 32);
  const tag = blob.subarray(32, 48);
  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(48)), decipher.final()]);
  } catch {
    throw new Error('Falsches Passwort oder beschädigte Sicherung');
  }
}
