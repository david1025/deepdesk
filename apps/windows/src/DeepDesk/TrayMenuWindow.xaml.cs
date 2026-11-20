using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace DeepDesk;

/// <summary>DeepDesk-styled tray menu. A small WPF window replaces the native ContextMenuStrip.</summary>
public partial class TrayMenuWindow : Window
{
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private readonly Action _showApp;
    private readonly Action _exitApp;
    private bool _opening;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr handle, out NativeRect rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter,
        int x, int y, int width, int height, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public TrayMenuWindow(Action showApp, Action exitApp)
    {
        InitializeComponent();
        _showApp = showApp;
        _exitApp = exitApp;
    }

    public void ApplyTheme(bool dark)
    {
        var palette = dark
            ? new Dictionary<string, string>
            {
                ["TraySurfaceBrush"] = "#2B2B2E",
                ["TrayBorderBrush"] = "#414145",
                ["TrayTextBrush"] = "#F1F2F5",
                ["TrayHoverBrush"] = "#404146",
                ["TrayDividerBrush"] = "#424348"
            }
            : new Dictionary<string, string>
            {
                ["TraySurfaceBrush"] = "#FFFFFF",
                ["TrayBorderBrush"] = "#E9EBEF",
                ["TrayTextBrush"] = "#22252B",
                ["TrayHoverBrush"] = "#F4F5F7",
                ["TrayDividerBrush"] = "#E7E9EC"
            };

        foreach (var (key, hex) in palette)
        {
            var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
            brush.Freeze();
            Resources[key] = brush;
        }
    }

    public void ShowAt(System.Drawing.Point cursor)
    {
        _opening = true;
        try
        {
            // The temporary initial position is replaced with an exact Win32 pixel
            // position below, so multi-monitor taskbars / different DPI also work.
            var bounds = System.Windows.Forms.Screen.FromPoint(cursor).WorkingArea;
            Left = cursor.X;
            Top = cursor.Y;
            if (!IsVisible)
                Show();

            var hwnd = new WindowInteropHelper(this).Handle;
            if (GetWindowRect(hwnd, out var rect))
            {
                int widthPx = rect.Right - rect.Left;
                int heightPx = rect.Bottom - rect.Top;
                int left = Math.Clamp(cursor.X - widthPx + 22,
                    bounds.Left, Math.Max(bounds.Left, bounds.Right - widthPx));
                int above = cursor.Y - heightPx - 8;
                int below = cursor.Y + 8;
                int top = above >= bounds.Top ? above : below;
                top = Math.Clamp(top, bounds.Top, Math.Max(bounds.Top, bounds.Bottom - heightPx));

                _ = SetWindowPos(hwnd, IntPtr.Zero, left, top, 0, 0,
                    SwpNoSize | SwpNoZOrder | SwpNoActivate);
            }
            Activate();
        }
        finally
        {
            _opening = false;
        }
    }

    private void Menu_Deactivated(object sender, EventArgs e)
    {
        if (!_opening)
            Hide();
    }

    private void Open_Click(object sender, RoutedEventArgs e)
    {
        Hide();
        _showApp();
    }

    private void Exit_Click(object sender, RoutedEventArgs e)
    {
        Hide();
        _exitApp();
    }
}
