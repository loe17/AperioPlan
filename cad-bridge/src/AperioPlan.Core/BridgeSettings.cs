using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace AperioPlan.Core
{
    /// <summary>
    /// Einstellungen des CAD-Wächters in %APPDATA%\AperioPlan\cad-bridge.json.
    /// Der API-Schlüssel wird unter Windows mit DPAPI (nur für den angemeldeten Benutzer lesbar) verschlüsselt.
    /// </summary>
    public class BridgeSettings
    {
        public string ServerUrl = "";
        public string Token = "";
        /// <summary>Lokaler Arbeitsbereich, spiegelt die Ordnerstruktur des Servers</summary>
        public string Workspace = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AperioPlan", "Arbeitsbereich");
        /// <summary>Speichermaske nur für Dateien außerhalb des Arbeitsbereichs überspringen?</summary>
        public bool InterceptAllSaves = true;
        public bool CheckinOnClose = false;
        public string LastProjectId = "";
        /// <summary>Nur PCB-Wächter: Pfad zu kicad-cli (leer = automatisch suchen)</summary>
        public string KicadCli = "";

        /// <summary>Dateiname der Einstellungen: cad-bridge.json (SolidWorks) oder pcb-bridge.json (KiCad)</summary>
        public static string FileName = "cad-bridge.json";

        public static string ConfigDir
        {
            get
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                if (string.IsNullOrEmpty(appData)) appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
                return Path.Combine(appData, "AperioPlan");
            }
        }
        public static string ConfigFile => Path.Combine(ConfigDir, FileName);

        public bool IsConfigured => !string.IsNullOrWhiteSpace(ServerUrl) && !string.IsNullOrWhiteSpace(Token);

        public static BridgeSettings Load()
        {
            var s = new BridgeSettings();
            try
            {
                if (!File.Exists(ConfigFile)) return s;
                var d = Json.ParseObject(File.ReadAllText(ConfigFile, Encoding.UTF8));
                s.ServerUrl = d.Str("serverUrl") ?? "";
                s.Token = Unprotect(d.Str("token") ?? "");
                s.Workspace = d.Str("workspace") ?? s.Workspace;
                s.InterceptAllSaves = !d.ContainsKey("interceptAllSaves") || d.Bool("interceptAllSaves");
                s.CheckinOnClose = d.Bool("checkinOnClose");
                s.LastProjectId = d.Str("lastProjectId") ?? "";
                s.KicadCli = d.Str("kicadCli") ?? "";
            }
            catch { /* beschädigte Datei – Standardwerte */ }
            return s;
        }

        public void Save()
        {
            Directory.CreateDirectory(ConfigDir);
            var d = new Dictionary<string, object>
            {
                ["serverUrl"] = ServerUrl, ["token"] = Protect(Token), ["workspace"] = Workspace,
                ["interceptAllSaves"] = InterceptAllSaves, ["checkinOnClose"] = CheckinOnClose, ["lastProjectId"] = LastProjectId, ["kicadCli"] = KicadCli,
            };
            File.WriteAllText(ConfigFile, Json.Stringify(d), Encoding.UTF8);
        }

        public ApiClient CreateClient() => new ApiClient(ServerUrl, Token);

        private const string Prefix = "dpapi:";

        private static string Protect(string plain)
        {
            if (string.IsNullOrEmpty(plain)) return "";
#if NETFRAMEWORK
            var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
            return Prefix + Convert.ToBase64String(bytes);
#else
            return plain;
#endif
        }

        private static string Unprotect(string stored)
        {
            if (!stored.StartsWith(Prefix)) return stored;
#if NETFRAMEWORK
            var bytes = ProtectedData.Unprotect(Convert.FromBase64String(stored.Substring(Prefix.Length)), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
#else
            throw new PlatformNotSupportedException("DPAPI nur unter Windows");
#endif
        }
    }

    /// <summary>Übersetzt Ablagepfade des Servers in lokale Pfade des Arbeitsbereichs und zurück.</summary>
    public class Workspace
    {
        public string Root { get; }
        public Workspace(string root) { Root = Path.GetFullPath(root); }

        public string LocalPath(string serverPath)
        {
            string rel = (serverPath ?? "").Replace('/', Path.DirectorySeparatorChar).TrimStart(Path.DirectorySeparatorChar);
            string full = Path.GetFullPath(Path.Combine(Root, rel));
            if (!full.StartsWith(Root, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Pfad außerhalb des Arbeitsbereichs");
            return full;
        }

        public bool Contains(string localPath) =>
            !string.IsNullOrEmpty(localPath) && Path.GetFullPath(localPath).StartsWith(Root, StringComparison.OrdinalIgnoreCase);

        /// <summary>Schreibschutz für nicht ausgecheckte Dateien – verhindert versehentliches Überschreiben.</summary>
        public static void SetReadOnly(string file, bool readOnly)
        {
            if (!File.Exists(file)) return;
            var a = File.GetAttributes(file);
            File.SetAttributes(file, readOnly ? a | FileAttributes.ReadOnly : a & ~FileAttributes.ReadOnly);
        }
    }
}
