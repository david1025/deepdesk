# DeepDesk

[简体中文](README.zh-CN.md)

## Download v1.1.0 pre-release

- [Windows x64 installer (.exe)](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-Setup-1.1.0-x64.exe)
- [Windows ARM64 installer (.exe)](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-Setup-1.1.0-arm64.exe) for Windows 11 on Arm
- [macOS universal disk image (.dmg)](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-1.1.0-macOS-universal.dmg) for Apple silicon and Intel

The macOS preview is ad hoc signed and has not been notarized. [Release notes](https://github.com/david1025/deepdesk/releases/tag/v1.1.0)

DeepDesk is an independent desktop client for the DeepSeek API on Windows and macOS. Its shared React and TypeScript chat interface is adapted from [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo). Windows hosts it in WPF and WebView2. macOS hosts it in SwiftUI, AppKit, and WKWebView.

The desktop apps share chat, streaming responses, Markdown rendering, and attachment handling. Conversations are stored locally. Enter your own DeepSeek API key in Settings before sending messages. On macOS the native app saves it in a user-only file in Application Support and reuses it on restart. See the [V1 acceptance checklist](docs/macos/06-v1-acceptance.md) for remaining work and validation.

## Desktop version

Windows and macOS use the release number in [`VERSION`](VERSION). On macOS, About shows the full release number. The app bundle records its numeric part and the build number separately. When preparing a new macOS distribution, increment `CURRENT_PROJECT_VERSION` in [the XcodeGen project spec](apps/macos/project.yml).

## Build from source

Install Node.js 22.12 or later in the 22 series and pnpm 10. Clone the `main` branch, then run the platform commands from the repository root.

```sh
git clone --branch main https://github.com/david1025/deepdesk.git
cd deepdesk
```

### Windows

You need Windows 10/11 x64 or Windows 11 ARM64, the .NET 10 SDK, and the Microsoft Edge WebView2 Runtime.

On Windows 11 ARM64, use the x64 build of Node.js for the shared frontend. The Windows app is published for the architecture selected below.

```powershell
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web type
pnpm --dir apps/web build

# Use arm64 when building for Windows 11 on Arm
$arch = 'x64'
dotnet publish apps/windows/src/DeepDesk/DeepDesk.csproj -c Release -r "win-$arch" --self-contained true -o "artifacts/DeepDesk-win-$arch"
& ".\artifacts\DeepDesk-win-$arch\DeepDesk.exe"
```

To build a local installer, install Inno Setup 6.3 or a later 6.x version and run the following after publishing. The installer appears in `artifacts/installer/`.

```powershell
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" "/DBuildArch=$arch" apps/windows/installer/DeepDesk.iss
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
