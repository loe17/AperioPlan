import { useApi } from '../lib/hooks';
import { fmtDateTime, fmtHours, fmtTime } from '../lib/format';
import { Avatar, Empty, Progress } from '../components/ui';
import { ClockWidget } from '../pages/Time';

/** Zeiterfassung im Projekt: Stempeluhr, Auswertung nach Mitarbeiter und Aufgabe */
export function ProjectTime({ projectId }: { projectId: string; project?: any }) {
  const { data } = useApi<any>(`/projects/${projectId}/time`);
  const max = Math.max(1, ...(data?.byUser ?? []).map((u: any) => u.hours));
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
        <ProjectClock projectId={projectId} />
        <div className="card"><div className="muted small">Gesamt gebucht</div><div className="stat">{fmtHours(data?.total ?? 0)}</div>
          <a className="small" href={`/api/time/export?from=2000-01-01&to=2100-12-31&projectId=${projectId}`}>📊 Als CSV exportieren</a></div>
      </div>
      {!data?.recent?.length ? <Empty icon="⏱️" title="Noch keine Zeiten auf diesem Projekt" /> : <>
        <div className="grid2" style={{ gap: 14 }}>
          <div className="card"><h3 style={{ marginBottom: 10 }}>Nach Mitarbeiter</h3>
            {data.byUser.map((u: any) => <div key={u.userId} style={{ marginBottom: 8 }}><div className="row"><Avatar id={u.userId} name={u.userName} /><span className="grow">{u.userName}</span><b>{fmtHours(u.hours)}</b></div><Progress value={u.hours / max} /></div>)}
          </div>
          <div className="card"><h3 style={{ marginBottom: 10 }}>Nach Aufgabe</h3>
            <table className="table"><tbody>{data.byTask.map((t: any, i: number) => (
              <tr key={i}><td>{t.taskId ? `P${t.number} ${t.title}` : <span className="muted">ohne Aufgabe</span>}</td><td style={{ textAlign: 'right' }}><b>{fmtHours(t.hours)}</b>{t.estimateHours ? <span className="muted small"> / {fmtHours(t.estimateHours)}</span> : ''}</td></tr>
            ))}</tbody></table>
          </div>
        </div>
        <div><h3 style={{ marginBottom: 8 }}>Letzte Buchungen</h3>
          <div className="table-wrap"><table className="table"><tbody>{data.recent.map((e: any) => (
            <tr key={e.id}><td className="small">{fmtDateTime(e.startedAt)} – {e.endedAt ? fmtTime(e.endedAt) : 'läuft'}</td><td>{e.userName}</td><td className="small">{e.taskTitle ?? ''}</td><td><b>{fmtHours(e.hours)}</b></td></tr>
          ))}</tbody></table></div>
        </div>
      </>}
    </div>
  );
}

function ProjectClock({ projectId }: { projectId: string }) {
  return <div style={{ minWidth: 320 }}><ClockWidget defaultProjectId={projectId} key={projectId} /></div>;
}
