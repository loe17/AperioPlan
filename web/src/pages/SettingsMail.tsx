/**
 * Einstellungen für E-Mail: einheitliche Firmen-Signatur und die Anmeldung mit Microsoft bzw. Google.
 */
import { useState } from 'react';
import { Field, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { useAdminSettings } from './Settings';
import { SignatureEditor } from '../modules/mail/MailSignatures';

export function MailSignatureSettings() {
  const act = useAction();
  const s = useAdminSettings('mailSignature');
  if (!s.value) return null;
  const v = s.value as { enabled: boolean; mode: 'default' | 'mandatory'; html: string };
  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ marginBottom: 8 }}>Firmen-Signatur</h1>
      <p className="muted">Eine einheitliche Signatur für alle. Name, Berufsbezeichnung und Abteilung kommen aus dem Benutzerkonto, Telefon und Mobilnummer aus dem Profil der jeweiligen Person – Sie gestalten die Vorlage nur einmal.</p>
      <label className="row" style={{ margin: '12px 0' }}><input type="checkbox" checked={v.enabled} onChange={(e) => s.setValue({ ...v, enabled: e.target.checked })} /> Firmen-Signatur verwenden</label>
      {v.enabled && <>
        <Field label="Verbindlichkeit">
          <select value={v.mode} onChange={(e) => s.setValue({ ...v, mode: e.target.value as 'default' | 'mandatory' })}>
            <option value="default">Voreinstellung – jede Person kann stattdessen eine eigene wählen</option>
            <option value="mandatory">Pflicht – wird immer verwendet</option>
          </select>
        </Field>
        <Field label="Vorlage"><SignatureEditor value={v.html} onChange={(html) => s.setValue({ ...v, html })} /></Field>
        <div className="hint">Zeilen mit einem leeren Platzhalter (z. B. kein Mobiltelefon hinterlegt) entfallen beim Einfügen automatisch. Ein Logo wird direkt in die E-Mail eingebettet.</div>
      </>}
      <div className="spacer" />
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Firmen-Signatur gespeichert')}>Speichern</button>
    </div>
  );
}

export function MailOAuthSettings() {
  const act = useAction();
  const s = useAdminSettings('mailOAuth');
  const [copied, setCopied] = useState(false);
  if (!s.value) return null;
  const v = s.value as { microsoftClientId: string; microsoftClientSecret: string; microsoftTenant: string; googleClientId: string; googleClientSecret: string };
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => s.setValue({ ...v, [k]: e.target.value });
  const redirect = `${location.origin}/api/mailbox/oauth/callback`;
  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ marginBottom: 8 }}>E-Mail-Anmeldung mit Microsoft und Google</h1>
      <p className="muted">Microsoft lässt die Anmeldung nur mit Passwort für Firmenkonten nach und nach nicht mehr zu (das Versenden ist ab Ende 2026 standardmäßig gesperrt). Damit Ihre Mitarbeiter im Einrichtungsassistenten einfach auf „Mit Microsoft anmelden“ klicken können, wird AperioPlan hier einmalig beim Anbieter eingetragen. Bei Google geht es auch ohne – dann mit einem App-Passwort.</p>
      <div className="card flat" style={{ marginBottom: 16 }}>
        <div className="small muted">Rücksprung-Adresse (beim Anbieter eintragen):</div>
        <div className="row"><code className="grow" style={{ wordBreak: 'break-all' }}>{redirect}</code>
          <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(redirect); setCopied(true); }}><Icon name="copy" /> {copied ? 'Kopiert' : 'Kopieren'}</button></div>
        <div className="small muted" style={{ marginTop: 4 }}>Wichtig: Die Adresse muss so aussehen, wie Ihre Mitarbeiter AperioPlan im Browser aufrufen (am besten mit https).</div>
      </div>

      <h2>Microsoft 365 / Outlook.com</h2>
      <ol className="small">
        <li>Im Microsoft Entra Admin Center unter „App-Registrierungen“ eine neue Registrierung anlegen (Name z. B. „AperioPlan E-Mail“, Kontotypen nach Bedarf).</li>
        <li>Als Umleitungs-URI „Web“ die Rücksprung-Adresse von oben eintragen.</li>
        <li>Unter „API-Berechtigungen“ hinzufügen: Office 365 Exchange Online → <b>IMAP.AccessAsUser.All</b> und <b>SMTP.Send</b> (delegiert), dazu offline_access. Danach die Administratorzustimmung erteilen.</li>
        <li>Unter „Zertifikate &amp; Geheimnisse“ einen geheimen Clientschlüssel anlegen und hier mit der Anwendungs-ID eintragen.</li>
        <li>Für Exchange Online muss beim Postfach „Authentifiziertes SMTP“ erlaubt sein.</li>
      </ol>
      <div className="grid3">
        <Field label="Anwendungs-ID (Client-ID)"><input value={v.microsoftClientId} onChange={set('microsoftClientId')} /></Field>
        <Field label="Geheimer Schlüssel"><input type="password" value={v.microsoftClientSecret} onChange={set('microsoftClientSecret')} autoComplete="new-password" /></Field>
        <Field label="Verzeichnis (Mandant)" hint="„common“ oder die Verzeichnis-ID Ihres Unternehmens"><input value={v.microsoftTenant} onChange={set('microsoftTenant')} /></Field>
      </div>

      <h2>Google (Gmail / Workspace)</h2>
      <ol className="small">
        <li>In der Google Cloud Console ein Projekt anlegen und unter „APIs &amp; Dienste → Anmeldedaten“ eine OAuth-Client-ID vom Typ „Webanwendung“ erstellen.</li>
        <li>Die Rücksprung-Adresse von oben als „Autorisierte Weiterleitungs-URI“ eintragen.</li>
        <li>Im Zustimmungsbildschirm den Bereich <b>https://mail.google.com/</b> hinzufügen.</li>
      </ol>
      <div className="grid2">
        <Field label="Client-ID"><input value={v.googleClientId} onChange={set('googleClientId')} /></Field>
        <Field label="Clientschlüssel"><input type="password" value={v.googleClientSecret} onChange={set('googleClientSecret')} autoComplete="new-password" /></Field>
      </div>
      <div className="spacer" />
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
