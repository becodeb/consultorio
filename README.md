# Consultorio

Static page (`index.html` + `styles.css` + `app.js`, no build step) plus a zero-dependency
Node server (`server.mjs`) that serves the files and proxies `POST /api/voice` to an
OpenAI-compatible LLM.

## Run

```sh
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=your-key \
LLM_MODEL=deepseek-chat \
node server.mjs
```

Env vars:

- `PORT` — default `8811`.
- `HOST` — default `0.0.0.0`.
- `LLM_BASE_URL` — OpenAI-compatible base URL (the server appends `/chat/completions`).
- `LLM_API_KEY` — bearer token for that API. Never logged, never committed.
- `LLM_MODEL` — model id.
- `LLM_EXTRA_HEADERS` — optional JSON object merged into the LLM request headers (some
  providers need a custom session or user-agent header).

Without `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` the app works fully except the voice
assistant, which returns `503`.

## Microphone

`window.SpeechRecognition` requires a secure context: `https://` or `http://localhost`.
On a plain LAN address (`http://192.168.x.x`) the mic is unavailable and the voice sheet
falls back to its always-available text input.

## Data

All patient/schedule/attendance data lives in the browser's `localStorage`
(`consultorio.v1`). Use "Descargar copia" / "Cargar copia" in Pacientes for backups.
