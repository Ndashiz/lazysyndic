// Tests de recon.js (rapprochement bancaire). Lancer : node --test tests/recon.test.mjs — aucune dépendance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../recon.js');

const tx = [
  { id:'a', iso:'2026-03-02', amount:-80,     tiers:'Engie',   date:'02/03/26' },
  { id:'b', iso:'2026-03-17', amount:-306.77, tiers:'Vivaqua', date:'17/03/26' },
  { id:'c', iso:'2026-04-01', amount:79.39,   tiers:'Alex Martin', date:'01/04/26' },
  { id:'d', iso:'2026-05-12', amount:-88.4,   tiers:'Engie',   date:'12/05/26' },   // plus récent que le relevé
];

test('réconcilié à la date du relevé : un mouvement plus récent n’est pas un écart', () => {
  const r = R.reconcile({ closing:692.62, asOfIso:'2026-04-30', balanceAtAsOf:692.62, tx });
  assert.equal(r.ok, true); assert.equal(r.diff, 0);
  assert.equal(r.afterCount, 1); assert.equal(r.afterTotal, -88.4);
  assert.deepEqual(r.candidates, []);
});

test('écart : une ligne en trop du montant exact, un doublon, un brouillon ou une corbeille du montant manquant', () => {
  // en trop : le solde calculé dépasse la clôture de −306,77 → la ligne Vivaqua est candidate
  let r = R.reconcile({ closing:999.39, asOfIso:'2026-04-30', balanceAtAsOf:692.62, tx });
  assert.equal(r.diff, -306.77);
  assert.deepEqual(r.candidates.map(c => [c.kind, c.t.id]), [['extra', 'b']]);
  // doublon : Vivaqua deux fois le même jour → la seconde est « dup », pas « extra »
  const dup = [...tx, { id:'b2', iso:'2026-03-17', amount:-306.77, tiers:'VIVAQUA', date:'17/03/26' }];
  r = R.reconcile({ closing:692.62, asOfIso:'2026-04-30', balanceAtAsOf:385.85, tx:dup });
  assert.deepEqual(r.candidates.map(c => [c.kind, c.t.id]), [['dup', 'b2']]);
  assert.equal(r.candidates[0].twin.id, 'b');
  // manquante : +79,39 attendu, une ligne du même montant attend sa validation, une autre est à la corbeille
  r = R.reconcile({ closing:692.62, asOfIso:'2026-04-30', balanceAtAsOf:613.23, tx:tx.filter(t => t.id !== 'c'),
    drafts:[{ id:'x', iso:'2026-04-01', amount:79.39, tiers:'Alex Martin' }], trash:[{ id:'y', iso:'2026-04-01', amount:79.39, tiers:'Alex Martin' }] });
  assert.equal(r.diff, -79.39);
  assert.deepEqual(r.candidates.map(c => c.kind), ['draft', 'trash']);
  // un brouillon plus récent que le relevé ne peut pas expliquer l'écart
  r = R.reconcile({ closing:692.62, asOfIso:'2026-04-30', balanceAtAsOf:613.23, tx:tx.filter(t => t.id !== 'c'), drafts:[{ id:'x', iso:'2026-05-01', amount:79.39 }] });
  assert.deepEqual(r.candidates, []);
});

test('écart : le solde d’ouverture du compte qui s’écarte de l’ouverture du premier relevé', () => {
  const r = R.reconcile({ closing:1000, asOfIso:'2026-04-30', balanceAtAsOf:1050, tx:[], opening:1358.7, firstOpening:1308.7 });
  assert.equal(r.diff, 50);
  assert.deepEqual(r.candidates, [{ kind:'opening', opening:1358.7, firstOpening:1308.7 }]);
});

test('chaîne des relevés : chacun s’ouvre là où le précédent s’est fermé, sinon il en manque un', () => {
  const sts = [
    { v:3, opening:900,  closing:950,  asOfIso:'2026-06-30' },
    { v:1, opening:1000, closing:1100, asOfIso:'2026-03-31' },
    { v:2, opening:1100, closing:1050, asOfIso:'2026-04-30' },
    { v:4, opening:null, closing:null, asOfIso:'2026-07-31' },   // sans clôture : ignoré
  ];
  const c = R.chain(sts);
  assert.deepEqual(c.statements.map(s => s.v), [1, 2, 3]);
  assert.equal(c.gaps.length, 1);
  assert.deepEqual([c.gaps[0].prev.v, c.gaps[0].next.v, c.gaps[0].diff], [2, 3, -150]);
  assert.deepEqual(R.chain([]).gaps, []);
});
