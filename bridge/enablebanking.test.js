// Run: node --test  (from bridge/)  — no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signJwt, createEnableBanking, EnableBankingError } from './enablebanking.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const APP = '0377783c-3414-4bb1-a7d4-0c3eb54cd4b0';   // l'identifiant d'exemple des samples Enable Banking
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('signJwt : en-tête RS256 + kid, claims Enable Banking, signature vérifiable avec la clé publique', () => {
  const jwt = signJwt({ appId: APP, privateKey: pem, now: 1_800_000_000 });
  const [h, b, s] = jwt.split('.');
  assert.deepEqual(decode(h), { typ: 'JWT', alg: 'RS256', kid: APP });
  assert.deepEqual(decode(b), { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(!/[=+/]/.test(jwt), 'base64url sans remplissage');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('signJwt refuse sans identifiant ou sans clé', () => {
  assert.throws(() => signJwt({ appId: '', privateKey: pem }), /app_id/);
  assert.throws(() => signJwt({ appId: APP, privateKey: '' }), /private_key/);
});

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, ...init });
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const r = typeof routes[key] === 'function' ? routes[key](u, init) : routes[key];
    if (!r) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'no route' }), { status: 404 });
    return new Response(JSON.stringify(r.body ?? r), { status: r.status || 200 });
  };
  return { f, calls };
}

test('chaque appel porte le JWT, le corps JSON et la query encodée', async () => {
  const { f, calls } = fakeFetch({
    'GET /aspsps': { aspsps: [{ name: 'Swan', country: 'FR' }] },
    'POST /auth': { url: 'https://bank.example/auth?x=1', authorization_id: 'a1' },
  });
  const eb = createEnableBanking({ appId: APP, privateKey: pem, fetch: f });
  assert.deepEqual(await eb.aspsps('FR'), [{ name: 'Swan', country: 'FR' }]);
  const r = await eb.startAuth({ aspspName: 'Swan', country: 'FR', psuType: 'business', redirectUrl: 'https://ndashiz.be/lazysyndic/banque.html', state: 's1', validUntil: '2027-01-01T00:00:00.000Z' });
  assert.equal(r.url, 'https://bank.example/auth?x=1');
  assert.match(calls[0].url, /\/aspsps\?country=FR&service=AIS$/);
  assert.match(calls[0].headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const body = JSON.parse(calls[1].body);
  assert.deepEqual(body.aspsp, { name: 'Swan', country: 'FR' });
  assert.deepEqual(body.access, { valid_until: '2027-01-01T00:00:00.000Z', balances: true, transactions: true });
  assert.equal(body.redirect_url, 'https://ndashiz.be/lazysyndic/banque.html');
  assert.equal(body.state, 's1');
  assert.equal(body.psu_type, 'business');
  assert.equal(calls[1].headers['content-type'], 'application/json');
});

test('le JWT est réutilisé, puis renouvelé 5 min avant son échéance', async () => {
  let t = 1_800_000_000_000;
  const { f, calls } = fakeFetch({ 'GET /application': { name: 'LazySyndic' } });
  const eb = createEnableBanking({ appId: APP, privateKey: pem, fetch: f, now: () => t });
  await eb.application(); await eb.application();
  t += 56 * 60 * 1000;
  await eb.application();
  assert.equal(calls[0].headers.authorization, calls[1].headers.authorization);
  assert.notEqual(calls[1].headers.authorization, calls[2].headers.authorization);
});

test('une erreur HTTP devient EnableBankingError avec statut et code', async () => {
  const { f } = fakeFetch({ 'GET /accounts/u1/balances': { status: 422, body: { error: 'EXPIRED_SESSION', message: 'Session expired' } } });
  const eb = createEnableBanking({ appId: APP, privateKey: pem, fetch: f });
  await assert.rejects(eb.balances('u1'), (e) => e instanceof EnableBankingError && e.status === 422 && e.code === 'EXPIRED_SESSION' && /Session expired/.test(e.message));
});

test('transactions : toutes les pages via continuation_key, en ne demandant que le comptabilisé', async () => {
  const pages = { '': { transactions: [{ n: 1 }, { n: 2 }], continuation_key: 'k2' }, k2: { transactions: [{ n: 3 }], continuation_key: null } };
  const { f, calls } = fakeFetch({ 'GET /accounts/u1/transactions': (u) => pages[u.searchParams.get('continuation_key') || ''] });
  const eb = createEnableBanking({ appId: APP, privateKey: pem, fetch: f });
  const all = await eb.transactions('u1', { dateFrom: '2026-07-01' });
  assert.deepEqual(all.map((x) => x.n), [1, 2, 3]);
  assert.match(calls[0].url, /date_from=2026-07-01/);
  assert.match(calls[0].url, /transaction_status=BOOK/);
  assert.match(calls[1].url, /continuation_key=k2/);
});
