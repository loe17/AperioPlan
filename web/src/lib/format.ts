const locale = () => (document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE');

export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
export const fmtTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '–';
export const fmtHours = (h: number | null | undefined) => (h == null ? '–' : `${h.toLocaleString(locale(), { maximumFractionDigits: 1 })} Std.`);
export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toLocaleString(locale(), { maximumFractionDigits: 1 })} ${u[i]}`;
};
export const fmtEuro = (n: number | null | undefined) =>
  n == null ? '–' : n.toLocaleString(locale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** relative Fälligkeit: "Heute", "Morgen", "in 3 Tagen", "überfällig" */
export function relDue(d: string | null | undefined): { text: string; tone: '' | 'red' | 'amber' } {
  if (!d) return { text: '', tone: '' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(d); due.setHours(0, 0, 0, 0);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: `überfällig (${fmtDate(d)})`, tone: 'red' };
  if (diff === 0) return { text: 'Heute', tone: 'amber' };
  if (diff === 1) return { text: 'Morgen', tone: 'amber' };
  if (diff < 7) return { text: `in ${diff} Tagen`, tone: '' };
  return { text: fmtDate(d), tone: '' };
}

export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const COLORS = ['#4f46e5', '#0e9f6e', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#dc2626', '#65a30d', '#2563eb', '#c2410c'];
export function colorFor(id: string | null | undefined) {
  if (!id) return '#868e96';
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
export const initials = (name: string | null | undefined) =>
  (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('') || '?';
