/**
 * Serves the production build and exposes the data-refresh endpoint — no dependencies.
 *
 * Binds 0.0.0.0 so phones and other machines on the same wifi can open the
 * dashboard, which is also how the mobile layout gets tested on a real device.
 *
 * Two roots are served, deliberately:
 *   /data/*   from public/data — the live artifact, rewritten by build:data, so a
 *             refresh takes effect without rebuilding the app bundle.
 *   anything  from dist — the app shell, whose asset names are content-hashed.
 *
 * Usage: npm run serve  [-- --port 4173]
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATES } from './build-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DATA = path.join(ROOT, 'public', 'data');
const SOURCE_DIR = path.join(ROOT, 'BEMMP DATA');

const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 4173;

/**
 * Loads `.env.local` from the repo root, so the OpenAI key and the site password
 * can be set once in a file instead of exported before every run.
 *
 * The file is gitignored. It is read *here*, in the server process — the browser
 * never receives it. A key placed anywhere the browser can fetch (src/, public/,
 * the bundle) is a published key, because everything the page can read, so can
 * every visitor.
 */
function loadEnvFile() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Tolerate quoted values, which is what people paste out of a password manager.
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // A real environment variable wins, so CI and scheduled tasks can override.
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

/* -------------------------------------------------------------- assistant -- */

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';

/**
 * Forwards one chat-completions request using the server-held key.
 *
 * The body is capped and the model is pinned server-side, so a client cannot use
 * this as an open relay to run arbitrary expensive jobs on the company key.
 */
function proxyToOpenAI(req, res, kind = 'chat') {
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 128 * 1024) {
      aborted = true;
      sendJson(res, 413, { error: 'request too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
    // Speech returns audio bytes; chat returns JSON. Both pin the model here so a
    // client cannot ask the company key for an expensive one.
    const speech = kind === 'speech';
    const endpoint = speech
      ? 'https://api.openai.com/v1/audio/speech'
      : 'https://api.openai.com/v1/chat/completions';
    body.model = speech ? OPENAI_TTS_MODEL : OPENAI_MODEL;

    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (speech && upstream.ok) {
        const audio = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.length,
          'Cache-Control': 'no-store',
        });
        res.end(audio);
        return;
      }

      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(text);
    } catch (err) {
      sendJson(res, 502, { error: `upstream request failed: ${err.message}` });
    }
  });
}

/* ------------------------------------------------------------------ auth -- */

/*
 * Optional shared-password gate, on when BEMMP_PASSWORD is set.
 *
 * Off by default because the LAN case does not need it. Turn it on for anything
 * reachable beyond the office — the artifact carries engineer names and phone
 * numbers, so an open URL publishes those. Basic auth sends the password on every
 * request, so only enable it behind HTTPS (a tunnel), never on plain http.
 */
const AUTH_USER = process.env.BEMMP_USER || 'cyrix';
const AUTH_PASS = process.env.BEMMP_PASSWORD || '';
const AUTH_ON = AUTH_PASS.length > 0;

const expected = AUTH_ON
  ? Buffer.from(`Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')}`)
  : null;

function authorised(req) {
  if (!AUTH_ON) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const given = Buffer.from(header);
  // timingSafeEqual throws on length mismatch, which is itself a mismatch.
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/* --------------------------------------------------------------- refresh -- */

const job = { status: 'idle', startedAt: null, finishedAt: null, log: [], error: null };

function startRefresh() {
  if (job.status === 'running') return false;

  job.status = 'running';
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.log = [];
  job.error = null;

  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-data.mjs')], {
    cwd: ROOT,
  });

  const push = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const t = line.trim();
      if (t) job.log.push(t);
    }
    // The log is a progress readout, not an archive.
    if (job.log.length > 80) job.log = job.log.slice(-80);
  };

  child.stdout.on('data', push);
  child.stderr.on('data', push);

  child.on('error', (err) => {
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = Date.now();
  });

  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'error';
    if (code !== 0) job.error = `build-data exited with code ${code}`;
    job.finishedAt = Date.now();
    console.log(`  refresh ${job.status} in ${((job.finishedAt - job.startedAt) / 1000).toFixed(0)}s`);
  });

  return true;
}

/** Source workbook mtimes against the artifact's build time. */
function freshness() {
  const out = [];
  for (const state of STATES) {
    const source = path.join(SOURCE_DIR, state.file);
    const metaPath = path.join(DATA, state.id, 'meta.json');

    let sourceAt = null;
    let sourceMB = null;
    if (fs.existsSync(source)) {
      const st = fs.statSync(source);
      sourceAt = st.mtimeMs;
      sourceMB = +(st.size / 1e6).toFixed(1);
    }

    let builtAt = null;
    let rows = null;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        builtAt = Date.parse(meta.generatedAt) || null;
        rows = meta.rows ?? null;
      } catch { /* a half-written meta during a build is not an error here */ }
    }

    out.push({
      id: state.id,
      short: state.short,
      name: state.name,
      file: state.file,
      sourceAt,
      sourceMB,
      builtAt,
      rows,
      missing: sourceAt === null,
      stale: sourceAt !== null && builtAt !== null && sourceAt > builtAt,
    });
  }
  return out;
}

function sendJson(res, code, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/* ----------------------------------------------------------------- files -- */

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (!authorised(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="BEMMP dashboard", charset="UTF-8"',
      'Cache-Control': 'no-store',
    });
    res.end('Authentication required');
    return;
  }

  if (url === '/api/status') {
    sendJson(res, 200, {
      refreshAvailable: true,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      log: job.log.slice(-12),
      states: freshness(),
    });
    return;
  }

  if (url === '/api/refresh') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'use POST' }); return; }
    const started = startRefresh();
    sendJson(res, started ? 202 : 409, {
      started,
      status: job.status,
      error: started ? null : 'a refresh is already running',
    });
    return;
  }

  /*
   * Assistant proxy. The OpenAI key stays in this process and is never sent to the
   * browser; the page posts a request body here and gets the completion back. Without
   * OPENAI_API_KEY the health check fails and the app falls back to asking each user
   * for their own key.
   */
  if (url === '/api/assistant/health') {
    if (!OPENAI_KEY) { sendJson(res, 503, { error: 'OPENAI_API_KEY not set' }); return; }
    sendJson(res, 200, { ok: true, model: OPENAI_MODEL, tts: true });
    return;
  }

  if (url === '/api/assistant' || url === '/api/assistant/speech') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'use POST' }); return; }
    if (!OPENAI_KEY) { sendJson(res, 503, { error: 'OPENAI_API_KEY not set' }); return; }
    proxyToOpenAI(req, res, url.endsWith('/speech') ? 'speech' : 'chat');
    return;
  }

  // Serving a half-written artifact would hand the browser a torn binary, so the
  // data route is closed for the ~10s a rebuild takes.
  const isData = url.startsWith('/data/');
  if (isData && job.status === 'running') {
    res.writeHead(503, { 'Retry-After': '5', 'Cache-Control': 'no-store' });
    res.end('rebuilding');
    return;
  }

  const base = isData ? DATA : DIST;
  const rel = isData ? url.slice('/data/'.length) : (url === '/' ? 'index.html' : url);
  const resolved = path.resolve(path.join(base, rel));

  const file = resolved.startsWith(base) && fs.existsSync(resolved)
    && fs.statSync(resolved).isFile()
    ? resolved
    : path.join(DIST, 'index.html');

  const ext = path.extname(file);
  const stat = fs.statSync(file);

  /*
   * Only /assets/ is safe to cache hard — Vite content-hashes those filenames, so
   * a rebuild produces new URLs. Everything else keeps a stable name across
   * rebuilds and must be revalidated, index.html above all: caching it would pin
   * returning users to an old build whose hashed assets no longer exist.
   */
  const immutable = url.startsWith('/assets/');

  // Revalidation needs a validator, or "no-cache" just re-downloads 23 MB of
  // tickets.bin on every page load even when the data has not changed.
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  if (!immutable && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }

  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`\n  BEMMP dashboard — app from dist/, data from public/data/\n`);
  console.log(`  Local     http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  Network   http://${ip}:${PORT}`);
  console.log(`\n  Password  ${AUTH_ON ? `on (user "${AUTH_USER}")` : 'off — anyone who can reach this port can read the data'}`);
  console.log(`  Assistant ${OPENAI_KEY ? `on (${OPENAI_MODEL}, key held server-side)` : 'off — set OPENAI_API_KEY to enable'}`);
  console.log('  The Refresh button in the header re-reads BEMMP DATA/ on demand.');
  console.log('  Ctrl+C to stop.\n');
});
