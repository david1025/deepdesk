# Implementation status

## Milestone 0 — Windows-native foundation

- [x] WPF + WebView2 host with packaged local UI.
- [x] WebView2 profile is stored under the local DeepDesk application data directory.
- [x] External HTTP(S) links open in the system browser.
- [x] Microphone permission is scoped to the DeepDesk virtual origin.

## Milestone 1 — Official DeepSeek Chat Demo integration

- [x] Build the official `deepseek-ai/chat-demo` source in CI.
- [x] Pin upstream baseline to `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`.
- [x] Stage the official `dist` directly into the Windows host.
- [x] Keep upstream localStorage / IndexedDB behavior instead of reimplementing chat storage.
- [x] Produce lightweight and self-contained Windows x64 artifacts.
- [ ] Windows runtime acceptance of every upstream feature.
- [ ] Verify exact UI parity at the same viewport and interaction states.

## Milestone 2 — Release

- [ ] File picker / drag-drop / paste acceptance.
- [ ] Voice input and read-aloud acceptance.
- [ ] Search, link reading, source citation acceptance.
- [ ] ZIP history import/export acceptance.
- [ ] Theme, language, settings, and location acceptance.
- [ ] Signed installer.
- [ ] Upgrade/uninstall QA.
- [ ] Auto-update.
- [ ] Automated Windows UI smoke tests.

Compilation is not considered feature parity.