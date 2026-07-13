import { useState } from 'react';
import { Profile } from '@deem/shared';
import { api } from '../api';

interface LoginForm {
  name: string;
  email: string;
  password: string;
}

export default function Login({ onLogin }: { onLogin: (profile: Profile) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState<LoginForm>({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof LoginForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      onLogin(await api.post<Profile>(mode === 'login' ? '/api/login' : '/api/register', form));
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  return (
    <div className="app">
      <div className="login-wrap card">
        <div className="kicker">Desktop-first AI engineering</div>
        <h1 style={{ fontFamily: 'Georgia, serif', margin: '4px 0 2px' }}>Deem</h1>
        <p className="lead">
          Describe a task in plain English. Deem plans, implements, reviews, tests and reports —
          with consistent quality, on every run.
        </p>
        <div className="row" style={{ marginBottom: 4 }}>
          <button className={`pill small ${mode === 'login' ? 'primary' : ''}`} onClick={() => setMode('login')}>Sign in</button>
          <button className={`pill small ${mode === 'register' ? 'primary' : ''}`} onClick={() => setMode('register')}>Create account</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'register' && (
            <label className="field">
              <span className="lab">Name</span>
              <input className="text" value={form.name} onChange={set('name')} placeholder="Aiko Sato" required />
            </label>
          )}
          <label className="field">
            <span className="lab">Email</span>
            <input className="text" type="email" value={form.email} onChange={set('email')} placeholder="aiko@example.com" required />
          </label>
          <label className="field">
            <span className="lab">Password</span>
            <input className="text" type="password" value={form.password} onChange={set('password')} required minLength={4} />
          </label>
          {err && <p style={{ color: '#a03325' }}>{err}</p>}
          <button className="pill primary" type="submit">{mode === 'login' ? 'Sign in' : 'Create account & enter'}</button>
        </form>
      </div>
    </div>
  );
}
