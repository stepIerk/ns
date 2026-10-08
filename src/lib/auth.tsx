/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { getFirebase, isFirebaseConfigured } from './firebase';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  configured: isFirebaseConfigured,
  signIn: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(isFirebaseConfigured);

  useEffect(() => {
    const fb = getFirebase();
    if (!fb) return;
    const unsub = onAuthStateChanged(fb.auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  const signIn = async (email: string, password: string) => {
    const fb = getFirebase();
    if (!fb) throw new Error('Firebase не настроен (нет VITE_ переменных)');
    await signInWithEmailAndPassword(fb.auth, email.trim(), password);
  };

  const logout = async () => {
    const fb = getFirebase();
    if (!fb) return;
    await signOut(fb.auth);
  };

  return (
    <Ctx.Provider value={{ user, loading, configured: isFirebaseConfigured, signIn, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  return useContext(Ctx);
}
