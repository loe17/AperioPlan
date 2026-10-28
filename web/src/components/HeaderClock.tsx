import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invalidate, post } from '../lib/api';
import { useApi, useInterval } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { fmtDuration, fmtHours, fmtTime } from '../lib/format';
import { useSession } from '../session';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { useAction } from './ui';

interface Current {
  running: { id: string; projectId: string | null; projectNumber: string | null; projectName: string | null; taskId: string | null; taskNumber: number | null; taskTitle: string | null; startedAt: string } | null;
  todayHours: number;
}

/** Stempeluhr dauerhaft oben neben der Blitzsuche: worauf, wie lange, Gesamtzeit heute */
export function HeaderClock() {
  const t = useT();
  const nav = useNavigate();
  const act = useAction();
  const { me } = useSession();
  const { data, reload } = useApi<Current>('/time/current');
  const { data: projects } = useApi<{ id: string; number: string; name: string; status: string }[]>('/projects');
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [, tick] = useState(0);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  useEffect(() => { setFetchedAt(Date.now()); }, [data]);
  useInterval(() => tick((x) => x + 1), data?.running ? 1000 : 60000);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e === 'time.changed') void reload(); }) : undefined), [me, reload]);
  useEffect(() => { if (data?.running?.projectId) setProjectId(data.running.projectId); }, [data?.running?.projectId]);

  const r = data?.running;
  const started = r ? new Date(r.startedAt).getTime() : 0;
  const elapsed = r ? Date.now() - started : 0;
  // Gesamtzeit heute: Server-Stand + seitdem vergangene Zeit der laufenden Buchung
  const today = (data?.todayHours ?? 0) * 3600_000 + (r ? Date.now() - fetchedAt : 0);
  const done = async () => { await reload(); invalidate('/time'); invalidate('/tasks/'); };

  return (
    <div className="header-clock">
      <button className={`clock-chip ${r ? 'running' : ''}`} onClick={() => setOpen(!open)} title={r ? 'Stempeluhr läuft' : 'Nicht eingestempelt'}>
        <Icon name="timer" />
        {r ? <>
          <span className="clock-where">{r.projectNumber ?? 'ohne Projekt'}{r.taskNumber ? ` · P${r.taskNumber}` : ''}</span>
          <span className="clock-time mono">{fmtDuration(elapsed)}</span>
        </> : <span className="clock-where">{t('Einstempeln')}</span>}
        <span className="clock-total small">{t('Heute')} {fmtHours(today / 3600_000)}</span>
      </button>
      {open && <>
        <div className="overlay transparent" onClick={() => setOpen(false)} />
        <div className="dropdown-menu" style={{ width: 320, padding: 12 }}>
          {r ? (
            <div style={{ marginBottom: 10 }}>
              <div className="small muted">Eingestempelt seit {fmtTime(r.startedAt)}</div>
              <div style={{ fontWeight: 600 }}>{r.projectNumber ? `${r.projectNumber} ${r.projectName}` : 'ohne Projekt'}</div>
              {r.taskTitle && <div className="small">P{r.taskNumber} {r.taskTitle}</div>}
              <div className="clock mono" style={{ fontSize: 26, color: 'var(--amber)' }}>{fmtDuration(elapsed)}</div>
            </div>
          ) : <div className="small muted" style={{ marginBottom: 10 }}>Nicht eingestempelt · heute {fmtHours(today / 3600_000)}</div>}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>
            <option value="">– ohne Projekt –</option>
            {projects?.filter((p) => !['done', 'archived'].includes(p.status)).map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
          </select>
          <div className="row">
            {r && <button className="btn" onClick={async () => { await act(() => post('/time/clock-out'), 'Ausgestempelt'); await done(); setOpen(false); }}><Icon name="square" /> {t('Ausstempeln')}</button>}
            <button className="btn primary" disabled={Boolean(r && r.projectId === (projectId || null) && !r.taskId)}
              onClick={async () => { await act(() => post('/time/clock-in', { projectId: projectId || null }), r ? 'Gewechselt' : 'Eingestempelt'); await done(); setOpen(false); }}>
              <Icon name="play" /> {r ? 'Wechseln' : t('Einstempeln')}
            </button>
          </div>
          <div className="item small" style={{ marginTop: 8 }} onClick={() => { setOpen(false); nav('/time'); }}>Zur Zeiterfassung</div>
        </div>
      </>}
    </div>
  );
}
