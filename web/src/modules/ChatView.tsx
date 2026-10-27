import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { get, post, del, upload, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtDateTime, fmtTime } from '../lib/format';
import { Avatar, Empty, useAction } from '../components/ui';
import { VideoCall } from './Video';
import { Icon } from '../components/Icon';

export interface Message { id: string; channelId: string; userId: string; userName: string; body: string; attachments: { fileId: string; name: string; size: number }[]; createdAt: string; updatedAt: string; deletedAt: string | null }

/** Nachrichtenverlauf + Eingabe einer Unterhaltung (Projekt, Team oder Direktnachricht) */
export function ChatView({ channelId, title, height = 'calc(100vh - 48px)' }: { channelId: string; title: string; height?: string }) {
  const { me } = useSession();
  const act = useAction();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState<string | null>(null);
  const [call, setCall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastTyping = useRef(0);

  const scrollDown = () => requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; });

  useEffect(() => {
    setMessages([]);
    get<Message[]>(`/chat/channels/${channelId}/messages`).then((m) => { setMessages(m); setHasMore(m.length >= 60); scrollDown(); });
    void post(`/chat/channels/${channelId}/read`).then(() => invalidate('/chat/channels'));
    return realtime.subscribe(`chat:${channelId}`, (event, data) => {
      if (event === 'message.created') {
        setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
        setTyping(null);
        scrollDown();
        void post(`/chat/channels/${channelId}/read`);
      } else if (event === 'message.updated') setMessages((m) => m.map((x) => (x.id === data.id ? data : x)));
      else if (event === 'message.deleted') setMessages((m) => m.map((x) => (x.id === data.id ? { ...x, deletedAt: new Date().toISOString(), body: '' } : x)));
      else if (event === 'typing') {
        setTyping(data.displayName);
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(null), 3000);
      }
    });
  }, [channelId]);

  const send = async () => {
    if (!text.trim()) return;
    const body = text;
    setText('');
    const r = await act(() => post<Message>(`/chat/channels/${channelId}/messages`, { body }));
    if (r) { setMessages((m) => (m.some((x) => x.id === r.id) ? m : [...m, r])); scrollDown(); }
    else setText(body);
  };

  const attach = async (files: FileList) => {
    if (!files.length) return;
    setBusy(true);
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    try {
      const atts = await upload(`/chat/channels/${channelId}/upload`, fd);
      const r = await post<Message>(`/chat/channels/${channelId}/messages`, { body: text, attachments: atts });
      setText('');
      setMessages((m) => (m.some((x) => x.id === r.id) ? m : [...m, r]));
      scrollDown();
    } catch (e) { await act(() => Promise.reject(e)); }
    setBusy(false);
  };

  const loadMore = async () => {
    const older = await get<Message[]>(`/chat/channels/${channelId}/messages?before=${encodeURIComponent(messages[0]!.createdAt)}`);
    setMessages((m) => [...older, ...m]);
    setHasMore(older.length >= 60);
  };

  let lastDay = '';
  return (
    <div className="chat-main" style={{ height }}>
      <div className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)' }}>
        <b className="grow">{title}</b>
        <button className="btn sm" onClick={() => setCall(true)}><Icon name="video" /> Videoanruf</button>
      </div>
      <div className="chat-messages" ref={listRef}>
        {hasMore && <div style={{ textAlign: 'center' }}><button className="btn sm" onClick={loadMore}>Ältere Nachrichten laden</button></div>}
        {!messages.length && <Empty icon="chat" title="Noch keine Nachrichten">Schreiben Sie die erste Nachricht – @benutzername erwähnt Kollegen.</Empty>}
        {messages.map((m, i) => {
          const day = new Date(m.createdAt).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });
          const showDay = day !== lastDay;
          lastDay = day;
          const prev = messages[i - 1];
          const grouped = !showDay && prev && prev.userId === m.userId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60000;
          return (
            <div key={m.id}>
              {showDay && <div className="small muted" style={{ textAlign: 'center', margin: '12px 0' }}>{day}</div>}
              <div className="msg" style={{ paddingTop: grouped ? 0 : 6 }}>
                <div style={{ width: 24 }}>{!grouped && <Avatar id={m.userId} name={m.userName} />}</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  {!grouped && <div className="who">{m.userName}<span className="when" title={fmtDateTime(m.createdAt)}>{fmtTime(m.createdAt)}</span></div>}
                  {m.deletedAt ? <div className="body muted small">Nachricht gelöscht</div> : <div className="body">{renderBody(m.body)}</div>}
                  {!m.deletedAt && m.attachments?.map((a) => (
                    <a key={a.fileId} href={`/api/files/${a.fileId}/download${/\.(png|jpe?g|gif|webp)$/i.test(a.name) ? '?inline=1' : ''}`} target="_blank" rel="noreferrer" className="card row" style={{ display: 'inline-flex', padding: '6px 10px', marginTop: 4, marginRight: 6 }}>
                      {/\.(png|jpe?g|gif|webp)$/i.test(a.name) ? <img src={`/api/files/${a.fileId}/download?inline=1`} style={{ maxHeight: 160, maxWidth: 260, borderRadius: 6 }} /> : <><Icon name="paperclip" /> {a.name} <span className="muted small">{fmtBytes(a.size)}</span></>}
                    </a>
                  ))}
                </div>
                {m.userId === me?.id && !m.deletedAt && <button className="btn ghost sm" title="Löschen" style={{ opacity: 0.4 }} onClick={() => del(`/chat/messages/${m.id}`)}><Icon name="x" /></button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="small muted" style={{ height: 18, padding: '0 20px' }}>{typing && `${typing} schreibt …`}</div>
      <div className="chat-input">
        <button className="btn ghost" title="Datei anhängen" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="paperclip" /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }} />
        <textarea value={text} placeholder="Nachricht schreiben … (Enter senden, Umschalt+Enter neue Zeile)" rows={1}
          onChange={(e) => {
            setText(e.target.value);
            if (Date.now() - lastTyping.current > 2000) { realtime.send({ type: 'typing', channel: `chat:${channelId}` }); lastTyping.current = Date.now(); }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void attach(e.clipboardData.files); } }} />
        <button className="btn primary" disabled={!text.trim()} onClick={send}>Senden</button>
      </div>
      {call && <VideoCall channelId={channelId} title={title} onClose={() => setCall(false)} />}
    </div>
  );
}

function renderBody(body: string) {
  const parts = body.split(/(https?:\/\/\S+|@[\w.-]+)/g);
  return parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>
    : p.startsWith('@') ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 550 }}>{p}</span> : p));
}

/** Eingehender Anruf – global eingeblendet */
export function IncomingCalls() {
  const { me } = useSession();
  const [incoming, setIncoming] = useState<{ channelId: string; from: string } | null>(null);
  const [joined, setJoined] = useState<{ channelId: string; title: string } | null>(null);
  useEffect(() => {
    if (!me) return;
    return realtime.subscribe(`user:${me.id}`, (event, data) => {
      if (event === 'call.incoming') {
        setIncoming({ channelId: data.channelId, from: data.from });
        try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play().catch(() => {}); } catch { /* ohne Ton */ }
        setTimeout(() => setIncoming((c) => (c?.channelId === data.channelId ? null : c)), 45000);
      }
    });
  }, [me]);
  return (
    <>
      {incoming && createPortal(
        <div className="card" style={{ position: 'fixed', top: 60, right: 20, zIndex: 75, boxShadow: 'var(--shadow-lg)', width: 320 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}><Icon name="video" /> {incoming.from} ruft an</div>
          <div className="row">
            <button className="btn primary" onClick={() => { setJoined({ channelId: incoming.channelId, title: `Anruf mit ${incoming.from}` }); setIncoming(null); }}>Annehmen</button>
            <button className="btn" onClick={() => setIncoming(null)}>Ablehnen</button>
          </div>
        </div>, document.body)}
      {joined && <VideoCall channelId={joined.channelId} title={joined.title} onClose={() => setJoined(null)} />}
    </>
  );
}

export function useChannels() {
  const r = useApi<any[]>('/chat/channels');
  const { me } = useSession();
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e === 'chat.unread') void r.reload(); }) : undefined), [me]); // eslint-disable-line react-hooks/exhaustive-deps
  return r;
}
