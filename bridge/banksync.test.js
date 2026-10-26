// Run: node --test  (from bridge/)  — no dependencies.
// Le cycle complet de la synchro bancaire contre un Supabase en mémoire (un mini PostgREST qui
// comprend les filtres que le pont emploie) et un faux Enable Banking. Données FICTIVES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankSync } from './banksync.js';
import { EnableBankingError } from './enablebanking.js';

/* ---------- mini PostgREST ---------- */
function getCol(row, col) {
  const m = col.match(/^(\w+)->>(\w+)$/);
  if (m) { const v = row[m[1]] && row[m[1]][m[2]]; return v == null ? null : String(v); }
  return row[col];
}
function cond(row, col, expr) {
  const [op, ...rest] = expr.split('.');
  const val = rest.join('.');
  const v = getCol(row, col);
  switch (op) {
    case 'eq': return v != null && String(v) === val;
    case 'neq': return v != null && String(v) !== val;
    case 'gte': return v != null && String(v) >= val;
    case 'lte': return v != null && String(v) <= val;
    case 'in': return val.replace(/^\(|\)$/g, '').split(',').includes(String(v));
    case 'is': return val === 'null' ? v == null : String(v) === val;
    case 'not': return !cond(row, col, val);
    default: throw new Error(`op ${op}`);
  }
}
function filterRows(rows, query) {
  let out = rows, order = null, limit = null;
  for (const part of String(query || '').split('&').filter(Boolean)) {
    const i = part.indexOf('='), k = part.slice(0, i), e = decodeURIComponent(part.slice(i + 1));
    if (k === 'select') continue;
    if (k === 'order') { order = e; continue; }
    if (k === 'limit') { limit = Number(e); continue; }
    if (k === 'or') {
      const parts = e.replace(/^\(|\)$/g, '').split(',').map((c) => { const [col, ...x] = c.split('.'); return [col, x.join('.')]; });
      out = out.filter((r) => parts.some(([col, x]) => cond(r, col, x)));
      continue;
    }
    out = out.filter((r) => cond(r, k, e));
  }
  if (order) {
    const [col, dir] = order.split('.');
    out = [...out].sort((a, b) => { const x = a[col] ?? '', y = b[col] ?? ''; return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); });
  }
  return limit ? out.slice(0, limit) : out;
}
function fakeRest(seed = {}) {
  const db = { ls_bank_links: [], ls_transactions: [], ls_imports: [], ls_timeline: [], ls_bank_syncs: [], ls_settings: [{ id: 1 }], ...seed };
  let n = 0;
  return {
    db,
    async select(t, q) { if (!db[t]) throw new Error(`supabase_${t}_http_404`); return structuredClone(filterRows(db[t], q)); },
    async insert(t, rows) {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: `${t}-${++n}`, created_at: new Date().toISOString(), deleted_at: null, ...structuredClone(r) }));
      if (t === 'ls_transactions') for (const r of list) {
        if (r.bank_ref && db[t].some((x) => x.account === r.account && x.bank_ref === r.bank_ref)) throw new Error('supabase_ls_transactions_post_http_409');
      }
      db[t].push(...list);
      return structuredClone(list);
    },
    async update(t, q, patch) {
      const hit = filterRows(db[t], q);
      for (const r of hit) Object.assign(r, structuredClone(patch));
      return structuredClone(hit);
    },
  };
}

/* ---------- faux Enable Banking ---------- */
const IBAN_PAY = 'FR7617748019000000000000001', IBAN_RES = 'FR7617748019000000000000002';
const bankTx = (d, amount, dir, party, remit, ref) => ({
  booking_date: d, status: 'BOOK', credit_debit_indicator: dir, transaction_amount: { currency: 'EUR', amount },
  ...(dir === 'CRDT' ? { debtor: { name: party } } : { creditor: { name: party } }),
  remittance_information: remit ? [remit] : [], entry_reference: ref,
});
function fakeEb() {
  const state = {
    tx: {
      'u-pay': [
        bankTx('2026-10-01', '150.00', 'CRDT', 'Alex Martin', 'Provision octobre', 'P1'),
        bankTx('2026-10-01', '150.00', 'CRDT', 'Sam Bernard', 'Provision octobre', 'P2'),
        bankTx('2026-10-09', '84.12', 'DBIT', 'ENGIE', 'Facture 2026-10', 'P3'),
      ],
      'u-res': [bankTx('2026-10-05', '50.00', 'CRDT', 'Lou Petit', 'Fonds de reserve', 'R1')],
    },
    balances: { 'u-pay': '1215.88', 'u-res': '871.14' },
    sessionStatus: 'AUTHORIZED',
    calls: [],
    failTx: null,
  };
  const eb = {
    async aspsps(country) { state.calls.push(['aspsps', country]); return [{ name: 'Swan', country: 'FR', psu_types: ['business'], maximum_consent_validity: 180 * 86400 }, { name: 'Qonto', country: 'FR', psu_types: ['business'] }]; },
    async startAuth(o) { state.calls.push(['auth', o]); return { url: `https://swan.example/auth?state=${o.state}` }; },
    async createSession(code) {
      state.calls.push(['session', code]);
      if (code !== 'good-code') throw new EnableBankingError('POST /sessions', 422, '{"error":"WRONG_CODE"}');
      return {
        session_id: `sess-${state.calls.length}`, access: { valid_until: '2027-04-24T09:00:00.000Z' },
        accounts: [
          { uid: 'u-pay', identification_hash: 'h-pay', account_id: { iban: IBAN_PAY }, name: 'ACP Démo', currency: 'EUR' },
          { uid: 'u-res', identification_hash: 'h-res', account_id: { iban: IBAN_RES }, name: 'ACP Démo', currency: 'EUR' },
        ],
      };
    },
    async getSession() { return { status: state.sessionStatus }; },
    async deleteSession(id) { state.calls.push(['delete', id]); return {}; },
    async balances(uid) { return [{ balance_type: 'ITBD', balance_amount: { currency: 'EUR', amount: state.balances[uid] }, reference_date: '2026-10-26' }]; },
    async transactions(uid, { dateFrom }) {
      state.calls.push(['tx', uid, dateFrom]);
      if (state.failTx) throw state.failTx;
      return (state.tx[uid] || []).filter((t) => t.booking_date >= dateFrom);
    },
  };
  return { eb, state };
}

const NOW = Date.parse('2026-10-26T10:00:00Z');
const quiet = { log() {}, error() {} };
function setup(seed) {
  const rest = fakeRest(seed);
  const { eb, state } = fakeEb();
  let t = NOW;
  const sync = createBankSync({ rest, eb, log: quiet, syncHours: 8, now: () => t });
  return { rest, eb, state, sync, at: (ms) => { t = ms; }, now: () => t };
}
const request = (o = {}) => ({
  id: 'L1', status: 'requested', aspsp_name: 'swan', aspsp_country: 'FR', psu_type: 'personal',
  redirect_url: 'https://ndashiz.be/lazysyndic/banque.html', state: 'st-1', accounts: [], seen: {}, acct_map: {},
  created_at: new Date(NOW - 60e3).toISOString(), updated_at: new Date(NOW - 60e3).toISOString(), ...o,
});
const settings = { id: 1, iban_pay: 'FR76 1774 8019 0000 0000 0000 001', iban_map: { [IBAN_RES]: 'res' } };

test('connexion de bout en bout : lien de la banque, code, session, première synchro en brouillon', async () => {
  const { rest, state, sync } = setup({ ls_settings: [settings], ls_bank_links: [request()] });
  await sync.tick();
  const l = rest.db.ls_bank_links[0];
  assert.equal(l.status, 'auth_ready');
  assert.equal(l.auth_url, 'https://swan.example/auth?state=st-1');
  assert.equal(l.aspsp_name, 'Swan', 'le nom exact de la banque remplace la saisie');
  assert.equal(l.psu_type, 'business', 'type de compte ramené à ce que la banque propose');
  const auth = state.calls.find((c) => c[0] === 'auth')[1];
  assert.equal(auth.redirectUrl, 'https://ndashiz.be/lazysyndic/banque.html');
  assert.equal(auth.validUntil, '2027-04-24T09:00:00.000Z');

  // l'app dépose le code renvoyé par la banque
  Object.assign(l, { status: 'code_received', code: 'good-code', updated_at: new Date(NOW).toISOString() });
  await sync.tick();
  assert.equal(l.status, 'active');
  assert.equal(l.code, null, 'le code d’autorisation ne reste pas en base');
  assert.equal(l.valid_until, '2027-04-24T09:00:00.000Z');
  assert.deepEqual(l.accounts.map((a) => [a.uid, a.acct, a.synced_to]), [['u-pay', 'pay', '2026-10-26'], ['u-res', 'res', '2026-10-26']]);

  const tx = rest.db.ls_transactions;
  assert.equal(tx.length, 4);
  assert.ok(tx.every((t) => t.draft === true && t.high === null && t.bank_ref), 'brouillons, sans catégorie, avec référence');
  assert.deepEqual(tx.filter((t) => t.account === 'pay').map((t) => [t.tx_date, t.tiers, t.amount]),
    [['2026-10-01', 'Alex Martin', 150], ['2026-10-01', 'Sam Bernard', 150], ['2026-10-09', 'ENGIE', -84.12]]);
  // un relevé à valider par compte, avec le solde de la banque comme clôture
  const imps = rest.db.ls_imports;
  assert.equal(imps.length, 2);
  const pay = imps.find((i) => i.stmt.acct === 'pay');
  assert.equal(pay.pending, true);
  assert.equal(pay.cur, false);
  assert.equal(pay.stmt.source, 'bank');
  assert.equal(pay.stmt.closing, 1215.88);
  assert.equal(pay.stmt.opening, 1000, 'premier relevé du compte : ouverture = solde − mouvements');
  assert.equal(pay.stmt.asOf, '26/10/26');
  assert.equal(pay.stmt.from, '01/10/26');
  assert.equal(pay.stmt.iban, 'FR76 1774 8019 0000 0000 0000 001');
  assert.equal(new Set(imps.map((i) => i.v)).size, 2, 'deux numéros de relevé distincts');
  assert.ok(tx.filter((t) => t.account === 'pay').every((t) => t.import_v === pay.v));
  assert.equal(rest.db.ls_timeline.length, 2);
  assert.equal(l.last_sync.added.pay, 3);
  assert.ok(l.last_ok_at);
});

test('les synchros suivantes : rien en double, le nouveau rejoint le relevé encore à valider', async () => {
  const { rest, state, sync, at } = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  await sync.tick();
  assert.equal(rest.db.ls_transactions.length, 4);
  const v = rest.db.ls_imports.find((i) => i.stmt.acct === 'pay').v;

  assert.deepEqual(await sync.tick(), [{ id: 'L1', status: 'idle' }], 'pas encore l’heure');
  state.tx['u-pay'].push(bankTx('2026-10-27', '6.00', 'DBIT', '', 'Account subscription', 'P4'));
  state.balances['u-pay'] = '1209.88';
  at(NOW + 9 * 3600e3);
  await sync.tick();
  const pay = rest.db.ls_transactions.filter((t) => t.account === 'pay');
  assert.equal(pay.length, 4);
  assert.equal(pay[3].tiers, 'Account subscription');
  assert.equal(pay[3].import_v, v, 'même relevé tant qu’il n’est pas validé');
  const imp = rest.db.ls_imports.find((i) => i.v === v);
  assert.equal(imp.stmt.closing, 1209.88);
  assert.equal(imp.meta, '4 transaction(s) — en attente de validation');
  // compte vide : les 89 derniers jours ; ensuite la dernière synchro moins 5 jours
  assert.deepEqual(state.calls.filter((c) => c[0] === 'tx' && c[1] === 'u-pay').map((c) => c[2]), ['2026-07-29', '2026-10-21']);
});

test('les lignes déjà importées par relevé PDF/CSV ne reviennent pas ; un même montant manquant, si', async () => {
  const csv = (d, amount, tiers) => ({ id: `csv-${d}-${tiers}`, tx_date: d, amount, tiers, account: 'pay', draft: false, deleted_at: null, bank_ref: null, import_v: 3 });
  const { rest, sync } = setup({
    ls_settings: [settings],
    ls_bank_links: [request({ status: 'code_received', code: 'good-code' })],
    // relevé de septembre déjà validé, qui s'arrête au 30/09 : le versement d'Alex y est daté du
    // 30/09 (la banque le comptabilise le 01/10) ; celui de Sam, du même montant, n'y est pas
    ls_transactions: [csv('2026-09-30', 150, 'Transfer from Alex')],
    ls_imports: [{ id: 'imp3', v: 3, pending: false, cur: true, stmt: { acct: 'pay' } }],
  });
  await sync.tick();
  const synced = rest.db.ls_transactions.filter((t) => t.account === 'pay' && t.bank_ref);
  assert.deepEqual(synced.map((t) => t.tiers), ['Sam Bernard', 'ENGIE'], 'seul ce qui manque au relevé arrive');
  const imp = rest.db.ls_imports.find((i) => i.stmt.source === 'bank' && i.stmt.acct === 'pay');
  assert.equal(imp.v, 4, 'numéro suivant le dernier relevé');
  assert.equal(imp.stmt.opening, null, 'le compte a déjà des lignes : pas d’ouverture déduite');
  assert.equal(rest.db.ls_bank_links[0].last_sync.matched, 1);
});

test('un relevé validé est clos : la synchro suivante en ouvre un nouveau', async () => {
  const { rest, state, sync, at } = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  await sync.tick();
  const first = rest.db.ls_imports.find((i) => i.stmt.acct === 'pay');
  first.pending = false; first.cur = true;
  rest.db.ls_transactions.filter((t) => t.import_v === first.v).forEach((t) => { t.draft = false; });
  state.tx['u-pay'].push(bankTx('2026-10-28', '150.00', 'CRDT', 'Lou Petit', 'Provision', 'P5'));
  at(NOW + 9 * 3600e3);
  await sync.tick();
  const second = rest.db.ls_imports.filter((i) => i.stmt.acct === 'pay').find((i) => i.pending);
  assert.ok(second && second.v > Math.max(...rest.db.ls_imports.map((i) => i.v).filter((v) => v !== second.v)));
  assert.deepEqual(rest.db.ls_transactions.filter((t) => t.import_v === second.v).map((t) => t.tiers), ['Lou Petit']);
});

test('un relevé synchronisé puis écarté ne revient pas', async () => {
  const { rest, state, sync, at } = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  state.tx['u-pay'].push(bankTx('2026-10-24', '20.00', 'DBIT', 'Minimax', 'Entretien', 'P6'));   // dans le recouvrement
  await sync.tick();
  const v = rest.db.ls_imports.find((i) => i.stmt.acct === 'pay').v;
  assert.equal(rest.db.ls_transactions.filter((t) => t.import_v === v).length, 4);
  // « Écarter » dans l'app : les brouillons et la fiche sont supprimés pour de bon
  rest.db.ls_transactions = rest.db.ls_transactions.filter((t) => t.import_v !== v);
  rest.db.ls_imports = rest.db.ls_imports.filter((i) => i.v !== v);
  rest.db.ls_bank_links[0].sync_requested_at = new Date(NOW + 60e3).toISOString();
  at(NOW + 120e3);
  const calls = state.calls.length;
  await sync.tick();
  assert.ok(state.calls.slice(calls).some((c) => c[0] === 'tx' && c[1] === 'u-pay' && c[2] === '2026-10-21'), 'P6 redemandé à la banque');
  assert.equal(rest.db.ls_transactions.filter((t) => t.account === 'pay').length, 0, '… mais pas réimporté');
});

test('banque inconnue, demande trop vieille, adresse de retour douteuse : erreur lisible, pas de boucle', async () => {
  const { rest, sync } = setup({
    ls_bank_links: [
      request({ id: 'A', aspsp_name: 'Swann Bank' }),
      request({ id: 'B', created_at: new Date(NOW - 20 * 60e3).toISOString() }),
      request({ id: 'C', redirect_url: 'http://evil.example/' }),
    ],
  });
  await sync.tick();
  const [a, b, c] = rest.db.ls_bank_links;
  assert.equal(a.status, 'error');
  assert.match(a.error, /« Swann Bank » n’est pas proposée par Enable Banking pour ce pays \(FR\)\. Noms proches : Swan\./);
  assert.equal(b.status, 'error');
  assert.match(b.error, /abandonnée/);
  assert.equal(c.status, 'error');
  assert.match(c.error, /retour refusée/);
  assert.deepEqual(await sync.tick(), [], 'plus rien à faire');
});

test('code refusé par la banque → erreur ; consentement échu → expiré ; déconnexion → session supprimée', async () => {
  const { rest, state, sync } = setup({
    ls_bank_links: [
      request({ id: 'A', status: 'code_received', code: 'bad', updated_at: new Date(NOW).toISOString() }),
      request({ id: 'B', status: 'active', session_id: 'sess-old', valid_until: new Date(NOW - 1000).toISOString() }),
      request({ id: 'C', status: 'revoke_requested', session_id: 'sess-c' }),
    ],
  });
  await sync.tick();
  const [a, b, c] = rest.db.ls_bank_links;
  assert.equal(a.status, 'error');
  assert.match(a.error, /WRONG_CODE|422/);
  assert.equal(b.status, 'expired');
  assert.equal(c.status, 'revoked');
  assert.ok(state.calls.some((x) => x[0] === 'delete' && x[1] === 'sess-c'));
});

test('session révoquée côté banque pendant une synchro → connexion marquée, pas de nouvel essai en boucle', async () => {
  const { rest, state, sync } = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  state.failTx = new EnableBankingError('GET /accounts/u-pay/transactions', 401, '{"error":"UNAUTHORIZED_ACCESS"}');
  state.sessionStatus = 'REVOKED';
  await sync.tick();
  const l = rest.db.ls_bank_links[0];
  assert.equal(l.status, 'revoked');
  assert.match(l.error, /REVOKED/);

  // erreur passagère (banque indisponible) : on note l'erreur et l'heure, on réessaiera à l'échéance
  const two = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  two.state.failTx = new EnableBankingError('GET /accounts/u-pay/transactions', 503, '{"error":"ASPSP_ERROR"}');
  await two.sync.tick();
  const l2 = two.rest.db.ls_bank_links[0];
  assert.equal(l2.status, 'active');
  assert.match(l2.error, /503/);
  assert.ok(l2.last_sync_at);
  assert.equal(l2.last_ok_at, undefined);
  assert.deepEqual(await two.sync.tick(), [{ id: 'L1', status: 'idle' }]);
});

test('reconnexion : l’ancienne connexion est remplacée et la synchro reprend où elle s’était arrêtée', async () => {
  const { rest, state, sync } = setup({
    ls_settings: [settings],
    ls_bank_links: [
      request({ id: 'OLD', status: 'active', session_id: 'sess-old', valid_until: '2026-11-01T00:00:00Z', last_sync_at: new Date(NOW - 3600e3).toISOString(),
        accounts: [{ uid: 'old-pay', hash: 'h-pay', iban: IBAN_PAY, acct: 'pay', synced_to: '2026-10-20' }], acct_map: { 'h-res': 'skip' },
        seen: { 'pay:P1': '2026-10-01', 'pay:P2': '2026-10-01' }, created_at: new Date(NOW - 90 * 86400e3).toISOString() }),
      request({ id: 'NEW', status: 'code_received', code: 'good-code', updated_at: new Date(NOW).toISOString() }),
    ],
  });
  await sync.tick();
  const [old, neu] = rest.db.ls_bank_links;
  assert.equal(old.status, 'replaced');
  assert.ok(state.calls.some((x) => x[0] === 'delete' && x[1] === 'sess-old'));
  assert.equal(neu.status, 'active');
  assert.deepEqual(neu.acct_map, { 'h-res': 'skip' }, 'le choix de compte fait dans l’app est repris');
  assert.deepEqual(state.calls.filter((c) => c[0] === 'tx').map((c) => [c[1], c[2]]), [['u-pay', '2026-10-15']], 'reprise au 20/10 − 5 j ; réserve ignorée');
  assert.deepEqual(rest.db.ls_transactions.map((t) => t.tiers), [], 'P1/P2 déjà vus, P3 (09/10) avant la fenêtre');
});

test('un mouvement d’un exercice clôturé n’est pas importé (il bloquerait la validation du relevé) : avertissement', async () => {
  const { rest, sync } = setup({
    ls_settings: [settings],
    ls_bank_links: [request({ status: 'code_received', code: 'good-code' })],
    ls_periods: [{ year: 2026, starts: '2026-01-01', ends: '2026-10-05', closed_at: '2026-10-06T08:00:00Z' }, { year: 2027, starts: '2027-01-01', ends: '2027-12-31', closed_at: null }],
  });
  await sync.tick();
  const pay = rest.db.ls_transactions.filter((t) => t.account === 'pay');
  assert.deepEqual(pay.map((t) => t.tiers), ['ENGIE'], 'les versements du 01/10 (exercice clôturé) sont écartés');
  const l = rest.db.ls_bank_links[0];
  assert.ok(l.last_sync.warnings.some((w) => /compte de paiement : 2 mouvement\(s\) daté\(s\) d’un exercice clôturé/.test(w)));
  assert.ok(l.last_sync.warnings.some((w) => /compte de réserve : 1 mouvement/.test(w)), 'la réserve (05/10) aussi');
  // sans table ls_periods (base pas encore migrée), rien n'est écarté
  const two = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  await two.sync.tick();
  assert.equal(two.rest.db.ls_transactions.length, 4);
});

test('historique : une ligne par synchro, avec sa cause — connexion, planifiée, bouton, outil, échec', async () => {
  const { rest, state, sync, at } = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  await sync.tick();
  const h = () => rest.db.ls_bank_syncs;
  assert.equal(h().length, 1);
  assert.deepEqual(
    { cause: h()[0].cause, ok: h()[0].ok, pay: h()[0].added_pay, res: h()[0].added_res, link: h()[0].link_id, balances: h()[0].balances, error: h()[0].error },
    { cause: 'connect', ok: true, pay: 3, res: 1, link: 'L1', balances: { pay: 1215.88, res: 871.14 }, error: null });

  await sync.tick();
  assert.equal(h().length, 1, 'pas due : aucune ligne');

  const l = rest.db.ls_bank_links[0];
  l.sync_requested_at = new Date(NOW + 60e3).toISOString();
  at(NOW + 120e3);
  await sync.tick();
  assert.equal(h()[1].cause, 'manual');
  assert.equal(h()[1].added_pay + h()[1].added_res, 0);
  assert.equal(h()[1].ok, true, 'rien de nouveau, mais la synchro est notée');
  assert.deepEqual(h()[1].balances, { pay: 1215.88, res: 871.14 });

  at(NOW + 9 * 3600e3);
  await sync.tick();
  assert.equal(h()[2].cause, 'auto');

  await sync.tick({ force: true });
  assert.equal(h()[3].cause, 'cli');

  state.failTx = new EnableBankingError('GET /accounts/u-pay/transactions', 503, '{"error":"ASPSP_ERROR"}');
  at(NOW + 18 * 3600e3);
  await sync.tick();
  assert.equal(h()[4].ok, false);
  assert.match(h()[4].error, /503/);

  // sans la table (SQL pas encore lancé), la synchro se fait quand même
  const two = setup({ ls_settings: [settings], ls_bank_links: [request({ status: 'code_received', code: 'good-code' })] });
  delete two.rest.db.ls_bank_syncs;
  await two.sync.tick();
  assert.equal(two.rest.db.ls_bank_links[0].status, 'active');
  assert.equal(two.rest.db.ls_transactions.length, 4);
});
