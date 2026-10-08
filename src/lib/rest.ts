// Плоскость данных через Firestore REST вместо SDK-стримов.
// Стриминг WebChannel в части сетей устанавливается и тут же рвётся по кругу
// (каждый рестарт перечитывает документы — горят reads, сообщения не ходят).
// REST — обычные короткие HTTPS-запросы: проходят там, где стримы мёртвы.
// Правила Firestore те же, авторизация — Bearer Firebase ID token.
import { getFirebase } from './firebase';

function projectId(): string {
  const pid = (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim() ?? '';
  if (!pid) throw new Error('Firebase не настроен');
  return pid;
}

function base(): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const fb = getFirebase();
  if (!fb?.auth.currentUser) throw new Error('Нет auth-сессии');
  const token = await fb.auth.currentUser.getIdToken();
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export function isoNow(): string {
  return new Date().toISOString();
}

type V =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: V[] } }
  | { mapValue: { fields?: Record<string, V> } };

export function toV(v: unknown): V {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number' && Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === 'number') return { stringValue: String(v) }; // чисел с точкой у нас нет; храним строкой
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toV) } };
  if (typeof v === 'object') {
    const fields: Record<string, V> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      fields[k] = toV((v as Record<string, unknown>)[k]);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

export function fromV(v: V): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromV);
  if ('mapValue' in v) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v.mapValue.fields ?? {})) out[k] = fromV(v.mapValue.fields![k]!);
    return out;
  }
  return null;
}

export function fromFields(fields: Record<string, V> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) out[k] = fromV(fields[k]!);
  return out;
}

function toFields(obj: Record<string, unknown>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of Object.keys(obj)) out[k] = toV(obj[k]);
  return out;
}

async function check(res: Response, what: string): Promise<unknown> {
  if (res.ok) return res.status === 204 ? null : ((await res.json()) as unknown);
  const text = await res.text().catch(() => '');
  throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 160)}`);
}

function docIdFromName(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] ?? name;
}

/** Создать документ со случайным ID. Возвращает ID. */
export async function restCreate(collectionPath: string, fields: Record<string, unknown>): Promise<string> {
  const h = await authHeaders();
  const res = await fetch(`${base()}/${collectionPath}`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ fields: toFields(fields) }),
  });
  const data = (await check(res, 'create')) as { name: string };
  return docIdFromName(data.name);
}

/** Перезаписать документ целиком (merge для наших плоских структур). */
export async function restSet(docPath: string, fields: Record<string, unknown>): Promise<void> {
  const h = await authHeaders();
  const res = await fetch(`${base()}/${docPath}`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ fields: toFields(fields) }),
  });
  await check(res, 'set');
}

/** Частичное обновление полей. */
export async function restPatch(docPath: string, fields: Record<string, unknown>): Promise<void> {
  const h = await authHeaders();
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${base()}/${docPath}?${mask}`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ fields: toFields(fields) }),
  });
  await check(res, 'patch');
}

export async function restDelete(docPath: string): Promise<void> {
  const h = await authHeaders();
  const res = await fetch(`${base()}/${docPath}`, { method: 'DELETE', headers: h });
  if (res.status !== 200 && res.status !== 404) await check(res, 'delete');
}

export interface RestDoc {
  id: string;
  data: Record<string, unknown>;
}

async function runQuery(parent: string, structuredQuery: unknown): Promise<RestDoc[]> {
  const h = await authHeaders();
  const res = await fetch(`${base()}:runQuery`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ parent: `${base()}/${parent}`, structuredQuery }),
  });
  const rows = (await check(res, 'query')) as Array<{ document?: { name: string; fields: Record<string, V> } }>;
  const out: RestDoc[] = [];
  for (const r of rows) {
    if (r.document) out.push({ id: docIdFromName(r.document.name), data: fromFields(r.document.fields) });
  }
  return out;
}

const MESSAGES_PARENT = 'rooms/main';

/** Самый свежий clientTs (1 read). null — сообщений пока нет. */
export async function restNewestTs(): Promise<number | null> {
  const docs = await runQuery(MESSAGES_PARENT, {
    from: [{ collectionId: 'messages' }],
    orderBy: [{ field: { fieldPath: 'clientTs' }, direction: 'DESCENDING' }],
    limit: 1,
  });
  if (docs.length === 0) return null;
  const ts = docs[0]!.data.clientTs;
  return typeof ts === 'number' ? ts : null;
}

/** Все сообщения по возрастанию (для полной выборки при новом сообщении). */
export async function restFetchAll(limitN = 100): Promise<RestDoc[]> {
  const docs = await runQuery(MESSAGES_PARENT, {
    from: [{ collectionId: 'messages' }],
    orderBy: [{ field: { fieldPath: 'clientTs' }, direction: 'ASCENDING' }],
    limit: limitN,
  });
  return docs;
}
