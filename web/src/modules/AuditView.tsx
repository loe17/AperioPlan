import { useApi } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Avatar, Empty } from '../components/ui';

/** Lückenloses Änderungsprotokoll: Wer? Wann? Was? */
export function AuditView({ projectId }: { projectId?: string }) {
  const { data } = useApi<any[]>(projectId ? `/audit?projectId=${projectId}&limit=300` : '/audit?limit=300');
  if (!data?.length) return <Empty icon="history" title="Keine Einträge" />;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Wann</th><th>Wer</th><th>Was</th><th>Bereich</th></tr></thead>
      <tbody>{data.map((a) => (
        <tr key={a.id}>
          <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td>
          <td><span className="row" style={{ gap: 6 }}><Avatar id={a.userId} name={a.userName} />{a.userName}</span></td>
          <td>{a.summary}</td>
          <td className="small muted mono">{a.action}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
