import { useState } from 'react';
import { del, patch, post, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { fmtDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { fileIcon } from './ProjectFiles';
import { OfficeButton } from './Office';

export const DOC_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Entwurf', tone: 'amber' },
  review: { label: 'In Prüfung', tone: 'blue' },
  released: { label: 'Freigegeben', tone: 'green' },
  obsolete: { label: 'Ungültig', tone: '' },
};
export const DOC_KINDS = ['Angebot', 'Auftragsbestätigung', 'Lastenheft', 'Pflichtenheft', 'Protokoll', 'Bericht', 'Zeichnung', 'Betriebsanleitung', 'Konformitätserklärung', 'Liste', 'Vertrag', 'Sonstiges'];

interface Doc {
  id: string; number: string; title: string; kind: string; version: number; status: string; description: string;
  fileId: string | null; fileName: string | null; filePath: string | null; createdAt: string; updatedAt: string; createdByName: string | null;
}
interface Template { id: string; builtinKey: string | null; name: string; kind: string; ext: string; active: boolean }


/**
 * Dokumentenregister: jedes Projektdokument mit fester Nummer (0100-DOK-001), Art, Version und Status.
 * Neue Dokumente entstehen auf Wunsch direkt aus einer Vorlage – Nummer, Titel, Projekt usw. sind dann schon eingetragen.
 */
export function Documents({ projectId, canEdit, canManage }: { projectId: string; canEdit: boolean; canManage?: boolean }) {
  const { data } = useApi<Doc[]>(`/projects/${projectId}/documents`);
  const [create, setCreate] = useState(false);
  const [remove, setRemove] = useState<Doc | null>(null);
  const [filter, setFilter] = useState('');
  const act = useAction();
  const reload = () => invalidate(`/projects/${projectId}/documents`);
  const setStatus = async (d: Doc, status: string) => { if (await act(() => patch(`/documents/${d.id}`, { status }), `Status: ${DOC_STATUS[status]!.label}`)) reload(); };
  const rows = (data ?? []).filter((d) => !filter || `${d.number} ${d.title} ${d.kind}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Nummer, Titel oder Art …" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 260 }} />
        <span className="muted small">Angebote, Lastenhefte, Protokolle, Berichte – jedes Dokument mit fester Nummer, Version und Freigabestatus.</span>
        {canEdit && <button className="btn primary right" onClick={() => setCreate(true)}><Icon name="plus" /> Neues Dokument</button>}
      </div>
      {!rows.length ? <Empty icon="file-text" title={data?.length ? 'Kein Treffer' : 'Noch keine Dokumente'}>{!data?.length && 'Legen Sie ein Dokument aus einer Vorlage an – die Nummer wird automatisch vergeben.'}</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nummer</th><th>Titel</th><th>Art</th><th>Version</th><th>Status</th><th>Datei</th><th>Geändert</th><th /></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.number}</td>
              <td><b>{d.title}</b>{d.description && <div className="small muted">{d.description}</div>}</td>
              <td>{d.kind}</td>
              <td className="mono">V{d.version}</td>
              <td>{canEdit
                ? <select value={d.status} onChange={(e) => setStatus(d, e.target.value)} className={`select-pill ${DOC_STATUS[d.status]?.tone ?? ''}`}>
                    {Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                : <Pill tone={DOC_STATUS[d.status]?.tone}>{DOC_STATUS[d.status]?.label}</Pill>}</td>
              <td>{d.fileId ? <span className="row" style={{ gap: 6 }}>
                <Icon name={fileIcon(d.fileName ?? '')} />
                <a href={`/api/files/${d.fileId}/download`}>{d.fileName}</a>
                <OfficeButton projectId={projectId} entry={{ id: d.fileId, name: d.fileName ?? '' }} />
              </span> : <span className="muted">–</span>}</td>
              <td className="small">{fmtDate(d.updatedAt)}<div className="muted">{d.createdByName}</div></td>
              <td className="nowrap">
                {canEdit && <button className="btn ghost sm" title="Neue Version beginnen (Status wird Entwurf)" onClick={async () => { if (await act(() => patch(`/documents/${d.id}`, { newVersion: true }), `Version ${d.version + 1} begonnen`)) reload(); }}><Icon name="repeat" /></button>}
                {canManage && <button className="btn ghost sm" title="Aus dem Register entfernen" onClick={() => setRemove(d)}><Icon name="trash" /></button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {create && <CreateDocument projectId={projectId} onClose={() => setCreate(false)} />}
      {remove && <Confirm danger text={`Dokument ${remove.number} aus dem Register entfernen? Die Datei bleibt im Projektordner erhalten.`} onClose={() => setRemove(null)}
        onConfirm={async () => { await act(() => del(`/documents/${remove.id}`), 'Entfernt'); reload(); }} />}
    </div>
  );
}

function CreateDocument({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { data: templates } = useApi<Template[]>('/document-templates');
  const [d, setD] = useState({ title: '', kind: 'Protokoll', description: '', templateId: '' });
  const act = useAction();
  const active = (templates ?? []).filter((t) => t.active);
  return (
    <Modal title="Neues Dokument" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.title.trim()} onClick={async () => {
        const r = await act(() => post<{ number: string }>(`/projects/${projectId}/documents`, { ...d, templateId: d.templateId || null }), 'Dokument angelegt');
        if (r) { invalidate(`/projects/${projectId}/documents`); onClose(); }
      }}>Anlegen</button>
    </>}>
      <Field label="Titel" required><input autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="z. B. Abnahmeprotokoll Werk 2" /></Field>
      <div className="grid2">
        <Field label="Art">
          <input list="doc-kinds" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })} />
          <datalist id="doc-kinds">{DOC_KINDS.map((k) => <option key={k} value={k} />)}</datalist>
        </Field>
        <Field label="Vorlage" hint="Nummer, Titel, Projekt und Datum werden in die Datei eingetragen">
          <select value={d.templateId} onChange={(e) => {
            const t = active.find((x) => x.id === e.target.value);
            setD({ ...d, templateId: e.target.value, kind: t && d.kind === 'Protokoll' ? t.kind : d.kind });
          }}>
            <option value="">– nur Registereintrag, ohne Datei –</option>
            {active.map((t) => <option key={t.id} value={t.id}>{t.name} (.{t.ext})</option>)}
          </select>
        </Field>
      </div>
      <Field label="Beschreibung"><textarea rows={3} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      <div className="hint">Die Dokumentnummer wird automatisch vergeben. Die Datei landet im Projektordner unter „03_Doku“.</div>
    </Modal>
  );
}

/** Einstellungen → Dokumentvorlagen (Administrator) */
export function DocumentTemplateSettings() {
  const { data, reload } = useApi<Template[]>('/document-templates');
  const [up, setUp] = useState<{ name: string; kind: string; file: File | null } | null>(null);
  const act = useAction();
  return (
    <div>
      <div className="page-head"><div className="grow"><h1>Dokumentvorlagen</h1>
        <div className="sub">Word-, Excel-, PowerPoint- und OpenDocument-Vorlagen. Platzhalter wie <code>{'{{Dokumentnummer}}'}</code>, <code>{'{{Titel}}'}</code>, <code>{'{{Projektnummer}}'}</code>, <code>{'{{Projektname}}'}</code>, <code>{'{{Kunde}}'}</code>, <code>{'{{Datum}}'}</code>, <code>{'{{Ersteller}}'}</code>, <code>{'{{Version}}'}</code> und <code>{'{{Firma}}'}</code> werden beim Anlegen ausgefüllt.</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setUp({ name: '', kind: 'Sonstiges', file: null })}><Icon name="upload" /> Vorlage hochladen</button></div>
      </div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Name</th><th>Art</th><th>Typ</th><th>Herkunft</th><th>Aktiv</th><th /></tr></thead>
        <tbody>{data?.map((t) => (
          <tr key={t.id}>
            <td><b>{t.name}</b></td><td>{t.kind}</td><td className="mono">.{t.ext}</td><td className="muted">{t.builtinKey ? 'mitgeliefert' : 'hochgeladen'}</td>
            <td><input type="checkbox" checked={t.active} onChange={async (e) => { await act(() => patch(`/document-templates/${t.id}`, { active: e.target.checked })); reload(); }} /></td>
            <td className="nowrap">
              <a className="btn ghost sm" title="Vorlage herunterladen" href={`/api/document-templates/${t.id}/download`}><Icon name="download" /></a>
              {!t.builtinKey && <button className="btn ghost sm" title="Löschen" onClick={async () => { await act(() => del(`/document-templates/${t.id}`), 'Vorlage gelöscht'); reload(); }}><Icon name="trash" /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {up && (
        <Modal title="Vorlage hochladen" onClose={() => setUp(null)} footer={<>
          <button className="btn" onClick={() => setUp(null)}>Abbrechen</button>
          <button className="btn primary" disabled={!up.file} onClick={async () => {
            const f = new FormData(); f.append('name', up.name); f.append('kind', up.kind); f.append('file', up.file!);
            if (await act(() => post('/document-templates', f), 'Vorlage gespeichert')) { setUp(null); reload(); }
          }}>Hochladen</button>
        </>}>
          <Field label="Datei" required><input type="file" accept=".docx,.dotx,.xlsx,.xltx,.pptx,.odt,.ods,.odp" onChange={(e) => setUp({ ...up, file: e.target.files?.[0] ?? null, name: up.name || (e.target.files?.[0]?.name.replace(/\.[^.]+$/, '') ?? '') })} /></Field>
          <div className="grid2">
            <Field label="Name"><input value={up.name} onChange={(e) => setUp({ ...up, name: e.target.value })} /></Field>
            <Field label="Art"><input list="doc-kinds-admin" value={up.kind} onChange={(e) => setUp({ ...up, kind: e.target.value })} /><datalist id="doc-kinds-admin">{DOC_KINDS.map((k) => <option key={k} value={k} />)}</datalist></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
