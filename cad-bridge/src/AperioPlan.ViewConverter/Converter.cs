using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace AperioPlan.ViewConverter
{
    /// <summary>Ein CAD-Programm, das Dateien nach STEP umwandeln kann (über die Windows-Automatisierung)</summary>
    internal abstract class Converter
    {
        public abstract string Program { get; }
        protected abstract string ProgId { get; }
        public abstract string[] Formats { get; }
        protected object App;

        public bool Installed => OperatingSystem.IsWindows() && Type.GetTypeFromProgID(ProgId) != null;

        public static IEnumerable<Converter> All() => new Converter[] { new SolidWorks(), new Inventor(), new SolidEdge(), new Catia() };

        protected object Start()
        {
            if (App != null) return App;
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            App = Activator.CreateInstance(Type.GetTypeFromProgID(ProgId));
            return App;
        }

        public abstract void ToStep(string source, string target);

        /// <summary>Nach einem Absturz neu starten</summary>
        public void Reset() { try { Quit(); } catch { /* schon weg */ } App = null; }
        public virtual void Quit() { if (App != null) try { Call(App, "Quit"); } catch { /* egal */ } }

        // ------------------------------------------------------------ spät gebundene Aufrufe
        protected static object Call(object o, string name, params object[] args) => o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args);
        protected static object Get(object o, string name, params object[] args) => o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, args);
        protected static void Set(object o, string name, object value) => o.GetType().InvokeMember(name, BindingFlags.SetProperty, null, o, new[] { value });
        /// <summary>Aufruf mit Rückgabe-Parametern (ref): die betroffenen Stellen werden nach dem Aufruf aus args gelesen</summary>
        protected static object CallRef(object o, string name, object[] args, params int[] byRef)
        {
            var mods = new ParameterModifier(args.Length);
            foreach (int i in byRef) mods[i] = true;
            return o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args, new[] { mods }, null, null);
        }
        protected static string Ext(string path) => Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
    }

    /// <summary>SolidWorks: Teile und Baugruppen öffnen, Parasolid/ACIS/JT importieren, als STEP speichern</summary>
    internal sealed class SolidWorks : Converter
    {
        public override string Program => "SolidWorks";
        protected override string ProgId => "SldWorks.Application";
        public override string[] Formats => new[] { "sldprt", "sldasm", "x_t", "x_b", "sat", "sab", "jt" };

        public override void ToStep(string source, string target)
        {
            var sw = Start();
            Set(sw, "Visible", false);
            Set(sw, "UserControl", false);
            string ext = Ext(source);
            object doc;
            if (ext == "sldprt" || ext == "sldasm")
            {
                int type = ext == "sldasm" ? 2 : 1;                 // swDocPART = 1, swDocASSEMBLY = 2
                var args = new object[] { source, type, 1 | 2, "", 0, 0 }; // swOpenDocOptions_Silent | ReadOnly
                doc = CallRef(sw, "OpenDoc6", args, 4, 5);
                if (doc == null) throw new InvalidOperationException($"SolidWorks konnte die Datei nicht öffnen (Fehler {args[4]}).");
            }
            else
            {
                var args = new object[] { source, "r", null, 0 };
                doc = CallRef(sw, "LoadFile4", args, 3);
                if (doc == null) throw new InvalidOperationException($"SolidWorks konnte die Datei nicht einlesen (Fehler {args[3]}).");
            }
            try
            {
                int err = Convert.ToInt32(Call(doc, "SaveAs3", target, 0, 1 | 2)); // aktuelle Version, still, als Kopie
                if (err != 0 && !File.Exists(target)) throw new InvalidOperationException($"SolidWorks konnte nicht als STEP speichern (Fehler {err}).");
            }
            finally { try { Call(sw, "CloseDoc", Get(doc, "GetTitle")); } catch { /* egal */ } }
        }

        public override void Quit() { if (App != null) try { Call(App, "ExitApp"); } catch { /* egal */ } }
    }

    /// <summary>Inventor: über den STEP-Übersetzer speichern</summary>
    internal sealed class Inventor : Converter
    {
        public override string Program => "Inventor";
        protected override string ProgId => "Inventor.Application";
        public override string[] Formats => new[] { "ipt", "iam" };
        private const string StepTranslator = "{90AF7F40-0C01-11D5-8E83-0010B541CD80}";

        public override void ToStep(string source, string target)
        {
            var inv = Start();
            Set(inv, "Visible", false);
            Set(inv, "SilentOperation", true);
            var doc = Call(Get(inv, "Documents"), "Open", source, false);
            try
            {
                var addin = Get(Get(inv, "ApplicationAddIns"), "ItemById", StepTranslator);
                var trans = Get(inv, "TransientObjects");
                var context = Call(trans, "CreateTranslationContext");
                Set(context, "Type", 13059);                          // kFileBrowseIOMechanism
                var options = Call(trans, "CreateNameValueMap");
                if (Convert.ToBoolean(Call(addin, "HasSaveCopyAsOptions", doc, context, options)))
                    Call(options, "Add", "ApplicationProtocolType", 3); // AP 214
                var data = Call(trans, "CreateDataMedium");
                Set(data, "FileName", target);
                Call(addin, "SaveCopyAs", doc, context, options, data);
            }
            finally { try { Call(doc, "Close", true); } catch { /* egal */ } }
        }
    }

    /// <summary>Solid Edge: „Speichern unter“ mit Endung .stp nutzt den STEP-Übersetzer</summary>
    internal sealed class SolidEdge : Converter
    {
        public override string Program => "Solid Edge";
        protected override string ProgId => "SolidEdge.Application";
        public override string[] Formats => new[] { "par", "psm", "asm", "x_t", "x_b", "jt" };

        public override void ToStep(string source, string target)
        {
            var se = Start();
            Set(se, "Visible", false);
            Set(se, "DisplayAlerts", false);
            var doc = Call(Get(se, "Documents"), "Open", source);
            try { Call(doc, "SaveCopyAs", target); }
            finally { try { Call(doc, "Close", false); } catch { /* egal */ } }
        }
    }

    /// <summary>CATIA V5: ExportData im Format „stp“</summary>
    internal sealed class Catia : Converter
    {
        public override string Program => "CATIA V5";
        protected override string ProgId => "CATIA.Application";
        public override string[] Formats => new[] { "catpart", "catproduct" };

        public override void ToStep(string source, string target)
        {
            var cat = Start();
            Set(cat, "Visible", false);
            Set(cat, "DisplayFileAlerts", false);
            var doc = Call(Get(cat, "Documents"), "Open", source);
            try { Call(doc, "ExportData", target, "stp"); }
            finally { try { Call(doc, "Close"); } catch { /* egal */ } }
        }
    }
}
