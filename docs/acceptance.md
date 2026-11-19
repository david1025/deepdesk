# Stage 3 — Windows functional acceptance

## Acceptance baseline

- Repository: `david1025/deepdesk`
- Branch: `feature/windows-native-shell`
- Upstream UI: `deepseek-ai/chat-demo@5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`
- Platform target: Windows 10/11 x64 + WebView2
- Rule: a successful CI build is not evidence that a runtime feature passed.

## Status reported by the product owner

These are user-reported manual checks, not independently reproduced by CI:

- [x] Send chat messages and receive responses.
- [x] Switch between the available models.
- [x] Import ZIP history in replace mode.
- [x] Import ZIP history in merge mode.
- [x] Export chat history.
- [x] Launch the Windows desktop app successfully (owner report).
- [x] Professional mode remains enabled after closing and restarting the app (owner report).
- [x] The Deep Thinking toggle is hidden while professional mode is enabled (owner report).
- [x] Stream chat replies and reopen local conversation history successfully (owner report).
- [x] Upload and read PDF files; drag files into chat; paste with Ctrl+V (owner report).
- [x] API account balance and session Token statistics display normally (owner report; numerical accuracy not independently reconciled).
- [x] Read web links and perform web searches (owner report; citation-card link behavior not separately checked).
- [x] Render code and mathematical formulas (owner report; Mermaid not separately checked).
- [ ] Voice input was not tested (owner report).
- [ ] API key replacement was not tested because only one key is available (owner report).

## Stage 3 code-review fixes

- [x] Windows API-key replacement now sends the new key to the native bridge first. The host validates the supplied key directly, then stores it with DPAPI. It no longer validates the replacement key through a renderer request that may have the previous key injected by WebView2.
- [x] Professional mode request mapping: `output_config.effort` controls the thinking mode; `none` disables thinking and `low/high/max` enable it. The legacy `thinking.type` toggle remains the normal-mode path.
- [x] This mapping follows the current official DeepSeek Anthropic Messages API documentation; explicit `thinking.type` takes precedence over `output_config.effort`, so professional-mode requests must omit `thinking`.

## Windows manual acceptance still required

Run on the target Windows machine with a real API key. Record app version, Windows version, WebView2 runtime version, package type, display resolution, and date.

### Chat lifecycle
- [ ] Create two or more conversations; verify titles, ordering, and switching.
- [ ] Rename and delete conversations.
- [ ] Edit a user prompt, regenerate, and switch response branches.
- [ ] Stop generation; verify only the selected request is cancelled.
- [ ] Continue an eligible truncated/stopped response.
- [ ] Restart the app; verify chats, drafts, settings, and attachments persist.

### Models and thinking
- [ ] Normal mode: thinking off sends `thinking.type=disabled`.
- [ ] Normal mode: thinking on sends `thinking.type=enabled`.
- [ ] Professional mode: Off sends `output_config.effort=none` and omits `thinking`.
- [ ] Professional mode: Low/High/Max sends the selected `output_config.effort` and omits `thinking`.
- [x] Professional mode hides the normal thinking toggle (owner report).
- [ ] Exiting professional mode restores the normal thinking toggle (not separately verified).
- [ ] Flash and V4-Pro both respond; verify V4-Pro's image-input limitation is explained in UI.
- [x] Verify professional-mode enabled state persists after restart (owner report).
- [ ] Verify the selected model and effort values persist after restart (not separately verified).

### API key and account usage
- [ ] Set a valid key on a clean profile.
- [ ] Replace a valid key with another valid key.
- [ ] Attempt to replace with an invalid key; verify the previous valid key remains stored.
- [ ] Clear the key; verify chat and balance actions require reconfiguration.
- [x] Account balance is displayed (owner report).
- [x] Session Token statistics are displayed (owner report).
- [ ] Verify refresh behavior, balance values, and multi-currency display against the provider.
- [ ] Compare displayed token counts with the response usage fields.
- [ ] Verify cost estimates are explicitly labeled as local estimates, not provider billing records.
- [ ] Verify rate-limit, insufficient-balance, invalid-key, timeout, and offline states.

### Tools, files, and speech
- [x] Web search works (owner report; source-card links not specifically verified).
- [ ] Verify web search source cards and citation links.
- [x] Web URL reading works (owner report).
- [ ] Verify URL safety handling and rejected unsafe schemes.
- [x] PDF upload and reading, drag-and-drop upload, and Ctrl+V paste work (owner report).
- [ ] Image uploads, alternate file types, and large files require separate coverage.
- [ ] Reopen an old conversation and verify attachments are still available.
- [ ] Voice input: grant microphone permission, record, transcribe, and insert text.
- [ ] Read-aloud: start, stop, and change supported voice.
- [ ] Verify file-size limits and clear errors for failed uploads/transcription/synthesis.

### Rendering and Windows integration
- [x] Code display and math formulas render (owner report).
- [ ] Separately verify Markdown edge cases, KaTeX breadth, Mermaid, citations, syntax-highlighting specifics, and long responses.
- [ ] Chinese/English and light/dark/system theme work.
- [ ] External HTTP(S) links open in the default browser; non-web schemes are blocked.
- [ ] Clipboard copy/paste and file downloads work.
- [ ] WebView2 profile and DPAPI credential survive restart.
- [x] A Windows desktop build launches on the owner's machine (owner report; package type not recorded).
- [ ] Lite package starts with required .NET Desktop Runtime installed (specific package not confirmed).
- [ ] Self-contained package starts on a clean Windows 10/11 x64 machine with WebView2 Runtime.
- [ ] Upgrade install preserves local data; uninstall does not delete user data.

## Evidence log

| Date | Build / commit | Package | Test | Result | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | owner-reported current build | Windows | Chat, model switch, ZIP merge/replace import, export | Pass (reported) | Not independently reproduced in CI |
| 2026-11-18 | owner-reported test build (commit not recorded) | Windows; package type not recorded | Startup; professional mode persists after restart; Deep Thinking hidden in professional mode; chat, streaming and history; ZIP import (merge/replace) and export | Pass (reported) | Professional-mode exit, specific model/effort persistence and request payloads not separately verified |
| 2026-11-18 | owner-reported test build (commit not recorded) | Windows; package type not recorded | PDF upload/read, drag-drop, Ctrl+V paste; balance and Token display; web reading and search; code and formula rendering | Pass (reported) | Voice input not tested; API key replacement not tested; no value-by-value balance/usage reconciliation |
| Pending | pending | pending | Remaining checklist | Not run | Requires Windows desktop and real API key |


## Stage 4 — Windows productization checks

- [ ] Install using `DeepDesk-Setup-x64` without administrator privileges.
- [ ] Confirm Start Menu shortcut and optional desktop shortcut.
- [ ] First run: validate and save a valid API Key; verify invalid key is not saved.
- [ ] First run: skip API Key setup, then configure later in Settings.
- [ ] Confirm API Key is stored using Windows DPAPI and is not written to renderer localStorage as plaintext.
- [ ] Install a newer build over an existing installation; verify chats, attachments, API Key, settings and WebView2 profile remain available.
- [ ] Uninstall; verify user data under `%LOCALAPPDATA%\\DeepDesk` remains.
- [ ] Reinstall; verify existing user data can be used again.
- [ ] Help → Check for updates: latest stable release opens; no-update and network-error messages are correct.
- [ ] Confirm app version displayed in About and bridge status matches the build.
- [ ] Confirm installer publisher/signature warning is documented until signing is configured.
