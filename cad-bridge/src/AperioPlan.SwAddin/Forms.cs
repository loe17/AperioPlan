using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using AperioPlan.Core;

namespace AperioPlan.SwAddin
{
    /// <summary>Gemeinsamer Aufbau der Dialoge: Formularzeilen + OK/Abbrechen.</summary>
    internal abstract class DialogBase : Form
    {
        protected readonly TableLayoutPanel Grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoScroll = true, Padding = new Padding(12) };
        protected readonly Button Ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Width = 110, Height = 30 };
        protected readonly Button Cancel = new Button { Text = "Abbrechen", DialogResult = DialogResult.Cancel, Width = 110, Height = 30 };
        protected readonly Label Error = new Label { ForeColor = Color.Firebrick, AutoSize = true, Padding = new Padding(12, 0, 0, 0) };

        protected DialogBase(string title, int width = 560, int height = 520)
        {
            Text = title;
            Font = new Font("Segoe UI", 9.5f);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = MaximizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(width, height);
            Grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
            Grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 48, Padding = new Padding(8) };
            buttons.Controls.Add(Cancel);
            buttons.Controls.Add(Ok);
            Controls.Add(Grid);
            Controls.Add(Error);
            Error.Dock = DockStyle.Bottom;
            Controls.Add(buttons);
            AcceptButton = Ok;
            CancelButton = Cancel;
            Ok.Click += (s, e) =>
            {
                string err = Validate2();
                if (err != null) { Error.Text = err; DialogResult = DialogResult.None; }
            };
        }

        /// <summary>Prüft die Eingaben; Rückgabe = Fehlermeldung oder null.</summary>
        protected virtual string Validate2() => null;

        protected T Row<T>(string label, T control, bool required = false) where T : Control
        {
            var l = new Label { Text = label + (required ? " *" : ""), AutoSize = true, Anchor = AnchorStyles.Left, Padding = new Padding(0, 6, 0, 0) };
            control.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            Grid.Controls.Add(l);
            Grid.Controls.Add(control);
            return control;
        }

        protected void Heading(string text)
        {
            var l = new Label { Text = text, AutoSize = true, Font = new Font(Font, FontStyle.Bold), Padding = new Padding(0, 10, 0, 2) };
            Grid.Controls.Add(l);
            Grid.SetColumnSpan(l, 2);
        }

        protected void Info(string text)
        {
            var l = new Label { Text = text, AutoSize = true, ForeColor = Color.DimGray, MaximumSize = new Size(ClientSize.Width - 40, 0) };
            Grid.Controls.Add(l);
            Grid.SetColumnSpan(l, 2);
        }
    }

    /// <summary>
    /// Die Speichermaske – Felder, Pflichtfelder und Kataloge legt der Administrator im Web fest.
    /// </summary>
    internal class SaveMaskForm : DialogBase
    {
        private readonly ApiClient _api;
        private readonly SaveMask _mask;
        private readonly CadType _type;
        private readonly ComboBox _project = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly ComboBox _sub = new ComboBox { DropDownStyle = ComboBoxStyle.DropDown };
        private readonly NumericUpDown _subsub = new NumericUpDown { Minimum = 0, Maximum = 99, Width = 80 };
        private readonly TextBox _designation = new TextBox();
        private readonly ComboBox _procurement = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly CheckBox _drawing = new CheckBox { Text = "Passende 2D-Zeichnung (.slddrw) gleich mit anlegen", AutoSize = true };
        private readonly Label _preview = new Label { AutoSize = true, Font = new Font("Consolas", 11f, FontStyle.Bold), ForeColor = Color.FromArgb(79, 70, 229) };
        private readonly Dictionary<MaskField, Control> _fields = new Dictionary<MaskField, Control>();
        private readonly Timer _previewTimer = new Timer { Interval = 300 };

        public string ProjectId => (_project.SelectedItem as Project)?.Id;
        public int Sub => int.TryParse(new string((_sub.Text ?? "").TakeWhile(char.IsDigit).ToArray()), out int v) ? v : 0;
        public int SubSub => (int)_subsub.Value;
        public string Designation => _designation.Text.Trim();
        public string Procurement => new[] { "make", "buy", "standard" }[Math.Max(0, _procurement.SelectedIndex)];
        public bool CreateDrawing => _type != CadType.Drawing && _drawing.Checked;
        public Dictionary<string, string> Properties => _fields.ToDictionary(f => f.Key.Key, f => ValueOf(f.Value));

        public SaveMaskForm(ApiClient api, SaveMask mask, List<Project> projects, CadType type, string lastProjectId, Dictionary<string, string> existing, string title)
            : base($"AperioPlan – Speichermaske ({(type == CadType.Assembly ? "Baugruppe" : "Teil")})", 600, 640)
        {
            _api = api; _mask = mask; _type = type;
            Heading("Nummer");
            foreach (var p in projects) _project.Items.Add(p);
            _project.SelectedItem = projects.FirstOrDefault(p => p.Id == lastProjectId) ?? projects.FirstOrDefault();
            Row("Projekt", _project, true);
            foreach (var s in mask.Subassemblies) _sub.Items.Add($"{s.Key} – {s.Value}");
            if (_sub.Items.Count > 0) _sub.SelectedIndex = 0; else _sub.Text = "100";
            Row("Unterbaugruppe", _sub, true);
            Row("Unter-Unterbaugruppe", _subsub);
            _designation.Text = existing.TryGetValue("Benennung1", out var b1) ? b1 : CleanTitle(title);
            Row("Sprechende Benennung", _designation, true);
            _procurement.Items.AddRange(new object[] { "Eigenfertigung", "Kaufteil", "Normteil" });
            _procurement.SelectedIndex = 0;
            Row("Beschaffungsart", _procurement, true);
            Row("Dateiname", _preview);

            Heading("Eigenschaften (werden in den Schriftkopf übernommen)");
            foreach (var f in mask.Fields.Where(f => f.AppliesToType(type)))
            {
                Control c;
                if (f.Type == "select")
                {
                    var cb = new ComboBox { DropDownStyle = ComboBoxStyle.DropDown, AutoCompleteMode = AutoCompleteMode.SuggestAppend, AutoCompleteSource = AutoCompleteSource.ListItems };
                    var cat = mask.FindCatalog(f.Catalog);
                    if (cat != null) cb.Items.AddRange(cat.Values.Cast<object>().ToArray());
                    c = cb;
                }
                else if (f.Type == "checkbox") c = new CheckBox { AutoSize = true };
                else if (f.Type == "textarea") c = new TextBox { Multiline = true, Height = 54 };
                else c = new TextBox();
                string initial = existing.TryGetValue(f.Key, out var ev) ? ev : f.Key == "Gezeichnet" ? mask.UserDisplayName : f.DefaultValue;
                SetValue(c, initial);
                _fields[f] = Row(f.Label, c, f.Required);
            }
            if (type != CadType.Drawing)
            {
                _drawing.Checked = mask.AskCreateDrawing;
                Grid.Controls.Add(new Label());
                Grid.Controls.Add(_drawing);
            }
            _procurement.SelectedIndexChanged += (s, e) =>
            {
                var fb = _fields.FirstOrDefault(x => x.Key.Key == "Beschaffung").Value;
                if (fb != null) SetValue(fb, (string)_procurement.SelectedItem);
                if (Procurement != "make") _drawing.Checked = false;
            };
            EventHandler changed = (s, e) => { _previewTimer.Stop(); _previewTimer.Start(); };
            _project.SelectedIndexChanged += changed; _sub.TextChanged += changed; _subsub.ValueChanged += changed; _designation.TextChanged += changed;
            _previewTimer.Tick += (s, e) => { _previewTimer.Stop(); UpdatePreview(); };
            Shown += (s, e) => UpdatePreview();
        }

        private static string CleanTitle(string t) => System.IO.Path.GetFileNameWithoutExtension(t ?? "").Replace("Teil", "").Replace("Part", "").Replace("Baugruppe", "").Replace("Assem", "").Trim(' ', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0');

        private void UpdatePreview()
        {
            if (ProjectId == null) return;
            try
            {
                string ext = _type == CadType.Assembly ? ".sldasm" : ".sldprt";
                _preview.Text = _api.PreviewNumber(ProjectId, Sub, SubSub, string.IsNullOrEmpty(Designation) ? "Benennung" : Designation) + ext;
            }
            catch (Exception ex) { _preview.Text = "–  " + ex.Message; }
        }

        protected override string Validate2()
        {
            if (ProjectId == null) return "Bitte ein Projekt wählen";
            if (string.IsNullOrEmpty(Designation)) return "Bitte eine Benennung eingeben";
            var missing = _fields.Where(f => f.Key.Required && string.IsNullOrWhiteSpace(ValueOf(f.Value))).Select(f => f.Key.Label).ToList();
            return missing.Count > 0 ? "Pflichtfelder fehlen: " + string.Join(", ", missing) : null;
        }

        private static string ValueOf(Control c) => c is CheckBox cb ? (cb.Checked ? "Ja" : "Nein") : c.Text.Trim();
        private static void SetValue(Control c, string v)
        {
            if (c is CheckBox cb) cb.Checked = v == "Ja";
            else c.Text = v ?? "";
        }
    }

    internal class CheckinForm : DialogBase
    {
        private readonly TextBox _comment = new TextBox { Multiline = true, Height = 70 };
        private readonly CheckBox _keep = new CheckBox { Text = "Ausgecheckt lassen (weiter bearbeiten)", AutoSize = true };
        private readonly CheckBox _review = new CheckBox { Text = "Anschließend zur Prüfung geben", AutoSize = true };
        public string Comment => _comment.Text.Trim();
        public bool KeepCheckedOut => _keep.Checked;
        public bool RequestReview => _review.Checked && !_keep.Checked;

        public CheckinForm(CadItem item) : base("Einchecken – " + item.Number, 520, 260)
        {
            Info(item.Number + "  ·  " + item.Designation);
            Row("Kommentar", _comment);
            Grid.Controls.Add(new Label()); Grid.Controls.Add(_keep);
            Grid.Controls.Add(new Label()); Grid.Controls.Add(_review);
        }
    }

    internal class ReviseForm : DialogBase
    {
        private readonly TextBox _reason = new TextBox { Multiline = true, Height = 70 };
        public string Reason => _reason.Text.Trim();

        public ReviseForm(CadItem item, List<Dictionary<string, object>> usedIn) : base("Neuer Versionsstand", 560, 400)
        {
            string next = (item.Revision + 1).ToString("00");
            Info($"{item.Number}  →  {item.BaseNumber}-{next}_{item.Designation}");
            Row("Grund der Änderung", _reason, true);
            Info("Beispiel: Bohrungsdurchmesser auf 12 mm vergrößert wegen stärkerer Welle");
            if (usedIn.Count > 0)
            {
                Heading($"Achtung: verwendet in {usedIn.Count} Baugruppe(n):");
                var list = new ListBox { Height = 120 };
                foreach (var u in usedIn) list.Items.Add($"{new string(' ', 2 * (u.Int("depth") - 1))}{u.Str("number")}  ({u.Str("projectNumber")})");
                Grid.Controls.Add(list);
                Grid.SetColumnSpan(list, 2);
            }
        }

        protected override string Validate2() => Reason.Length < 3 ? "Bitte den Grund der Änderung angeben" : null;
    }

    internal class WhereUsedForm : DialogBase
    {
        public WhereUsedForm(CadItem item, List<Dictionary<string, object>> rows) : base("Wo verbaut? – " + item.Number, 640, 420)
        {
            Cancel.Visible = false;
            if (rows.Count == 0) { Info("Das Teil ist in keiner Baugruppe verbaut und kann gefahrlos geändert werden."); return; }
            var lv = new ListView { View = View.Details, FullRowSelect = true, Height = 300, Width = 600 };
            lv.Columns.Add("Ebene", 50); lv.Columns.Add("Baugruppe", 260); lv.Columns.Add("Menge", 60); lv.Columns.Add("Projekt", 120); lv.Columns.Add("Status", 90);
            foreach (var r in rows)
                lv.Items.Add(new ListViewItem(new[] { r.Int("depth").ToString(), r.Str("number"), r.Int("quantity").ToString(), r.Str("projectNumber"), CadItem.StateLabel(r.Str("state")) }));
            Grid.Controls.Add(lv);
            Grid.SetColumnSpan(lv, 2);
        }
    }

    internal class SettingsForm : DialogBase
    {
        private readonly BridgeSettings _s;
        private readonly TextBox _url = new TextBox();
        private readonly TextBox _token = new TextBox { UseSystemPasswordChar = true };
        private readonly TextBox _ws = new TextBox();
        private readonly CheckBox _intercept = new CheckBox { Text = "Jedes Speichern neuer Dateien über die Speichermaske leiten", AutoSize = true };

        public SettingsForm(BridgeSettings s) : base("AperioPlan CAD-Wächter – Einstellungen", 600, 330)
        {
            _s = s;
            Info("API-Schlüssel erzeugen: AperioPlan → Einstellungen → API-Schlüssel");
            _url.Text = s.ServerUrl; _token.Text = s.Token; _ws.Text = s.Workspace; _intercept.Checked = s.InterceptAllSaves;
            Row("Server-Adresse", _url, true);
            Row("API-Schlüssel", _token, true);
            Row("Lokaler Arbeitsbereich", _ws, true);
            Grid.Controls.Add(new Label()); Grid.Controls.Add(_intercept);
            var test = new Button { Text = "Verbindung testen", AutoSize = true };
            test.Click += (o, e) =>
            {
                try
                {
                    using (var api = new ApiClient(_url.Text.Trim(), _token.Text.Trim()))
                    {
                        var me = api.Me();
                        Error.ForeColor = Color.SeaGreen;
                        Error.Text = "Verbunden als " + me.Str("displayName");
                    }
                }
                catch (Exception ex) { Error.ForeColor = Color.Firebrick; Error.Text = ex.Message; }
            };
            Grid.Controls.Add(new Label()); Grid.Controls.Add(test);
        }

        protected override string Validate2()
        {
            if (!Uri.TryCreate(_url.Text.Trim(), UriKind.Absolute, out _)) return "Bitte eine gültige Adresse eingeben, z. B. https://plan.firma.de";
            if (string.IsNullOrWhiteSpace(_token.Text)) return "Bitte den API-Schlüssel eingeben";
            _s.ServerUrl = _url.Text.Trim();
            _s.Token = _token.Text.Trim();
            _s.Workspace = _ws.Text.Trim();
            _s.InterceptAllSaves = _intercept.Checked;
            System.IO.Directory.CreateDirectory(_s.Workspace);
            return null;
        }
    }
}
