# DeepDesk

DeepDesk is a Windows desktop shell for the official DeepSeek Chat Demo.

**The acceptance target is the official UI and feature set, not a visual imitation.**

## Architecture

- **UI:** the upstream `deepseek-ai/chat-demo` source is checked out and built in CI at a pinned commit.
- **Desktop shell:** .NET 10 WPF + Microsoft WebView2.
- **API:** the official web UI talks directly to the configured DeepSeek API.
- **Local data:** the official demo stores API settings in localStorage and conversations/attachments in IndexedDB; WebView2 keeps that data in `%LOCALAPPDATA%\\DeepDesk\\WebView2`.
- **Windows integration:** native host provides the local HTTPS origin, microphone permission boundary, and external-link handling.

The official project is a static frontend with no application backend and supports conversations, branches, streaming, deep thinking, search, link reading, citations, attachments, voice, Markdown, KaTeX, Mermaid, themes, and ZIP history import/export. citeturn104694search0

## Upstream baseline

Pinned source:

`deepseek-ai/chat-demo@5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`

This corresponds to the v0.1.1 release baseline. citeturn104694search2

## Windows builds

CI produces:

- **DeepDesk-Setup-x64** — recommended per-user Windows installer. It installs under `%LOCALAPPDATA%\\Programs\\DeepDesk`, creates Start Menu shortcuts, and upgrades the existing installation using a stable AppId.
- **DeepDesk-win-x64-lite** — portable build; requires .NET 10 Desktop Runtime and WebView2 Runtime.
- **DeepDesk-win-x64** — portable self-contained .NET build; still requires WebView2 Runtime.

The installer does not require administrator rights. Chat history, attachments, WebView2 profile, API Key and settings are stored outside the install folder under `%LOCALAPPDATA%\\DeepDesk`; the installer does not delete them on upgrade or uninstall. The first-run wizard has two optional steps: configure an API Key (validated and stored with Windows DPAPI) and learn how to import a DeepSeek ZIP history export. Both can be skipped; API Key setup and history import remain available later. Use Help → Check for updates to open the latest stable GitHub release page. Updates are installed by running the downloaded installer after closing DeepDesk. Preview builds are not code-signed yet.

## Development

The repository deliberately does not maintain a second hand-written copy of the DeepSeek Chat Demo UI. CI builds the upstream source and stages its `dist` into the WPF host.

For a local build:

1. Clone this repository.
2. Check out `deepseek-ai/chat-demo` at the pinned commit into `vendor/chat-demo`.
3. Run `pnpm install --frozen-lockfile && pnpm build` inside `vendor/chat-demo`.
4. Copy `vendor/chat-demo/dist` to `src/chat-ui/dist`.
5. Run `dotnet build src/DeepDesk/DeepDesk.csproj -c Release`.

## Acceptance

See `docs/acceptance.md`. Compilation alone does not count as feature parity; each upstream capability must be exercised on Windows with a real API key.

## License

DeepDesk wrapper code is MIT-licensed. The upstream DeepSeek Chat Demo is MIT-licensed; its license is copied into the packaged UI. Third-party dependencies retain their licenses.
