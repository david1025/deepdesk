# Native Bridge and API Protocol

## Credential boundary

- The renderer uses the official Chat Demo API client.
- In the Windows host, WebView2 only receives the DeepSeek API credential for requests to the allowlisted `https://api.deepseek.com` origin. The key is stored encrypted with Windows DPAPI CurrentUser.
- API-key configuration on Windows uses `settings.saveApiKey`: the host validates the newly supplied key directly with `GET /models`, then stores it using DPAPI. This avoids validating a replacement key through a renderer request that could have the old credential injected.
- The renderer must never persist a real API key. It receives only the non-secret sentinel `DEEPDESK_NATIVE_CREDENTIAL` in the WebView profile.
- Do not log prompts, completions, file contents, authorization headers, or API keys.

## Bridge envelope

Request:
```json
{"requestId":"uuid","action":"app.getStatus","payload":{}}
```

Response:
```json
{"type":"response","requestId":"uuid","success":true,"data":{}}
```

## Actions

- `app.openExternal`: opens only absolute HTTP/HTTPS URLs through the Windows shell; credentials and non-web URI schemes are rejected.
- `app.getStatus`: returns app name/version and whether an API key is configured; never returns the key.
- `settings.saveApiKey`: validates the supplied key using `GET /models`, then stores it using DPAPI.
- `settings.configureApiKey`: opens the native WPF secure-entry dialog, validates the key, then stores it using DPAPI.
- `settings.clearApiKey`: deletes the protected key.
- `settings.testApiKey`: verifies the configured key using `GET /models`.
- `api.getBalance`: queries `GET /user/balance` using the protected key.
- `speech.transcribe`: accepts a size-limited Base64 WAV recording, calls `POST /v1/tools/asr` natively, and returns recognized text.
- `speech.synthesize`: accepts text and an allowlisted voice, calls `POST /v1/tools/tts` natively, and returns bounded PCM audio for local playback.
- `api.cancel`: accepts targetRequestId and cancels only that native request.

## Chat request path

Chat, search, link reading, file upload, and history import/export are implemented in the pinned official renderer. On Windows, WebView2 attaches the protected credential only to requests whose destination is exactly the DeepSeek API HTTPS origin. The native `DeepSeekApiService.StreamChatAsync` exists as a separate host service; it is not the renderer's current chat transport.

Professional mode uses the official Anthropic Messages extension field `output_config.effort`:

- `none`: disables thinking.
- `low`, `high`, `max`: enables thinking at the requested effort.
- Do not send `thinking.type` together with `output_config.effort` in professional mode. An explicit `thinking.type` takes precedence over effort.

Normal mode keeps the original Chat Demo toggle and sends `thinking.type=enabled/disabled`.

## Errors

Bridge errors use stable codes where applicable: `INVALID_REQUEST`, `API_KEY_MISSING`, `API_AUTH_FAILED`, `API_RATE_LIMITED`, `API_REQUEST_FAILED`, `API_PROTOCOL_ERROR`, `REQUEST_CANCELLED`.
