import { useState } from 'react';
import { del, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';

interface Account { id: string; kind: 'caldav' | 'ics'; name: string; url: string; username: string; color: string; pushNew: boolean; lastSyncAt: string | null; lastError: string | null; eventCount: number }

const PRESETS: { label: string; url: string; hint: string }[] = [
  { label: 'Nextcloud', url: 'https://cloud.firma.de/remote.php/dav', hint: 'Benutzername und ein App-Passwort (Nextcloud → Einstellungen → Sicherheit)' },
  { label: 'Google', url: 'https://apidata.googleusercontent.com/caldav/v2/IHRE-ADRESSE@gmail.com/events', hint: 'Google-Adresse und ein App-Passwort (Google-Konto → Sicherheit → App-Passwörter)' },
  { label: 'mailbox.org', url: 'https://dav.mailbox.org/caldav/', hint: 'Ihre mailbox.org-Adresse und Ihr Passwort' },
  { label: 'Synology', url: 'https://nas.firma.local:5001/caldav/', hint: 'Benutzer des NAS; in „Synology Calendar“ unter CalDAV-Konto zu sehen' },
  { label: 'iCloud', url: 'https://caldav.icloud.com/', hint: 'Apple-ID und ein app-spezifisches Passwort' },
];

/** Kalender des E-Mail-Kontos verbinden und eigener Abo-Link */
export function CalendarSyncSettings() {
  const act = useAction();
  const { data: accounts, reload } = useApi<Account[]>('/calendar/accounts');
  const { data: ical, reload: reloadIcal } = useApi<{ path: string }>('/me/ical');
  const [edit, setEdit] = useState<Partial<Account> & { password?: string } | null>(null);
  const [remove, setRemove] = useState<Account | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const feed = ical ? `${location.origin}${ical.path}` : '';

  const sync = async (a: Account) => {
    setBusy(a.id);
    const r = await act(() => post<{ count: number }>(`/calendar/accounts/${a.id}/sync`), undefined);
    setBusy(null);
    if (r) await reload();
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ marginBottom: 8 }}>Kalender verbinden</h1>
      <p className="muted">Termine aus dem Kalender Ihres E-Mail-Kontos erscheinen in „Mein Kalender“. Bei CalDAV werden hier angelegte Termine auch dort eingetragen.</p>

      <div className="row" style={{ margin: '14px 0' }}>
        <button className="btn primary" onClick={() => setEdit({ kind: 'caldav', name: '', url: '', username: '', color: '#0ea5e9', pushNew: true })}><Icon name="plus" /> CalDAV-Kalender (beide Richtungen)</button>
        <button className="btn" onClick={() => setEdit({ kind: 'ics', name: '', url: '', color: '#64748b' })}><Icon name="link" /> Kalender-Abo (.ics, nur lesen)</button>
      </div>

      {!accounts?.length && <Empty icon="calendar" title="Noch kein Kalender verbunden">Verbinden Sie z. B. Nextcloud, Google oder mailbox.org.</Empty>}
      {accounts?.map((a) => (
        <div key={a.id} className="card row" style={{ marginBottom: 8, borderLeft: `4px solid ${a.color}` }}>
          <Icon name={a.kind === 'caldav' ? 'refresh' : 'link'} />
          <div className="grow">
            <b>{a.name}</b> <span className="muted small">{a.kind === 'caldav' ? 'CalDAV, beide Richtungen' : 'Abo, nur lesen'} · {a.eventCount} Termine</span>
            <div className="small muted mono" style={{ wordBreak: 'break-all' }}>{a.url}</div>
            {a.lastError ? <div className="error-text">Letzter Abgleich fehlgeschlagen: {a.lastError}</div>
              : <div className="small muted">{a.lastSyncAt ? `Zuletzt abgeglichen ${fmtDateTime(a.lastSyncAt)}` : 'Noch nicht abgeglichen'} · automatisch alle 15 Minuten</div>}
          </div>
          <button className="btn sm" disabled={busy === a.id} onClick={() => sync(a)}><Icon name="refresh" /> {busy === a.id ? 'Gleicht ab …' : 'Jetzt abgleichen'}</button>
          <button className="btn sm" onClick={() => setEdit({ ...a })}><Icon name="edit" /></button>
          <button className="btn sm danger" onClick={() => setRemove(a)}><Icon name="trash" /></button>
        </div>
      ))}

      <h2 style={{ margin: '28px 0 8px' }}>AperioPlan-Kalender abonnieren</h2>
      <p className="muted">Mit diesem persönlichen Link sehen Sie Ihre Termine, Fristen, Urlaube und Buchungen in Outlook, Thunderbird oder auf dem Handy (nur lesen).</p>
      <div className="row">
        <input readOnly className="mono" value={feed} onFocus={(e) => e.target.select()} />
        <button className="btn" onClick={() => { void navigator.clipboard?.writeText(feed); }}><Icon name="copy" /> Kopieren</button>
        <button className="btn" title="Neuer Link – der alte funktioniert dann nicht mehr" onClick={async () => { await act(() => post('/me/ical/reset'), 'Neuer Link erzeugt'); await reloadIcal(); }}><Icon name="refresh" /> Neu erzeugen</button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>Outlook: Kalender → Kalender hinzufügen → Aus dem Internet abonnieren. Den Link nicht weitergeben – wer ihn kennt, sieht Ihre Termine.</div>

      {edit && <AccountModal account={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reload(); }} />}
      {remove && <Confirm danger text={`„${remove.name}“ trennen? Die Termine daraus verschwinden aus AperioPlan; im Konto selbst bleibt alles erhalten.`} confirmLabel="Trennen"
        onClose={() => setRemove(null)} onConfirm={async () => { await act(() => del(`/calendar/accounts/${remove.id}`), 'Kalender getrennt'); setRemove(null); await reload(); }} />}
    </div>
  );
}

function AccountModal({ account, onClose, onSaved }: { account: Partial<Account> & { password?: string }; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const toast = useToast();
  const [a, setA] = useState(account);
  const [preset, setPreset] = useState<string>('');
  const caldav = a.kind === 'caldav';
  const save = async () => {
    const body = { name: a.name, url: a.url, username: a.username ?? '', color: a.color, pushNew: a.pushNew ?? false, ...(a.password ? { password: a.password } : {}) };
    const r = await act(() => (a.id ? patch(`/calendar/accounts/${a.id}`, body) : post<{ count?: number; error?: string }>('/calendar/accounts', { ...body, kind: a.kind })),
      a.id ? 'Gespeichert' : undefined);
    if (!r) return;
    const res = r as { count?: number; error?: string };
    if (!a.id && res.error) toast(`Verbunden, aber der erste Abgleich schlug fehl: ${res.error}`, 'error');
    else if (!a.id) toast(`Verbunden – ${res.count ?? 0} Termine übernommen`);
    onSaved();
  };
  return (
    <Modal title={a.id ? `„${a.name}“ bearbeiten` : caldav ? 'CalDAV-Kalender verbinden' : 'Kalender-Abo hinzufügen'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!a.name?.trim() || !a.url?.trim()} onClick={save}>{a.id ? 'Speichern' : 'Verbinden und prüfen'}</button></>}>
      {caldav && !a.id && (
        <Field label="Anbieter (Vorschlag für die Adresse)">
          <div className="row wrap">{PRESETS.map((p) => <button key={p.label} type="button" className={`btn sm ${preset === p.label ? 'primary' : ''}`}
            onClick={() => { setPreset(p.label); setA({ ...a, url: p.url, name: a.name || p.label }); }}>{p.label}</button>)}</div>
          {preset && <div className="hint">{PRESETS.find((p) => p.label === preset)?.hint}</div>}
        </Field>
      )}
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={a.name ?? ''} onChange={(e) => setA({ ...a, name: e.target.value })} placeholder="z. B. Firmenkalender" /></Field>
        <Field label="Farbe"><input type="color" value={a.color ?? '#0ea5e9'} onChange={(e) => setA({ ...a, color: e.target.value })} style={{ width: 60, padding: 2 }} /></Field>
      </div>
      <Field label={caldav ? 'Adresse (Server oder Kalender)' : 'Abo-Link (.ics)'} required hint={caldav ? 'Es genügt die Server-Adresse – der Kalender wird dann selbst gesucht.' : 'Beginnt mit https:// oder webcal://'}>
        <input className="mono" value={a.url ?? ''} onChange={(e) => setA({ ...a, url: e.target.value })} />
      </Field>
      {caldav && (
        <div className="grid2">
          <Field label="Benutzername"><input value={a.username ?? ''} onChange={(e) => setA({ ...a, username: e.target.value })} autoComplete="off" /></Field>
          <Field label={a.id ? 'Passwort (leer = unverändert)' : 'Passwort bzw. App-Passwort'}><input type="password" value={a.password ?? ''} onChange={(e) => setA({ ...a, password: e.target.value })} autoComplete="new-password" /></Field>
        </div>
      )}
      {caldav && <label className="row"><input type="checkbox" checked={Boolean(a.pushNew)} onChange={(e) => setA({ ...a, pushNew: e.target.checked })} /> Neue Termine aus AperioPlan auch in diesem Kalender anlegen</label>}
      <div className="hint" style={{ marginTop: 8 }}>Das Passwort wird verschlüsselt gespeichert.</div>
    </Modal>
  );
}
