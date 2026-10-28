import { useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { Avatar } from './ui';

export interface MentionUser { id: string; displayName: string; username: string }

/**
 * Textfeld mit @-Erwähnung: Beim Tippen von @ erscheint eine Auswahl der Kollegen
 * (nach Name oder Benutzername gefiltert). Eingefügt wird @benutzername.
 */
export function MentionInput({ value, onChange, users, onSubmit, ...rest }: {
  value: string; onChange: (v: string) => void; users: MentionUser[]; onSubmit?: () => void;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onSubmit'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return users.filter((u) => u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)).slice(0, 8);
  }, [query, users]);

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
    if (m) { setQuery({ start: caret - m[2]!.length - 1, text: m[2]! }); setActive(0); } else setQuery(null);
  };

  const pick = (u: MentionUser) => {
    if (!query) return;
    const el = ref.current!;
    const caret = el.selectionStart;
    const next = `${value.slice(0, query.start)}@${u.username} ${value.slice(caret)}`;
    onChange(next);
    setQuery(null);
    const pos = query.start + u.username.length + 2;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    rest.onKeyDown?.(e);
    if (!e.defaultPrevented && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit) { e.preventDefault(); onSubmit(); }
  };

  return (
    <div className="mention-wrap">
      <textarea ref={ref} {...rest} value={value} onKeyDown={onKey}
        onChange={(e) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onClick={(e) => detect(value, (e.target as HTMLTextAreaElement).selectionStart)} />
      {query && matches.length > 0 && (
        <div className="mention-list" role="listbox">
          {matches.map((u, i) => (
            <div key={u.id} role="option" aria-selected={i === active} className={`item ${i === active ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(u); }}>
              <Avatar id={u.id} name={u.displayName} /> <span>{u.displayName}</span> <span className="muted small">@{u.username}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
