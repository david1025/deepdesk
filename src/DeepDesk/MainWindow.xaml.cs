using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace DeepDesk;

public partial class MainWindow : Window
{
    private readonly CredentialService _credentials = new();
    private WebViewBridge? _bridge;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += (_, _) => _bridge = null;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!Directory.Exists(AppPaths.UiDirectory))
                throw new DirectoryNotFoundException("未找到前端资源，请重新安装应用。");
            Directory.CreateDirectory(AppPaths.WebViewDirectory);
            var environment = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewDirectory);
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

            if (!_credentials.Exists && !AppPaths.FirstRunCompleted)
            {
                var welcome = new FirstRunDialog(_credentials, new DeepSeekApiService(_credentials)) { Owner = this };
                welcome.ShowDialog();
                AppPaths.MarkFirstRunCompleted();
            }

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
            Browser.Source = new Uri("https://deepdesk.local/index.html");
            Browser.Visibility = Visibility.Visible;
            LoadingPanel.Visibility = Visibility.Collapsed;
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
        UpdateMenuItem.IsEnabled = false;
        UpdateMenuItem.Header = "正在检查更新…";
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
            UpdateMenuItem.IsEnabled = true;
            UpdateMenuItem.Header = "检查更新…";
        }
    }

    private void About_Click(object sender, RoutedEventArgs e)
    {
        MessageBox.Show(this, $"DeepDesk {UpdateService.CurrentVersion}\n本地运行 · 数据保存在本机\n\nGitHub: david1025/deepdesk",
            "关于 DeepDesk", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private static void OpenExternal(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            uri.UserInfo.Length > 0) return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
