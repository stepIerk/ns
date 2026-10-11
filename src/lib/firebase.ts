import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  type Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  type Firestore,
} from 'firebase/firestore';
import { getDatabase, type Database } from 'firebase/database';

function readEnv(name: string): string {
  return (import.meta.env[name] as string | undefined)?.trim() ?? '';
}

export const firebaseConfig = {
  apiKey: readEnv('VITE_FIREBASE_API_KEY'),
  authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: readEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: readEnv('VITE_FIREBASE_APP_ID'),
};

export const isFirebaseConfigured =
  !!firebaseConfig.apiKey && !!firebaseConfig.projectId && !!firebaseConfig.appId;

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let rtdb: Database | null = null;
let persistenceSet = false;

export function getFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } | null {
  if (!isFirebaseConfigured) return null;
  if (app && auth && db) return { app, auth, db };

  if (getApps().length === 0) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApps()[0]!;
  }
  auth = getAuth(app);
  if (!persistenceSet) {
    persistenceSet = true;
    // Сохраняем сессию локально: после перезапуска пароль не нужен.
    setPersistence(auth, browserLocalPersistence).catch((e) => {
      console.warn('[auth] persistence failed', e);
    });
  }
  try {
    // Обычный стриминг WebChannel, но с авто-детектом long-polling:
    // если сеть/блокировщик режет потоковые ответы Firestore (симптом:
    // снапшоты только из кэша, fromCache=true, счётчик snapshots стоит),
    // SDK сам переключится на long-polling и данные пойдут.
    db = initializeFirestore(app, {
      localCache: persistentLocalCache(),
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    db = getFirestore(app);
  }
  return { app, auth, db };
}

/**
 * Realtime Database для presence/typing/receipts (онлайн, печатает, seen).
 * Нужен VITE_FIREBASE_DATABASE_URL (URL инстанса из консоли). Без него —
 * null, presence тихо отключена, остальное работает как раньше.
 */
export function getRtdb(): Database | null {
  const fb = getFirebase();
  if (!fb) return null;
  // Слэш в конце URL допускаем — отрезаем (getDatabase хочет чистый origin).
  const url = readEnv('VITE_FIREBASE_DATABASE_URL').replace(/\/+$/, '');
  if (!url) return null;
  if (!rtdb) {
    try {
      rtdb = getDatabase(fb.app, url);
    } catch {
      return null;
    }
  }
  return rtdb;
}
