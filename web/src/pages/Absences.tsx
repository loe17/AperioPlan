import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, rememberedTab, rememberTab } from '../lib/hooks';
import { post, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useT } from '../i18n';
import { fmtDate } from '../lib/format';
import { Avatar, Empty, Field, Modal, Progress, REQUEST_META, StatusPill, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

const KIND: Record<string, string> = { vacation: 'Urlaub', other: 'Sonstige Abwesenheit' };

export default function AbsencesPage() {
  const t = useT();
  useCrumbs([{ label: `${t('Urlaubskonto')}` }]);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? rememberedTab('absences') ?? 'mine') as 'mine' | 'review';
  const [year, setYear] = useState(new Date().getFullYear());
  const { data: bal } = useApi<any>(`/absences/balance?year=${year}`);
  const { data: list } = useApi<any[]>(`/absences?year=${year}`);
  const { data: review } = useApi<any[]>('/absences/review');
  const act = useAction();
  const pending = review?.filter((r) => r.status === 'pending').length ?? 0;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Urlaubskonto')}</h1><div className="sub">Urlaub beantragen, Resturlaub im Blick behalten</div></div>
        <div className="actions">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 'auto' }}>{[year - 1, year, year + 1].map((y) => <option key={y}>{y}</option>)}</select>
          <button className="btn primary" onClick={() => setParams({ new: '1' })}>＋ {t('Urlaub beantragen')}</button>
        </div>
      </div>
      {bal && (
        <div className="card-grid" style={{ marginBottom: 20 }}>
          <div className="card"><div className="muted small">Anspruch {year}</div><div className="stat">{bal.entitlement}</div><div className="small muted">{bal.base} Tage{bal.adjustments ? ` ${bal.adjustments > 0 ? '+' : ''}${bal.adjustments} Übertrag/Sonderurlaub` : ''}</div></div>
          <div className="card"><div className="muted small">Genommen / genehmigt</div><div className="stat">{bal.taken}</div><Progress value={bal.entitlement ? bal.taken / bal.entitlement : 0} /></div>
          <div className="card"><div className="muted small">Beantragt (offen)</div><div className="stat" style={{ color: bal.pending ? 'var(--amber)' : undefined }}>{bal.pending}</div></div>
          <div className="card"><div className="muted small">Resturlaub</div><div className="stat" style={{ color: 'var(--green)' }}>{bal.remaining}</div></div>
        </div>
      )}
      <Tabs value={tab} onChange={(v) => { rememberTab('absences', v); setParams({ tab: v }); }} tabs={[
        { id: 'mine', label: 'Meine Anträge' },
        ...(review?.length ? [{ id: 'review' as const, label: `Zu genehmigen${pending ? ` (${pending})` : ''}` }] : []),
      ]} />
      {tab === 'mine' && (!list?.length ? <Empty icon="palm" title="Noch keine Anträge in diesem Jahr" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Art</th><th>Zeitraum</th><th>Tage</th><th>Notiz</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((a) => (
            <tr key={a.id}>
              <td>{KIND[a.kind]}</td><td>{fmtDate(a.startDate)} – {fmtDate(a.endDate)}{a.halfDayStart && ' (½ erster Tag)'}{a.halfDayEnd && ' (½ letzter Tag)'}</td>
              <td><b>{a.days}</b></td><td className="small muted">{a.note}</td>
              <td><StatusPill status={a.status} meta={REQUEST_META} />{a.approverName && <div className="small muted">{a.approverName}</div>}</td>
              <td>{(a.status === 'pending' || (a.status === 'approved' && a.startDate > new Date().toISOString().slice(0, 10))) &&
                <button className="btn sm" onClick={async () => { await act(() => post(`/absences/${a.id}/cancel`), 'Storniert'); invalidate('/absences'); }}>Stornieren</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {tab === 'review' && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Mitarbeiter</th><th>Art</th><th>Zeitraum</th><th>Tage</th><th>Resturlaub</th><th>Notiz</th><th>Status</th><th /></tr></thead>
          <tbody>{review?.map((a) => (
            <tr key={a.id}>
              <td><span className="row" style={{ gap: 6 }}><Avatar id={a.userId} name={a.userName} />{a.userName}</span></td>
              <td>{KIND[a.kind]}</td><td>{fmtDate(a.startDate)} – {fmtDate(a.endDate)}</td><td><b>{a.days}</b></td>
              <td className="small">{a.balance ? `${a.balance.remaining + a.days} → ${a.balance.remaining}` : ''}</td>
              <td className="small muted">{a.note}</td>
              <td><StatusPill status={a.status} meta={REQUEST_META} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>{a.status === 'pending' && <>
                <button className="btn sm primary" onClick={async () => { await act(() => post(`/absences/${a.id}/decide`, { approve: true }), 'Genehmigt'); invalidate('/absences'); }}>{t('Genehmigen')}</button>{' '}
                <button className="btn sm danger" onClick={async () => { const note = prompt('Begründung (optional)') ?? ''; await act(() => post(`/absences/${a.id}/decide`, { approve: false, note }), 'Abgelehnt'); invalidate('/absences'); }}>{t('Ablehnen')}</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="hint" style={{ marginTop: 16 }}><Icon name="lock" /> Datenschutz: Kollegen sehen im Teamkalender nur, <b>wann</b> Sie abwesend sind – nie die Art oder einen Grund.</p>
      {params.get('new') && <RequestDialog onClose={() => setParams({})} />}
    </div>
  );
}

function RequestDialog({ onClose }: { onClose: () => void }) {
  const act = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [d, setD] = useState({ kind: 'vacation', startDate: today, endDate: today, halfDayStart: false, halfDayEnd: false, note: '' });
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    if (!d.startDate || !d.endDate || d.endDate < d.startDate) { setDays(null); return; }
    post('/absences/preview', d).then((r) => setDays(r.days)).catch(() => setDays(null));
  }, [d.startDate, d.endDate, d.halfDayStart, d.halfDayEnd]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Abwesenheit beantragen" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!days} onClick={async () => { const r = await act(() => post('/absences', d), 'Antrag gestellt'); if (r) { onClose(); invalidate('/absences'); } }}>Beantragen</button>
    </>}>
      <Field label="Art"><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <div className="grid2">
        <Field label="Erster Tag"><input type="date" value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value, endDate: e.target.value > d.endDate ? e.target.value : d.endDate })} /></Field>
        <Field label="Letzter Tag"><input type="date" value={d.endDate} min={d.startDate} onChange={(e) => setD({ ...d, endDate: e.target.value })} /></Field>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row small"><input type="checkbox" checked={d.halfDayStart} onChange={(e) => setD({ ...d, halfDayStart: e.target.checked })} /> erster Tag halb</label>
        <label className="row small"><input type="checkbox" checked={d.halfDayEnd} onChange={(e) => setD({ ...d, halfDayEnd: e.target.checked })} /> letzter Tag halb</label>
      </div>
      <Field label="Notiz (nur für Sie und die Teamleitung)"><textarea value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></Field>
      <div className="card flat">{days === null ? 'Zeitraum prüfen …' : <>Das sind <b>{days} Arbeitstage</b> (ohne Wochenenden und Feiertage).</>}</div>
    </Modal>
  );
}
