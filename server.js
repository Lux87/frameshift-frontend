import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleAuth } from 'google-auth-library';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT) || 8080;

// ── Persistent data dir ──────────────────────────────────────────────────────
// Runtime settings (engine URL, API key, IAP client id, SA key path) are
// persisted here so the frontend can be deployed with zero env vars and
// configured through the UI afterwards. On Cloud Run this directory is
// per-instance and lost on cold start — see IMPLEMENTATION-GUIDE.md.
const dataDir = join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });
const configPath = join(dataDir, 'config.json');

function readPersisted() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function savePersisted(cfg) {
  const toWrite = {
    engineUrl: cfg.engineUrl || '',
    apiKey: cfg.apiKey || '',
    iapClientId: cfg.iapClientId || '',
    saKeyPath: cfg.saKeyPath || '',
  };
  writeFileSync(configPath, JSON.stringify(toWrite, null, 2));
}

// Config resolution order: persisted settings win, env vars act as a seed.
// This means an operator can pre-seed with env vars on deploy, but the UI
// can always override at runtime.
function loadConfig() {
  const persisted = readPersisted();
  return {
    engineUrl: (persisted.engineUrl || process.env.ENGINE_URL || '').replace(/\/$/, ''),
    apiKey: persisted.apiKey || process.env.FRAMESHIFT_API_KEY || '',
    iapClientId: persisted.iapClientId || process.env.IAP_CLIENT_ID || '',
    saKeyPath: persisted.saKeyPath || process.env.GOOGLE_SA_KEY_PATH || '',
    saEmail: null,
  };
}

let config = loadConfig();

let auth = null;

function initIapAuth() {
  auth = null;
  config.saEmail = null;

  if (!config.iapClientId) {
    console.log('[auth] No IAP_CLIENT_ID set — IAP authentication disabled (direct mode)');
    return;
  }

  const opts = { targetAudience: config.iapClientId };

  if (config.saKeyPath) {
    try {
      const keyData = JSON.parse(readFileSync(config.saKeyPath, 'utf8'));
      opts.credentials = keyData;
      config.saEmail = keyData.client_email || null;
      console.log(`[auth] Using service account: ${keyData.client_email}`);
    } catch (err) {
      console.error(`[auth] Failed to read SA key from ${config.saKeyPath}: ${err.message}`);
      console.log('[auth] Falling back to Application Default Credentials');
    }
  } else {
    console.log('[auth] No SA key file — using Application Default Credentials');
  }

  auth = new GoogleAuth(opts);
}

async function getIapHeaders() {
  if (!auth) return {};
  try {
    const client = await auth.getIdTokenClient(config.iapClientId);
    const headers = await client.getRequestHeaders();
    return headers;
  } catch (err) {
    console.error(`[auth] Failed to get IAP token: ${err.message}`);
    return {};
  }
}

class NotConfiguredError extends Error {
  constructor(missing) {
    super(`Frontend is not configured — set ${missing} in Settings.`);
    this.code = 'NOT_CONFIGURED';
    this.status = 503;
  }
}

async function proxyToEngine(path, options = {}) {
  if (!config.engineUrl) throw new NotConfiguredError('Engine URL');
  if (!config.apiKey) throw new NotConfiguredError('API Key');

  const url = `${config.engineUrl}${path}`;
  const iapHeaders = await getIapHeaders();

  const headers = {
    ...iapHeaders,
    'X-Api-Key': config.apiKey,
    ...options.headers,
  };

  const fetchOpts = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) fetchOpts.body = options.body;

  const resp = await fetch(url, fetchOpts);
  return resp;
}

function errorStatus(err) {
  return err.code === 'NOT_CONFIGURED' ? 503 : 502;
}

const app = express();
app.use(express.json());

app.use(express.static(join(__dirname, 'public')));

const uploadsDir = join(__dirname, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Health proxy ────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const resp = await proxyToEngine('/health');
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// ── Submit job ──────────────────────────────────────────────────────────────
app.post('/api/process', upload.fields([
  { name: 'product_image', maxCount: 1 },
  { name: 'background_image', maxCount: 1 },
  { name: 'detailing_mask', maxCount: 1 },
]), async (req, res) => {
  try {
    const formData = new FormData();

    if (req.body.mode) formData.append('mode', req.body.mode);
    if (req.body.action_prompt) formData.append('action_prompt', req.body.action_prompt);
    if (req.body.webhook_url) formData.append('webhook_url', req.body.webhook_url);

    for (const field of ['product_image', 'background_image', 'detailing_mask']) {
      if (req.files?.[field]?.[0]) {
        const file = req.files[field][0];
        const buf = readFileSync(file.path);
        formData.append(field, new Blob([buf], { type: file.mimetype }), file.originalname);
        try { unlinkSync(file.path); } catch {}
      }
    }

    const resp = await proxyToEngine('/process', {
      method: 'POST',
      body: formData,
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// ── Job status ──────────────────────────────────────────────────────────────
app.get('/api/jobs', async (req, res) => {
  try {
    const resp = await proxyToEngine('/jobs');
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const resp = await proxyToEngine(`/jobs/${req.params.id}`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// ── Download proxy (streams image from engine to browser) ───────────────────
app.get('/api/download/:jobId/:filename', async (req, res) => {
  try {
    const resp = await proxyToEngine(`/download/${req.params.jobId}/${req.params.filename}`);
    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Download failed' });
    }

    const contentType = resp.headers.get('content-type') || 'image/png';
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `inline; filename="${req.params.filename}"`);

    const arrayBuf = await resp.arrayBuffer();
    res.send(Buffer.from(arrayBuf));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// ── NB2 AI Selection Edit proxy (blend editor) ───────────────────────────────
const nb2Upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024, files: 15 },
});

app.post('/api/nb2-edit', nb2Upload.array('images', 13), async (req, res) => {
  try {
    const formData = new FormData();

    for (const field of ['prompt', 'aspect_ratio', 'resolution', 'temperature', 'output_format']) {
      if (req.body[field] != null) formData.append(field, req.body[field]);
    }

    for (const file of req.files || []) {
      const buf = readFileSync(file.path);
      formData.append('images', new Blob([buf], { type: file.mimetype }), file.originalname);
      try { unlinkSync(file.path); } catch {}
    }

    const resp = await proxyToEngine('/api/nb2-edit', {
      method: 'POST',
      body: formData,
    });

    const data = await resp.json().catch(() => ({}));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// ── Download URLs for a job ─────────────────────────────────────────────────
// Engine returns { bucket, outputs: { name: { url, gcs, gcsPath } } }.
// We rewrite each output's `url` (engine-proxy path) to the frontend's
// /api/download proxy path so browser fetches go through this service,
// and we pass `gcs` (the direct Google Cloud Storage URL) through untouched
// so the UI can render a direct "open in bucket" link.
app.get('/api/downloads/:jobId', async (req, res) => {
  try {
    const resp = await proxyToEngine(`/api/downloads/${req.params.jobId}`);
    const data = await resp.json();

    const outputs = {};
    const engineOutputs = data && typeof data === 'object' && data.outputs && typeof data.outputs === 'object'
      ? data.outputs
      : {};

    for (const [name, info] of Object.entries(engineOutputs)) {
      if (!info || typeof info !== 'object' || !info.url) continue;
      const parts = String(info.url).split('/');
      const filename = parts[parts.length - 1];
      outputs[name] = {
        url: `/api/download/${req.params.jobId}/${filename}`,
        gcs: info.gcs || null,
        gcsPath: info.gcsPath || null,
      };
    }

    res.json({
      bucket: data && data.bucket ? data.bucket : null,
      outputs,
    });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// ── Settings ─────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({
    engine_url: config.engineUrl,
    api_key: config.apiKey ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}` : '',
    api_key_set: !!config.apiKey,
    iap_client_id: config.iapClientId || '',
    iap_enabled: !!config.iapClientId,
    sa_key_path: config.saKeyPath || '',
    sa_email: config.saEmail || '',
    configured: !!(config.engineUrl && config.apiKey),
  });
});

app.put('/api/settings', (req, res) => {
  const { engine_url, api_key, iap_client_id } = req.body;
  let changed = false;

  if (engine_url !== undefined) {
    config.engineUrl = engine_url.replace(/\/$/, '');
    changed = true;
  }
  if (api_key !== undefined && api_key !== '') {
    config.apiKey = api_key;
    changed = true;
  }
  if (iap_client_id !== undefined) {
    config.iapClientId = iap_client_id;
    initIapAuth();
    changed = true;
  }

  if (changed) {
    try {
      savePersisted(config);
      console.log('[settings] Config updated and persisted to data/config.json');
    } catch (err) {
      console.error(`[settings] Failed to persist config: ${err.message}`);
      return res.status(500).json({ error: `Failed to persist: ${err.message}` });
    }
  }

  res.json({ ok: true });
});

const saUpload = multer({ dest: uploadsDir, limits: { fileSize: 1 * 1024 * 1024 } });

app.post('/api/settings/sa-key', saUpload.single('sa_key'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const raw = readFileSync(req.file.path, 'utf8');
    const keyData = JSON.parse(raw);

    if (!keyData.client_email || !keyData.private_key) {
      try { unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Invalid service account key — missing client_email or private_key' });
    }

    const destName = `${keyData.client_email.split('@')[0]}-sa-key.json`;
    const destPath = join(dataDir, destName);
    writeFileSync(destPath, JSON.stringify(keyData, null, 2));
    try { unlinkSync(req.file.path); } catch {}

    // Remove the previous SA key on disk (if any) to avoid stale files
    if (config.saKeyPath && config.saKeyPath !== destPath && existsSync(config.saKeyPath)) {
      try { unlinkSync(config.saKeyPath); } catch {}
    }

    config.saKeyPath = destPath;
    initIapAuth();
    savePersisted(config);

    console.log(`[settings] SA key uploaded: ${keyData.client_email}`);
    res.json({ ok: true, sa_email: keyData.client_email, sa_key_path: config.saKeyPath });
  } catch (err) {
    res.status(400).json({ error: `Invalid key file: ${err.message}` });
  }
});

app.post('/api/settings/test', async (req, res) => {
  try {
    if (!config.engineUrl) {
      return res.json({ ok: false, error: 'Engine URL not set', engine_url: '', iap_used: false });
    }
    if (!config.apiKey) {
      return res.json({ ok: false, error: 'API key not set', engine_url: config.engineUrl, iap_used: false });
    }
    const iapHeaders = await getIapHeaders();
    const resp = await fetch(`${config.engineUrl}/health`, {
      headers: { ...iapHeaders, 'X-Api-Key': config.apiKey },
    });
    const data = await resp.json().catch(() => ({}));
    res.json({
      ok: resp.ok,
      status: resp.status,
      engine_url: config.engineUrl,
      iap_used: !!auth,
      response: data,
    });
  } catch (err) {
    res.json({
      ok: false,
      error: err.message,
      engine_url: config.engineUrl,
      iap_used: !!auth,
    });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
initIapAuth();

app.listen(PORT, () => {
  console.log(`\nFrameShift Frontend running on http://localhost:${PORT}`);
  console.log(`Engine:  ${config.engineUrl || '(not configured — set via Settings)'}`);
  console.log(`API key: ${config.apiKey ? 'set' : '(not configured — set via Settings)'}`);
  console.log(`IAP:     ${config.iapClientId ? 'enabled' : 'disabled (direct mode)'}`);
  if (!config.engineUrl || !config.apiKey) {
    console.log('\n→ Open the UI and fill in Settings to finish configuration.\n');
  } else {
    console.log('');
  }
});
