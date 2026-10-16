/**
 * Nexora Nexus — Cryptographic Utilities
 *
 * Built strictly on the standard W3C Web Cryptography API (`crypto.subtle`).
 * Compatible with Cloudflare Workers runtime and Node.js 18+.
 *
 * Security parameters:
 * - PBKDF2-HMAC-SHA256
 * - 100,000 iterations
 * - 16-byte cryptographically secure random salt
 * - 256-bit derived key length
 * - Constant-time comparison to prevent timing attacks
 * - SHA-256 for opaque session token hashing
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

// Pre-computed dummy salt for constant-time mitigation when email is not found
const DUMMY_SALT_HEX = 'e1a49f50cb88167f08c345b10694e9f2';


/**
 * Converts a Uint8Array buffer to a lowercase hex string.
 * @param {Uint8Array} buffer
 * @returns {string}
 */
export function bufToHex(buffer) {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Converts a hex string to a Uint8Array buffer.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBuf(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return arr;
}

/**
 * Compares two strings in constant time to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/**
 * Derives a PBKDF2 key from password and salt.
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<string>} Hex representation of derived 256-bit key
 */
async function derivePbkdf2(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    KEY_BITS
  );
  return bufToHex(new Uint8Array(derivedBits));
}

/**
 * Hashes a password using PBKDF2-HMAC-SHA256 with a fresh random salt.
 * @param {string} password
 * @returns {Promise<{ hash: string, salt: string }>}
 */
export async function hashPassword(password) {
  const saltBuf = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltHex = bufToHex(saltBuf);
  const hashHex = await derivePbkdf2(password, saltBuf);
  return { hash: hashHex, salt: saltHex };
}

/**
 * Verifies a plaintext password against a stored PBKDF2 hash and salt.
 * @param {string} password
 * @param {string} storedHash
 * @param {string} storedSalt
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, storedHash, storedSalt) {
  try {
    const saltBuf = hexToBuf(storedSalt);
    const calculatedHash = await derivePbkdf2(password, saltBuf);
    return timingSafeEqual(calculatedHash, storedHash);
  } catch {
    return false;
  }
}

/**
 * Performs a dummy PBKDF2 derivation to equalize response timing when a user is not found.
 * Mitigates username enumeration timing attacks.
 * @param {string} password
 * @returns {Promise<void>}
 */
export async function performDummyPasswordCheck(password) {
  try {
    await derivePbkdf2(password, hexToBuf(DUMMY_SALT_HEX));
  } catch {
    // Suppress dummy error
  }
}

/**
 * Generates cryptographically secure random token bytes as a hex string.
 * @param {number} bytes - Number of random bytes (default 32 bytes = 256 bits entropy)
 * @returns {string}
 */
export function generateSecureToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return bufToHex(buf);
}

/**
 * Computes SHA-256 digest of a token.
 * Used to store only hashed tokens in the database.
 * @param {string} token
 * @returns {Promise<string>} Hex representation of SHA-256 digest
 */
export async function hashToken(token) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return bufToHex(new Uint8Array(digest));
}

/**
 * Generates a standard UUID v4 using crypto.randomUUID().
 * @returns {string}
 */
export function generateUuid() {
  return crypto.randomUUID();
}
