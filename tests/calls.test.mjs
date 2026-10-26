// Tests de calls.js (appels de fonds). Lancer : node --test tests/calls.test.mjs — aucune dépendance.
// Données FICTIVES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const K = createRequire(import.meta.url)('../calls.js');

test('communication structurée : contrôle mod 97, 0 → 97, format, lecture dans un libellé', () => {
  assert.equal(K.ogmFromDigits('1234567890'), '123456789002');        // 1234567890 mod 97 = 2
  assert.equal(K.ogmFromDigits('0000000097'), '000000009797');        // reste 0 → 97
  assert.equal(K.ogmFormat('123456789002'), '+++123/4567/89002+++');
  assert.equal(K.ogmValid('+++123/4567/89002+++'), true);
  assert.equal(K.ogmValid('+++123/4567/89003+++'), false);
  assert.equal(K.ogmIn('VIREMENT SEPA +++123/4567/89002+++ CHARGES'), '123456789002');
  assert.equal(K.ogmIn('***123/4567/89002*** provision'), '123456789002');
  assert.equal(K.ogmIn('123/4567/89002'), '123456789002');            // sans les +++
  assert.equal(K.ogmIn('+++123/4567/89003+++'), '');                  // contrôle faux : ignoré
  assert.equal(K.ogmIn('Facture 2024/0012'), '');
});

test('communication structurée : stable pour une graine et un rang, différente entre copropriétaires', () => {
  const a = K.ogmFromSeed('3b1f7f3a-1111-4e4e-9b9b-000000000001', 1), b = K.ogmFromSeed('3b1f7f3a-1111-4e4e-9b9b-000000000002', 2);
  assert.equal(a, K.ogmFromSeed('3b1f7f3a-1111-4e4e-9b9b-000000000001', 1));
  assert.equal(a.length, 12); assert.ok(K.ogmValid(a)); assert.ok(K.ogmValid(b));
  assert.equal(a.slice(0, 3), '001'); assert.equal(b.slice(0, 3), '002');
  assert.notEqual(a, b);
});

test('échéancier : au centime, le reste sur les premières, dû le 1er du mois qui ouvre la période', () => {
  const m = K.schedule(973.92, 'month', 2026);
  assert.equal(m.length, 12);
  assert.equal(Math.round(m.reduce((s, e) => s + e.amount, 0) * 100) / 100, 973.92);
  assert.equal(m[0].due, '2026-01-01'); assert.equal(m[11].due, '2026-12-01');
  const q = K.schedule(100, 'quarter', 2026);
  assert.deepEqual(q.map(e => e.month), [1, 4, 7, 10]);
  assert.deepEqual(q.map(e => e.amount), [25, 25, 25, 25]);
  const odd = K.schedule(100.01, 'quarter', 2026);                     // 10001 centimes : 2501, 2500, 2500, 2500
  assert.deepEqual(odd.map(e => e.amount), [25.01, 25, 25, 25]);
  assert.deepEqual(K.schedule(500, 'year', 2026), [{ n:1, month:1, due:'2026-01-01', amount:500 }]);
  assert.equal(K.expectedInMonth(1200, 'quarter', 2026, 4), 300);
  assert.equal(K.expectedInMonth(1200, 'quarter', 2026, 5), 0);
  assert.equal(K.expectedInMonth(1200, 'month', 2026, 5), 100);
  assert.equal(K.cleanPeriodicity('n’importe quoi'), 'month');
});

test('modèle : charges + réserve par échéance, somme exacte, communication et IBAN', () => {
  const o = { name:'Alex Martin', short:'Alex', q:500, email:'alex@exemple.be', ogm:'123456789002', periodicity:'quarter' };
  const m = K.callModel(o, { pay:952.63, res:240 }, { year:2026, qTot:1000, copro:{ name:'ACP Démo' }, iban:'BE68539007547034', syndic:{ name:'Sam Bernard' }, issuedAt:'2026-01-05' });
  assert.equal(m.total, 1192.63);
  assert.equal(m.rows.length, 4);
  assert.equal(Math.round(m.rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, 1192.63);
  assert.equal(Math.round(m.rows.reduce((s, r) => s + r.pay, 0) * 100) / 100, 952.63);
  assert.equal(Math.round(m.rows.reduce((s, r) => s + r.res, 0) * 100) / 100, 240);
  assert.equal(m.ogm, '+++123/4567/89002+++');
  assert.equal(m.periodLabel, 'trimestriel');
  assert.equal(K.subject(m), 'Appel de fonds 2026 · ACP Démo');
  assert.match(K.text(m), /\+\+\+123\/4567\/89002\+\+\+/);
  assert.match(K.html(m), /BE68 5390 0754 7034/);
  assert.equal(K.fileName(m, 'eml'), 'appel-de-fonds-2026-Alex.eml');
  // sans communication valide : pas de ligne fausse
  assert.equal(K.callModel({ ...o, ogm:'' }, { pay:1, res:0 }, { year:2026 }).ogm, '');
});
