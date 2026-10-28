import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post, put } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, isoDate } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { uploadForm } from '../modules/Pickers';
import { useAdminSettings } from './Settings';

type Tab = 'people' | 'skills' | 'jobs' | 'settings';
const LEVEL = ['', 'Grundkenntnisse', 'selbstständig', 'erfahren', 'Experte / Ausbilder'];
const STAGE: Record<string, [string, string]> = { new: ['neu', 'red'], screening: ['in Prüfung', 'blue'], interview: ['Gespräch', 'amber'], offer: ['Angebot', 'amber'], hired: ['eingestellt', 'green'], rejected: ['abgesagt', ''] };
const REVIEW_KIND: Record<string, string> = { annual: 'Jahresgespräch', probation: 'Probezeitgespräch', feedback: 'Feedbackgespräch', development: 'Entwicklungsgespräch', return: 'Rückkehrgespräch' };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'hr.changed') void reload(); }), [reload]);
}

export default function HrPage() {
  useCrumbs([{ label: 'Personal' }]);
  const { me } = useSession();
  const { data: access } = useApi<{ manager: boolean }>('/hr/access');
  const [tab, setTab] = useTabState<Tab>('hr', 'people');
  if (!access) return null;
  if (!access.manager) return <div className="page"><Empty icon="lock" title="Nur für Personalverantwortliche">Deine eigenen Unterlagen findest du unter „Meine Unterlagen“.</Empty></div>;
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Personal</h1><div className="sub">Personalakte, Gespräche, Qualifikationen und Bewerbungen</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'people', label: 'Mitarbeiter' }, { id: 'skills', label: 'Qualifikationen' }, { id: 'jobs', label: 'Stellen und Bewerbungen' }, ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />
      {tab === 'people' && <People />}
      {tab === 'skills' && <Matrix />}
      {tab === 'jobs' && <Jobs />}
      {tab === 'settings' && <HrSettings />}
      <p className="hint" style={{ marginTop: 20 }}>Personaldaten sind besonders schützenswert. Zugriff haben nur Administratoren und die eingetragenen Personalverantwortlichen; jede Änderung steht im Protokoll.</p>
    </div>
  );
}

function People() {
  const [params, setParams] = useSearchParams();
  const { data, reload } = useApi<any[]>('/hr/people');
  useLive(reload);
  const open = params.get('person');
  const setOpen = (id: string | null) => { if (id) params.set('person', id); else params.delete('person'); setParams(params, { replace: true }); };
  return (
    <div>
      {data && <table className="table"><thead><tr><th>Mitarbeiter</th><th>Dokumente</th><th>Letztes Gespräch</th><th>Qualifikationen</th></tr></thead>
        <tbody>{data.map((p) => (
          <tr key={p.id} className="click" onClick={() => setOpen(p.id)}>
            <td className="row" style={{ gap: 8 }}><Avatar id={p.id} name={p.displayName} /><b>{p.displayName}</b></td>
            <td>{p.documents}{p.expiring > 0 && <span className="pill small amber" style={{ marginLeft: 6 }}>{p.expiring} laufen ab</span>}</td>
            <td>{fmtDate(p.lastReview)}</td><td>{p.skills}</td>
          </tr>
        ))}</tbody></table>}
      {open && <PersonPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PersonPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: p, reload } = useApi<any>(`/hr/people/${id}`, [id]);
  const s = useAdminSettings('hr');
  const act = useAction();
  const [tab, setTab] = useState<'docs' | 'reviews' | 'skills'>('docs');
  const [upload, setUpload] = useState(false);
  const [review, setReview] = useState<any | null>(null);
  const [skill, setSkill] = useState(false);
  useLive(reload);
  if (!p) return null;
  const cats = s.value?.documentCategories ?? ['Arbeitsvertrag', 'Zeugnis', 'Bescheinigung', 'Sonstiges'];
  return (
    <SlideOver wide title={p.displayName} onClose={onClose}>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'docs', label: `Personalakte (${p.documents.length})` }, { id: 'reviews', label: `Gespräche (${p.reviews.length})` }, { id: 'skills', label: `Qualifikationen (${p.skills.length})` }]} />
      {tab === 'docs' && <>
        <div className="toolbar"><span className="right"><button className="btn primary sm" onClick={() => setUpload(true)}><Icon name="upload" /> Dokument</button></span></div>
        {!p.documents.length && <p className="muted">Noch keine Dokumente.</p>}
        <table className="table small"><tbody>{p.documents.map((d: any) => (
          <tr key={d.id}><td className="muted" style={{ width: 120 }}>{d.category}</td><td><a href={`/api/hr/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.title}</a></td>
            <td className={d.validUntil && d.validUntil < isoDate(new Date()) ? 'text-red' : ''}>{d.validUntil ? `gültig bis ${fmtDate(d.validUntil)}` : ''}</td>
            <td><label className="row small" title="Für den Mitarbeiter unter „Meine Unterlagen“ sichtbar"><input type="checkbox" checked={d.visibleToEmployee} onChange={async (e) => { if (await act(() => patch(`/hr/documents/${d.id}`, { visibleToEmployee: e.target.checked }))) void reload(); }} /> sichtbar</label></td>
            <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/hr/documents/${d.id}`), 'Gelöscht')) void reload(); }}><Icon name="trash" /></button></td></tr>
        ))}</tbody></table>
      </>}
      {tab === 'reviews' && <>
        <div className="toolbar"><span className="right"><button className="btn primary sm" onClick={() => setReview({ date: isoDate(new Date()), kind: 'annual', notes: '', goals: [], shared: false })}><Icon name="plus" /> Gespräch</button></span></div>
        {p.reviews.map((r: any) => (
          <div key={r.id} className="card flat click" style={{ marginBottom: 8 }} onClick={() => setReview(r)}>
            <div className="row"><b className="grow">{REVIEW_KIND[r.kind] ?? r.kind} am {fmtDate(r.date)}</b>{r.shared && <Pill tone="blue">mit Mitarbeiter geteilt</Pill>}</div>
            <div className="small muted">{r.goals.filter((g: any) => g.done).length}/{r.goals.length} Ziele erreicht · {r.createdByName}</div>
          </div>
        ))}
      </>}
      {tab === 'skills' && <>
        <div className="toolbar"><span className="right"><button className="btn primary sm" onClick={() => setSkill(true)}><Icon name="plus" /> Qualifikation</button></span></div>
        <table className="table small"><tbody>{p.skills.map((k: any) => (
          <tr key={k.id}><td><b>{k.name}</b><div className="muted">{k.category}</div></td><td>{LEVEL[k.level]}</td>
            <td className={k.validUntil && k.validUntil < isoDate(new Date()) ? 'text-red' : ''}>{k.validUntil ? `bis ${fmtDate(k.validUntil)}` : ''}</td>
            <td>{k.hasCertificate ? <a href={`/api/hr/people/${id}/skills/${k.id}/certificate`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> Nachweis</a>
              : <label className="btn ghost sm"><Icon name="upload" /> Nachweis<input type="file" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f && await act(() => uploadForm(`/hr/people/${id}/skills/${k.id}/certificate`, {}, f), 'Hochgeladen')) void reload(); }} /></label>}</td>
            <td><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/hr/people/${id}/skills/${k.id}`))) void reload(); }}><Icon name="x" /></button></td></tr>
        ))}</tbody></table>
      </>}
      {upload && <UploadDoc userId={id} cats={cats} onClose={() => setUpload(false)} onDone={() => { setUpload(false); void reload(); }} />}
      {review && <ReviewModal userId={id} review={review} onClose={() => setReview(null)} onDone={() => { setReview(null); void reload(); }} />}
      {skill && <SkillModal userId={id} onClose={() => setSkill(false)} onDone={() => { setSkill(false); void reload(); }} />}
    </SlideOver>
  );
}

function UploadDoc({ userId, cats, onClose, onDone }: { userId: string; cats: string[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ category: cats[0] ?? 'Sonstiges', title: '', validUntil: '', visibleToEmployee: false });
  const [file, setFile] = useState<File | null>(null);
  return (
    <Modal title="Dokument in die Personalakte" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!file} onClick={async () => { if (await act(() => uploadForm(`/hr/people/${userId}/documents`, { ...f, visibleToEmployee: String(f.visibleToEmployee) }, file), 'Gespeichert')) onDone(); }}>Hochladen</button></>}>
      <Field label="Datei"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <div className="grid2">
        <Field label="Art"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{cats.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Gültig bis" hint="z. B. Aufenthaltstitel, Gesundheitszeugnis"><input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></Field>
      </div>
      <Field label="Bezeichnung"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="leer = Dateiname" /></Field>
      <label className="row"><input type="checkbox" checked={f.visibleToEmployee} onChange={(e) => setF({ ...f, visibleToEmployee: e.target.checked })} /> Mitarbeiter darf das Dokument sehen</label>
    </Modal>
  );
}

function ReviewModal({ userId, review, onClose, onDone }: { userId: string; review: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState(review);
  const [goal, setGoal] = useState('');
  const body = { date: f.date, kind: f.kind, notes: f.notes, goals: f.goals, shared: f.shared };
  return (
    <Modal size="lg" title={review.id ? 'Mitarbeitergespräch' : 'Neues Mitarbeitergespräch'} onClose={onClose} footer={<>
      {review.id && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/hr/reviews/${review.id}`))) onDone(); }}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => { if (await act(() => (review.id ? patch(`/hr/reviews/${review.id}`, body) : post(`/hr/people/${userId}/reviews`, body)), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Datum"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(REVIEW_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <Field label="Protokoll"><textarea rows={8} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Rückblick, Stärken, Entwicklung, Wünsche, Vereinbarungen …" /></Field>
      <h3 style={{ margin: '6px 0 4px' }}>Ziele</h3>
      {f.goals.map((g: any, i: number) => (
        <div key={i} className="row" style={{ gap: 6, padding: '2px 0' }}>
          <input type="checkbox" checked={g.done} onChange={(e) => setF({ ...f, goals: f.goals.map((x: any, k: number) => (k === i ? { ...x, done: e.target.checked } : x)) })} />
          <span className="grow">{g.text}</span>
          <input type="date" style={{ width: 150 }} value={g.due ?? ''} onChange={(e) => setF({ ...f, goals: f.goals.map((x: any, k: number) => (k === i ? { ...x, due: e.target.value || null } : x)) })} />
          <button className="btn ghost sm" onClick={() => setF({ ...f, goals: f.goals.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button>
        </div>
      ))}
      <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (goal.trim()) { setF({ ...f, goals: [...f.goals, { text: goal.trim(), done: false, due: null }] }); setGoal(''); } }}>
        <input className="grow" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Ziel hinzufügen …" /><button className="btn" type="submit">Hinzufügen</button></form>
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} /> Protokoll und Ziele mit dem Mitarbeiter teilen</label>
    </Modal>
  );
}

function SkillModal({ userId, onClose, onDone }: { userId: string; onClose: () => void; onDone: () => void }) {
  const { data: skills } = useApi<any[]>('/hr/skills');
  const act = useAction();
  const [f, setF] = useState({ skillId: '', level: 2, validUntil: '', note: '' });
  return (
    <Modal title="Qualifikation eintragen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.skillId} onClick={async () => { if (await act(() => put(`/hr/people/${userId}/skills/${f.skillId}`, { level: f.level, validUntil: f.validUntil || null, note: f.note }), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <Field label="Qualifikation" hint="Katalog unter „Qualifikationen“ pflegen"><select value={f.skillId} onChange={(e) => setF({ ...f, skillId: e.target.value })}><option value="">–</option>{skills?.map((k) => <option key={k.id} value={k.id}>{k.category ? `${k.category}: ` : ''}{k.name}</option>)}</select></Field>
      <div className="grid2">
        <Field label="Stufe"><select value={f.level} onChange={(e) => setF({ ...f, level: Number(e.target.value) })}>{[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVEL[l]}</option>)}</select></Field>
        <Field label="Gültig bis"><input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></Field>
      </div>
      <Field label="Bemerkung"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </Modal>
  );
}

function Matrix() {
  const { data, reload } = useApi<any>('/hr/matrix');
  const act = useAction();
  const [f, setF] = useState({ name: '', category: '' });
  useLive(reload);
  if (!data) return null;
  const val = (u: string, k: string) => data.values.find((v: any) => v.userId === u && v.skillId === k);
  const cats = [...new Set(data.skills.map((s: any) => s.category))];
  return (
    <div>
      <form className="toolbar" onSubmit={async (e) => { e.preventDefault(); if (await act(() => post('/hr/skills', f), 'Hinzugefügt')) { setF({ name: '', category: f.category }); void reload(); } }}>
        <input placeholder="Neue Qualifikation, z. B. Schweißschein, Kranschein" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ width: 300 }} />
        <input placeholder="Bereich" list="hr-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={{ width: 160 }} />
        <datalist id="hr-cats">{cats.map((c) => <option key={c as string} value={c as string} />)}</datalist>
        <button className="btn" type="submit" disabled={!f.name.trim()}><Icon name="plus" /> Hinzufügen</button>
      </form>
      {!data.skills.length ? <Empty icon="id-card" title="Noch keine Qualifikationen">Katalog anlegen (z. B. Staplerschein, Ersthelfer, Elektrofachkraft, SolidWorks), dann je Mitarbeiter mit Stufe und Gültigkeit eintragen.</Empty>
        : <div style={{ overflowX: 'auto' }}><table className="table small hr-matrix"><thead><tr><th />{data.skills.map((s: any) => <th key={s.id} title={s.category}><span>{s.name}</span></th>)}</tr></thead>
          <tbody>{data.people.map((p: any) => (
            <tr key={p.id}><td style={{ whiteSpace: 'nowrap' }}>{p.displayName}</td>{data.skills.map((s: any) => {
              const v = val(p.id, s.id);
              const expired = v?.validUntil && v.validUntil < isoDate(new Date());
              return <td key={s.id} className={`lvl-${v?.level ?? 0} ${expired ? 'expired' : ''}`} title={v ? `${LEVEL[v.level]}${v.validUntil ? ` · bis ${fmtDate(v.validUntil)}` : ''}` : ''}>{v ? '●'.repeat(v.level) : ''}</td>;
            })}</tr>
          ))}</tbody></table></div>}
    </div>
  );
}

function Jobs() {
  const { data: jobs, reload } = useApi<any[]>('/hr/jobs');
  const [job, setJob] = useState<string>('');
  const { data: apps, reload: reloadApps } = useApi<any[]>(`/hr/applicants${job ? `?jobId=${job}` : ''}`, [job]);
  const [edit, setEdit] = useState<any | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const toast = useToast();
  useLive(() => { void reload(); void reloadApps(); });
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ title: '', description: '', location: '', hours: 'Vollzeit', status: 'open' })}><Icon name="plus" /> Stelle</button></span></div>
      <div className="bk-types">{jobs?.map((j) => (
        <div key={j.id} className={`card click ${job === j.id ? 'sel' : ''}`} onClick={() => setJob(job === j.id ? '' : j.id)} style={j.status === 'closed' ? { opacity: 0.55 } : undefined}>
          <div className="row"><b className="grow">{j.title}</b>{j.newApplicants > 0 && <Pill tone="red">{j.newApplicants} neu</Pill>}</div>
          <div className="small muted">{j.location} · {j.hours} · {j.applicants} Bewerbungen · {{ draft: 'Entwurf', open: 'ausgeschrieben', closed: 'besetzt' }[j.status as string]}</div>
          <div className="row" style={{ gap: 6, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
            <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(j.publicUrl); toast('Link zur Stellenanzeige kopiert'); }}><Icon name="link" /> Link</button>
            <a className="btn sm" href={j.publicUrl} target="_blank" rel="noreferrer"><Icon name="eye" /></a>
            <button className="btn sm" onClick={() => setEdit(j)}><Icon name="edit" /></button>
          </div>
        </div>
      ))}</div>
      <h3>Bewerbungen{job ? ` – ${jobs?.find((j) => j.id === job)?.title}` : ''}</h3>
      {apps && !apps.length && <p className="muted">Keine Bewerbungen.</p>}
      <div className="hr-pipeline">{Object.entries(STAGE).map(([k, [l]]) => (
        <div key={k}><div className="small muted" style={{ fontWeight: 600, marginBottom: 4 }}>{l} ({apps?.filter((a) => a.stage === k).length ?? 0})</div>
          {apps?.filter((a) => a.stage === k).map((a) => (
            <div key={a.id} className="card flat click" style={{ marginBottom: 6 }} onClick={() => setOpen(a)}>
              <b>{a.name}</b><div className="small muted">{a.jobTitle ?? 'Initiativ'} · {fmtDate(a.createdAt)}</div>{a.rating > 0 && <div className="small">{'★'.repeat(a.rating)}</div>}
            </div>
          ))}</div>
      ))}</div>
      {edit && <JobModal job={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
      {open && <ApplicantPanel a={open} onClose={() => setOpen(null)} onChanged={() => { void reloadApps(); void reload(); }} />}
    </div>
  );
}

function JobModal({ job, onClose, onDone }: { job: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState(job);
  const body = { title: f.title, description: f.description, location: f.location, hours: f.hours, status: f.status };
  return (
    <Modal size="lg" title={job.id ? 'Stelle bearbeiten' : 'Neue Stelle'} onClose={onClose} footer={<>
      {job.id && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/hr/jobs/${job.id}`))) onDone(); }}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => { if (await act(() => (job.id ? patch(`/hr/jobs/${job.id}`, body) : post('/hr/jobs', body)), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <Field label="Stelle"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Konstrukteur Maschinenbau (m/w/d)" /></Field>
      <div className="grid3">
        <Field label="Ort"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Umfang"><input value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="draft">Entwurf</option><option value="open">ausgeschrieben</option><option value="closed">besetzt</option></select></Field>
      </div>
      <Field label="Anzeigetext"><textarea rows={10} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Aufgaben, Profil, Wir bieten …" /></Field>
    </Modal>
  );
}

function ApplicantPanel({ a, onClose, onChanged }: { a: any; onClose: () => void; onChanged: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ stage: a.stage, rating: a.rating, notes: a.notes });
  const [remove, setRemove] = useState(false);
  const save = async (p: Partial<typeof f>) => { const n = { ...f, ...p }; setF(n); if (await act(() => patch(`/hr/applicants/${a.id}`, p))) onChanged(); };
  return (
    <SlideOver title={a.name} onClose={onClose}>
      <div className="small"><a href={`mailto:${a.email}`}>{a.email}</a>{a.phone && ` · ${a.phone}`}</div>
      <div className="small muted" style={{ marginBottom: 10 }}>{a.jobTitle ?? 'Initiativbewerbung'} · eingegangen {fmtDate(a.createdAt)}{a.deleteAfter ? ` · wird am ${fmtDate(a.deleteAfter)} gelöscht` : ''}</div>
      <div className="grid2">
        <Field label="Stand"><select value={f.stage} onChange={(e) => void save({ stage: e.target.value })}>{Object.entries(STAGE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Bewertung"><div className="row" style={{ gap: 2 }}>{[1, 2, 3, 4, 5].map((n) => <button key={n} className={`btn sm ${f.rating >= n ? 'primary' : 'ghost'}`} onClick={() => void save({ rating: f.rating === n ? 0 : n })}>★</button>)}</div></Field>
      </div>
      {a.message && <div className="card flat small" style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{a.message}</div>}
      {a.files.map((x: any) => <div key={x.id}><a href={`/api/hr/applicants/${a.id}/files/${x.id}`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {x.name}</a></div>)}
      <Field label="Notizen"><textarea rows={6} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} onBlur={() => void save({ notes: f.notes })} /></Field>
      <button className="btn ghost danger sm" onClick={() => setRemove(true)}>Bewerbung jetzt löschen</button>
      {remove && <Confirm danger text="Bewerbung mit allen Unterlagen endgültig löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/hr/applicants/${a.id}`))) { onChanged(); onClose(); } }} />}
    </SlideOver>
  );
}

function HrSettings() {
  const s = useAdminSettings('hr');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 760 }}>
      <Field label="Personalverantwortliche" hint="sehen alle Personalakten und Bewerbungen"><UserPicker users={users} value={v.managerIds} onChange={(ids) => s.setValue({ ...v, managerIds: ids })} /></Field>
      <Field label="Bewerbungen löschen nach (Monaten)" hint="nach Absage oder Einstellung; üblich sind 6 Monate (AGG-Frist)"><input type="number" min={1} value={v.applicantRetentionMonths} onChange={(e) => s.setValue({ ...v, applicantRetentionMonths: Number(e.target.value) })} /></Field>
      <Field label="Dokumentarten" hint="durch Komma getrennt"><input value={v.documentCategories.join(', ')} onChange={(e) => s.setValue({ ...v, documentCategories: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} /></Field>
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
    </div>
  );
}

// ---------------------------------------------------------------- Meine Unterlagen
export function MyHrPage() {
  useCrumbs([{ label: 'Meine Unterlagen' }]);
  const { data, reload } = useApi<any>('/me/hr');
  const act = useAction();
  if (!data) return null;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Meine Unterlagen</h1><div className="sub">Dokumente aus der Personalakte, Gesprächsprotokolle und Qualifikationen</div></div></div>
      <h3>Dokumente</h3>
      {!data.documents.length ? <p className="muted">Keine freigegebenen Dokumente.</p> : <table className="table" style={{ maxWidth: 760 }}><tbody>{data.documents.map((d: any) => (
        <tr key={d.id}><td className="muted" style={{ width: 140 }}>{d.category}</td><td><a href={`/api/me/hr/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.title}</a></td><td>{d.validUntil ? `gültig bis ${fmtDate(d.validUntil)}` : ''}</td></tr>
      ))}</tbody></table>}
      <h3>Gespräche und Ziele</h3>
      {!data.reviews.length ? <p className="muted">Keine geteilten Gespräche.</p> : data.reviews.map((r: any) => (
        <div key={r.id} className="card" style={{ maxWidth: 760, marginBottom: 10 }}>
          <b>{REVIEW_KIND[r.kind] ?? r.kind} am {fmtDate(r.date)}</b>
          {r.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{r.notes}</p>}
          {r.goals.map((g: any, i: number) => <label key={i} className="row"><input type="checkbox" checked={g.done} onChange={async (e) => { if (await act(() => patch(`/me/hr/reviews/${r.id}`, { goals: r.goals.map((x: any, k: number) => ({ done: k === i ? e.target.checked : x.done })) }))) void reload(); }} /> {g.text}{g.due ? <span className="muted small"> · bis {fmtDate(g.due)}</span> : ''}</label>)}
        </div>
      ))}
      <h3>Qualifikationen</h3>
      {!data.skills.length ? <p className="muted">Keine eingetragen.</p> : <table className="table" style={{ maxWidth: 760 }}><tbody>{data.skills.map((k: any) => <tr key={k.id}><td><b>{k.name}</b></td><td>{LEVEL[k.level]}</td><td>{k.validUntil ? `bis ${fmtDate(k.validUntil)}` : ''}</td></tr>)}</tbody></table>}
    </div>
  );
}

// ---------------------------------------------------------------- Öffentliche Stellenanzeige
export function PublicJobPage() {
  const token = location.pathname.match(/^\/jobs\/([\w-]+)/)?.[1] ?? '';
  const [j, setJ] = useState<any>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '', consent: false, website: '' });
  const [files, setFiles] = useState<File[]>([]);
  useEffect(() => { void get(`/pub/jobs/${token}`).then(setJ).catch((x) => setErr((x as Error).message)); }, [token]);
  if (err && !j) return <div className="pub-page"><div className="pub-card"><p>{err}</p></div></div>;
  if (!j) return null;
  return (
    <div className="pub-page"><div className="pub-card">
      <div className="pub-company">{j.company}</div>
      <h1>{j.title}</h1>
      <p className="muted">{[j.location, j.hours].filter(Boolean).join(' · ')}</p>
      <div style={{ whiteSpace: 'pre-wrap' }}>{j.description}</div>
      <hr style={{ margin: '20px 0', border: 0, borderTop: '1px solid var(--line)' }} />
      {done ? <p><b>Vielen Dank für Ihre Bewerbung!</b> Wir melden uns bei Ihnen.</p> : !j.open ? <p><b>Diese Stelle ist bereits besetzt.</b></p> :
        <form onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          const fd = new FormData(); for (const [k, v] of Object.entries({ ...f, consent: String(f.consent) })) fd.append(k, String(v)); for (const x of files) fd.append('file', x, x.name);
          const r = await fetch(`/api/pub/jobs/${token}`, { method: 'POST', body: fd });
          if (r.ok) setDone(true); else setErr((await r.json().catch(() => ({}))).error ?? 'Fehler beim Senden');
        }}>
          <h3 style={{ marginTop: 0 }}>Jetzt bewerben</h3>
          <div className="grid2">
            <Field label="Name" required><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="E-Mail" required><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Telefon"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </div>
          <Field label="Nachricht"><textarea rows={4} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
          <Field label="Unterlagen" hint="Lebenslauf, Zeugnisse – PDF, Word oder Bild, bis zu 5 Dateien"><input type="file" multiple accept=".pdf,.doc,.docx,.odt,.jpg,.jpeg,.png" onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 5))} /></Field>
          <input className="hp" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} aria-hidden="true" />
          <label className="row small" style={{ margin: '8px 0' }}><input type="checkbox" required checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> Ich bin einverstanden, dass meine Angaben für das Bewerbungsverfahren gespeichert und nach Abschluss gelöscht werden.</label>
          {err && <p className="text-red">{err}</p>}
          <button className="btn primary" type="submit">Bewerbung absenden</button>
        </form>}
    </div></div>
  );
}
