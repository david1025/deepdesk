# DeepDesk

A lightweight native Windows AI desktop client with local-first storage and bring-your-own API keys.

> DeepDesk is an independent third-party client. It is not affiliated with or endorsed by DeepSeek.

## Status

Early development. The first milestone establishes the Windows desktop shell, WebView2 local UI, a restricted native bridge, DPAPI-backed API key storage, and DeepSeek streaming chat.

## Architecture

- **Desktop:** .NET 10 WPF + Microsoft WebView2
- **UI:** React + TypeScript + Rspack
- **Native services:** C# HttpClient, Windows DPAPI, local application data
- **Model provider:** user-configured DeepSeek API key; requests go directly to the configured API endpoint
- **Storage:** browser IndexedDB for conversations; native protected storage for credentials

## Development

See [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).

### Requirements

- Windows 10/11 x64
- .NET 10 SDK
- Node.js 22.12+ and pnpm 10+
- Microsoft Edge WebView2 Runtime

### Build

```powershell
corepack enable
pnpm install --dir src/chat-ui
pnpm --dir src/chat-ui build
dotnet build src/DeepDesk/DeepDesk.csproj -c Release
```

The UI build is copied into the WPF output and loaded through a WebView2 virtual host mapping. No Node.js server is required at runtime.

## License

The DeepDesk application code is licensed under MIT unless otherwise noted. The upstream DeepSeek chat-demo is MIT-licensed; its copyright and license notices must be retained when its source is incorporated. Third-party dependencies retain their respective licenses.
