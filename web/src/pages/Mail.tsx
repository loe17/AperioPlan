import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { post, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCrumbs } from '../components/Layout';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { Empty, Field, Modal, Pill, Tabs, useAction } from '../components/ui';

/** Integrierte E-Mail-Verwaltung: Projektpostfach lesen, beantworten und Vorgängen zuordnen */
export default function MailPage() {
  useCrumbs([{ label: '✉️ E-Mail' }]);
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') ?? 'all') as 'all' | 'unassigned' | 'sent';
  const projectId = params.get('projectId') ?? '';
  const [q, setQ] = useState('');
  const url = `/mail?filter=${filter}${projectId ? `&projectId=${projectId}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const { data, reload } = useApi<any[]>(url);
  const { data: projects } = useApi<any[]>('/projects');
  const [selected, setSelected] = useState<string | null>(null);
  const [compose, setCompose] = useState<any | null>(null);
  const act = useAction();
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'mail.new') void reload(); }), [reload]);

  return (
    <div className="chat">
      <div style={{ width: 420, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn primary" onClick={() => setCompose({ to: '', subject: '', text: '', projectId })}>✏️ Neue E-Mail</button>
            <button className="btn" onClick={async () => { const r = await act(() => post('/mail/sync')); if (r) { reload(); } }}>🔄 Abrufen</button>
          </div>
          <input placeholder="🔍 Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
          <select value={projectId} onChange={(e) => { if (e.target.value) params.set('projectId', e.target.value); else params.delete('projectId'); setParams(params); }}>
            <option value="">Alle Projekte</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
          </select>
        </div>
        <Tabs value={filter} onChange={(v) => { params.set('filter', v); setParams(params); }} tabs={[{ id: 'all', label: 'Alle' }, { id: 'unassigned', label: 'Nicht zugeordnet' }, { id: 'sent', label: 'Gesendet' }]} />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {!data?.length && <Empty icon="✉️" title="Keine E-Mails" />}
          {data?.map((m) => (
            <div key={m.id} className={`nav-item ${selected === m.id ? 'active' : ''}`} style={{ display: 'block', padding: '8px 12px', borderRadius: 0, borderBottom: '1px solid var(--line)', whiteSpace: 'normal' }} onClick={() => setSelected(m.id)}>
              <div className="row"><b className="grow" style={{ fontWeight: m.seen ? 450 : 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.direction === 'out' ? `An: ${m.to}` : m.from}</b><span className="small muted">{fmtDateTime(m.date)}</span></div>
              <div style={{ fontWeight: m.seen ? 400 : 650 }}>{m.subject || '(kein Betreff)'} {m.attachmentCount > 0 && '📎'}</div>
              <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.preview}</div>
              {m.projectNumber && <Pill tone="accent">{m.projectNumber} {m.projectName}</Pill>}
            </div>
          ))}
        </div>
      </div>
      <div className="chat-main" style={{ overflowY: 'auto' }}>
        {selected ? <MailDetail id={selected} projects={projects ?? []} onReply={setCompose} onChanged={reload} /> : <Empty icon="✉️" title="E-Mail auswählen" />}
      </div>
      {compose && <ComposeDialog initial={compose} projects={projects ?? []} onClose={() => setCompose(null)} onSent={() => { setCompose(null); reload(); }} />}
    </div>
  );
}

function MailDetail({ id, projects, onReply, onChanged }: { id: string; projects: any[]; onReply: (c: any) => void; onChanged: () => void }) {
  const { data: m, reload } = useApi<any>(`/mail/${id}`);
  const act = useAction();
  const { data: tasks } = useApi<any[]>(m?.projectId ? `/projects/${m.projectId}/tasks` : null);
  if (!m) return null;
  const assign = async (projectId: string | null, taskId: string | null = null) => {
    await act(() => post(`/mail/${id}/assign`, { projectId, taskId }), projectId ? 'Zugeordnet – Anhänge liegen im Projektordner' : 'Zuordnung entfernt');
    reload(); onChanged(); invalidate('/mail');
  };
  return (
    <div style={{ padding: '20px 28px' }}>
      <h2 style={{ marginBottom: 8 }}>{m.subject || '(kein Betreff)'}</h2>
      <div className="small"><b>Von:</b> {m.from}</div>
      <div className="small"><b>An:</b> {m.to}{m.cc && <> · <b>Cc:</b> {m.cc}</>}</div>
      <div className="small muted" style={{ marginBottom: 12 }}>{fmtDateTime(m.date)}</div>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <select value={m.projectId ?? ''} onChange={(e) => assign(e.target.value || null)} style={{ maxWidth: 280 }}>
          <option value="">– keinem Projekt zugeordnet –</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
        </select>
        {m.projectId && <select value={m.taskId ?? ''} onChange={(e) => assign(m.projectId, e.target.value || null)} style={{ maxWidth: 260 }}>
          <option value="">– Aufgabe (optional) –</option>{tasks?.map((t) => <option key={t.id} value={t.id}>P{t.number} {t.title}</option>)}
        </select>}
        <button className="btn" onClick={() => onReply({ to: m.direction === 'in' ? m.from : m.to, subject: m.subject.startsWith('AW:') ? m.subject : `AW: ${m.subject}`,
          text: `\n\n---- Am ${fmtDateTime(m.date)} schrieb ${m.from}:\n${(m.text ?? '').split('\n').map((l: string) => '> ' + l).join('\n')}`, projectId: m.projectId ?? '', replyTo: m.id })}>↩️ Antworten</button>
      </div>
      {m.attachments.length > 0 && <div className="row wrap" style={{ marginBottom: 14 }}>
        {m.attachments.map((a: any) => <a key={a.index} className="card row" style={{ padding: '6px 10px' }} href={`/api/mail/${id}/attachments/${a.index}`}>📎 {a.name} <span className="small muted">{fmtBytes(a.size)}</span></a>)}
      </div>}
      {m.html ? <iframe sandbox="" srcDoc={m.html} style={{ width: '100%', minHeight: '60vh', border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
        : <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{m.text}</pre>}
    </div>
  );
}

function ComposeDialog({ initial, projects, onClose, onSent }: { initial: any; projects: any[]; onClose: () => void; onSent: () => void }) {
  const act = useAction();
  const [d, setD] = useState({ cc: '', ...initial });
  return (
    <Modal size="lg" title="✏️ E-Mail schreiben" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.to || !d.subject} onClick={async () => { const r = await act(() => post('/mail/send', { ...d, projectId: d.projectId || null, cc: d.cc || undefined }), 'Gesendet'); if (r) onSent(); }}>Senden</button>
    </>}>
      <div className="grid2">
        <Field label="An" required><input value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} /></Field>
        <Field label="Cc"><input value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} /></Field>
      </div>
      <Field label="Betreff" required hint="Tipp: Mit der Projektnummer im Betreff (z. B. [0100]) werden Antworten automatisch zugeordnet"><input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} /></Field>
      <Field label="Projekt"><select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })}><option value="">–</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
      <Field label="Nachricht"><textarea rows={12} value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} /></Field>
    </Modal>
  );
}
