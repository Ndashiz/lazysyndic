// Run: node --test  (from bridge/)  — no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceCents, expenseBreakdown, reminderBoard, buildDashboard } from './dashboard.js';

const owners = [
  { id: 'o-alex', short: 'Alex', name: 'Alex Martin', quotite: 500, color: '#2F6B53', due_pay: 900, due_res: 100 },
  { id: 'o-lou', short: 'Lou', name: 'Lou Petit', quotite: 249, color: '#C9854A', due_pay: 499, due_res: 0 },
];

const settings = { opening_pay: 100, opening_res: 50, reserve_target: 2000, copro_name: 'ACP Test' };

test('balanceCents: opening + movements of that account only', () => {
  const tx = [
    { account: 'pay', amount: 25.5 },
    { account: 'pay', amount: -10.25 },
    { account: 'res', amount: 200 },
  ];
  assert.equal(balanceCents(tx, 'pay', { pay: 100, res: 50 }), 11525);
  assert.equal(balanceCents(tx, 'res', { pay: 100, res: 50 }), 25000);
});

test('balanceCents: drafts and deleted rows never move a balance', () => {
  const tx = [
    { account: 'pay', amount: 100 },
    { account: 'pay', amount: 500, draft: true },
    { account: 'pay', amount: 900, deleted_at: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(balanceCents(tx, 'pay', { pay: 0 }), 10000);
});

test('expenseBreakdown: outflows by category, sorted, percentages', () => {
  const tx = [
    { account: 'pay', amount: -60, high: 'Énergie' },
    { account: 'pay', amount: -30, high: 'Assurance' },
    { account: 'pay', amount: -10, high: 'Énergie' },
    { account: 'pay', amount: 500, high: 'Charges' }, // an inflow is not an expense
    { account: 'res', amount: -400, high: 'Entretien' }, // other account
  ];
  const { totalCents, categories } = expenseBreakdown(tx, 'pay');
  assert.equal(totalCents, 10000);
  assert.deepEqual(
    categories.map((c) => [c.high, c.amountCents, c.pct]),
    [
      ['Énergie', 7000, 70],
      ['Assurance', 3000, 30],
    ],
  );
  assert.equal(categories[0].color, '#2F6B53');
});

test('expenseBreakdown: uncategorised lines are shown, not hidden', () => {
  const tx = [
    { account: 'pay', amount: -50, high: 'Énergie' },
    { account: 'pay', amount: -50, high: '?' },
    { account: 'pay', amount: -100 },
  ];
  const { categories } = expenseBreakdown(tx, 'pay');
  const todo = categories.find((c) => c.high === 'À catégoriser');
  assert.equal(todo.amountCents, 15000, 'both the "?" line and the blank one land in the bucket');
  assert.equal(todo.pct, 75);
});

test('reminderBoard: open ones first by due date, undated last', () => {
  const board = reminderBoard([
    { id: '1', tx: 'Relancer Lou', due: '2026-09-01', done: false },
    { id: '2', tx: 'Classer les PV', done: false },
    { id: '3', tx: 'Payer Engie', due: '2026-08-10', done: false },
    { id: '4', tx: 'Déjà fait', done: true },
  ]);
  assert.deepEqual(board.open.map((r) => r.text), ['Payer Engie', 'Relancer Lou', 'Classer les PV']);
  assert.equal(board.openCount, 3);
  assert.equal(board.doneCount, 1);
  assert.equal(board.open[2].due, undefined, 'an undated reminder carries no due field');
});

test('buildDashboard: reserve gauge mirrors the app banner', () => {
  const d = buildDashboard({ owners, transactions: [{ account: 'res', amount: 450 }], settings });
  assert.equal(d.reserve.currentCents, 50000); // opening 50 + 450
  assert.equal(d.reserve.targetCents, 200000);
  assert.equal(d.reserve.remainingCents, 150000);
  assert.equal(d.reserve.pct, 25);
  assert.equal(d.coproName, 'ACP Test');
});

test('buildDashboard: reserve above target caps the gauge at 100 %', () => {
  const d = buildDashboard({ transactions: [{ account: 'res', amount: 5000 }], settings });
  assert.equal(d.reserve.pct, 100);
  assert.equal(d.reserve.remainingCents, 0);
});

test('buildDashboard: reserve with no target set does not divide by zero', () => {
  const d = buildDashboard({ transactions: [{ account: 'res', amount: 100 }], settings: { reserve_target: 0 } });
  assert.equal(d.reserve.pct, 0);
});

// Le « maintenant » des tests : sans lui, le tableau dépendrait du jour où ils tournent.
const now = new Date('2026-11-22');

test('buildDashboard: who pays what, and receivables = sum of debtor balances', () => {
  // Alex owes 1000 and paid 1000; Lou owes 499 and paid 345 → 154 outstanding.
  const transactions = [
    { account: 'pay', amount: 1000, owner: 'Alex', tx_date: '2026-03-01' },
    { account: 'pay', amount: 345, owner: 'Lou', tx_date: '2026-04-01' },
  ];
  const d = buildDashboard({ owners, transactions, settings }, { now });
  const [alex, lou] = d.owners;
  assert.deepEqual(
    [alex.year, alex.dueCents, alex.paidCents, alex.balanceCents, alex.overdueCents, alex.late],
    [2026, 100000, 100000, 0, 0, false],
  );
  assert.deepEqual([lou.dueCents, lou.paidCents, lou.balanceCents, lou.late], [49900, 34500, -15400, true]);
  // Dix échéances échues au 22 novembre : 4 × 41,59 + 6 × 41,58 = 415,84 attendus, 345 versés.
  assert.deepEqual([lou.expectedCents, lou.overdueCents], [41584, 7084]);
  assert.equal(d.balances.receivableCents, 15400);
  assert.equal(d.lastMovementDate, '2026-04-01');
});

// Même règle que l'accueil de l'app : le solde dit ce qui reste à verser d'ici la fin de
// l'exercice, « late » ne s'allume que pour des échéances échues.
test('buildDashboard: a negative balance mid-year is not late while instalments are paid', () => {
  const transactions = [{ account: 'pay', amount: 500, owner: 'Alex', tx_date: '2026-02-01' }];
  const d = buildDashboard({ owners: [owners[0]], transactions, settings }, { now: new Date('2026-06-15') });
  const [alex] = d.owners;
  assert.deepEqual([alex.balanceCents, alex.expectedCents, alex.overdueCents, alex.late], [-50000, 41669, 0, false]);
  assert.equal(d.balances.receivableCents, 50000, 'le reste de l’année reste « à recevoir »');
});

// Budget 2027 appliqué en décembre 2026 : les provisions en vigueur sont celles de 2027, le
// tableau reste sur 2026 avec le dû enregistré pour 2026 (settings.dues_by_year).
test('buildDashboard: the ledger keeps the dues of the current exercise', () => {
  const next = [{ ...owners[0], due_pay: 1500, due_res: 300 }];
  const transactions = [{ account: 'pay', amount: 1000, owner: 'Alex', tx_date: '2026-03-01' }];
  const d = buildDashboard({
    owners: next, transactions,
    settings: { ...settings, charges: { 2027: { applied: { at: '2026-12-01' } } }, dues_by_year: { 2026: { 'o-alex': { pay: 900, res: 100 } } } },
  }, { now: new Date('2026-12-10') });
  assert.deepEqual([d.owners[0].year, d.owners[0].dueCents, d.owners[0].balanceCents, d.owners[0].late], [2026, 100000, 0, false]);
});

test('buildDashboard: learned owner rules attribute a payment, like the app does', () => {
  const transactions = [{ account: 'pay', amount: 499, tiers: 'VIREMENT PARKING B12', tx_date: '2026-05-02' }];
  const plain = buildDashboard({ owners, transactions, settings }, { now });
  assert.equal(plain.balances.receivableCents, 49900 + 100000, 'unattributed: both owners look late');

  const learned = buildDashboard({ owners, transactions, settings, ownerRules: { 'parking b12': 'Lou' } }, { now });
  const lou = learned.owners.find((o) => o.short === 'Lou');
  assert.equal(lou.paidCents, 49900);
  assert.equal(lou.late, false);
});

test('buildDashboard: an empty building still returns a whole shape', () => {
  const d = buildDashboard({});
  assert.equal(d.coproName, 'Ma copropriété');
  assert.equal(d.lastMovementDate, null);
  assert.deepEqual(d.balances, { payCents: 0, resCents: 0, receivableCents: 0, payableCents: 0 });
  assert.deepEqual(d.owners, []);
  assert.deepEqual(d.expenses, { totalCents: 0, categories: [] });
  assert.equal(d.reminders.openCount, 0);
});
