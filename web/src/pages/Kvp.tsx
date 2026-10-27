import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { del, patch, post, upload, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { useT } from '../i18n';
import { fmtDate, fmtEuro } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, SlideOver, StatusPill, useAction, UserSelect } from '../components/ui';
import { Comments } from '../components/TaskPanel';

export const KVP_META: Record<string, { label: string; tone: string }> = {
  new: { label: 'Neu', tone: 'blue' }, review: { label: 'In Prüfung', tone: 'amber' }, accepted: { label: 'Angenommen', tone: 'accent' },
  implemented: { label: 'Umgesetzt', tone: 'green' }, rejected: { label: 'Abgelehnt', tone: 'red' },
};

/** KVP-Verbesserungsbox: digitaler Kummer- und Ideenkasten */
export default function KvpPage() {
  const t = useT();
  useCrumbs([{ label: `💡 ${t('KVP-Ideenbox')}` }]);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const { data } = useApi<any[]>(`/kvp${status ? `?status=${status}` : ''}`);
  const { data: stats } = useApi<any>('/kvp/stats');
  const open = params.get('idea');
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('KVP-Ideenbox')}</h1><div className="sub">Kontinuierliche Verbesserung: Jede Idee zählt – mit Einsparpotenzial, Zuständigkeit und Fotos.</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setParams({ new: '1' })}>＋ {t('Neue Idee')}</button></div>
      </div>
      {stats && <div className="card-grid" style={{ marginBottom: 18 }}>
        <div className="card"><div className="muted small">Ideen gesamt</div><div className="stat">{stats.total}</div></div>
        <div className="card"><div className="muted small">Offen</div><div className="stat" style={{ color: 'var(--amber)' }}>{stats.open}</div></div>
        <div className="card"><div className="muted small">Umgesetzt</div><div className="stat" style={{ color: 'var(--green)' }}>{stats.implemented}</div></div>
        <div className="card"><div className="muted small">Einsparpotenzial (angenommen/umgesetzt)</div><div className="stat">{fmtEuro(stats.savings)}</div></div>
      </div>}
      <div className="toolbar">
        {['', ...Object.keys(KVP_META)].map((s) => <button key={s} className={`btn sm ${status === s ? 'primary' : ''}`} onClick={() => setStatus(s)}>{s ? KVP_META[s]!.label : 'Alle'}</button>)}
      </div>
      {!data?.length ? <Empty icon="💡" title="Noch keine Ideen">Haben Sie eine Idee, wie es besser, sicherer oder günstiger geht? Reichen Sie sie ein!</Empty> : (
        <div className="card-grid">
          {data.map((k) => (
            <div key={k.id} className="card click" onClick={() => setParams({ idea: k.id })}>
              {k.photos[0] && <img src={`/api/kvp/photos/${k.photos[0].id}`} style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 8, marginBottom: 10 }} />}
              <div className="row" style={{ marginBottom: 6 }}><span className="mono muted">#{k.number}</span><StatusPill status={k.status} meta={KVP_META} />{k.savingsEur ? <span className="right small"><b>{fmtEuro(k.savingsEur)}</b></span> : null}</div>
              <h3 style={{ marginBottom: 4 }}>{k.title}</h3>
              <div className="small muted" style={{ marginBottom: 8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{k.description}</div>
              <div className="row small muted"><Avatar id={k.createdBy} name={k.createdByName} />{k.createdByName} · {fmtDate(k.createdAt)}{k.teamName && ` · ${k.teamIcon} ${k.teamName}`}{k.commentCount > 0 && ` · 💬 ${k.commentCount}`}</div>
            </div>
          ))}
        </div>
      )}
      {params.get('new') && <IdeaForm onClose={() => setParams({})} />}
      {open && <IdeaPanel id={open} onClose={() => setParams({})} />}
    </div>
  );
}

function IdeaForm({ onClose }: { onClose: () => void }) {
  const { teams, users } = useSession();
  const act = useAction();
  const [d, setD] = useState({ title: '', description: '', teamId: '', savingsEur: '', leadId: null as string | null });
  const [files, setFiles] = useState<File[]>([]);
  return (
    <Modal title="💡 Neue Verbesserungsidee" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={d.title.trim().length < 3} onClick={async () => {
        const r = await act(() => post('/kvp', { ...d, teamId: d.teamId || null, savingsEur: d.savingsEur ? Number(d.savingsEur) : null }));
        if (!r) return;
        if (files.length) { const fd = new FormData(); files.forEach((f) => fd.append('file', f, f.name)); await act(() => upload(`/kvp/${r.id}/photos`, fd)); }
        invalidate('/kvp'); onClose();
      }}>Einreichen</button>
    </>}>
      <Field label="Titel" required><input autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="z. B. Werkzeugwand an Station 3" /></Field>
      <Field label="Beschreibung" hint="Was ist das Problem? Was schlagen Sie vor?"><textarea rows={5} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="Abteilung"><select value={d.teamId} onChange={(e) => setD({ ...d, teamId: e.target.value })}><option value="">–</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select></Field>
        <Field label="Geschätztes Einsparpotenzial (€/Jahr)"><input type="number" min={0} value={d.savingsEur} onChange={(e) => setD({ ...d, savingsEur: e.target.value })} /></Field>
      </div>
      <Field label="Zuständige Teamleitung" hint="leer = Teamleitung der Abteilung"><UserSelect users={users.filter((u) => u.role === 'teamlead' || u.role === 'admin')} value={d.leadId} onChange={(v) => setD({ ...d, leadId: v })} /></Field>
      <Field label="Fotos"><input type="file" accept="image/*" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></Field>
    </Modal>
  );
}

function IdeaPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: k, reload } = useApi<any>(`/kvp/${id}`);
  const { me, users } = useSession();
  const act = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const [remove, setRemove] = useState(false);
  if (!k) return null;
  const isLead = me?.role === 'admin' || me?.role === 'teamlead' || k.leadId === me?.id;
  const refresh = () => { void reload(); invalidate('/kvp'); };
  return (
    <SlideOver title={<div className="row"><span className="mono muted">#{k.number}</span><StatusPill status={k.status} meta={KVP_META} /></div>} onClose={onClose}
      actions={(me?.role === 'admin' || (k.createdBy === me?.id && k.status === 'new')) ? <button className="btn sm danger" onClick={() => setRemove(true)}>Löschen</button> : undefined}>
      <h2 style={{ marginBottom: 8 }}>{k.title}</h2>
      <div className="row small muted" style={{ marginBottom: 12 }}><Avatar id={k.createdBy} name={k.createdByName} />{k.createdByName} · {fmtDate(k.createdAt)}</div>
      <div style={{ whiteSpace: 'pre-wrap', marginBottom: 14 }}>{k.description || <span className="muted">Keine Beschreibung</span>}</div>
      <table className="table" style={{ marginBottom: 14 }}><tbody>
        <tr><td className="muted">Abteilung</td><td>{k.teamName ? `${k.teamIcon} ${k.teamName}` : '–'}</td></tr>
        <tr><td className="muted">Einsparpotenzial</td><td><b>{fmtEuro(k.savingsEur)}</b> / Jahr</td></tr>
        <tr><td className="muted">Zuständig</td><td>{isLead ? <UserSelect users={users} value={k.leadId} onChange={async (v) => { await act(() => patch(`/kvp/${id}`, { leadId: v })); refresh(); }} /> : (k.leadName ?? '–')}</td></tr>
        {k.decisionNote && <tr><td className="muted">Entscheidung</td><td>{k.decisionNote}</td></tr>}
      </tbody></table>
      {isLead && (
        <div className="card flat" style={{ marginBottom: 14 }}>
          <b>Entscheidung</b>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {Object.entries(KVP_META).map(([s, m]) => (
              <button key={s} className={`btn sm ${k.status === s ? 'primary' : ''}`} onClick={async () => {
                const note = s === 'rejected' || s === 'accepted' ? prompt('Kurze Begründung / Rückmeldung an den Einreicher', k.decisionNote ?? '') ?? undefined : undefined;
                await act(() => patch(`/kvp/${id}`, { status: s, ...(note !== undefined ? { decisionNote: note } : {}) }), `Status: ${m.label}`);
                refresh();
              }}>{m.label}</button>
            ))}
          </div>
        </div>
      )}
      <div className="row wrap" style={{ marginBottom: 10 }}>
        {k.photos.map((p: any) => (
          <div key={p.id} style={{ position: 'relative' }}>
            <a href={`/api/kvp/photos/${p.id}`} target="_blank" rel="noreferrer"><img src={`/api/kvp/photos/${p.id}`} style={{ height: 120, borderRadius: 8 }} /></a>
            {(k.createdBy === me?.id || me?.role === 'admin') && <button className="btn sm" style={{ position: 'absolute', top: 4, right: 4 }} onClick={async () => { await del(`/kvp/photos/${p.id}`); refresh(); }}>✕</button>}
          </div>
        ))}
        <button className="btn" onClick={() => fileRef.current?.click()}>📷 Foto hinzufügen</button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={async (e) => {
          if (!e.target.files?.length) return;
          const fd = new FormData(); [...e.target.files].forEach((f) => fd.append('file', f, f.name));
          await act(() => upload(`/kvp/${id}/photos`, fd)); refresh();
        }} />
      </div>
      <Comments type="kvp" id={id} />
      {remove && <Confirm danger text="Idee löschen?" onClose={() => setRemove(false)} onConfirm={async () => { await del(`/kvp/${id}`); invalidate('/kvp'); onClose(); }} />}
    </SlideOver>
  );
}
