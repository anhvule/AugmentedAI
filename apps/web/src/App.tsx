import { useEffect, useState, createContext, useContext } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { Profile, Settings } from '@deem/shared';
import { api } from './api';
import { Kicker } from './components/ui';
import Login from './pages/Login';

const ProfileCtx = createContext<Profile | null>(null);
export const useProfile = () => useContext(ProfileCtx);

interface SettingsForm {
  telegramToken: string;
  defaultTokenBudget: number | string;
  maxConcurrentRuns: number | string;
  phaseTimeoutMinutes: number | string;
}

function WorkspaceSettings({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<SettingsForm>({ telegramToken: '', defaultTokenBudget: 500000, maxConcurrentRuns: 2, phaseTimeoutMinutes: 30 });
  const [current, setCurrent] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<Settings>('/api/settings').then((s) => {
      setCurrent(s);
      setForm((f) => ({
        ...f,
        defaultTokenBudget: s.defaultTokenBudget,
        maxConcurrentRuns: s.maxConcurrentRuns ?? 2,
        phaseTimeoutMinutes: s.phaseTimeoutMinutes ?? 30,
      }));
    });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch: Partial<Settings> = {
      defaultTokenBudget: Number(form.defaultTokenBudget),
      maxConcurrentRuns: Number(form.maxConcurrentRuns),
      phaseTimeoutMinutes: Number(form.phaseTimeoutMinutes),
    };
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
        <div className="grid2">
          <label className="field">
            <span className="lab">Max concurrent runs</span>
            <input className="text" type="number" min="1" max="8" value={form.maxConcurrentRuns}
              onChange={(e) => setForm({ ...form, maxConcurrentRuns: e.target.value })} />
            <span className="hint">Extra runs wait in a queue.</span>
          </label>
          <label className="field">
            <span className="lab">Phase timeout (minutes)</span>
            <input className="text" type="number" min="1" max="240" value={form.phaseTimeoutMinutes}
              onChange={(e) => setForm({ ...form, phaseTimeoutMinutes: e.target.value })} />
            <span className="hint">Hung agents are killed by the watchdog.</span>
          </label>
        </div>
        <div className="row">
          <button className="pill primary" type="submit">{saved ? 'Saved ✓' : 'Save settings'}</button>
          <button className="pill" type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined); // undefined = loading
  const [settings, setSettings] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Profile>('/api/profile').then(setProfile).catch(() => setProfile(null));
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
