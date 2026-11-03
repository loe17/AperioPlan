import { useEffect, useRef, useState } from 'react';

/** Einfache Diagramme (SVG): Balken senkrecht/waagrecht, Linie. Farben über --viz-1 … --viz-8 (hell/dunkel). */
export type ChartData = { key: string; values: number[] }[];
type Props = { kind: 'bar' | 'hbar' | 'line'; rows: ChartData; series: string[]; format: (v: number) => string; unit?: string; height?: number };

const color = (i: number) => `var(--viz-${(i % 8) + 1})`;
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

export function Chart({ kind, rows, series, format, unit = '', height = 280 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  // in echter Breite zeichnen, damit Schrift nicht mitskaliert
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const [tip, setTip] = useState<{ x: number; y: number; i: number } | null>(null);
  const names = series.length ? series : [''];
  if (!rows.length) return <div className="muted small" style={{ padding: 20 }}>Keine Daten im gewählten Zeitraum.</div>;
  const max = niceMax(Math.max(0, ...rows.flatMap((r) => r.values)));
  const min = Math.min(0, ...rows.flatMap((r) => r.values));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * (max - min));
  const span = max - min;
  const axis = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: span < 0.1 ? 3 : span < 10 ? 2 : span < 100 ? 1 : 0 })}${unit ? ` ${unit}` : ''}`;
  const move = (e: React.MouseEvent, i: number) => { const b = wrap.current!.getBoundingClientRect(); setTip({ x: e.clientX - b.left, y: e.clientY - b.top, i }); };
  const legend = series.length > 1 && <div className="viz-legend">{series.map((s, i) => <span key={s}><i style={{ background: color(i) }} />{s}</span>)}</div>;
  const tooltip = tip && rows[tip.i] && (
    <div className="viz-tip" style={{ left: Math.min(tip.x + 12, (wrap.current?.clientWidth ?? 400) - 180), top: tip.y + 12 }}>
      <b>{rows[tip.i]!.key}</b>
      {names.map((s, k) => <div key={k} className="row" style={{ gap: 6 }}>{series.length > 1 && <i className="sw" style={{ background: color(k) }} />}<span className="grow">{s}</span><b>{format(rows[tip.i]!.values[k] ?? 0)}</b></div>)}
    </div>
  );

  if (kind === 'hbar') {
    const bh = series.length > 1 ? 10 : 16;
    const rowH = Math.max(26, names.length * (bh + 2) + 10);
    const labelW = Math.min(170, Math.round(width * 0.32));
    const W = width;
    const plotW = W - labelW - 80;
    const x = (v: number) => labelW + ((v - min) / (max - min || 1)) * plotW;
    return (
      <div className="viz" ref={wrap} onMouseLeave={() => setTip(null)}>
        {legend}
        <svg viewBox={`0 0 ${W} ${rows.length * rowH + 8}`} width={W} height={rows.length * rowH + 8} role="img">
          {rows.map((r, i) => (
            <g key={r.key} transform={`translate(0 ${i * rowH})`} onMouseMove={(e) => move(e, i)}>
              <rect x={0} y={0} width={W} height={rowH} fill="transparent" />
              <text x={labelW - 8} y={rowH / 2 + 4} textAnchor="end" className="viz-label">{r.key.length > 26 ? `${r.key.slice(0, 25)}…` : r.key}</text>
              {r.values.map((v, k) => {
                const y = (rowH - names.length * (bh + 2)) / 2 + k * (bh + 2);
                const x0 = x(Math.min(0, v)), x1 = x(Math.max(0, v));
                return <rect key={k} x={x0} y={y} width={Math.max(1, x1 - x0)} height={bh} rx={3} fill={color(k)} />;
              })}
              {names.length === 1 && <text x={x(Math.max(0, r.values[0] ?? 0)) + 6} y={rowH / 2 + 4} className="viz-value">{format(r.values[0] ?? 0)}</text>}
            </g>
          ))}
        </svg>
        {tooltip}
      </div>
    );
  }

  const W = width, H = height, L = 64, B = 44, T = 10, R = 12;
  const plotW = W - L - R, plotH = H - T - B;
  const y = (v: number) => T + plotH - ((v - min) / (max - min || 1)) * plotH;
  const step = plotW / rows.length;
  const every = Math.ceil(rows.length / 12);
  return (
    <div className="viz" ref={wrap} onMouseLeave={() => setTip(null)}>
      {legend}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="viz-grid" /><text x={L - 6} y={y(t) + 4} textAnchor="end" className="viz-axis">{axis(t)}</text></g>)}
        {rows.map((r, i) => i % every === 0 && <text key={r.key} x={L + step * (i + 0.5)} y={H - B + 16} textAnchor="middle" className="viz-axis">{r.key.length > 12 ? `${r.key.slice(0, 11)}…` : r.key}</text>)}
        {kind === 'bar' && rows.map((r, i) => {
          const gw = Math.min(step * 0.72, 18 * names.length + 2 * names.length);
          const bw = (gw - 2 * (names.length - 1)) / names.length;
          return r.values.map((v, k) => {
            const top = y(Math.max(0, v)), bot = y(Math.min(0, v));
            return <rect key={`${i}-${k}`} x={L + step * i + (step - gw) / 2 + k * (bw + 2)} y={top} width={Math.max(1, bw)} height={Math.max(1, bot - top)} rx={Math.min(4, bw / 2)} fill={color(k)} />;
          });
        })}
        {kind === 'line' && names.map((_, k) => (
          <g key={k}>
            <polyline fill="none" stroke={color(k)} strokeWidth={2} strokeLinejoin="round" points={rows.map((r, i) => `${L + step * (i + 0.5)},${y(r.values[k] ?? 0)}`).join(' ')} />
            {rows.length <= 40 && rows.map((r, i) => <circle key={i} cx={L + step * (i + 0.5)} cy={y(r.values[k] ?? 0)} r={tip?.i === i ? 5 : 3} fill={color(k)} stroke="var(--card)" strokeWidth={2} />)}
          </g>
        ))}
        {kind === 'line' && tip && <line x1={L + step * (tip.i + 0.5)} x2={L + step * (tip.i + 0.5)} y1={T} y2={T + plotH} className="viz-cross" />}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="viz-base" />
        {rows.map((r, i) => <rect key={`h${i}`} x={L + step * i} y={T} width={step} height={plotH} fill="transparent" onMouseMove={(e) => move(e, i)} />)}
      </svg>
      {tooltip}
    </div>
  );
}
