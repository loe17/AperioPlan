import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { Avatar, Empty } from '../components/ui';
import { ChatView, useChannels } from '../modules/ChatView';
import { EntityIcon, Icon } from '../components/Icon';

export default function ChatPage() {
  useCrumbs([{ label: 'Chat' }]);
  const [params, setParams] = useSearchParams();
  const { users, me } = useSession();
  const { data: channels } = useChannels();
  const [newDm, setNewDm] = useState(false);
  const active = params.get('channel');

  // /chat?user=<id> öffnet die Direktnachricht
  useEffect(() => {
    const uid = params.get('user');
    if (uid && uid !== me?.id) post('/chat/direct', { userId: uid }).then((c) => { invalidate('/chat/channels'); setParams({ channel: c.id }); });
  }, [params.get('user')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active && channels?.length && !params.get('user')) setParams({ channel: channels[0].id }, { replace: true }); }, [channels, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups: [string, string][] = [['project', 'Projekte'], ['team', 'Teams'], ['direct', 'Direktnachrichten']];
  const current = channels?.find((c) => c.id === active);
  return (
    <div className="chat">
      <div className="chat-list">
        {groups.map(([kind, label]) => (
          <div key={kind} style={{ marginBottom: 12 }}>
            <div className="nav-title">{label}{kind === 'direct' && <button className="btn ghost sm" onClick={() => setNewDm(!newDm)}>＋</button>}</div>
            {kind === 'direct' && newDm && (
              <select autoFocus onChange={(e) => { if (e.target.value) { setNewDm(false); setParams({ user: e.target.value }); } }} style={{ marginBottom: 6 }}>
                <option value="">Mitarbeiter wählen …</option>
                {users.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            )}
            {channels?.filter((c) => c.kind === kind).map((c) => {
              const other = users.find((u) => u.id === c.otherUserId);
              return (
                <div key={c.id} className={`nav-item ${active === c.id ? 'active' : ''}`} onClick={() => setParams({ channel: c.id })}>
                  <span className="ico">{kind === 'direct' ? <Avatar id={c.otherUserId} name={c.name} /> : kind === 'project' ? <EntityIcon value={c.projectIcon} /> : <Icon name="team" />}</span>
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  {other?.online && <span className="dot ok" />}
                  {c.activeCallId && <span title="Laufender Anruf"><Icon name="video" /></span>}
                  {c.unread > 0 && <span className="count">{c.unread}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {current ? <ChatView key={current.id} channelId={current.id} title={current.name} /> : <div className="chat-main"><Empty icon="chat" title="Unterhaltung auswählen" /></div>}
    </div>
  );
}
