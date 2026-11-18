# Windows acceptance checklist

- [ ] Clean Windows 10/11 x64 machine launches installed application.
- [ ] WebView2 Runtime prerequisite is detected or installed.
- [ ] UI loads from packaged local assets without localhost server.
- [ ] Navigating to an external origin cannot retain native bridge privileges.
- [ ] API key is never returned to JavaScript or written to logs.
- [ ] API key survives app restart and is protected with DPAPI CurrentUser.
- [ ] Invalid key produces a useful error without leaking headers.
- [ ] Streaming Chinese text renders incrementally.
- [ ] Stop generation cancels only the selected request.
- [ ] Multiple chat requests have independent cancellation.
- [ ] Conversation history survives restart in IndexedDB.
- [ ] Offline startup still opens the app and local history.
- [ ] Installer upgrade preserves LocalAppData.
