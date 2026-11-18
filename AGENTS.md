# Agent instructions

## Product constraints
- Windows-first native desktop application. Use WPF + WebView2; do not introduce Electron, Node.js runtime servers, or DeepSeek Harness.
- The React UI is a build-time asset only. Runtime requests to the model provider must be sent by the .NET host.
- Never expose API keys to JavaScript, localStorage, IndexedDB, URLs, logs, or exception text.
- Restrict WebView2 navigation and Native Bridge messages to the app's virtual HTTPS origin.
- Use explicit bridge action allowlists and validate every payload.
- Keep conversation content in browser IndexedDB. Keep credentials in Windows DPAPI CurrentUser protected storage.
- Never claim support for an API capability until its current official protocol has been verified.
- Preserve upstream DeepSeek chat-demo MIT license and notices when integrating its source.

## Engineering
- Prefer small, reviewable changes.
- Keep C# nullable enabled and use async APIs.
- Handle cancellation, timeouts, non-2xx responses, malformed SSE, and app shutdown.
- Do not log prompts, completions, file contents, or authorization headers.
- Add tests for protocol parsing and bridge validation where practical.
- Build the frontend and WPF project in CI on Windows.
