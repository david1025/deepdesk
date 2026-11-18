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
                if (args.PermissionKind == CoreWebView2PermissionKind.Microphone &&
                    Uri.TryCreate(args.Uri, UriKind.Absolute, out var permissionUri) &&
                    permissionUri.Scheme == "https" && permissionUri.Host == "deepdesk.local")
                    args.State = CoreWebView2PermissionState.Allow;
                else
                    args.State = CoreWebView2PermissionState.Deny;
            };
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("deepdesk.local", AppPaths.UiDirectory,
                CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) ||
                    uri.Scheme != "https" || uri.Host != "deepdesk.local")
                    args.Cancel = true;
            };
            _bridge = new WebViewBridge(core, _credentials, new DeepSeekApiService(_credentials));
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
}
