import { useMemo, useState } from 'react';
import { Avatar } from './ui';
import { Icon } from './Icon';

/** Mehrere Personen auswählen: gewählte als Chips, weitere über ein Suchfeld */
export function UserPicker({ users, value, onChange, preferred = [], placeholder = 'Person hinzufügen …' }: {
  users: { id: string; displayName: string; username?: string }[]; value: string[]; onChange: (ids: string[]) => void;
  preferred?: string[]; placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const options = useMemo(() => {
    const s = q.toLowerCase();
    return users
      .filter((u) => !value.includes(u.id) && (!s || u.displayName.toLowerCase().includes(s) || (u.username ?? '').toLowerCase().includes(s)))
      .sort((a, b) => Number(preferred.includes(b.id)) - Number(preferred.includes(a.id)) || a.displayName.localeCompare(b.displayName, 'de'))
      .slice(0, 10);
  }, [users, value, q, preferred]);
  return (
    <div className="user-picker">
      <div className="chips">
        {value.map((id) => {
          const u = byId.get(id);
          return <span key={id} className="chip"><Avatar id={id} name={u?.displayName ?? '?'} /> {u?.displayName ?? 'Unbekannt'}
            <button type="button" className="chip-x" aria-label="Entfernen" onClick={() => onChange(value.filter((x) => x !== id))}><Icon name="x" size={12} /></button></span>;
        })}
        <input value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      </div>
      {open && options.length > 0 && (
        <div className="mention-list">
          {options.map((u) => <div key={u.id} className="item" onMouseDown={(e) => { e.preventDefault(); onChange([...value, u.id]); setQ(''); }}>
            <Avatar id={u.id} name={u.displayName} /> {u.displayName}{preferred.includes(u.id) && <span className="muted small"> · im Projekt</span>}
          </div>)}
        </div>
      )}
    </div>
  );
}
