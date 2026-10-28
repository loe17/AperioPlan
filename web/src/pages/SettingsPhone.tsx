import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { post, put } from '../lib/api';
import { Field, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { useAdminSettings } from './Settings';

const PROVIDERS: [string, string, string][] = [
  ['none', 'Keine Anlage', 'Nur Wählen per Klick über das Telefonprogramm des Rechners'],
  ['fritzbox', 'FRITZ!Box', 'Anrufmonitor (am Telefon einmal #96*5* wählen) und Wählhilfe'],
  ['sipgate', 'sipgate', 'Webhook in sipgate.io eintragen, Wählen über die sipgate-Schnittstelle'],
  ['placetel', 'Placetel', 'Webhook (Notify-URL) im Placetel-Portal eintragen'],
  ['3cx', '3CX', 'CRM-Vorlage in der 3CX-Verwaltung importieren'],
  ['asterisk', 'Asterisk / FreePBX', 'Manager-Schnittstelle (AMI) – Softphone über WebRTC möglich'],
  ['generic', 'Andere Anlage', 'Allgemeine Schnittstelle: Anlage meldet Anrufe per HTTP'],
];

/** Telefonanlage anbinden (Administrator) */
export function PhoneSettings() {
  const act = useAction();
  const toast = useToast();
  const s = useAdminSettings('phone');
  const { data, reload } = useApi<any>('/phone/admin');
  if (!s.value) return null;
  const v = s.value;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => s.setValue({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const copy = async (t: string) => { await navigator.clipboard.writeText(t).catch(() => {}); toast('Kopiert'); };
  const Hook = ({ label, url }: { label: string; url: string }) => <Field label={label}><div className="row"><input readOnly className="mono small" value={url} /><button className="btn" onClick={() => copy(url)}><Icon name="copy" /></button></div></Field>;
  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginBottom: 8 }}>Telefonie</h1>
      <p className="muted">Bindet die Telefonanlage an: Bei Anrufen erscheint, wer anruft (aus dem CRM), alle Gespräche landen in der Anrufliste, und Mitarbeiter wählen per Klick oder telefonieren mit dem Headset am PC.</p>
      <h2 style={{ margin: '16px 0 8px' }}>Telefonanlage</h2>
      <div className="provider-grid">
        {PROVIDERS.map(([k, l, d]) => <label key={k} className={`provider ${v.provider === k ? 'on' : ''}`}><input type="radio" name="prov" checked={v.provider === k} onChange={() => s.setValue({ ...v, provider: k })} /><b>{l}</b><span className="small muted">{d}</span></label>)}
      </div>
      {data?.connector && (v.provider === 'fritzbox' || v.provider === 'asterisk') && <p className="small">{data.connector.connected ? <Pill tone="green">verbunden seit {new Date(data.connector.since).toLocaleTimeString('de-DE')}</Pill> : <Pill tone="red">nicht verbunden{data.connector.error ? `: ${data.connector.error}` : ''}</Pill>}</p>}

      {v.provider === 'fritzbox' && <div className="grid3">
        <Field label="Adresse der FRITZ!Box"><input value={v.fritzHost} onChange={set('fritzHost')} /></Field>
        <Field label="Benutzer (für Wählhilfe)"><input value={v.fritzUser} onChange={set('fritzUser')} /></Field>
        <Field label="Passwort"><input type="password" value={v.fritzPassword} onChange={set('fritzPassword')} autoComplete="new-password" /></Field>
      </div>}
      {v.provider === 'asterisk' && <div className="grid3">
        <Field label="AMI-Adresse"><input value={v.amiHost} onChange={set('amiHost')} placeholder="pbx.firma.local" /></Field>
        <Field label="AMI-Port"><input type="number" value={v.amiPort} onChange={set('amiPort')} /></Field>
        <Field label="AMI-Benutzer"><input value={v.amiUser} onChange={set('amiUser')} /></Field>
        <Field label="AMI-Passwort"><input type="password" value={v.amiPassword} onChange={set('amiPassword')} autoComplete="new-password" /></Field>
      </div>}
      {v.provider === 'sipgate' && <div className="grid2">
        <Field label="sipgate Token-ID" hint="Persönlicher Zugangs-Token mit Recht „sessions:calls:write“"><input value={v.sipgateTokenId} onChange={set('sipgateTokenId')} /></Field>
        <Field label="sipgate Token"><input type="password" value={v.sipgateToken} onChange={set('sipgateToken')} autoComplete="new-password" /></Field>
      </div>}
      {data?.hooks && ['sipgate', 'placetel', 'generic', '3cx'].includes(v.provider) && <div className="card flat" style={{ marginBottom: 12 }}>
        {v.provider === 'sipgate' && <Hook label="In sipgate.io unter Webhooks als URL für eingehende und ausgehende Anrufe eintragen" url={data.hooks.sipgate} />}
        {v.provider === 'placetel' && <Hook label="Im Placetel-Portal unter Integrationen → Notify-URL eintragen" url={data.hooks.placetel} />}
        {v.provider === 'generic' && <><Hook label="Die Anlage sendet Ereignisse als JSON (POST) an" url={data.hooks.generic} />
          <pre className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{'{ "event": "ring" | "call" | "answer" | "hangup", "callId": "…", "from": "…", "to": "…", "extension": "21" }'}</pre></>}
        {v.provider === '3cx' && <>
          <p className="small">In der 3CX-Verwaltung unter <i>Einstellungen → CRM-Integration</i> die Vorlage hochladen. Danach zeigt der 3CX-Client bei Anrufen den Kunden aus AperioPlan an, und Gespräche erscheinen in der Anrufliste.</p>
          <a className="btn" href="/api/phone/admin/3cx-template.xml"><Icon name="download" /> 3CX-Vorlage herunterladen</a>
        </>}
        <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={async () => { if (await act(() => post('/phone/admin/new-secret'), 'Neue Adressen erzeugt – bitte in der Anlage aktualisieren')) reload(); }}>Neue geheime Adressen erzeugen</button>
      </div>}

      <h2 style={{ margin: '16px 0 8px' }}>Rufnummern und Wählen</h2>
      <div className="grid3">
        <Field label="Landesvorwahl" hint="ohne +, Deutschland 49"><input value={v.countryCode} onChange={set('countryCode')} /></Field>
        <Field label="Ortsvorwahl" hint="ohne 0, z. B. 771"><input value={v.areaCode} onChange={set('areaCode')} /></Field>
        <Field label="Amtsholung" hint="z. B. 0 – leer, wenn nicht nötig"><input value={v.outsideLinePrefix} onChange={set('outsideLinePrefix')} /></Field>
      </div>
      <Field label="Wählen per Klick">
        <select value={v.dialMethod} onChange={set('dialMethod')}>
          <option value="tel">Telefonprogramm des Rechners (tel:-Link, z. B. Teams, 3CX-App)</option>
          <option value="softphone">Softphone im Browser (Headset am PC)</option>
          <option value="fritzbox">FRITZ!Box-Wählhilfe (Telefon klingelt, dann wird gewählt)</option>
          <option value="sipgate">sipgate (Gerät klingelt, dann wird gewählt)</option>
        </select>
      </Field>
      <div className="grid2">
        <Field label="Softphone: SIP über WebSocket" hint="z. B. wss://pbx.firma.de:8089/ws – die Anlage muss WebRTC unterstützen (Asterisk/FreePBX, Kamailio u. a.)"><input value={v.sipWsUrl} onChange={set('sipWsUrl')} placeholder="wss://…" /></Field>
        <Field label="SIP-Domain" hint="leer = Adresse aus der WebSocket-URL"><input value={v.sipDomain} onChange={set('sipDomain')} /></Field>
      </div>
      <label className="row small"><input type="checkbox" checked={v.popupForAll} onChange={set('popupForAll')} /> Anrufe ohne zugeordnete Nebenstelle allen Telefonie-Nutzern anzeigen</label>
      <div className="spacer" />
      <button className="btn primary" onClick={async () => { if (await act(() => s.save(v), 'Gespeichert')) reload(); }}>Speichern</button>

      <h2 style={{ margin: '24px 0 8px' }}>Mitarbeiter</h2>
      <p className="small muted">Nebenstelle bzw. SIP-Benutzer und Durchwahl je Mitarbeiter – darüber ordnet AperioPlan Anrufe der richtigen Person zu.</p>
      {data?.users && <div className="table-wrap"><table className="table">
        <thead><tr><th>Telefonie</th><th>Mitarbeiter</th><th>Nebenstelle</th><th>Durchwahl(en)</th><th>SIP-Benutzer (Softphone)</th><th>SIP-Passwort</th><th /></tr></thead>
        <tbody>{data.users.map((u: any) => <PhoneUserRow key={u.id} u={u} onSaved={reload} />)}</tbody>
      </table></div>}
    </div>
  );
}

function PhoneUserRow({ u, onSaved }: { u: any; onSaved: () => void }) {
  const act = useAction();
  const [r, setR] = useState({ enabled: u.enabled, extension: u.extension, numbers: u.numbers.join(', '), sipUser: u.sipUser, sipPassword: '' });
  const dirty = r.enabled !== u.enabled || r.extension !== u.extension || r.numbers !== u.numbers.join(', ') || r.sipUser !== u.sipUser || r.sipPassword;
  return (
    <tr>
      <td><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /></td>
      <td>{u.displayName}</td>
      <td><input style={{ width: 80 }} value={r.extension} disabled={!r.enabled} onChange={(e) => setR({ ...r, extension: e.target.value })} /></td>
      <td><input style={{ width: 170 }} value={r.numbers} disabled={!r.enabled} placeholder="+49 771 1234-21" onChange={(e) => setR({ ...r, numbers: e.target.value })} /></td>
      <td><input style={{ width: 120 }} value={r.sipUser} disabled={!r.enabled} onChange={(e) => setR({ ...r, sipUser: e.target.value })} /></td>
      <td><input style={{ width: 120 }} type="password" value={r.sipPassword} disabled={!r.enabled} placeholder={u.hasSipPassword ? '(gespeichert)' : ''} onChange={(e) => setR({ ...r, sipPassword: e.target.value })} autoComplete="new-password" /></td>
      <td>{dirty && <button className="btn sm primary" onClick={async () => {
        if (await act(() => put(`/phone/admin/users/${u.id}`, { enabled: r.enabled, extension: r.extension, numbers: r.numbers.split(',').map((x: string) => x.trim()).filter(Boolean), sipUser: r.sipUser, ...(r.sipPassword ? { sipPassword: r.sipPassword } : {}) }), 'Gespeichert')) onSaved();
      }}>Speichern</button>}</td>
    </tr>
  );
}
