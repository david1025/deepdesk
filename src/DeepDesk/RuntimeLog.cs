namespace DeepDesk;

internal static class RuntimeLog
{
    private static readonly object Gate = new();

    public static void Write(string message)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.LogDirectory);
            lock (Gate)
                File.AppendAllText(Path.Combine(AppPaths.LogDirectory, "application.log"),
                    $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch { /* Logging must never crash the application. */ }
    }
}
