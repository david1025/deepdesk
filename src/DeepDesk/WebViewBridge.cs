using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace DeepDesk;

internal sealed class WebViewBridge
{
    private readonly CoreWebView2 _web;
    private readonly CredentialService _credentials;
    private readonly DeepSeekApiService _api;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _requests = new();
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public WebViewBridge(CoreWebView2 web, CredentialService credentials, DeepSeekApiService api)
    {
        _web = web;
        _credentials = credentials;
        _api = api;
        _web.WebMessageReceived += OnMessage;
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) ||
            source.Scheme != "https" || source.Host != "deepdesk.local") return;

        string? requestId = null;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            requestId = root.TryGetProperty("requestId", out var id) ? id.GetString() : null;
            var action = root.TryGetProperty("action", out var a) ? a.GetString() : null;
            var payload = root.TryGetProperty("payload", out var p) ? p : default;
            if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 80 || string.IsNullOrWhiteSpace(action))
                throw new ApiServiceException("INVALID_REQUEST", "请求格式无效。");

            switch (action)
            {
                case "app.openExternal":
                    var externalText = payload.TryGetProperty("url", out var externalValue) ? externalValue.GetString() : null;
                    if (!Uri.TryCreate(externalText, UriKind.Absolute, out var externalUri) ||
                        externalUri.UserInfo.Length > 0 ||
                        (externalUri.Scheme != Uri.UriSchemeHttps && externalUri.Scheme != Uri.UriSchemeHttp))
                        throw new ApiServiceException("INVALID_REQUEST", "仅允许打开 HTTP 或 HTTPS 网页链接。");
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(externalUri.AbsoluteUri) { UseShellExecute = true });
                    Reply(requestId, true, new { opened = true });
                    break;
                case "app.getStatus":
                    Reply(requestId, true, new { apiKeyConfigured = _credentials.Exists, appVersion = UpdateService.CurrentVersion });
                    break;
                case "settings.configureApiKey":
                    var dialog = new ApiKeyDialog { Owner = System.Windows.Application.Current.MainWindow };
                    if (dialog.ShowDialog() == true)
                    {
                        await _api.TestKeyAsync(dialog.ApiKey, CancellationToken.None);
                        _credentials.SaveApiKey(dialog.ApiKey);
                        Reply(requestId, true, new { saved = true, valid = true });
                    }
                    else
                    {
                        throw new ApiServiceException("REQUEST_CANCELLED", "已取消 API Key 配置。");
                    }
                    break;
                case "settings.saveApiKey":
                    var suppliedKey = payload.TryGetProperty("apiKey", out var keyValue) ? keyValue.GetString() : null;
                    if (string.IsNullOrWhiteSpace(suppliedKey))
                        throw new ApiServiceException("INVALID_REQUEST", "API Key 不能为空。");
                    await _api.TestKeyAsync(suppliedKey, CancellationToken.None);
                    _credentials.SaveApiKey(suppliedKey);
                    Reply(requestId, true, new { saved = true, valid = true });
                    break;
                case "api.getBalance":
                    if (!_credentials.Exists) throw new ApiServiceException("API_KEY_MISSING", "请先配置 API Key。");
                    var balance = await _api.GetBalanceAsync(CancellationToken.None);
                    Reply(requestId, true, balance);
                    break;
                case "settings.clearApiKey":
                    _credentials.Clear();
                    Reply(requestId, true, new { cleared = true });
                    break;
                case "settings.testApiKey":
                    await _api.TestKeyAsync(CancellationToken.None);
                    Reply(requestId, true, new { valid = true });
                    break;
                case "speech.synthesize":
                    if (!_credentials.Exists) throw new ApiServiceException("API_KEY_MISSING", "请先配置 API Key。");
                    var speechText = payload.TryGetProperty("text", out var textValue) ? textValue.GetString() : null;
                    var voice = payload.TryGetProperty("voice", out var voiceValue) ? voiceValue.GetString() ?? "stella" : "stella";
                    using (var speechTimeout = new CancellationTokenSource(TimeSpan.FromMinutes(2)))
                    {
                        var pcm = await _api.SynthesizeAsync(speechText ?? "", voice, speechTimeout.Token);
                        Reply(requestId, true, new { audioBase64 = Convert.ToBase64String(pcm), sampleRate = 24000 });
                    }
                    break;
                case "speech.transcribe":
                    if (!_credentials.Exists) throw new ApiServiceException("API_KEY_MISSING", "请先配置 API Key。");
                    if (!payload.TryGetProperty("audioBase64", out var audioValue) ||
                        audioValue.ValueKind != JsonValueKind.String)
                        throw new ApiServiceException("INVALID_REQUEST", "录音数据无效。");
                    var encodedAudio = audioValue.GetString() ?? "";
                    if (encodedAudio.Length > 12 * 1024 * 1024)
                        throw new ApiServiceException("INVALID_REQUEST", "录音数据超过大小限制。");
                    byte[] audioBytes;
                    try { audioBytes = Convert.FromBase64String(encodedAudio); }
                    catch (FormatException) { throw new ApiServiceException("INVALID_REQUEST", "录音数据编码无效。"); }
                    var transcript = await _api.TranscribeAsync(audioBytes, CancellationToken.None);
                    Reply(requestId, true, new { text = transcript });
                    break;
                case "api.cancel":
                    var target = payload.GetProperty("targetRequestId").GetString();
                    if (target is not null && _requests.TryGetValue(target, out var cts)) cts.Cancel();
                    Reply(requestId, true, new { cancelled = true });
                    break;
                case "api.chat":
                    if (!_credentials.Exists) throw new ApiServiceException("API_KEY_MISSING", "请先在设置中配置 API Key。");
                    var linked = new CancellationTokenSource(TimeSpan.FromMinutes(5));
                    if (!_requests.TryAdd(requestId, linked)) throw new ApiServiceException("INVALID_REQUEST", "请求 ID 重复。");
                    try
                    {
                        await _api.StreamChatAsync(requestId, payload, async (text, kind) =>
                        {
                            await _web.ExecuteScriptAsync($"window.deepDeskReceive({JsonSerializer.Serialize(new { type = "stream", requestId, @event = "delta", data = new { text, kind } }, JsonOptions)})");
                        }, linked.Token);
                        await _web.ExecuteScriptAsync($"window.deepDeskReceive({JsonSerializer.Serialize(new { type = "stream", requestId, @event = "completed" }, JsonOptions)})");
                    }
                    finally
                    {
                        _requests.TryRemove(requestId, out _);
                        linked.Dispose();
                    }
                    break;
                default:
                    throw new ApiServiceException("ACTION_NOT_ALLOWED", "不支持的操作。");
            }
        }
        catch (Exception ex)
        {
            var code = ex is ApiServiceException apiError ? apiError.Code : "REQUEST_FAILED";
            var message = ex is OperationCanceledException ? "请求已取消。" : ex.Message;
            if (requestId is not null)
                Reply(requestId, false, new { code, message });
        }
    }

    private void Reply(string requestId, bool success, object data)
    {
        var message = new { type = "response", requestId, success, data };
        _web.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
    }
}
