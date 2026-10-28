// AperioPlan Fernsteuerung – kleines Hilfsprogramm für Windows.
// Es läuft unten rechts im Infobereich, verbindet sich mit AperioPlan und führt Maus- und Tastatureingaben
// eines Kollegen aus – aber nur, nachdem Sie im Videoanruf ausdrücklich auf „Erlauben“ geklickt haben.
// Ein Klick auf „Steuerung beenden“ (hier, im Anruf oder per Strg+Alt+Pause) beendet die Fernsteuerung sofort.
using System;
using System.Drawing;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AperioPlan.RemoteHelper;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var single = new Mutex(true, "AperioPlan-Fernsteuerung", out var first);
        if (!first) { MessageBox.Show("Die AperioPlan Fernsteuerung läuft bereits (Symbol unten rechts).", "AperioPlan"); return; }
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp());
    }
}

internal sealed class Settings
{
    public string Server { get; set; } = "";
    public string Token { get; set; } = "";
    public int Screen { get; set; }

    private static string FilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AperioPlan", "fernsteuerung.json");

    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings(); }
        catch { return new Settings(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
    }
}

internal sealed class TrayApp : ApplicationContext
{
    private readonly NotifyIcon _icon = new();
    private readonly Settings _settings = Settings.Load();
    private readonly SynchronizationContext _ui;
    private readonly ToolStripMenuItem _status = new("Nicht verbunden") { Enabled = false };
    private readonly ToolStripMenuItem _stop = new("Steuerung beenden") { Enabled = false };
    private CancellationTokenSource _cts = new();
    private ClientWebSocket _ws;
    private string _controller;
    private readonly HotkeyWindow _hotkey;

    public TrayApp()
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        var menu = new ContextMenuStrip();
        menu.Items.Add(_status);
        menu.Items.Add(new ToolStripSeparator());
        _stop.Click += (_, _) => StopControl(true);
        menu.Items.Add(_stop);
        var screens = new ToolStripMenuItem("Bildschirm");
        for (var i = 0; i < Screen.AllScreens.Length; i++)
        {
            var idx = i;
            var s = Screen.AllScreens[i];
            var item = new ToolStripMenuItem($"{i + 1}: {s.Bounds.Width} × {s.Bounds.Height}{(s.Primary ? " (Haupt)" : "")}") { Checked = idx == _settings.Screen };
            item.Click += (_, _) => { _settings.Screen = idx; _settings.Save(); foreach (ToolStripMenuItem x in screens.DropDownItems) x.Checked = x == item; };
            screens.DropDownItems.Add(item);
        }
        menu.Items.Add(screens);
        menu.Items.Add("Verbindung einrichten …", null, (_, _) => Configure());
        menu.Items.Add("Beenden", null, (_, _) => { _cts.Cancel(); _icon.Visible = false; Application.Exit(); });
        _icon.ContextMenuStrip = menu;
        _icon.Icon = SystemIcons.Application;
        _icon.Text = "AperioPlan Fernsteuerung";
        _icon.Visible = true;
        _icon.DoubleClick += (_, _) => Configure();
        _hotkey = new HotkeyWindow(() => StopControl(true));
        if (string.IsNullOrWhiteSpace(_settings.Server) || string.IsNullOrWhiteSpace(_settings.Token)) Configure();
        else Start();
    }

    private void Configure()
    {
        using var f = new SetupForm(_settings);
        if (f.ShowDialog() != DialogResult.OK) return;
        _settings.Save();
        _cts.Cancel();
        _cts = new CancellationTokenSource();
        Start();
    }

    private void SetStatus(string text) => _ui.Post(_ => { _status.Text = text; _icon.Text = Truncate("AperioPlan Fernsteuerung – " + text, 63); }, null);
    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n];

    private void Start() => _ = Task.Run(() => Loop(_cts.Token));

    private async Task Loop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _ws = new ClientWebSocket();
                _ws.Options.SetRequestHeader("Authorization", "Bearer " + _settings.Token.Trim());
                var baseUrl = _settings.Server.Trim().TrimEnd('/');
                var wsUrl = baseUrl.Replace("https://", "wss://").Replace("http://", "ws://") + "/api/ws?client=remote-helper";
                SetStatus("Verbinde …");
                await _ws.ConnectAsync(new Uri(wsUrl), ct);
                SetStatus("Bereit – wartet auf Freigabe im Anruf");
                using var ping = new System.Threading.Timer(_ => _ = Send(new { type = "ping" }), null, 25000, 25000);
                var buf = new byte[64 * 1024];
                var sb = new StringBuilder();
                while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    var r = await _ws.ReceiveAsync(buf, ct);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                    if (!r.EndOfMessage) continue;
                    Handle(sb.ToString());
                    sb.Clear();
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception e) { SetStatus("Keine Verbindung: " + e.Message); }
            StopControl(false);
            try { await Task.Delay(5000, ct); } catch { break; }
        }
    }

    private async Task Send(object o)
    {
        try { if (_ws?.State == WebSocketState.Open) await _ws.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(o)), WebSocketMessageType.Text, true, CancellationToken.None); }
        catch { /* nächster Versuch */ }
    }

    private void Handle(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var ev = doc.RootElement.TryGetProperty("event", out var e) ? e.GetString() : null;
        var data = doc.RootElement.TryGetProperty("data", out var d) ? d : default;
        switch (ev)
        {
            case "remote.start":
                _controller = data.TryGetProperty("controller", out var c) ? c.GetString() : "?";
                _ui.Post(_ => { _stop.Enabled = true; _icon.ShowBalloonTip(4000, "AperioPlan", "Ein Kollege steuert jetzt Ihren Bildschirm. Beenden: Strg+Alt+Pause oder Rechtsklick auf dieses Symbol.", ToolTipIcon.Warning); }, null);
                SetStatus("Wird ferngesteuert");
                break;
            case "remote.stop":
                StopControl(false);
                break;
            case "remote.input" when _controller != null:
                var screen = Screen.AllScreens[Math.Clamp(_settings.Screen, 0, Screen.AllScreens.Length - 1)];
                Input.Apply(data, screen.Bounds);
                break;
        }
    }

    private void StopControl(bool tellServer)
    {
        if (_controller == null) return;
        _controller = null;
        Input.ReleaseAll();
        _ui.Post(_ => _stop.Enabled = false, null);
        SetStatus("Bereit – wartet auf Freigabe im Anruf");
        if (tellServer) _ = Send(new { type = "remote-stop-helper" });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { _icon.Dispose(); _hotkey.Dispose(); }
        base.Dispose(disposing);
    }
}

/// <summary>Notbremse Strg+Alt+Pause beendet die Fernsteuerung jederzeit</summary>
internal sealed class HotkeyWindow : NativeWindow, IDisposable
{
    private readonly Action _onHotkey;
    public HotkeyWindow(Action onHotkey)
    {
        _onHotkey = onHotkey;
        CreateHandle(new CreateParams());
        Native.RegisterHotKey(Handle, 1, 0x0001 | 0x0002, 0x13); // Alt + Strg + Pause
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312) _onHotkey();
        base.WndProc(ref m);
    }
    public void Dispose() { Native.UnregisterHotKey(Handle, 1); DestroyHandle(); }
}

internal sealed class SetupForm : Form
{
    public SetupForm(Settings s)
    {
        Text = "AperioPlan Fernsteuerung einrichten";
        Width = 520; Height = 300; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
        var info = new Label { Left = 16, Top = 12, Width = 470, Height = 54, Text = "Adresse von AperioPlan und ein persönlicher Zugangsschlüssel.\nDen Schlüssel erstellen Sie in AperioPlan unter Einstellungen → API-Schlüssel (beginnt mit ap_)." };
        var l1 = new Label { Left = 16, Top = 74, Width = 470, Text = "Adresse (z. B. https://aperioplan.firma.local)" };
        var server = new TextBox { Left = 16, Top = 96, Width = 470, Text = s.Server };
        var l2 = new Label { Left = 16, Top = 128, Width = 470, Text = "Zugangsschlüssel" };
        var token = new TextBox { Left = 16, Top = 150, Width = 470, Text = s.Token, UseSystemPasswordChar = true };
        var ok = new Button { Text = "Speichern und verbinden", Left = 286, Top = 200, Width = 200, DialogResult = DialogResult.OK };
        ok.Click += (_, _) => { s.Server = server.Text.Trim(); s.Token = token.Text.Trim(); };
        Controls.AddRange(new Control[] { info, l1, server, l2, token, ok });
        AcceptButton = ok;
    }
}
