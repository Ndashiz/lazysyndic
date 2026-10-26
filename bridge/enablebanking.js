// Client Enable Banking (https://enablebanking.com/docs/api/reference/) — zéro dépendance.
//
// Chaque appel porte un JWT RS256 signé avec la clé privée de l'application Enable Banking
// (le .pem téléchargé à la création de l'application dans le Control Panel) : en-tête
// {typ:'JWT', alg:'RS256', kid:<id de l'application>}, corps {iss:'enablebanking.com',
// aud:'api.enablebanking.com', iat, exp}. Durée de vie : 24 h au plus côté Enable Banking,
// 1 h ici, régénéré 5 min avant l'échéance.
//
// La clé privée ne quitte jamais le VPS : ni le navigateur, ni Supabase, ni Jarvis ne la voient.
// Sans elle, un `code` d'autorisation ou un `session_id` ne permet de rien lire.

import crypto from 'node:crypto';

export const EB_BASE_URL = 'https://api.enablebanking.com';
const JWT_TTL_S = 3600;

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/**
 * JWT d'application Enable Banking.
 * @param {{appId:string, privateKey:string|crypto.KeyObject, now?:number}} o  now en secondes
 */
export function signJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000), ttl = JWT_TTL_S }) {
  if (!appId) throw new Error('enablebanking_app_id_missing');
  if (!privateKey) throw new Error('enablebanking_private_key_missing');
  const head = b64url({ typ: 'JWT', alg: 'RS256', kid: appId });
  const body = b64url({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + ttl });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** Erreur HTTP d'Enable Banking, avec le statut et le code renvoyés (`error`, `code`). */
export class EnableBankingError extends Error {
  constructor(path, status, body) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* corps texte */ }
    const what = (parsed && (parsed.message || parsed.error || parsed.detail)) || String(body || '').slice(0, 200);
    super(`enablebanking ${path} → HTTP ${status}${what ? ` : ${typeof what === 'string' ? what : JSON.stringify(what)}` : ''}`);
    this.status = status;
    this.code = (parsed && (parsed.error || parsed.code)) || null;
    this.body = parsed || body;
  }
}

/**
 * @param {{appId:string, privateKey:string, baseUrl?:string, fetch?:typeof fetch, now?:()=>number}} cfg
 */
export function createEnableBanking({ appId, privateKey, baseUrl = EB_BASE_URL, fetch: f = globalThis.fetch, now = () => Date.now() }) {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  let jwt = null, jwtExp = 0;
  function token() {
    const s = Math.floor(now() / 1000);
    if (!jwt || jwtExp - s < 300) { jwt = signJwt({ appId, privateKey: key, now: s }); jwtExp = s + JWT_TTL_S; }
    return jwt;
  }

  async function call(method, path, { query, body } = {}) {
    const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    const url = `${baseUrl.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`;
    const res = await f(url, {
      method,
      headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new EnableBankingError(`${method} ${path}`, res.status, text);
    return text ? JSON.parse(text) : {};
  }

  return {
    /** L'application telle qu'Enable Banking la voit : nom, environnement, actif, redirect_urls. */
    application: () => call('GET', '/application'),
    /** Les banques (ASPSP) d'un pays, avec psu_types et maximum_consent_validity (secondes). */
    aspsps: (country) => call('GET', '/aspsps', { query: { country, service: 'AIS' } }).then((r) => r.aspsps || []),
    /** Démarre l'autorisation : renvoie {url, authorization_id}. La banque renvoie sur redirectUrl?code=…&state=…. */
    startAuth: ({ aspspName, country, psuType, redirectUrl, state, validUntil, language = 'fr' }) => call('POST', '/auth', {
      body: {
        access: { valid_until: validUntil, balances: true, transactions: true },
        aspsp: { name: aspspName, country },
        state, redirect_url: redirectUrl, psu_type: psuType, language,
      },
    }),
    /** Échange le code contre une session : {session_id, accounts:[AccountResource], access:{valid_until}}. */
    createSession: (code) => call('POST', '/sessions', { body: { code } }),
    getSession: (id) => call('GET', `/sessions/${encodeURIComponent(id)}`),
    deleteSession: (id) => call('DELETE', `/sessions/${encodeURIComponent(id)}`),
    balances: (uid) => call('GET', `/accounts/${encodeURIComponent(uid)}/balances`).then((r) => r.balances || []),
    /** Une page de mouvements ; `continuation_key` null quand il n'y en a plus. */
    transactionsPage: (uid, { dateFrom, continuationKey, status = 'BOOK' } = {}) => call('GET', `/accounts/${encodeURIComponent(uid)}/transactions`, {
      query: { date_from: dateFrom, continuation_key: continuationKey, transaction_status: status },
    }),
    /** Toutes les pages (garde-fou : 100 pages). */
    async transactions(uid, opts = {}) {
      const out = [];
      let continuationKey = null;
      for (let page = 0; page < 100; page++) {
        const r = await this.transactionsPage(uid, { ...opts, continuationKey });
        out.push(...(r.transactions || []));
        continuationKey = r.continuation_key || null;
        if (!continuationKey) return out;
      }
      throw new Error('enablebanking_transactions_too_many_pages');
    },
  };
}
