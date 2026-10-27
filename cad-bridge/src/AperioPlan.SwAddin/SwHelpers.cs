using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using AperioPlan.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace AperioPlan.SwAddin
{
    /// <summary>Hilfsfunktionen rund um die SolidWorks-API.</summary>
    internal static class SwHelpers
    {
        public static swDocumentTypes_e SwDocType(CadType t) =>
            t == CadType.Assembly ? swDocumentTypes_e.swDocASSEMBLY : t == CadType.Drawing ? swDocumentTypes_e.swDocDRAWING : swDocumentTypes_e.swDocPART;

        /// <summary>Dateieigenschaften (Custom Properties) lesen.</summary>
        public static Dictionary<string, string> ReadCustomProperties(ModelDoc2 doc)
        {
            var result = new Dictionary<string, string>();
            var mgr = doc.Extension.get_CustomPropertyManager("");
            object names = null, types = null, values = null, resolved = null, links = null;
            mgr.GetAll3(ref names, ref types, ref values, ref resolved, ref links);
            if (names is string[] n && resolved is string[] r)
                for (int i = 0; i < n.Length; i++) result[n[i]] = r[i];
            return result;
        }

        /// <summary>
        /// Schreibt alle Eigenschaften aus der Speichermaske als Custom Properties in die Datei.
        /// Die Zeichnungsvorlage verweist per $PRP / $PRPSHEET darauf – so landen sie im Schriftkopf.
        /// </summary>
        public static void WriteCustomProperties(ModelDoc2 doc, IDictionary<string, string> props)
        {
            var mgr = doc.Extension.get_CustomPropertyManager("");
            foreach (var kv in props)
            {
                if (string.IsNullOrEmpty(kv.Key)) continue;
                mgr.Add3(kv.Key, (int)swCustomInfoType_e.swCustomInfoText, kv.Value ?? "", (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
            }
        }

        public static void SaveAs(ModelDoc2 doc, string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            if (File.Exists(path)) Workspace.SetReadOnly(path, false);
            int errors = 0, warnings = 0;
            Bridge.IsSavingInternally = true;
            try
            {
                bool ok = doc.Extension.SaveAs(path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                    (int)(swSaveAsOptions_e.swSaveAsOptions_Silent | swSaveAsOptions_e.swSaveAsOptions_SaveReferenced), null, ref errors, ref warnings);
                if (!ok) throw new InvalidOperationException($"SolidWorks konnte die Datei nicht speichern (Fehlercode {errors}): {path}");
            }
            finally { Bridge.IsSavingInternally = false; }
        }

        public static void Save(ModelDoc2 doc)
        {
            int errors = 0, warnings = 0;
            Bridge.IsSavingInternally = true;
            try
            {
                if (!doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref errors, ref warnings))
                    throw new InvalidOperationException($"Speichern fehlgeschlagen (Fehlercode {errors})");
            }
            finally { Bridge.IsSavingInternally = false; }
        }

        /// <summary>Oberste Ebene der Baugruppe als Stückliste (Dateiname + Anzahl), ohne unterdrückte/ausgeschlossene Komponenten.</summary>
        public static List<Reference> CollectReferences(ModelDoc2 doc)
        {
            var result = new Dictionary<string, Reference>(StringComparer.OrdinalIgnoreCase);
            if (!(doc is AssemblyDoc asm)) return new List<Reference>();
            var comps = asm.GetComponents(true) as object[];
            if (comps == null) return new List<Reference>();
            foreach (Component2 c in comps.Cast<Component2>())
            {
                if (c.IsSuppressed() || c.ExcludeFromBOM || c.IsEnvelope()) continue;
                string path = c.GetPathName();
                if (string.IsNullOrEmpty(path)) continue;
                string name = Path.GetFileName(path);
                if (result.TryGetValue(name, out var r)) r.Quantity++;
                else result[name] = new Reference { FileName = name, Quantity = 1 };
            }
            return result.Values.ToList();
        }

        /// <summary>Legt die Zeichnung mit gleicher Nummer und Firmenvorlage an (Normalprojektion nach DIN, 1. Winkel).</summary>
        public static ModelDoc2 CreateDrawing(SldWorks sw, string modelPath, string drawingPath, string templateName, IDictionary<string, string> props)
        {
            string template = FindTemplate(sw, templateName);
            var dwg = sw.NewDocument(template, (int)swDwgPaperSizes_e.swDwgPaperA3size, 0.42, 0.297) as ModelDoc2;
            if (dwg == null) throw new InvalidOperationException("Zeichnungsvorlage konnte nicht geöffnet werden: " + template);
            var drawing = (DrawingDoc)dwg;
            if (!drawing.Create1stAngleViews2(modelPath)) drawing.Create3rdAngleViews2(modelPath);
            WriteCustomProperties(dwg, props);
            dwg.ForceRebuild3(false);
            SaveAs(dwg, drawingPath);
            return dwg;
        }

        private static string FindTemplate(SldWorks sw, string templateName)
        {
            if (!string.IsNullOrEmpty(templateName))
            {
                if (File.Exists(templateName)) return templateName;
                string folders = sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swFileLocationsDocumentTemplates) ?? "";
                foreach (var dir in folders.Split(';').Where(Directory.Exists))
                {
                    var hit = Directory.GetFiles(dir, templateName, SearchOption.AllDirectories).FirstOrDefault();
                    if (hit != null) return hit;
                }
            }
            return sw.GetUserPreferenceStringValue((int)swUserPreferenceStringValue_e.swDefaultTemplateDrawing);
        }

        /// <summary>Erstes Modell, das in einer Zeichnungsansicht dargestellt wird.</summary>
        public static string FirstReferencedModel(ModelDoc2 doc)
        {
            if (!(doc is DrawingDoc drawing)) return null;
            var view = drawing.GetFirstView() as View; // erstes Objekt ist das Blatt
            view = view?.GetNextView() as View;
            while (view != null)
            {
                string name = view.GetReferencedModelName();
                if (!string.IsNullOrEmpty(name)) return name;
                view = view.GetNextView() as View;
            }
            return null;
        }

        public static bool SameContent(string a, string b)
        {
            if (!File.Exists(a) || !File.Exists(b)) return false;
            if (new FileInfo(a).Length != new FileInfo(b).Length) return false;
            using (var sha = SHA256.Create())
            using (var fa = File.OpenRead(a))
            using (var fb = File.OpenRead(b))
                return sha.ComputeHash(fa).SequenceEqual(SHA256.Create().ComputeHash(fb));
        }
    }
}
