import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onInvalidate } from './api';

/** Lädt Daten von der API und lädt automatisch neu, wenn invalidate(prefix) aufgerufen wird. */
export function useApi<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    const u = urlRef.current;
    if (!u) return;
    setLoading(true);
    try {
      const d = await api<T>(u);
      if (urlRef.current === u) { setData(d); setError(null); }
    } catch (e) {
      if (urlRef.current === u) setError(e as Error);
    } finally {
      if (urlRef.current === u) setLoading(false);
    }
  }, []);

  useEffect(() => { setData(undefined); void load(); }, [url, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onInvalidate((prefix) => { if (urlRef.current?.startsWith(prefix)) void load(); }), [load]);

  return { data, error, loading, reload: load, setData };
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; }
  });
  const set = useCallback((nv: T) => {
    setV(nv);
    try { localStorage.setItem(key, JSON.stringify(nv)); } catch { /* privat */ }
  }, [key]);
  return [v, set];
}

export function useHotkey(combo: string, fn: (e: KeyboardEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const [mod, key] = combo.includes('+') ? combo.split('+') : ['', combo];
    const h = (e: KeyboardEvent) => {
      const modOk = mod === 'mod' ? e.ctrlKey || e.metaKey : !mod || mod === '';
      if (modOk && e.key.toLowerCase() === key!.toLowerCase()) { e.preventDefault(); ref.current(e); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [combo]);
}
