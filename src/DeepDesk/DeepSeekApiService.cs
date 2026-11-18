using System.Net;\nusing System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DeepDesk;

internal sealed class DeepSeekApiService
{
    private static readonly Uri ApiBase = new("https://api.deepseek.com/");
    private readonly HttpClient _http = new() { BaseAddress = ApiBase, Timeout = Timeout.InfiniteTimeSpan };
    private readonly CredentialService _credentials;

    public DeepSeekApiService(CredentialService credentials) => _credentials = credentials;

    public async Task TestKeyAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "models");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _credentials.ReadApiKey());
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.Forbidden)
            throw new ApiServiceException("API_AUTH_FAILED", "API Key 无效或无权访问。");
        if (!response.IsSuccessStatusCode)
            throw new ApiServiceException("API_REQUEST_FAILED", $"连接测试失败（HTTP {(int)response.StatusCode}）。");
    }

    public async Task StreamChatAsync(string requestId, JsonElement payload, Func<string, string, Task> onDelta,
        CancellationToken cancellationToken)
    {
        var model = payload.TryGetProperty("model", out var modelValue) ? modelValue.GetString() : "deepseek-chat";
        if (string.IsNullOrWhiteSpace(model) || model.Length > 100)
            throw new ApiServiceException("INVALID_REQUEST", "模型名称无效。");
        if (!payload.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array ||
            messages.GetArrayLength() is < 1 or > 100)
            throw new ApiServiceException("INVALID_REQUEST", "消息列表无效。");

        var body = new Dictionary<string, object?> { ["model"] = model, ["messages"] = messages, ["stream"] = true };
        if (payload.TryGetProperty("thinking", out var thinking) && thinking.ValueKind is JsonValueKind.True or JsonValueKind.False)
            body["thinking"] = new { type = thinking.GetBoolean() ? "enabled" : "disabled" };

        using var request = new HttpRequestMessage(HttpMethod.Post, "chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _credentials.ReadApiKey());
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new ApiServiceException("API_AUTH_FAILED", "API Key 无效或无权访问。");
            if ((int)response.StatusCode == 429)
                throw new ApiServiceException("API_RATE_LIMITED", "请求过于频繁，请稍后重试。");
            throw new ApiServiceException("API_REQUEST_FAILED", $"模型请求失败（HTTP {(int)response.StatusCode}）。");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null) break;
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") return;
            try
            {
                using var json = JsonDocument.Parse(data);
                if (json.RootElement.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0 &&
                    choices[0].TryGetProperty("delta", out var delta))
                {
                    if (delta.TryGetProperty("reasoning_content", out var reasoning) && reasoning.ValueKind == JsonValueKind.String)
                    {
                        var thought = reasoning.GetString();
                        if (!string.IsNullOrEmpty(thought)) await onDelta(thought, "reasoning");
                    }
                    if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                    {
                        var answer = content.GetString();
                        if (!string.IsNullOrEmpty(answer)) await onDelta(answer, "content");
                    }
                }
            }
            catch (JsonException)
            {
                throw new ApiServiceException("API_PROTOCOL_ERROR", "模型返回了无法识别的数据流。");
            }
        }
    }
}

internal sealed class ApiServiceException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
