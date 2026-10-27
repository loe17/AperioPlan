import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { STATUS_META, CAD_STATE_META } from './ui';

interface Item { group: string; icon: string; label: string; meta?: string; go: () => void }

/** Globale Blitzsuche (Strg + K) – zwei Buchstaben genügen */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const { setTheme } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setResults(null); return; }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      get(`/search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => {});
    }, 120);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [q]);

  const go = (path: string) => () => { onClose(); nav(path); };

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const commands: Item[] = [
      { group: 'Befehle', icon: '🚀', label: t('Neues Projekt'), go: go('/projects?new=1') },
      { group: 'Befehle', icon: '⏱️', label: t('Stempeluhr'), go: go('/time') },
      { group: 'Befehle', icon: '🏖️', label: t('Urlaub beantragen'), go: go('/absences?new=1') },
      { group: 'Befehle', icon: '💡', label: t('Neue Idee'), go: go('/kvp?new=1') },
      { group: 'Befehle', icon: '📐', label: t('CAD-Zentrale'), go: go('/cad') },
      { group: 'Befehle', icon: '💬', label: t('Chat'), go: go('/chat') },
      { group: 'Befehle', icon: '⚙️', label: t('Einstellungen'), go: go('/settings') },
      { group: 'Befehle', icon: '🌙', label: t('Dunkelmodus'), go: () => { setTheme('dark'); onClose(); } },
      { group: 'Befehle', icon: '☀️', label: t('Hellmodus'), go: () => { setTheme('light'); onClose(); } },
    ];
    const ql = q.trim().toLowerCase();
    out.push(...commands.filter((c) => !ql || c.label.toLowerCase().includes(ql)));
    if (results) {
      for (const p of results.projects) out.push({ group: 'Projekte', icon: p.icon, label: `${p.number} ${p.name}`, go: go(`/projects/${p.id}`) });
      for (const tk of results.tasks) out.push({ group: 'Aufgaben', icon: STATUS_META[tk.status]?.ico ?? '•', label: `P${tk.number} ${tk.title}`, meta: tk.projectNumber, go: go(`/projects/${tk.projectId}?task=${tk.id}`) });
      for (const c of results.cad) out.push({ group: 'Baugruppen & Teile', icon: c.type === 'assembly' ? '🧩' : c.type === 'drawing' ? '📄' : '⚙️', label: `${c.baseNumber}-${String(c.revision).padStart(2, '0')} ${c.designation}`, meta: CAD_STATE_META[c.state]?.label, go: go(`/cad?item=${c.id}`) });
      for (const f of results.files) out.push({ group: 'Dateien', icon: '📄', label: f.name, meta: f.path.split('/').slice(-2, -1)[0], go: go(`/projects/${f.projectId}?tab=files&path=${encodeURIComponent(f.path.split('/').slice(0, -1).join('/'))}`) });
      for (const u of results.users) out.push({ group: 'Mitarbeiter', icon: '👤', label: u.displayName, meta: u.email ?? u.username, go: go(`/chat?user=${u.id}`) });
      for (const k of results.kvp) out.push({ group: 'KVP-Ideen', icon: '💡', label: `#${k.number} ${k.title}`, go: go(`/kvp?idea=${k.id}`) });
    }
    return out;
  }, [results, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setSel(0); }, [items.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.go(); }
    else if (e.key === 'Escape') onClose();
  };

  let lastGroup = '';
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className="palette">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          placeholder="Projekt, Baugruppe, Aufgabe oder Mitarbeiter suchen …" />
        <div className="palette-list">
          {items.length === 0 && <div className="muted" style={{ padding: 14 }}>Keine Treffer</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{t(it.group)}</div> : null;
            lastGroup = it.group;
            return (
              <div key={i}>
                {head}
                <div className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={it.go}>
                  <span>{it.icon}</span><span>{it.label}</span>{it.meta && <span className="meta">{it.meta}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="row small muted" style={{ padding: '6px 14px', borderTop: '1px solid var(--line)' }}>
          <span><kbd>↑</kbd> <kbd>↓</kbd> auswählen</span><span><kbd>Enter</kbd> öffnen</span><span><kbd>Esc</kbd> schließen</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
