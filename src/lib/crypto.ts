// AES-256-GCM через WebCrypto. Plaintext никогда не покидает устройство.

const QR_PREFIX = 'ns1.';

export function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function generateRoomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** Экспорт ключа в компактную строку для QR / ручного ввода. */
export async function exportRoomKeyToString(key: CryptoKey): Promise<string> {
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { k?: string };
  if (!jwk.k) throw new Error('key export failed');
  return `${QR_PREFIX}${jwk.k}`;
}

export async function importRoomKeyFromString(s: string): Promise<CryptoKey> {
  const raw = s.trim().replace(/^ns1\./, '').replace(/\s+/g, '');
  if (raw.length < 20) throw new Error('Слишком короткий код ключа');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'oct', k: raw, alg: 'A256GCM', ext: true },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

function randomIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
}

export async function encryptText(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ivB64: string; ctB64: string }> {
  const iv = randomIv();
  const data = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { ivB64: bufToB64(iv), ctB64: bufToB64(ct) };
}

export async function decryptText(
  key: CryptoKey,
  ivB64: string,
  ctB64: string,
): Promise<string> {
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}

export async function encryptBytes(
  key: CryptoKey,
  data: ArrayBuffer,
): Promise<{ ivB64: string; cipher: ArrayBuffer }> {
  const iv = randomIv();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { ivB64: bufToB64(iv), cipher: ct };
}

export async function decryptBytes(
  key: CryptoKey,
  ivB64: string,
  cipher: ArrayBuffer,
): Promise<ArrayBuffer> {
  const iv = b64ToBytes(ivB64);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, cipher);
}
