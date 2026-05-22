/**
 * HMAC-SHA256 envelope signing/verification for tournament_config payloads.
 *
 * Uses Web Crypto's SubtleCrypto so the module runs in both Node (>=18) and
 * Edge runtimes without any imports. Bodies are canonicalized via deep
 * key-sorted JSON.stringify before hashing so signatures are deterministic
 * regardless of property ordering.
 *
 * Reference: specs/008-configuration/tasks.md T019.
 */

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * Recursively sort object keys alphabetically so the canonical JSON form is
 * deterministic. Arrays preserve order; nested objects/arrays are
 * recursively normalized. Non-JSON values (undefined, functions) are dropped
 * by JSON.stringify naturally.
 */
function canonicalize(value: unknown): Json {
  if (value === null || typeof value !== 'object') {
    return value as Json;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: { [key: string]: Json } = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

/**
 * Produce the canonical JSON string for `body`. This is what gets HMAC'd.
 */
function canonicalJson(body: object): string {
  return JSON.stringify(canonicalize(body));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Sign `body` with `secret` using HMAC-SHA256 over the canonical JSON form.
 * Returns a lowercase hex string.
 */
export async function signEnvelope(body: object, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(canonicalJson(body));
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Constant-time hex string comparison to thwart timing attacks.
 * Both inputs must be strings of equal length to return true.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Re-sign `envelope.body` with `secret` and compare in constant time to
 * `envelope.signature`. Returns true iff the signature matches.
 */
export async function verifyEnvelope(
  envelope: { body: object; signature: string },
  secret: string,
): Promise<boolean> {
  const expected = await signEnvelope(envelope.body, secret);
  return constantTimeEqualHex(expected, envelope.signature);
}
