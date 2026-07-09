import React, { useEffect, useState, createContext, useContext } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';

const ProfileCtx = createContext(null);
export const useProfile = () => useContext(ProfileCtx);

export default function App() {
  const [profile, setProfile] = useState(undefined); // undefined = loading
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
      </div>
    </ProfileCtx.Provider>
  );
}
