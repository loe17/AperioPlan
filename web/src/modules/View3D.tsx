import { lazy, Suspense } from 'react';
import { VIEW3D_DIRECT, isView3d, isView3dDirect } from '@aperio/shared';
import { Icon } from '../components/Icon';
import { Loading } from '../components/ui';

/** Dateiendungen, die der Browser direkt als 3D-Modell anzeigt */
export const VIEWER3D_EXT = new RegExp(`\\.(${VIEW3D_DIRECT.join('|')})$`, 'i');

// three.js ist groß – erst laden, wenn wirklich ein Modell geöffnet wird
const Viewer3D = lazy(() => import('./Viewer3D').then((m) => ({ default: m.Viewer3D })));

/** Der Viewer selbst, nachgeladen */
export function LazyViewer3D(props: { src?: string; file?: File; name: string; height?: string }) {
  return <Suspense fallback={<Loading />}><Viewer3D {...props} /></Suspense>;
}

/**
 * Lässt sich die Datei in 3D ansehen? Austauschformate immer; native CAD-Formate (SolidWorks, Inventor …)
 * nur, wenn die Datei in der Dateiablage liegt (dann kann ein CAD-Arbeitsplatz sie umwandeln).
 */
export function useCan3D() {
  return (name: string | null | undefined, inStore = false) => Boolean(name && (inStore ? isView3d(name) : isView3dDirect(name)));
}

/** 3D-Ansicht im selben Fenster öffnen (wie Word-Dateien); „Zurück“ führt hierher zurück */
export function open3D(o: { fileId?: string | null; src?: string; cadItemId?: string; name?: string }) {
  const q = new URLSearchParams();
  if (o.fileId) q.set('file', o.fileId);
  else if (o.cadItemId) q.set('cad', o.cadItemId);
  else if (o.src) q.set('src', o.src);
  if (o.name) q.set('name', o.name);
  q.set('back', location.pathname + location.search);
  location.assign(`/view3d?${q}`);
}

/** Knopf „3D ansehen“ */
export function View3DButton({ url, name, label, fileId }: { url?: string; name: string; label?: string; fileId?: string | null }) {
  const can3d = useCan3D();
  if (!can3d(name, Boolean(fileId))) return null;
  return <button className="btn sm" onClick={() => open3D({ fileId, src: url, name })} title="In 3D ansehen und messen"><Icon name="cube" />{label ? ` ${label}` : ''}</button>;
}
