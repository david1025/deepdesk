using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using System.ComponentModel;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Runtime.InteropServices;

namespace DeepDesk;

public partial class MainWindow : Window
{
    private const int WmSettingChange = 0x001A;
    private const int WmSysColorChange = 0x0015;
    private const int WmThemeChanged = 0x031A;
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmcpDoNotRound = 1;
    private const int DwmcpRound = 2;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd, int attribute, ref int value, int valueSize);

    private readonly CredentialService _credentials = new();
    private WebViewBridge? _bridge;
    private HwndSource? _windowSource;
    // Null before the page reports its effective light/dark appearance.
    private bool? _webUiLightTheme;
    private Window? _firstRunBackdrop;
    private FirstRunDialog? _firstRunDialog;
    private bool _isClosing;
    private bool _exitRequested;
    private bool _startupStarted;
    private bool _guideWasVisibleBeforeTray;
    private TrayIconService? _tray;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        LocationChanged += (_, _) => SyncFirstRunBackdrop();
        // Logging out or shutting down Windows must not be intercepted as a tray hide.
        System.Windows.Application.Current.SessionEnding += (_, _) => _exitRequested = true;
        Closed += (_, _) => _bridge = null;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _windowSource = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        _windowSource?.AddHook(WindowMessageHook);
        ApplyWindowsTheme();
        ApplyNativeWindowCorners();
        try
        {
            _tray = new TrayIconService(
                () => Dispatcher.BeginInvoke(new Action(RestoreFromTray)),
                () => Dispatcher.BeginInvoke(new Action(ExitFromTray)));
        }
        catch (Exception ex)
        {
            // Without a tray icon, let the normal Close operation exit the program.
            RuntimeLog.Write($"Tray initialization failed: {ex.GetType().Name}");
        }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_exitRequested && _tray is not null)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }

        _isClosing = true;
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        if (_windowSource is not null)
            _windowSource.RemoveHook(WindowMessageHook);
        _tray?.Dispose();
        _tray = null;
        base.OnClosed(e);
    }

    private IntPtr WindowMessageHook(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message is WmSettingChange or WmSysColorChange or WmThemeChanged)
            Dispatcher.BeginInvoke(new Action(ApplyWindowsTheme));
        return IntPtr.Zero;
    }

    private static bool IsWindowsLightTheme()
    {
        try
        {
            var value = Registry.GetValue(
                @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "AppsUseLightTheme", 1);
            return Convert.ToInt32(value) != 0;
        }
        catch
        {
            return true;
        }
    }

    private void ApplyWindowsTheme()
    {
        var light = _webUiLightTheme ?? IsWindowsLightTheme();
        var palette = light
            ? new Dictionary<string, string>
            {
                ["WindowBackgroundBrush"] = "#FFFFFF",
                ["WindowBorderBrush"] = "#DDE2EA",
                ["TitleBarBackgroundBrush"] = "#FFFFFF",
                ["TitleBarBorderBrush"] = "#E8EBF1",
                ["TitleBarForegroundBrush"] = "#202938",
                ["TitleBarMutedBrush"] = "#667085",
                ["TitleBarHoverBrush"] = "#F2F4F7",
                ["CloseHoverBrush"] = "#E81123",
                ["TitleBarIconBackgroundBrush"] = "#EEF3FF",
                ["TitleBarIconForegroundBrush"] = "#315EFB"
            }
            : new Dictionary<string, string>
            {
                ["WindowBackgroundBrush"] = "#17191F",
                ["WindowBorderBrush"] = "#303641",
                ["TitleBarBackgroundBrush"] = "#1D2028",
                ["TitleBarBorderBrush"] = "#303641",
                ["TitleBarForegroundBrush"] = "#F2F4F7",
                ["TitleBarMutedBrush"] = "#A0A8B5",
                ["TitleBarHoverBrush"] = "#303641",
                ["CloseHoverBrush"] = "#C42B1C",
                ["TitleBarIconBackgroundBrush"] = "#293653",
                ["TitleBarIconForegroundBrush"] = "#9DB4FF"
            };

        foreach (var item in palette)
        {
            var color = (Color)ColorConverter.ConvertFromString(item.Value);
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            Resources[item.Key] = brush;
        }

        Background = (Brush)Resources["WindowBackgroundBrush"];
        WindowSurface.Background = (Brush)Resources["WindowBackgroundBrush"];
        WindowSurface.BorderBrush = (Brush)Resources["WindowBorderBrush"];
        TitleBarSurface.Background = (Brush)Resources["TitleBarBackgroundBrush"];
        TitleBarSurface.BorderBrush = (Brush)Resources["TitleBarBorderBrush"];
        TitleBarIconBorder.Background = (Brush)Resources["TitleBarIconBackgroundBrush"];
    }

    private void OnWindowStateChanged(object? sender, EventArgs e)
    {
        UpdateMaximizeGlyph();
        UpdateWindowSurfaceClip();
        ApplyNativeWindowCorners();
        SyncFirstRunBackdrop();
    }

    private void UpdateMaximizeGlyph()
    {
        var maximized = WindowState == WindowState.Maximized;
        MaximizeNormalGlyph.Visibility = maximized ? Visibility.Collapsed : Visibility.Visible;
        MaximizeRestoreGlyph.Visibility = maximized ? Visibility.Visible : Visibility.Collapsed;
        MaximizeButton.ToolTip = maximized ? "还原" : "最大化";
    }

    private void Minimize_Click(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeRestore_Click(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void CloseWindow_Click(object sender, RoutedEventArgs e)
    {
        // All close paths (including Alt+F4) are handled by OnClosing.
        Close();
    }

    private void HideToTray()
    {
        // The onboarding guide is modeless, so preserve it when hiding the app.
        _guideWasVisibleBeforeTray = _firstRunDialog?.IsVisible == true;
        if (_guideWasVisibleBeforeTray)
        {
            _firstRunDialog!.Hide();
            _firstRunBackdrop?.Hide();
        }
        Hide();
    }

    private void RestoreFromTray()
    {
        if (_exitRequested)
            return;

        if (!IsVisible)
            Show();
        if (WindowState == WindowState.Minimized)
            WindowState = WindowState.Normal;
        Activate();

        if (_guideWasVisibleBeforeTray &&
            _firstRunBackdrop is not null &&
            _firstRunDialog is not null)
        {
            if (!_firstRunBackdrop.IsVisible)
                _firstRunBackdrop.Show();
            SyncFirstRunBackdrop();
            if (!_firstRunDialog.IsVisible)
                _firstRunDialog.Show();
            _firstRunDialog.Activate();
        }
        _guideWasVisibleBeforeTray = false;
    }

    private void ExitFromTray()
    {
        if (_exitRequested)
            return;

        _exitRequested = true;
        _isClosing = true;
        // Remove the notification icon before shutting down the WPF dispatcher.
        _tray?.Dispose();
        _tray = null;
        System.Windows.Application.Current.Shutdown();
    }

    private void WindowSurface_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        UpdateWindowSurfaceClip();
        SyncFirstRunBackdrop();
    }

    private void UpdateWindowSurfaceClip()
    {
        if (WindowSurface is null || WindowSurface.ActualWidth <= 0 || WindowSurface.ActualHeight <= 0)
            return;

        var maximized = WindowState == WindowState.Maximized;
        var radius = maximized ? 0d : 10d;
        WindowSurface.CornerRadius = new CornerRadius(radius);
        WindowSurface.BorderThickness = maximized ? new Thickness(0) : new Thickness(1);
        TitleBarSurface.CornerRadius = new CornerRadius(radius, radius, 0, 0);
        WindowSurface.Clip = new RectangleGeometry(
            new Rect(0, 0, WindowSurface.ActualWidth, WindowSurface.ActualHeight), radius, radius);
    }

    private void ApplyNativeWindowCorners()
    {
        if (_windowSource is null)
            return;

        var preference = WindowState == WindowState.Maximized ? DwmcpDoNotRound : DwmcpRound;
        try
        {
            _ = DwmSetWindowAttribute(
                _windowSource.Handle, DwmwaWindowCornerPreference,
                ref preference, sizeof(int));
        }
        catch (DllNotFoundException)
        {
            // Older Windows versions use the WPF rounded clip geometry.
        }
        catch (EntryPointNotFoundException)
        {
            // Older Windows versions do not expose this DWM attribute.
        }
    }


    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        // Restoring from the tray must never initialize WebView2 a second time.
        if (_startupStarted)
            return;
        _startupStarted = true;
        try
        {
            if (!Directory.Exists(AppPaths.UiDirectory))
                throw new DirectoryNotFoundException("未找到前端资源，请重新安装应用。");
            Directory.CreateDirectory(AppPaths.WebViewDirectory);
            CoreWebView2Environment environment;
            try
            {
                environment = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewDirectory);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                var choice = MessageBox.Show(this,
                    "当前电脑尚未安装 Microsoft Edge WebView2 Runtime。DeepDesk 需要该组件才能运行。是否打开微软官方下载页面？",
                    "需要安装 WebView2 Runtime", MessageBoxButton.YesNo, MessageBoxImage.Information);
                if (choice == MessageBoxResult.Yes)
                    OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/");
                // Runtime is unavailable: this is a real startup failure, not a tray close.
                _exitRequested = true;
                Close();
                return;
            }
            await Browser.EnsureCoreWebView2Async(environment);
            var core = Browser.CoreWebView2;
            core.PermissionRequested += (_, args) =>
            {
                if (args.PermissionKind != CoreWebView2PermissionKind.Microphone) return;
                args.State = Uri.TryCreate(args.Uri, UriKind.Absolute, out var permissionUri) &&
                    permissionUri.Scheme == "https" && permissionUri.Host == "deepdesk.local"
                    ? CoreWebView2PermissionState.Allow
                    : CoreWebView2PermissionState.Deny;
            };
            core.Settings.AreDevToolsEnabled = false;
            core.AddWebResourceRequestedFilter("https://api.deepseek.com/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, args) =>
            {
                if (!_credentials.Exists || args.Request.Method.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase)) return;
                try
                {
                    var requestUri = new Uri(args.Request.Uri);
                    if (requestUri.Scheme == "https" && requestUri.Host == "api.deepseek.com")
                    {
                        var key = _credentials.ReadApiKey();
                        args.Request.Headers.SetHeader("Authorization", $"Bearer {key}");
                        args.Request.Headers.SetHeader("x-api-key", key);
                    }
                }
                catch (Exception ex) { RuntimeLog.Write($"API credential injection failed: {ex.GetType().Name}"); }
            };
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("deepdesk.local", AppPaths.UiDirectory,
                CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) &&
                    uri.Scheme == "https" && uri.Host == "deepdesk.local") return;
                args.Cancel = true;
                OpenExternal(args.Uri);
            };
            core.NewWindowRequested += (_, args) => { args.Handled = true; OpenExternal(args.Uri); };
            _bridge = new WebViewBridge(core, _credentials, new DeepSeekApiService(_credentials), isDark =>
            {
                _webUiLightTheme = !isDark;
                ApplyWindowsTheme();
            });

            var nativeCredentialBootstrap = _credentials.Exists
                ? "localStorage.setItem('chat-demo:api-key','DEEPDESK_NATIVE_CREDENTIAL');"
                : """
                  (() => {
                    try {
                      const key = localStorage.getItem('chat-demo:api-key');
                      if (!key || key === 'DEEPDESK_NATIVE_CREDENTIAL' || !window.chrome?.webview) return;
                      const requestId = 'deepdesk-key-migration';
                      const listener = (event) => {
                        const response = event.data;
                        if (!response || response.type !== 'response' || response.requestId !== requestId) return;
                        window.chrome.webview.removeEventListener('message', listener);
                        if (response.success) localStorage.setItem('chat-demo:api-key', 'DEEPDESK_NATIVE_CREDENTIAL');
                      };
                      window.chrome.webview.addEventListener('message', listener);
                      window.chrome.webview.postMessage({ requestId, action: 'settings.saveApiKey', payload: { apiKey: key } });
                    } catch {}
                  })();
                  """;
            await core.AddScriptToExecuteOnDocumentCreatedAsync($"try{{{nativeCredentialBootstrap}}}catch{{}}");
            var navigationCompleted = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<CoreWebView2NavigationCompletedEventArgs>? navigationHandler = null;
            navigationHandler = (_, args) =>
            {
                core.NavigationCompleted -= navigationHandler;
                if (args.IsSuccess)
                    navigationCompleted.TrySetResult(true);
                else
                    navigationCompleted.TrySetException(new InvalidOperationException(
                        $"DeepDesk 页面加载失败（WebErrorStatus: {args.WebErrorStatus}）。"));
            };
            core.NavigationCompleted += navigationHandler;
            Browser.Source = new Uri("https://deepdesk.local/index.html");
            await navigationCompleted.Task.WaitAsync(TimeSpan.FromSeconds(60));
            Browser.Visibility = Visibility.Visible;
            LoadingPanel.Visibility = Visibility.Collapsed;

            if (!AppPaths.FirstRunCompleted)
                ShowFirstRunGuide(core);
        }
        catch (Exception ex)
        {
            RuntimeLog.Write($"Startup failed: {ex.GetType().Name}: {ex.Message}");
            MessageBox.Show($"DeepDesk 启动失败：{ex.Message}", "DeepDesk", MessageBoxButton.OK, MessageBoxImage.Error);
            // Do not strand a nonfunctional process in the tray.
            _exitRequested = true;
            Close();
        }
    }

    // A WPF overlay in the main visual tree cannot reliably cover WebView2's native surface.
    // Use a separate owned window; the onboarding overlay starts BELOW our 38 DIP caption.
    private Window CreateBackdropWindow(double topInset)
    {
        var backdrop = new Window
        {
            Owner = this,
            WindowStartupLocation = WindowStartupLocation.Manual,
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = false,
            ShowActivated = false,
            ResizeMode = ResizeMode.NoResize,
            Content = new System.Windows.Controls.Border
            {
                Background = new SolidColorBrush(Color.FromArgb(156, 0, 0, 0))
            }
        };
        SyncBackdropBounds(backdrop, topInset);
        return backdrop;
    }

    private void SyncBackdropBounds(Window backdrop, double topInset)
    {
        if (WindowState == WindowState.Minimized)
            return;

        var screenPoint = PointToScreen(new Point(0, topInset));
        var deviceToDip = PresentationSource.FromVisual(this)?.CompositionTarget?.TransformFromDevice
                          ?? Matrix.Identity;
        var location = deviceToDip.Transform(screenPoint);
        backdrop.Left = location.X;
        backdrop.Top = location.Y;
        backdrop.Width = ActualWidth;
        backdrop.Height = Math.Max(1, ActualHeight - topInset);

        if (backdrop.Content is System.Windows.Controls.Border surface)
            surface.CornerRadius = new CornerRadius(0, 0,
                WindowState == WindowState.Maximized ? 0 : 10,
                WindowState == WindowState.Maximized ? 0 : 10);
    }

    private void SyncFirstRunBackdrop()
    {
        if (_firstRunBackdrop is null || WindowState == WindowState.Minimized)
            return;

        SyncBackdropBounds(_firstRunBackdrop, TitleBarSurface?.ActualHeight is > 0
            ? TitleBarSurface.ActualHeight : 38);

        if (_firstRunDialog?.IsVisible == true)
        {
            _firstRunDialog.Left = _firstRunBackdrop.Left +
                                   Math.Max(0, (_firstRunBackdrop.Width - _firstRunDialog.Width) / 2);
            _firstRunDialog.Top = _firstRunBackdrop.Top +
                                  Math.Max(0, (_firstRunBackdrop.Height - _firstRunDialog.Height) / 2);
        }
    }

    private void ShowFirstRunGuide(CoreWebView2 core)
    {
        if (_firstRunDialog is not null)
            return;

        // Show(), not ShowDialog(): the title bar must remain interactive.
        var backdrop = CreateBackdropWindow(TitleBarSurface.ActualHeight is > 0
            ? TitleBarSurface.ActualHeight : 38);
        _firstRunBackdrop = backdrop;
        var welcome = new FirstRunDialog(_credentials, new DeepSeekApiService(_credentials), core)
        {
            WindowStartupLocation = WindowStartupLocation.Manual
        };
        _firstRunDialog = welcome;
        welcome.Closed += (_, _) =>
        {
            _firstRunDialog = null;
            _firstRunBackdrop = null;
            backdrop.Close();
            if (!_isClosing)
                AppPaths.MarkFirstRunCompleted();
        };

        try
        {
            // WPF requires the owner window to be shown before assigning Window.Owner.
            backdrop.Show();
            welcome.Owner = backdrop;
            welcome.Left = backdrop.Left + Math.Max(0, (backdrop.Width - welcome.Width) / 2);
            welcome.Top = backdrop.Top + Math.Max(0, (backdrop.Height - welcome.Height) / 2);
            welcome.Show();
        }
        catch
        {
            _firstRunDialog = null;
            _firstRunBackdrop = null;
            backdrop.Close();
            throw;
        }
    }

    // Preserve the existing full-window backdrop for modal About and Update dialogs.
    private bool? ShowDecoratedDialog(Window dialog)
    {
        var backdrop = CreateBackdropWindow(0);
        try
        {
            backdrop.Show();
            dialog.Owner = backdrop;
            return dialog.ShowDialog();
        }
        finally
        {
            backdrop.Close();
        }
    }

    private async void CheckForUpdates_Click(object sender, RoutedEventArgs e)
    {
        CheckForUpdatesButton.IsEnabled = false;
        CheckForUpdatesButton.Content = "检查中…";

        try
        {
            var update = await UpdateService.CheckAsync();
            var current = UpdateService.CurrentVersion.Split('+', 2)[0];
            if (update is null)
            {
                ShowDecoratedDialog(new UpdateDialog(
                    "已是最新版本",
                    $"当前版本：{current}",
                    "暂未发现可用更新。"));
            }
            else
            {
                var dialog = new UpdateDialog(
                    $"发现新版本 {update.Version}",
                    $"当前版本：{current}",
                    "安装新版本不会删除本地对话或 API Key。",
                    "前往下载");
                if (ShowDecoratedDialog(dialog) == true)
                    OpenExternal(update.ReleaseUrl);
            }
        }
        catch (Exception ex)
        {
            RuntimeLog.Write($"Update check failed: {ex.GetType().Name}");
            ShowDecoratedDialog(new UpdateDialog(
                "检查更新失败",
                "暂时无法获取最新版本。",
                "请检查网络连接后重试。"));
        }
        finally
        {
            CheckForUpdatesButton.IsEnabled = true;
            CheckForUpdatesButton.Content = "检查更新";
        }
    }

    private void About_Click(object sender, RoutedEventArgs e)
    {
        ShowDecoratedDialog(new AboutDialog());
    }

    private static void OpenExternal(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            uri.UserInfo.Length > 0) return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
