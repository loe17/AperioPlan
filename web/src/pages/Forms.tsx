import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FORM_TYPE_LABELS, validateFormAnswers, type FormAnswers, type FormQuestion, type FormQuestionType, type FormSettings } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post, put, upload } from '../lib/api';
import { useSession } from '../session';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { Confirm, Empty, Field, Pill, Tabs, useAction, useToast } from '../components/ui';
import { UserPicker } from '../components/UserPicker';
import { Icon } from '../components/Icon';

const TYPE_ICON: Record<FormQuestionType, string> = {
  short: 'text', long: 'file-text', single: 'circle', multiple: 'check-circle', dropdown: 'chevron-down', date: 'calendar', time: 'clock', datetime: 'calendar', scale: 'chart', file: 'paperclip', section: 'list',
};
const uid = () => crypto.randomUUID();
const newQuestion = (type: FormQuestionType): FormQuestion => ({ id: uid(), type, text: '', description: '', required: false,
  options: ['single', 'multiple', 'dropdown'].includes(type) ? [{ id: uid().slice(0, 8), text: '' }] : [], extra: type === 'scale' ? { min: 1, max: 5 } : type === 'file' ? { maxFiles: 1 } : {} });

export default function FormsPage() {
  const { id, mode } = useParams();
  if (id && mode === 'fill') return <FillInternal id={id} />;
  if (id) return <FormEditor id={id} />;
  return <FormList />;
}

function FormList() {
  useCrumbs([{ label: 'Formulare' }]);
  const nav = useNavigate();
  const act = useAction();
  const [filter, setFilter] = useTabState<'mine' | 'shared' | 'archived'>('forms', 'mine', 'filter');
  const { data } = useApi<any[]>(`/forms?filter=${filter}`);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Formulare</h1><div className="sub">Umfragen, Anmeldungen und Abfragen – intern oder per öffentlichem Link</div></div>
        <div className="actions"><button className="btn primary" onClick={async () => { const r = await act(() => post<{ id: string }>('/forms', {})); if (r) nav(`/forms/${r.id}`); }}><Icon name="plus" /> Neues Formular</button></div>
      </div>
      <Tabs value={filter} onChange={setFilter} tabs={[{ id: 'mine', label: 'Meine Formulare' }, { id: 'shared', label: 'Mit mir geteilt' }, { id: 'archived', label: 'Archiv' }]} />
      {data && !data.length && <Empty icon="list" title={filter === 'shared' ? 'Keine geteilten Formulare' : 'Noch keine Formulare'}>{filter === 'mine' ? 'Legen Sie eine Umfrage an – etwa zur Mitarbeiterzufriedenheit oder für eine Anmeldung zum Sommerfest.' : null}</Empty>}
      <div className="form-grid">
        {data?.map((f) => (
          <Link key={f.id} to={filter === 'shared' ? `/forms/${f.id}/fill` : `/forms/${f.id}`} className="card form-card">
            <div className="row" style={{ gap: 6 }}><Icon name="list" /><b className="grow">{f.title || 'Ohne Titel'}</b>{f.isPublic && <Pill tone="accent">öffentlich</Pill>}</div>
            <div className="small muted" style={{ margin: '4px 0 8px' }}>{f.description?.slice(0, 120)}</div>
            <div className="small muted">{f.questions} Fragen · {f.responses} Antworten{filter === 'shared' ? ` · von ${f.ownerName}` : ''}</div>
            {filter === 'shared' && <div style={{ marginTop: 6 }}>{f.answered ? <Pill tone="green">beantwortet</Pill> : <Pill tone="amber">offen</Pill>}</div>}
            {f.settings?.closed && <Pill>geschlossen</Pill>}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Bearbeiten
function FormEditor({ id }: { id: string }) {
  const nav = useNavigate();
  const act = useAction();
  const { data: f, reload } = useApi<any>(`/forms/${id}`);
  const [tab, setTab] = useTabState<'questions' | 'settings' | 'results'>('form', 'questions');
  const [title, setTitle] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  const [qs, setQs] = useState<FormQuestion[] | null>(null);
  const [saved, setSaved] = useState(true);
  const [remove, setRemove] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useCrumbs([{ label: 'Formulare', to: '/forms' }, { label: (title ?? f?.title) || 'Ohne Titel' }]);
  useEffect(() => { if (f && qs === null) { setQs(f.questions); setTitle(f.title); setDesc(f.description); } }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (f && f.permission === 'submit') nav(`/forms/${id}/fill`, { replace: true }); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = f && (f.permission === 'edit' || f.permission === 'owner');
  const saveQs = (next: FormQuestion[]) => {
    setQs(next); setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => { await act(() => put(`/forms/${id}/questions`, { questions: next })); setSaved(true); }, 700);
  };
  const saveMeta = (patchBody: Record<string, unknown>) => act(() => patch(`/forms/${id}`, patchBody));
  if (!f || !qs) return null;
  const update = (i: number, q: FormQuestion) => saveQs(qs.map((x, j) => (j === i ? q : x)));
  const move = (i: number, d: number) => { const n = [...qs]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; saveQs(n); };
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          {canEdit ? <input className="form-title-input" value={title ?? ''} placeholder="Titel des Formulars" onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== f.title && saveMeta({ title })} />
            : <h1>{f.title}</h1>}
          <div className="sub">{f.responses} Antworten {!saved && '· speichert …'}</div>
        </div>
        <div className="actions">
          <Link className="btn" to={`/forms/${id}/fill`}><Icon name="eye" /> Vorschau / Ausfüllen</Link>
          {canEdit && <button className="btn" onClick={async () => { const r = await act(() => post<{ id: string }>(`/forms/${id}/duplicate`)); if (r) nav(`/forms/${r.id}`); }}><Icon name="copy" /> Kopie</button>}
          {f.permission === 'owner' && <button className="btn ghost" onClick={async () => { await saveMeta({ archived: !f.archived }); reload(); }}><Icon name="archive" /> {f.archived ? 'Wiederherstellen' : 'Archivieren'}</button>}
          {f.permission === 'owner' && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[...(canEdit ? [{ id: 'questions' as const, label: 'Fragen' }, { id: 'settings' as const, label: 'Einstellungen und Teilen' }] : []), { id: 'results', label: `Ergebnisse (${f.responses})` }]} />
      {tab === 'questions' && canEdit && (
        <div className="form-editor">
          <textarea className="form-desc-input" rows={2} value={desc ?? ''} placeholder="Beschreibung (optional) – erscheint oben im Formular" onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== f.description && saveMeta({ description: desc })} />
          {f.responses > 0 && <div className="card flat small" style={{ marginBottom: 10 }}><Icon name="info" /> Es gibt schon Antworten. Geänderte Fragen gelten nur für neue Antworten; gelöschte Fragen fehlen in der Auswertung.</div>}
          {qs.map((q, i) => <QuestionEditor key={q.id} q={q} index={i} total={qs.length} onChange={(n) => update(i, n)} onMove={(d) => move(i, d)}
            onCopy={() => saveQs([...qs.slice(0, i + 1), { ...q, id: uid(), options: q.options.map((o) => ({ ...o })) }, ...qs.slice(i + 1)])}
            onDelete={() => saveQs(qs.filter((_, j) => j !== i))} />)}
          <div className="form-add">
            <span className="small muted">Frage hinzufügen:</span>
            {(Object.keys(FORM_TYPE_LABELS) as FormQuestionType[]).map((t) => <button key={t} className="btn sm" onClick={() => saveQs([...qs, newQuestion(t)])}><Icon name={TYPE_ICON[t]} /> {FORM_TYPE_LABELS[t]}</button>)}
          </div>
        </div>
      )}
      {tab === 'settings' && canEdit && <FormSettingsPanel form={f} onChanged={reload} />}
      {tab === 'results' && <Results id={id} />}
      {remove && <Confirm danger text={`Formular „${f.title || 'Ohne Titel'}“ mit allen ${f.responses} Antworten löschen?`} onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/forms/${id}`), 'Gelöscht')) nav('/forms'); }} />}
    </div>
  );
}

function QuestionEditor({ q, index, total, onChange, onMove, onCopy, onDelete }: { q: FormQuestion; index: number; total: number; onChange: (q: FormQuestion) => void; onMove: (d: number) => void; onCopy: () => void; onDelete: () => void }) {
  const choice = ['single', 'multiple', 'dropdown'].includes(q.type);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const setOpt = (i: number, text: string) => onChange({ ...q, options: q.options.map((o, j) => (j === i ? { ...o, text } : o)) });
  const ex = (patch: Partial<FormQuestion['extra']>) => onChange({ ...q, extra: { ...q.extra, ...patch } });
  return (
    <div className={`card form-q ${q.type === 'section' ? 'section' : ''}`}>
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <span className="small muted">{q.type === 'section' ? 'Abschnitt' : `Frage ${index + 1}`}</span>
        <select value={q.type} onChange={(e) => { const t = e.target.value as FormQuestionType; const base = newQuestion(t); onChange({ ...q, type: t, options: ['single', 'multiple', 'dropdown'].includes(t) ? (q.options.length ? q.options : base.options) : [], extra: base.extra }); }} style={{ width: 'auto' }}>
          {(Object.keys(FORM_TYPE_LABELS) as FormQuestionType[]).map((t) => <option key={t} value={t}>{FORM_TYPE_LABELS[t]}</option>)}
        </select>
        <span className="grow" />
        {q.type !== 'section' && <label className="row small"><input type="checkbox" checked={q.required} onChange={(e) => onChange({ ...q, required: e.target.checked })} /> Pflicht</label>}
        <button className="btn ghost sm" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="btn ghost sm" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
        <button className="btn ghost sm" title="Kopieren" onClick={onCopy}><Icon name="copy" /></button>
        <button className="btn ghost sm" title="Löschen" onClick={onDelete}><Icon name="trash" /></button>
      </div>
      <input className="form-q-text" value={q.text} placeholder={q.type === 'section' ? 'Überschrift des Abschnitts' : 'Frage'} onChange={(e) => onChange({ ...q, text: e.target.value })} />
      <input className="small" value={q.description} placeholder="Erläuterung (optional)" onChange={(e) => onChange({ ...q, description: e.target.value })} style={{ marginTop: 4 }} />
      {choice && (
        <div style={{ marginTop: 8 }}>
          {q.options.map((o, i) => (
            <div key={o.id} className="row" style={{ marginBottom: 4 }}>
              <Icon name={q.type === 'multiple' ? 'square' : 'circle'} />
              <input ref={(el) => { refs.current[i] = el; }} value={o.text} placeholder={`Möglichkeit ${i + 1}`} onChange={(e) => setOpt(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onChange({ ...q, options: [...q.options.slice(0, i + 1), { id: uid().slice(0, 8), text: '' }, ...q.options.slice(i + 1)] }); setTimeout(() => refs.current[i + 1]?.focus(), 30); } }} />
              <button className="btn ghost sm" disabled={q.options.length <= 1} onClick={() => onChange({ ...q, options: q.options.filter((_, j) => j !== i) })}><Icon name="x" /></button>
            </div>
          ))}
          <div className="row wrap small" style={{ gap: 12 }}>
            <button className="btn ghost sm" onClick={() => onChange({ ...q, options: [...q.options, { id: uid().slice(0, 8), text: '' }] })}><Icon name="plus" /> Möglichkeit</button>
            {q.type !== 'dropdown' && <label className="row"><input type="checkbox" checked={Boolean(q.extra.other)} onChange={(e) => ex({ other: e.target.checked })} /> „Sonstiges“ mit Freitext</label>}
            <label className="row"><input type="checkbox" checked={Boolean(q.extra.shuffle)} onChange={(e) => ex({ shuffle: e.target.checked })} /> Reihenfolge mischen</label>
            {q.type === 'multiple' && <label className="row">mind. <input type="number" min={0} style={{ width: 56 }} value={q.extra.minSelect ?? ''} onChange={(e) => ex({ minSelect: e.target.value ? Number(e.target.value) : undefined })} /></label>}
            {q.type === 'multiple' && <label className="row">höchstens <input type="number" min={1} style={{ width: 56 }} value={q.extra.maxSelect ?? ''} onChange={(e) => ex({ maxSelect: e.target.value ? Number(e.target.value) : undefined })} /></label>}
          </div>
        </div>
      )}
      {q.type === 'short' && (
        <div className="row small" style={{ marginTop: 8 }}>Prüfen auf
          <select value={q.extra.validation ?? 'none'} onChange={(e) => ex({ validation: e.target.value as 'none' })} style={{ width: 'auto' }}>
            <option value="none">nichts</option><option value="email">E-Mail-Adresse</option><option value="phone">Telefonnummer</option><option value="number">Zahl</option><option value="regex">eigenes Muster</option>
          </select>
          {q.extra.validation === 'regex' && <input className="mono" placeholder="z. B. ^\d{5}$" value={q.extra.regex ?? ''} onChange={(e) => ex({ regex: e.target.value })} />}
        </div>
      )}
      {q.type === 'scale' && (
        <div className="row wrap small" style={{ marginTop: 8, gap: 8 }}>
          von <select value={q.extra.min ?? 1} onChange={(e) => ex({ min: Number(e.target.value) })} style={{ width: 'auto' }}>{[0, 1].map((n) => <option key={n}>{n}</option>)}</select>
          bis <select value={q.extra.max ?? 5} onChange={(e) => ex({ max: Number(e.target.value) })} style={{ width: 'auto' }}>{[3, 4, 5, 6, 7, 10].map((n) => <option key={n}>{n}</option>)}</select>
          <input placeholder="Bezeichnung unten, z. B. gar nicht" value={q.extra.minLabel ?? ''} onChange={(e) => ex({ minLabel: e.target.value })} style={{ width: 200 }} />
          <input placeholder="Bezeichnung oben, z. B. sehr" value={q.extra.maxLabel ?? ''} onChange={(e) => ex({ maxLabel: e.target.value })} style={{ width: 200 }} />
        </div>
      )}
      {q.type === 'file' && (
        <div className="row small" style={{ marginTop: 8 }}>höchstens <input type="number" min={1} max={10} style={{ width: 56 }} value={q.extra.maxFiles ?? 1} onChange={(e) => ex({ maxFiles: Number(e.target.value) })} /> Datei(en), erlaubte Endungen
          <input placeholder="z. B. pdf, jpg (leer = alle)" value={(q.extra.fileTypes ?? []).join(', ')} onChange={(e) => ex({ fileTypes: e.target.value.split(/[,\s]+/).filter(Boolean) })} /></div>
      )}
    </div>
  );
}

function FormSettingsPanel({ form, onChanged }: { form: any; onChanged: () => void }) {
  const act = useAction();
  const toast = useToast();
  const { users, teams } = useSession();
  const [s, setS] = useState<FormSettings>(form.settings);
  const [shares, setShares] = useState<any[]>(form.shares);
  const [publicUrl, setPublicUrl] = useState<string | null>(form.publicUrl);
  const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const saveS = async (next: FormSettings) => { setS(next); if (await act(() => patch(`/forms/${form.id}`, { settings: next }))) onChanged(); };
  const saveShares = async (next: any[]) => { setShares(next); await act(() => put(`/forms/${form.id}/shares`, { shares: next.map((x) => ({ userId: x.userId ?? null, teamId: x.teamId ?? null, everyone: Boolean(x.everyone), permission: x.permission })) })); onChanged(); };
  const userIds = shares.filter((x) => x.userId).map((x) => x.userId);
  return (
    <div className="grid2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Einstellungen</h3>
        <label className="row"><input type="checkbox" checked={s.anonymous} disabled={form.responses > 0 && s.anonymous} onChange={(e) => saveS({ ...s, anonymous: e.target.checked })} /> Anonyme Antworten (Namen werden nicht angezeigt)</label>
        <label className="row"><input type="checkbox" checked={s.allowMultiple} onChange={(e) => saveS({ ...s, allowMultiple: e.target.checked })} /> Mehrfach ausfüllen erlaubt</label>
        <label className="row"><input type="checkbox" checked={s.allowEdit} disabled={s.anonymous} onChange={(e) => saveS({ ...s, allowEdit: e.target.checked })} /> Eigene Antwort nachträglich ändern</label>
        <label className="row"><input type="checkbox" checked={s.showResultsToRespondents} onChange={(e) => saveS({ ...s, showResultsToRespondents: e.target.checked })} /> Teilnehmer sehen nach dem Absenden die Zusammenfassung</label>
        <label className="row"><input type="checkbox" checked={s.closed} onChange={(e) => saveS({ ...s, closed: e.target.checked })} /> Formular geschlossen (keine neuen Antworten)</label>
        <Field label="Teilnahme bis"><input type="datetime-local" value={local(s.expiresAt)} onChange={(e) => saveS({ ...s, expiresAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
        <Field label="Text nach dem Absenden"><textarea rows={2} value={s.submitMessage} onChange={(e) => setS({ ...s, submitMessage: e.target.value })} onBlur={() => saveS(s)} /></Field>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Teilen</h3>
        <label className="row"><input type="checkbox" checked={Boolean(publicUrl)} onChange={async (e) => {
          const on = e.target.checked;
          setPublicUrl(on ? '…' : null);
          const r = await act(() => patch<{ publicUrl: string | null }>(`/forms/${form.id}`, { publicLink: on }));
          setPublicUrl(r ? r.publicUrl : form.publicUrl); onChanged();
        }} /> Öffentlicher Link (ohne Anmeldung, z. B. für Kunden)</label>
        {publicUrl && publicUrl !== '…' && <div className="row" style={{ margin: '6px 0 12px' }}><input readOnly className="mono small" value={publicUrl} /><button className="btn" onClick={async () => { await navigator.clipboard.writeText(publicUrl).catch(() => {}); toast('Link kopiert'); }}><Icon name="copy" /></button></div>}
        <label className="row"><input type="checkbox" checked={shares.some((x) => x.everyone)} onChange={(e) => saveShares(e.target.checked ? [...shares, { everyone: true, permission: 'submit' }] : shares.filter((x) => !x.everyone))} /> Alle Mitarbeiter dürfen ausfüllen</label>
        <Field label="Bestimmte Personen"><UserPicker users={users} value={userIds} onChange={(ids) => saveShares([...shares.filter((x) => !x.userId), ...ids.map((uid2) => shares.find((x) => x.userId === uid2) ?? { userId: uid2, permission: 'submit' })])} /></Field>
        <Field label="Abteilungen / Teams">
          <select value="" onChange={(e) => e.target.value && saveShares([...shares, { teamId: e.target.value, permission: 'submit' }])}><option value="">Team hinzufügen …</option>{teams.filter((t) => !shares.some((x) => x.teamId === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </Field>
        {shares.filter((x) => !x.everyone).map((x, i) => (
          <div key={i} className="row small" style={{ padding: '3px 0' }}>
            <span className="grow">{x.userId ? users.find((u) => u.id === x.userId)?.displayName ?? x.userName : teams.find((t) => t.id === x.teamId)?.name ?? x.teamName}</span>
            <select value={x.permission} onChange={(e) => saveShares(shares.map((y) => (y === x ? { ...y, permission: e.target.value } : y)))} style={{ width: 'auto' }}>
              <option value="submit">ausfüllen</option><option value="results">Ergebnisse sehen</option><option value="edit">bearbeiten</option>
            </select>
            <button className="btn ghost sm" onClick={() => saveShares(shares.filter((y) => y !== x))}><Icon name="x" /></button>
          </div>
        ))}
        <p className="hint">Neu eingeladene Personen erhalten eine Benachrichtigung.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Ergebnisse
function Results({ id }: { id: string }) {
  const act = useAction();
  const { data, reload } = useApi<any>(`/forms/${id}/results`);
  const [view, setView] = useState<'summary' | 'responses'>('summary');
  const [clear, setClear] = useState(false);
  const { data: form } = useApi<any>(`/forms/${id}`);
  if (!data) return null;
  if (!data.total) return <Empty icon="chart" title="Noch keine Antworten">Teilen Sie das Formular – die Auswertung erscheint hier, sobald die ersten Antworten da sind.</Empty>;
  const qById = new Map<string, FormQuestion>((form?.questions ?? []).map((q: FormQuestion) => [q.id, q]));
  const show = (q: FormQuestion | undefined, a: FormAnswers, qid: string) => {
    const v = a[qid], other = a[`other:${qid}`];
    if (!q) return '';
    const t = (x: string) => q.options.find((o) => o.id === x)?.text ?? x;
    let s = v == null ? '' : Array.isArray(v) ? (q.type === 'file' ? (v as any[]).map((f) => f.name).join(', ') : (v as string[]).map(t).join(', ')) : ['single', 'dropdown'].includes(q.type) ? t(String(v)) : String(v);
    if (typeof other === 'string' && other) s = s ? `${s}, ${other}` : other;
    return s;
  };
  return (
    <div>
      <div className="toolbar">
        <button className={`btn sm ${view === 'summary' ? 'primary' : ''}`} onClick={() => setView('summary')}>Zusammenfassung</button>
        {data.responses.length > 0 && <button className={`btn sm ${view === 'responses' ? 'primary' : ''}`} onClick={() => setView('responses')}>Einzelne Antworten ({data.total})</button>}
        <span className="grow" />
        {data.responses.length > 0 && <><a className="btn sm" href={`/api/forms/${id}/export?format=xlsx`}><Icon name="file-excel" /> Excel</a><a className="btn sm" href={`/api/forms/${id}/export?format=csv`}><Icon name="file-text" /> CSV</a></>}
        {data.canManage && <button className="btn sm ghost danger" onClick={() => setClear(true)}>Alle Antworten löschen</button>}
      </div>
      {view === 'summary' ? data.summary.map((s: any) => (
        <div key={s.id} className="card" style={{ marginBottom: 10 }}>
          <div className="row"><b className="grow">{s.text || FORM_TYPE_LABELS[s.type as FormQuestionType]}</b><span className="small muted">{s.answered} Antworten{s.average != null ? ` · Durchschnitt ${s.average.toLocaleString('de-DE', { maximumFractionDigits: 2 })}` : ''}</span></div>
          {s.counts && <div style={{ marginTop: 8 }}>{s.counts.map((c: any) => {
            const pct = data.total ? Math.round((c.count / data.total) * 100) : 0;
            return <div key={c.id} className="bar-row"><span className="bar-label">{c.text}</span><span className="bar-track"><span className="bar-fill" style={{ width: `${pct}%` }} /></span><span className="small mono" style={{ width: 70, textAlign: 'right' }}>{c.count} · {pct} %</span></div>;
          })}</div>}
          {s.others?.length > 0 && <div className="small" style={{ marginTop: 6 }}><span className="muted">Sonstiges:</span> {s.others.join(' · ')}</div>}
          {s.texts && <div className="form-texts">{s.texts.map((t: string, i: number) => <div key={i}>{t}</div>)}</div>}
          {s.files && <div style={{ marginTop: 6 }}>{s.files.map((f: any, i: number) => <a key={i} className="row small" href={`/api/forms/${id}/responses/${f.responseId}/files/${s.id}/${f.index}`}><Icon name="paperclip" /> {f.name} <span className="muted">{fmtBytes(f.size)}</span></a>)}</div>}
        </div>
      )) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Zeitpunkt</th>{!data.anonymous && <th>Person</th>}{data.summary.map((s: any) => <th key={s.id}>{s.text}</th>)}{data.canManage && <th />}</tr></thead>
          <tbody>{data.responses.map((r: any) => (
            <tr key={r.id}>
              <td className="small">{fmtDateTime(r.createdAt)}</td>
              {!data.anonymous && <td className="small">{r.userName ?? (r.public ? 'Extern' : '')}</td>}
              {data.summary.map((s: any) => <td key={s.id} className="small">{show(qById.get(s.id), r.answers, s.id)}</td>)}
              {data.canManage && <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/forms/${id}/responses/${r.id}`), 'Antwort gelöscht')) reload(); }}><Icon name="trash" /></button></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {clear && <Confirm danger text={`Alle ${data.total} Antworten endgültig löschen?`} onClose={() => setClear(false)} onConfirm={async () => { if (await act(() => del(`/forms/${id}/responses`), 'Antworten gelöscht')) reload(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Ausfüllen
function FillInternal({ id }: { id: string }) {
  const { data, reload } = useApi<any>(`/forms/${id}/fill`);
  useCrumbs([{ label: 'Formulare', to: '/forms' }, { label: data?.title || 'Formular' }]);
  if (!data) return null;
  return <div className="page"><FormFill form={data} uploadUrl={`/forms/${id}/uploads`} submit={(answers, editId) => (editId ? put(`/forms/${id}/responses/${editId}`, { answers }) : post(`/forms/${id}/responses`, { answers }))} onDone={reload} resultsLink={data.showResults ? `/forms/${id}?tab=results` : undefined} /></div>;
}

/** Ausfüll-Ansicht – intern und über den öffentlichen Link */
export function FormFill({ form, uploadUrl, submit, onDone, resultsLink }: {
  form: any; uploadUrl: string; submit: (a: FormAnswers, editId?: string) => Promise<{ message?: string }>; onDone?: () => void; resultsLink?: string;
}) {
  const toast = useToast();
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const questions: FormQuestion[] = form.questions;
  const canSubmit = form.open && (!form.answered || form.allowMultiple || editId);
  const set = (k: string, v: FormAnswers[string]) => { setAnswers((a) => ({ ...a, [k]: v })); setErrors((e) => { const n = { ...e }; delete n[k.replace(/^other:/, '')]; return n; }); };
  const send = async () => {
    const errs = validateFormAnswers(questions, answers);
    setErrors(errs);
    if (Object.keys(errs).length) { document.getElementById(`q-${Object.keys(errs)[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    setBusy(true);
    try { const r = await submit(answers, editId ?? undefined); setDone(r.message ?? 'Vielen Dank!'); onDone?.(); }
    catch (e: any) { if (e.details) setErrors(e.details); toast(e.message, 'error'); }
    setBusy(false);
  };
  if (done) return (
    <div className="form-fill"><div className="card form-done"><Icon name="check-circle" size={36} /><h2>{form.title}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{done}</p>
      <div className="row" style={{ justifyContent: 'center' }}>{form.allowMultiple && <button className="btn" onClick={() => { setAnswers({}); setDone(null); setEditId(null); }}>Weitere Antwort</button>}
        {resultsLink && <Link className="btn" to={resultsLink}>Ergebnisse ansehen</Link>}</div></div></div>
  );
  return (
    <div className="form-fill">
      <div className="card form-head"><h1>{form.title || 'Formular'}</h1>{form.description && <p style={{ whiteSpace: 'pre-wrap' }}>{form.description}</p>}
        <div className="small muted">{form.anonymous ? 'Die Antworten werden ohne Namen gespeichert.' : ''} {form.expiresAt && `Teilnahme bis ${fmtDateTime(form.expiresAt)}.`}</div>
        {!form.open && <div className="card flat" style={{ marginTop: 8 }}><Icon name="lock" /> Dieses Formular nimmt keine Antworten mehr an.</div>}
        {form.open && form.answered && !form.allowMultiple && !editId && <div className="card flat" style={{ marginTop: 8 }}><Icon name="check-circle" /> Sie haben bereits geantwortet.
          {form.allowEdit && form.myResponses?.[0] && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { setEditId(form.myResponses[0].id); setAnswers(form.myResponses[0].answers); }}>Antwort ändern</button>}
          {resultsLink && <Link className="btn sm" style={{ marginLeft: 8 }} to={resultsLink}>Ergebnisse</Link>}</div>}
      </div>
      {canSubmit && <>
        {questions.map((q) => q.type === 'section'
          ? <div key={q.id} className="form-section"><h2>{q.text}</h2>{q.description && <p className="muted">{q.description}</p>}</div>
          : <div key={q.id} id={`q-${q.id}`} className={`card form-fill-q ${errors[q.id] ? 'error' : ''}`}>
              <div className="form-q-title">{q.text || 'Frage'}{q.required && <span className="req"> *</span>}</div>
              {q.description && <div className="small muted" style={{ marginBottom: 6 }}>{q.description}</div>}
              <AnswerInput q={q} answers={answers} set={set} uploadUrl={uploadUrl} />
              {errors[q.id] && <div className="error-text small" style={{ marginTop: 4 }}>{errors[q.id]}</div>}
            </div>)}
        <button className="btn primary" disabled={busy} onClick={send}>{busy ? 'Wird gesendet …' : editId ? 'Änderung speichern' : 'Absenden'}</button>
      </>}
    </div>
  );
}

function AnswerInput({ q, answers, set, uploadUrl }: { q: FormQuestion; answers: FormAnswers; set: (k: string, v: FormAnswers[string]) => void; uploadUrl: string }) {
  const toast = useToast();
  const v = answers[q.id];
  const other = (answers[`other:${q.id}`] as string) ?? '';
  const [uploading, setUploading] = useState(false);
  switch (q.type) {
    case 'short': return <input value={(v as string) ?? ''} onChange={(e) => set(q.id, e.target.value)} type={q.extra.validation === 'email' ? 'email' : q.extra.validation === 'phone' ? 'tel' : 'text'} inputMode={q.extra.validation === 'number' ? 'decimal' : undefined} />;
    case 'long': return <textarea rows={4} value={(v as string) ?? ''} onChange={(e) => set(q.id, e.target.value)} />;
    case 'date': return <input type="date" value={(v as string) ?? ''} onChange={(e) => set(q.id, e.target.value)} style={{ maxWidth: 200 }} />;
    case 'time': return <input type="time" value={(v as string) ?? ''} onChange={(e) => set(q.id, e.target.value)} style={{ maxWidth: 160 }} />;
    case 'datetime': return <input type="datetime-local" value={(v as string) ?? ''} onChange={(e) => set(q.id, e.target.value)} style={{ maxWidth: 240 }} />;
    case 'dropdown': return <select value={(v as string) ?? ''} onChange={(e) => set(q.id, e.target.value || null)} style={{ maxWidth: 400 }}><option value="">Bitte wählen</option>{q.options.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}</select>;
    case 'single': return (
      <div className="form-choices">
        {q.options.map((o) => <label key={o.id} className="row"><input type="radio" name={q.id} checked={v === o.id} onChange={() => { set(q.id, o.id); if (other) set(`other:${q.id}`, ''); }} /> {o.text}</label>)}
        {q.extra.other && <label className="row"><input type="radio" name={q.id} checked={v == null && Boolean(other)} onChange={() => set(q.id, null)} /> Sonstiges: <input value={other} onChange={(e) => { set(`other:${q.id}`, e.target.value); set(q.id, null); }} /></label>}
      </div>
    );
    case 'multiple': {
      const sel = (v as string[]) ?? [];
      return (
        <div className="form-choices">
          {q.options.map((o) => <label key={o.id} className="row"><input type="checkbox" checked={sel.includes(o.id)} onChange={(e) => set(q.id, e.target.checked ? [...sel, o.id] : sel.filter((x) => x !== o.id))} /> {o.text}</label>)}
          {q.extra.other && <label className="row"><input type="checkbox" checked={Boolean(other)} readOnly /> Sonstiges: <input value={other} onChange={(e) => set(`other:${q.id}`, e.target.value)} /></label>}
        </div>
      );
    }
    case 'scale': {
      const min = q.extra.min ?? 1, max = q.extra.max ?? 5;
      return (
        <div className="form-scale">
          {q.extra.minLabel && <span className="small muted">{q.extra.minLabel}</span>}
          {Array.from({ length: max - min + 1 }, (_, i) => String(min + i)).map((n) => <button key={n} type="button" className={`btn ${v === n ? 'primary' : ''}`} onClick={() => set(q.id, n)}>{n}</button>)}
          {q.extra.maxLabel && <span className="small muted">{q.extra.maxLabel}</span>}
        </div>
      );
    }
    case 'file': {
      const files = (v as { name: string; path: string; size: number }[]) ?? [];
      const max = q.extra.maxFiles ?? 1;
      const accept = q.extra.fileTypes?.length ? q.extra.fileTypes.map((t) => `.${t.replace(/^\./, '')}`).join(',') : undefined;
      return (
        <div>
          {files.map((f, i) => <div key={i} className="row small"><Icon name="paperclip" /> {f.name} <span className="muted">{fmtBytes(f.size)}</span><button className="btn ghost sm" onClick={() => set(q.id, files.filter((_, j) => j !== i))}><Icon name="x" /></button></div>)}
          {files.length < max && <label className="btn sm">{uploading ? 'Lädt hoch …' : <><Icon name="upload" /> Datei wählen</>}<input type="file" hidden accept={accept} onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            if (accept && !accept.split(',').some((x) => f.name.toLowerCase().endsWith(x))) { toast(`Erlaubt: ${accept}`, 'error'); return; }
            const fd = new FormData(); fd.append('file', f, f.name);
            setUploading(true);
            try { const r = await upload(uploadUrl, fd); set(q.id, [...files, ...r]); } catch (err) { toast((err as Error).message, 'error'); }
            setUploading(false);
          }} /></label>}
        </div>
      );
    }
    default: return null;
  }
}

/** Öffentliche Seite /form/:token (ohne Anmeldung) */
export function PublicFormPage() {
  const token = location.pathname.split('/')[2] ?? '';
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { fetch(`/api/form/${token}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setForm(j); }).catch((e) => setError(e.message)); }, [token]);
  const submit = useMemo(() => async (answers: FormAnswers) => {
    const r = await fetch(`/api/form/${token}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error), { details: j.details });
    return j;
  }, [token]);
  return (
    <div className="public-form">
      <div className="row" style={{ justifyContent: 'center', marginBottom: 16 }}><img src="/logo-mark.svg" alt="" width={32} height={32} /><b>{form?.company}</b></div>
      {error ? <div className="card" style={{ maxWidth: 640, margin: '0 auto' }}><h2>Nicht verfügbar</h2><p className="muted">{error}</p></div>
        : form ? <FormFill form={form} uploadUrl={`/form/${token}/uploads`} submit={submit} /> : <p className="muted" style={{ textAlign: 'center' }}>Wird geladen …</p>}
    </div>
  );
}
