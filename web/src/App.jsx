import React, { useEffect, useState, createContext, useContext } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { Kicker } from './components/ui.jsx';
import Login from './pages/Login.jsx';

const ProfileCtx = createContext(null);
export const useProfile = () => useContext(ProfileCtx);

function WorkspaceSettings({ onClose }) {
  const [form, setForm] = useState({ telegramToken: '', defaultTokenBudget: 500000 });
  const [current, setCurrent] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/api/settings').then((s) => {
      setCurrent(s);
      setForm((f) => ({ ...f, defaultTokenBudget: s.defaultTokenBudget }));
    });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    const patch = { defaultTokenBudget: Number(form.defaultTokenBudget) };
    if (form.telegramToken.trim()) patch.telegramToken = form.telegramToken.trim();
    await api.patch('/api/settings', patch);
    setSaved(true);
    setTimeout(onClose, 700);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <Kicker>Workspace settings</Kicker>
        <h2>Integrations & budgets</h2>
        <label className="field">
          <span className="lab">Telegram bot token</span>
          <input
            className="text"
            value={form.telegramToken}
            onChange={(e) => setForm({ ...form, telegramToken: e.target.value })}
            placeholder={current?.telegramConfigured ? `configured (${current.telegramToken}) — paste to replace` : 'paste a token from @BotFather to enable chat control'}
          />
          <span className="hint">
            With a token set, message your bot on Telegram: the same commands as the Command Center.
            Leave blank to keep the current value.
          </span>
        </label>
        <label className="field" style={{ maxWidth: 280 }}>
          <span className="lab">Default token budget per task</span>
          <input className="text" type="number" min="1000" step="1000" value={form.defaultTokenBudget}
            onChange={(e) => setForm({ ...form, defaultTokenBudget: e.target.value })} />
          <span className="hint">Runs stop retrying when a task exhausts its budget.</span>
        </label>
        <div className="row">
          <button className="pill primary" type="submit">{saved ? 'Saved ✓' : 'Save settings'}</button>
          <button className="pill" type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState(undefined); // undefined = loading
  const [settings, setSettings] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/api/profile').then(setProfile).catch(() => setProfile(null));
  }, []);

  if (profile === undefined) return null;
  if (!profile) return <Login onLogin={setProfile} />;

  const logout = async () => {
    await api.post('/api/logout');
    setProfile(null);
    navigate('/');
  };

  return (
    <ProfileCtx.Provider value={profile}>
      <div className="app">
        <header className="topbar">
          <Link to="/" className="brand">
            <div className="kicker">Desktop-first AI engineering</div>
            <h1>Deem</h1>
          </Link>
          <div className="topbar-right">
            <span className="badge blue">Multi-agent</span>
            <span className="badge green">Runner ready</span>
            <Link to="/" className="pill">Home</Link>
            <Link to="/chat" className="pill">Command Center</Link>
            <button className="pill" onClick={() => setSettings(true)}>Settings</button>
            <div className="account">
              <div>
                <div className="name">{profile.name}</div>
                <div className="email">{profile.email}</div>
              </div>
              <button className="pill" onClick={logout}>Log out</button>
            </div>
          </div>
        </header>
        <Outlet />
        {settings && <WorkspaceSettings onClose={() => setSettings(false)} />}
      </div>
    </ProfileCtx.Provider>
  );
}
