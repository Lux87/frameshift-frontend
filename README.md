# FrameShift Frontend

Test frontend for the FrameShift Engine API. Handles IAP authentication and proxies requests to the engine.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in:
   ```bash
   cp .env.example .env
   ```

   - `ENGINE_URL` — the IAP-protected engine domain (e.g. `https://frameshift-engine.com`)
   - `FRAMESHIFT_API_KEY` — API key generated from the engine dashboard (`fsk_...`)
   - `GOOGLE_SA_KEY_PATH` — path to a GCP service account JSON key with IAP access
   - `IAP_CLIENT_ID` — the OAuth client ID used for IAP on the backend service

3. Place the service account key file (e.g. `sa-key.json`) in the project root.

4. Start the server:
   ```bash
   npm start
   # or with auto-reload:
   npm run dev
   ```

5. Open `http://localhost:8080` in your browser.

## GCP Prerequisites

The service account needs:
- **IAP-secured Web App User** (`roles/iap.httpsResourceAccessUser`) on the engine's backend service

The API key needs to be generated from the engine's admin dashboard (API Keys tab).

## How It Works

```
Browser → Frontend (localhost:8080)
  → Express proxy adds IAP token + API key headers
  → FrameShift Engine (frameshift-engine.com)
  → Cloud Run processes the job
  → Results stream back through the proxy
```

The frontend never exposes credentials to the browser. All IAP and API key authentication happens server-side.
