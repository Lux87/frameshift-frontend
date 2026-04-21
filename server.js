import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT) || 8080;

let config = {
  engineUrl: process.env.ENGINE_URL?.replace(/\/$/, '') || '',
  apiKey: process.env.FRAMESHIFT_API_KEY || '',
  iapClientId: process.env.IAP_CLIENT_ID || '',
  saKeyPath: process.env.GOOGLE_SA_KEY_PATH || '',
  saEmail: null,
};

if (!config.engineUrl) throw new Error('ENGINE_URL is required');
if (!config.apiKey) throw new Error('FRAMESHIFT_API_KEY is required');

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

async function proxyToEngine(path, options = {}) {
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

const app = express();
app.use(express.json());

app.use(express.static(join(__dirname, 'public')));

const uploadsDir = join(__dirname, 'uploads');
import { mkdirSync } from 'fs';
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
    res.status(502).json({ error: `Engine unreachable: ${err.message}` });
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

    for (const field of ['product_image', 'background_image', 'detailing_mask']) {
      if (req.files?.[field]?.[0]) {
        const file = req.files[field][0];
        const { readFileSync: rfs, unlinkSync } = await import('fs');
        const buf = rfs(file.path);
        formData.append(field, new Blob([buf], { type: file.mimetype }), file.originalname);
        unlinkSync(file.path);
      }
    }

    const resp = await proxyToEngine('/process', {
      method: 'POST',
      body: formData,
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to submit job: ${err.message}` });
  }
});

// ── Job status ──────────────────────────────────────────────────────────────
app.get('/api/jobs', async (req, res) => {
  try {
    const resp = await proxyToEngine('/jobs');
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Engine unreachable: ${err.message}` });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const resp = await proxyToEngine(`/jobs/${req.params.id}`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Engine unreachable: ${err.message}` });
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
    res.status(502).json({ error: `Download failed: ${err.message}` });
  }
});

// ── NB2 AI Selection Edit proxy (blend editor) ───────────────────────────────
const nb2Upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024, files: 15 },
});

app.post('/api/nb2-edit', nb2Upload.array('images', 13), async (req, res) => {
  try {
    const { readFileSync: rfs, unlinkSync } = await import('fs');
    const formData = new FormData();

    for (const field of ['prompt', 'aspect_ratio', 'resolution', 'temperature', 'output_format']) {
      if (req.body[field] != null) formData.append(field, req.body[field]);
    }

    for (const file of req.files || []) {
      const buf = rfs(file.path);
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
    res.status(502).json({ error: `Failed to edit selection: ${err.message}` });
  }
});

// ── Download URLs for a job ─────────────────────────────────────────────────
app.get('/api/downloads/:jobId', async (req, res) => {
  try {
    const resp = await proxyToEngine(`/api/downloads/${req.params.jobId}`);
    const data = await resp.json();

    const remapped = {};
    for (const [name, enginePath] of Object.entries(data)) {
      const parts = enginePath.split('/');
      const filename = parts[parts.length - 1];
      remapped[name] = `/api/download/${req.params.jobId}/${filename}`;
    }
    res.json(remapped);
  } catch (err) {
    res.status(502).json({ error: `Engine unreachable: ${err.message}` });
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

  if (changed) console.log('[settings] Config updated via UI');

  res.json({ ok: true });
});

const saUpload = multer({ dest: uploadsDir, limits: { fileSize: 1 * 1024 * 1024 } });

app.post('/api/settings/sa-key', saUpload.single('sa_key'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { readFileSync: rfs, writeFileSync, unlinkSync } = await import('fs');
    const raw = rfs(req.file.path, 'utf8');
    const keyData = JSON.parse(raw);

    if (!keyData.client_email || !keyData.private_key) {
      unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid service account key — missing client_email or private_key' });
    }

    const destName = `${keyData.client_email.split('@')[0]}-sa-key.json`;
    const destPath = join(__dirname, destName);
    writeFileSync(destPath, JSON.stringify(keyData, null, 2));
    unlinkSync(req.file.path);

    config.saKeyPath = `./${destName}`;
    initIapAuth();

    console.log(`[settings] SA key uploaded: ${keyData.client_email}`);
    res.json({ ok: true, sa_email: keyData.client_email, sa_key_path: config.saKeyPath });
  } catch (err) {
    res.status(400).json({ error: `Invalid key file: ${err.message}` });
  }
});

app.post('/api/settings/test', async (req, res) => {
  try {
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
  console.log(`Engine: ${config.engineUrl}`);
  console.log(`IAP: ${config.iapClientId ? 'enabled' : 'disabled (direct mode)'}\n`);
});
