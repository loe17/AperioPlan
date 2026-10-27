import { useState } from 'react';
import { PROJECT_MODULES } from '@aperio/shared';
import { patch, put, invalidate } from '../lib/api';
import { useSession } from '../session';
import { Avatar, Field, useAction } from '../components/ui';
import { EntityIcon, Icon, IconPicker } from '../components/Icon';

export const MODULE_LABELS: Record<string, { label: string; icon: string }> = {
  kanban: { label: 'Kanban-Board', icon: 'projects' },
  list: { label: 'Aufgabenliste', icon: 'list' },
  gantt: { label: 'Gantt-Diagramm', icon: 'chart' },
  whiteboard: { label: 'Whiteboard', icon: 'whiteboard' },
  report: { label: 'Abschlussbericht', icon: 'report' },
  files: { label: 'Dateien', icon: 'folder' },
  cad: { label: 'CAD-Dateien', icon: 'cad' },
  chat: { label: 'Chat', icon: 'chat' },
  time: { label: 'Zeiterfassung', icon: 'timer' },
};

export const STATUS_OPTIONS = [
  ['planned', 'Geplant'], ['active', 'Aktiv'], ['paused', 'Pausiert'], ['done', 'Abgeschlossen'], ['archived', 'Archiviert'],
] as const;

export function ProjectSettings({ project }: { project: any }) {
  const { teams, users } = useSession();
  const act = useAction();
  const [p, setP] = useState({ ...project });
  const [members, setMembers] = useState<{ userId: string; role: string }[]>(project.members.map((m: any) => ({ userId: m.userId, role: m.role })));
  const [addUser, setAddUser] = useState('');
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setP({ ...p, [k]: e.target.value });
  const mods: string[] = p.modules;
  const moveMod = (m: string, dir: -1 | 1) => {
    const i = mods.indexOf(m);
    const j = i + dir;
    if (j < 0 || j >= mods.length) return;
    const n = [...mods];
    [n[i], n[j]] = [n[j]!, n[i]!];
    setP({ ...p, modules: n });
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ marginBottom: 14 }}>Allgemein</h2>
      <div className="grid2">
        <Field label="Name" required><input value={p.name} onChange={set('name')} /></Field>
        <Field label="Symbol"><IconPicker value={p.icon} onChange={(icon) => setP({ ...p, icon })} /></Field>
        <Field label="Status"><select value={p.status} onChange={set('status')}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Team / Abteilung"><select value={p.teamId ?? ''} onChange={set('teamId')}><option value="">–</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="Sichtbarkeit">
          <select value={p.visibility} onChange={set('visibility')}>
            <option value="company">Ganze Firma</option><option value="team">Nur Team</option><option value="members">Nur Projektmitglieder</option>
          </select>
        </Field>
        <Field label="Kunde"><input value={p.customer} onChange={set('customer')} /></Field>
        <Field label="Start"><input type="date" value={p.startDate ?? ''} onChange={set('startDate')} /></Field>
        <Field label="Ende"><input type="date" value={p.dueDate ?? ''} onChange={set('dueDate')} /></Field>
      </div>
      <Field label="Beschreibung"><textarea value={p.description} onChange={set('description')} /></Field>

      <h2 style={{ margin: '20px 0 10px' }}>Werkzeuge in diesem Projekt</h2>
      <div className="card flat" style={{ padding: 8 }}>
        {[...mods, ...PROJECT_MODULES.filter((m) => !mods.includes(m))].map((m) => {
          const on = mods.includes(m);
          return (
            <div key={m} className="row" style={{ padding: '4px 6px' }}>
              <input type="checkbox" checked={on} onChange={() => setP({ ...p, modules: on ? mods.filter((x) => x !== m) : [...mods, m] })} />
              <span className="row" style={{ gap: 6 }}><Icon name={MODULE_LABELS[m]?.icon ?? 'square'} /> {MODULE_LABELS[m]?.label}</span>
              {on && <span className="right row" style={{ gap: 4 }}><button className="btn ghost sm" onClick={() => moveMod(m, -1)}>↑</button><button className="btn ghost sm" onClick={() => moveMod(m, 1)}>↓</button></span>}
            </div>
          );
        })}
      </div>
      <div className="spacer" />
      <button className="btn primary" onClick={async () => {
        await act(() => patch(`/projects/${project.id}`, {
          name: p.name, icon: p.icon, status: p.status, teamId: p.teamId || null, visibility: p.visibility, customer: p.customer,
          startDate: p.startDate || null, dueDate: p.dueDate || null, description: p.description, modules: p.modules,
        }), 'Projekt gespeichert');
        invalidate('/projects');
      }}>Speichern</button>

      <h2 style={{ margin: '28px 0 10px' }}>Mitglieder</h2>
      <div className="table-wrap"><table className="table"><tbody>
        {members.map((m) => {
          const u = users.find((x) => x.id === m.userId);
          return (
            <tr key={m.userId}>
              <td><span className="row" style={{ gap: 6 }}><Avatar id={m.userId} name={u?.displayName} />{u?.displayName ?? m.userId}</span></td>
              <td style={{ width: 200 }}>
                <select value={m.role} onChange={(e) => setMembers(members.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value } : x)))}>
                  <option value="owner">Verantwortlich</option><option value="member">Mitarbeit</option><option value="viewer">Nur lesen</option>
                </select>
              </td>
              <td style={{ width: 60 }}><button className="btn ghost sm" onClick={() => setMembers(members.filter((x) => x.userId !== m.userId))}><Icon name="x" /></button></td>
            </tr>
          );
        })}
      </tbody></table></div>
      <div className="row" style={{ marginTop: 10 }}>
        <select value={addUser} onChange={(e) => setAddUser(e.target.value)} style={{ maxWidth: 300 }}>
          <option value="">Mitarbeiter hinzufügen …</option>
          {users.filter((u) => !members.some((m) => m.userId === u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
        </select>
        <button className="btn" disabled={!addUser} onClick={() => { setMembers([...members, { userId: addUser, role: 'member' }]); setAddUser(''); }}>Hinzufügen</button>
        <button className="btn primary right" onClick={async () => { await act(() => put(`/projects/${project.id}/members`, { members }), 'Mitglieder gespeichert'); invalidate(`/projects/${project.id}`); }}>Mitglieder speichern</button>
      </div>
      <p className="hint">Externe Partner (Kunden, Lieferanten) erhalten Zugang über Gastlinks im Bereich „Dateien“.</p>
    </div>
  );
}
