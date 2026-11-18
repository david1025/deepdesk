# Implementation status

## Milestone 0 — Windows-native foundation

- [x] WPF + WebView2 host with packaged local UI.
- [x] Origin-checked allowlisted native bridge.
- [x] Native WPF API-key dialog and DPAPI CurrentUser credential storage.
- [x] DeepSeek API key verification using GET /models.
- [x] DeepSeek Anthropic-compatible Messages API with incremental SSE parsing.
- [x] Thinking and answer deltas rendered separately.
- [x] Search and URL-reading tool declarations with progress feedback.
- [x] IndexedDB conversation persistence and conversation switching.
- [x] Windows CI: TypeScript check, Rspack build, WPF compile.

## Milestone 1 — daily chat client

- [x] Markdown rendering, GFM tables, math formulas, and syntax highlighting.
- [x] DeepSeek ASR voice input via native WPF bridge.
- [x] Microphone permission scoped to the DeepDesk virtual origin.
- [x] Recording size cap and cleanup on app component shutdown.
- [x] Add search result source cards and safe external-link opening.
- [x] Add TTS read-aloud with PCM playback via native bridge.
- [ ] Add image/file attachment upload and file references.
- [ ] Add rename/delete/search/export/import for local conversation history.
- [ ] Add model catalogue from GET /models and persistent user settings.
- [ ] Windows runtime QA for microphone, TTS playback, streaming, cancellation, and long conversations.

## Milestone 2 — feature parity and release

- [ ] Port remaining upstream DeepSeek chat-demo components and interaction details.
- [ ] Add validated file upload lifecycle and attachment previews.
- [ ] Add history ZIP backup/restore with transactional import.
- [x] Publish self-contained win-x64 build to GitHub Actions artifact (14-day retention).
- [ ] Add signed installer, upgrade/uninstall QA, and auto-update.
- [ ] Add automated protocol tests and Windows UI smoke tests.

The current implementation is a working-in-progress foundation. CI compilation does not replace runtime tests against a real DeepSeek API key and Windows microphone.
