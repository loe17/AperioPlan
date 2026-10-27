using System;
using System.IO;
using System.Linq;
using System.Threading;
using AperioPlan.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace AperioPlan.ExportWorker
{
    /// <summary>
    /// Holt Ableitungsaufträge vom Server (PDF/DXF für Zeichnungen, STEP für 3D-Modelle), lädt die Dateien
    /// in einen temporären Arbeitsbereich, öffnet sie unsichtbar in SolidWorks, exportiert und lädt das Ergebnis hoch.
    ///   AperioPlan.ExportWorker.exe [--once] [--formats pdf,dxf,step] [--interval 20]
    /// Server-Adresse und API-Schlüssel stammen aus den Einstellungen des CAD-Wächters.
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            var settings = BridgeSettings.Load();
            if (!settings.IsConfigured) { Console.Error.WriteLine("Bitte zuerst im CAD-Wächter bzw. mit 'aperio-cad config' Server und API-Schlüssel einrichten."); return 1; }
            bool once = args.Contains("--once");
            string[] formats = Arg(args, "--formats")?.Split(',') ?? new[] { "pdf", "dxf", "step" };
            int interval = int.TryParse(Arg(args, "--interval"), out int i) ? i : 20;
            string temp = Path.Combine(Path.GetTempPath(), "AperioPlanExport");
            string worker = "ExportWorker@" + Environment.MachineName;

            SldWorks sw = null;
            using (var api = settings.CreateClient())
            {
                Console.WriteLine($"AperioPlan Export-Dienst – {api.BaseUrl} – Formate: {string.Join(", ", formats)}");
                while (true)
                {
                    ExportJob job = null;
                    try
                    {
                        job = api.ClaimExport(worker, formats);
                        if (job == null)
                        {
                            if (once) break;
                            Thread.Sleep(TimeSpan.FromSeconds(interval));
                            continue;
                        }
                        Console.WriteLine($"{DateTime.Now:T}  {job.Format.ToUpperInvariant()}  {job.Item.Number}");
                        sw = sw ?? StartSolidWorks();
                        string result = Export(api, sw, job, temp);
                        api.CompleteExport(job.Id, result);
                        Console.WriteLine("            erledigt: " + Path.GetFileName(result));
                    }
                    catch (Exception e)
                    {
                        Console.Error.WriteLine("            Fehler: " + e.Message);
                        if (job != null) try { api.FailExport(job.Id, e.Message); } catch { /* Server nicht erreichbar */ }
                        if (e is System.Runtime.InteropServices.COMException) sw = null; // SolidWorks neu starten
                        Thread.Sleep(TimeSpan.FromSeconds(5));
                    }
                }
            }
            sw?.ExitApp();
            return 0;
        }

        private static string Arg(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        private static SldWorks StartSolidWorks()
        {
            var sw = (SldWorks)Activator.CreateInstance(Type.GetTypeFromProgID("SldWorks.Application"));
            sw.Visible = false;
            sw.UserControl = false;
            return sw;
        }

        private static string Export(ApiClient api, SldWorks sw, ExportJob job, string temp)
        {
            string jobDir = Path.Combine(temp, job.Id);
            Directory.CreateDirectory(jobDir);
            string file = Path.Combine(jobDir, job.Item.FileName);
            api.Download(job.DownloadUrl, file);
            if (job.ReferencedModelUrl != null) api.Download(job.ReferencedModelUrl, Path.Combine(jobDir, job.ReferencedModelFileName));

            int type = job.Item.CadType == CadType.Drawing ? (int)swDocumentTypes_e.swDocDRAWING
                : job.Item.CadType == CadType.Assembly ? (int)swDocumentTypes_e.swDocASSEMBLY : (int)swDocumentTypes_e.swDocPART;
            int errors = 0, warnings = 0;
            var doc = sw.OpenDoc6(file, type, (int)(swOpenDocOptions_e.swOpenDocOptions_Silent | swOpenDocOptions_e.swOpenDocOptions_ReadOnly), "", ref errors, ref warnings) as ModelDoc2;
            if (doc == null) throw new InvalidOperationException($"SolidWorks konnte {job.Item.FileName} nicht öffnen (Fehler {errors})");
            try
            {
                string target = Path.Combine(jobDir, job.TargetName);
                object exportData = null;
                if (job.Format == "pdf")
                {
                    var pdf = (ExportPdfData)sw.GetExportFileData((int)swExportDataFileType_e.swExportPdfData);
                    var sheets = (doc as DrawingDoc)?.GetSheetNames() as string[];
                    if (sheets != null) pdf.SetSheets((int)swExportDataSheetsToExport_e.swExportData_ExportAllSheets, sheets);
                    exportData = pdf;
                }
                if (job.Format == "dxf" && doc is DrawingDoc)
                    sw.SetUserPreferenceIntegerValue((int)swUserPreferenceIntegerValue_e.swDxfMultiSheetOption, (int)swDxfMultisheet_e.swDxfSeparateSheets);
                bool ok = doc.Extension.SaveAs(target, (int)swSaveAsVersion_e.swSaveAsCurrentVersion, (int)swSaveAsOptions_e.swSaveAsOptions_Silent, exportData, ref errors, ref warnings);
                if (!ok || !File.Exists(target))
                {
                    // Mehrblatt-DXF wird ggf. als <Name>-<Blatt>.dxf abgelegt
                    var alt = Directory.GetFiles(jobDir, Path.GetFileNameWithoutExtension(target) + "*." + job.Format).FirstOrDefault();
                    if (alt == null) throw new InvalidOperationException($"Export nach {job.Format.ToUpperInvariant()} fehlgeschlagen (Fehler {errors})");
                    target = alt;
                }
                return target;
            }
            finally
            {
                sw.CloseDoc(doc.GetTitle());
            }
        }
    }
}
