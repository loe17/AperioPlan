import { useState } from 'react';
import { post, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { fmtDate } from '../lib/format';
import { Empty, Field, Modal, useAction } from '../components/ui';

/** Allgemeine Dokumente mit lesbaren Nummern (0100-DOK-001_Projektplan) */
export function Documents({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data } = useApi<any[]>(`/projects/${projectId}/documents`);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const act = useAction();
  return (
    <div>
      <div className="toolbar">
        <span className="muted">Schriftverkehr, Verträge, Berichte – jedes Dokument erhält eine fortlaufende Nummer.</span>
        {canEdit && <button className="btn primary right" onClick={() => setOpen(true)}>＋ Dokument anlegen</button>}
      </div>
      {!data?.length ? <Empty icon="📄" title="Noch keine Dokumente" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nummer</th><th>Titel</th><th>Datei</th><th>Angelegt</th><th>von</th></tr></thead>
          <tbody>{data.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.number}</td><td>{d.title}</td>
              <td>{d.fileId ? <a href={`/api/files/${d.fileId}/download`}>{d.fileName}</a> : <span className="muted">–</span>}</td>
              <td>{fmtDate(d.createdAt)}</td><td>{d.createdByName}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open && (
        <Modal title="Dokument anlegen" onClose={() => setOpen(false)} footer={<>
          <button className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
          <button className="btn primary" disabled={!title.trim()} onClick={async () => {
            const r = await act(() => post(`/projects/${projectId}/documents`, { title }));
            if (r) { setOpen(false); setTitle(''); invalidate(`/projects/${projectId}/documents`); }
          }}>Anlegen</button>
        </>}>
          <Field label="Titel" required hint="Die Nummer wird automatisch vergeben, z. B. 0100-DOK-004"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  );
}
