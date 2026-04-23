# FrameShift Frontend — Implementation Guide

**Audience**: the person deploying a FrameShift Frontend instance that connects
to an **existing** FrameShift Engine (the engine is already deployed on GCP,
behind IAP, on a custom domain).

If you are the one running the engine itself, see the engine's
implementation guide in that repo instead.

---

## 1. What this frontend is

`frameshift-frontend` is a small Node 20 + Express app that:

- Serves a browser UI from `/public`.
- Proxies API calls to the engine.
- Holds all credentials **server‑side**: the engine API key and the GCP
  service account used to mint IAP ID tokens. The browser never sees them.
- Is configured **at runtime via the Settings panel** in the UI. You can
  deploy it with no env vars at all.

```
Browser ──► http://localhost:8080 (this app)
              │
              │ adds  Authorization: Bearer <IAP ID token>
              │       X-Api-Key: fsk_…
              ▼
       https://<engine-domain>/…
              │
              ▼
         Cloud Run engine processes the job, writes to GCS, returns status
```

The proxy streams uploads and downloads, so the browser talks HTTP(S) only to
your frontend and never directly to the engine.

---

## 2. What you need from the engine operator

Before you can use the app (not necessarily before deploying it), the engine
team hands you **four** things:

| Value | What it is | Example |
|-------|------------|---------|
| Engine URL | The engine's IAP‑protected domain | `https://frameshift-engine.com` |
| IAP Client ID | OAuth 2.0 client ID in the engine's GCP project — identifies the engine as an IAP audience | `73422879528-45ds2…apps.googleusercontent.com` |
| API Key | Engine API key issued **to you** from the engine dashboard | `fsk_abc123…` |
| A GCP service account identity | Lives in the **engine's** GCP project, has `IAP-secured Web App User` on the engine's backend service | `yourtenant-frameshift@engine-project.iam.gserviceaccount.com` |

The first two are the **same for every frontend** connecting to that engine.
The last two are **unique to you**.

Both the IAP Client ID and the service account are properties of the
**engine's** GCP project, not your project. You don't create them — the
engine team does and hands them to you.

### 2.1 How the service account reaches you

One of two ways, depending on where you run the frontend:

- **Frontend on Cloud Run in the engine's GCP project** — the engine team
  gives you only the SA email. You attach it to your Cloud Run service and
  the frontend picks it up via Application Default Credentials.
  **No JSON key file changes hands.** Recommended.

- **Frontend anywhere else** (another GCP project, another cloud, on‑prem,
  local laptop) — the engine team creates a JSON key file for the SA and
  sends it to you. You'll upload it through the UI. Treat it as a bearer
  credential: anyone who copies the file can impersonate that SA until the
  key is deleted.

---

## 3. Runtime configuration model

The frontend has **no required env vars**. It can boot completely blank, and
all four values above are entered in the **Settings** panel of the UI:

1. Engine URL
2. API Key
3. IAP Client ID
4. Service Account Key (upload `.json`, or leave empty to use ADC)

Changes are persisted to `data/config.json` (and the SA key goes into
`data/<sa>-sa-key.json`), so they **survive process restart**.

### 3.1 Optional env‑var seeding

If you prefer to pre‑configure on deploy, any of these env vars are used as
initial defaults the first time the frontend starts:

| Env var | Maps to |
|---------|---------|
| `ENGINE_URL` | Engine URL |
| `FRAMESHIFT_API_KEY` | API Key |
| `IAP_CLIENT_ID` | IAP Client ID |
| `GOOGLE_SA_KEY_PATH` | Path to a pre‑mounted SA key file |
| `PORT` | Server port (default 8080) |

Persisted settings (from the UI) take precedence over env vars, so the UI can
always override.

### 3.2 Cloud Run caveat

The Cloud Run container filesystem is **ephemeral** — anything written to
`data/` is lost on cold start. To avoid losing settings:

- Keep `--min-instances=1` so the instance doesn't scale to zero, **or**
- Seed the values via env vars on deploy. They'll always be available after
  every cold start and the UI will show them pre‑filled.

For local hosts, VMs, or any traditional server, `data/config.json` just
persists normally.

---

## 4. Flavour A — Deploy on Cloud Run (engine's project)

Simplest, most secure setup: **no JSON key file anywhere**, no env vars
required.

### 4.1 Permissions you need in the engine's project

Ask the engine operator to grant you, in the engine's GCP project:

- `roles/run.developer` on the `frameshift-frontend-<yourname>` service (or
  broader `roles/run.admin` if you'll create it yourself).
- `roles/iam.serviceAccountUser` **on the frontend SA** they created for you
  — required to attach that SA to a Cloud Run service.
- `roles/artifactregistry.writer` (or `roles/storage.admin` if using GCR) to
  push the built image.
- `roles/cloudbuild.builds.editor` if you want to use `gcloud builds submit`.

### 4.2 Deploy (no env vars)

```bash
cd frameshift-frontend

gcloud run deploy frameshift-frontend-<yourname> \
  --source=. \
  --region=<engine-region> \
  --service-account=<yourtenant>-frameshift@<engine-project>.iam.gserviceaccount.com \
  --cpu=1 --memory=512Mi --port=8080 \
  --min-instances=1 \
  --allow-unauthenticated
```

Then open the service URL and configure in **Settings**:

1. Paste the Engine URL.
2. Paste the API Key.
3. Paste the IAP Client ID.
4. Leave the SA Key field empty — ADC will pick up the attached SA.
5. **Save**, then **Test connection**.

Server logs should show:

```
[auth] No SA key file — using Application Default Credentials
Engine:  (not configured — set via Settings)
API key: (not configured — set via Settings)
IAP:     disabled (direct mode)
→ Open the UI and fill in Settings to finish configuration.
```

After saving:

```
[settings] Config updated and persisted to data/config.json
[auth] No SA key file — using Application Default Credentials
```

### 4.3 Alternative: deploy with env vars pre‑seeded

Useful on Cloud Run specifically because `data/` is lost on cold start:

```bash
gcloud run deploy frameshift-frontend-<yourname> \
  --source=. \
  --region=<engine-region> \
  --service-account=<yourtenant>-frameshift@<engine-project>.iam.gserviceaccount.com \
  --cpu=1 --memory=512Mi --port=8080 \
  --min-instances=1 \
  --set-env-vars=ENGINE_URL=https://<engine-domain> \
  --set-env-vars=FRAMESHIFT_API_KEY=fsk_... \
  --set-env-vars=IAP_CLIENT_ID=...apps.googleusercontent.com \
  --allow-unauthenticated
```

The UI will show these as defaults and you can still change them at runtime.
A `PUT /api/settings` writes `data/config.json`, which overrides the env vars
until the next cold start.

If you'd rather not expose the frontend to the public internet, drop
`--allow-unauthenticated` and put your own IAP / Cloud Armor in front of it
(users will now need a Google identity to reach the frontend itself, separate
from whatever the frontend's UI does for them).

---

## 5. Flavour B — Deploy anywhere else (JSON key file)

Use this when the frontend runs outside the engine's GCP project: your own
cloud, on‑prem, a developer laptop, another GCP project, etc.

### 5.1 Install and run

```bash
cd frameshift-frontend
npm install
npm start           # or `npm run dev` for auto-reload
```

No env vars needed. Open `http://localhost:8080`.

### 5.2 Configure in the UI

1. Engine URL → paste.
2. API Key → paste.
3. IAP Client ID → paste.
4. Service Account Key → click **Upload .json** and select the file the
   engine team sent you. It'll be stored at `data/<sa-name>-sa-key.json`.
5. **Save**, then **Test connection**.

Server logs on save:

```
[settings] SA key uploaded: yourtenant-frameshift@engine-project.iam.gserviceaccount.com
[auth] Using service account: yourtenant-frameshift@...
[settings] Config updated and persisted to data/config.json
```

### 5.3 Alternative: pre‑mount the SA key

If you'd rather not upload through the UI, drop the `.json` file in the
project root and set `GOOGLE_SA_KEY_PATH` in `.env`:

```env
GOOGLE_SA_KEY_PATH=./yourtenant-sa-key.json
```

Everything else can still be entered via the UI. The repo's `.gitignore`
already excludes `*-sa-key.json` and `data/`.

### 5.4 Production hosts (VM / container / systemd)

Same idea. Mount the `data/` directory on a volume so config survives
restarts:

```bash
docker run -d \
  -p 8080:8080 \
  -v /var/lib/frameshift-frontend:/app/data \
  frameshift-frontend
```

Make sure the host clock is within a few minutes of real time — IAP ID
tokens are time‑sensitive.

---

## 6. Testing the connection

From the UI: **Settings** → **Test connection**. It runs the full IAP +
API‑key chain against `/health` on the engine.

From the command line:

```bash
# Simple engine health via proxy
curl http://localhost:8080/api/health
# → { "status": "ok", ... }

# Full auth-chain test
curl -X POST http://localhost:8080/api/settings/test
# → { "ok": true, "status": 200, "iap_used": true, ... }
```

If the frontend hasn't been configured yet, you'll get a 503:

```json
{ "error": "Frontend is not configured — set Engine URL in Settings." }
```

---

## 7. Rotating the SA key via the UI

`POST /api/settings/sa-key` accepts a JSON SA key upload, validates it has
`client_email` + `private_key`, writes it to
`data/<client-email-prefix>-sa-key.json`, re‑initializes auth, and deletes
the previous key file. Useful for rotating without redeploying:

1. Ask the engine team for a fresh JSON key.
2. Open the settings UI → **Upload .json**.
3. Ask the engine team to delete the old key in IAM so the rotated credential
   can't be reused.

> This endpoint is not authenticated — **do not expose this frontend to the
> public internet in Flavour B without putting your own auth in front of it**.
> Flavour A on Cloud Run with `--no-allow-unauthenticated` + your own IAP is
> the clean path here.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `503 Frontend is not configured…` | Engine URL or API Key blank | Fill in Settings and save |
| `[auth] Failed to get IAP token: …` in logs | SA key file unreadable, wrong IAP Client ID, or SA not granted `IAP-secured Web App User` | Re‑upload key; ask engine team to re‑check the OAuth client ID and IAP principal binding |
| Settings page shows previously set values as empty after Cloud Run cold start | `data/config.json` was lost (ephemeral FS) | Either keep `--min-instances=1`, or seed with env vars on deploy (§4.3) |
| Browser sees `502 Engine unreachable` | Engine URL wrong, engine down, or DNS not resolving from this host | Curl `${ENGINE_URL}/health` from the same host running the frontend |
| Login page from Google when you expected the app UI | The IAP token was missing or rejected — the LB is bouncing you to Google | You're probably hitting the engine directly in a browser; the frontend must be the one making the call. Confirm you're opening the frontend URL, not the engine URL |
| `403 Forbidden` from the engine via the frontend | IAP accepted the token but the engine's API‑key check failed | API key wrong, revoked, or expired. Paste a fresh one in Settings |
| `401 Unauthorized` with no IAP redirect | API Key header not being sent | Confirm the key is saved in Settings; re‑save |
| Job submits but download URLs 404 | Output still processing, or engine lost outputs | Poll `/api/jobs/:id` until `completed`; if still 404, escalate to engine team |
| Works locally, fails on Cloud Run | Flavour A deploy didn't attach the SA, **or** you didn't re‑enter settings after cold start | `gcloud run services describe …` to check `spec.template.spec.serviceAccountName`; or seed env vars (§4.3) |
| IAP suddenly rejects everything | SA key rotated/deleted, or IAP access removed | Ask engine team: have they rotated keys or revoked access? |

### Logging

`server.js` logs to stdout:

- `[auth] …` — IAP auth setup and errors.
- `[settings] …` — config changes via the UI, SA key uploads, persistence.

On Cloud Run, these show up in **Logs Explorer** under the service's logs.
For local dev they're just in the terminal where you ran `npm start`.

---

## 9. Rotating / revoking

### Rotating your engine API key (`fsk_…`)

1. Ask the engine team to issue a new key.
2. Paste it in Settings → Save. Done — no restart needed.
3. Ask them to revoke the old key only after you've confirmed the new one
   works (Test connection).

### Rotating your SA JSON key (Flavour B)

1. Ask the engine team to create a new key.
2. Upload via Settings (§7). The old key file is removed automatically.
3. Ask them to delete the old key in IAM.

### Being decommissioned

If your access is being revoked, the engine team will:

1. Revoke your engine API key in the engine dashboard.
2. Remove your SA's `IAP-secured Web App User` binding on the backend service.
3. Optionally delete the SA and all its JSON keys.

At that point this frontend stops being able to call the engine, and any
cached IAP tokens expire within an hour.

---

## 10. What you do **not** need

For clarity, you do **not** need any of the following to stand up a frontend:

- Vertex AI access (the engine makes all Gemini calls).
- A GCS bucket (the engine owns the output bucket).
- Firestore (the engine/license service owns that).
- A GCP project of your own (Flavour A uses the engine's project; Flavour B
  uses no GCP project at all for the frontend itself).
- Domain / SSL / load balancer of your own (unless you want to put the
  frontend on a public domain, which is a separate, optional concern).
- Any env vars at startup. Configure in Settings.

---

## 11. Engine API reference

Every endpoint the frontend may call on `frameshift-local`, with example
requests. All examples assume:

```bash
ENGINE_URL=https://audi-frameshift-engine.com
FRAMESHIFT_API_KEY=fsk_abc123...
IAP_TOKEN="$(gcloud auth print-identity-token \
  --audiences=$IAP_CLIENT_ID \
  --impersonate-service-account=$SA_EMAIL)"
```

In practice the browser never talks to the engine directly — it hits the
frontend's proxy at `http://localhost:8080/...`, which injects the IAP
`Authorization` header and the `X-Api-Key` header automatically (see
`server.js:112-134`). Each endpoint below lists both paths: **Engine** (the
direct URL, what the frontend's server actually calls) and **Proxy** (what
browser JS or a local curl calls on the frontend itself).

### 11.1 Auth rules at a glance

| Layer | Header | Scope |
|-------|--------|-------|
| IAP (network) | `Authorization: Bearer <ID token>` | All requests, public or not. Minted from the frontend's SA, audience = `IAP_CLIENT_ID`. |
| Engine (app) | `X-Api-Key: fsk_...` | Every endpoint except `/health` and `/api/auth/*`. Jobs are scoped to the API key that submitted them. |

Through the proxy, both headers are added server‑side — your browser code
only calls `fetch('/api/...')` with no auth headers.

### 11.2 `GET /health` — engine + license snapshot

Cheap liveness + license probe. No `X-Api-Key` required (but still behind
IAP).

- **Engine**: `GET ${ENGINE_URL}/health`
- **Proxy**: `GET http://localhost:8080/api/health`

```bash
curl -s "$ENGINE_URL/health" \
  -H "Authorization: Bearer $IAP_TOKEN"
```

Response (200):

```json
{
  "status": "ok",
  "version": "dev",
  "active_jobs": 1,
  "queue_depth": 0,
  "max_concurrent": 4,
  "uptime": 1834,
  "license": { "org": "Audi", "credits": 8421, "active": true }
}
```

### 11.3 `POST /process` — submit a full pipeline job

Runs the V2.1 pipeline: preprocess → Gemini relight → wavelet detail
transfer → post‑process. Returns `202` immediately with a `job_id`; poll
`GET /jobs/:id` until `status: "completed"`.

- **Engine**: `POST ${ENGINE_URL}/process` (multipart)
- **Proxy**: `POST http://localhost:8080/api/process` (multipart)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `mode` | text | yes | One of `2d`, `cgi`, `cgi-topview`, `overlay`, `lite`, `prompt`, `prompt-raw` |
| `product_image` | file | yes | JPEG / PNG / WebP, ≤ 50 MB |
| `background_image` | file | yes* | Required unless `mode ∈ {prompt, prompt-raw}` |
| `detailing_mask` | file | no | Optional mask for region‑locked detail transfer |
| `action_prompt` | text | no | Freeform prompt — appended for `2d`/`cgi`/etc, used raw for `prompt-raw` |

```bash
curl -s "$ENGINE_URL/process" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY" \
  -F "mode=2d" \
  -F "product_image=@./product.png" \
  -F "background_image=@./background.jpg" \
  -F "action_prompt=on a polished marble countertop"
```

Response (202):

```json
{
  "message": "Job submitted",
  "job_id": "job_1771234567890_abc123x",
  "status": "processing"
}
```

### 11.4 `POST /detail-transfer` — wavelet‑only job

Runs just the wavelet color match stage — no Gemini, no preprocessing, no
cropping. Inputs must already be dimension‑matched. Useful when you
pre‑generated the relight elsewhere and only want texture recovery.

- **Engine**: `POST ${ENGINE_URL}/detail-transfer` (multipart)
- **Proxy**: not exposed by the current frontend — call the engine
  directly, or add a proxy route to `server.js` mirroring `/api/process`.

| Field | Type | Required |
|-------|------|----------|
| `product_image` | file | yes |
| `relight_image` | file | yes |

```bash
curl -s "$ENGINE_URL/detail-transfer" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY" \
  -F "product_image=@./product.png" \
  -F "relight_image=@./ai-relight.png"
```

Response (202): same shape as `/process`.

### 11.5 `GET /jobs` — list jobs

Returns a summary list of jobs submitted by **this** API key. Other
tenants' jobs are invisible (`server.js:467-468`).

- **Engine**: `GET ${ENGINE_URL}/jobs`
- **Proxy**: `GET http://localhost:8080/api/jobs`

```bash
curl -s "$ENGINE_URL/jobs" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY"
```

Response (200):

```json
[
  {
    "job_id": "job_1771234567890_abc123x",
    "status": "completed",
    "progress": 100,
    "current_step": "completed",
    "mode": "2d",
    "created_at": "2026-04-23T14:12:03.118Z",
    "completed_at": "2026-04-23T14:12:48.902Z",
    "duration_seconds": 45,
    "error": null
  }
]
```

### 11.6 `GET /jobs/:id` — single job status

Full job record. Once `status: "completed"`, `result.downloads` is a map
from output name → engine download URL you can fetch from `/download/...`.

- **Engine**: `GET ${ENGINE_URL}/jobs/{jobId}`
- **Proxy**: `GET http://localhost:8080/api/jobs/{jobId}`

```bash
curl -s "$ENGINE_URL/jobs/job_1771234567890_abc123x" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY"
```

Response (200) while running:

```json
{
  "job_id": "job_1771234567890_abc123x",
  "status": "processing",
  "progress": 55,
  "current_step": "wavelet",
  "input": { "product": "product.png", "background": "background.jpg", "mode": "2d" }
}
```

Response (200) when done:

```json
{
  "job_id": "job_1771234567890_abc123x",
  "status": "completed",
  "progress": 100,
  "duration_seconds": 45,
  "result": {
    "mode": "2d",
    "outputs": { "final": "/abs/path/final.png", "base": "/abs/path/base.png" },
    "downloads": {
      "final": "/download/job_1771234567890_abc123x/final.png",
      "base":  "/download/job_1771234567890_abc123x/base.png"
    }
  }
}
```

### 11.7 `GET /jobs/history` — history from the license service

Pulls your org's job history from the central license service. Useful for
building a history view that survives engine instance restarts (the
engine's in‑memory store is transient).

- **Engine**: `GET ${ENGINE_URL}/jobs/history?limit=50`
- **Proxy**: not exposed by the current frontend — call directly.

Query params:

| Name | Default | Notes |
|------|---------|-------|
| `limit` | `100` | Max records to return |

```bash
curl -s "$ENGINE_URL/jobs/history?limit=20" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY"
```

Response (200): array of job records (shape matches whatever the license
service returns; mostly superset of `/jobs/:id`).

### 11.8 `GET /api/downloads/:jobId` — download URL map

Convenience endpoint: returns a map of output name → download URL for a
completed job, without having to pull the full job record. The URL points
back at `/download/{jobId}/{filename}`.

- **Engine**: `GET ${ENGINE_URL}/api/downloads/{jobId}`
- **Proxy**: `GET http://localhost:8080/api/downloads/{jobId}` — note the
  proxy rewrites the URLs to `/api/download/...` so they're browser‑safe.

```bash
curl -s "$ENGINE_URL/api/downloads/job_1771234567890_abc123x" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY"
```

Response (200):

```json
{
  "final": "/download/job_1771234567890_abc123x/final.png",
  "base":  "/download/job_1771234567890_abc123x/base.png"
}
```

### 11.9 `GET /download/:jobId/:filename` — download an output file

Streams the actual image bytes. Served from local disk if the job is still
on the engine instance, otherwise proxied from GCS.

- **Engine**: `GET ${ENGINE_URL}/download/{jobId}/{filename}` → `image/png`
- **Proxy**: `GET http://localhost:8080/api/download/{jobId}/{filename}` —
  same bytes, re‑streamed by the frontend.

```bash
curl -s "$ENGINE_URL/download/job_1771234567890_abc123x/final.png" \
  -H "Authorization: Bearer $IAP_TOKEN" \
  -H "X-Api-Key: $FRAMESHIFT_API_KEY" \
  -o final.png
```

### 11.10 Typical client flow

1. `POST /process` with the inputs. Capture `job_id` from the 202.
2. Poll `GET /jobs/:id` every 1–2s until `status` is `completed` or `failed`.
3. On success, read `result.downloads` (or call `GET /api/downloads/:jobId`).
4. For each entry, `GET /download/:jobId/:filename` to fetch the image.

Minimal Node example (direct — no frontend proxy):

```js
import { readFileSync } from 'fs';

const form = new FormData();
form.append('mode', '2d');
form.append('product_image',
  new Blob([readFileSync('./product.png')], { type: 'image/png' }),
  'product.png');
form.append('background_image',
  new Blob([readFileSync('./background.jpg')], { type: 'image/jpeg' }),
  'background.jpg');

const headers = {
  Authorization: `Bearer ${iapToken}`,
  'X-Api-Key': process.env.FRAMESHIFT_API_KEY,
};

const submit = await fetch(`${engineUrl}/process`, {
  method: 'POST', headers, body: form,
}).then(r => r.json());

let job;
while (true) {
  job = await fetch(`${engineUrl}/jobs/${submit.job_id}`, { headers })
    .then(r => r.json());
  if (['completed', 'failed'].includes(job.status)) break;
  await new Promise(r => setTimeout(r, 1500));
}

if (job.status === 'failed') throw new Error(job.error);

for (const [name, url] of Object.entries(job.result.downloads)) {
  const buf = Buffer.from(
    await fetch(`${engineUrl}${url}`, { headers }).then(r => r.arrayBuffer())
  );
  writeFileSync(`./${name}.png`, buf);
}
```

### 11.11 Endpoints you **cannot** call as a frontend

These live on the engine but require **admin** auth (session cookie or
`Bearer $FRAMESHIFT_PASSWORD`) — not an `fsk_` key — and are intentionally
off‑limits to frontends. Listed here so you're not surprised if a hit
returns `401`:

| Endpoint | Purpose |
|----------|---------|
| `GET /`, `GET /api/console`, `GET /api/console/stream` | Dashboard HTML + live logs |
| `POST /api/auth/login`, `POST /api/auth/logout` | Admin password login |
| `GET /api/license` | Admin license info |
| `GET /api/storage`, `POST /api/storage/setup` | GCS bucket config |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:keyId` | Manage `fsk_` keys |

If you need any of these programmatically, ask the engine operator — they
can run it from the dashboard on your behalf.
