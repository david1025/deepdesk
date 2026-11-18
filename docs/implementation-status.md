# Implementation status

## Milestone 0 — repository and native proof of concept

- [x] Create independent repository and feature branch.
- [x] Add product constraints and architecture documentation.
- [x] Add WPF + WebView2 host.
- [x] Map packaged UI through a virtual HTTPS host name.
- [x] Add origin-checked, allowlisted WebView2 message bridge.
- [x] Add native WPF API-key entry dialog.
- [x] Protect API key with Windows DPAPI CurrentUser.
- [x] Add DeepSeek API key verification and streaming chat endpoint.
- [x] Add initial React chat shell and IndexedDB persistence for the active conversation.
- [x] Add Windows CI build workflow.
- [ ] Run CI and fix compile/build issues.
- [ ] Port the full upstream chat-demo interface and feature set.
- [ ] Add model discovery from GET /models.
- [ ] Add conversation list, search, import/export, and full attachment lifecycle.
- [ ] Add validated file, search, URL-reading, ASR and TTS integrations.
- [ ] Add signed/reproducible release and auto-update flow.

This milestone is a functional foundation, not yet feature parity with the DeepSeek web application.
