import { getFirebase } from './firebase';

/** POST к serverless API с Firebase ID token. */
export async function authedPost<T>(path: string, body: unknown): Promise<T> {
  const fb = getFirebase();
  if (!fb?.auth.currentUser) throw new Error('Нет auth-сессии');
  const token = await fb.auth.currentUser.getIdToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ?? `API ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }
  return data as T;
}
