import { useEffect, useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, UserSelect, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';

const monday = (d: Date) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return isoDate(x); };
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return isoDate(x); };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'planning.changed') void reload(); }), [reload]);
}

export default function PlanningPage() {
  useCrumbs([{ label: 'Einsatzplanung' }]);
  const { teams } = useSession();
  const [week, setWeek] = useState(() => monday(new Date()));
  const [team, setTeam] = useState('');
  const { data, reload } = useApi<any>(`/planning/week?from=${week}${team ? `&teamId=${team}` : ''}`, [week, team]);
  const { data: templates, reload: reloadTpl } = useApi<any[]>('/planning/templates');
  const { data: open, reload: reloadOpen } = useApi<any[]>('/planning/open');
  const act = useAction();
  const toast = useToast();
  const [edit, setEdit] = useState<any | null>(null);
  const [tpl, setTpl] = useState(false);
  const [copy, setCopy] = useState(false);
  useLive(() => { void reload(); void reloadOpen(); });
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  if (!data) return null;
  const planner = data.planner;
  const absent = (uid: string, d: string) => data.absences.find((a: any) => a.userId === uid && a.startDate <= d && a.endDate >= d);
  const holiday = (d: string) => data.holidays.find((h: any) => h.day === d);
  const rows: { id: string | null; displayName: string; hours?: number }[] = [...data.users, { id: null, displayName: 'Offene Schichten' }];
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Einsatzplanung</h1><div className="sub">Schichten und Einsätze je Woche</div></div>
        {planner && <div className="actions">
          <button className="btn" onClick={() => setTpl(true)}><Icon name="settings" /> Vorlagen</button>
          <button className="btn" onClick={() => setCopy(true)}><Icon name="copy" /> Woche kopieren</button>
          <button className="btn primary" disabled={!data.unpublished} onClick={async () => { const r = await act(() => post<any>('/planning/publish', { from: week })); if (r) toast(`${r.published} Schichten veröffentlicht, ${r.notified} Personen benachrichtigt`); }}>
            <Icon name="send" /> Veröffentlichen{data.unpublished ? ` (${data.unpublished})` : ''}</button></div>}</div>
      {!planner && open && open.length > 0 && <div className="card" style={{ marginBottom: 12 }}><b>Offene Schichten – wer übernimmt?</b>
        {open.map((s) => <div key={s.id} className="row small" style={{ gap: 8, padding: '3px 0' }}><span style={{ width: 160 }}>{new Date(`${s.date}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} {s.startTime}–{s.endTime}</span>
          <span className="grow">{s.role}{s.location ? ` · ${s.location}` : ''}</span><button className="btn sm primary" onClick={async () => { if (await act(() => post(`/planning/shifts/${s.id}/claim`, {}), 'Übernommen')) { void reload(); void reloadOpen(); } }}>Übernehmen</button></div>)}</div>}
      <div className="toolbar">
        <button className="btn sm" onClick={() => setWeek(addDays(week, -7))}><Icon name="chevron-left" /></button>
        <b>{fmtDate(week)} – {fmtDate(addDays(week, 6))}</b>
        <button className="btn sm" onClick={() => setWeek(addDays(week, 7))}><Icon name="chevron-right" /></button>
        <button className="btn sm ghost" onClick={() => setWeek(monday(new Date()))}>Heute</button>
        <select value={team} onChange={(e) => setTeam(e.target.value)} style={{ width: 'auto' }}><option value="">alle Mitarbeiter</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {planner && data.unpublished > 0 && <span className="small text-red">{data.unpublished} Änderungen noch nicht veröffentlicht</span>}
      </div>
      <div className="plan-grid" style={{ gridTemplateColumns: `180px repeat(7, minmax(110px, 1fr))` }}>
        <div className="plan-h" />
        {days.map((d) => <div key={d} className={`plan-h ${holiday(d) ? 'holiday' : ''} ${d === isoDate(new Date()) ? 'today' : ''}`}>{new Date(`${d}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}{holiday(d) && <div className="small">{holiday(d).name}</div>}</div>)}
        {rows.map((u) => (
          <div key={u.id ?? 'open'} className="plan-row" style={{ display: 'contents' }}>
            <div className="plan-name">{u.displayName}{u.id && <div className="small muted">{u.hours ?? 0} Std.</div>}</div>
            {days.map((d) => {
              const ab = u.id ? absent(u.id, d) : null;
              const list = data.shifts.filter((s: any) => (s.userId ?? null) === u.id && s.date === d);
              return (
                <div key={d} className={`plan-cell ${ab ? 'absent' : ''} ${planner ? 'click' : ''}`} onClick={() => planner && setEdit({ userId: u.id, date: d, startTime: templates?.[0]?.startTime ?? '08:00', endTime: templates?.[0]?.endTime ?? '16:30', role: templates?.[0]?.role ?? '', location: '', color: templates?.[0]?.color ?? '', note: '' })}>
                  {ab && <div className="plan-absent">{ab.status === 'pending' ? 'Urlaub beantragt' : 'abwesend'}</div>}
                  {list.map((s: any) => (
                    <div key={s.id} className={`plan-shift ${s.published ? '' : 'draft'}`} style={{ borderLeftColor: s.color || 'var(--accent)' }} onClick={(e) => { e.stopPropagation(); if (planner) setEdit(s); }}>
                      <b>{s.startTime}–{s.endTime}</b>{s.role && <div>{s.role}</div>}{s.location && <div className="muted">{s.location}</div>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!data.users.length && <Empty icon="users" title="Keine Mitarbeiter" />}
      {edit && <ShiftModal shift={edit} templates={templates ?? []} users={data.users} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
      {tpl && <Templates list={templates ?? []} onClose={() => setTpl(false)} onChanged={reloadTpl} />}
      {copy && <Confirm text={`Schichten der Vorwoche (${fmtDate(addDays(week, -7))}) in diese Woche kopieren? Noch nicht veröffentlichte Schichten dieser Woche werden ersetzt.`} confirmLabel="Kopieren" onClose={() => setCopy(false)}
        onConfirm={async () => { const r = await act(() => post<{ copied: number }>('/planning/copy', { from: addDays(week, -7), to: week, replace: true })); if (r) { toast(`${r.copied} Schichten kopiert`); void reload(); } }} />}
    </div>
  );
}

function ShiftModal({ shift, templates, users, onClose, onSaved }: { shift: any; templates: any[]; users: any[]; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ ...shift });
  const body = { userId: f.userId, date: f.date, startTime: f.startTime, endTime: f.endTime, role: f.role, location: f.location, color: f.color, note: f.note };
  return (
    <Modal title={`Schicht ${new Date(`${f.date}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}`} onClose={onClose} footer={<>
      {shift.id && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/planning/shifts/${shift.id}`))) onSaved(); }}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => { if (await act(() => (shift.id ? patch(`/planning/shifts/${shift.id}`, body) : post('/planning/shifts', body)))) onSaved(); }}>Speichern</button></>}>
      {templates.length > 0 && <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>{templates.map((t) => <button key={t.id} className="btn sm" style={{ borderLeft: `4px solid ${t.color}` }} onClick={() => setF({ ...f, startTime: t.startTime, endTime: t.endTime, role: t.role || t.name, color: t.color })}>{t.name}</button>)}</div>}
      <Field label="Mitarbeiter"><UserSelect users={users} value={f.userId} onChange={(v) => setF({ ...f, userId: v })} placeholder="– offene Schicht –" /></Field>
      <div className="grid3">
        <Field label="Datum"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Beginn"><input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
        <Field label="Ende"><input type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
      </div>
      <div className="grid2">
        <Field label="Aufgabe / Schicht"><input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
        <Field label="Ort"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      </div>
      <Field label="Notiz"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </Modal>
  );
}

function Templates({ list, onClose, onChanged }: { list: any[]; onClose: () => void; onChanged: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ name: '', startTime: '06:00', endTime: '14:00', role: '', color: '#4f46e5' });
  return (
    <Modal title="Schichtvorlagen" onClose={onClose}>
      {list.map((t) => <div key={t.id} className="row" style={{ gap: 8, padding: '3px 0' }}><span className="dot" style={{ background: t.color }} /><b style={{ width: 120 }}>{t.name}</b><span className="grow">{t.startTime}–{t.endTime} {t.role}</span>
        <button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/planning/templates/${t.id}`))) onChanged(); }}><Icon name="x" /></button></div>)}
      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
        <input style={{ width: 140 }} placeholder="Name, z. B. Früh" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input type="time" style={{ width: 110 }} value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} />
        <input type="time" style={{ width: 110 }} value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} />
        <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
        <button className="btn primary sm" disabled={!f.name.trim()} onClick={async () => { if (await act(() => post('/planning/templates', f))) { setF({ ...f, name: '' }); onChanged(); } }}>Hinzufügen</button>
      </div>
    </Modal>
  );
}
