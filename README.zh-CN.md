# DeepDesk

[English](README.md)

## 下载 v1.1.0 预发布版

- [Windows x64 安装包（.exe）](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-Setup-1.1.0-x64.exe)
- [Windows ARM64 安装包（.exe）](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-Setup-1.1.0-arm64.exe)，适用于 Windows 11 ARM64
- [macOS 通用磁盘镜像（.dmg）](https://github.com/david1025/deepdesk/releases/download/v1.1.0/DeepDesk-1.1.0-macOS-universal.dmg)，适用于 Apple 芯片和 Intel Mac

macOS 预览包采用临时签名，未经 Apple 公证。 [发布说明](https://github.com/david1025/deepdesk/releases/tag/v1.1.0)

DeepDesk 是适用于 Windows 和 macOS 的独立 DeepSeek API 桌面客户端。两端共用的 React 和 TypeScript 聊天界面源自 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo)。Windows 使用 WPF 和 WebView2，macOS 使用 SwiftUI、AppKit 和 WKWebView。

两端共用聊天、流式回复、Markdown 渲染和附件处理功能。聊天记录保存在本地。发送消息前，请在设置中填写自己的 DeepSeek API Key。macOS 版由原生程序保存到当前用户的 Application Support 私有文件，重启后继续使用。剩余功能和验证工作见 [V1 验收清单](docs/macos/06-v1-acceptance.md)。

## 桌面版本号

Windows 和 macOS 共用 [`VERSION`](VERSION) 中的发布版本号。macOS 的「关于」显示完整版本，应用包分别记录数字版本和构建号。发布新的 macOS 构建时，请递增 [XcodeGen 工程配置](apps/macos/project.yml)里的 `CURRENT_PROJECT_VERSION`。

## 从源码构建

先安装 Node.js 22 系列（至少 22.12）和 pnpm 10。克隆 `main` 分支后，从仓库根目录执行对应平台的命令。

```sh
git clone --branch main https://github.com/david1025/deepdesk.git
cd deepdesk
```

### Windows

需要 Windows 10/11 x64 或 Windows 11 ARM64、.NET 10 SDK 和 Microsoft Edge WebView2 Runtime。

在 Windows 11 ARM64 上，请使用 x64 版 Node.js 构建共享前端。Windows 应用按下方选择的架构发布。

```powershell
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web type
pnpm --dir apps/web build

# 为 Windows 11 ARM64 构建时改用 arm64
$arch = 'x64'
dotnet publish apps/windows/src/DeepDesk/DeepDesk.csproj -c Release -r "win-$arch" --self-contained true -o "artifacts/DeepDesk-win-$arch"
& ".\artifacts\DeepDesk-win-$arch\DeepDesk.exe"
```

如需生成安装包，安装 Inno Setup 6.3 或更新的 6.x 版本，在上面的发布命令完成后运行以下命令。安装包输出到 `artifacts/installer/`。

```powershell
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" "/DBuildArch=$arch" apps/windows/installer/DeepDesk.iss
```

### macOS

需要 macOS、已选定命令行工具的 Xcode，以及 XcodeGen 2.38 或更新版本。应用最低支持 macOS 13。

```bash
brew install xcodegen
./scripts/bootstrap-macos.sh
open artifacts/macos/Build/Products/Debug/DeepSeek.app
```

脚本会构建共享前端、生成 Xcode 工程，并构建用于本地运行的 Debug 应用。运行脚本后，可用 Xcode 打开 `apps/macos/DeepSeekMac.xcodeproj`。签名、公证和更新流程见 [macOS 发布手册](docs/macos/08-release.md)。

## 开源许可与署名

DeepDesk 采用 [MIT 许可证](LICENSE)。改编的 chat-demo 源码保留 [DeepSeek 的版权声明和 MIT 许可证](apps/web/LICENSE)。两个桌面构建均随包附带这些许可文本。独立许可的依赖见 [第三方许可声明](THIRD_PARTY_NOTICES.md)。
