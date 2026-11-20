# DeepDesk

[简体中文](README.zh-CN.md)

## Download v1.1.0 pre-release

- [Windows x64 installer (.exe)](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-Setup-1.1.0-x64.exe)
- [macOS universal disk image (.dmg)](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-1.1.0-macOS-universal.dmg) for Apple silicon and Intel

The macOS preview is ad hoc signed and has not been notarized. [Release notes](https://github.com/david1025/deepdesk/releases/tag/v1.1.0)

DeepDesk is an independent desktop client for the DeepSeek API on Windows and macOS. Its shared React and TypeScript chat interface is adapted from [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo). Windows hosts it in WPF and WebView2. macOS hosts it in SwiftUI, AppKit, and WKWebView.

The desktop apps share chat, streaming responses, Markdown rendering, and attachment handling. Conversations are stored locally. Enter your own DeepSeek API key in Settings before sending messages. On macOS the native app saves it in a user-only file in Application Support and reuses it on restart. See the [V1 acceptance checklist](docs/macos/06-v1-acceptance.md) for remaining work and validation.

## Desktop version

Windows and macOS use the release number in [`VERSION`](VERSION). On macOS, About shows the full release number. The app bundle records its numeric part and the build number separately. When preparing a new macOS distribution, increment `CURRENT_PROJECT_VERSION` in [the XcodeGen project spec](apps/macos/project.yml).

## Build from source

Install Node.js 22.12 or later in the 22 series and pnpm 10. Clone the desktop integration branch, then run the platform commands from the repository root.

```sh
git clone --branch integration/desktop-monorepo https://github.com/david1025/deepdesk.git
cd deepdesk
```

### Windows

You need Windows 10 or 11 x64, the .NET 10 SDK, and the Microsoft Edge WebView2 Runtime.

```powershell
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web type
pnpm --dir apps/web build

dotnet publish apps/windows/src/DeepDesk/DeepDesk.csproj -c Release -r win-x64 --self-contained true -o artifacts/DeepDesk-win-x64
& .\artifacts\DeepDesk-win-x64\DeepDesk.exe
```

To build a local installer, install Inno Setup 6 and run the following after publishing. The installer appears in `artifacts/installer/`.

```powershell
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" apps/windows/installer/DeepDesk.iss
```

### macOS

You need macOS, Xcode with the command-line tools selected, and XcodeGen 2.38 or later. The app targets macOS 13 and later.

```bash
brew install xcodegen
./scripts/bootstrap-macos.sh
open artifacts/macos/Build/Products/Debug/DeepSeek.app
```

The script builds the shared UI, generates the Xcode project, and builds a Debug app for local use. To work in Xcode, open `apps/macos/DeepSeekMac.xcodeproj` after running the script. For signing, notarization, and updates, see the [macOS release guide](docs/macos/08-release.md).

## License and attribution

DeepDesk is licensed under the [MIT License](LICENSE). The adapted chat-demo source retains [DeepSeek’s copyright and MIT license](apps/web/LICENSE). Both desktop builds include these notices. See [Third-party notices](THIRD_PARTY_NOTICES.md) for separately licensed dependencies.
