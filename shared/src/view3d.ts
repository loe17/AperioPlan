/** 3D-Formate, die der Browser direkt anzeigt (three.js und OpenCascade als WebAssembly) */
export const VIEW3D_DIRECT = ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'obj', 'glb', 'gltf', '3mf', 'ply', 'fbx', 'dae', 'wrl', 'vrml', 'amf', '3ds', 'vtk', 'vtp', 'usdz'] as const;

/**
 * Native CAD-Formate: Geometrie lesen nur die CAD-Programme selbst. Ein Arbeitsplatz mit dem Programm
 * wandelt die Datei auf Anfrage in STEP um (Umwandlungsdienst der CAD-Bridge); bis dahin zeigt die Ansicht
 * das in der Datei gespeicherte Vorschaubild.
 */
export const VIEW3D_NATIVE: Record<string, { label: string; program: string }> = {
  sldprt: { label: 'SolidWorks-Teil', program: 'SolidWorks' },
  sldasm: { label: 'SolidWorks-Baugruppe', program: 'SolidWorks' },
  ipt: { label: 'Inventor-Teil', program: 'Inventor' },
  iam: { label: 'Inventor-Baugruppe', program: 'Inventor' },
  par: { label: 'Solid-Edge-Teil', program: 'Solid Edge' },
  psm: { label: 'Solid-Edge-Blechteil', program: 'Solid Edge' },
  asm: { label: 'Solid-Edge-Baugruppe', program: 'Solid Edge' },
  catpart: { label: 'CATIA-Teil', program: 'CATIA V5' },
  catproduct: { label: 'CATIA-Produkt', program: 'CATIA V5' },
  prt: { label: 'Creo- oder NX-Teil', program: 'Creo oder NX' },
  x_t: { label: 'Parasolid', program: 'SolidWorks, Solid Edge oder NX' },
  x_b: { label: 'Parasolid (binär)', program: 'SolidWorks, Solid Edge oder NX' },
  sat: { label: 'ACIS', program: 'SolidWorks oder Inventor' },
  sab: { label: 'ACIS (binär)', program: 'SolidWorks oder Inventor' },
  jt: { label: 'JT', program: 'SolidWorks, Solid Edge oder NX' },
};

export const extOf = (name: string | null | undefined) => {
  const n = (name ?? '').toLowerCase();
  const m = /\.(x_t|x_b)$/.exec(n) ?? /\.([a-z0-9]+)(\.\d+)?$/.exec(n); // Creo hängt Versionsnummern an: teil.prt.3
  return m?.[1] ?? '';
};
export const isView3dDirect = (name: string | null | undefined) => (VIEW3D_DIRECT as readonly string[]).includes(extOf(name));
export const isView3dNative = (name: string | null | undefined) => extOf(name) in VIEW3D_NATIVE;
export const isView3d = (name: string | null | undefined) => isView3dDirect(name) || isView3dNative(name);
