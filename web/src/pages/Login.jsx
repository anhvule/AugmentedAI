import React, { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    onLogin(await api.post('/api/profile', { name, email }));
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
        <form onSubmit={submit}>
          <label className="field">
            <span className="lab">Name</span>
            <input className="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Aiko Sato" required />
          </label>
          <label className="field">
            <span className="lab">Email</span>
            <input className="text" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aiko@example.com" required />
          </label>
          <button className="pill primary" type="submit">Enter workspace</button>
        </form>
      </div>
    </div>
  );
}
