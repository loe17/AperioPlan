import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useInterval, rememberedTab, rememberTab } from '../lib/hooks';
import { post, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { useT } from '../i18n';
import { fmtDate, fmtDateTime, fmtDuration, fmtHours, fmtTime, isoDate } from '../lib/format';
import { Avatar, Empty, Field, Modal, REQUEST_META, StatusPill, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

interface Entry { id: string; userId: string; userName: string; projectId: string | null; projectNumber: string | null; projectName: string | null; taskId: string | null; taskNumber: number | null; taskTitle: string | null; startedAt: string; endedAt: string | null; note: string; source: string; hours: number }

/** Stempeluhr-Kachel (Schreibtisch und Zeiterfassung) */
export function ClockWidget({ compact, defaultProjectId }: { compact?: boolean; defaultProjectId?: string }) {
  const t = useT();
  const act = useAction();
  const { me } = useSession();
  const { data, reload } = useApi<{ running: Entry | null; todayHours: number; weekHours: number }>('/time/current');
  const { data: projects } = useApi<any[]>('/projects');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [, tick] = useState(0);
  useInterval(() => tick((x) => x + 1), data?.running ? 1000 : null);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e === 'time.changed') void reload(); }) : undefined), [me, reload]);
  const running = data?.running;
  const elapsed = running ? Date.now() - new Date(running.startedAt).getTime() : 0;
  return (
    <div className="card" style={compact ? undefined : { maxWidth: 520 }}>
      <div className="muted small"><Icon name="timer" /> {t('Stempeluhr')}</div>
      <div className="clock" style={{ color: running ? 'var(--amber)' : undefined, fontSize: compact ? 30 : 40 }}>{fmtDuration(elapsed)}</div>
      {running ? (
        <div className="small" style={{ marginBottom: 8 }}>
          seit {fmtTime(running.startedAt)} · {running.projectNumber ? `${running.projectNumber} ${running.projectName}` : 'ohne Projekt'}{running.taskTitle ? ` · P${running.taskNumber} ${running.taskTitle}` : ''}
        </div>
      ) : <div className="small muted" style={{ marginBottom: 8 }}>Heute {fmtHours(data?.todayHours ?? 0)} · Woche {fmtHours(data?.weekHours ?? 0)}</div>}
      <div className="row">
        {!compact && <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">– ohne Projekt –</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
        </select>}
        {running && <button className="btn" onClick={async () => { await act(() => post('/time/clock-out')); reload(); invalidate('/time'); }}><Icon name="square" /> {t('Ausstempeln')}</button>}
        <button className="btn primary" onClick={async () => { await act(() => post('/time/clock-in', { projectId: projectId || null })); reload(); invalidate('/time'); }}>
          <Icon name="play" /> {running ? 'Wechseln' : t('Einstempeln')}
        </button>
      </div>
    </div>
  );
}

const monday = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

export default function TimePage() {
  const t = useT();
  useCrumbs([{ label: `${t('Zeiterfassung')}` }]);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? rememberedTab('time') ?? 'entries') as 'entries' | 'corrections' | 'review';
  const { data: review } = useApi<any[]>('/time/corrections?scope=review');
  const pending = review?.filter((r) => r.status === 'pending').length ?? 0;
  return (
    <div className="page">
      <div className="page-head"><div><h1>{t('Zeiterfassung')}</h1><div className="sub">Projektzeiten stempeln, Fehlbuchungen korrigieren lassen</div></div></div>
      <ClockWidget />
      <div className="spacer" />
      <Tabs value={tab} onChange={(v) => { rememberTab('time', v); setParams({ tab: v }); }} tabs={[
        { id: 'entries', label: 'Meine Buchungen' },
        { id: 'corrections', label: 'Korrekturanfragen' },
        ...(review && review.length ? [{ id: 'review' as const, label: `Zu prüfen${pending ? ` (${pending})` : ''}` }] : []),
      ]} />
      {tab === 'entries' && <Entries />}
      {tab === 'corrections' && <Corrections />}
      {tab === 'review' && <Review rows={review ?? []} />}
    </div>
  );
}

function Entries() {
  const [week, setWeek] = useState(() => monday(new Date()));
  const from = isoDate(week);
  const to = isoDate(new Date(week.getTime() + 6 * 86400000));
  const { data } = useApi<Entry[]>(`/time/entries?from=${from}&to=${to}`);
  const [correct, setCorrect] = useState<Partial<Entry> | null>(null);
  const days = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of data ?? []) {
      const k = isoDate(new Date(e.startedAt));
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);
  const total = (data ?? []).reduce((s, e) => s + e.hours, 0);
  return (
    <div>
      <div className="toolbar">
        <button className="btn sm" onClick={() => setWeek(new Date(week.getTime() - 7 * 86400000))}>‹</button>
        <b>{fmtDate(from)} – {fmtDate(to)}</b>
        <button className="btn sm" onClick={() => setWeek(new Date(week.getTime() + 7 * 86400000))}>›</button>
        <button className="btn sm" onClick={() => setWeek(monday(new Date()))}>Diese Woche</button>
        <span className="muted">Summe: <b>{fmtHours(total)}</b></span>
        <a className="btn sm right" href={`/api/time/export?from=${from}&to=${to}`}><Icon name="chart" /> CSV</a>
        <button className="btn sm primary" onClick={() => setCorrect({ id: undefined })}>＋ Zeit nachtragen</button>
      </div>
      {!days.length ? <Empty icon="timer" title="Keine Buchungen in dieser Woche" /> : days.map(([day, list]) => (
        <div key={day} style={{ marginBottom: 16 }}>
          <div className="row" style={{ marginBottom: 6 }}><b>{new Date(day).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}</b><span className="muted small">{fmtHours(list.reduce((s, e) => s + e.hours, 0))}</span></div>
          <div className="table-wrap"><table className="table"><tbody>
            {list.map((e) => (
              <tr key={e.id}>
                <td style={{ width: 130 }} className="mono small">{fmtTime(e.startedAt)} – {e.endedAt ? fmtTime(e.endedAt) : 'läuft'}</td>
                <td>{e.projectNumber ? `${e.projectNumber} ${e.projectName}` : <span className="muted">ohne Projekt</span>}{e.taskTitle && <span className="muted"> · P{e.taskNumber} {e.taskTitle}</span>}</td>
                <td className="small muted">{e.note}</td>
                <td className="small">{e.source === 'correction' ? 'korrigiert' : e.source === 'manual' ? 'nachgetragen' : ''}</td>
                <td style={{ width: 80 }}><b>{fmtHours(e.hours)}</b></td>
                <td style={{ width: 110 }}>{e.endedAt && <button className="btn sm" onClick={() => setCorrect(e)}>Korrektur …</button>}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      ))}
      {correct && <CorrectionDialog entry={correct} onClose={() => setCorrect(null)} />}
    </div>
  );
}

const toLocalInput = (d: string | Date) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

function CorrectionDialog({ entry, onClose }: { entry: Partial<Entry>; onClose: () => void }) {
  const act = useAction();
  const { data: projects } = useApi<any[]>('/projects');
  const isNew = !entry.id;
  const now = new Date();
  const [d, setD] = useState({
    kind: isNew ? 'add' : 'change',
    projectId: entry.projectId ?? '',
    start: toLocalInput(entry.startedAt ?? new Date(now.setHours(8, 0, 0, 0))),
    end: toLocalInput(entry.endedAt ?? new Date(now.setHours(12, 0, 0, 0))),
    what: '', reason: '',
  });
  return (
    <Modal title={isNew ? 'Zeit nachtragen (Korrekturanfrage)' : 'Korrekturanfrage'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.what.trim() || !d.reason.trim()} onClick={async () => {
        const r = await act(() => post('/time/corrections', {
          kind: d.kind, entryId: entry.id, projectId: d.projectId || null,
          newStartedAt: d.kind === 'delete' ? undefined : new Date(d.start).toISOString(), newEndedAt: d.kind === 'delete' ? undefined : new Date(d.end).toISOString(),
          what: d.what, reason: d.reason,
        }), 'Anfrage an die Teamleitung gesendet');
        if (r) { onClose(); invalidate('/time/corrections'); }
      }}>Zur Genehmigung senden</button>
    </>}>
      {!isNew && (
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="row small"><input type="radio" checked={d.kind === 'change'} onChange={() => setD({ ...d, kind: 'change' })} /> Ändern</label>
          <label className="row small"><input type="radio" checked={d.kind === 'delete'} onChange={() => setD({ ...d, kind: 'delete' })} /> Löschen</label>
          <span className="muted small">bisher: {fmtDateTime(entry.startedAt)} – {fmtTime(entry.endedAt)}</span>
        </div>
      )}
      {d.kind !== 'delete' && <>
        <Field label="Projekt"><select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })}><option value="">– ohne Projekt –</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
        <div className="grid2">
          <Field label="Beginn" required><input type="datetime-local" value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} /></Field>
          <Field label="Ende" required><input type="datetime-local" value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} /></Field>
        </div>
      </>}
      <Field label="Was?" required hint="z. B. Montag vergessen einzustempeln"><input value={d.what} onChange={(e) => setD({ ...d, what: e.target.value })} /></Field>
      <Field label="Warum?" required><textarea value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
    </Modal>
  );
}

function Corrections() {
  const { data } = useApi<any[]>('/time/corrections?scope=mine');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="toolbar"><span className="muted">Fehlbuchungen werden per Anfrage von der Teamleitung geprüft und genehmigt.</span><button className="btn primary right" onClick={() => setOpen(true)}>＋ Neue Anfrage</button></div>
      {!data?.length ? <Empty icon="edit" title="Keine Korrekturanfragen" /> : <CorrectionTable rows={data} />}
      {open && <CorrectionDialog entry={{}} onClose={() => setOpen(false)} />}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { add: 'Nachtrag', change: 'Änderung', delete: 'Löschung' };

function CorrectionTable({ rows, onDecide }: { rows: any[]; onDecide?: (r: any, approve: boolean) => void }) {
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>{onDecide && <th>Mitarbeiter</th>}<th>Art</th><th>Zeit</th><th>Projekt</th><th>Was / Warum</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          {onDecide && <td><span className="row" style={{ gap: 6 }}><Avatar id={r.userId} name={r.userName} />{r.userName}</span></td>}
          <td>{KIND_LABEL[r.kind]}</td>
          <td className="small">{r.kind === 'delete' ? `${fmtDateTime(r.oldStartedAt)} – ${fmtTime(r.oldEndedAt)}` : `${fmtDateTime(r.newStartedAt)} – ${fmtTime(r.newEndedAt)}`}
            {r.kind === 'change' && <div className="muted">bisher {fmtDateTime(r.oldStartedAt)} – {fmtTime(r.oldEndedAt)}</div>}</td>
          <td className="small">{r.projectNumber ? `${r.projectNumber} ${r.projectName}` : '–'}</td>
          <td><div>{r.what}</div><div className="small muted">{r.reason}</div></td>
          <td><StatusPill status={r.status} meta={REQUEST_META} />{r.reviewerName && <div className="small muted">{r.reviewerName}{r.reviewNote ? `: ${r.reviewNote}` : ''}</div>}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{onDecide && r.status === 'pending' && <>
            <button className="btn sm primary" onClick={() => onDecide(r, true)}>Genehmigen</button> <button className="btn sm danger" onClick={() => onDecide(r, false)}>Ablehnen</button>
          </>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Review({ rows }: { rows: any[] }) {
  const act = useAction();
  return <CorrectionTable rows={rows} onDecide={async (r, approve) => {
    const note = approve ? '' : prompt('Begründung der Ablehnung (optional)') ?? '';
    await act(() => post(`/time/corrections/${r.id}/decide`, { approve, note }), approve ? 'Genehmigt' : 'Abgelehnt');
    invalidate('/time');
  }} />;
}

