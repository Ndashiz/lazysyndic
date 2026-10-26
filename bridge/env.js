// Chargeur minimal de bridge/.env (lignes CLE=VALEUR) — partagé par server.js et eb.js.
// Une variable déjà présente dans l'environnement (systemd EnvironmentFile) l'emporte.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadDotEnv(dir = BRIDGE_DIR) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** La configuration Enable Banking, ou null si elle est absente (synchro désactivée). */
export function enableBankingConfig(env = process.env) {
  if (!env.EB_APP_ID || !env.EB_KEY_PATH) return null;
  const keyPath = path.isAbsolute(env.EB_KEY_PATH) ? env.EB_KEY_PATH : path.join(BRIDGE_DIR, env.EB_KEY_PATH);
  return {
    appId: env.EB_APP_ID.trim(),
    keyPath,
    privateKey: fs.readFileSync(keyPath, 'utf8'),
    baseUrl: env.EB_BASE_URL || undefined,
    syncHours: Math.max(1, Number(env.EB_SYNC_HOURS) || 8),
    pollMs: Math.max(5000, Number(env.EB_POLL_MS) || 20000),
    redirectAllow: String(env.EB_REDIRECT_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
