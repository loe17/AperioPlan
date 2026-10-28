import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { Icon } from '../components/Icon';

/** Hinweis „Gast wartet“ überall in AperioPlan */
export function MeetingLobbyNotice() {
  const { me } = useSession();
  const nav = useNavigate();
  const [items, setItems] = useState<{ meetingId: string; title: string; name: string }[]>([]);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e, d) => {
    if (e === 'meeting.lobby') { setItems((x) => [...x.filter((y) => y.meetingId !== d.meetingId || y.name !== d.name), d].slice(-3)); setTimeout(() => setItems((x) => x.filter((y) => y !== d)), 60000); }
  }) : undefined), [me]);
  if (!items.length || location.pathname.startsWith('/meetings/')) return null;
  return createPortal(
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 74, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((i) => (
        <div key={`${i.meetingId}-${i.name}`} className="card" style={{ boxShadow: 'var(--shadow-lg)', width: 320 }}>
          <div><Icon name="door" /> <b>{i.name}</b> wartet im Warteraum von „{i.title}“</div>
          <div className="row" style={{ marginTop: 8 }}><button className="btn sm primary" onClick={() => { setItems([]); nav(`/meetings/${i.meetingId}`); }}>Zum Meeting</button>
            <button className="btn sm" onClick={() => setItems((x) => x.filter((y) => y !== i))}>Schließen</button></div>
        </div>
      ))}
    </div>, document.body);
}
