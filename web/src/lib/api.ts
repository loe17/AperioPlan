/** Schmale Hülle um fetch mit JSON, Fehlermeldungen und Cache-Invalidierung. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

type Listener = (prefix: string) => void;
const listeners = new Set<Listener>();
export const onInvalidate = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Alle offenen Abfragen, deren URL mit prefix beginnt, neu laden */
export const invalidate = (prefix = '/') => listeners.forEach((l) => l(prefix));

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(url: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean } = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    credentials: 'same-origin',
    signal: opts.signal,
  });
  if (res.status === 401 && !url.startsWith('/auth/')) onUnauthorized?.();
  if (!res.ok) {
    let msg = res.statusText;
    let code: string | undefined;
    try { const j = await res.json(); msg = j.error ?? msg; code = j.code; } catch { /* leer */ }
    throw new ApiError(res.status, msg, code);
  }
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const get = <T = any>(url: string) => api<T>(url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>(url, { method: 'POST', body });
export const patch = <T = any>(url: string, body: unknown) => api<T>(url, { method: 'PATCH', body });
export const put = <T = any>(url: string, body: unknown) => api<T>(url, { method: 'PUT', body });
export const del = <T = any>(url: string) => api<T>(url, { method: 'DELETE' });

/** Datei-Upload mit Fortschrittsanzeige */
export function upload(url: string, form: FormData, onProgress?: (p: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${url}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* leer */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(xhr.status, body?.error ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Netzwerkfehler'));
    xhr.send(form);
  });
}
