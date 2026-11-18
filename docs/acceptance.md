# Acceptance checklist — official DeepSeek Chat Demo parity

## Source and visual baseline

- [ ] Confirm build metadata reports the pinned upstream commit.
- [ ] Compare welcome screen, sidebar, session list, composer, message view, settings, dialogs, menus, icons, typography, spacing, themes, and responsive behavior with the official demo at the same viewport size.
- [ ] Confirm no custom replacement UI is rendered.

## Conversation lifecycle

- [ ] Create multiple conversations; verify automatic titles.
- [ ] Rename and delete conversations.
- [ ] Edit a user prompt, regenerate a response, and switch between response branches.
- [ ] Stop generation and continue eligible replies.
- [ ] Restart the desktop app and confirm sessions and drafts persist.

## Model and tools

- [ ] Configure API key and model settings.
- [ ] Streaming response and deep thinking.
- [ ] Smart search, link reading, and source citations.
- [ ] Verify API errors, rate limits, cancellation, and long responses.

## Attachments and speech

- [ ] Upload through file picker, paste, and drag/drop.
- [ ] Verify file cards and server upload lifecycle.
- [ ] Voice input and recording spectrum.
- [ ] Read replies aloud and stop playback.

## Rendering and settings

- [ ] Markdown, code highlighting, KaTeX, and Mermaid.
- [ ] Simplified Chinese and English.
- [ ] Light and dark themes.
- [ ] Location settings and mobile/responsive layout where applicable.
- [ ] ZIP history export/import; validate that failed import does not replace existing data.
- [ ] Delete all chats without deleting API key/settings.

## Windows integration

- [ ] API key, settings, chats, attachments, and drafts remain under the local WebView2 profile.
- [ ] External HTTP(S) links open in the default browser.
- [ ] Microphone permission works and is not granted to unrelated origins.
- [ ] Downloads, file picker, clipboard paste, and app restart work.
- [ ] Lite package starts with .NET 10 Desktop Runtime installed.
- [ ] Self-contained package starts on a clean Windows 10/11 x64 machine with WebView2 Runtime.

## Acceptance evidence

Record Windows version, WebView2 version, upstream commit, package type, screen resolution, test date, and pass/fail notes. Do not mark parity accepted based on CI compilation alone.
