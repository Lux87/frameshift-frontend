# FrameShift Frontend

Thin Express proxy + browser UI for the FrameShift Engine. Handles IAP
authentication and the engine API key server‑side so the browser never
touches credentials.

## Quick start

```bash
npm install
npm start
```

Then open `http://localhost:8080` and fill in **Settings**:

- **Engine URL** — the engine's IAP‑protected domain (e.g. `https://frameshift-engine.com`)
- **API Key** — `fsk_…` key from the engine dashboard
- **IAP Client ID** — OAuth client ID of the engine's IAP backend (leave empty for direct mode)
- **Service Account Key** — upload a GCP service account `.json` with IAP access (or leave empty to use Application Default Credentials)

Click **Save**, then **Test connection**.

No environment variables are required. Everything is configurable at runtime.

## Optional: seed via env vars

If you'd rather pre‑configure on deploy, any value set in `.env` (or via
`--set-env-vars` on Cloud Run) is used as an initial default. The UI can
still override anything at runtime. See `.env.example`.

## Runtime configuration storage

UI changes are persisted to `data/config.json` and survive process restarts.
Uploaded SA key files are stored in `data/<sa>-sa-key.json`.

On **Cloud Run** the container filesystem is ephemeral — configuration
entered in the UI is lost on cold start. For Cloud Run deployments either:

- Keep `--min-instances=1` so the instance stays warm, or
- Seed the config via env vars on deploy (see `.env.example`).

See [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) for full deployment
details (Cloud Run, local, rotating credentials, troubleshooting).

## How it works

```
Browser → Frontend (localhost:8080)
  → Express proxy adds IAP token + API key headers
  → FrameShift Engine (frameshift-engine.com)
  → Cloud Run processes the job
  → Results stream back through the proxy
```

## What you need from the engine operator

1. `ENGINE_URL` — the IAP‑protected engine domain
2. `IAP_CLIENT_ID` — OAuth client ID of the engine's IAP backend service
3. `FRAMESHIFT_API_KEY` — an `fsk_…` key issued to your tenant
4. Either an attached Cloud Run SA (same GCP project as the engine) **or** a
   GCP service account JSON key that has `IAP-secured Web App User` on the
   engine's backend service

See [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) for the full flow.
