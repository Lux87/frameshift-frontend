# FrameShift Frontend

Thin Express proxy + browser UI for the FrameShift Engine. Handles IAP
authentication and the engine API key server‑side so the browser never
touches credentials.

## What it does

- **Proxies every engine call** under `/api/*`. The browser calls the frontend;
  the frontend adds the IAP ID token and `X-Api-Key: fsk_...` header and
  forwards to the engine.
- **Ships a full browser UI** for submitting jobs, watching them run, browsing
  history, and reading API docs without ever leaving the app.
- **Stores runtime config** (engine URL, API key, IAP client ID, uploaded SA
  key) in `data/` so the same container can be re‑configured from the UI
  without redeploying.

## Security model — read this before deploying

**The frontend itself has no authentication on its HTTP endpoints.** Anyone
who can reach `http://<host>:8080/api/*` can submit jobs (burning your
tenant's credits), read all of your tenant's outputs, and overwrite the
engine credentials via `PUT /api/settings` or `POST /api/settings/sa-key`.

Never expose it to the public internet naked. Safe deployment shapes:

- **Cloud Run in the engine's GCP project**, deployed with
  `--no-allow-unauthenticated` and Cloud Run invoker role granted to specific
  Google identities (simplest).
- **Behind your own IAP / Cloud Armor / reverse proxy auth** (any flavour).
- **Local dev on a trusted machine** (laptop, private LAN). Fine as long as
  `localhost:8080` isn't reachable from elsewhere.

See [IMPLEMENTATION-GUIDE.md §7](./IMPLEMENTATION-GUIDE.md) for the full
discussion.

## Quick start

```bash
npm install
npm start
```

Then open `http://localhost:8080` and fill in **Settings**:

- **Engine URL** — the engine's IAP‑protected domain (e.g.
  `https://engine.example.com`).
- **API Key** — `fsk_...` key issued from the engine dashboard.
- **IAP Client ID** — OAuth client ID of the engine's IAP backend. Required
  for any sensibly‑deployed engine; leave empty only if the engine is not
  behind IAP (rare).
- **Service Account Key** — upload a GCP service‑account `.json` with
  `IAP-secured Web App User` on the engine's backend service, or leave empty
  to use Application Default Credentials (when running on Cloud Run with an
  attached SA).

Click **Save**, then **Test connection**.

No environment variables are required. Everything is configurable at runtime.

## What's in the UI

- **Submit** — drop a product + background, pick a mode, optionally set an
  `action_prompt`, optional detailing mask, optional webhook URL, submit. A
  second endpoint selector switches between the full `/process` pipeline and
  wavelet‑only `/detail-transfer`.
- **Jobs** — live list of running / completed / failed jobs with thumbnails,
  per‑output download + GCS links, and retry / delete actions.
- **Documentation** — in‑app Quick Start and Endpoints reference covering
  `/process`, `/detail-transfer`, `/jobs`, `/api/downloads/:jobId`,
  webhooks, and the modes table. Your team can explore the API without
  leaving the frontend.
- **Settings** — everything described in Quick Start above, plus a connection
  test.

## Endpoints this frontend exposes

All unauthenticated (see Security model). Every one proxies to the
corresponding engine route after adding IAP + API key headers:

| Frontend path | Engine path | Purpose |
|---|---|---|
| `POST /api/process` | `POST /process` | Full pipeline (mode + images). |
| `POST /api/detail-transfer` | `POST /detail-transfer` | Wavelet‑only colour‑match. |
| `POST /api/nb2-edit` | `POST /api/nb2-edit` | Blend editor. |
| `GET /api/jobs`, `/api/jobs/:id` | same | Job listing and status. |
| `GET /api/downloads/:jobId` | same | Per‑output URLs (proxy + direct GCS). |
| `GET /api/download/:jobId/:filename` | `GET /download/...` | Streamed image bytes. |
| `GET /api/health` | `GET /health` | Engine health check. |
| `GET/PUT /api/settings`, `POST /api/settings/sa-key`, `POST /api/settings/test` | n/a | Local frontend configuration. |

## Webhooks

Pass a `webhook_url` (must be `https://`) when submitting to `/api/process`
or `/api/detail-transfer`, either via the UI field or your own HTTP client.
When the job reaches a terminal state the engine `POST`s a signed JSON
payload to that URL:

- Headers: `X-Frameshift-Event`, `X-Frameshift-Job-Id`, `X-Frameshift-Timestamp`, `X-Frameshift-Signature` (HMAC‑SHA256 over the body, when the engine has `FRAMESHIFT_WEBHOOK_SECRET` set).
- Body matches the shape of `GET /api/downloads/:jobId` plus job metadata
  (`event`, `status`, `mode`, `created_at`, `completed_at`,
  `duration_seconds`, `bucket`, `outputs`, `gcsOutputs`).

Full details are in the in‑app **Documentation → Endpoints → Webhooks**
section.

## Optional: seed via env vars

If you'd rather pre‑configure on deploy, any value set in `.env` (or via
`--set-env-vars` on Cloud Run) is used as an initial default. The UI can
still override anything at runtime. See `.env.example`.

## Runtime configuration storage

UI changes are persisted to `data/config.json` and survive process
restarts. Uploaded SA key files are stored in `data/<sa>-sa-key.json`.

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
  → FrameShift Engine
  → Engine processes the job, writes outputs to GCS
  → Results / download URLs stream back through the proxy
  → (optional) Engine POSTs a signed webhook to your URL on completion
```

## What you need from the engine operator

1. `ENGINE_URL` — the IAP‑protected engine domain.
2. `IAP_CLIENT_ID` — OAuth client ID of the engine's IAP backend service.
3. `FRAMESHIFT_API_KEY` — an `fsk_...` key issued to your tenant.
4. Either an attached Cloud Run SA (same GCP project as the engine) **or** a
   GCP service‑account JSON key that has `IAP-secured Web App User` on the
   engine's backend service.

See [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) for the full flow.
