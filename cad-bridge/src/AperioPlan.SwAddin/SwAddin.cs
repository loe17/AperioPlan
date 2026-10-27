using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using AperioPlan.Core;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
using SolidWorks.Interop.swpublished;

namespace AperioPlan.SwAddin
{
    /// <summary>
    /// AperioPlan CAD-Wächter: klinkt sich in SolidWorks ein, fängt das Speichern ab und öffnet die
    /// Speichermaske der Projektverwaltung. Vergibt Nummern (0100-100-00-0000-00_Benennung), schreibt die
    /// Eigenschaften in die Datei (Schriftkopf), legt auf Wunsch die passende Zeichnung an und regelt
    /// Auschecken/Einchecken, Versionsstände und Freigaben.
    /// </summary>
    [ComVisible(true)]
    [Guid("b581e74a-99d2-4a1e-836f-49f20c1a8b92")]
    [ProgId("AperioPlan.SwAddin")]
    public class SwAddin : ISwAddin
    {
        private const int CommandGroupId = 4711;
        private const string Title = "AperioPlan CAD-Wächter";

        private SldWorks _sw;
        private int _cookie;
        private ICommandManager _cmdMgr;
        private BridgeSettings _settings;
        private readonly Dictionary<ModelDoc2, DocWatcher> _watchers = new Dictionary<ModelDoc2, DocWatcher>();
        private SaveMask _maskCache;
        private DateTime _maskLoaded;

        internal SldWorks Sw => _sw;
        internal BridgeSettings Settings => _settings;
        internal Workspace Workspace => new Workspace(_settings.Workspace);

        // ============================================================ Registrierung in SolidWorks
        [ComRegisterFunction]
        public static void RegisterFunction(Type t)
        {
            string key = @"SOFTWARE\SolidWorks\Addins\{" + t.GUID.ToString() + "}";
            using (var k = Registry.LocalMachine.CreateSubKey(key))
            {
                k.SetValue(null, 1);
                k.SetValue("Description", "Speichermaske, Nummernvergabe und PDM-Funktionen der AperioPlan-Projektverwaltung");
                k.SetValue("Title", Title);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\SolidWorks\AddInsStartup\{" + t.GUID.ToString() + "}"))
                k.SetValue(null, 1);
        }

        [ComUnregisterFunction]
        public static void UnregisterFunction(Type t)
        {
            Registry.LocalMachine.DeleteSubKey(@"SOFTWARE\SolidWorks\Addins\{" + t.GUID.ToString() + "}", false);
            Registry.CurrentUser.DeleteSubKey(@"Software\SolidWorks\AddInsStartup\{" + t.GUID.ToString() + "}", false);
        }

        // ============================================================ Verbinden / Trennen
        public bool ConnectToSW(object thisSw, int cookie)
        {
            _sw = (SldWorks)thisSw;
            _cookie = cookie;
            _sw.SetAddinCallbackInfo2(0, this, cookie);
            _settings = BridgeSettings.Load();
            _cmdMgr = _sw.GetCommandManager(cookie);
            AddCommands();
            _sw.ActiveModelDocChangeNotify += OnActiveDocChanged;
            _sw.DocumentLoadNotify2 += OnDocumentLoaded;
            _sw.FileNewNotify2 += OnFileNew;
            AttachAllOpenDocuments();
            return true;
        }

        public bool DisconnectFromSW()
        {
            foreach (var w in _watchers.Values.ToList()) w.Detach();
            _watchers.Clear();
            _sw.ActiveModelDocChangeNotify -= OnActiveDocChanged;
            _sw.DocumentLoadNotify2 -= OnDocumentLoaded;
            _sw.FileNewNotify2 -= OnFileNew;
            _cmdMgr.RemoveCommandGroup(CommandGroupId);
            Marshal.ReleaseComObject(_cmdMgr);
            _cmdMgr = null;
            _sw = null;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            return true;
        }

        private void AddCommands()
        {
            int err = 0;
            var grp = _cmdMgr.CreateCommandGroup2(CommandGroupId, "AperioPlan", "AperioPlan Projektverwaltung", "AperioPlan", -1, true, ref err);
            int menuOnly = (int)swCommandItemType_e.swMenuItem;
            int both = (int)(swCommandItemType_e.swMenuItem | swCommandItemType_e.swToolbarItem);
            grp.AddCommandItem2("Auschecken", -1, "Datei zum Bearbeiten sperren", "Auschecken", 0, nameof(CmdCheckout), nameof(EnableIfManaged), 1, both);
            grp.AddCommandItem2("Einchecken …", -1, "Datei mit Kommentar auf den Server hochladen", "Einchecken", 1, nameof(CmdCheckin), nameof(EnableIfManaged), 2, both);
            grp.AddCommandItem2("Sperre aufheben", -1, "Auschecken rückgängig machen", "Sperre aufheben", 2, nameof(CmdUndoCheckout), nameof(EnableIfManaged), 3, menuOnly);
            grp.AddCommandItem2("Neuer Versionsstand …", -1, "Versionsstand hochzählen (00 → 01) mit Begründung", "Neuer Versionsstand", 3, nameof(CmdRevise), nameof(EnableIfManaged), 4, both);
            grp.AddCommandItem2("Zur Prüfung geben", -1, "Freigabe-Workflow: In Arbeit → Prüfung", "Zur Prüfung", 4, nameof(CmdReview), nameof(EnableIfManaged), 5, menuOnly);
            grp.AddCommandItem2("Wo verbaut?", -1, "Verwendungsnachweis anzeigen", "Wo verbaut?", 5, nameof(CmdWhereUsed), nameof(EnableIfManaged), 6, both);
            grp.AddCommandItem2("Zeichnung anlegen", -1, "Passende 2D-Zeichnung mit gleicher Nummer anlegen", "Zeichnung anlegen", 6, nameof(CmdCreateDrawing), nameof(EnableIfManagedModel), 7, menuOnly);
            grp.AddCommandItem2("Im Browser öffnen", -1, "Teil in der CAD-Zentrale anzeigen", "Im Browser öffnen", 7, nameof(CmdOpenInBrowser), nameof(EnableIfManaged), 8, menuOnly);
            grp.AddCommandItem2("Einstellungen …", -1, "Server-Adresse, API-Schlüssel, Arbeitsbereich", "Einstellungen", 8, nameof(CmdSettings), "", 9, menuOnly);
            grp.HasToolbar = true;
            grp.HasMenu = true;
            grp.Activate();
        }

        // ============================================================ Dokument-Ereignisse
        private int OnActiveDocChanged()
        {
            AttachAllOpenDocuments();
            return 0;
        }

        private int OnDocumentLoaded(string docTitle, string docPath)
        {
            AttachAllOpenDocuments();
            if (string.IsNullOrEmpty(docPath)) return 0;
            var doc = _sw.GetOpenDocumentByName(docPath) as ModelDoc2;
            if (doc != null) ApplyLockState(doc);
            return 0;
        }

        private int OnFileNew(object newDoc, int docType, string templateName)
        {
            AttachAllOpenDocuments();
            return 0;
        }

        private void AttachAllOpenDocuments()
        {
            var doc = _sw.GetFirstDocument() as ModelDoc2;
            while (doc != null)
            {
                if (!_watchers.ContainsKey(doc)) _watchers[doc] = new DocWatcher(this, doc);
                doc = doc.GetNext() as ModelDoc2;
            }
        }

        internal void Detached(ModelDoc2 doc) => _watchers.Remove(doc);

        /// <summary>Nicht ausgecheckte, verwaltete Dateien werden schreibgeschützt geöffnet.</summary>
        private void ApplyLockState(ModelDoc2 doc)
        {
            if (!_settings.IsConfigured) return;
            try
            {
                var item = ResolveDoc(doc);
                if (item == null) return;
                bool mine = item.CheckedOutBy != null && item.CheckedOutBy == MyUserId();
                if (!mine && !doc.IsOpenedReadOnly()) doc.SetReadOnlyState(true);
            }
            catch { /* offline – kein Schreibschutz erzwingen */ }
        }

        // ============================================================ Speichern abfangen
        /// <summary>Vor "Speichern unter" / erstem Speichern. Rückgabe 1 bricht das Speichern in SolidWorks ab.</summary>
        internal int BeforeSaveAs(ModelDoc2 doc, string targetFile)
        {
            if (!_settings.IsConfigured || !_settings.InterceptAllSaves) return 0;
            string current = doc.GetPathName();
            var targetName = Path.GetFileName(targetFile ?? "");
            // Ziel ist bereits eine vergebene Nummer (z. B. eigenes Speichern durch den Wächter) → zulassen
            if (Bridge.IsSavingInternally) return 0;
            if (!string.IsNullOrEmpty(current) && string.Equals(Path.GetFullPath(current), Path.GetFullPath(targetFile ?? current), StringComparison.OrdinalIgnoreCase))
                return BeforeSave(doc);
            // Neues Dokument oder Kopie → Speichermaske
            Defer(() => ShowSaveMask(doc));
            return 1;
        }

        /// <summary>Vor dem normalen Speichern (Strg+S) einer bestehenden Datei.</summary>
        internal int BeforeSave(ModelDoc2 doc)
        {
            if (!_settings.IsConfigured || Bridge.IsSavingInternally) return 0;
            string path = doc.GetPathName();
            if (string.IsNullOrEmpty(path))
            {
                Defer(() => ShowSaveMask(doc));
                return 1;
            }
            CadItem item;
            try { item = ResolveDoc(doc); }
            catch (Exception e)
            {
                // Server nicht erreichbar: lokal speichern erlauben, Einchecken später
                _sw.SendMsgToUser2("AperioPlan nicht erreichbar – die Datei wird nur lokal gespeichert.\n" + e.Message,
                    (int)swMessageBoxIcon_e.swMbWarning, (int)swMessageBoxBtn_e.swMbOk);
                return 0;
            }
            if (item == null)
            {
                if (!_settings.InterceptAllSaves || !Workspace.Contains(path)) return 0;
                Defer(() => ShowSaveMask(doc));
                return 1;
            }
            if (item.IsReleased || item.State == "obsolete")
            {
                Msg($"{item.Number} ist {CadItem.StateLabel(item.State)} und schreibgeschützt.\nFür Änderungen bitte „Neuer Versionsstand“ verwenden.", swMessageBoxIcon_e.swMbStop);
                return 1;
            }
            if (item.CheckedOutBy == MyUserId()) return 0;
            if (item.CheckedOutBy != null)
            {
                Msg($"Gesperrt durch {item.CheckedOutByName}.\nDie Datei kann nicht überschrieben werden.", swMessageBoxIcon_e.swMbStop);
                return 1;
            }
            if (Ask($"{item.Number} ist nicht ausgecheckt.\nJetzt auschecken und speichern?"))
            {
                try
                {
                    using (var api = Api()) api.Checkout(item.Id, Environment.MachineName);
                    Workspace.SetReadOnly(path, false);
                    return 0;
                }
                catch (Exception e) { Msg(e.Message, swMessageBoxIcon_e.swMbStop); }
            }
            return 1;
        }

        private void ShowSaveMask(ModelDoc2 doc)
        {
            var type = DocType(doc);
            if (type == null) return;
            using (var api = Api())
            {
                try
                {
                    if (type == CadType.Drawing) { SaveNewDrawing(api, doc); return; }
                    var mask = Mask(api);
                    var projects = api.Projects();
                    var existingProps = SwHelpers.ReadCustomProperties(doc);
                    using (var form = new SaveMaskForm(api, mask, projects, type.Value, _settings.LastProjectId, existingProps, doc.GetTitle()))
                    {
                        if (form.ShowDialog(new SwWindow(_sw)) != DialogResult.OK) return;
                        _settings.LastProjectId = form.ProjectId;
                        _settings.Save();
                        var result = api.CreateItem(form.ProjectId, type.Value, form.Sub, form.SubSub, form.Designation, form.Procurement,
                            form.Properties, form.CreateDrawing, Environment.MachineName);
                        string local = Workspace.LocalPath(result.Item.FilePath);
                        SwHelpers.WriteCustomProperties(doc, result.CustomProperties);
                        SwHelpers.SaveAs(doc, local);
                        api.Checkin(result.Item.Id, local, "Urversion", null, type == CadType.Assembly ? SwHelpers.CollectReferences(doc) : null, keepCheckedOut: true);
                        string message = $"Nummer vergeben:\n{result.Item.Number}";
                        if (result.Drawing != null)
                        {
                            string dwgPath = Workspace.LocalPath(result.Drawing.FilePath);
                            var props = api.CustomProperties(result.Drawing.Id);
                            var dwg = SwHelpers.CreateDrawing(_sw, local, dwgPath, result.DrawingTemplate, props);
                            if (dwg != null)
                            {
                                api.Checkin(result.Drawing.Id, dwgPath, "Urversion", null, null, keepCheckedOut: true);
                                message += $"\n\nZeichnung angelegt:\n{Path.GetFileName(dwgPath)}";
                            }
                        }
                        SetStatus(message.Replace("\n", " "));
                        Msg(message, swMessageBoxIcon_e.swMbInformation);
                    }
                }
                catch (Exception e) { Msg("Speichern über AperioPlan fehlgeschlagen:\n" + e.Message, swMessageBoxIcon_e.swMbStop); }
            }
        }

        /// <summary>Neue Zeichnung: Nummer vom referenzierten Modell übernehmen.</summary>
        private void SaveNewDrawing(ApiClient api, ModelDoc2 doc)
        {
            string model = SwHelpers.FirstReferencedModel(doc);
            var modelItem = model == null ? null : api.Resolve(Path.GetFileName(model));
            if (modelItem == null)
            {
                Msg("Die Zeichnung zeigt kein in AperioPlan verwaltetes Modell.\nBitte zuerst das Teil bzw. die Baugruppe über die Speichermaske speichern.", swMessageBoxIcon_e.swMbWarning);
                return;
            }
            if (modelItem.DrawingId != null)
            {
                Msg($"Für {modelItem.Number} existiert bereits eine Zeichnung.", swMessageBoxIcon_e.swMbWarning);
                return;
            }
            var r = api.CreateItem(modelItem.ProjectId, CadType.Drawing, 0, 0, modelItem.Designation, modelItem.Procurement, modelItem.Properties, false, Environment.MachineName, modelItem.Id);
            string local = Workspace.LocalPath(r.Item.FilePath);
            SwHelpers.WriteCustomProperties(doc, r.CustomProperties);
            SwHelpers.SaveAs(doc, local);
            api.Checkin(r.Item.Id, local, "Urversion", null, null, keepCheckedOut: true);
            Msg($"Zeichnung gespeichert:\n{r.Item.Number}", swMessageBoxIcon_e.swMbInformation);
        }

        // ============================================================ Befehle (Menü / Symbolleiste)
        public int EnableIfManaged() => ActiveDoc() != null && !string.IsNullOrEmpty(ActiveDoc().GetPathName()) ? 1 : 0;
        public int EnableIfManagedModel() => ActiveDoc() != null && DocType(ActiveDoc()) != CadType.Drawing ? EnableIfManaged() : 0;

        public void CmdCheckout() => WithItem((api, doc, item) =>
        {
            if (item.CheckedOutBy == MyUserId()) { Msg("Bereits von Ihnen ausgecheckt.", swMessageBoxIcon_e.swMbInformation); return; }
            var r = api.Checkout(item.Id, Environment.MachineName);
            string local = doc.GetPathName();
            // Neuesten Stand vom Server holen, falls lokal veraltet
            string tmp = local + ".aperio";
            try
            {
                api.Download($"/cad/items/{r.Id}/download", tmp);
                if (!SwHelpers.SameContent(tmp, local))
                {
                    _sw.CloseDoc(doc.GetTitle());
                    Workspace.SetReadOnly(local, false);
                    File.Copy(tmp, local, true);
                    int e = 0, w = 0;
                    _sw.OpenDoc6(local, (int)SwHelpers.SwDocType(item.CadType), (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref e, ref w);
                }
            }
            catch (ApiException ex) when (ex.Status == 404) { /* noch keine Datei auf dem Server */ }
            finally { if (File.Exists(tmp)) File.Delete(tmp); }
            Workspace.SetReadOnly(local, false);
            (_sw.ActiveDoc as ModelDoc2)?.SetReadOnlyState(false);
            SetStatus($"{r.Number} ausgecheckt");
        });

        public void CmdCheckin() => WithItem((api, doc, item) =>
        {
            if (item.CheckedOutBy != MyUserId()) { Msg("Die Datei ist nicht von Ihnen ausgecheckt.", swMessageBoxIcon_e.swMbWarning); return; }
            using (var form = new CheckinForm(item))
            {
                if (form.ShowDialog(new SwWindow(_sw)) != DialogResult.OK) return;
                if (doc.GetSaveFlag()) SwHelpers.Save(doc);
                var props = api.CustomProperties(item.Id);
                SwHelpers.WriteCustomProperties(doc, props);
                SwHelpers.Save(doc);
                var refs = item.CadType == CadType.Assembly ? SwHelpers.CollectReferences(doc) : null;
                var unknown = api.Checkin(item.Id, doc.GetPathName(), form.Comment, null, refs, form.KeepCheckedOut);
                if (form.RequestReview) api.SetState(item.Id, "review", form.Comment);
                if (!form.KeepCheckedOut)
                {
                    Workspace.SetReadOnly(doc.GetPathName(), true);
                    doc.SetReadOnlyState(true);
                }
                string msg = $"{item.Number} eingecheckt.";
                if (unknown.Count > 0) msg += "\n\nNicht verwaltete Komponenten (nicht in der Stückliste):\n" + string.Join("\n", unknown.Take(15));
                Msg(msg, swMessageBoxIcon_e.swMbInformation);
            }
        });

        public void CmdUndoCheckout() => WithItem((api, doc, item) =>
        {
            if (!Ask($"Sperre von {item.Number} aufheben? Lokale Änderungen werden nicht hochgeladen.")) return;
            api.UndoCheckout(item.Id);
            Workspace.SetReadOnly(doc.GetPathName(), true);
            doc.SetReadOnlyState(true);
            SetStatus("Sperre aufgehoben");
        });

        public void CmdRevise() => WithItem((api, doc, item) =>
        {
            var used = api.WhereUsed(item.Id);
            using (var form = new ReviseForm(item, used))
            {
                if (form.ShowDialog(new SwWindow(_sw)) != DialogResult.OK) return;
                var r = api.Revise(item.Id, form.Reason, Environment.MachineName);
                string newLocal = Workspace.LocalPath(r.FilePath);
                var props = api.CustomProperties(r.Id);
                doc.SetReadOnlyState(false);
                SwHelpers.WriteCustomProperties(doc, props);
                SwHelpers.SaveAs(doc, newLocal);
                api.Checkin(r.Id, newLocal, form.Reason, null, r.CadType == CadType.Assembly ? SwHelpers.CollectReferences(doc) : null, keepCheckedOut: true);
                Msg($"Neuer Versionsstand: {r.Number}\n\nGeöffnete Baugruppen, die das Teil verwenden, bitte speichern und einchecken, damit sie auf den neuen Stand verweisen.", swMessageBoxIcon_e.swMbInformation);
            }
        });

        public void CmdReview() => WithItem((api, doc, item) =>
        {
            if (item.CheckedOutBy != null) { Msg("Bitte zuerst einchecken.", swMessageBoxIcon_e.swMbWarning); return; }
            var r = api.SetState(item.Id, "review", "");
            SetStatus($"{r.Number}: {CadItem.StateLabel(r.State)}");
            Msg($"{r.Number} wurde zur Prüfung gegeben.", swMessageBoxIcon_e.swMbInformation);
        });

        public void CmdWhereUsed() => WithItem((api, doc, item) =>
        {
            using (var form = new WhereUsedForm(item, api.WhereUsed(item.Id))) form.ShowDialog(new SwWindow(_sw));
        });

        public void CmdCreateDrawing() => WithItem((api, doc, item) =>
        {
            if (item.DrawingId != null) { Msg("Zeichnung existiert bereits.", swMessageBoxIcon_e.swMbInformation); return; }
            var r = api.CreateItem(item.ProjectId, CadType.Drawing, 0, 0, item.Designation, item.Procurement, item.Properties, false, Environment.MachineName, item.Id);
            string dwgPath = Workspace.LocalPath(r.Item.FilePath);
            var dwg = SwHelpers.CreateDrawing(_sw, doc.GetPathName(), dwgPath, Mask(api).DrawingTemplate, r.CustomProperties);
            if (dwg != null) api.Checkin(r.Item.Id, dwgPath, "Urversion", null, null, keepCheckedOut: true);
        });

        public void CmdOpenInBrowser() => WithItem((api, doc, item) => Process.Start(_settings.ServerUrl.TrimEnd('/') + "/cad?item=" + item.Id));

        public void CmdSettings()
        {
            using (var form = new SettingsForm(_settings))
            {
                if (form.ShowDialog(new SwWindow(_sw)) == DialogResult.OK)
                {
                    _settings.Save();
                    _maskCache = null;
                    _myUserId = null;
                }
            }
        }

        // ============================================================ Hilfen
        private ModelDoc2 ActiveDoc() => _sw?.ActiveDoc as ModelDoc2;

        private void WithItem(Action<ApiClient, ModelDoc2, CadItem> action)
        {
            if (!EnsureConfigured()) return;
            var doc = ActiveDoc();
            if (doc == null) return;
            try
            {
                using (var api = Api())
                {
                    var item = ResolveDoc(doc, api);
                    if (item == null) { Msg("Diese Datei wird nicht von AperioPlan verwaltet.", swMessageBoxIcon_e.swMbInformation); return; }
                    action(api, doc, item);
                }
            }
            catch (Exception e) { Msg(e.Message, swMessageBoxIcon_e.swMbStop); }
        }

        private bool EnsureConfigured()
        {
            if (_settings.IsConfigured) return true;
            CmdSettings();
            return _settings.IsConfigured;
        }

        internal ApiClient Api() => _settings.CreateClient();

        private string _myUserId;
        private string MyUserId()
        {
            if (_myUserId == null) using (var api = Api()) _myUserId = api.Me().Str("id");
            return _myUserId;
        }

        private SaveMask Mask(ApiClient api)
        {
            if (_maskCache == null || DateTime.Now - _maskLoaded > TimeSpan.FromMinutes(5)) { _maskCache = api.GetMask(); _maskLoaded = DateTime.Now; }
            return _maskCache;
        }

        private CadItem ResolveDoc(ModelDoc2 doc, ApiClient api = null)
        {
            string path = doc.GetPathName();
            if (string.IsNullOrEmpty(path)) return null;
            if (api != null) return api.Resolve(Path.GetFileName(path));
            using (var a = Api()) return a.Resolve(Path.GetFileName(path));
        }

        internal static CadType? DocType(ModelDoc2 doc)
        {
            switch ((swDocumentTypes_e)doc.GetType())
            {
                case swDocumentTypes_e.swDocPART: return CadType.Part;
                case swDocumentTypes_e.swDocASSEMBLY: return CadType.Assembly;
                case swDocumentTypes_e.swDocDRAWING: return CadType.Drawing;
                default: return null;
            }
        }

        /// <summary>Aktion nach Ende des aktuellen SolidWorks-Ereignisses ausführen (UI-Thread).</summary>
        private static void Defer(Action action)
        {
            var t = new Timer { Interval = 50 };
            t.Tick += (s, e) => { t.Stop(); t.Dispose(); action(); };
            t.Start();
        }

        private void Msg(string text, swMessageBoxIcon_e icon) => _sw.SendMsgToUser2(text, (int)icon, (int)swMessageBoxBtn_e.swMbOk);
        private bool Ask(string text) => _sw.SendMsgToUser2(text, (int)swMessageBoxIcon_e.swMbQuestion, (int)swMessageBoxBtn_e.swMbYesNo) == (int)swMessageBoxResult_e.swMbHitYes;
        private void SetStatus(string text) { try { ((Frame)_sw.Frame()).SetStatusBarText(text); } catch { /* ohne Statusleiste */ } }
    }

    /// <summary>Verbindet die Speichern-Ereignisse eines Dokuments mit dem Wächter.</summary>
    internal class DocWatcher
    {
        private readonly SwAddin _owner;
        private readonly ModelDoc2 _doc;

        public DocWatcher(SwAddin owner, ModelDoc2 doc)
        {
            _owner = owner;
            _doc = doc;
            switch (doc)
            {
                case PartDoc p:
                    p.FileSaveAsNotify2 += OnSaveAs; p.FileSaveNotify += OnSave; p.DestroyNotify2 += OnDestroy; break;
                case AssemblyDoc a:
                    a.FileSaveAsNotify2 += OnSaveAs; a.FileSaveNotify += OnSave; a.DestroyNotify2 += OnDestroy; break;
                case DrawingDoc d:
                    d.FileSaveAsNotify2 += OnSaveAs; d.FileSaveNotify += OnSave; d.DestroyNotify2 += OnDestroy; break;
            }
        }

        public void Detach()
        {
            switch (_doc)
            {
                case PartDoc p: p.FileSaveAsNotify2 -= OnSaveAs; p.FileSaveNotify -= OnSave; p.DestroyNotify2 -= OnDestroy; break;
                case AssemblyDoc a: a.FileSaveAsNotify2 -= OnSaveAs; a.FileSaveNotify -= OnSave; a.DestroyNotify2 -= OnDestroy; break;
                case DrawingDoc d: d.FileSaveAsNotify2 -= OnSaveAs; d.FileSaveNotify -= OnSave; d.DestroyNotify2 -= OnDestroy; break;
            }
        }

        private int OnSaveAs(string fileName) => Safe(() => _owner.BeforeSaveAs(_doc, fileName));
        private int OnSave(string fileName) => Safe(() => _owner.BeforeSave(_doc));
        private int OnDestroy(int destroyType)
        {
            Detach();
            _owner.Detached(_doc);
            return 0;
        }

        private static int Safe(Func<int> f)
        {
            try { return f(); }
            catch (Exception e) { MessageBox.Show(e.Message, "AperioPlan CAD-Wächter"); return 0; }
        }
    }

    /// <summary>SolidWorks-Hauptfenster als Besitzer für Dialoge.</summary>
    internal class SwWindow : IWin32Window
    {
        public SwWindow(SldWorks sw) { Handle = new IntPtr(((Frame)sw.Frame()).GetHWndx64()); }
        public IntPtr Handle { get; }
    }

    /// <summary>Kennzeichnet Speichervorgänge, die der Wächter selbst auslöst (nicht erneut abfangen).</summary>
    internal static class Bridge
    {
        [ThreadStatic] public static bool IsSavingInternally;
    }
}
