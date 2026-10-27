import { useNavigate } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { post, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useT } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { Empty } from '../components/ui';

export default function InboxPage() {
  const t = useT();
  const nav = useNavigate();
  useCrumbs([{ label: `📥 ${t('Posteingang')}` }]);
  const { data } = useApi<any[]>('/notifications');
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <h1>{t('Posteingang')}</h1>
        <div className="actions"><button className="btn" onClick={async () => { await post('/notifications/read'); invalidate('/notifications'); }}>{t('Alle als gelesen markieren')}</button></div>
      </div>
      {!data?.length ? <Empty icon="📥" title={t('Keine neuen Benachrichtigungen')} /> : (
        <div className="table-wrap"><table className="table"><tbody>
          {data.map((n) => (
            <tr key={n.id} className="click" style={{ opacity: n.readAt ? 0.6 : 1 }} onClick={async () => {
              if (!n.readAt) { await post('/notifications/read', { ids: [n.id] }); invalidate('/notifications'); }
              if (n.link) nav(n.link);
            }}>
              <td style={{ width: 20 }}>{n.readAt ? '○' : '●'}</td>
              <td><div style={{ fontWeight: 550 }}>{n.title}</div>{n.body && <div className="small muted">{n.body}</div>}</td>
              <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(n.createdAt)}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}
