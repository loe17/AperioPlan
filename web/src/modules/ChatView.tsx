import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { get, post, del, upload, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtDateTime, fmtTime } from '../lib/format';
import { Avatar, Empty, useAction } from '../components/ui';
import { VideoCall } from './Video';
import { Icon } from '../components/Icon';
import { MentionInput } from '../components/MentionInput';
import { EMOJI_CATEGORIES, QUICK_REACTIONS } from '../lib/emojiData';

export interface CallMeta { callId: string; startedAt: string; endedAt: string; durationSec: number; participants: { id: string; name: string }[]; messageCount: number }
export interface Message {
  id: string; channelId: string; userId: string; userName: string; body: string; attachments: { fileId: string; name: string; size: number }[];
  createdAt: string; updatedAt: string; deletedAt: string | null; kind?: 'message' | 'call'; meta?: CallMeta | null; callId?: string | null;
  reactions?: { emoji: string; userId: string }[];
}

/** Nachrichtenverlauf + Eingabe einer Unterhaltung (Projekt, Team oder Direktnachricht) */
export function ChatView({ channelId, title, height = 'calc(100vh - 48px)', subtitle, actions }: { channelId: string; title: string; height?: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  const { me, users } = useSession();
  const [emoji, setEmoji] = useState<{ forMsg: string | null } | null>(null);
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

  const react = async (id: string, emojiChar: string) => {
    const r = await act(() => post<Message>(`/chat/messages/${id}/reactions`, { emoji: emojiChar }));
    if (r) setMessages((m) => m.map((x) => (x.id === r.id ? r : x)));
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
        <div className="grow"><b>{title}</b>{subtitle && <div className="small muted">{subtitle}</div>}</div>
        {actions}
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
          if (m.kind === 'call') return (
            <div key={m.id}>
              {showDay && <div className="small muted" style={{ textAlign: 'center', margin: '12px 0' }}>{day}</div>}
              <CallEntry m={m} />
            </div>
          );
          const mine = (e: string) => m.reactions?.some((r) => r.emoji === e && r.userId === me?.id);
          const grouped_reactions = [...new Set((m.reactions ?? []).map((r) => r.emoji))].map((e) => ({ e, n: m.reactions!.filter((r) => r.emoji === e).length, who: m.reactions!.filter((r) => r.emoji === e).map((r) => users.find((u) => u.id === r.userId)?.displayName ?? '').join(', ') }));
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
                  {grouped_reactions.length > 0 && (
                    <div className="reactions">
                      {grouped_reactions.map((r) => <button key={r.e} className={`reaction ${mine(r.e) ? 'mine' : ''}`} title={r.who} onClick={() => react(m.id, r.e)}>{r.e} {r.n}</button>)}
                    </div>
                  )}
                </div>
                {!m.deletedAt && (
                  <div className="msg-tools">
                    {QUICK_REACTIONS.slice(0, 4).map((e) => <button key={e} title="Reagieren" onClick={() => react(m.id, e)}>{e}</button>)}
                    <button title="Weitere Reaktion" onClick={() => setEmoji({ forMsg: m.id })}><Icon name="plus" /></button>
                    {m.userId === me?.id && <button title="Löschen" onClick={() => del(`/chat/messages/${m.id}`)}><Icon name="trash" /></button>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="small muted" style={{ height: 18, padding: '0 20px' }}>{typing && `${typing} schreibt …`}</div>
      <div className="chat-input">
        <button className="btn ghost" title="Datei anhängen" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="paperclip" /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }} />
        <div style={{ position: 'relative' }}>
          <button className="btn ghost" title="Emoji einfügen" onClick={() => setEmoji(emoji ? null : { forMsg: null })}><Icon name="heart" /></button>
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <MentionInput value={text} users={users.filter((u) => u.id !== me?.id)} placeholder="Nachricht schreiben … (Enter senden, Umschalt+Enter neue Zeile, @ erwähnt)" rows={1}
            onChange={(v) => {
              setText(v);
              if (Date.now() - lastTyping.current > 2000) { realtime.send({ type: 'typing', channel: `chat:${channelId}` }); lastTyping.current = Date.now(); }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void attach(e.clipboardData.files); } }} />
        </div>
        <button className="btn primary" disabled={!text.trim()} onClick={send}>Senden</button>
      </div>
      {emoji && <EmojiPicker onClose={() => setEmoji(null)} onPick={(e) => { if (emoji.forMsg) void react(emoji.forMsg, e); else setText((t) => t + e); setEmoji(null); }} />}
      {call && <VideoCall channelId={channelId} title={title} onClose={() => setCall(false)} />}
    </div>
  );
}

/** Verlaufseintrag eines beendeten Anrufs – aufklappbar mit dem Chat aus dem Anruf */
function CallEntry({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const meta = m.meta;
  if (!meta) return null;
  const mins = Math.floor(meta.durationSec / 60); const secs = meta.durationSec % 60;
  const toggle = async () => {
    if (!open && !msgs) setMsgs(await get<Message[]>(`/chat/calls/${meta.callId}/messages`).catch(() => []));
    setOpen(!open);
  };
  return (
    <div className="call-entry">
      <div className="row">
        <Icon name="video" />
        <div className="grow">
          <b>Videoanruf</b> <span className="muted small">{fmtTime(meta.startedAt)}–{fmtTime(meta.endedAt)} · {mins ? `${mins} Min. ` : ''}{secs} Sek.</span>
          <div className="small muted">{meta.participants.map((p) => p.name).join(', ')}</div>
        </div>
        {meta.messageCount > 0 && <button className="btn sm ghost" onClick={toggle}><Icon name={open ? 'chevron-down' : 'chevron-right'} /> Chat im Anruf ({meta.messageCount})</button>}
      </div>
      {open && msgs && (
        <div style={{ marginTop: 8, paddingLeft: 26 }}>
          {msgs.map((x) => (
            <div key={x.id} className="small" style={{ marginBottom: 4 }}>
              <b>{x.userName}</b> <span className="muted">{fmtTime(x.createdAt)}</span> {x.body}
              {x.attachments?.map((a) => <a key={a.fileId} href={`/api/files/${a.fileId}/download`} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}><Icon name="paperclip" /> {a.name}</a>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Emoji-Auswahl mit Kategorien und Suche (deutsche Stichworte) */
export function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const [cat, setCat] = useState(0);
  const [q, setQ] = useState('');
  const list = q.trim()
    ? EMOJI_CATEGORIES.flatMap((c) => c.items).filter(([, k]) => k.includes(q.trim().toLowerCase()))
    : EMOJI_CATEGORIES[cat]!.items;
  return createPortal(
    <>
      <div className="overlay transparent" onClick={onClose} />
      <div className="dropdown-menu emoji-picker" style={{ position: 'fixed', bottom: 80, left: 'max(280px, 30vw)', top: 'auto', right: 'auto', zIndex: 80 }}>
        <input autoFocus placeholder="Suchen, z. B. daumen, danke, party" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
        {!q && <div className="emoji-tabs">{EMOJI_CATEGORIES.map((c, i) => <button key={c.name} className={`btn sm ${i === cat ? 'primary' : 'ghost'}`} title={c.name} onClick={() => setCat(i)}><Icon name={c.icon} /></button>)}</div>}
        <div className="emoji-grid">{list.map(([e, k]) => <button key={e} title={k} onClick={() => onPick(e)}>{e}</button>)}</div>
        {!list.length && <div className="small muted" style={{ padding: 8 }}>Nichts gefunden</div>}
      </div>
    </>,
    document.body,
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
