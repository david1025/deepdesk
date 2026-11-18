# Architecture

## Runtime topology

```text
Official React Chat Demo (static assets in WebView2)
  | fetch to allowlisted DeepSeek API HTTPS origin
  v
WebView2 host request interception (credential injection only for api.deepseek.com)
  |-- CredentialService: Windows DPAPI CurrentUser
  |-- Native bridge: status, key management, balance, speech, cancellation
  |-- IndexedDB: conversations, messages, attachments
  v
https://api.deepseek.com
```

No local HTTP server and no Node.js runtime are required. Node/pnpm are build-time dependencies only.

## Security boundaries

- WebView2 maps the packaged UI folder to `https://deepdesk.local`.
- Only this exact origin may invoke the native bridge.
- Top-level navigation away from the app origin is cancelled; only absolute HTTP/HTTPS links without embedded credentials may open externally.
- The bridge exposes named operations, never arbitrary filesystem paths or process execution.
- API keys are encrypted with Windows DPAPI CurrentUser and are not intentionally exposed to renderer storage. The renderer holds a non-secret sentinel only.
- WebView2 attaches credentials only to HTTPS requests whose host is exactly `api.deepseek.com`.
- Do not include credentials or conversation content in logs.

## Data ownership

- Conversation database and local attachments: IndexedDB owned by the official React application, scoped to the DeepDesk virtual origin.
- API key: DPAPI-protected file under LocalAppData.
- WebView2 profile: under LocalAppData DeepDesk directory.
- User exports/backups: user-selected destination.
- App logs: LocalAppData, restricted to operational metadata and exception types; never prompts, completions, file contents or credentials.

## API compatibility

The pinned official Chat Demo implements Anthropic-compatible Messages and Files APIs plus separate speech endpoints. The Windows host currently supplies credentials to the renderer's requests and provides native key management, account-balance, and speech bridge actions. The host also contains a separate streaming API service; it is not currently the renderer's chat transport. Each API capability must be validated against current official documentation and real Windows runtime tests before release.

## Streaming and cancellation

The official renderer parses the chat SSE stream and owns conversation state. The native host's standalone streaming service parses SSE and supports request-ID cancellation, but the current renderer chat flow does not use that service. Windows acceptance must verify the actual renderer request cancellation and app shutdown behavior independently.
