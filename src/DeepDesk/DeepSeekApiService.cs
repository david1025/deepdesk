using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DeepDesk;

internal sealed class DeepSeekApiService
{
    private static readonly Uri ApiBase = new("https://api.deepseek.com/");
    private const string MessagesEndpoint = "anthropic/v1/messages";
    private const string SystemPrompt = "该助手为DeepSeek，由深度求索公司创造。";
    private readonly HttpClient _http = new() { BaseAddress = ApiBase, Timeout = Timeout.InfiniteTimeSpan };
    private readonly CredentialService _credentials;

    public DeepSeekApiService(CredentialService credentials) => _credentials = credentials;

    public Task TestKeyAsync(CancellationToken cancellationToken) =>
        TestKeyAsync(_credentials.ReadApiKey(), cancellationToken);

    public async Task TestKeyAsync(string apiKey, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "models");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new ApiServiceException("API_AUTH_FAILED", "API Key 无效或无权访问。");
        if (!response.IsSuccessStatusCode)
            throw new ApiServiceException("API_REQUEST_FAILED", $"连接测试失败（HTTP {(int)response.StatusCode}）。");
    }

    public async Task<byte[]> SynthesizeAsync(string text, string voice, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > 12000)
            throw new ApiServiceException("INVALID_REQUEST", "朗读文本为空或超过 12000 个字符。");
        if (voice is not ("stella" or "tide"))
            throw new ApiServiceException("INVALID_REQUEST", "不支持的朗读音色。");
        using var request = new HttpRequestMessage(HttpMethod.Post, "v1/tools/tts");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _credentials.ReadApiKey());
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            text, voice_id = voice, format = "pcm", filter_markdown = true
        }), Encoding.UTF8, "application/json");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new ApiServiceException("API_AUTH_FAILED", "API Key 无效或无权访问。");
            if ((int)response.StatusCode == 429)
                throw new ApiServiceException("API_RATE_LIMITED", "语音合成请求过于频繁。");
            throw new ApiServiceException("API_REQUEST_FAILED", $"语音合成失败（HTTP {(int)response.StatusCode}）。");
        }
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var output = new MemoryStream();
        var buffer = new byte[32 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, timeout.Token)) > 0)
        {
            if (output.Length + read > 8 * 1024 * 1024)
                throw new ApiServiceException("API_PROTOCOL_ERROR", "朗读音频超过 8 MiB 限制。");
            output.Write(buffer, 0, read);
        }
        if (output.Length == 0 || output.Length % 2 != 0)
            throw new ApiServiceException("API_PROTOCOL_ERROR", "语音合成返回的 PCM 数据无效。");
        return output.ToArray();
    }

    public async Task<string> TranscribeAsync(byte[] wav, CancellationToken cancellationToken)
    {
        if (wav.Length < 44 || wav.Length > 8 * 1024 * 1024)
            throw new ApiServiceException("INVALID_REQUEST", "录音文件大小无效（最大 8 MiB）。");
        using var form = new MultipartFormDataContent();
        var audio = new ByteArrayContent(wav);
        audio.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        form.Add(audio, "file", "recording.wav");
        using var request = new HttpRequestMessage(HttpMethod.Post, "v1/tools/asr");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _credentials.ReadApiKey());
        request.Content = form;
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new ApiServiceException("API_AUTH_FAILED", "API Key 无效或无权访问。");
            if ((int)response.StatusCode == 429)
                throw new ApiServiceException("API_RATE_LIMITED", "语音识别请求过于频繁。");
            throw new ApiServiceException("API_REQUEST_FAILED", $"语音识别失败（HTTP {(int)response.StatusCode}）。");
        }
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        if (!json.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
            throw new ApiServiceException("API_PROTOCOL_ERROR", "语音识别返回格式无效。");
        return text.GetString() ?? "";
    }

    public async Task StreamChatAsync(string requestId, JsonElement payload,
        Func<string, string, Task> onEvent, CancellationToken cancellationToken)
    {
        var model = payload.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "deepseek-flash";
        if (model is not ("deepseek-flash" or "deepseek-v4-pro"))
            throw new ApiServiceException("INVALID_REQUEST", "当前版本不支持所选模型。");
        if (!payload.TryGetProperty("messages", out var messages) ||
            messages.ValueKind != JsonValueKind.Array || messages.GetArrayLength() is < 1 or > 100)
            throw new ApiServiceException("INVALID_REQUEST", "消息列表无效。");

        foreach (var message in messages.EnumerateArray())
        {
            if (!message.TryGetProperty("role", out var role) ||
                role.GetString() is not ("user" or "assistant") ||
                !message.TryGetProperty("content", out var content) ||
                content.ValueKind != JsonValueKind.String ||
                content.GetString()!.Length > 200_000)
                throw new ApiServiceException("INVALID_REQUEST", "消息内容或角色无效。");
        }

        var thinkingEnabled = payload.TryGetProperty("thinking", out var thinking) &&
            thinking.ValueKind == JsonValueKind.True;
        var searchEnabled = payload.TryGetProperty("search", out var search) &&
            search.ValueKind == JsonValueKind.True;
        var tools = new List<object>
        {
            new { type = "deepseek_read_url", name = "deepseek_read_url" }
        };
        if (searchEnabled)
            tools.Add(new { type = "deepseek_web_search", name = "deepseek_web_search" });

        var body = new
        {
            model,
            system = SystemPrompt,
            messages,
            thinking = new { type = thinkingEnabled ? "enabled" : "disabled" },
            tools,
            safety_check = new { level = "high" }
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, MessagesEndpoint);
        request.Headers.TryAddWithoutValidation("x-api-key", _credentials.ReadApiKey());
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new ApiServiceException("API_AUTH_FAILED", "API Key 无效或无权访问。");
            if ((int)response.StatusCode == 429)
                throw new ApiServiceException("API_RATE_LIMITED", "请求过于频繁，请稍后重试。");
            var detail = await ReadErrorMessageAsync(response, cancellationToken);
            throw new ApiServiceException("API_REQUEST_FAILED",
                string.IsNullOrWhiteSpace(detail) ? $"模型请求失败（HTTP {(int)response.StatusCode}）。" : detail);
        }

        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (contentType is null || !contentType.Equals("text/event-stream", StringComparison.OrdinalIgnoreCase))
            throw new ApiServiceException("API_PROTOCOL_ERROR", "服务端没有返回 SSE 流式响应。");

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var dataLines = new List<string>();
        var messageStopped = false;

        async Task DispatchFrameAsync()
        {
            if (dataLines.Count == 0) return;
            var data = string.Join("\n", dataLines);
            dataLines.Clear();
            try
            {
                using var json = JsonDocument.Parse(data);
                var root = json.RootElement;
                var eventType = root.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
                if (eventType == "error")
                {
                    var message = root.TryGetProperty("error", out var error) &&
                        error.TryGetProperty("message", out var errorMessage)
                        ? errorMessage.GetString() : null;
                    throw new ApiServiceException("API_REQUEST_FAILED", message ?? "模型服务返回错误。");
                }

                if (eventType == "content_block_delta" &&
                    root.TryGetProperty("delta", out var delta) &&
                    delta.TryGetProperty("type", out var deltaType))
                {
                    var kind = deltaType.GetString();
                    var field = kind == "text_delta" ? "text" : kind == "thinking_delta" ? "thinking" : null;
                    if (field is not null && delta.TryGetProperty(field, out var value))
                    {
                        var chunk = value.GetString();
                        if (!string.IsNullOrEmpty(chunk))
                            await onEvent(chunk, kind == "thinking_delta" ? "reasoning" : "content");
                    }
                }
                else if (eventType == "content_block_start" &&
                    root.TryGetProperty("content_block", out var block) &&
                    block.TryGetProperty("type", out var blockType))
                {
                    var blockName = blockType.GetString();
                    if (blockName == "server_tool_use")
                    {
                        var kind = block.TryGetProperty("kind", out var kindValue) ? kindValue.GetString() : "search";
                        await onEvent(kind == "read_link" ? "正在阅读链接…" : "正在联网搜索…", "status");
                    }
                    else if (blockName is "web_search_tool_result" or "web_fetch_tool_result")
                    {
                        await onEvent(blockName == "web_fetch_tool_result" ? "网页内容已读取" : "搜索结果已返回", "status");
                    }
                }
                else if (eventType == "message_stop")
                {
                    messageStopped = true;
                }
            }
            catch (JsonException)
            {
                throw new ApiServiceException("API_PROTOCOL_ERROR", "模型返回了无法识别的 SSE 数据。");
            }
        }

        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null) break;
            if (line.Length == 0)
            {
                await DispatchFrameAsync();
                if (messageStopped) return;
                continue;
            }
            if (line.StartsWith(':')) continue;
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                var value = line[5..];
                dataLines.Add(value.StartsWith(' ') ? value[1..] : value);
            }
        }
        await DispatchFrameAsync();
        if (!messageStopped && !cancellationToken.IsCancellationRequested)
            throw new ApiServiceException("API_PROTOCOL_ERROR", "模型响应在正常结束前中断。");
    }

    private static async Task<string?> ReadErrorMessageAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            using var json = JsonDocument.Parse(text);
            if (json.RootElement.TryGetProperty("error", out var error) &&
                error.TryGetProperty("message", out var message))
                return message.GetString();
        }
        catch { /* 不把原始响应体写入日志或透传可能敏感的内容。 */ }
        return null;
    }
}

internal sealed class ApiServiceException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
