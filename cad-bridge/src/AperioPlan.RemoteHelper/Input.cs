using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

namespace AperioPlan.RemoteHelper;

/// <summary>Setzt die Eingaben aus dem Browser (Mausposition 0…1, Tasten nach KeyboardEvent.code) in Windows-Eingaben um</summary>
internal static class Input
{
    private static readonly HashSet<ushort> Down = new();
    private static readonly HashSet<int> Buttons = new();

    public static void Apply(JsonElement d, Rectangle screen)
    {
        var t = d.TryGetProperty("t", out var tp) ? tp.GetString() : null;
        switch (t)
        {
            case "move": Move(d, screen); break;
            case "down": Move(d, screen); Mouse(Btn(d), true); break;
            case "up": Move(d, screen); Mouse(Btn(d), false); break;
            case "wheel":
                var dy = d.TryGetProperty("dy", out var y) ? y.GetDouble() : 0;
                var dx = d.TryGetProperty("dx", out var x) ? x.GetDouble() : 0;
                if (dy != 0) Send(MouseInput(0, 0, (uint)(-dy * 120), Native.MOUSEEVENTF_WHEEL));
                if (dx != 0) Send(MouseInput(0, 0, (uint)(dx * 120), Native.MOUSEEVENTF_HWHEEL));
                break;
            case "keydown":
            case "keyup":
                Key(d, t == "keydown");
                break;
        }
    }

    public static void ReleaseAll()
    {
        foreach (var vk in Down) Send(KeyInput(vk, 0, Native.KEYEVENTF_KEYUP));
        Down.Clear();
        foreach (var b in Buttons) Mouse(b, false);
        Buttons.Clear();
    }

    private static int Btn(JsonElement d) => d.TryGetProperty("button", out var b) ? b.GetInt32() : 0;

    private static void Move(JsonElement d, Rectangle screen)
    {
        if (!d.TryGetProperty("x", out var xp) || !d.TryGetProperty("y", out var yp)) return;
        var px = screen.Left + xp.GetDouble() * (screen.Width - 1);
        var py = screen.Top + yp.GetDouble() * (screen.Height - 1);
        // absolute Koordinaten beziehen sich auf den gesamten (virtuellen) Desktop: 0 … 65535
        var v = SystemInformation.VirtualScreen;
        var ax = (int)Math.Round((px - v.Left) * 65535.0 / Math.Max(1, v.Width - 1));
        var ay = (int)Math.Round((py - v.Top) * 65535.0 / Math.Max(1, v.Height - 1));
        Send(MouseInput(ax, ay, 0, Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK));
    }

    private static void Mouse(int button, bool down)
    {
        uint flag = button switch
        {
            1 => down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP,
            2 => down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP,
            _ => down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP,
        };
        if (down) Buttons.Add(button); else Buttons.Remove(button);
        Send(MouseInput(0, 0, 0, flag));
    }

    private static void Key(JsonElement d, bool down)
    {
        var code = d.TryGetProperty("code", out var c) ? c.GetString() ?? "" : "";
        var key = d.TryGetProperty("key", out var k) ? k.GetString() ?? "" : "";
        var vk = VirtualKey(code);
        if (vk != 0)
        {
            var ext = IsExtended(code) ? Native.KEYEVENTF_EXTENDEDKEY : 0u;
            if (down) Down.Add(vk); else Down.Remove(vk);
            Send(KeyInput(vk, 0, (down ? 0 : Native.KEYEVENTF_KEYUP) | ext));
            return;
        }
        // unbekannte Taste mit druckbarem Zeichen: als Zeichen senden
        if (down && key.Length == 1) Send(KeyInput(0, key[0], Native.KEYEVENTF_UNICODE), KeyInput(0, key[0], Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP));
    }

    private static bool IsExtended(string code) => code is "ArrowUp" or "ArrowDown" or "ArrowLeft" or "ArrowRight" or "Home" or "End" or "PageUp" or "PageDown"
        or "Insert" or "Delete" or "ControlRight" or "AltRight" or "NumpadEnter" or "NumpadDivide" or "MetaLeft" or "MetaRight" or "ContextMenu";

    private static ushort VirtualKey(string code)
    {
        if (code.Length == 4 && code.StartsWith("Key")) return code[3];
        if (code.Length == 6 && code.StartsWith("Digit")) return code[5];
        if (code.StartsWith("Numpad") && code.Length == 7 && char.IsDigit(code[6])) return (ushort)(0x60 + (code[6] - '0'));
        if (code.StartsWith('F') && int.TryParse(code[1..], out var f) && f is >= 1 and <= 24) return (ushort)(0x6F + f);
        return code switch
        {
            "Enter" or "NumpadEnter" => 0x0D, "Escape" => 0x1B, "Backspace" => 0x08, "Tab" => 0x09, "Space" => 0x20,
            "ArrowLeft" => 0x25, "ArrowUp" => 0x26, "ArrowRight" => 0x27, "ArrowDown" => 0x28,
            "ShiftLeft" => 0xA0, "ShiftRight" => 0xA1, "ControlLeft" => 0xA2, "ControlRight" => 0xA3, "AltLeft" => 0xA4, "AltRight" => 0xA5,
            "MetaLeft" => 0x5B, "MetaRight" => 0x5C, "ContextMenu" => 0x5D, "CapsLock" => 0x14,
            "Delete" => 0x2E, "Insert" => 0x2D, "Home" => 0x24, "End" => 0x23, "PageUp" => 0x21, "PageDown" => 0x22,
            "PrintScreen" => 0x2C, "ScrollLock" => 0x91, "Pause" => 0x13, "NumLock" => 0x90,
            "NumpadMultiply" => 0x6A, "NumpadAdd" => 0x6B, "NumpadSubtract" => 0x6D, "NumpadDecimal" => 0x6E, "NumpadDivide" => 0x6F,
            "Minus" => 0xBD, "Equal" => 0xBB, "BracketLeft" => 0xDB, "BracketRight" => 0xDD, "Backslash" => 0xDC, "Semicolon" => 0xBA,
            "Quote" => 0xDE, "Backquote" => 0xC0, "Comma" => 0xBC, "Period" => 0xBE, "Slash" => 0xBF, "IntlBackslash" => 0xE2,
            _ => 0,
        };
    }

    private static Native.INPUT MouseInput(int x, int y, uint data, uint flags) => new()
    {
        type = Native.INPUT_MOUSE,
        U = new Native.InputUnion { mi = new Native.MOUSEINPUT { dx = x, dy = y, mouseData = data, dwFlags = flags } },
    };

    private static Native.INPUT KeyInput(ushort vk, char scan, uint flags) => new()
    {
        type = Native.INPUT_KEYBOARD,
        U = new Native.InputUnion { ki = new Native.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };

    private static void Send(params Native.INPUT[] inputs) => Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Native.INPUT>());
}

internal static class Native
{
    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008,
        MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800,
        MOUSEEVENTF_HWHEEL = 0x1000, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
