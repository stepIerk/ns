// Локальное зеркало для экономии запросов к серверу (подробный план — в переписке).
//
// Две независимые базы (падают независимо, версионируются независимо):
// - ns-msgs-v1: зеркало документов сообщений, FIFO 10000 (старейшие удаляются).
//   Храним только plain-поля (никаких Firestore Timestamp — не клонируются).
// - ns-media-v1: расшифрованные блобы фото, FIFO ~2 ГБ по времени записи.
//
// Правила: все операции могут кидать (нет IDB / квота / iOS-причуды) —
// вызывающий код ВСЕГДА ловит и падает обратно на сеть/память, рендер
// никогда не блокируется на IDB.

export interface StoredMsg {
  id: string; // firestore doc id
  ts: number; // clientTs — тот же порядок, что orderBy('clientTs')
  clientMessageId: string;
  senderId: string;
  kind: 'text' | 'photo';
  ciphertext?: string;
  iv?: string;
  mediaId?: string;
  driveFileId?: string;
  mimeType?: string;
  size?: number;
}

export interface CachedBlob {
  blob: Blob;
  size: number;
  mime: string;
}

const MSG_DB = 'ns-msgs-v1';
const MEDIA_DB = 'ns-media-v1';
const MSG_STORE = 'messages';
const BLOB_STORE = 'blobs';
const META_STORE = 'meta';
const MSG_TS_INDEX = 'by-ts'; // compound ['ts','id'] — чистые курсоры без дублей
const BLOB_STORED_INDEX = 'by-stored'; // storedAt — FIFO-вытеснение

export const MSG_CAP = 10000;
export const MEDIA_BYTES_CAP = 2 * 1024 * 1024 * 1024;

function openDb(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
    req.onblocked = () => reject(new Error('idb blocked'));
  });
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let failed: unknown = null;
    let settled = false;
    const t = db.transaction(stores, mode);
    t.oncomplete = () => {
      if (!settled) {
        settled = true;
        if (failed) reject(failed);
        else resolve(result);
      }
    };
    t.onerror = () => {
      if (!settled) {
        settled = true;
        reject(t.error ?? new Error('idb txn failed'));
      }
    };
    t.onabort = () => {
      if (!settled) {
        settled = true;
        reject(t.error ?? failed ?? new Error('idb txn aborted'));
      }
    };
    void Promise.resolve()
      .then(() => run(t))
      .then((r) => {
        result = r;
      })
      .catch((e) => {
        failed = e;
        try {
          t.abort();
        } catch {
          // ignore
        }
      });
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('idb request failed'));
  });
}

// Cursor.openCursor().continue() возвращает void — новый курсор приходит
// повторным onsuccess исходного запроса. Поэтому итерация — хелперами ниже,
// а не через req().
function collect<T>(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | null,
  dir: IDBCursorDirection,
  limit: number,
  map: (c: IDBCursorWithValue) => T,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const out: T[] = [];
    const rq = source.openCursor(range, dir);
    rq.onerror = () => reject(rq.error ?? new Error('cursor failed'));
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(map(c));
      c.continue();
    };
  });
}

function deleteWhere(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | null,
  dir: IDBCursorDirection,
  pred: (c: IDBCursorWithValue) => boolean,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let n = 0;
    const rq = source.openCursor(range, dir);
    rq.onerror = () => reject(rq.error ?? new Error('cursor failed'));
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c || !pred(c)) {
        resolve(n);
        return;
      }
      const del = c.delete();
      del.onerror = () => reject(del.error ?? new Error('delete failed'));
      del.onsuccess = () => {
        n += 1;
        c.continue();
      };
    };
  });
}

let msgDb: IDBDatabase | null = null;
let mediaDb: IDBDatabase | null = null;

async function getMsgDb(): Promise<IDBDatabase> {
  if (msgDb) return msgDb;
  msgDb = await openDb(MSG_DB, 1, (db) => {
    const s = db.createObjectStore(MSG_STORE, { keyPath: 'id' });
    s.createIndex(MSG_TS_INDEX, ['ts', 'id'], { unique: false });
    db.createObjectStore(META_STORE);
  });
  return msgDb;
}

async function getMediaDb(): Promise<IDBDatabase> {
  if (mediaDb) return mediaDb;
  mediaDb = await openDb(MEDIA_DB, 1, (db) => {
    const s = db.createObjectStore(BLOB_STORE, { keyPath: 'mediaId' });
    s.createIndex(BLOB_STORED_INDEX, 'storedAt', { unique: false });
    db.createObjectStore(META_STORE);
  });
  return mediaDb;
}

// ---------- Сообщения ----------

export async function msgPut(batch: StoredMsg[]): Promise<void> {
  if (batch.length === 0) return;
  const db = await getMsgDb();
  await tx(db, [MSG_STORE], 'readwrite', (t) => {
    const s = t.objectStore(MSG_STORE);
    for (const m of batch) s.put(m);
  });
}

export async function msgCount(): Promise<number> {
  const db = await getMsgDb();
  return tx(db, [MSG_STORE], 'readonly', (t) => req(t.objectStore(MSG_STORE).count()));
}

/** Новейшие N (для мгновенного старта из кэша). */
export async function msgNewest(n: number): Promise<StoredMsg[]> {
  const db = await getMsgDb();
  const rows = await tx(db, [MSG_STORE], 'readonly', (t) =>
    collect<StoredMsg>(t.objectStore(MSG_STORE).index(MSG_TS_INDEX), null, 'prev', n, (c) => c.value as StoredMsg),
  );
  return rows.reverse(); // по возрастанию, как в ленте
}

/** Старше (ts,id) — постраничная подгрузка вверх. Возвращает по возрастанию. */
export async function msgOlderThan(ts: number, id: string, n: number): Promise<StoredMsg[]> {
  const db = await getMsgDb();
  const range = IDBKeyRange.upperBound([ts, id], true); // строго старше
  const rows = await tx(db, [MSG_STORE], 'readonly', (t) =>
    collect<StoredMsg>(t.objectStore(MSG_STORE).index(MSG_TS_INDEX), range, 'prev', n, (c) => c.value as StoredMsg),
  );
  return rows.reverse();
}

/** FIFO: режем старейшие, пока count <= cap. Возвращает сколько удалили. */
export async function msgTrim(cap: number = MSG_CAP): Promise<number> {
  const db = await getMsgDb();
  return tx(db, [MSG_STORE], 'readwrite', async (t) => {
    const store = t.objectStore(MSG_STORE);
    const total = await req(store.count());
    let over = total - cap;
    if (over <= 0) return 0;
    return deleteWhere(store.index(MSG_TS_INDEX), null, 'next', () => {
      if (over <= 0) return false;
      over -= 1;
      return true;
    });
  });
}

// ---------- Медиа (блобы) ----------

async function metaBytes(t: IDBTransaction): Promise<number> {
  const v = await req(t.objectStore(META_STORE).get('bytes'));
  return typeof v === 'number' ? v : 0;
}

/** FIFO-вытеснение до лимита. Вызывать внутри readwrite-транзакции blobs+meta. */
async function trimBlobs(t: IDBTransaction, cap: number): Promise<void> {
  const store = t.objectStore(BLOB_STORE);
  const meta = t.objectStore(META_STORE);
  let bytes = await metaBytes(t);
  if (bytes > cap) {
    await deleteWhere(store.index(BLOB_STORED_INDEX), null, 'next', (c) => {
      if (bytes <= cap) return false;
      const v = c.value as { size?: unknown };
      bytes = Math.max(0, bytes - (typeof v.size === 'number' ? v.size : 0));
      return true;
    });
  }
  await req(meta.put(bytes, 'bytes'));
}

export async function blobGet(mediaId: string): Promise<CachedBlob | null> {
  const db = await getMediaDb();
  const v = await tx(db, [BLOB_STORE], 'readonly', (t) =>
    req(t.objectStore(BLOB_STORE).get(mediaId)),
  );
  const r = v as { blob?: unknown; size?: unknown; mime?: unknown } | undefined;
  if (!r || !(r.blob instanceof Blob) || typeof r.size !== 'number') return null;
  return { blob: r.blob, size: r.size, mime: typeof r.mime === 'string' ? r.mime : 'image/jpeg' };
}

export async function blobPut(mediaId: string, blob: Blob, mime: string): Promise<void> {
  const size = blob.size;
  const storedAt = Date.now();
  const write = async () => {
    const db = await getMediaDb();
    await tx(db, [BLOB_STORE, META_STORE], 'readwrite', async (t) => {
      t.objectStore(BLOB_STORE).put({ mediaId, blob, size, mime, storedAt });
      const meta = t.objectStore(META_STORE);
      const bytes = await metaBytes(t);
      await req(meta.put(bytes + size, 'bytes'));
      await trimBlobs(t, MEDIA_BYTES_CAP);
    });
  };
  try {
    await write();
  } catch (e) {
    // Квота/причуды iOS: режем половину старейшего и пробуем разок ещё.
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      const db = await getMediaDb();
      await tx(db, [BLOB_STORE, META_STORE], 'readwrite', (t) =>
        trimBlobs(t, Math.floor(MEDIA_BYTES_CAP / 2)),
      ).catch(() => {});
      await write();
    } else {
      throw e;
    }
  }
}

export async function dbStats(): Promise<{ msgs: number; blobs: number; bytes: number }> {
  const msgDb = await getMsgDb();
  const msgs = await tx(msgDb, [MSG_STORE], 'readonly', (t) =>
    req(t.objectStore(MSG_STORE).count()),
  );
  const mediaDb = await getMediaDb();
  const [blobs, bytes] = await tx(mediaDb, [BLOB_STORE, META_STORE], 'readonly', async (t) => [
    await req(t.objectStore(BLOB_STORE).count()),
    await metaBytes(t),
  ]);
  return { msgs, blobs, bytes };
}

// ---------- Хранилище устройства ----------

/** Просим систему не вычищать origin при нехватке места (особенно Safari). */
export async function ensurePersist(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    // ignore
  }
  return false;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
    }
  } catch {
    // ignore
  }
  return null;
}
