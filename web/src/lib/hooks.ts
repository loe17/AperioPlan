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

/**
 * Reiter-Auswahl, die sich merkt, wo man zuletzt war: steht in der Adresszeile (?tab=…)
 * und zusätzlich im Browser, damit man beim Zurückkehren wieder am selben Reiter landet.
 */
export function useTabState<T extends string>(key: string, fallback: T, param = 'tab'): [T, (v: T) => void] {
  const read = (): T => {
    const fromUrl = new URLSearchParams(location.search).get(param);
    if (fromUrl) return fromUrl as T;
    try { return (localStorage.getItem(`aperio-tab:${key}`) as T) || fallback; } catch { return fallback; }
  };
  const [v, setV] = useState<T>(read);
  useEffect(() => { setV(read()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((nv: T) => {
    setV(nv);
    try { localStorage.setItem(`aperio-tab:${key}`, nv); } catch { /* privat */ }
    const u = new URL(location.href);
    u.searchParams.set(param, nv);
    history.replaceState(history.state, '', u.toString());
  }, [key, param]);
  return [v, set];
}

/** Zuletzt gewählter Wert eines Schlüssels (z. B. letzter Projekt-Reiter), ohne Zustand */
export const rememberedTab = (key: string): string | null => { try { return localStorage.getItem(`aperio-tab:${key}`); } catch { return null; } };
export const rememberTab = (key: string, v: string) => { try { localStorage.setItem(`aperio-tab:${key}`, v); } catch { /* privat */ } };
