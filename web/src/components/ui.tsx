import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { colorFor, initials } from '../lib/format';
import { useT } from '../i18n';

// ---------------------------------------------------------------- Toasts
interface Toast { id: number; text: string; kind: 'info' | 'error' }
const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.text}</div>)}
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
        <div className="modal-head"><h2 className="grow">{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Schließen">✕</button></div>
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
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">✕</button>
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

export function Empty({ icon = '📭', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="big">{icon}</div><div style={{ fontWeight: 550, color: 'var(--text-2)' }}>{title}</div>{children && <div style={{ marginTop: 8 }}>{children}</div>}</div>;
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

export const STATUS_META: Record<string, { label: string; tone: string; ico: string }> = {
  todo: { label: 'Zu erledigen', tone: 'amber', ico: '🟡' },
  in_progress: { label: 'In Arbeit', tone: 'blue', ico: '🔵' },
  review: { label: 'Prüfung', tone: 'accent', ico: '🟣' },
  done: { label: 'Fertig', tone: 'green', ico: '🟢' },
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

export function StatusPill({ status, meta = STATUS_META }: { status: string; meta?: Record<string, { label: string; tone: string }> }) {
  const t = useT();
  const m = meta[status] ?? { label: status, tone: '' };
  return <Pill tone={m.tone}>{t(m.label)}</Pill>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs">
      {tabs.map((tb) => <button key={tb.id} className={`tab ${value === tb.id ? 'active' : ''}`} onClick={() => onChange(tb.id)}>{tb.label}</button>)}
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
