# Architecture

## Runtime topology

```text
React static UI (WebView2 virtual HTTPS origin)
  | window.chrome.webview.postMessage
  v
WPF host / WebViewBridge (strict action allowlist)
  |-- CredentialService: DPAPI CurrentUser
  |-- DeepSeekApiService: HttpClient + SSE
  |-- AppSettingsService: non-secret JSON settings
  |-- IndexedDB: conversations and message history (renderer origin scoped)
  v
https://api.deepseek.com
```

No local HTTP server and no Node.js runtime are required. Node/pnpm are build-time dependencies only.

## Security boundaries
- WebView2 maps the packaged UI folder to `https://deepdesk.local`.
- Only this exact origin is permitted to invoke the bridge.
- Top-level navigation away from the app origin is cancelled and opened externally only for explicitly approved http(s) links (future feature).
- The bridge exposes named operations, never arbitrary filesystem paths or process execution.
- API keys are encrypted with Windows DPAPI CurrentUser and only decrypted inside the native API service.
- API requests go directly from .NET to the configured HTTPS API origin.
- Do not include credentials or conversation content in logs.

## Data ownership
- Conversation database: IndexedDB owned by the React application.
- API key: DPAPI-protected file under LocalAppData.
- Non-secret preferences: JSON under LocalAppData.
- User exports/backups: user-selected destination.
- Attachments: phase 2; define explicit lifecycle and server-retention UX before implementation.

## API compatibility
The upstream chat-demo currently uses DeepSeek's Anthropic-compatible Messages/Files endpoints and separate speech endpoints. This project must verify each capability against the current official API documentation before enabling it. The initial native service implements only streaming text chat and API-key verification. Search, file upload, link reading, ASR, and TTS remain disabled until their request/response contracts are validated.

## Streaming
The native host reads SSE frames, handles CRLF/LF boundaries and multi-line data fields, and emits normalized `delta`, `completed`, or `error` events. Cancellation is keyed by request ID and must not cancel unrelated chats.
