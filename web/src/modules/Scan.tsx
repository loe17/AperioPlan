import { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Modal } from '../components/ui';
import { Icon } from '../components/Icon';

// ---------------------------------------------------------------- Scannen
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
declare global { interface Window { BarcodeDetector?: { new (o?: { formats?: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } } }

/**
 * Barcode/QR scannen: mit der Kamera (Chrome, Edge, Android), sonst Code eintippen.
 * Handscanner funktionieren überall – sie „tippen“ den Code in das Eingabefeld und drücken Enter.
 */
export function ScanModal({ title = 'Scannen', hint, onCode, onClose, keepOpen }: { title?: string; hint?: string; onCode: (code: string) => void | Promise<void>; onClose: () => void; keepOpen?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [manual, setManual] = useState('');
  const [err, setErr] = useState('');
  const [last, setLast] = useState('');
  const supported = typeof window !== 'undefined' && Boolean(window.BarcodeDetector) && Boolean(navigator.mediaDevices?.getUserMedia);
  const busy = useRef(false);
  const lastAt = useRef<{ code: string; t: number }>({ code: '', t: 0 });
  const handle = async (code: string) => {
    const c = code.trim(); if (!c) return;
    // gleiche Codes nicht doppelt hintereinander auslösen
    if (lastAt.current.code === c && Date.now() - lastAt.current.t < 2500) return;
    lastAt.current = { code: c, t: Date.now() };
    setLast(c);
    try { navigator.vibrate?.(60); } catch { /* egal */ }
    await onCode(c);
    if (!keepOpen) onClose();
  };
  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null, raf = 0, stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current!; v.srcObject = stream; await v.play();
        const det = new window.BarcodeDetector!({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'data_matrix', 'upc_a', 'itf'] });
        const tick = async () => {
          if (stop) return;
          if (!busy.current && v.readyState >= 2) {
            busy.current = true;
            try { const r = await det.detect(v); if (r[0]?.rawValue) await handle(r[0].rawValue); } catch { /* nächstes Bild */ }
            busy.current = false;
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch { setErr('Kein Zugriff auf die Kamera. Bitte im Browser erlauben – oder den Code eintippen.'); }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [supported]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={title} onClose={onClose}>
      {supported && !err ? <div className="scan-video"><video ref={video} muted playsInline /><div className="scan-frame" /></div>
        : <p className="muted small">{err || 'Ihr Browser kann nicht mit der Kamera scannen (z. B. Firefox oder Safari). Code eintippen oder einen Handscanner verwenden.'}</p>}
      {hint && <p className="small muted">{hint}</p>}
      <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void handle(manual); setManual(''); }}>
        <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Code eintippen oder Handscanner" />
        <button className="btn primary" disabled={!manual.trim()}>OK</button>
      </form>
      {last && keepOpen && <p className="small muted" style={{ marginTop: 6 }}>Zuletzt erkannt: <span className="mono">{last}</span></p>}
    </Modal>
  );
}

export function ScanButton({ label = 'Scannen', onCode, title, hint, keepOpen, className = 'btn' }: { label?: string; onCode: (code: string) => void | Promise<void>; title?: string; hint?: string; keepOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className={className} onClick={() => setOpen(true)}><Icon name="scan" /> {label}</button>
    {open && <ScanModal title={title} hint={hint} onCode={onCode} onClose={() => setOpen(false)} keepOpen={keepOpen} />}
  </>;
}

// ---------------------------------------------------------------- Etiketten
export interface Label { title: string; subtitle?: string; code: string; qr: string }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function qrSvg(text: string, size = 120) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: Math.max(1, Math.floor(size / (q.getModuleCount() + 2))), margin: 1, scalable: true });
}

/** Etiketten drucken: QR-Code (Link oder Code) plus Klartext; Format wählbar */
export function printLabels(labels: Label[], format: '62x29' | '50x25' | 'a4' = 'a4') {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  const page = format === 'a4' ? '@page { size: A4; margin: 10mm; }' : `@page { size: ${format.replace('x', 'mm ')}mm; margin: 0; }`;
  const cell = format === 'a4' ? 'width: 63mm; height: 33mm; margin: 0 1.5mm 2mm 0; border: 0.2mm dashed #bbb;' : `width: ${format.split('x')[0]}mm; height: ${format.split('x')[1]}mm; page-break-after: always;`;
  const body = labels.map((l) => `<div class="l"><div class="q">${qrSvg(l.qr)}</div><div class="t"><b>${esc(l.title)}</b>${l.subtitle ? `<span>${esc(l.subtitle)}</span>` : ''}<code>${esc(l.code)}</code></div></div>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Etiketten</title><style>
    ${page} body { margin: 0; font-family: system-ui, sans-serif; } .wrap { display: flex; flex-wrap: wrap; }
    .l { ${cell} box-sizing: border-box; display: flex; align-items: center; gap: 2mm; padding: 1.5mm; overflow: hidden; }
    .q { width: 24mm; height: 24mm; flex-shrink: 0; } .q svg { width: 100%; height: 100%; }
    .t { display: flex; flex-direction: column; gap: 0.6mm; min-width: 0; font-size: 8pt; line-height: 1.15; }
    .t b { font-size: 9pt; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; } .t span { color: #555; } .t code { font-size: 10pt; font-weight: 700; }
    @media screen { body { padding: 10px; background: #eee; } .l { background: #fff; } .bar { margin-bottom: 10px; } }
    @media print { .bar { display: none; } }
  </style></head><body><div class="bar"><button onclick="print()">Drucken</button></div><div class="wrap">${body}</div></body></html>`);
  w.document.close();
}

export function LabelButton({ labels, label = 'Etiketten' }: { labels: () => Label[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<'a4' | '62x29' | '50x25'>(() => { try { return (localStorage.getItem('aperio-label-format') as 'a4') ?? 'a4'; } catch { return 'a4'; } });
  return <>
    <button className="btn" onClick={() => setOpen(true)}><Icon name="printer" /> {label}</button>
    {open && <Modal title="Etiketten drucken" onClose={() => setOpen(false)} footer={<><button className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
      <button className="btn primary" onClick={() => { try { localStorage.setItem('aperio-label-format', format); } catch { /* egal */ } printLabels(labels(), format); setOpen(false); }}>Vorschau und Drucken</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>{labels().length} Etikett(en) mit QR-Code. Mit dem Handy gescannt, öffnet der Code direkt den Eintrag in AperioPlan.</p>
      <label className="row"><input type="radio" checked={format === 'a4'} onChange={() => setFormat('a4')} /> A4-Bogen (3 × 8, z. B. 63,5 × 33,9 mm)</label>
      <label className="row"><input type="radio" checked={format === '62x29'} onChange={() => setFormat('62x29')} /> Etikettendrucker 62 × 29 mm (z. B. Brother QL)</label>
      <label className="row"><input type="radio" checked={format === '50x25'} onChange={() => setFormat('50x25')} /> Etikettendrucker 50 × 25 mm</label>
    </Modal>}
  </>;
}
