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
    db = initializeFirestore(app, {
      localCache: persistentLocalCache(),
      // Стриминг WebChannel режется middlebox'ами (РФ): ответы теряют CORS
      // и SDK бесконечно переподключается. Long-polling через такие сети проходит.
      experimentalForceLongPolling: true,
      useFetchStreams: false,
    });
  } catch {
    db = getFirestore(app);
  }
  return { app, auth, db };
}
