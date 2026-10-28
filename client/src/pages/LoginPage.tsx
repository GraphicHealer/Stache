import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../context';

/**
 * Sign in, or create the first household account when no users exist yet
 * (server reports that via /api/setup - sign-up is closed afterward).
 */
export function LoginPage() {
  const { setUser } = useApp();
  const [setup, setSetup] = useState<boolean | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/api/setup').then((r) => setSetup(r.needs_setup)).catch(() => setSetup(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (setup) {
        await api.post('/api/auth/sign-up/email', {
          name: form.name.trim() || form.email.split('@')[0],
          email: form.email.trim(),
          password: form.password,
        });
      } else {
        await api.post('/api/auth/sign-in/email', {
          email: form.email.trim(),
          password: form.password,
        });
      }
      const me = await api.get('/api/me');
      setUser(me.user);
    } catch (err) {
      setError((err as Error).message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  if (setup === null) return <div className="page"><p className="muted">…</p></div>;

  return (
    <div className="page login">
      <div className="login-brand">
        <img className="login-logo" src="/icon.svg" alt="" />
        <h1>Stache</h1>
        <p className="login-tagline">Where is my stuff?</p>
      </div>
      <p className="muted">
        {setup ? 'Create the first household account.' : 'Sign in to your household.'}
      </p>
      <form onSubmit={submit}>
        {setup && (
          <input
            className="input"
            placeholder="Your name"
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        )}
        <input
          className="input"
          type="email"
          placeholder="Email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <input
          className="input"
          type="password"
          placeholder={setup ? 'Password (8+ characters)' : 'Password'}
          autoComplete={setup ? 'new-password' : 'current-password'}
          required
          minLength={8}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-big" disabled={busy}>
          {setup ? 'Create account' : 'Sign in'}
        </button>
      </form>
      {setup && (
        <p className="muted">Everyone else gets added later from Settings → Household.</p>
      )}
    </div>
  );
}
