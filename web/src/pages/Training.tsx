import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, isoDate } from '../lib/format';
import { Empty, Field, Modal, Pill, SlideOver, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { uploadForm } from '../modules/Pickers';
import { useAdminSettings } from './Settings';

const STATUS: Record<string, [string, string]> = { ok: ['erledigt', 'green'], due: ['bald fällig', 'amber'], overdue: ['überfällig', 'red'], open: ['offen', 'blue'] };
const KIND: Record<string, string> = { instruction: 'Unterweisung', training: 'Schulung' };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'training.changed') void reload(); }), [reload]);
}

type Tab = 'mine' | 'courses' | 'matrix' | 'settings';

export default function TrainingPage() {
  useCrumbs([{ label: 'Unterweisungen' }]);
  const { me } = useSession();
  const { data, reload } = useApi<{ courses: any[]; manager: boolean }>('/training/mine');
  const [tab, setTab] = useTabState<Tab>('training', 'mine');
  const [params, setParams] = useSearchParams();
  const open = params.get('course');
  const setOpen = (id: string | null) => { if (id) params.set('course', id); else params.delete('course'); setParams(params, { replace: true }); };
  useLive(reload);
  if (!data) return null;
  const tabs = [{ id: 'mine' as Tab, label: 'Meine Unterweisungen' }, ...(data.manager ? [{ id: 'courses' as Tab, label: 'Verwalten' }, { id: 'matrix' as Tab, label: 'Übersicht' }] : []), ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])];
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Unterweisungen und Schulungen</h1><div className="sub">Pflichtunterweisungen online lesen, Fragen beantworten, Nachweis automatisch</div></div>
        {data.manager && <div className="actions"><a className="btn" href="/api/training/records.xlsx"><Icon name="download" /> Nachweise (Excel)</a></div>}</div>
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
      {tab === 'mine' && (!data.courses.length ? <Empty icon="graduation" title="Keine Unterweisungen für dich">Sobald dir eine Unterweisung zugewiesen ist, erscheint sie hier.</Empty>
        : <div className="bk-types">{data.courses.map((c) => (
          <div key={c.id} className="card click" onClick={() => setOpen(c.id)}>
            <div className="row"><b className="grow">{c.title}</b><Pill tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Pill></div>
            <div className="small muted">{KIND[c.kind]}{c.intervalMonths ? ` · alle ${c.intervalMonths} Monate` : ' · einmalig'}</div>
            <div className="small">{c.completedAt ? `zuletzt ${fmtDate(c.completedAt)}` : 'noch nicht absolviert'}{c.validUntil ? ` · gültig bis ${fmtDate(c.validUntil)}` : ''}</div>
          </div>
        ))}</div>)}
      {tab === 'courses' && <Courses onOpen={setOpen} />}
      {tab === 'matrix' && <Matrix onOpen={setOpen} />}
      {tab === 'settings' && <TrainingSettings />}
      {open && <CoursePanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CoursePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: c, reload } = useApi<any>(`/training/courses/${id}`, [id]);
  const { users } = useSession();
  const act = useAction();
  const [answers, setAnswers] = useState<number[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<string>('');
  const [edit, setEdit] = useState(false);
  const [att, setAtt] = useState(false);
  useLive(reload);
  if (!c) return null;
  return (
    <SlideOver wide title={c.title} onClose={onClose}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <span className="muted small grow">{KIND[c.kind]}{c.intervalMonths ? ` · Wiederholung alle ${c.intervalMonths} Monate` : ' · einmalig'}{!c.active ? ' · deaktiviert' : ''}</span>
        {c.manager && <><button className="btn sm" onClick={() => setAtt(true)}><Icon name="users" /> Präsenz-Teilnahme</button><button className="btn sm" onClick={() => setEdit(true)}><Icon name="edit" /> Bearbeiten</button></>}
      </div>
      {c.description && <p>{c.description}</p>}
      {c.content && <div className="card flat" style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{c.content}</div>}
      {c.files.length > 0 && <div style={{ marginBottom: 10 }}>{c.files.map((f: any) => <div key={f.id}><a href={`/api/training/courses/${id}/files/${f.id}`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {f.name}</a></div>)}</div>}
      {c.active && <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Abschließen</h3>
        {c.quiz.map((q: any, i: number) => (
          <div key={i} style={{ marginBottom: 10 }}><b>{i + 1}. {q.q}</b>
            {q.options.map((o: string, k: number) => <label key={k} className="row" style={{ gap: 6 }}><input type="radio" name={`q${i}`} checked={answers[i] === k} onChange={() => { const a = [...answers]; a[i] = k; setAnswers(a); }} /> {o}</label>)}</div>
        ))}
        <label className="row"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Ich habe den Inhalt gelesen und verstanden.</label>
        {result && <p className="small">{result}</p>}
        <button className="btn primary" style={{ marginTop: 8 }} disabled={!confirm || (c.quiz.length > 0 && c.quiz.some((_: any, i: number) => answers[i] === undefined))}
          onClick={async () => { const r = await act(() => post<any>(`/training/courses/${id}/complete`, { answers, confirm: true })); if (r) { setResult(`Abgeschlossen${r.score !== null ? ` mit ${r.score} %` : ''}${r.validUntil ? ` – gültig bis ${fmtDate(r.validUntil)}` : ''}.`); setAnswers([]); setConfirm(false); void reload(); } }}>
          <Icon name="check" /> Teilnahme bestätigen</button>
      </div>}
      <h3>{c.manager ? 'Nachweise' : 'Meine Nachweise'}</h3>
      {!c.records.length ? <p className="muted">Noch keine.</p> : <table className="table small"><tbody>{c.records.map((r: any) => (
        <tr key={r.id}>{c.manager && <td>{r.userName}</td>}<td>{fmtDate(r.completedAt)}</td><td>{r.method === 'online' ? 'online' : `Präsenz${r.trainer ? ` (${r.trainer})` : ''}`}</td>
          <td>{r.score !== null ? `${r.score} %` : ''}</td><td>{r.validUntil ? `bis ${fmtDate(r.validUntil)}` : 'unbegrenzt'}</td>
          {c.manager && <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/training/records/${r.id}`))) void reload(); }}><Icon name="x" /></button></td>}</tr>
      ))}</tbody></table>}
      {edit && <CourseModal course={c} onClose={() => setEdit(false)} onDone={() => { setEdit(false); void reload(); }} />}
      {att && <AttendanceModal courseId={id} users={users} onClose={() => setAtt(false)} onDone={() => { setAtt(false); void reload(); }} />}
    </SlideOver>
  );
}

function AttendanceModal({ courseId, users, onClose, onDone }: { courseId: string; users: any[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ userIds: [] as string[], date: isoDate(new Date()), trainer: '', note: '' });
  return (
    <Modal title="Teilnahme an Präsenzschulung erfassen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.userIds.length} onClick={async () => { if (await act(() => post(`/training/courses/${courseId}/attendance`, f), 'Erfasst')) onDone(); }}>Speichern</button></>}>
      <Field label="Teilnehmer"><UserPicker users={users} value={f.userIds} onChange={(ids) => setF({ ...f, userIds: ids })} /></Field>
      <div className="grid2">
        <Field label="Datum"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Unterwiesen durch"><input value={f.trainer} onChange={(e) => setF({ ...f, trainer: e.target.value })} /></Field>
      </div>
      <Field label="Bemerkung"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </Modal>
  );
}

function Courses({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useApi<any[]>('/training/courses');
  const [edit, setEdit] = useState<any | null>(null);
  useLive(reload);
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ title: '', description: '', content: '', kind: 'instruction', intervalMonths: 12, audience: { all: true, teamIds: [], userIds: [] }, quiz: [], passScore: 80, active: true })}><Icon name="plus" /> Unterweisung</button></span></div>
      {data && !data.length && <Empty icon="graduation" title="Noch keine Unterweisungen">Typisch sind z. B. Arbeitsschutz, Brandschutz, Erste Hilfe, Datenschutz, Gefahrstoffe, Stapler – jährlich.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Unterweisung</th><th>Wiederholung</th><th>Personen</th><th>erledigt</th><th>überfällig</th></tr></thead>
        <tbody>{data.map((c) => (
          <tr key={c.id} className="click" onClick={() => onOpen(c.id)} style={!c.active ? { opacity: 0.5 } : undefined}>
            <td><b>{c.title}</b><div className="small muted">{KIND[c.kind]}{c.quiz.length ? ` · ${c.quiz.length} Fragen` : ''}</div></td>
            <td>{c.intervalMonths ? `${c.intervalMonths} Monate` : 'einmalig'}</td><td>{c.people}</td><td>{c.ok}</td><td className={c.overdue ? 'text-red' : ''}>{c.overdue}</td>
          </tr>
        ))}</tbody></table>}
      {edit && <CourseModal course={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function CourseModal({ course, onClose, onDone }: { course: any; onClose: () => void; onDone: () => void }) {
  const { users, teams } = useSession();
  const act = useAction();
  const [f, setF] = useState({ ...course });
  const [files, setFiles] = useState<File[]>([]);
  const body = { title: f.title, description: f.description, content: f.content, kind: f.kind, intervalMonths: f.intervalMonths, audience: f.audience, quiz: f.quiz, passScore: f.passScore, active: f.active };
  const setQ = (i: number, q: any) => setF({ ...f, quiz: f.quiz.map((x: any, k: number) => (k === i ? q : x)) });
  return (
    <Modal size="lg" title={course.id ? 'Unterweisung bearbeiten' : 'Neue Unterweisung'} onClose={onClose} footer={<>
      {course.id && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/training/courses/${course.id}`))) onDone(); }}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => {
        const r = await act(async () => {
          const res = course.id ? (await patch(`/training/courses/${course.id}`, body), { id: course.id }) : await post<{ id: string }>('/training/courses', body);
          for (const x of files) await uploadForm(`/training/courses/${res.id}/files`, {}, x);
          return res;
        }, 'Gespeichert');
        if (r) onDone();
      }}>Speichern</button></>}>
      <div className="grid3">
        <Field label="Titel"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Jährliche Arbeitsschutzunterweisung" /></Field>
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="instruction">Unterweisung</option><option value="training">Schulung</option></select></Field>
        <Field label="Wiederholung (Monate)" hint="leer = einmalig"><input type="number" min={1} value={f.intervalMonths ?? ''} onChange={(e) => setF({ ...f, intervalMonths: e.target.value ? Number(e.target.value) : null })} /></Field>
      </div>
      <Field label="Kurzbeschreibung"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Inhalt" hint="wird online gelesen; zusätzlich können Unterlagen (PDF) angehängt werden"><textarea rows={8} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></Field>
      <Field label="Unterlagen anhängen"><input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></Field>
      <Field label="Für wen?">
        <label className="row"><input type="checkbox" checked={f.audience.all} onChange={(e) => setF({ ...f, audience: { ...f.audience, all: e.target.checked } })} /> alle Mitarbeiter</label>
        {!f.audience.all && <>
          <div className="row wrap" style={{ gap: 10, margin: '6px 0' }}>{teams.map((t) => <label key={t.id} className="row small"><input type="checkbox" checked={f.audience.teamIds.includes(t.id)} onChange={(e) => setF({ ...f, audience: { ...f.audience, teamIds: e.target.checked ? [...f.audience.teamIds, t.id] : f.audience.teamIds.filter((x: string) => x !== t.id) } })} /> {t.name}</label>)}</div>
          <UserPicker users={users} value={f.audience.userIds} onChange={(ids) => setF({ ...f, audience: { ...f.audience, userIds: ids } })} placeholder="einzelne Personen …" />
        </>}
      </Field>
      <h3 style={{ margin: '10px 0 4px' }}>Verständnisfragen</h3>
      {f.quiz.map((q: any, i: number) => (
        <div key={i} className="card flat" style={{ marginBottom: 8 }}>
          <div className="row" style={{ gap: 6 }}><input className="grow" value={q.q} placeholder={`Frage ${i + 1}`} onChange={(e) => setQ(i, { ...q, q: e.target.value })} />
            <button className="btn ghost sm" onClick={() => setF({ ...f, quiz: f.quiz.filter((_: any, k: number) => k !== i) })}><Icon name="trash" /></button></div>
          {q.options.map((o: string, k: number) => (
            <div key={k} className="row" style={{ gap: 6, marginTop: 4 }}>
              <input type="radio" name={`c${i}`} checked={q.correct === k} onChange={() => setQ(i, { ...q, correct: k })} title="richtige Antwort" />
              <input className="grow" value={o} placeholder={`Antwort ${k + 1}`} onChange={(e) => setQ(i, { ...q, options: q.options.map((x: string, j: number) => (j === k ? e.target.value : x)) })} />
              {q.options.length > 2 && <button className="btn ghost sm" onClick={() => setQ(i, { ...q, options: q.options.filter((_: string, j: number) => j !== k), correct: q.correct >= k && q.correct > 0 ? q.correct - 1 : q.correct })}><Icon name="x" /></button>}
            </div>
          ))}
          {q.options.length < 6 && <button className="btn ghost sm" onClick={() => setQ(i, { ...q, options: [...q.options, ''] })}>+ Antwort</button>}
        </div>
      ))}
      <div className="row" style={{ gap: 10 }}>
        <button className="btn sm" onClick={() => setF({ ...f, quiz: [...f.quiz, { q: '', options: ['', ''], correct: 0 }] })}><Icon name="plus" /> Frage</button>
        {f.quiz.length > 0 && <label className="row small">Bestanden ab <input type="number" min={0} max={100} style={{ width: 70 }} value={f.passScore} onChange={(e) => setF({ ...f, passScore: Number(e.target.value) })} /> % richtig</label>}
        <span className="grow" />
        <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
      </div>
    </Modal>
  );
}

function Matrix({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useApi<any>('/training/matrix');
  useLive(reload);
  if (!data) return null;
  if (!data.courses.length) return <Empty icon="graduation" title="Keine aktiven Unterweisungen" />;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table small hr-matrix"><thead><tr><th />{data.courses.map((c: any) => <th key={c.id} className="click" onClick={() => onOpen(c.id)}><span>{c.title}</span></th>)}</tr></thead>
        <tbody>{data.people.map((p: any) => (
          <tr key={p.id}><td style={{ whiteSpace: 'nowrap' }}>{p.displayName}</td>{data.courses.map((c: any) => {
            const s = data.cells[`${c.id}:${p.id}`];
            return <td key={c.id} title={s ? `${STATUS[s.status]![0]}${s.validUntil ? ` · bis ${fmtDate(s.validUntil)}` : ''}` : 'nicht betroffen'}>{s ? <span className={`dot ${STATUS[s.status]![1]}`} /> : <span className="muted">–</span>}</td>;
          })}</tr>
        ))}</tbody></table>
      <p className="hint"><span className="dot green" /> erledigt · <span className="dot amber" /> in den nächsten 30 Tagen fällig · <span className="dot red" /> überfällig · <span className="dot blue" /> neu zugewiesen</p>
    </div>
  );
}

function TrainingSettings() {
  const s = useAdminSettings('training');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  return (
    <div style={{ maxWidth: 760 }}>
      <Field label="Schulungsverantwortliche" hint="dürfen Unterweisungen anlegen, Präsenz-Teilnahmen erfassen und alle Nachweise sehen"><UserPicker users={users} value={s.value.managerIds} onChange={(ids) => s.setValue({ ...s.value, managerIds: ids })} /></Field>
      <button className="btn primary" onClick={() => act(() => s.save(s.value), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
