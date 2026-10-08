import { doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { getFirebase } from './firebase';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // Относительно BASE_URL: работает и в корне (Vercel), и в подпути (GH Pages /ns/).
    const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    return reg;
  } catch (e) {
    console.warn('[push] sw register failed', e);
    return null;
  }
}

/** Запросить permission, подписать и сохранить subscription в Firestore. */
export async function enablePush(uid: string): Promise<void> {
  const vapid = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim();
  if (!vapid) throw new Error('Нет VITE_VAPID_PUBLIC_KEY');
  if (!('Notification' in window) || !('PushManager' in window)) {
    throw new Error('Push не поддерживается этим браузером');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Разрешение на уведомления не выдано');

  const reg = (await navigator.serviceWorker.ready.catch(() => null)) ?? (await registerSW());
  if (!reg) throw new Error('Service Worker не зарегистрирован');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid) as unknown as ArrayBuffer,
  });
  const fb = getFirebase();
  if (!fb) throw new Error('Firebase не настроен');
  await setDoc(
    doc(fb.db, 'pushSubscriptions', uid),
    { subscription: sub.toJSON(), updatedAt: serverTimestamp(), userAgent: navigator.userAgent },
    { merge: true },
  );
}

export async function disablePush(uid: string): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // ignore
  }
  const fb = getFirebase();
  if (fb) {
    try {
      await deleteDoc(doc(fb.db, 'pushSubscriptions', uid));
    } catch {
      // ignore
    }
  }
}

export async function hasPushSubscription(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}
