import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { APP_CATEGORIES, appInfo } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, post, upload, invalidate } from '../lib/api';
import { useSession } from '../session';
import { Confirm, Empty, Modal, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';

interface StoreApp {
  id: string; name: string; summary: string; features: string[]; category: string; icon: string; route?: string; requires?: string[];
  source: 'builtin' | 'plugin'; installed: boolean; allowed: boolean; version?: string; author?: string; projectTab?: string | null;
}

/** App-Store: Anwendungen ein- und ausschalten, Plugins hochladen */
export default function AppStorePage() {
  useCrumbs([{ label: 'App-Store' }]);
  const { me } = useSession();
  const isAdmin = me?.role === 'admin';
  const { data, reload } = useApi<StoreApp[]>('/apps');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'installed' | 'available'>('all');
  const [open, setOpen] = useState<StoreApp | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const list = useMemo(() => (data ?? []).filter((a) => (!q || `${a.name} ${a.summary} ${a.features.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
    && (filter === 'all' || (filter === 'installed' ? a.installed : !a.installed))), [data, q, filter]);
  const cats = [...APP_CATEGORIES, 'Plugins'].filter((c) => list.some((a) => a.category === c || (c === 'Plugins' && a.source === 'plugin' && !APP_CATEGORIES.includes(a.category as never))));
  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>App-Store</h1><div className="sub">{isAdmin ? 'Anwendungen für die ganze Firma ein- und ausschalten. Wer sie nutzen darf, legen Sie je Benutzer oder Abteilung fest.' : 'Diese Anwendungen stehen in Ihrer Firma zur Verfügung.'}</div></div>
        {isAdmin && <div className="actions">
          <button className="btn" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Plugin hochladen (ZIP)</button>
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            const fd = new FormData(); fd.append('file', f, f.name);
            try { const r = await upload('/apps/upload', fd); toast(`Plugin „${r.manifest.name}“ ${r.manifest.version} hochgeladen – jetzt installieren`); reload(); }
            catch (err) { toast((err as Error).message, 'error'); }
          }} />
        </div>}
      </div>
      <div className="toolbar">
        <input placeholder="Anwendung suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        {isAdmin && <div className="row" style={{ gap: 4 }}>
          {([['all', 'Alle'], ['installed', 'Installiert'], ['available', 'Verfügbar']] as const).map(([k, l]) => <button key={k} className={`btn sm ${filter === k ? 'primary' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
        </div>}
        <span className="muted small right">{data?.filter((a) => a.installed).length ?? 0} installiert</span>
      </div>
      {!list.length && <Empty icon="puzzle" title="Keine Anwendungen gefunden" />}
      {cats.map((c) => {
        const apps = list.filter((a) => a.category === c || (c === 'Plugins' && a.source === 'plugin' && !APP_CATEGORIES.includes(a.category as never)));
        return (
          <section key={c} style={{ marginBottom: 26 }}>
            <h2 style={{ marginBottom: 10 }}>{c}</h2>
            <div className="app-grid">
              {apps.map((a) => (
                <div key={a.id} className={`app-card ${a.installed ? 'on' : ''}`} onClick={() => setOpen(a)}>
                  <div className="app-icon"><Icon name={a.icon} size={22} /></div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}><b>{a.name}</b>{a.source === 'plugin' && <Pill>Plugin {a.version}</Pill>}</div>
                    <div className="small muted app-summary">{a.summary}</div>
                    <div style={{ marginTop: 6 }}>{a.installed ? <Pill tone="green"><Icon name="check" /> installiert</Pill> : <Pill>verfügbar</Pill>}
                      {a.installed && !a.allowed && a.source === 'builtin' && <span className="small muted"> · für Sie nicht freigeschaltet</span>}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {open && <AppDetail app={open} isAdmin={isAdmin} onClose={() => setOpen(null)} onChanged={() => { reload(); invalidate('/plugins'); setOpen(null); }} />}
    </div>
  );
}

function AppDetail({ app, isAdmin, onClose, onChanged }: { app: StoreApp; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const act = useAction();
  const [grantAll, setGrantAll] = useState(true);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); const r = await act(fn, msg); setBusy(false); if (r) onChanged(); };
  return (
    <Modal title={<span className="row"><Icon name={app.icon} /> {app.name}</span>} onClose={onClose} footer={<>
      {isAdmin && app.source === 'plugin' && <button className="btn danger" onClick={() => setRemove(true)}><Icon name="trash" /> Dateien löschen</button>}
      <span className="grow" />
      {app.installed && app.allowed && app.route && <Link className="btn" to={app.route} onClick={onClose}>Öffnen</Link>}
      {isAdmin && (app.installed
        ? <button className="btn" disabled={busy} onClick={() => run(() => post(`/apps/${app.id}/uninstall`), `${app.name} ausgeschaltet`)}>Ausschalten</button>
        : <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/apps/${app.id}/install`, { grantAll }), `${app.name} installiert`)}><Icon name="download" /> Installieren</button>)}
    </>}>
      <p>{app.summary}</p>
      {app.features.length > 0 && <ul style={{ lineHeight: 1.8, paddingLeft: 20 }}>{app.features.map((f) => <li key={f}>{f}</li>)}</ul>}
      {app.requires?.length ? <p className="small muted">Benötigt: {app.requires.map((r) => appInfo(r)?.name ?? r).join(', ')}</p> : null}
      {app.source === 'plugin' && <p className="small muted">Plugin {app.version}{app.author ? ` von ${app.author}` : ''}{app.projectTab ? ` · erscheint als Reiter „${app.projectTab}“ in Projekten` : ''}. Plugins laufen in einem eigenen Rahmen und nutzen Ihre Anmeldung.</p>}
      {isAdmin && !app.installed && app.source === 'builtin' && <label className="row small"><input type="checkbox" checked={grantAll} onChange={(e) => setGrantAll(e.target.checked)} /> Für alle Benutzer freischalten (auch für die mit eigener Werkzeugliste)</label>}
      {isAdmin && app.installed && <p className="hint">Beim Ausschalten bleiben alle Daten erhalten. Nach dem Wiedereinschalten ist alles wieder da.</p>}
      {remove && <Confirm danger text={`Plugin „${app.name}“ ausschalten und seine Dateien vom Server löschen? Gespeicherte Daten des Plugins bleiben erhalten.`} onClose={() => setRemove(false)}
        onConfirm={() => run(() => del(`/apps/${app.id}`), 'Plugin entfernt')} />}
    </Modal>
  );
}
