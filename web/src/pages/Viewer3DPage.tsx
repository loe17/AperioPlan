import { useRef, useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { Icon } from '../components/Icon';
import { LazyViewer3D, VIEWER3D_EXT } from '../modules/View3D';
import { useToast } from '../components/ui';

/** Eigene 3D-Datei vom Rechner öffnen – sie wird nicht hochgeladen, nur im Browser angezeigt. */
export default function Viewer3DPage() {
  useCrumbs([{ label: '3D-Viewer' }]);
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!VIEWER3D_EXT.test(f.name)) { toast('Dieses Format kann nicht angezeigt werden. Möglich sind STEP, IGES, STL, OBJ, glTF/GLB, 3MF und PLY.', 'error'); return; }
    setFile(f);
  };
  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>3D-Viewer</h1><div className="sub">{file ? file.name : 'Modelle ansehen, schneiden und messen – ohne CAD-Programm'}</div></div>
        <div className="row"><button className="btn" onClick={() => input.current?.click()}><Icon name="upload" /> Datei öffnen</button></div>
      </div>
      <input ref={input} type="file" hidden accept=".step,.stp,.iges,.igs,.brep,.stl,.obj,.glb,.gltf,.3mf,.ply" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {file ? <LazyViewer3D file={file} name={file.name} height="calc(100vh - 190px)" /> : (
        <div className={`v3d-drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }} onClick={() => input.current?.click()} style={{ cursor: 'pointer' }}>
          <Icon name="cube" size={48} />
          <h3>3D-Datei hierher ziehen oder klicken</h3>
          <p className="muted">STEP, IGES, STL, OBJ, glTF/GLB, 3MF und PLY. Die Datei bleibt auf Ihrem Rechner und wird nicht hochgeladen.</p>
          <p className="small muted">Tipp: 3D-Dateien in Projektordnern, E-Mail-Anhängen und STEP-Ableitungen der CAD- und PCB-Bridge öffnen sich mit einem Klick direkt hier.</p>
        </div>
      )}
    </div>
  );
}
