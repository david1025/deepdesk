# Implementation status

## Milestone 0 — Windows-native foundation

- [x] WPF + WebView2 host with packaged local UI.
- [x] WebView2 profile is stored under the local DeepDesk application data directory.
- [x] External HTTP(S) links open in the system browser.
- [x] Microphone permission is scoped to the DeepDesk virtual origin.
- [ ] Independently verify all navigation and bridge-origin edge cases on Windows.

## Milestone 1 — Official DeepSeek Chat Demo integration

- [x] Build the official `deepseek-ai/chat-demo` source in CI.
- [x] Pin upstream baseline to `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`.
- [x] Stage the official `dist` directly into the Windows host.
- [x] Keep upstream localStorage / IndexedDB behavior for conversations and attachments.
- [x] Produce lightweight and self-contained Windows x64 artifacts.
- [x] Owner-reported runtime checks: Windows launch, chat, streaming, local history, model switching, ZIP merge/replace import, export.
- [x] Owner-reported professional-mode persistence after restart and Deep Thinking button hidden when enabled.
- [x] Owner-reported PDF upload/read, drag-drop, Ctrl+V paste, web search/link reading, balance/Token display, code and formula rendering.
- [ ] Full Windows runtime acceptance of every upstream feature.
- [ ] Verify exact UI parity at the same viewport and interaction states.

## Milestone 2 — Stage 3 acceptance

- [x] Fix replacement API-key flow to verify new key natively before saving.
- [x] Correct professional-mode effort mapping: `none/low/high/max` drives the mode via `output_config.effort`; omit explicit `thinking.type` in this mode.
- [x] Add a repeatable Windows manual acceptance matrix in `docs/acceptance.md`.
- [ ] Run the remaining matrix on Windows with a real API key (core chat, ZIP handling, mode persistence, PDF, web, balance display and rendering have owner-reported passes; API key replacement and voice input remain untested).
- [ ] Validate balance and usage figures against provider responses (UI display passed; numeric accuracy and refresh behavior still need testing).
- [ ] Remaining coverage: ASR voice input, TTS read-aloud, source-card links, image/large-file edge cases, and additional rendering formats (PDF read, drag/drop, paste, web search and reading passed).
- [ ] Verify cancellation, rate limits, insufficient balance, offline and timeout recovery.
- [ ] Verify upgrade/uninstall data preservation.

## Milestone 3 — Release readiness

- [ ] Signed installer.
- [ ] Upgrade/uninstall QA.
- [ ] Auto-update.
- [ ] Automated Windows UI smoke tests.

Compilation is not considered feature parity. Owner-reported checks are clearly distinguished from independently reproduced test evidence.
