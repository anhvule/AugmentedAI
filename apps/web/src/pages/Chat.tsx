import { useEffect, useRef, useState } from 'react';
import { api, useEvents } from '../api';
import { Kicker } from '../components/ui';

interface ChatMessage {
  id?: string;
  message: string;
  reply: string;
  source: string;
  ts: number;
}

export default function Chat() {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.get<ChatMessage[]>('/api/chat').then(setHistory);
  }, []);
  useEvents((type, payload) => {
    if (type === 'chat' && payload.source === 'telegram') {
      setHistory((h) => [...h, payload]);
    }
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    try {
      const { reply } = await api.post<{ reply: string }>('/api/chat', { message });
      setHistory((h) => [...h, { message, reply, source: 'web', ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 860, margin: '0 auto' }}>
      <Kicker>Chat control</Kicker>
      <h2>Command Center</h2>
      <p className="lead">
        Drive the whole workspace from chat — the same commands work from Telegram once a bot
        token is set in workspace settings. Try <code>help</code>, <code>status</code>, or{' '}
        <code>new task in &lt;project&gt;: &lt;name&gt; | &lt;description&gt; | &lt;req1; req2&gt;</code>.
      </p>
      <div className="logbox" style={{ maxHeight: 460, minHeight: 260 }}>
        {history.length === 0 && <div>No messages yet — say “help”.</div>}
        {history.map((m, i) => (
          <div key={m.id || i} style={{ marginBottom: 10 }}>
            <div style={{ color: '#9ecbff' }}>
              <span className="ts">{new Date(m.ts).toLocaleTimeString()}</span>
              {m.source === 'telegram' ? '📱' : '»'} {m.message}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.reply}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="row" style={{ marginTop: 14 }} onSubmit={send}>
        <input
          className="text"
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. new task in Vite3: Add dark mode | Toggle in header | Preference persists'
          autoFocus
        />
        <button className="pill primary" disabled={busy} type="submit">Send</button>
      </form>
    </div>
  );
}
