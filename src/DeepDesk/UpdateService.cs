using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json;

namespace DeepDesk;

internal sealed record AvailableUpdate(string Version, string ReleaseUrl, string TagName);

internal static class UpdateService
{
    private static readonly HttpClient Http = CreateClient();
    public static string CurrentVersion =>
        Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3)
        ?? "0.2.0-preview.1";

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("DeepDesk", "0.2.0"));
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    public static async Task<AvailableUpdate?> CheckAsync(CancellationToken cancellationToken = default)
    {
        using var response = await Http.GetAsync(
            "https://api.github.com/repos/david1025/deepdesk/releases?per_page=10", cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var current = ParseVersion(CurrentVersion);
        foreach (var release in document.RootElement.EnumerateArray())
        {
            if (release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            if (release.TryGetProperty("prerelease", out var prerelease) && prerelease.GetBoolean()) continue;
            var tag = release.TryGetProperty("tag_name", out var tagValue) ? tagValue.GetString() : null;
            var url = release.TryGetProperty("html_url", out var urlValue) ? urlValue.GetString() : null;
            if (string.IsNullOrWhiteSpace(tag) || !Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                uri.Host != "github.com" || !uri.AbsolutePath.StartsWith("/david1025/deepdesk/releases/tag/", StringComparison.Ordinal))
                continue;
            var candidate = ParseVersion(tag);
            var currentIsPreview = CurrentVersion.Contains('-', StringComparison.Ordinal);
            if (candidate > current || (candidate == current && currentIsPreview))
                return new AvailableUpdate(tag, uri.AbsoluteUri, tag);
        }
        return null;
    }

    private static Version ParseVersion(string value)
    {
        var normalized = value.Trim().TrimStart('v', 'V');
        var prerelease = normalized.IndexOfAny(['-', '+']);
        if (prerelease >= 0) normalized = normalized[..prerelease];
        return Version.TryParse(normalized, out var parsed) ? parsed : new Version(0, 0, 0);
    }
}
