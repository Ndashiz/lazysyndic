// LazySyndic → Jarvis bridge server.
// Exposes GET /api/jarvis/alerts (bearer-auth) reading Supabase server-side, and
// optionally pushes new alerts to Jarvis's webhook. Zero dependencies (Node 22).
//
//   node bridge/server.js
//
// Env (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_TOKEN,
// PORT, DOCUMENT_WINDOW_DAYS, and (push) JARVIS_WEBHOOK_URL, JARVIS_WEBHOOK_SECRET, POLL_MS.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRest } from './supabase.js';
import { buildAlerts, coproStatus } from './alerts.js';

// --- minimal .env loader (KEY=VALUE lines); systemd EnvironmentFile also works ---
const __dir = path.dirname(fileURLToPath(import.meta.url));
(function loadDotEnv() {
  const p = path.join(__dir, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  BRIDGE_TOKEN,
  PORT = '3011',
  HOST = '127.0.0.1',
  DOCUMENT_WINDOW_DAYS = '60',
  JARVIS_WEBHOOK_URL,
  JARVIS_WEBHOOK_SECRET,
  POLL_MS = '0',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 16) {
  console.error('FATAL: BRIDGE_TOKEN (≥ 16 chars) is required — it is the bearer Jarvis must present.');
  process.exit(1);
}

const rest = createRest(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const docWindow = Number(DOCUMENT_WINDOW_DAYS) || 60;

/** Constant-time bearer check against BRIDGE_TOKEN. */
function authorized(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(BRIDGE_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function currentAlerts() {
  const data = await rest.loadForAlerts();
  return buildAlerts(data, { documentWindowDays: docWindow });
}

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', service: 'lazysyndic-jarvis-bridge' });
    }
    if (req.method === 'GET' && url.pathname === '/api/jarvis/alerts') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const alerts = await currentAlerts();
      return sendJson(res, 200, { alerts });
    }
    // Mapping backlog, read by Jarvis's monthly routine to know whether the copro statement
    // has been categorised — LazySyndic owns that work, so it is the only place that knows.
    if (req.method === 'GET' && url.pathname === '/api/jarvis/copro') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, coproStatus(await rest.loadCoproRows()));
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('request_error', err?.message || err);
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(Number(PORT), HOST, () => {
  console.log(`lazysyndic-jarvis-bridge listening on ${HOST}:${PORT} (documents window ${docWindow}d)`);
});

// --- Optional push: poll and webhook new alerts to Jarvis ---------------------
const pollMs = Number(POLL_MS) || 0;
if (pollMs > 0 && JARVIS_WEBHOOK_URL && JARVIS_WEBHOOK_SECRET) {
  const seen = new Set();
  let priming = true; // first pass only records ids (no webhook storm for the backlog)
  const tick = async () => {
    try {
      const alerts = await currentAlerts();
      for (const a of alerts) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (priming) continue;
        const r = await fetch(JARVIS_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-lazysyndic-secret': JARVIS_WEBHOOK_SECRET },
          body: JSON.stringify(a),
        });
        if (!r.ok && r.status !== 200) console.error('webhook_failed', a.id, r.status);
      }
      priming = false;
    } catch (err) {
      console.error('poll_error', err?.message || err);
    }
  };
  setInterval(tick, pollMs).unref();
  tick();
  console.log(`push enabled → ${JARVIS_WEBHOOK_URL} every ${pollMs}ms`);
}
