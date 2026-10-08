import { get, set, del } from 'idb-keyval';
import { exportRoomKeyToString, importRoomKeyFromString } from './crypto';

// Храним JWK-строку (не CryptoKey) — надёжнее переживает перезапуски/клоны.
const STORE_KEY = 'ns-room-key-main-v1';

export async function loadRoomKey(): Promise<CryptoKey | null> {
  try {
    const raw = (await get<string>(STORE_KEY)) ?? null;
    if (!raw) return null;
    return await importRoomKeyFromString(raw);
  } catch (e) {
    console.warn('[keystore] load failed', e);
    return null;
  }
}

export async function saveRoomKeyString(raw: string): Promise<CryptoKey> {
  const key = await importRoomKeyFromString(raw);
  await set(STORE_KEY, raw.trim());
  return key;
}

export async function saveRoomKey(key: CryptoKey): Promise<void> {
  const raw = await exportRoomKeyToString(key);
  await set(STORE_KEY, raw);
}

export async function clearRoomKey(): Promise<void> {
  await del(STORE_KEY);
}
