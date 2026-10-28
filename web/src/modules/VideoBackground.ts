/**
 * Hintergrund im Videoanruf: unscharf oder durch ein Bild ersetzt.
 * Die Trennung von Person und Hintergrund rechnet der eigene Rechner mit MediaPipe
 * (freie Bilderkennung von Google); das Kamerabild verlässt dafür den Rechner nicht.
 */
export type BackgroundMode = { kind: 'none' } | { kind: 'blur'; strength: number } | { kind: 'image'; src: string };

interface Segmenter {
  setOptions(o: { modelSelection: number }): void;
  onResults(cb: (r: { image: CanvasImageSource; segmentationMask: CanvasImageSource }) => void): void;
  send(i: { image: HTMLVideoElement }): Promise<void>;
  close(): Promise<void>;
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if ((window as unknown as { SelfieSegmentation?: unknown }).SelfieSegmentation) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/mediapipe/selfie_segmentation.js';
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error('Hintergrund-Erkennung konnte nicht geladen werden')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Eingebaute Hintergrundbilder (ohne fremde Dateien gezeichnet) */
export function builtinBackgrounds(): { name: string; src: string }[] {
  const make = (stops: string[], deco: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 1280, 720);
    stops.forEach((s, i) => grad.addColorStop(i / (stops.length - 1), s));
    g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);
    deco(g);
    return c.toDataURL('image/jpeg', 0.85);
  };
  return [
    { name: 'Hell', src: make(['#f4f5f8', '#e3e6ee'], (g) => { g.fillStyle = 'rgba(79,70,229,.08)'; g.beginPath(); g.arc(1080, 140, 260, 0, Math.PI * 2); g.fill(); }) },
    { name: 'Blau', src: make(['#3f37c9', '#6d6af8'], (g) => { g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 40; g.beginPath(); g.arc(1000, 720, 360, Math.PI, 0); g.stroke(); }) },
    { name: 'Dunkel', src: make(['#16171c', '#2a2d3a'], (g) => { g.fillStyle = 'rgba(251,191,36,.10)'; g.fillRect(860, 420, 320, 48); g.fillStyle = 'rgba(199,210,254,.10)'; g.fillRect(940, 500, 320, 48); }) },
  ];
}

/** Wendet den Hintergrund auf eine Kamera-Spur an und liefert die bearbeitete Spur */
export class BackgroundProcessor {
  private video = document.createElement('video');
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private seg: Segmenter | null = null;
  private running = false;
  private bg: HTMLImageElement | null = null;
  private out: MediaStream | null = null;
  mode: BackgroundMode = { kind: 'none' };

  async start(input: MediaStreamTrack, mode: BackgroundMode): Promise<MediaStreamTrack> {
    await loadScript();
    this.mode = mode;
    const settings = input.getSettings();
    this.canvas.width = settings.width ?? 1280;
    this.canvas.height = settings.height ?? 720;
    this.video.srcObject = new MediaStream([input]);
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    const Ctor = (window as unknown as { SelfieSegmentation: new (o: { locateFile: (f: string) => string }) => Segmenter }).SelfieSegmentation;
    this.seg = new Ctor({ locateFile: (f) => `/mediapipe/${f}` });
    this.seg.setOptions({ modelSelection: 1 });
    this.seg.onResults((r) => this.draw(r));
    await this.setMode(mode);
    this.running = true;
    const loop = async () => {
      if (!this.running || !this.seg) return;
      try { if (this.video.readyState >= 2) await this.seg.send({ image: this.video }); } catch { /* nächstes Bild */ }
      setTimeout(loop, 40);
    };
    void loop();
    this.out = this.canvas.captureStream(25);
    return this.out.getVideoTracks()[0]!;
  }

  async setMode(mode: BackgroundMode) {
    this.mode = mode;
    if (mode.kind === 'image') {
      const img = new Image();
      img.src = mode.src;
      await img.decode().catch(() => {});
      this.bg = img;
    }
  }

  private draw(r: { image: CanvasImageSource; segmentationMask: CanvasImageSource }) {
    const { width: w, height: h } = this.canvas;
    const g = this.ctx;
    g.save();
    g.clearRect(0, 0, w, h);
    g.drawImage(r.segmentationMask, 0, 0, w, h);
    g.globalCompositeOperation = 'source-in';
    g.drawImage(r.image, 0, 0, w, h);
    g.globalCompositeOperation = 'destination-over';
    if (this.mode.kind === 'blur') {
      g.filter = `blur(${this.mode.strength}px)`;
      g.drawImage(r.image, 0, 0, w, h);
    } else if (this.mode.kind === 'image' && this.bg) {
      const s = Math.max(w / this.bg.width, h / this.bg.height);
      g.drawImage(this.bg, (w - this.bg.width * s) / 2, (h - this.bg.height * s) / 2, this.bg.width * s, this.bg.height * s);
    } else g.drawImage(r.image, 0, 0, w, h);
    g.restore();
  }

  stop() {
    this.running = false;
    void this.seg?.close().catch(() => {});
    this.seg = null;
    this.out?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }
}
