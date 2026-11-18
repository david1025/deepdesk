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
                catch (Exception ex)
                {
                    RuntimeLog.Write($"API credential injection failed: {ex.GetType().Name}");
                }
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
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                OpenExternal(args.Uri);
            };
            _bridge = new WebViewBridge(core, _credentials, new DeepSeekApiService(_credentials));
            var nativeCredentialBootstrap = _credentials.Exists
                ? "localStorage.setItem('chat-demo:api-key','DEEPDESK_NATIVE_CREDENTIAL');"
                : "";
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                $"try{{{nativeCredentialBootstrap}}}catch{{}}");
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

    private static void OpenExternal(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            uri.UserInfo.Length > 0) return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri)
        {
            UseShellExecute = true
        });
    }
}
