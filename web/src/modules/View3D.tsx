import { lazy, Suspense, useState } from 'react';
import { useCan } from '../session';
import { Icon } from '../components/Icon';
import { Loading, Modal } from '../components/ui';

/** Dateiendungen, die der 3D-Viewer öffnen kann */
export const VIEWER3D_EXT = /\.(step|stp|iges|igs|brep|stl|obj|glb|gltf|3mf|ply)$/i;

// three.js ist groß – erst laden, wenn wirklich ein Modell geöffnet wird
const Viewer3D = lazy(() => import('./Viewer3D').then((m) => ({ default: m.Viewer3D })));

/** Der Viewer selbst, nachgeladen */
export function LazyViewer3D(props: { src?: string; file?: File; name: string; height?: string }) {
  return <Suspense fallback={<Loading />}><Viewer3D {...props} /></Suspense>;
}

/** Ist die App installiert und das Format bekannt? */
export function useCan3D() {
  const can = useCan();
  return (name: string | null | undefined) => Boolean(name && can('viewer3d') && VIEWER3D_EXT.test(name));
}

/** Knopf „3D ansehen“, öffnet das Modell im Vollbild-Fenster */
export function View3DButton({ url, name, label }: { url: string; name: string; label?: string }) {
  const can3d = useCan3D();
  const [open, setOpen] = useState(false);
  if (!can3d(name)) return null;
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Im 3D-Viewer ansehen"><Icon name="cube" />{label ? ` ${label}` : ''}</button>
      {open && <Modal size="full" title={name} onClose={() => setOpen(false)}><LazyViewer3D src={url} name={name} height="calc(100vh - 150px)" /></Modal>}
    </>
  );
}
