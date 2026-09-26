# Consultorio

Static page (`index.html` + `styles.css` + `app.js`, no build step) plus a zero-dependency
Node server (`server.mjs`, `node:sqlite` for storage) that serves the files, an
email+password account per psicopedagoga, and proxies `POST /api/voice` to
[ai-router](https://github.com/ezemastro/ai-router) (`ezemastro/ai-router`), an
in-house latency-aware proxy that fans a chat request out over several free LLM
providers and fails over between them.

## Run

```sh
DATA_DIR=./data node server.mjs
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
- `AI_ROUTER_URL` — base URL of the router. Default `https://ai-router.becode.com.ar`.
- `AI_ROUTER_MODEL` — optional. Pins a specific model (e.g. `deepseek-chat`) instead of
  the default free-provider cascade (fastest healthy provider first, with failover).
- `AI_ROUTER_TOKEN` — optional bearer token, only sent when set. Required for a pinned
  paid model (currently only `deepseek-chat`); free models need no token at all.

The voice assistant always works as long as `AI_ROUTER_URL` is reachable — the free
cascade needs no key. Patients are children: the context sent to the model identifies
each one by id + first name + surname initial ("Martina L."), never a full name; the
reply is mapped back to full names before she sees it.

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
