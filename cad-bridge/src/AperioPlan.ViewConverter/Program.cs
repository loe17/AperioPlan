using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using AperioPlan.Core;

namespace AperioPlan.ViewConverter
{
    /// <summary>
    /// Holt Umwandlungsaufträge für die 3D-Ansicht vom Server, öffnet die Datei im passenden CAD-Programm
    /// (unsichtbar, schreibgeschützt), speichert sie als STEP und lädt das Ergebnis hoch.
    ///   AperioPlan.ViewConverter.exe [--once] [--interval 15]
    /// Server-Adresse und API-Schlüssel stammen aus den Einstellungen des CAD-Wächters.
    /// Erkannt werden SolidWorks, Inventor, Solid Edge und CATIA V5 – je nachdem, was installiert ist.
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("Der Umwandlungsdienst läuft nur unter Windows mit installiertem CAD-Programm."); return 1; }
            var settings = BridgeSettings.Load();
            if (!settings.IsConfigured) { Console.Error.WriteLine("Bitte zuerst im CAD-Wächter bzw. mit 'aperio-cad config' Server und API-Schlüssel einrichten."); return 1; }
            bool once = args.Contains("--once");
            int interval = int.TryParse(Arg(args, "--interval"), out int i) ? i : 15;
            var converters = Converter.All().Where((c) => c.Installed).ToList();
            if (converters.Count == 0) { Console.Error.WriteLine("Kein unterstütztes CAD-Programm gefunden (SolidWorks, Inventor, Solid Edge, CATIA V5)."); return 1; }
            var formats = converters.SelectMany((c) => c.Formats).Distinct().ToList();
            string worker = Environment.MachineName;
            string temp = Path.Combine(Path.GetTempPath(), "AperioPlanView3D");

            using (var api = settings.CreateClient())
            {
                Console.WriteLine($"AperioPlan Umwandlungsdienst – {api.BaseUrl}");
                Console.WriteLine($"Programme: {string.Join(", ", converters.Select((c) => c.Program))} – Formate: {string.Join(", ", formats)}");
                DateTime lastHello = DateTime.MinValue;
                while (true)
                {
                    if (DateTime.Now - lastHello > TimeSpan.FromMinutes(5))
                    {
                        lastHello = DateTime.Now;
                        try { api.Hello("export", "3D-Umwandlung: " + string.Join(", ", converters.Select((c) => c.Program))); } catch { /* Server kurz nicht erreichbar */ }
                    }
                    string jobId = null;
                    try
                    {
                        var r = api.Post("/view3d/conversions/claim", new Dictionary<string, object>
                        {
                            ["worker"] = worker, ["formats"] = formats.Cast<object>().ToList(), ["programs"] = converters.Select((c) => (object)c.Program).ToList(),
                        });
                        var job = r.Obj("job");
                        if (job == null)
                        {
                            if (once) break;
                            Thread.Sleep(TimeSpan.FromSeconds(interval));
                            continue;
                        }
                        jobId = job.Str("id");
                        string fileName = job.Str("fileName"), format = job.Str("format"), networkPath = job.Str("networkPath");
                        Console.WriteLine($"{DateTime.Now:T}  {fileName}");
                        string dir = Path.Combine(temp, jobId);
                        Directory.CreateDirectory(dir);
                        // Baugruppen direkt im Netzwerkordner öffnen, damit die Teile gefunden werden; sonst herunterladen
                        string source = !string.IsNullOrEmpty(networkPath) && File.Exists(networkPath) ? networkPath : Path.Combine(dir, fileName);
                        if (source != networkPath) api.Download(job.Str("downloadUrl"), source);
                        string target = Path.Combine(dir, Path.GetFileNameWithoutExtension(fileName) + ".step");
                        var conv = converters.First((c) => c.Formats.Contains(format));
                        conv.ToStep(source, target);
                        if (!File.Exists(target) || new FileInfo(target).Length == 0) throw new InvalidOperationException("Es wurde keine STEP-Datei erzeugt.");
                        api.Upload("/view3d/conversions/" + jobId + "/complete", target);
                        Console.WriteLine("            erledigt");
                        try { Directory.Delete(dir, true); } catch { /* egal */ }
                    }
                    catch (Exception e)
                    {
                        string msg = (e is TargetInvocationException t && t.InnerException != null ? t.InnerException : e).Message;
                        Console.Error.WriteLine("            Fehler: " + msg);
                        if (jobId != null) try { api.Post("/view3d/conversions/" + jobId + "/fail", new Dictionary<string, object> { ["error"] = msg }); } catch { /* Server nicht erreichbar */ }
                        if (e is COMException || e.InnerException is COMException) foreach (var c in converters) c.Reset();
                        Thread.Sleep(TimeSpan.FromSeconds(5));
                    }
                }
            }
            foreach (var c in converters) c.Quit();
            return 0;
        }

        private static string Arg(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
    }
}
