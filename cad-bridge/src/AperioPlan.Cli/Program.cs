using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AperioPlan.Core;

namespace AperioPlan.Cli
{
    /// <summary>
    /// aperio-cad – Kommandozeilenwerkzeug für die CAD-Zentrale.
    ///   aperio-cad config --server https://plan.firma.de --token ap_...
    ///   aperio-cad whoami
    ///   aperio-cad list [--project 0100] [--q Rahmen]
    ///   aperio-cad new --project 0100 --type part --sub 100 [--subsub 0] --name Rahmen [--drawing] [--prop Werkstoff=S235JR ...]
    ///   aperio-cad checkout &lt;Nummer|Datei&gt;
    ///   aperio-cad checkin &lt;Datei&gt; [-m Kommentar] [--ref Datei=Menge ...] [--keep]
    ///   aperio-cad revise &lt;Nummer|Datei&gt; -m Grund
    ///   aperio-cad state &lt;Nummer|Datei&gt; review|released|in_work|obsolete [-m Kommentar]
    ///   aperio-cad where-used &lt;Nummer|Datei&gt;
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0 || args[0] == "help" || args[0] == "--help") { Help(); return 0; }
                var o = Options.Parse(args.Skip(1).ToArray());
                var settings = BridgeSettings.Load();
                if (o.Has("server")) settings.ServerUrl = o["server"];
                if (o.Has("token")) settings.Token = o["token"];
                if (o.Has("workspace")) settings.Workspace = o["workspace"];
                if (args[0] == "config") { settings.Save(); Console.WriteLine("Gespeichert: " + BridgeSettings.ConfigFile); return 0; }
                if (!settings.IsConfigured) throw new InvalidOperationException("Bitte zuerst: aperio-cad config --server URL --token SCHLÜSSEL");
                using (var api = settings.CreateClient())
                {
                    var ws = new Workspace(settings.Workspace);
                    switch (args[0])
                    {
                        case "whoami":
                            var me = api.Me();
                            Console.WriteLine($"{me.Str("displayName")} ({me.Str("username")}, {me.Str("role")}) @ {api.BaseUrl}");
                            return 0;
                        case "list": return List(api, o);
                        case "new": return New(api, ws, o);
                        case "checkout": return Checkout(api, ws, o);
                        case "checkin": return Checkin(api, ws, o);
                        case "revise":
                            {
                                var item = Find(api, o.Positional(0));
                                var r = api.Revise(item.Id, o.Get("m") ?? throw new ArgumentException("-m Grund fehlt"), Environment.MachineName);
                                string local = ws.LocalPath(r.FilePath);
                                string old = ws.LocalPath(item.FilePath);
                                if (File.Exists(old) && !File.Exists(local)) { Workspace.SetReadOnly(old, false); File.Move(old, local); }
                                Console.WriteLine($"Neuer Versionsstand: {r.Number} → {local}");
                                return 0;
                            }
                        case "state":
                            {
                                var item = Find(api, o.Positional(0));
                                var r = api.SetState(item.Id, o.Positional(1), o.Get("m"));
                                Console.WriteLine($"{r.Number}: {CadItem.StateLabel(r.State)}");
                                return 0;
                            }
                        case "where-used":
                            {
                                var item = Find(api, o.Positional(0));
                                var rows = api.WhereUsed(item.Id);
                                if (rows.Count == 0) Console.WriteLine("Nirgends verbaut.");
                                foreach (var r in rows) Console.WriteLine($"{new string(' ', 2 * (r.Int("depth") - 1))}{r.Str("number")}  x{r.Int("quantity")}  ({r.Str("projectNumber")})");
                                return 0;
                            }
                        default: Help(); return 1;
                    }
                }
            }
            catch (ApiException e) { Console.Error.WriteLine($"Fehler ({e.Status}): {e.Message}"); return 2; }
            catch (Exception e) { Console.Error.WriteLine("Fehler: " + e.Message); return 1; }
        }

        private static void Help()
        {
            Console.WriteLine("aperio-cad – CAD-Zentrale von AperioPlan");
            Console.WriteLine("  config --server URL --token SCHLÜSSEL [--workspace ORDNER]");
            Console.WriteLine("  whoami | list [--project NR] [--q TEXT]");
            Console.WriteLine("  new --project NR --type part|assembly --sub 100 [--subsub 0] --name BENENNUNG [--drawing] [--proc make|buy|standard] [--prop KEY=WERT]");
            Console.WriteLine("  checkout NUMMER|DATEI | checkin DATEI [-m TEXT] [--ref DATEI=MENGE] [--keep]");
            Console.WriteLine("  revise NUMMER -m GRUND | state NUMMER review|released|in_work|obsolete [-m TEXT] | where-used NUMMER");
        }

        private static CadItem Find(ApiClient api, string key)
        {
            if (string.IsNullOrEmpty(key)) throw new ArgumentException("Nummer oder Datei angeben");
            var item = api.Resolve(Path.GetFileName(key) + (CadTypes.FromFileName(key) == null ? ".sldprt" : ""));
            if (item == null && CadTypes.FromFileName(key) == null) item = api.Resolve(Path.GetFileName(key) + ".sldasm");
            return item ?? throw new InvalidOperationException("Nicht in der CAD-Zentrale gefunden: " + key);
        }

        private static Project FindProject(ApiClient api, string number)
            => api.Projects().FirstOrDefault(p => p.Number == number || p.Id == number) ?? throw new InvalidOperationException("Projekt nicht gefunden: " + number);

        private static int List(ApiClient api, Options o)
        {
            string q = "/cad/items?limit=500";
            if (o.Has("project")) q += "&projectId=" + FindProject(api, o["project"]).Id;
            if (o.Has("q")) q += "&q=" + Uri.EscapeDataString(o["q"]);
            foreach (Dictionary<string, object> d in api.GetList(q))
            {
                var i = CadItem.From(d);
                Console.WriteLine($"{i.Number,-45} {i.Type,-9} {CadItem.StateLabel(i.State),-12} {(i.CheckedOutByName != null ? "🔒 " + i.CheckedOutByName : "")}");
            }
            return 0;
        }

        private static int New(ApiClient api, Workspace ws, Options o)
        {
            var p = FindProject(api, o["project"]);
            var type = CadTypes.FromApi(o.Get("type") ?? "part");
            var props = o.All("prop").Select(x => x.Split(new[] { '=' }, 2)).Where(x => x.Length == 2).ToDictionary(x => x[0], x => x[1]);
            var r = api.CreateItem(p.Id, type, int.Parse(o["sub"]), int.Parse(o.Get("subsub") ?? "0"), o["name"], o.Get("proc") ?? "make", props, o.Has("drawing"), Environment.MachineName);
            Console.WriteLine($"Nummer vergeben: {r.Item.Number}");
            Console.WriteLine($"Datei:           {ws.LocalPath(r.Item.FilePath)}");
            if (r.Drawing != null) Console.WriteLine($"Zeichnung:       {ws.LocalPath(r.Drawing.FilePath)}");
            foreach (var kv in r.CustomProperties) Console.WriteLine($"  {kv.Key} = {kv.Value}");
            return 0;
        }

        private static int Checkout(ApiClient api, Workspace ws, Options o)
        {
            var item = Find(api, o.Positional(0));
            var r = api.Checkout(item.Id, Environment.MachineName);
            string local = ws.LocalPath(r.FilePath);
            try { api.Download($"/cad/items/{r.Id}/download", local); } catch (ApiException e) when (e.Status == 404) { /* noch keine Datei */ }
            Workspace.SetReadOnly(local, false);
            Console.WriteLine($"Ausgecheckt: {r.Number} → {local}");
            return 0;
        }

        private static int Checkin(ApiClient api, Workspace ws, Options o)
        {
            string file = Path.GetFullPath(o.Positional(0) ?? throw new ArgumentException("Datei angeben"));
            var item = api.Resolve(Path.GetFileName(file)) ?? throw new InvalidOperationException("Datei ist nicht in der CAD-Zentrale registriert");
            var refs = o.All("ref").Select(x => x.Split('=')).Select(x => new Reference { FileName = x[0], Quantity = x.Length > 1 ? int.Parse(x[1]) : 1 }).ToList();
            var unknown = api.Checkin(item.Id, file, o.Get("m"), null, item.CadType == CadType.Assembly ? refs : null, o.Has("keep"));
            if (!o.Has("keep")) Workspace.SetReadOnly(file, true);
            Console.WriteLine($"Eingecheckt: {item.Number}");
            foreach (var u in unknown) Console.WriteLine("  nicht verwaltet: " + u);
            return 0;
        }
    }

    internal class Options
    {
        private readonly Dictionary<string, List<string>> _named = new Dictionary<string, List<string>>();
        private readonly List<string> _pos = new List<string>();

        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a.StartsWith("-"))
                {
                    string key = a.TrimStart('-');
                    string val = i + 1 < args.Length && !args[i + 1].StartsWith("--") && key != "drawing" && key != "keep" ? args[++i] : "true";
                    if (!o._named.ContainsKey(key)) o._named[key] = new List<string>();
                    o._named[key].Add(val);
                }
                else o._pos.Add(a);
            }
            return o;
        }

        public bool Has(string k) => _named.ContainsKey(k);
        public string Get(string k) => Has(k) ? _named[k].Last() : null;
        public IEnumerable<string> All(string k) => Has(k) ? _named[k] : Enumerable.Empty<string>();
        public string this[string k] => Get(k) ?? throw new ArgumentException("--" + k + " fehlt");
        public string Positional(int i) => i < _pos.Count ? _pos[i] : null;
    }
}
