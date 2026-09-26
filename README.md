# Consultorio

Static page (`index.html` + `styles.css` + `app.js`, no build step) plus a zero-dependency
Node server (`server.mjs`, `node:sqlite` for storage) that serves the files, an
email+password account per psicopedagoga, and proxies `POST /api/voice` to an
OpenAI-compatible LLM.

## Run

```sh
DATA_DIR=./data \
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=your-key \
LLM_MODEL=deepseek-chat \
node server.mjs
```

Env vars:

- `PORT` — default `8811`.
- `HOST` — default `0.0.0.0`.
- `DATA_DIR` — where `consultorio.db` (SQLite, WAL mode) lives. Default `./data`,
  gitignored. Must be writable.
- `INSECURE_COOKIES` — set to `1` to allow the session cookie over plain HTTP (a relaxed
  `consultorio` cookie instead of `__Host-consultorio`, which requires `Secure`). **Local
  dev / e2e only** — in production, behind Coolify/Traefik terminating TLS, leave unset so
  the `__Host-` cookie is used. The server only relaxes it when the request itself isn't
  HTTPS (checked via `x-forwarded-proto`), so setting this in production is a no-op behind
  a TLS-terminating proxy but still don't do it.
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

## Accounts and data

Each psicopedagoga signs up with email + password; data is stored server-side per account
(`docs` table, one JSON blob per user, optimistic-concurrency versioned) and cached in the
browser's `localStorage` (`consultorio.cache.<userId>`) for instant loads and offline use.
Saves are debounced and retried automatically when back online. On a first login with an
empty server doc, any pre-existing browser data under the legacy `consultorio.v1` key is
imported automatically. Use "Descargar copia" / "Cargar copia" in Pacientes for manual
JSON backups regardless.
