# Native Bridge and API Protocol

## Envelope

Request:
```json
{"type":"request","requestId":"uuid","action":"api.chat","payload":{}}
```

Response:
```json
{"type":"response","requestId":"uuid","success":true,"data":{}}
```

Stream event:
```json
{"type":"stream","requestId":"uuid","event":"delta","data":{"text":"..."}}
```

## Actions
- `app.getStatus`: returns app name/version and whether an API key is configured; never returns the key.
- `settings.configureApiKey`: opens a native WPF secure-entry dialog, verifies the key using GET /models, then stores it using DPAPI.
- `settings.clearApiKey`: deletes the protected key.
- `settings.testApiKey`: verifies the configured key using GET /models.
- `api.chat`: accepts model, text message history, thinking and search flags; emits content, reasoning, and progress stream events.\n- `speech.transcribe`: accepts a size-limited Base64 WAV recording, calls POST /v1/tools/asr natively, and returns recognized text.
- `api.cancel`: accepts targetRequestId and cancels only that request.

## Chat payload
```json
{
  "model":"deepseek-chat",
  "messages":[{"role":"user","content":"Hello"}],
  "thinking":false
}
```

The native host maps this to the currently documented DeepSeek Chat Completions API. Do not pass arbitrary URLs, headers, tools, or filesystem paths from the renderer.

## Errors
Errors use stable codes: `INVALID_REQUEST`, `API_KEY_MISSING`, `API_AUTH_FAILED`, `API_RATE_LIMITED`, `API_REQUEST_FAILED`, `API_PROTOCOL_ERROR`, `REQUEST_CANCELLED`.
