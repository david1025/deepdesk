using System.Drawing;
using System.Windows;
using System.Windows.Forms;

namespace DeepDesk;

/// <summary>
/// Windows notification-area icon with a custom WPF menu, sharing DeepDesk's
/// light/dark palette rather than the native WinForms ContextMenuStrip.
/// </summary>
internal sealed class TrayIconService : IDisposable
{
    private readonly Icon _icon;
    private readonly NotifyIcon _notifyIcon;
    private readonly TrayMenuWindow _menuWindow;
    private readonly Action _showWindow;
    private readonly Action _exitApplication;
    private readonly Func<bool> _isDarkMode;
    private bool _disposed;

    public TrayIconService(Action showWindow, Action exitApplication, Func<bool> isDarkMode)
    {
        _showWindow = showWindow;
        _exitApplication = exitApplication;
        _isDarkMode = isDarkMode;

        var executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法读取 DeepDesk 可执行文件路径。");
        _icon = Icon.ExtractAssociatedIcon(executable)
            ?? throw new InvalidOperationException("无法读取 DeepDesk 程序图标。");

        _menuWindow = new TrayMenuWindow(
            () => _showWindow(),
            () => _exitApplication());

        _notifyIcon = new NotifyIcon
        {
            Icon = _icon,
            Text = "DeepDesk",
            Visible = true
        };
        _notifyIcon.MouseUp += OnMouseUp;
        _notifyIcon.DoubleClick += OnDoubleClick;
    }

    public void RefreshTheme()
    {
        if (_disposed || !_menuWindow.IsVisible)
            return;

        _menuWindow.ApplyTheme(_isDarkMode());
    }

    private void OnMouseUp(object? sender, System.Windows.Forms.MouseEventArgs e)
    {
        if (_disposed || e.Button != MouseButtons.Right)
            return;

        System.Windows.Application.Current.Dispatcher.BeginInvoke(new Action(() =>
        {
            if (_disposed)
                return;
            _menuWindow.ApplyTheme(_isDarkMode());
            _menuWindow.ShowAt(Cursor.Position);
        }));
    }

    private void OnDoubleClick(object? sender, EventArgs e)
    {
        if (_disposed)
            return;
        System.Windows.Application.Current.Dispatcher.BeginInvoke(new Action(() =>
        {
            if (!_disposed)
            {
                _menuWindow.Hide();
                _showWindow();
            }
        }));
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;

        _notifyIcon.MouseUp -= OnMouseUp;
        _notifyIcon.DoubleClick -= OnDoubleClick;
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menuWindow.Close();
        _icon.Dispose();
    }
}
