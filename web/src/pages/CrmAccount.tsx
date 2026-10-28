import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, post, upload } from '../lib/api';
import { useApi, useTabState } from '../lib/hooks';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { fmtBytes, fmtDate, fmtDateTime, fmtEuro } from '../lib/format';
import { Confirm, Empty, ErrorBox, Loading, Pill, Tabs, useAction } from '../components/ui';
import { PhoneLink } from '../modules/Phone';
import { Icon } from '../components/Icon';
import { MentionInput } from '../components/MentionInput';
import { ACCOUNT_KIND, ACCOUNT_STATUS, AccountModal, CASE_STATUS, QUOTE_STATUS, STAGES, contactName, type CrmContact } from '../modules/CrmShared';
import { CaseModal, ContactModal, MinutesModal, OpportunityModal, QuoteEditor } from '../modules/CrmModals';
import { CaseTable, QuoteTable, WonToProject } from './Crm';
import { EventModal } from '../modules/EventModal';
import { NewProjectDialog } from './Projects';

type Tab = 'timeline' | 'contacts' | 'opportunities' | 'quotes' | 'cases' | 'projects';

const TL_ICON: Record<string, string> = { note: 'note', minutes: 'file-text', event: 'calendar', opportunity: 'target', quote: 'euro', case: 'alert', project: 'projects', mail: 'mail' };
const TL_LABEL: Record<string, string> = { note: 'Notiz', minutes: 'Gesprächsprotokoll', event: 'Termin', opportunity: 'Verkaufschance', quote: 'Angebot', case: 'Reklamation', project: 'Projekt', mail: 'E-Mail' };

export default function CrmAccountPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const act = useAction();
  const { me } = useSession();
  const { data: a, error, reload } = useApi<any>(`/crm/accounts/${id}`);
  const [tab, setTab] = useTabState<Tab>(`crm:${id}`, 'timeline');
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  useCrumbs([{ label: 'Kunden (CRM)', to: '/crm' }, ...(a ? [{ label: `${a.number} ${a.name}` }] : [])]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!a) return <Loading />;
  const addr = [a.street, [a.zip, a.city].filter(Boolean).join(' '), a.country !== 'Deutschland' ? a.country : ''].filter(Boolean).join(', ');
  return (
    <div className="page">
      <div className="page-head">
        <div className="entity-big"><Icon name="building" size={28} /></div>
        <div className="grow">
          <div className="row"><h1>{a.name}</h1><Pill tone={ACCOUNT_STATUS[a.status]?.tone}>{ACCOUNT_STATUS[a.status]?.label}</Pill>{a.kind !== 'customer' && <Pill>{ACCOUNT_KIND[a.kind]}</Pill>}</div>
          <div className="sub row wrap">
            <span className="mono">{a.number}</span>
            {addr && <span><Icon name="location" /> {addr}</span>}
            {a.phone && <PhoneLink number={a.phone} />}
            {a.email && <a href={`mailto:${a.email}`}><Icon name="mail" /> {a.email}</a>}
            {a.website && <a href={/^https?:/.test(a.website) ? a.website : `https://${a.website}`} target="_blank" rel="noreferrer"><Icon name="globe" /> {a.website}</a>}
            {a.ownerName && <span><Icon name="user" /> {a.ownerName}</span>}
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setEdit(true)}><Icon name="edit" /> Bearbeiten</button>
          {(me?.role === 'admin' || a.ownerId === me?.id) && <button className="btn ghost" title="Löschen" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
        </div>
      </div>
      <div className="kpi-row">
        <div className="kpi"><div className="v">{fmtEuro(a.stats.pipeline)}</div><div className="l">offene Verkaufschancen</div></div>
        <div className="kpi"><div className="v">{fmtEuro(a.stats.acceptedQuotes)}</div><div className="l">angenommene Angebote</div></div>
        <div className="kpi"><div className="v">{a.projects.length}</div><div className="l">Projekte</div></div>
        <div className="kpi"><div className="v">{a.stats.openCases}</div><div className="l">offene Reklamationen</div></div>
        <div className="kpi"><div className="v">{a.lastContactAt ? fmtDate(a.lastContactAt) : '–'}</div><div className="l">letzter Kontakt</div></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'timeline', label: 'Verlauf' }, { id: 'contacts', label: `Ansprechpartner (${a.contacts.length})` }, { id: 'opportunities', label: 'Verkaufschancen' },
        { id: 'quotes', label: 'Angebote' }, { id: 'cases', label: 'Reklamationen' }, { id: 'projects', label: `Projekte (${a.projects.length})` },
      ]} />
      {tab === 'timeline' && <Timeline account={a} />}
      {tab === 'contacts' && <Contacts accountId={a.id} contacts={a.contacts} onChanged={reload} />}
      {tab === 'opportunities' && <AccountOpps accountId={a.id} />}
      {tab === 'quotes' && <AccountQuotes accountId={a.id} />}
      {tab === 'cases' && <AccountCases accountId={a.id} />}
      {tab === 'projects' && <AccountProjects account={a} />}
      {a.notes && tab === 'timeline' && <div className="card flat" style={{ marginTop: 12 }}><div className="small muted">Notizen zum Kunden</div><div style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</div></div>}
      {edit && <AccountModal initial={a} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); void reload(); }} />}
      {remove && <Confirm danger text={`${a.name} mit allen Ansprechpartnern, Notizen und Protokollen löschen?`} onClose={() => setRemove(false)}
        onConfirm={async () => { if (await act(() => del(`/crm/accounts/${a.id}`), 'Gelöscht')) nav('/crm'); }} />}
    </div>
  );
}

function Timeline({ account }: { account: any }) {
  const act = useAction();
  const { users } = useSession();
  const { data, reload } = useApi<any[]>(`/crm/accounts/${account.id}/timeline`);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [minutes, setMinutes] = useState<any | 'new' | null>(null);
  const [event, setEvent] = useState(false);
  const addNote = async () => {
    let attachments: unknown[] = [];
    if (files.length) {
      const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
      const r = await act(() => upload(`/crm/accounts/${account.id}/upload`, fd));
      if (!r) return;
      attachments = r as unknown[];
    }
    if (await act(() => post(`/crm/accounts/${account.id}/notes`, { body: text, attachments }), 'Notiz gespeichert')) { setText(''); setFiles([]); void reload(); }
  };
  const open = async (x: any) => {
    if (x.type === 'minutes') setMinutes(await import('../lib/api').then((m) => m.get(`/crm/minutes/${x.id}`)));
  };
  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <MentionInput value={text} onChange={setText} users={users} rows={2} placeholder="Notiz zum Kunden … (@ erwähnt Kollegen)" />
        <div className="row" style={{ marginTop: 6 }}>
          <label className="btn sm ghost"><Icon name="paperclip" /> Anhang<input type="file" multiple hidden onChange={(e) => setFiles([...e.target.files ?? []])} /></label>
          {files.map((f) => <span key={f.name} className="pill small">{f.name} {fmtBytes(f.size)}</span>)}
          <span className="grow" />
          <button className="btn sm" onClick={() => setMinutes('new')}><Icon name="file-text" /> Gesprächsprotokoll</button>
          <button className="btn sm" onClick={() => setEvent(true)}><Icon name="calendar" /> Termin</button>
          <button className="btn sm primary" disabled={!text.trim()} onClick={addNote}>Notiz speichern</button>
        </div>
      </div>
      {!data?.length ? <Empty icon="history" title="Noch keine Einträge">Notizen, Protokolle, Termine, E-Mails, Angebote und Projekte erscheinen hier.</Empty> : (
        <div className="timeline">
          {data.map((x) => (
            <div key={`${x.type}-${x.id}`} className="tl-item">
              <span className="tl-dot"><Icon name={TL_ICON[x.type] ?? 'dot'} /></span>
              <div className="small muted">{TL_LABEL[x.type]} · {fmtDateTime(x.at)}{x.userName ? ` · ${x.userName}` : ''}</div>
              <div className={x.type === 'minutes' ? 'click' : ''} onClick={() => open(x)}>
                {x.type === 'note' ? <div style={{ whiteSpace: 'pre-wrap' }}>{x.title}</div>
                  : x.type === 'project' ? <Link to={`/projects/${x.id}`}>{x.title}</Link>
                  : x.type === 'event' ? <Link to={`/calendar?event=${x.id}`}>{x.title}</Link>
                  : <b>{x.title}</b>}
                {x.type === 'minutes' && x.detail && <div className="small muted">{x.detail}</div>}
                {x.type === 'quote' && <span> <Pill tone={QUOTE_STATUS[x.detail]?.tone}>{QUOTE_STATUS[x.detail]?.label}</Pill> {fmtEuro(Number(x.extra))}</span>}
                {x.type === 'case' && <span> <Pill tone={CASE_STATUS[x.detail]?.tone}>{CASE_STATUS[x.detail]?.label}</Pill></span>}
                {x.type === 'opportunity' && <span> <Pill tone={STAGES.find((s) => s.id === x.detail)?.tone}>{STAGES.find((s) => s.id === x.detail)?.label}</Pill>{x.extra != null && ` ${fmtEuro(Number(x.extra))}`}</span>}
                {x.type === 'mail' && <div className="small muted">{x.extra === 'out' ? 'gesendet' : `von ${x.detail}`}</div>}
                {x.type === 'note' && Array.isArray(x.extra) && x.extra.map((f: any) => <a key={f.fileId} className="small" style={{ marginRight: 8 }} href={`/api/files/${f.fileId}/download`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {f.name}</a>)}
              </div>
            </div>
          ))}
        </div>
      )}
      {minutes && <MinutesModal accountId={account.id} minutes={minutes === 'new' ? undefined : minutes} onClose={() => setMinutes(null)} onSaved={() => { setMinutes(null); void reload(); }} />}
      {event && <CrmEventModal account={account} onClose={() => setEvent(false)} onSaved={() => { setEvent(false); void reload(); }} />}
    </div>
  );
}

/** Termin mit dem Kunden (erscheint im Kalender und im Verlauf) */
function CrmEventModal({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: () => void }) {
  return <EventModal defaults={{ title: `Termin ${account.name}`, crmAccountId: account.id, location: [account.street, account.city].filter(Boolean).join(', ') }} onClose={onClose} onSaved={onSaved} />;
}

function Contacts({ accountId, contacts, onChanged }: { accountId: string; contacts: CrmContact[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<CrmContact | 'new' | null>(null);
  const CH: Record<string, string> = { phone: 'Telefon', mobile: 'Mobil', email: 'E-Mail', visit: 'persönlich' };
  return (
    <div>
      <div className="toolbar"><span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Ansprechpartner</button></div>
      {!contacts.length ? <Empty icon="user" title="Noch keine Ansprechpartner" /> : (
        <div className="card-grid">{contacts.map((c) => (
          <div key={c.id} className="card click" onClick={() => setEdit(c)}>
            <div className="card-title"><Icon name="user" /><h3>{c.salutation} {contactName(c)}</h3>{c.isPrimary && <Pill tone="green">Hauptkontakt</Pill>}</div>
            <div className="small muted">{[c.position, c.department].filter(Boolean).join(' · ')}</div>
            <div className="small" style={{ marginTop: 6 }}>
              {c.phone && <div><PhoneLink number={c.phone} stop /></div>}
              {c.mobile && <div><PhoneLink number={c.mobile} label={`${c.mobile} (mobil)`} stop /></div>}
              {c.email && <div><a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}><Icon name="mail" /> {c.email}</a></div>}
              {c.birthday && <div className="muted">Geburtstag {new Date(c.birthday).toLocaleDateString('de-DE', { day: '2-digit', month: 'long' })}</div>}
              {c.preferredChannel && <div className="muted">am liebsten per {CH[c.preferredChannel]}</div>}
            </div>
          </div>
        ))}</div>
      )}
      {edit && <ContactModal accountId={accountId} contact={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </div>
  );
}

function AccountOpps({ accountId }: { accountId: string }) {
  const { data, reload } = useApi<any[]>(`/crm/opportunities?accountId=${accountId}`);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [quoteFor, setQuoteFor] = useState<any | null>(null);
  return (
    <div>
      <div className="toolbar"><span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Verkaufschance</button></div>
      {!data?.length ? <Empty icon="target" title="Keine Verkaufschancen" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Titel</th><th>Phase</th><th style={{ textAlign: 'right' }}>Wert</th><th>Wahrsch.</th><th>Abschluss</th><th>Zuständig</th><th /></tr></thead>
          <tbody>{data.map((o) => { const s = STAGES.find((x) => x.id === o.stage)!; return (
            <tr key={o.id} className="click" onClick={() => setEdit(o)}>
              <td>{o.title}</td><td><Pill tone={s.tone}>{s.label}</Pill></td><td style={{ textAlign: 'right' }}>{fmtEuro(o.value)}</td><td>{o.probability} %</td>
              <td>{fmtDate(o.expectedClose)}</td><td className="small">{o.ownerName}</td>
              <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                {o.stage !== 'won' && o.stage !== 'lost' && <button className="btn sm" onClick={() => setQuoteFor(o)}><Icon name="euro" /> Angebot</button>}
                {o.stage === 'won' && (o.projectId ? <Link className="btn sm" to={`/projects/${o.projectId}`}>Projekt {o.projectNumber}</Link> : <WonToProject opp={o} onDone={reload} />)}
              </td>
            </tr>
          ); })}</tbody>
        </table></div>
      )}
      {edit && <OpportunityModal accountId={accountId} opp={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
      {quoteFor && <QuoteEditor accountId={accountId} opportunityId={quoteFor.id} title={quoteFor.title} onClose={() => setQuoteFor(null)} onSaved={() => { setQuoteFor(null); void reload(); }} />}
    </div>
  );
}

function AccountQuotes({ accountId }: { accountId: string }) {
  const { data, reload } = useApi<any[]>(`/crm/quotes?accountId=${accountId}`);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  return (
    <div>
      <div className="toolbar"><span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Angebot</button></div>
      {!data?.length ? <Empty icon="file-text" title="Keine Angebote" /> : <QuoteTable rows={data} onOpen={setEdit} hideAccount />}
      {edit && <QuoteEditor accountId={accountId} quote={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function AccountCases({ accountId }: { accountId: string }) {
  const { data, reload } = useApi<any[]>(`/crm/cases?accountId=${accountId}`);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  return (
    <div>
      <div className="toolbar"><span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Reklamation</button></div>
      {!data?.length ? <Empty icon="alert" title="Keine Reklamationen" /> : <CaseTable rows={data} onOpen={setEdit} hideAccount />}
      {edit && <CaseModal accountId={accountId} item={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function AccountProjects({ account }: { account: any }) {
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <div className="toolbar"><span className="grow" /><button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" /> Projekt für {account.name}</button></div>
      {!account.projects.length ? <Empty icon="projects" title="Noch keine Projekte" /> : (
        <div className="card-grid">{account.projects.map((p: any) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="card click"><div className="card-title"><Icon name="projects" /><h3>{p.number} {p.name}</h3></div><div className="small muted">{p.status}</div></Link>
        ))}</div>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} customer={{ id: account.id, name: account.name, number: account.number }} />}
    </div>
  );
}
