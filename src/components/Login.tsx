import { useState } from 'react';
import { Lock, LogIn } from 'lucide-react';
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
        <div className="auth-head">
          <div className="auth-logo">
            <Lock size={20} />
          </div>
          <h2>Вход</h2>
        </div>
        <p className="muted small">Личный мессенджер со сквозным шифрованием. Только для двух пользователей, регистрации нет.</p>
        <form onSubmit={submit}>
          <label className="field">
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              <LogIn size={17} /> {busy ? 'Вход…' : 'Войти'}
            </button>
          </div>
        </form>
        <p className="muted small">Сессия сохраняется на устройстве.</p>
      </div>
    </div>
  );
}
