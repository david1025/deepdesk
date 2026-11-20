# DeepDesk

DeepDesk is an independent, local-first DeepSeek desktop client for Windows and macOS.

| Path | Purpose |
| --- | --- |
| `apps/web` | Shared React/TypeScript chat UI and desktop adapters |
| `apps/windows` | WPF / WebView2 host and Windows installer |
| `apps/macos` | SwiftUI / AppKit / WKWebView host |
| `contracts` | Versioned bridge and cross-device protocol contracts |
| `docs/macos` | macOS migration plan, V1 acceptance, and release instructions |

The native Android project has a separate repository and follows the same cross-device contract. Windows and macOS build and release independently.

## Build

Use Node 22.12+ and pnpm 10 for the shared UI.

**Windows** (.NET 10 SDK and WebView2 Runtime)

```powershell
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web type
pnpm --dir apps/web build
dotnet build apps/windows/src/DeepDesk/DeepDesk.csproj -c Release
```

**macOS** (Xcode and XcodeGen)

```bash
./scripts/bootstrap-macos.sh
```

See the [V1 acceptance checklist](docs/macos/06-v1-acceptance.md) for release requirements.

## License

DeepDesk retains its MIT license. The shared UI includes code from the MIT-licensed DeepSeek chat-demo. See [third-party notices](THIRD_PARTY_NOTICES.md) and the [upstream license](apps/web/LICENSE).
