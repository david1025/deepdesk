namespace DeepDesk;

internal static class AppPaths
{
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepDesk");
    public static string CredentialsDirectory => Path.Combine(Root, "credentials");
    public static string ApiKeyFile => Path.Combine(CredentialsDirectory, "deepseek-api-key.bin");
    public static string SettingsDirectory => Path.Combine(Root, "settings");
    public static string WebViewDirectory => Path.Combine(Root, "WebView2");
    public static string LogDirectory => Path.Combine(Root, "logs");
    public static string UiDirectory => Path.Combine(AppContext.BaseDirectory, "wwwroot");
}
