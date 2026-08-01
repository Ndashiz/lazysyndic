// Run: node --test  (from bridge/)  — no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, detectOwner, ownerLedger, buildAlerts, coproStatus } from './alerts.js';

const owners = [
  { id: 'o-alex', short: 'Alex', name: 'Alex Martin', due_pay: 900, due_res: 100 }, // due 1000
  { id: 'o-sam', short: 'Sam', name: 'Sam Bernard', due_pay: 500, due_res: 0 },      // due 500
];

test('norm lowercases and collapses whitespace', () => {
  assert.equal(norm('  Alex   MARTIN '), 'alex martin');
});

test('detectOwner: explicit rule > name match > none', () => {
  assert.equal(detectOwner({ tiers: 'Versement Alex Martin' }, owners), 'Alex');
  assert.equal(detectOwner({ tiers: 'SAM' }, owners), 'Sam');
  assert.equal(detectOwner({ tiers: 'Inconnu SPRL' }, owners), '');
  // learned owner rule (pre-normalized label) wins
  assert.equal(detectOwner({ tiers: 'loyer parking b12' }, owners, { 'parking b12': 'Sam' }), 'Sam');
});

test('ownerLedger: verse from explicit owner + heuristic, solde = verse - due', () => {
  const tx = [
    { amount: 600, owner: 'Alex' },                 // explicit
    { amount: 300, tiers: 'Alex Martin' },          // heuristic → Alex
    { amount: 500, owner: 'Sam' },                  // Sam fully paid
    { amount: -50, owner: 'Alex' },                 // outflow ignored
    { amount: 200, owner: 'Alex', deleted_at: '2026-01-01' }, // soft-deleted ignored
  ];
  const led = ownerLedger(owners, tx);
  const alex = led.find((o) => o.short === 'Alex');
  const sam = led.find((o) => o.short === 'Sam');
  assert.equal(alex.verse, 900);            // 600 + 300
  assert.equal(alex.solde, -100);           // 900 - 1000
  assert.equal(sam.solde, 0);               // 500 - 500
});

test('buildAlerts: one overdue_payment per late owner, correct amountCents', () => {
  const tx = [{ amount: 900, owner: 'Alex' }, { amount: 500, owner: 'Sam' }];
  const alerts = buildAlerts({ owners, transactions: tx });
  const pay = alerts.filter((a) => a.kind === 'overdue_payment');
  assert.equal(pay.length, 1);              // only Alex is short 100
  assert.equal(pay[0].id, 'pay-o-alex');    // stable id
  assert.equal(pay[0].amountCents, 10000);  // 100.00 €
});

test('buildAlerts: open reminders → notice, done ones skipped', () => {
  const alerts = buildAlerts({
    owners: [], transactions: [],
    reminders: [
      { id: 'r1', tx: 'Relancer assurance', due: '2026-07-30', done: false },
      { id: 'r2', tx: 'Déjà fait', done: true },
    ],
  });
  const notices = alerts.filter((a) => a.kind === 'notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, 'rem-r1');
  assert.equal(notices[0].dueDate, '2026-07-30');
});

test('buildAlerts: recent manual timeline → document, old/non-manual skipped', () => {
  const now = new Date('2026-07-10T00:00:00Z');
  const alerts = buildAlerts({
    owners: [], transactions: [],
    timeline: [
      { id: 't1', date: '2026-07-01', title: 'PV AG 2026', description: 'Déposé', kind: 'manual' },
      { id: 't2', date: '2026-01-01', title: 'Vieux', kind: 'manual' },      // outside 60d window
      { id: 't3', date: '2026-07-05', title: 'Import CSV', kind: 'import' },  // non-manual
    ],
  }, { now, documentWindowDays: 60 });
  const docs = alerts.filter((a) => a.kind === 'document');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, 'tl-t1');
  assert.equal(docs[0].dueDate, '2026-07-01');
});

// « Le mapping est fini » n'a de définition que côté LazySyndic : une ligne importée arrive à
// high='?' et n'en sort que quand on l'a catégorisée. Jarvis lit ce compteur, il ne le devine pas.
test('coproStatus: compte les lignes restées à catégoriser', () => {
  const rows = [
    { tx_date: '2026-07-02', high: 'Énergie', created_at: '2026-07-10T08:00:00Z' },
    { tx_date: '2026-07-05', high: '?', created_at: '2026-07-10T08:00:00Z' },
    { tx_date: '2026-06-28', high: '', created_at: '2026-07-01T08:00:00Z' },
    { tx_date: '2026-07-06', created_at: '2026-07-12T09:00:00Z' }, // high absent = pas mappée
  ];
  const s = coproStatus(rows);
  assert.equal(s.total, 4);
  assert.equal(s.unmapped, 3);
  assert.equal(s.oldestUnmappedDate, '2026-06-28');
  assert.equal(s.lastImportAt, '2026-07-12T09:00:00Z');
});

// Un relevé Swan n'a pas de colonne « tiers » : mapCols() y recopie la description, donc les
// deux champs portent le libellé de la banque et le nom du fournisseur n'existe nulle part.
// C'est la catégorie posée au mapping qui dit ce qui a été payé.
test('coproStatus: liste les catégories réellement payées récemment', () => {
  const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const s = coproStatus([
    { tx_date: recent, high: 'Énergie', sub: 'Électricité', tiers: 'SEPA Credit Transfer', note: 'SEPA Credit Transfer', amount: -88.4 },
    { tx_date: recent, high: 'Énergie', sub: 'Eau', tiers: '+++810/7734/58662+++', amount: -306.77 },
    { tx_date: recent, high: 'Énergie', sub: 'Électricité', tiers: 'autre ligne', amount: -12 }, // doublon de catégorie
    { tx_date: recent, high: 'Charges', sub: '', tiers: 'Alex Martin', amount: +79.39 },         // entrée, pas payée
    { tx_date: old, high: 'Énergie', sub: 'Gaz', tiers: 'Luminus', amount: -50 },                // hors fenêtre
  ]);
  assert.deepEqual(s.paidCategories, [
    { high: 'Énergie', sub: 'Électricité' },
    { high: 'Énergie', sub: 'Eau' },
  ]);
  // Le texte brut reste exposé pour diagnostiquer, même quand il ne dit rien d'utile.
  assert.ok(s.paidRecently.some((t) => t.includes('SEPA Credit Transfer')));
});

test('coproStatus: une ligne non catégorisée ne prouve aucun paiement', () => {
  const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const s = coproStatus([{ tx_date: recent, high: '?', tiers: 'Virement', amount: -100 }]);
  assert.deepEqual(s.paidCategories, []);
});

test('coproStatus: rien à faire quand tout est catégorisé', () => {
  const s = coproStatus([{ tx_date: '2026-07-02', high: 'Charges', created_at: '2026-07-10T08:00:00Z' }]);
  assert.equal(s.unmapped, 0);
  assert.equal(s.oldestUnmappedDate, null);
});

// Un versement encore en brouillon n'est pas de l'argent reçu : il ne doit pas éteindre l'alerte
// d'impayé, sinon un import que le syndic écarte ensuite aura fait disparaître la relance.
test('ownerLedger: un versement en brouillon ne solde aucun impayé', () => {
  const owners = [{ short: 'Lou', name: 'Lou Petit', due_pay: 1000, due_res: 0 }];
  const draft = [{ tx_date: '2026-07-05', tiers: 'Lou Petit', amount: 1000, owner: 'Lou', draft: true }];
  const [pending] = ownerLedger(owners, draft, {});
  assert.equal(pending.verse, 0);
  assert.equal(pending.solde, -1000);

  // La même ligne, une fois validée, solde bien la dette.
  const [settled] = ownerLedger(owners, [{ ...draft[0], draft: false }], {});
  assert.equal(settled.verse, 1000);
  assert.equal(settled.solde, 0);
});

// Un relevé importé attend sa validation avant d'entrer dans les comptes. Jarvis ne lit qu'un
// compteur pour fermer son étape : il doit donc voir ces lignes-là comme du travail restant,
// même quand elles sont déjà catégorisées.
test('coproStatus: un relevé en brouillon reste du travail, même catégorisé', () => {
  const s = coproStatus([
    { tx_date: '2026-07-02', high: 'Énergie', created_at: '2026-07-10T08:00:00Z' },              // validée
    { tx_date: '2026-07-05', high: 'Charges', draft: true, created_at: '2026-08-01T08:00:00Z' }, // catégorisée, pas validée
    { tx_date: '2026-07-06', high: '?', draft: true, created_at: '2026-08-01T08:00:00Z' },       // ni l'un ni l'autre
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.unmapped, 2);
  assert.equal(s.pendingValidation, 2);
  assert.equal(s.oldestUnmappedDate, '2026-07-05');
});

test('coproStatus: un brouillon ne prouve aucun paiement', () => {
  const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const s = coproStatus([
    { tx_date: recent, high: 'Énergie', sub: 'Électricité', tiers: 'Luminus', amount: -88.4, draft: true },
  ]);
  // La ligne existe, mais elle n'est pas dans les comptes : cocher « électricité payée » ici
  // ferait sauter l'étape sur la foi d'un simple import.
  assert.deepEqual(s.paidCategories, []);
});

test('coproStatus: tolère une table vide ou une réponse inattendue', () => {
  for (const input of [[], null, undefined]) {
    const s = coproStatus(input);
    assert.equal(s.total, 0);
    assert.equal(s.unmapped, 0);
    assert.equal(s.lastImportAt, null);
  }
});
