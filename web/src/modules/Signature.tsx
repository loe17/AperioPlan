import { useEffect, useRef, useState } from 'react';

export type Stroke = [number, number][];

/** Unterschriftenfeld: mit Finger, Stift oder Maus zeichnen. Liefert Striche mit Koordinaten 0..1 (Seitenverhältnis 3:1). */
export function SignaturePad({ onChange }: { onChange: (strokes: Stroke[]) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawing = useRef<Stroke | null>(null);

  const redraw = (list: Stroke[]) => {
    const c = canvas.current; if (!c) return;
    const g = c.getContext('2d')!;
    const r = c.getBoundingClientRect();
    c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
    g.scale(devicePixelRatio, devicePixelRatio);
    g.clearRect(0, 0, r.width, r.height);
    g.strokeStyle = getComputedStyle(c).color || '#111'; g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of list) {
      g.beginPath();
      s.forEach(([x, y], i) => (i ? g.lineTo(x * r.width, y * r.height) : g.moveTo(x * r.width, y * r.height)));
      if (s.length === 1) g.lineTo(s[0]![0] * r.width + 0.5, s[0]![1] * r.height);
      g.stroke();
    }
  };
  useEffect(() => { redraw(strokes); }, [strokes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const f = () => redraw(strokes); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); });

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  return (
    <div className="sig-pad">
      <canvas ref={canvas}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drawing.current = [pos(e)]; }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = pos(e); const last = drawing.current[drawing.current.length - 1]!;
          if (Math.hypot(p[0] - last[0], (p[1] - last[1]) / 3) < 0.003) return;
          drawing.current.push(p);
          const c = canvas.current!, g = c.getContext('2d')!, r = c.getBoundingClientRect();
          g.beginPath(); g.moveTo(last[0] * r.width, last[1] * r.height); g.lineTo(p[0] * r.width, p[1] * r.height); g.stroke();
        }}
        onPointerUp={() => { if (drawing.current) { const n = [...strokes, drawing.current.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as [number, number])]; drawing.current = null; setStrokes(n); onChange(n); } }} />
      <div className="row small" style={{ justifyContent: 'space-between' }}>
        <span className="muted">Hier unterschreiben</span>
        <button type="button" className="link" onClick={() => { setStrokes([]); onChange([]); }}>Löschen</button>
      </div>
    </div>
  );
}

/** Gespeicherte Unterschrift anzeigen */
export function SignatureView({ strokes, height = 80 }: { strokes: Stroke[]; height?: number }) {
  const w = height * 3;
  return (
    <svg viewBox="0 0 300 100" width={w} height={height} className="sig-view">
      {strokes.map((s, i) => <polyline key={i} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" points={s.map(([x, y]) => `${x * 300},${y * 100}`).join(' ')} />)}
    </svg>
  );
}
