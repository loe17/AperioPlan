using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using AperioPlan.Core;

namespace AperioPlan.PcbBridge
{
    /// <summary>
    /// aperio-pcb – PCB-Wächter für KiCad.
    ///   aperio-pcb watch                      Arbeitsbereich beobachten, neue Projekte melden, Fertigungsaufträge erledigen
    ///   aperio-pcb status [Ordner]            Nummer, Status und Sperre eines Projekts
    ///   aperio-pcb checkout [Ordner]          zum Bearbeiten sperren
    ///   aperio-pcb checkin [Ordner] [-m Text] [--keep]   Projekt und Stückliste hochladen
    ///   aperio-pcb undo [Ordner]              Sperre aufheben
    ///   aperio-pcb get &lt;Nummer&gt; [Ordner]      Projekt vom Server in den Arbeitsbereich holen
    ///   aperio-pcb export-once                offene Fertigungsaufträge einmal abarbeiten
    ///   aperio-pcb config --server URL --token SCHLÜSSEL [--workspace ORDNER] [--kicad-cli PFAD]
    ///   aperio-pcb update                     neue Version laden und installieren
    /// </summary>
    internal static class Program
    {
        private static BridgeSettings _settings;
        private static readonly string Host = Environment.MachineName;
        private const string Marker = ".aperioplan.json";

        private static int Main(string[] args)
        {
            BridgeSettings.FileName = "pcb-bridge.json";
            try
            {
                string cmd = args.Length == 0 ? "help" : args[0];
                var o = Opts.Parse(args.Skip(1).ToArray());
                _settings = BridgeSettings.Load();
                if (cmd == "help" || cmd == "--help" || cmd == "-h") { Help(); return 0; }
                if (cmd == "version" || cmd == "--version") { Console.WriteLine("aperio-pcb " + ApiClient.BridgeVersion); return 0; }
                if (cmd == "config")
                {
                    if (o.Has("server")) _settings.ServerUrl = o.Get("server");
                    if (o.Has("token")) _settings.Token = o.Get("token");
                    if (o.Has("workspace")) _settings.Workspace = o.Get("workspace");
                    if (o.Has("kicad-cli")) _settings.KicadCli = o.Get("kicad-cli");
                    _settings.Save();
                    Console.WriteLine("Gespeichert: " + BridgeSettings.ConfigFile);
                    return 0;
                }
                if (!_settings.IsConfigured) throw new InvalidOperationException("Noch nicht eingerichtet. In AperioPlan unter PCB-Bridge → Wächter einrichten das Installationspaket herunterladen – oder: aperio-pcb config --server URL --token SCHLÜSSEL");
                using (var api = _settings.CreateClient())
                {
                    string dir = Path.GetFullPath(o.Pos(0) ?? Directory.GetCurrentDirectory());
                    switch (cmd)
                    {
                        case "watch": return Watch(api);
                        case "status": return Status(api, dir);
                        case "checkout": return Checkout(api, dir);
                        case "checkin": return Checkin(api, dir, o.Get("m") ?? "", o.Has("keep"));
                        case "undo": return Undo(api, dir);
                        case "get": return Get(api, o.Pos(0) ?? throw new ArgumentException("Nummer fehlt"), o.Pos(1));
                        case "export-once": { var k = RequireKicad(); while (ExportOnce(api, k)) { } return 0; }
                        case "update": return Update(api, interactive: true) ? 0 : 1;
                        default: Help(); return 1;
                    }
                }
            }
            catch (ApiException e) { Console.Error.WriteLine($"Fehler ({e.Status}): {e.Message}"); return 2; }
            catch (Exception e) { Console.Error.WriteLine("Fehler: " + e.Message); return 1; }
        }

        private static void Help()
        {
            Console.WriteLine("aperio-pcb " + ApiClient.BridgeVersion + " – PCB-Wächter von AperioPlan (KiCad ab Version 8)");
            Console.WriteLine();
            Console.WriteLine("  watch                         Arbeitsbereich beobachten und Fertigungsaufträge erledigen (läuft im Hintergrund)");
            Console.WriteLine("  status [Ordner]               Nummer, Status und Sperre anzeigen");
            Console.WriteLine("  checkout [Ordner]             zum Bearbeiten sperren");
            Console.WriteLine("  checkin [Ordner] -m \"Text\" [--keep]   Projekt und Stückliste hochladen");
            Console.WriteLine("  undo [Ordner]                 Sperre aufheben");
            Console.WriteLine("  get <Nummer> [Ordner]         Projekt vom Server holen");
            Console.WriteLine("  export-once                   offene Fertigungsaufträge einmal abarbeiten");
            Console.WriteLine("  config --server URL --token SCHLÜSSEL [--workspace ORDNER] [--kicad-cli PFAD]");
            Console.WriteLine("  update                        neue Version installieren");
            Console.WriteLine();
            Console.WriteLine("Ohne Ordnerangabe gilt der aktuelle Ordner.");
        }

        private static Kicad RequireKicad() => Kicad.Find(_settings.KicadCli) ?? throw new InvalidOperationException("KiCad (kicad-cli ab Version 8) wurde nicht gefunden. Pfad mit: aperio-pcb config --kicad-cli PFAD");

        // ------------------------------------------------------------ Projekt ↔ Leiterplatte
        private static string MarkerFile(string dir) => Path.Combine(dir, Marker);

        /// <summary>Leiterplatte zu einem Projektordner: Merkzettel, Textvariable APERIO_NUMMER oder Ordnername</summary>
        private static Dictionary<string, object> Resolve(ApiClient api, string dir)
        {
            if (File.Exists(MarkerFile(dir)))
            {
                var m = Json.ParseObject(File.ReadAllText(MarkerFile(dir)));
                string id = m?.Str("boardId");
                if (!string.IsNullOrEmpty(id)) { try { return api.Get("/pcb/boards/" + id); } catch (ApiException e) when (e.Status == 404) { File.Delete(MarkerFile(dir)); } }
            }
            string pro = Kicad.ProjectFile(dir);
            var names = new List<string>();
            if (pro != null && Kicad.ReadTextVariables(pro).TryGetValue("APERIO_NUMMER", out var nr) && nr.Length > 0) names.Add(nr);
            names.Add(Path.GetFileName(dir.TrimEnd(Path.DirectorySeparatorChar)));
            foreach (var n in names)
            {
                var r = api.Get("/pcb/resolve?name=" + Uri.EscapeDataString(n));
                if (r != null && r.Bool("managed")) { Remember(dir, r.Obj("board")); return api.Get("/pcb/boards/" + r.Obj("board").Str("id")); }
            }
            return null;
        }

        private static void Remember(string dir, Dictionary<string, object> board)
            => File.WriteAllText(MarkerFile(dir), Json.Stringify(new Dictionary<string, object> { ["boardId"] = board.Str("id"), ["number"] = board.Str("number"), ["server"] = _settings.ServerUrl }));

        private static Dictionary<string, object> Need(ApiClient api, string dir)
        {
            if (Kicad.ProjectFile(dir) == null) throw new InvalidOperationException($"Kein KiCad-Projekt (.kicad_pro) in {dir}");
            return Resolve(api, dir) ?? throw new InvalidOperationException("Dieses Projekt ist noch nicht in AperioPlan angelegt. Der Wächter (aperio-pcb watch) erkennt es und öffnet die Speichermaske.");
        }

        private static void ApplyVariables(string dir, Dictionary<string, object> vars)
        {
            string pro = Kicad.ProjectFile(dir);
            if (pro == null || vars == null) return;
            Kicad.WriteTextVariables(pro, vars.ToDictionary(kv => kv.Key, kv => kv.Value?.ToString() ?? ""));
        }

        private static string StateLabel(string s) => s switch { "in_work" => "In Arbeit", "review" => "Prüfung", "released" => "Freigegeben", "obsolete" => "Ungültig", _ => s };

        private static int Status(ApiClient api, string dir)
        {
            var b = Need(api, dir);
            Console.WriteLine($"{b.Str("fullNumber")}  {b.Str("designation")}");
            Console.WriteLine($"Projekt {b.Str("projectNumber")} {b.Str("projectName")} · Status: {StateLabel(b.Str("state"))}");
            Console.WriteLine(string.IsNullOrEmpty(b.Str("checkedOutBy")) ? "Nicht ausgecheckt" : $"Ausgecheckt von {b.Str("checkedOutByName")}" + (string.IsNullOrEmpty(b.Str("checkoutHost")) ? "" : $" ({b.Str("checkoutHost")})"));
            Console.WriteLine($"Im Browser: {_settings.ServerUrl.TrimEnd('/')}/pcb?board={b.Str("id")}");
            return 0;
        }

        private static int Checkout(ApiClient api, string dir)
        {
            var b = Need(api, dir);
            var r = api.Post($"/pcb/boards/{b.Str("id")}/checkout", new Dictionary<string, object> { ["host"] = Host });
            ApplyVariables(dir, b.Obj("textVariables"));
            Console.WriteLine($"{r.Str("fullNumber")} ausgecheckt – bitte nach dem Bearbeiten einchecken.");
            return 0;
        }

        private static int Undo(ApiClient api, string dir)
        {
            var b = Need(api, dir);
            api.Post($"/pcb/boards/{b.Str("id")}/undo-checkout");
            Console.WriteLine("Sperre aufgehoben.");
            return 0;
        }

        private static int Checkin(ApiClient api, string dir, string comment, bool keep)
        {
            var b = Need(api, dir);
            var me = api.Me();
            if (b.Str("checkedOutBy") != me.Str("id"))
            {
                if (!string.IsNullOrEmpty(b.Str("checkedOutBy"))) throw new InvalidOperationException($"Ausgecheckt von {b.Str("checkedOutByName")} – Einchecken nicht möglich");
                api.Post($"/pcb/boards/{b.Str("id")}/checkout", new Dictionary<string, object> { ["host"] = Host });
            }
            ApplyVariables(dir, b.Obj("textVariables"));
            string tmp = Path.Combine(Path.GetTempPath(), "aperio-pcb-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tmp);
            try
            {
                var files = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("file", Kicad.ZipProject(dir, Path.Combine(tmp, b.Str("number") + ".zip"))) };
                var k = Kicad.Find(_settings.KicadCli);
                if (k != null && Kicad.Schematic(dir) != null)
                {
                    try { files.Insert(0, new KeyValuePair<string, string>("bom", k.ExportBom(dir, Path.Combine(tmp, "bom.csv")))); }
                    catch (Exception e) { Console.WriteLine("Hinweis: Stückliste konnte nicht erzeugt werden – " + e.Message); }
                }
                var r = api.UploadFiles($"/pcb/boards/{b.Str("id")}/checkin", files, new Dictionary<string, string> { ["comment"] = comment, ["keepCheckedOut"] = keep ? "true" : "false" });
                var board = r.Obj("board");
                Console.WriteLine($"{board.Str("fullNumber")} eingecheckt{(r.ContainsKey("bomRows") && r["bomRows"] != null ? $" · {r.Int("bomRows")} Stücklisten-Positionen" : "")}.");
            }
            finally { try { Directory.Delete(tmp, true); } catch { } }
            return 0;
        }

        private static int Get(ApiClient api, string number, string target)
        {
            var r = api.Get("/pcb/resolve?name=" + Uri.EscapeDataString(number));
            if (r == null || !r.Bool("managed")) throw new InvalidOperationException("Nicht gefunden: " + number);
            var b = api.Get("/pcb/boards/" + r.Obj("board").Str("id"));
            string dir = target ?? Path.Combine(_settings.Workspace, "Leiterplatten", b.Str("fullNumber") + "_" + b.Str("designation").Replace(' ', '_'));
            string zip = Path.Combine(Path.GetTempPath(), "aperio-pcb-" + Guid.NewGuid().ToString("N") + ".zip");
            api.Download($"/pcb/boards/{b.Str("id")}/download", zip);
            Directory.CreateDirectory(dir);
            ZipFile.ExtractToDirectory(zip, dir, overwriteFiles: true);
            File.Delete(zip);
            Remember(dir, b);
            Console.WriteLine($"{b.Str("fullNumber")} → {dir}");
            return 0;
        }

        // ------------------------------------------------------------ Wächter
        private static readonly ConcurrentDictionary<string, DateTime> Pending = new ConcurrentDictionary<string, DateTime>();
        private static readonly ConcurrentDictionary<string, bool> Known = new ConcurrentDictionary<string, bool>();

        private static int Watch(ApiClient api)
        {
            Directory.CreateDirectory(_settings.Workspace);
            var kicad = Kicad.Find(_settings.KicadCli);
            Log($"PCB-Wächter {ApiClient.BridgeVersion} – {api.BaseUrl}");
            Log($"Arbeitsbereich: {_settings.Workspace}");
            Log(kicad == null ? "Achtung: kicad-cli nicht gefunden – Fertigungsdaten können hier nicht erzeugt werden." : $"KiCad {kicad.Version}: {kicad.Cli}");
            Hello(api, kicad, offerUpdate: true);

            using (var fsw = new FileSystemWatcher(_settings.Workspace) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.DirectoryName })
            {
                fsw.Filters.Add("*.kicad_pro"); fsw.Filters.Add("*.kicad_pcb"); fsw.Filters.Add("*.kicad_sch");
                FileSystemEventHandler h = (s, e) => Touch(api, Path.GetDirectoryName(e.FullPath), e.FullPath);
                fsw.Created += h; fsw.Changed += h; fsw.Renamed += (s, e) => Touch(api, Path.GetDirectoryName(e.FullPath), e.FullPath);
                fsw.EnableRaisingEvents = true;
                // Bestehende Projekte beim Start einmal prüfen
                foreach (var pro in Directory.EnumerateFiles(_settings.Workspace, "*.kicad_pro", SearchOption.AllDirectories)) Touch(api, Path.GetDirectoryName(pro), pro);

                DateTime lastHello = DateTime.Now;
                while (true)
                {
                    try
                    {
                        if (kicad != null) while (ExportOnce(api, kicad)) { }
                        if (DateTime.Now - lastHello > TimeSpan.FromMinutes(5)) { lastHello = DateTime.Now; Hello(api, kicad, offerUpdate: false); }
                    }
                    catch (Exception e) { Log("Fehler: " + e.Message); }
                    Thread.Sleep(TimeSpan.FromSeconds(20));
                }
            }
        }

        private static readonly ConcurrentDictionary<string, DateTime> LastTouch = new ConcurrentDictionary<string, DateTime>();

        /// <summary>Datei im Arbeitsbereich geändert: neues Projekt melden oder vor Änderungen ohne Sperre warnen</summary>
        private static void Touch(ApiClient api, string dir, string file)
        {
            if (dir == null || file.Contains("-backups") || Path.GetFileName(file).StartsWith("_autosave")) return;
            var now = DateTime.Now;
            if (LastTouch.TryGetValue(dir, out var last) && now - last < TimeSpan.FromSeconds(10)) return;
            LastTouch[dir] = now;
            Task.Run(() =>
            {
                try
                {
                    Thread.Sleep(1500); // KiCad schreibt mehrere Dateien nacheinander
                    if (Kicad.ProjectFile(dir) == null) return;
                    var b = Resolve(api, dir);
                    if (b == null) { Detected(api, dir); return; }
                    Known[dir] = true;
                    if (file.EndsWith(".kicad_pro")) return;
                    var me = api.Me();
                    string by = b.Str("checkedOutBy");
                    if (string.IsNullOrEmpty(by)) Log($"Hinweis: {b.Str("fullNumber")} wurde geändert, ist aber nicht ausgecheckt. Bitte „aperio-pcb checkout \"{dir}\"“ – sonst gehen Änderungen beim nächsten Abgleich verloren.");
                    else if (by != me.Str("id")) Log($"Achtung: {b.Str("fullNumber")} ist von {b.Str("checkedOutByName")} ausgecheckt – Ihre Änderungen können nicht eingecheckt werden.");
                }
                catch (Exception e) { Log("Fehler: " + e.Message); }
            });
        }

        /// <summary>Neues KiCad-Projekt: beim Server melden, Speichermaske im Browser öffnen, auf die Nummer warten</summary>
        private static void Detected(ApiClient api, string dir)
        {
            if (Pending.ContainsKey(dir)) return;
            Pending[dir] = DateTime.Now;
            string name = Path.GetFileNameWithoutExtension(Kicad.ProjectFile(dir));
            var r = api.Post("/pcb/detected", new Dictionary<string, object> { ["host"] = Host, ["path"] = dir, ["name"] = name });
            if (r.Bool("dismissed")) { Log($"{name}: wird nicht verwaltet (in AperioPlan abgelehnt)"); return; }
            string id = r.Str("id");
            Log($"Neues KiCad-Projekt erkannt: {name} – Speichermaske wird im Browser geöffnet");
            OpenBrowser(_settings.ServerUrl.TrimEnd('/') + r.Str("url"));
            var until = DateTime.Now.AddHours(8);
            while (DateTime.Now < until)
            {
                Thread.Sleep(TimeSpan.FromSeconds(5));
                try
                {
                    var d = api.Get("/pcb/detected/" + id);
                    if (d.Bool("dismissed")) { Pending.TryRemove(dir, out _); return; }
                    var b = d.Obj("board");
                    if (b == null) continue;
                    Remember(dir, b);
                    ApplyVariables(dir, d.Obj("textVariables"));
                    Log($"{name}: Nummer {b.Str("fullNumber")} vergeben und ins Projekt übernommen. Nach dem Bearbeiten: aperio-pcb checkin \"{dir}\"");
                    Pending.TryRemove(dir, out _);
                    return;
                }
                catch (Exception e) { Log("Warte auf Speichermaske: " + e.Message); }
            }
            Pending.TryRemove(dir, out _);
        }

        /// <summary>Einen Fertigungsauftrag abarbeiten (alle Formate einer Leiterplatte). true = es gab einen Auftrag.</summary>
        private static bool ExportOnce(ApiClient api, Kicad kicad)
        {
            var r = api.Post("/pcb/exports/claim", new Dictionary<string, object> { ["worker"] = "aperio-pcb@" + Host });
            var job = r.Obj("job");
            if (job == null) return false;
            var board = job.Obj("board");
            string stem = job.Str("stem");
            Log($"Fertigungsdaten für {board.Str("fullNumber")} …");
            string tmp = Path.Combine(Path.GetTempPath(), "aperio-pcb-export-" + Guid.NewGuid().ToString("N"));
            string src = Path.Combine(tmp, "projekt"), outDir = Path.Combine(tmp, "aus");
            var exports = job.Arr("exports").Cast<Dictionary<string, object>>().ToList();
            try
            {
                string zip = Path.Combine(tmp, "projekt.zip");
                api.Download(job.Str("downloadUrl"), zip);
                ZipFile.ExtractToDirectory(zip, src);
                string projDir = Path.GetDirectoryName(Directory.EnumerateFiles(src, "*.kicad_pro", SearchOption.AllDirectories).FirstOrDefault() ?? Directory.EnumerateFiles(src, "*.kicad_pcb", SearchOption.AllDirectories).First());
                foreach (var e in exports)
                {
                    string fmt = e.Str("format");
                    try
                    {
                        string f = kicad.Export(projDir, fmt, outDir, stem);
                        api.Upload($"/pcb/exports/{e.Str("id")}/complete", f);
                        Log($"   {fmt}: {Path.GetFileName(f)}");
                    }
                    catch (Exception ex)
                    {
                        Log($"   {fmt}: Fehler – {ex.Message}");
                        try { api.Post($"/pcb/exports/{e.Str("id")}/fail", new Dictionary<string, object> { ["error"] = ex.Message.Length > 1900 ? ex.Message.Substring(0, 1900) : ex.Message }); } catch { }
                    }
                }
            }
            catch (Exception ex)
            {
                foreach (var e in exports) try { api.Post($"/pcb/exports/{e.Str("id")}/fail", new Dictionary<string, object> { ["error"] = ex.Message }); } catch { }
                Log("Fehler: " + ex.Message);
            }
            finally { try { Directory.Delete(tmp, true); } catch { } }
            return true;
        }

        private static void Hello(ApiClient api, Kicad kicad, bool offerUpdate)
        {
            try
            {
                var r = api.Hello("pcb", kicad == null ? "" : "KiCad " + kicad.Version);
                if (r.Bool("updateAvailable"))
                {
                    Log($"Neue Version {r.Str("latestVersion")} verfügbar (installiert: {ApiClient.BridgeVersion}).");
                    if (offerUpdate) Update(api, interactive: !Console.IsInputRedirected && Environment.UserInteractive, info: r);
                }
            }
            catch (Exception e) { Log("Server nicht erreichbar: " + e.Message); }
        }

        /// <summary>Neue Version laden und die Programmdateien ersetzen (wirksam beim nächsten Start)</summary>
        private static bool Update(ApiClient api, bool interactive, Dictionary<string, object> info = null)
        {
            info = info ?? api.Hello("pcb", "");
            if (!info.Bool("updateAvailable")) { Console.WriteLine($"aperio-pcb {ApiClient.BridgeVersion} ist aktuell."); return true; }
            if (interactive)
            {
                Console.Write($"Version {info.Str("latestVersion")} jetzt installieren? [j/N] ");
                var a = Console.ReadLine() ?? "";
                if (!a.StartsWith("j", StringComparison.OrdinalIgnoreCase) && !a.StartsWith("y", StringComparison.OrdinalIgnoreCase)) return false;
            }
            else { Log($"Aktualisieren mit: aperio-pcb update (oder neues Installationspaket unter {api.BaseUrl}/pcb?tab=setup)"); return false; }
            string exe = Environment.ProcessPath ?? throw new InvalidOperationException("Programmpfad unbekannt");
            string dir = Path.GetDirectoryName(exe);
            string url = info.Str("downloadUrl");
            string pkg = Path.Combine(Path.GetTempPath(), "aperio-pcb-update" + (url.EndsWith(".zip") ? ".zip" : ".tar.gz"));
            api.Download(url, pkg);
            string unpack = Path.Combine(Path.GetTempPath(), "aperio-pcb-update");
            if (Directory.Exists(unpack)) Directory.Delete(unpack, true);
            if (pkg.EndsWith(".zip")) ZipFile.ExtractToDirectory(pkg, unpack);
            else { Directory.CreateDirectory(unpack); var r = Kicad.Run("tar", new[] { "-xzf", pkg, "-C", unpack }, null, TimeSpan.FromMinutes(2)); if (r.Code != 0) throw new InvalidOperationException(r.Output); }
            foreach (var f in Directory.EnumerateFiles(unpack, "*", SearchOption.AllDirectories))
            {
                string target = Path.Combine(dir, Path.GetRelativePath(unpack, f));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                // laufende Programmdatei unter Windows nicht überschreibbar → umbenennen, neue daneben legen
                if (File.Exists(target)) { string old = target + ".alt"; if (File.Exists(old)) File.Delete(old); File.Move(target, old); }
                File.Copy(f, target);
            }
            Console.WriteLine($"Version {info.Str("latestVersion")} installiert – wird beim nächsten Start des Wächters aktiv.");
            return true;
        }

        private static void OpenBrowser(string url)
        {
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) Process.Start("open", url);
                else Process.Start("xdg-open", url);
            }
            catch { Log("Bitte im Browser öffnen: " + url); }
        }

        private static readonly object LogLock = new object();
        private static void Log(string msg)
        {
            string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {msg}";
            lock (LogLock)
            {
                Console.WriteLine(line);
                try { File.AppendAllText(Path.Combine(BridgeSettings.ConfigDir, "pcb-bridge.log"), line + Environment.NewLine); } catch { }
            }
        }
    }

    internal class Opts
    {
        private readonly Dictionary<string, string> _named = new Dictionary<string, string>();
        private readonly List<string> _pos = new List<string>();
        private static readonly HashSet<string> Flags = new HashSet<string> { "keep" };
        public static Opts Parse(string[] args)
        {
            var o = new Opts();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a.StartsWith("-") && a.Length > 1)
                {
                    string key = a.TrimStart('-');
                    o._named[key] = !Flags.Contains(key) && i + 1 < args.Length ? args[++i] : "true";
                }
                else o._pos.Add(a);
            }
            return o;
        }
        public bool Has(string k) => _named.ContainsKey(k);
        public string Get(string k) => _named.TryGetValue(k, out var v) ? v : null;
        public string Pos(int i) => i < _pos.Count ? _pos[i] : null;
    }
}
