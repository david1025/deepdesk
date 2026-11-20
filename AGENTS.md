# Repository instructions

- Windows and macOS build from `apps/web`. Preserve Windows custom behavior and use platform adapters for native operations.
- For shared UI and contract changes, apply the relevant requirements from both [Windows](apps/windows/AGENTS.md) and [macOS](apps/macos/AGENTS.md).
- Preserve the DeepSeek chat-demo MIT license. Keep signing material, tokens, keys and user data out of source control.
- Changes to the cross-device contract require a version and upgrade path, plus Windows, macOS and Android interoperability validation.
