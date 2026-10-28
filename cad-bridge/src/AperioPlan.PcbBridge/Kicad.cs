using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AperioPlan.PcbBridge
{
    /// <summary>
    /// Anschluss an KiCad über das mitgelieferte Kommandozeilenwerkzeug kicad-cli (ab KiCad 8).
    /// Weitere Programme (Altium, Eagle/Fusion) kommen später als eigene Anschlüsse mit derselben Schnittstelle dazu.
    /// </summary>
    public sealed class Kicad
    {
        public string Cli { get; }
        public string Version { get; }

        private Kicad(string cli, string version) { Cli = cli; Version = version; }

        /// <summary>kicad-cli suchen: Einstellung, PATH, übliche Installationsorte</summary>
        public static Kicad Find(string configured)
        {
            var cands = new List<string>();
            if (!string.IsNullOrWhiteSpace(configured)) cands.Add(configured);
            string exe = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "kicad-cli.exe" : "kicad-cli";
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) if (dir.Length > 0) cands.Add(Path.Combine(dir, exe));
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                                             Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs") })
                {
                    string k = Path.Combine(root ?? "", "KiCad");
                    if (!Directory.Exists(k)) continue;
                    foreach (var v in Directory.GetDirectories(k).OrderByDescending(d => ParseVersion(Path.GetFileName(d))))
                        cands.Add(Path.Combine(v, "bin", exe));
                }
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                cands.Add("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli");
            else cands.AddRange(new[] { "/usr/bin/kicad-cli", "/usr/local/bin/kicad-cli", "/snap/bin/kicad-cli" });

            foreach (var c in cands.Where(File.Exists).Distinct())
            {
                try
                {
                    var r = Run(c, new[] { "version" }, null, TimeSpan.FromSeconds(30));
                    if (r.Code == 0) return new Kicad(c, r.Output.Trim());
                }
                catch { /* nächster Kandidat */ }
            }
            return null;
        }

        private static Version ParseVersion(string s) => System.Version.TryParse(s.Contains('.') ? s : s + ".0", out var v) ? v : new Version(0, 0);

        public int Major => int.TryParse(Version.Split('.')[0], out int m) ? m : 0;

        public struct Result { public int Code; public string Output; }

        public static Result Run(string exe, IEnumerable<string> args, string cwd, TimeSpan timeout)
        {
            var psi = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in args) psi.ArgumentList.Add(a);
            if (cwd != null) psi.WorkingDirectory = cwd;
            using (var p = Process.Start(psi))
            {
                var sb = new StringBuilder();
                p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                if (!p.WaitForExit((int)timeout.TotalMilliseconds)) { try { p.Kill(true); } catch { } throw new TimeoutException("kicad-cli antwortet nicht"); }
                p.WaitForExit();
                return new Result { Code = p.ExitCode, Output = sb.ToString() };
            }
        }

        private void Must(IEnumerable<string> args, string what)
        {
            var r = Run(Cli, args, null, TimeSpan.FromMinutes(10));
            if (r.Code != 0) throw new InvalidOperationException($"{what} fehlgeschlagen: {r.Output.Trim()}");
        }

        // ------------------------------------------------------------ Projektdateien
        public static string ProjectFile(string dir) => Directory.Exists(dir) ? Directory.GetFiles(dir, "*.kicad_pro").OrderBy(f => f.Length).FirstOrDefault() : null;
        public static string Board(string dir) { var pro = ProjectFile(dir); var f = pro == null ? null : Path.ChangeExtension(pro, ".kicad_pcb"); return f != null && File.Exists(f) ? f : Directory.GetFiles(dir, "*.kicad_pcb").FirstOrDefault(); }
        public static string Schematic(string dir) { var pro = ProjectFile(dir); var f = pro == null ? null : Path.ChangeExtension(pro, ".kicad_sch"); return f != null && File.Exists(f) ? f : Directory.GetFiles(dir, "*.kicad_sch").FirstOrDefault(); }

        /// <summary>Textvariablen im .kicad_pro lesen (z. B. APERIO_NUMMER)</summary>
        public static Dictionary<string, string> ReadTextVariables(string pro)
        {
            var r = new Dictionary<string, string>();
            try
            {
                var root = JsonNode.Parse(File.ReadAllText(pro)) as JsonObject;
                if (root?["text_variables"] is JsonObject tv) foreach (var kv in tv) r[kv.Key] = kv.Value?.ToString() ?? "";
            }
            catch { /* keine oder beschädigte Projektdatei */ }
            return r;
        }

        /// <summary>Textvariablen ins .kicad_pro schreiben – erscheinen im Schriftfeld über ${APERIO_NUMMER} usw.</summary>
        public static void WriteTextVariables(string pro, IDictionary<string, string> vars)
        {
            var root = (File.Exists(pro) ? JsonNode.Parse(File.ReadAllText(pro)) as JsonObject : null) ?? new JsonObject();
            if (!(root["text_variables"] is JsonObject tv)) { tv = new JsonObject(); root["text_variables"] = tv; }
            foreach (var kv in vars) tv[kv.Key] = kv.Value;
            File.WriteAllText(pro, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }

        /// <summary>Projektordner als ZIP packen (ohne Sicherungen und Zwischenablagen von KiCad)</summary>
        public static string ZipProject(string dir, string target)
        {
            if (File.Exists(target)) File.Delete(target);
            using (var zip = ZipFile.Open(target, ZipArchiveMode.Create))
            {
                foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                {
                    string rel = Path.GetRelativePath(dir, f).Replace('\\', '/');
                    if (rel.StartsWith(".") || rel.Contains("-backups/") || rel.Contains("/.history/") || rel.StartsWith("Fertigung/")
                        || rel.EndsWith(".lck") || rel.EndsWith("fp-info-cache") || rel.EndsWith(".kicad_prl") || rel.Contains("~")) continue;
                    zip.CreateEntryFromFile(f, rel, CompressionLevel.Optimal);
                }
            }
            return target;
        }

        // ------------------------------------------------------------ Ausgaben
        public string ExportBom(string dir, string target)
        {
            string sch = Schematic(dir) ?? throw new InvalidOperationException("Kein Schaltplan (.kicad_sch) gefunden");
            Must(new[] { "sch", "export", "bom", "--output", target,
                "--fields", "Reference,Value,Footprint,${QUANTITY},${DNP},Manufacturer,MPN,Hersteller,Herstellernummer,Bestellnummer",
                "--labels", "Refs,Value,Footprint,Qty,DNP,Manufacturer,MPN,Hersteller,Herstellernummer,Bestellnummer",
                "--group-by", "Value,Footprint,MPN,Herstellernummer", "--ref-range-delimiter", "", sch }, "Stückliste");
            return target;
        }

        /// <summary>Erzeugt eine Fertigungsdatei. Mehrteilige Ausgaben (Gerber, Bohrdaten) werden als ZIP zusammengefasst.</summary>
        public string Export(string dir, string format, string outDir, string stem)
        {
            string pcb = Board(dir), sch = Schematic(dir);
            Directory.CreateDirectory(outDir);
            switch (format)
            {
                case "gerber":
                    {
                        string tmp = Path.Combine(outDir, "gerber"); Directory.CreateDirectory(tmp);
                        Must(new[] { "pcb", "export", "gerbers", "--board-plot-params", "--output", tmp + Path.DirectorySeparatorChar, pcb ?? throw new InvalidOperationException("Keine Platine (.kicad_pcb)") }, "Gerber");
                        return ZipDir(tmp, Path.Combine(outDir, stem + "_Gerber.zip"));
                    }
                case "drill":
                    {
                        string tmp = Path.Combine(outDir, "drill"); Directory.CreateDirectory(tmp);
                        Must(new[] { "pcb", "export", "drill", "--format", "excellon", "--generate-map", "--map-format", "pdf", "--output", tmp + Path.DirectorySeparatorChar, pcb ?? throw new InvalidOperationException("Keine Platine (.kicad_pcb)") }, "Bohrdaten");
                        return ZipDir(tmp, Path.Combine(outDir, stem + "_Bohrdaten.zip"));
                    }
                case "pos":
                    {
                        string f = Path.Combine(outDir, stem + "_Bestueckung.csv");
                        Must(new[] { "pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--output", f, pcb ?? throw new InvalidOperationException("Keine Platine (.kicad_pcb)") }, "Bestückungsliste");
                        return f;
                    }
                case "bom": return ExportBom(dir, Path.Combine(outDir, stem + "_Stueckliste.csv"));
                case "schematic":
                    {
                        string f = Path.Combine(outDir, stem + "_Schaltplan.pdf");
                        Must(new[] { "sch", "export", "pdf", "--output", f, sch ?? throw new InvalidOperationException("Kein Schaltplan (.kicad_sch)") }, "Schaltplan-PDF");
                        return f;
                    }
                case "step":
                    {
                        string f = Path.Combine(outDir, stem + ".step");
                        Must(new[] { "pcb", "export", "step", "--subst-models", "--force", "--output", f, pcb ?? throw new InvalidOperationException("Keine Platine (.kicad_pcb)") }, "STEP-Modell");
                        return f;
                    }
                default: throw new NotSupportedException("Unbekanntes Format: " + format);
            }
        }

        private static string ZipDir(string dir, string target)
        {
            if (File.Exists(target)) File.Delete(target);
            if (!Directory.EnumerateFiles(dir).Any()) throw new InvalidOperationException("kicad-cli hat keine Dateien erzeugt");
            ZipFile.CreateFromDirectory(dir, target);
            return target;
        }
    }
}
