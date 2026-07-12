// Run: node --test  (from bridge/)  — no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, detectOwner, ownerLedger, buildAlerts } from './alerts.js';

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
