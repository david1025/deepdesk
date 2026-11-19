using System.Drawing;
using System.Windows.Forms;

namespace DeepDesk;

/// <summary>
/// Windows notification-area icon and its two explicit commands.
/// Owns all WinForms resources so they can be released on real application exit.
/// </summary>
internal sealed class TrayIconService : IDisposable
{
    private readonly Icon _icon;
    private readonly ContextMenuStrip _menu;
    private readonly NotifyIcon _notifyIcon;

    public TrayIconService(Action showWindow, Action exitApplication)
    {
        // DeepDesk.exe embeds the original DSH Harbor multi-resolution icon.
        var executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法读取 DeepDesk 可执行文件路径。");
        _icon = Icon.ExtractAssociatedIcon(executable)
            ?? throw new InvalidOperationException("无法读取 DeepDesk 程序图标。");

        _menu = new ContextMenuStrip();
        _menu.Items.Add("打开 DeepDesk", null, (_, _) => showWindow());
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add("退出 DeepDesk", null, (_, _) => exitApplication());

        _notifyIcon = new NotifyIcon
        {
            Icon = _icon,
            Text = "DeepDesk",
            ContextMenuStrip = _menu,
            Visible = true
        };
        _notifyIcon.DoubleClick += (_, _) => showWindow();
    }

    public void Dispose()
    {
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menu.Dispose();
        _icon.Dispose();
    }
}
