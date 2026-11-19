using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
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

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += (_, _) => _bridge = null;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _windowSource = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        _windowSource?.AddHook(WindowMessageHook);
        ApplyWindowsTheme();
        ApplyNativeWindowCorners();
    }

    protected override void OnClosed(EventArgs e)
    {
        if (_windowSource is not null)
            _windowSource.RemoveHook(WindowMessageHook);
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
        var light = IsWindowsLightTheme();
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
        Close();
    }

    private void WindowSurface_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        UpdateWindowSurfaceClip();
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
            _bridge = new WebViewBridge(core, _credentials, new DeepSeekApiService(_credentials));

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
            {
                var welcome = new FirstRunDialog(_credentials, new DeepSeekApiService(_credentials), core)
                {
                    Owner = this
                };
                welcome.ShowDialog();
                AppPaths.MarkFirstRunCompleted();
            }
        }
        catch (Exception ex)
        {
            RuntimeLog.Write($"Startup failed: {ex.GetType().Name}: {ex.Message}");
            MessageBox.Show($"DeepDesk 启动失败：{ex.Message}", "DeepDesk", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private async void CheckForUpdates_Click(object sender, RoutedEventArgs e)
    {
        CheckForUpdatesButton.IsEnabled = false;
        CheckForUpdatesButton.Content = "检查中…";
        try
        {
            var update = await UpdateService.CheckAsync();
            var current = UpdateService.CurrentVersion;
            if (update is null)
            {
                MessageBox.Show(this, $"当前版本：{current}\n暂未发现更新。", "DeepDesk 更新", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                var result = MessageBox.Show(this,
                    $"发现新版本 {update.Version}\n当前版本：{current}\n\n将打开 GitHub 发布页面。请退出 DeepDesk 后运行安装程序。\n\n安装更新不会删除本地聊天记录和 API Key。",
                    "发现 DeepDesk 更新", MessageBoxButton.OKCancel, MessageBoxImage.Information);
                if (result == MessageBoxResult.OK) OpenExternal(update.ReleaseUrl);
            }
        }
        catch (Exception ex)
        {
            RuntimeLog.Write($"Update check failed: {ex.GetType().Name}");
            MessageBox.Show(this, "检查更新失败，请稍后重试，或访问 DeepDesk GitHub Releases 页面。", "DeepDesk 更新", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            CheckForUpdatesButton.IsEnabled = true;
            CheckForUpdatesButton.Content = "检查更新";
        }
    }

    private void About_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new AboutDialog { Owner = this };
        dialog.ShowDialog();
    }

    private static void OpenExternal(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            uri.UserInfo.Length > 0) return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
