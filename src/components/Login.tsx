import { useState } from 'react';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!email.trim() || !password) {
      setErr('Введите email и пароль');
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="card">
        <h2>Вход</h2>
        <p className="muted">Только для двух пользователей. Регистрации нет.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {err && <div className="error">{err}</div>}
          <button type="submit" disabled={busy}>
            {busy ? 'Вход…' : 'Войти'}
          </button>
        </form>
        <p className="muted small">Сессия сохраняется на устройстве (browserLocalPersistence).</p>
      </div>
    </div>
  );
}
