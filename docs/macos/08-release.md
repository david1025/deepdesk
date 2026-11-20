# 构建、发布、公证与 Sparkle 更新手册

## 1. Debug 构建

Mac 安装 Xcode / Xcode Command Line Tools / Homebrew / XcodeGen；终端执行：

```bash
brew install xcodegen
# 将 Windows 自定义版 Web 源码放入 apps/web 后：
./scripts/build-web.sh
./scripts/bootstrap-macos.sh
open apps/macos/DeepSeekMac.xcodeproj
```

Debug 的 Bundle ID `com.example.deepseekmac` 是占位，务必在发布前设定正式 ID，并在后续版本中保持稳定。

## 2. 正式 Release 前必改

- apps/macos/project.yml：Bundle ID、产品显示名称、组织 Team、签名配置、`CODE_SIGNING_ALLOWED` Release。
- apps/macos/Config/Info.plist：`SUFeedURL` 和真实 `SUPublicEDKey`、权限文案、关于和版权信息；不要把私钥写进任何 plist。
- apps/macos/Config/DeepSeekMac.entitlements：审计实际网络和系统权限、Hardened Runtime；如果做 sandbox，遵循 Apple entitlement 和容器路径。
- 使用团队正式图标替换默认图标，创建 `.xcassets/AppIcon`，按 macOS 高/低分辨率要求生产。
- 完成用户数据存储迁移；App Bundle 只放只读 UI，用户数据位于 Application Support。
- 安装包和 appcast 走 HTTPS；服务端 Cache-Control、下载完整性、更新撤销与回滚预案需要验证。

## 3. 发布命令参考（由签名机器执行）

```bash
cd macos
xcodegen generate --spec project.yml
xcodebuild -project DeepSeekMac.xcodeproj -scheme DeepSeekMac \
  -configuration Release -destination 'generic/platform=macOS' \
  -archivePath "$PWD/build/DeepSeek.xcarchive" archive

# 打包签名 .app：实际签名应由 Xcode archive / export 流程完成，确保所有嵌套 Sparkle 组件均已正确签名。
# 验证：
codesign --verify --deep --strict --verbose=2 build/DeepSeek.xcarchive/Products/Applications/DeepSeek.app
spctl --assess --type execute --verbose=4 build/DeepSeek.xcarchive/Products/Applications/DeepSeek.app
```

之后按公司签名策略创建 `.dmg`，运行 `xcrun notarytool submit path/to/DeepSeek.dmg --keychain-profile PROFILE --wait`，成功后 `xcrun stapler staple path/to/DeepSeek.dmg` 与 `xcrun stapler validate`。**前提是有 Apple Developer ID 证书和已配置的 notarytool profile**。不要将证书/密码/私钥写入脚本仓库。

## 4. Sparkle 2

Swift Package：`https://github.com/sparkle-project/Sparkle`；骨架已经声明 SPM 包和 UpdateService。发布前须：

1. 在安全机器上通过 Sparkle 官方 `generate_keys` 创建 EdDSA 签名密钥；私钥存安全位置，仅发布使用。
2. 将公钥写 `SUPublicEDKey`、HTTPS feed 写入 `SUFeedURL`。
3. 生产 DMG 或 ZIP；对更新包运行 Sparkle 官方 `sign_update`/`generate_appcast` 工具并发布 appcast。
4. appcast 记录正确版本、签名、URL 与更新说明；对不同架构进行充分测试。
5. 从旧签名版本实际升级到新版本，验证数据库迁移、安全凭据和窗口状态。

Sparkle 文档：https://sparkle-project.org/documentation/ 。

## 5. CI

`.github/workflows/build-macos.yml` 当前仅执行无签名的编译检查；完整 Release CI 还要添加签名、公证、发布和更新清单流水线。签名凭据放 GitHub Encrypted Secrets / OIDC 与安全密钥管理，不通过 PR/日志泄露。

## 6. 发布前最终清单

- [ ] `docs/06-v1-acceptance.md` 全部真实测试通过
- [ ] 软件许可（MIT/第三方）与产品命名/Logo 权益已核对
- [ ] Apple Developer ID 签名/公证已验证
- [ ] 生产 API base URL / Keychain / 同步身份稳定
- [ ] Sparkle 正式签名更新端到端验证
- [ ] 灰度/回滚与旧版数据库备份策略已验证
