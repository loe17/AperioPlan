import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { colorFor, initials } from '../lib/format';
import { useT } from '../i18n';
import { Icon } from './Icon';

// ---------------------------------------------------------------- Toasts
interface Toast { id: number; text: string; kind: 'info' | 'error' }
const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastToast = useRef(0);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    lastToast.current = Date.now();
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  // Jede Speicherung bekommt eine Rückmeldung – außer die Aktion hat schon selbst eine gezeigt
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ ok: boolean; message?: string; startedAt: number }>).detail;
      setTimeout(() => {
        if (lastToast.current >= d.startedAt) return;
        if (d.ok) push('Gespeichert');
        else push(`Nicht gespeichert: ${d.message ?? 'unbekannter Fehler'}`, 'error');
      }, 80);
    };
    window.addEventListener('aperio:saved', h);
    return () => window.removeEventListener('aperio:saved', h);
  }, [push]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : 'ok'}`} role={t.kind === 'error' ? 'alert' : 'status'}><Icon name={t.kind === 'error' ? 'alert' : 'check-circle'} /> <span>{t.text}</span></div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Führt eine Aktion aus und zeigt Fehler als Toast */
export function useAction() {
  const toast = useToast();
  return useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      toast((e as Error).message, 'error');
      return undefined;
    }
  }, [toast]);
}

// ---------------------------------------------------------------- Overlays
function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

export function Modal({ title, onClose, children, footer, size }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'lg' }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${size ?? ''}`} role="dialog">
        <div className="modal-head"><h2 className="grow">{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="x" /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

/** Detail-Fenster, das von rechts hereingleitet (Kaneo-Stil). Klick daneben schließt. */
export function SlideOver({ title, onClose, children, actions, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <aside className={`slideover ${wide ? 'wide' : ''}`}>
        <div className="slideover-head">
          <div className="grow" style={{ minWidth: 0 }}>{title}</div>
          {actions}
          <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="x" /></button>
        </div>
        <div className="slideover-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

export function Confirm({ text, onConfirm, onClose, danger, confirmLabel }: { text: ReactNode; onConfirm: () => void | Promise<void>; onClose: () => void; danger?: boolean; confirmLabel?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('Bitte bestätigen')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('Abbrechen')}</button>
      <button className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>
        {confirmLabel ?? t('Ja')}
      </button>
    </>}>
      {text}
    </Modal>
  );
}

export function Dropdown({ trigger, children, align = 'right' }: { trigger: (toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className="dropdown" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Kleinteile
export function Avatar({ id, name, size }: { id?: string | null; name?: string | null; size?: 'lg' }) {
  return <span className={`avatar ${size ?? ''}`} style={{ background: colorFor(id ?? name) }} title={name ?? ''}>{initials(name)}</span>;
}

export function Empty({ icon = 'inbox', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="big"><Icon name={icon} size={36} strokeWidth={1.5} /></div><div style={{ fontWeight: 550, color: 'var(--text-2)' }}>{title}</div>{children && <div style={{ marginTop: 8 }}>{children}</div>}</div>;
}

export function Loading() {
  const t = useT();
  return <div className="empty">{t('Wird geladen …')}</div>;
}

export function ErrorBox({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{error.message}</div>;
}

export function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}{required && <span className="req"> *</span>}</span>
      {children}
      {hint && <div className="hint" style={{ marginTop: 3 }}>{hint}</div>}
    </label>
  );
}

export const STATUS_META: Record<string, { label: string; tone: string }> = {
  todo: { label: 'Zu erledigen', tone: 'amber' },
  in_progress: { label: 'In Arbeit', tone: 'blue' },
  review: { label: 'Prüfung', tone: 'accent' },
  done: { label: 'Fertig', tone: 'green' },
};
export const PRIORITY_META: Record<string, { label: string; tone: string }> = {
  low: { label: 'Niedrig', tone: '' },
  normal: { label: 'Normal', tone: '' },
  high: { label: 'Hoch', tone: 'amber' },
  urgent: { label: 'Dringend', tone: 'red' },
};
export const CAD_STATE_META: Record<string, { label: string; tone: string }> = {
  in_work: { label: 'In Arbeit', tone: 'amber' },
  review: { label: 'Prüfung', tone: 'blue' },
  released: { label: 'Freigegeben', tone: 'green' },
  obsolete: { label: 'Ungültig', tone: 'red' },
};
export const REQUEST_META: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Offen', tone: 'amber' },
  approved: { label: 'Genehmigt', tone: 'green' },
  rejected: { label: 'Abgelehnt', tone: 'red' },
  cancelled: { label: 'Storniert', tone: '' },
};

export function Pill({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${STATUS_META[status]?.tone ?? ''}`} />;
}

export function StatusPill({ status, meta = STATUS_META }: { status: string; meta?: Record<string, { label: string; tone: string }> }) {
  const t = useT();
  const m = meta[status] ?? { label: status, tone: '' };
  return <Pill tone={m.tone}>{t(m.label)}</Pill>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  // Passen nicht alle Reiter in die Breite, wandern die übrigen in ein Menü „Mehr“ – kein Rollbalken.
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(tabs.length);
  const [open, setOpen] = useState(false);
  const key = tabs.map((t) => t.id).join('|');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const buttons = [...el.querySelectorAll<HTMLElement>('[data-tab-measure]')];
      const avail = el.clientWidth - 96;
      let used = 0; let n = 0;
      for (const b of buttons) { used += b.offsetWidth + 2; if (used > avail && n > 0) break; n++; }
      const total = buttons.reduce((sum, b) => sum + b.offsetWidth + 2, 0);
      setVisible(total <= el.clientWidth ? buttons.length : n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  const shown = tabs.slice(0, visible);
  const more = tabs.slice(visible);
  const activeHidden = more.find((t) => t.id === value);
  return (
    <div className="tabs" ref={ref}>
      <div className="tabs-measure" aria-hidden>{tabs.map((tb) => <span key={tb.id} data-tab-measure className="tab">{tb.label}</span>)}</div>
      {shown.map((tb) => <button key={tb.id} className={`tab ${value === tb.id ? 'active' : ''}`} onClick={() => onChange(tb.id)}>{tb.label}</button>)}
      {more.length > 0 && (
        <div className="tabs-more">
          <button className={`tab ${activeHidden ? 'active' : ''}`} onClick={() => setOpen(!open)}>{activeHidden ? activeHidden.label : 'Mehr'} <Icon name="chevron-down" size={14} /></button>
          {open && <>
            <div className="overlay transparent" onClick={() => setOpen(false)} />
            <div className="dropdown-menu">
              {more.map((tb) => <div key={tb.id} className={`item ${value === tb.id ? 'active' : ''}`} onClick={() => { setOpen(false); onChange(tb.id); }}>{tb.label}</div>)}
            </div>
          </>}
        </div>
      )}
    </div>
  );
}

export function UserSelect({ users, value, onChange, placeholder = '– niemand –', allowEmpty = true }: {
  users: { id: string; displayName: string }[] | undefined; value: string | null; onChange: (v: string | null) => void; placeholder?: string; allowEmpty?: boolean;
}) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {users?.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
    </select>
  );
}

export function Progress({ value }: { value: number }) {
  return <div className="progress"><div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} /></div>;
}
