import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT) || 8080;
const ENGINE_URL = process.env.ENGINE_URL?.replace(/\/$/, '');
const API_KEY = process.env.FRAMESHIFT_API_KEY;
const IAP_CLIENT_ID = process.env.IAP_CLIENT_ID;
const SA_KEY_PATH = process.env.GOOGLE_SA_KEY_PATH;

if (!ENGINE_URL) throw new Error('ENGINE_URL is required');
if (!API_KEY) throw new Error('FRAMESHIFT_API_KEY is required');

let auth = null;

function initIapAuth() {
  if (!IAP_CLIENT_ID) {
    console.log('[auth] No IAP_CLIENT_ID set — IAP authentication disabled (direct mode)');
    return;
  }

  const opts = { targetAudience: IAP_CLIENT_ID };

  if (SA_KEY_PATH) {
    try {
      const keyData = JSON.parse(readFileSync(SA_KEY_PATH, 'utf8'));
      opts.credentials = keyData;
      console.log(`[auth] Using service account: ${keyData.client_email}`);
    } catch (err) {
      console.error(`[auth] Failed to read SA key from ${SA_KEY_PATH}: ${err.message}`);
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
    const client = await auth.getIdTokenClient(IAP_CLIENT_ID);
    const headers = await client.getRequestHeaders();
    return headers;
  } catch (err) {
    console.error(`[auth] Failed to get IAP token: ${err.message}`);
    return {};
  }
}

async function proxyToEngine(path, options = {}) {
  const url = `${ENGINE_URL}${path}`;
  const iapHeaders = await getIapHeaders();

  const headers = {
    ...iapHeaders,
    'X-Api-Key': API_KEY,
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

// ── Start ───────────────────────────────────────────────────────────────────
initIapAuth();

app.listen(PORT, () => {
  console.log(`\nFrameShift Frontend running on http://localhost:${PORT}`);
  console.log(`Engine: ${ENGINE_URL}`);
  console.log(`IAP: ${IAP_CLIENT_ID ? 'enabled' : 'disabled (direct mode)'}\n`);
});
