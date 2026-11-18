# DeepDesk

DeepDesk is a Windows desktop wrapper for the **official DeepSeek Chat Demo**. Its UI is built from the upstream `deepseek-ai/chat-demo` source at a pinned commit, rather than re-created with a look-alike React interface.

> DeepDesk is an independent third-party desktop wrapper. It is not affiliated with or endorsed by DeepSeek.

## Product acceptance target

The acceptance baseline is the upstream Chat Demo, not a custom approximation. The desktop build uses the upstream UI source and its native browser storage (localStorage + IndexedDB) inside a WebView2 profile under `%LOCALAPPDATA%\DeepDesk\WebView2`.

Upstream source: https://github.com/deepseek-ai/chat-demo
Pinned upstream commit: `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`

## Desktop architecture

- **Desktop host:** .NET 10 WPF + Microsoft WebView2
- **UI:** official DeepSeek Chat Demo (React + TypeScript + Rspack), built from pinned upstream source in CI
- **API:** official UI calls the configured DeepSeek API directly
- **Local data:** WebView2 localStorage and IndexedDB in the app's local profile
- **Desktop integration:** microphone permission scoped to the local app origin; external HTTP(S) links open in the system browser

## Build and download

The GitHub Actions workflow checks out the official UI at the pinned commit, type-checks and builds it, stages its `dist` into the WPF host, then publishes two Windows x64 packages:

- `DeepDesk-win-x64-lite`: smaller, framework-dependent build; requires the .NET 10 Desktop Runtime and WebView2 Runtime.
- `DeepDesk-win-x64`: larger self-contained build; still requires the WebView2 Runtime.

Use the lite artifact first if download speed is an issue. Both artifacts are available from the latest successful [Windows Actions run](https://github.com/david1025/deepdesk/actions).

## Requirements for local development

- Windows 10/11 x64
- .NET 10 SDK
- Node.js 22.12+ and pnpm 10+
- Microsoft Edge WebView2 Runtime

See [AGENTS.md](AGENTS.md), [docs/architecture.md](docs/architecture.md), and [docs/acceptance.md](docs/acceptance.md).

## Licensing

DeepDesk wrapper code is MIT-licensed. The upstream DeepSeek Chat Demo is MIT-licensed; its license is copied into the built UI. Third-party dependencies retain their respective licenses.
