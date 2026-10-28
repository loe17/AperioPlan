import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PROJECT_MODULES } from '@aperio/shared';
import { useApi } from '../lib/hooks';
import { post, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { useT } from '../i18n';
import { fmtDate } from '../lib/format';
import { Empty, Field, Modal, Progress, useAction } from '../components/ui';
import { MODULE_LABELS, STATUS_OPTIONS } from '../modules/ProjectSettings';
import { EntityIcon, Icon, IconPicker } from '../components/Icon';
import { CustomerPicker, contactName, useContacts } from '../modules/CrmShared';

export interface ProjectRow {
  id: string; number: string; name: string; icon: string; parentId: string | null; teamId: string | null; teamName: string | null; teamIcon: string | null;
  status: string; customer: string; dueDate: string | null; openTasks: number; totalTasks: number; childCount: number; favorite: boolean;
}

export function ProjectCards({ projects }: { projects: ProjectRow[] }) {
  const roots = projects.filter((p) => !p.parentId || !projects.some((x) => x.id === p.parentId));
  return (
    <div className="card-grid">
      {roots.map((p) => {
        const children = projects.filter((c) => c.parentId === p.id);
        return (
          <div key={p.id} className="card">
            <Link to={`/projects/${p.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="card-title"><EntityIcon value={p.icon} size={20} /><b className="mono">{p.number}</b>{p.favorite && <Icon name="star-filled" />}<span className="right pill">{STATUS_OPTIONS.find(([v]) => v === p.status)?.[1]}</span></div>
              <h3 style={{ marginBottom: 6 }}>{p.name}</h3>
              <div className="small muted" style={{ marginBottom: 8 }}>{p.teamName ? p.teamName : 'ohne Team'}{p.customer ? ` · ${p.customer}` : ''}{p.dueDate ? ` · bis ${fmtDate(p.dueDate)}` : ''}</div>
              <Progress value={p.totalTasks ? (p.totalTasks - p.openTasks) / p.totalTasks : 0} />
              <div className="small muted" style={{ marginTop: 6 }}>{p.openTasks} offene von {p.totalTasks} Aufgaben</div>
            </Link>
            {children.length > 0 && (
              <div className="tree-line" style={{ marginTop: 10 }}>
                {children.map((c) => <div key={c.id}><Link to={`/projects/${c.id}`}>{c.number} {c.name}</Link></div>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function NewProjectDialog({ onClose, parentId, teamId, customer: preset }: { onClose: () => void; parentId?: string; teamId?: string; customer?: { id: string; name: string; number: string } }) {
  const t = useT();
  const nav = useNavigate();
  const act = useAction();
  const { teams, settings, me } = useSession();
  const { data: projects } = useApi<ProjectRow[]>('/projects?parentId=root');
  const [d, setD] = useState({
    name: '', description: '', icon: 'rocket', parentId: parentId ?? '', teamId: teamId ?? '', visibility: 'company', customer: '',
    startDate: '', dueDate: '', number: '', modules: settings?.defaultModules ?? [...PROJECT_MODULES],
  });
  const [customer, setCustomer] = useState<{ id: string; name: string; number?: string } | null>(preset ?? null);
  const [contactId, setContactId] = useState('');
  const contacts = useContacts(customer?.id);
  useEffect(() => { if (settings) setD((x) => ({ ...x, modules: settings.defaultModules })); }, [settings]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  return (
    <Modal size="lg" title={t('Neues Projekt')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('Abbrechen')}</button>
      <button className="btn primary" disabled={!d.name.trim()} onClick={async () => {
        const r = await act(() => post('/projects', {
          ...d, customer: customer?.name ?? '', customerId: customer?.id ?? null, customerContactId: contactId || null, parentId: d.parentId || null, teamId: d.teamId || null, startDate: d.startDate || null, dueDate: d.dueDate || null, number: d.number || undefined,
        }));
        if (r) { invalidate('/projects'); onClose(); nav(`/projects/${r.id}`); }
      }}>{t('Anlegen')}</button>
    </>}>
      <div className="grid2">
        <Field label="Projektname" required><input autoFocus value={d.name} onChange={set('name')} placeholder="z. B. Verpackungsanlage" /></Field>
        <Field label="Symbol"><IconPicker value={d.icon} onChange={(icon) => setD({ ...d, icon })} /></Field>
        <Field label="Teilprojekt von" hint="Teilprojekte erhalten die Nummer des Hauptprojekts mit Buchstabe, z. B. 0100-A">
          <select value={d.parentId} onChange={set('parentId')}>
            <option value="">– eigenständiges Hauptprojekt –</option>
            {projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
          </select>
        </Field>
        <Field label="Team / Abteilung"><select value={d.teamId} onChange={set('teamId')}><option value="">–</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}</select></Field>
        <Field label="Kunde" hint="aus dem CRM"><CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setContactId(''); }} /></Field>
        {customer && contacts.length > 0 && <Field label="Ansprechpartner beim Kunden"><select value={contactId} onChange={(e) => setContactId(e.target.value)}><option value="">–</option>{contacts.map((c) => <option key={c.id} value={c.id}>{contactName(c)}</option>)}</select></Field>}
        <Field label="Sichtbarkeit"><select value={d.visibility} onChange={set('visibility')}><option value="company">Ganze Firma</option><option value="team">Nur Team</option><option value="members">Nur Projektmitglieder</option></select></Field>
        <Field label="Start"><input type="date" value={d.startDate} onChange={set('startDate')} /></Field>
        <Field label="Ende"><input type="date" value={d.dueDate} onChange={set('dueDate')} /></Field>
      </div>
      <Field label="Beschreibung"><textarea value={d.description} onChange={set('description')} /></Field>
      {me?.role === 'admin' && !d.parentId && (
        <Field label="Projektnummer (optional)" hint="Leer lassen für automatische Vergabe nach dem eingestellten Muster">
          <input value={d.number} onChange={set('number')} className="mono" />
        </Field>
      )}
      <Field label="Aktive Werkzeuge">
        <div className="row wrap">
          {PROJECT_MODULES.map((m) => (
            <label key={m} className="row small" style={{ gap: 4 }}>
              <input type="checkbox" checked={d.modules.includes(m)} onChange={() => setD({ ...d, modules: d.modules.includes(m) ? d.modules.filter((x) => x !== m) : [...d.modules, m] })} />
              <Icon name={MODULE_LABELS[m]?.icon ?? 'square'} /> {MODULE_LABELS[m]?.label}
            </label>
          ))}
        </div>
      </Field>
      <div className="hint">Beim Anlegen werden automatisch die Ordner {settings?.storage.projectFolders.join(', ')} erzeugt.</div>
    </Modal>
  );
}

export default function ProjectsPage() {
  const t = useT();
  useCrumbs([{ label: `${t('Alle Projekte')}` }]);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const { data } = useApi<ProjectRow[]>(`/projects${status ? `?status=${status}` : ''}`);
  const { me } = useSession();
  const shown = (data ?? []).filter((p) => !q || `${p.number} ${p.name} ${p.customer}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('Projekte')}</h1><div className="sub">{data?.length ?? 0} Projekte</div></div>
        <div className="actions">{me?.role !== 'guest' && <button className="btn primary" onClick={() => setParams({ new: '1' })}>＋ {t('Neues Projekt')}</button>}</div>
      </div>
      <div className="toolbar">
        <input placeholder="Nummer, Name oder Kunde" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Alle außer archivierte</option>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {shown.length ? <ProjectCards projects={shown} /> : <Empty icon="projects" title="Keine Projekte gefunden" />}
      {params.get('new') && <NewProjectDialog onClose={() => setParams({})} />}
    </div>
  );
}
