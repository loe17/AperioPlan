import { useEffect, useState } from 'react';
import { put, invalidate } from '../lib/api';
import { fmtEuro, fmtHours } from '../lib/format';
import { Field, useAction } from '../components/ui';
import type { Task } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

interface ReportData { goals: string; result: string; costsPlanned: number | null; costsActual: number | null; lessons: string; acceptedBy: string; acceptedAt: string | null; notes: string }
const EMPTY: ReportData = { goals: '', result: '', costsPlanned: null, costsActual: null, lessons: '', acceptedBy: '', acceptedAt: null, notes: '' };

/** Abschlussbericht: Ziele, Ergebnis, Kosten und Abnahme */
export function Report({ project, tasks, canEdit }: { project: any; tasks: Task[]; canEdit: boolean }) {
  const act = useAction();
  const [r, setR] = useState<ReportData>({ ...EMPTY, ...(project.report ?? {}) });
  useEffect(() => { setR({ ...EMPTY, ...(project.report ?? {}) }); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = tasks.filter((t) => t.status === 'done').length;
  const hours = tasks.reduce((s, t) => s + t.hoursBooked, 0);
  const est = tasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0);
  const diff = r.costsPlanned != null && r.costsActual != null ? r.costsActual - r.costsPlanned : null;
  const set = (k: keyof ReportData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setR({ ...r, [k]: e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value || (k === 'acceptedAt' ? null : '') });

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="card-grid" style={{ marginBottom: 18 }}>
        <div className="card"><div className="muted small">Aufgaben erledigt</div><div className="stat">{done} / {tasks.length}</div></div>
        <div className="card"><div className="muted small">Gebuchte Zeit</div><div className="stat">{fmtHours(hours)}</div><div className="small muted">geplant {fmtHours(est)}</div></div>
        <div className="card"><div className="muted small">Kostenabweichung</div><div className="stat" style={{ color: diff == null ? undefined : diff > 0 ? 'var(--red)' : 'var(--green)' }}>{diff == null ? '–' : (diff > 0 ? '+' : '') + fmtEuro(diff)}</div></div>
      </div>
      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
        <Field label="Projektziele"><textarea rows={4} value={r.goals} onChange={set('goals')} /></Field>
        <Field label="Ergebnis / Zielerreichung"><textarea rows={4} value={r.result} onChange={set('result')} /></Field>
        <div className="grid2">
          <Field label="Geplante Kosten (€)"><input type="number" value={r.costsPlanned ?? ''} onChange={set('costsPlanned')} /></Field>
          <Field label="Tatsächliche Kosten (€)"><input type="number" value={r.costsActual ?? ''} onChange={set('costsActual')} /></Field>
          <Field label="Abgenommen durch"><input value={r.acceptedBy} onChange={set('acceptedBy')} /></Field>
          <Field label="Abnahmedatum"><input type="date" value={r.acceptedAt ?? ''} onChange={set('acceptedAt')} /></Field>
        </div>
        <Field label="Erkenntnisse (Lessons Learned)"><textarea rows={4} value={r.lessons} onChange={set('lessons')} /></Field>
        <Field label="Bemerkungen"><textarea rows={3} value={r.notes} onChange={set('notes')} /></Field>
      </fieldset>
      <div className="row">
        {canEdit && <button className="btn primary" onClick={async () => { await act(() => put(`/projects/${project.id}/report`, r), 'Bericht gespeichert'); invalidate(`/projects/${project.id}`); }}>Bericht speichern</button>}
        <button className="btn" onClick={() => window.print()}><Icon name="printer" /> Drucken / PDF</button>
      </div>
    </div>
  );
}
