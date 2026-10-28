import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { Icon } from '../components/Icon';
import { useSession } from '../session';

/** Dateiendungen, die der 3D-Viewer öffnen kann */

type TreeNode = { id: number; name: string; obj: THREE.Object3D; children: TreeNode[] };
type Loaded = { root: THREE.Group; tree: TreeNode[]; parts: THREE.Object3D[] };

const BASE_COLOR = 0x9aa7b8;

function stdMaterial(color: THREE.ColorRepresentation = BASE_COLOR) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, flatShading: false });
}

/** STEP / IGES / BREP: OpenCascade läuft als WebAssembly in einem Hintergrund-Thread */
function readCad(buffer: ArrayBuffer, ext: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new Worker('/occt/occt-import-js-worker.js');
    const format = ext === 'igs' || ext === 'iges' ? 'iges' : ext === 'brep' ? 'brep' : 'step';
    w.onmessage = (e) => { w.terminate(); e.data?.success ? resolve(e.data) : reject(new Error('Die Datei konnte nicht gelesen werden.')); };
    w.onerror = () => { w.terminate(); reject(new Error('Der STEP-Leser konnte nicht gestartet werden.')); };
    const bytes = new Uint8Array(buffer);
    w.postMessage({ format, buffer: bytes, params: { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 } }, [bytes.buffer]);
  });
}

function cadToGroup(res: any): THREE.Group {
  const meshes: THREE.Mesh[] = res.meshes.map((m: any, i: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    g.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from(m.index.array), 1));
    if (!m.attributes.normal) g.computeVertexNormals();
    const base = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(BASE_COLOR);
    let material: THREE.Material | THREE.Material[] = stdMaterial(base);
    const faces = (m.brep_faces ?? []) as { first: number; last: number; color: number[] | null }[];
    if (faces.some((f) => f.color)) {
      const mats: THREE.Material[] = [material];
      const byColor = new Map<string, number>();
      for (const f of faces) {
        let idx = 0;
        if (f.color) {
          const key = f.color.join(',');
          if (!byColor.has(key)) { byColor.set(key, mats.length); mats.push(stdMaterial(new THREE.Color(f.color[0]!, f.color[1]!, f.color[2]!))); }
          idx = byColor.get(key)!;
        }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, idx);
      }
      material = mats;
    }
    const mesh = new THREE.Mesh(g, material);
    mesh.name = m.name || `Körper ${i + 1}`;
    return mesh;
  });
  const build = (node: any): THREE.Group => {
    const grp = new THREE.Group();
    grp.name = node.name || '';
    for (const mi of node.meshes ?? []) grp.add(meshes[mi]!.parent ? meshes[mi]!.clone() : meshes[mi]!);
    for (const c of node.children ?? []) grp.add(build(c));
    return grp;
  };
  return build(res.root);
}

async function loadModel(buffer: ArrayBuffer, name: string): Promise<Loaded> {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  let root: THREE.Group;
  if (['step', 'stp', 'iges', 'igs', 'brep'].includes(ext)) root = cadToGroup(await readCad(buffer, ext));
  else if (ext === 'stl') {
    const g = new STLLoader().parse(buffer);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const hasColors = Boolean(g.getAttribute('color'));
    root = new THREE.Group();
    const mesh = new THREE.Mesh(g, hasColors ? new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }) : stdMaterial());
    mesh.name = name.replace(/\.[^.]+$/, '');
    root.add(mesh);
  } else if (ext === 'obj') root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  else if (ext === 'ply') {
    const g = new PLYLoader().parse(buffer);
    g.computeVertexNormals();
    root = new THREE.Group();
    root.add(new THREE.Mesh(g, g.getAttribute('color') ? new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }) : stdMaterial()));
  } else if (ext === '3mf') root = new ThreeMFLoader().parse(buffer);
  else if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    root = new THREE.Group(); root.add(gltf.scene);
  } else throw new Error('Dieses Dateiformat kann nicht angezeigt werden.');

  // Materialien ohne Licht (z. B. OBJ ohne MTL) durch ein neutrales ersetzen, beidseitig zeichnen
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat.side = THREE.DoubleSide;
    if (mats.every((x) => x.type === 'MeshPhongMaterial' && !(x as THREE.MeshPhongMaterial).map) && ext === 'obj') m.material = stdMaterial();
  });

  // Baum: Gruppen mit Namen oder mit Körpern
  let id = 0;
  const toTree = (o: THREE.Object3D): TreeNode[] => {
    const kids = o.children.flatMap(toTree);
    const isMesh = (o as THREE.Mesh).isMesh;
    if (!isMesh && !o.name) return kids;
    return [{ id: id++, name: o.name || 'Körper', obj: o, children: kids }];
  };
  const tree = root.children.flatMap(toTree);
  // Teile für die Explosionsansicht: oberste Ebene mit mehr als einem Eintrag
  let level: THREE.Object3D[] = [root];
  while (level.length === 1 && level[0]!.children.length > 0 && !(level[0] as THREE.Mesh).isMesh) level = level[0]!.children;
  return { root, tree, parts: level.length > 1 ? level : [] };
}

const fmtMm = (n: number) => `${n.toLocaleString('de-DE', { maximumFractionDigits: n < 10 ? 2 : 1 })} mm`;

/**
 * 3D-Viewer: Drehen (linke Maustaste), Verschieben (rechte Maustaste), Zoomen (Mausrad).
 * Läuft komplett im Browser, die Datei verlässt den Rechner nicht.
 */
export function Viewer3D({ src, file, name, height = 'calc(100vh - 140px)' }: { src?: string; file?: File; name: string; height?: string }) {
  const { theme } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<any>({});
  const [state, setState] = useState<{ loading: boolean; error?: string; info?: { size: THREE.Vector3; tris: number; parts: number } }>({ loading: true });
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [showTree, setShowTree] = useState(true);
  const [wire, setWire] = useState(false);
  const [edges, setEdges] = useState(true);
  const [section, setSection] = useState<'' | 'x' | 'y' | 'z'>('');
  const [cut, setCut] = useState(50);
  const [explode, setExplode] = useState(0);
  const [measure, setMeasure] = useState(false);
  const [dist, setDist] = useState<{ d: number; dx: number; dy: number; dz: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [, force] = useState(0);
  const hasParts = (api.current.loaded?.parts?.length ?? 0) > 1;

  // Szene aufbauen
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e7);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    camera.add(sun); sun.position.set(1, 2, 3);
    scene.add(camera);
    const markers = new THREE.Group(); scene.add(markers);
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();
    api.current = { renderer, scene, camera, controls, markers, plane: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0) };
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement);
      scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh || (o as THREE.LineSegments).isLineSegments) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x?.dispose()); } }); };
  }, []);

  useEffect(() => { api.current.scene && (api.current.scene.background = new THREE.Color(theme === 'dark' ? 0x1a1d21 : 0xf3f5f8)); }, [theme, state.loading]);

  // Modell laden
  useEffect(() => {
    let stop = false;
    setState({ loading: true }); setTree([]); setDist(null); setSection(''); setExplode(0); setSelected(null);
    (async () => {
      try {
        const buf = file ? await file.arrayBuffer() : await fetch(src!, { credentials: 'include' }).then((r) => { if (!r.ok) throw new Error('Die Datei konnte nicht geladen werden.'); return r.arrayBuffer(); });
        const loaded = await loadModel(buf, name);
        if (stop) return;
        const { scene } = api.current;
        if (api.current.loaded) scene.remove(api.current.loaded.root);
        scene.add(loaded.root);
        loaded.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(loaded.root);
        const center = box.getCenter(new THREE.Vector3());
        loaded.parts.forEach((p) => { p.userData.home = p.position.clone(); p.userData.dir = new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3()).sub(center); });
        let tris = 0;
        loaded.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { const g = m.geometry; tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3; } });
        api.current.loaded = loaded; api.current.box = box;
        setTree(loaded.tree);
        setState({ loading: false, info: { size: box.getSize(new THREE.Vector3()), tris: Math.round(tris), parts: loaded.parts.length } });
        view('iso');
      } catch (e) { if (!stop) setState({ loading: false, error: (e as Error).message }); }
    })();
    return () => { stop = true; };
  }, [src, file, name]); // eslint-disable-line react-hooks/exhaustive-deps

  function view(dir: 'iso' | 'front' | 'top' | 'right' | 'fit') {
    const { camera, controls, box } = api.current as { camera: THREE.PerspectiveCamera; controls: OrbitControls; box?: THREE.Box3 };
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const dist = r / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
    const d = dir === 'fit' ? camera.position.clone().sub(controls.target).normalize()
      : { iso: new THREE.Vector3(1, -1, 0.8), front: new THREE.Vector3(0, -1, 0), top: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0) }[dir].normalize();
    camera.up.set(0, dir === 'top' ? 1 : 0, dir === 'top' ? 0 : 1);
    camera.position.copy(c).addScaledVector(d, dist);
    camera.near = dist / 1000; camera.far = dist * 100; camera.updateProjectionMatrix();
    controls.target.copy(c); controls.update();
  }

  const meshes = () => { const out: THREE.Mesh[] = []; api.current.loaded?.root.traverse((o: THREE.Object3D) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); }); return out; };
  const mats = () => meshes().flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material]));

  // Drahtgitter
  useEffect(() => { mats().forEach((m) => { (m as THREE.MeshStandardMaterial).wireframe = wire; }); }, [wire, state.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  // Kanten
  useEffect(() => {
    if (state.loading) return;
    for (const m of meshes()) {
      let e = m.userData.edges as THREE.LineSegments | undefined;
      if (edges && !e && (state.info?.tris ?? 0) < 1_500_000) {
        e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25), new THREE.LineBasicMaterial({ color: 0x1f2933, transparent: true, opacity: 0.55 }));
        e.raycast = () => {}; m.add(e); m.userData.edges = e;
      }
      if (e) e.visible = edges && !wire;
    }
    applyClip();
  }, [edges, wire, state.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Schnitt
  function applyClip() {
    const { plane, box } = api.current as { plane: THREE.Plane; box?: THREE.Box3 };
    const all = [...mats(), ...meshes().map((m) => (m.userData.edges as THREE.LineSegments | undefined)?.material as THREE.Material | undefined).filter(Boolean)] as THREE.Material[];
    if (!section || !box) { all.forEach((m) => { m.clippingPlanes = null; m.needsUpdate = true; }); return; }
    const axis = { x: 0, y: 1, z: 2 }[section];
    const n = new THREE.Vector3(); n.setComponent(axis, -1);
    const min = box.min.getComponent(axis), max = box.max.getComponent(axis);
    plane.set(n, min + ((max - min) * cut) / 100);
    all.forEach((m) => { m.clippingPlanes = [plane]; m.needsUpdate = true; });
  }
  useEffect(applyClip, [section, cut, state.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Explosionsansicht
  useEffect(() => {
    const parts = (api.current.loaded?.parts ?? []) as THREE.Object3D[];
    parts.forEach((p) => { p.position.copy(p.userData.home).addScaledVector(p.userData.dir, explode / 50); });
  }, [explode]);

  // Auswahl hervorheben
  useEffect(() => {
    const target = selected == null ? null : findNode(tree, selected)?.obj;
    for (const m of meshes()) {
      const inSel = target ? isInside(m, target) : false;
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { const s = x as THREE.MeshStandardMaterial; s.emissive?.set(inSel ? 0x4f46e5 : 0x000000); s.emissiveIntensity = inSel ? 0.45 : 0; });
    }
  }, [selected, tree]); // eslint-disable-line react-hooks/exhaustive-deps

  // Klick: Messen oder Teil auswählen
  useEffect(() => {
    const el = api.current.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!el) return;
    let down = { x: 0, y: 0 };
    const pts: THREE.Vector3[] = [];
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
      const r = el.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), api.current.camera);
      const hit = ray.intersectObjects(meshes().filter((m) => isVisible(m)), false).find((h) => !section || api.current.plane.distanceToPoint(h.point) >= 0);
      if (!measure) {
        const node = hit ? nodeFor(tree, hit.object) : null;
        setSelected(node?.id ?? null);
        return;
      }
      if (!hit) return;
      const { markers, box } = api.current as { markers: THREE.Group; box: THREE.Box3 };
      if (pts.length === 2) { pts.length = 0; markers.clear(); setDist(null); }
      pts.push(hit.point.clone());
      const size = box.getSize(new THREE.Vector3()).length() / 150;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(size), new THREE.MeshBasicMaterial({ color: 0xe5484d, depthTest: false }));
      dot.renderOrder = 10; dot.position.copy(hit.point); markers.add(dot);
      if (pts.length === 2) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xe5484d, depthTest: false }));
        line.renderOrder = 10; markers.add(line);
        const d = pts[1]!.clone().sub(pts[0]!);
        setDist({ d: d.length(), dx: Math.abs(d.x), dy: Math.abs(d.y), dz: Math.abs(d.z) });
      }
    };
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointerup', onUp);
    if (!measure) { api.current.markers?.clear(); setDist(null); }
    return () => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); };
  }, [measure, tree, section]); // eslint-disable-line react-hooks/exhaustive-deps

  const screenshot = () => {
    const a = document.createElement('a');
    a.href = (api.current.renderer as THREE.WebGLRenderer).domElement.toDataURL('image/png');
    a.download = `${name.replace(/\.[^.]+$/, '')}.png`; a.click();
  };
  const toggle = (n: TreeNode) => { n.obj.visible = !n.obj.visible; force((x) => x + 1); };
  const showOnly = (n: TreeNode) => { tree.forEach(function walk(t: TreeNode) { t.obj.visible = true; t.children.forEach(walk); }); for (const t of flatten(tree)) if (!isInside(t.obj, n.obj) && !isInside(n.obj, t.obj)) t.obj.visible = false; force((x) => x + 1); };
  const showAll = () => { for (const t of flatten(tree)) t.obj.visible = true; force((x) => x + 1); };

  return (
    <div className="v3d" style={{ height }}>
      <div className="v3d-bar">
        <button className="btn sm" onClick={() => view('iso')} title="Schrägansicht">Iso</button>
        <button className="btn sm" onClick={() => view('front')}>Vorne</button>
        <button className="btn sm" onClick={() => view('top')}>Oben</button>
        <button className="btn sm" onClick={() => view('right')}>Rechts</button>
        <button className="btn sm" onClick={() => view('fit')} title="Einpassen"><Icon name="maximize" /></button>
        <span className="v3d-sep" />
        <button className={`btn sm ${edges ? 'primary' : ''}`} onClick={() => setEdges(!edges)}>Kanten</button>
        <button className={`btn sm ${wire ? 'primary' : ''}`} onClick={() => setWire(!wire)}>Drahtgitter</button>
        <select className="sm" value={section} onChange={(e) => setSection(e.target.value as typeof section)} style={{ width: 'auto' }} aria-label="Schnitt">
          <option value="">kein Schnitt</option><option value="x">Schnitt X</option><option value="y">Schnitt Y</option><option value="z">Schnitt Z</option>
        </select>
        {section && <input type="range" min={0} max={100} value={cut} onChange={(e) => setCut(Number(e.target.value))} style={{ width: 120 }} aria-label="Schnittposition" />}
        <button className={`btn sm ${measure ? 'primary' : ''}`} onClick={() => setMeasure(!measure)}><Icon name="ruler" /> Messen</button>
        {hasParts && <label className="row small" style={{ gap: 4 }}>Explosion <input type="range" min={0} max={100} value={explode} onChange={(e) => setExplode(Number(e.target.value))} style={{ width: 90 }} /></label>}
        <span className="grow" />
        {tree.length > 0 && <button className={`btn sm ${showTree ? 'primary' : ''}`} onClick={() => setShowTree(!showTree)}>Baugruppe</button>}
        <button className="btn sm" onClick={screenshot} title="Bild speichern"><Icon name="image" /></button>
      </div>
      <div className="v3d-main">
        {showTree && tree.length > 0 && (
          <div className="v3d-tree">
            <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 4 }}><b>Teile</b><button className="btn ghost sm" onClick={showAll}>alle zeigen</button></div>
            {tree.map((n) => <TreeRow key={n.id} n={n} depth={0} selected={selected} onSelect={setSelected} onToggle={toggle} onOnly={showOnly} />)}
          </div>
        )}
        <div className="v3d-canvas" ref={host}>
          {state.loading && <div className="v3d-overlay">3D-Modell wird geladen …</div>}
          {state.error && <div className="v3d-overlay error">{state.error}</div>}
          {measure && <div className="v3d-measure">{dist ? <><b>{fmtMm(dist.d)}</b><span>X {fmtMm(dist.dx)} · Y {fmtMm(dist.dy)} · Z {fmtMm(dist.dz)}</span></> : 'Zwei Punkte auf dem Modell anklicken'}</div>}
          {state.info && <div className="v3d-info">{fmtMm(state.info.size.x)} × {fmtMm(state.info.size.y)} × {fmtMm(state.info.size.z)}{state.info.parts > 1 ? ` · ${state.info.parts} Teile` : ''}</div>}
        </div>
      </div>
    </div>
  );
}

function TreeRow({ n, depth, selected, onSelect, onToggle, onOnly }: { n: TreeNode; depth: number; selected: number | null; onSelect: (id: number | null) => void; onToggle: (n: TreeNode) => void; onOnly: (n: TreeNode) => void }) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <>
      <div className={`v3d-row ${selected === n.id ? 'on' : ''} ${n.obj.visible ? '' : 'hidden'}`} style={{ paddingLeft: depth * 14 + 2 }}>
        {n.children.length ? <button className="v3d-caret" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button> : <span className="v3d-caret" />}
        <span className="grow v3d-name" onClick={() => onSelect(selected === n.id ? null : n.id)} onDoubleClick={() => onOnly(n)} title={`${n.name} – Doppelklick: nur dieses Teil zeigen`}>{n.name}</span>
        <button className="v3d-eye" onClick={() => onToggle(n)} title={n.obj.visible ? 'Ausblenden' : 'Einblenden'}><Icon name={n.obj.visible ? 'eye' : 'eye-off'} size={14} /></button>
      </div>
      {open && n.children.map((c) => <TreeRow key={c.id} n={c} depth={depth + 1} selected={selected} onSelect={onSelect} onToggle={onToggle} onOnly={onOnly} />)}
    </>
  );
}

const flatten = (t: TreeNode[]): TreeNode[] => t.flatMap((n) => [n, ...flatten(n.children)]);
const findNode = (t: TreeNode[], id: number) => flatten(t).find((n) => n.id === id);
function isInside(o: THREE.Object3D, parent: THREE.Object3D) { for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === parent) return true; return false; }
function isVisible(o: THREE.Object3D) { for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false; return true; }
/** kleinster Baumeintrag, der das getroffene Objekt enthält – bevorzugt das oberste Bauteil unter der Wurzel */
function nodeFor(tree: TreeNode[], o: THREE.Object3D) {
  let best: TreeNode | null = null;
  for (const n of flatten(tree)) if (isInside(o, n.obj) && (!best || isInside(n.obj, best.obj))) best = n;
  return best;
}
