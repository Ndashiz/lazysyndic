// Run: node --test  (from bridge/)  — no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { norm, detectOwner, ownerLedger, expectedToDate, todayIso, buildAlerts, coproStatus, bankAlerts } from './alerts.js';

const owners = [
  { id: 'o-alex', short: 'Alex', name: 'Alex Martin', due_pay: 900, due_res: 100 }, // due 1000
  { id: 'o-sam', short: 'Sam', name: 'Sam Bernard', due_pay: 500, due_res: 0 },      // due 500
];

test('norm lowercases and collapses whitespace', () => {
  assert.equal(norm('  Alex   MARTIN '), 'alex martin');
});

test('detectOwner: an owner name in the label beats a shorter learned rule (app.js OWNER-DETECT)', () => {
  const copro = [{ short: 'Alex', name: 'Alex Martin' }, { short: 'Lou', name: 'Lou Petit' }];
  const rules = { 'fond de reserve': 'Alex' };                       // learned on one of Alex's lines
  assert.equal(detectOwner({ tiers: 'Fond de reserve' }, copro, rules), 'Alex');            // exact label → the rule
  assert.equal(detectOwner({ tiers: 'FOND DE RESERVE - LOU' }, copro, rules), 'Lou');      // Lou's name wins
  assert.equal(detectOwner({ tiers: 'Fond de reserve', note: 'juin' }, copro, rules), 'Alex'); // substring, no name
  assert.equal(detectOwner({ tiers: 'FOND DE RESERVE - LOU' }, copro, { 'fond de reserve - lou': 'Alex' }), 'Alex'); // rule on the whole label
  assert.equal(detectOwner({ tiers: 'Total charges' }, [{ short: 'Al', name: 'Al Petit' }]), '');   // whole words only
  assert.equal(detectOwner({ tiers: 'Fond de reserve' }, copro, { 'fond de reserve': 'Zoé' }), ''); // rule to a vanished owner
});

test('detectOwner: a valid structured communication beats rules and names (app.js step 0)', () => {
  const copro = [{ short: 'Alex', name: 'Alex Martin', ogm: '123456789002' }, { short: 'Lou', name: 'Lou Petit', ogm: '000000009797' }];
  assert.equal(detectOwner({ tiers: 'Virement', note: '+++123/4567/89002+++' }, copro, { virement: 'Lou' }), 'Alex');
  assert.equal(detectOwner({ tiers: 'VIREMENT LOU PETIT +++123/4567/89002+++' }, copro), 'Alex');
  assert.equal(detectOwner({ tiers: 'Virement ***000/0000/09797***' }, copro), 'Lou');
  assert.equal(detectOwner({ tiers: 'Virement', note: '+++123/4567/89003+++' }, copro, { virement: 'Lou' }), 'Lou'); // bad check digits
});

test('detectOwner: explicit rule > name match > none', () => {
  assert.equal(detectOwner({ tiers: 'Versement Alex Martin' }, owners), 'Alex');
  assert.equal(detectOwner({ tiers: 'SAM' }, owners), 'Sam');
  assert.equal(detectOwner({ tiers: 'Inconnu SPRL' }, owners), '');
  // learned owner rule (pre-normalized label) wins
  assert.equal(detectOwner({ tiers: 'loyer parking b12' }, owners, { 'parking b12': 'Sam' }), 'Sam');
});

test('ownerLedger: verse from explicit owner + heuristic, solde = verse - due', () => {
  const now = new Date('2026-06-15');
  const tx = [
    { account: 'pay', amount: 600, owner: 'Alex', tx_date: '2026-01-05' },                 // explicit
    { account: 'res', amount: 300, tiers: 'Alex Martin', tx_date: '2026-02-05' },          // heuristic → Alex
    { account: 'pay', amount: 500, owner: 'Sam', tx_date: '2026-03-05' },                  // Sam fully paid
    { account: 'pay', amount: -50, owner: 'Alex', tx_date: '2026-03-06' },                 // outflow ignored
    { account: 'pay', amount: 200, owner: 'Alex', deleted_at: '2026-01-01', tx_date: '2026-04-01' }, // soft-deleted ignored
    { account: 'ext', amount: 400, owner: 'Alex', tx_date: '2026-04-02' },                 // hors comptes : pas un versement
  ];
  const led = ownerLedger({ owners, transactions: tx }, { now });
  const alex = led.find((o) => o.short === 'Alex');
  const sam = led.find((o) => o.short === 'Sam');
  assert.equal(alex.year, 2026);            // l'année civile en cours
  assert.deepEqual([alex.versePay, alex.verseRes, alex.verse], [600, 300, 900]);
  assert.deepEqual([alex.report, alex.reportKnown], [0, false]);   // dû 2025 inconnu : pas de report
  assert.equal(alex.solde, -100);           // 900 - 1000
  assert.equal(sam.solde, 0);               // 500 - 500
});

// app.js ownerLedger : « en retard » se dit des échéances échues, jamais du solde. En cours
// d'année le solde est négatif pour tout le monde, puisqu'il reste des échéances à venir.
test('ownerLedger: le retard ne compte que les échéances dont le mois est terminé', () => {
  const copro = [
    { id: 'm', short: 'Mia', name: 'Mia Roy', due_pay: 1200, due_res: 0 },                           // 100 par mois
    { id: 'q', short: 'Quentin', name: 'Quentin Noel', due_pay: 1200, due_res: 0, periodicity: 'quarter' },
    { id: 'y', short: 'Yann', name: 'Yann Colin', due_pay: 1200, due_res: 0, periodicity: 'year' },
  ];
  const paid = (short, amount) => ({ account: 'pay', amount, owner: short, tx_date: '2026-02-01' });
  const at = (iso, tx) => Object.fromEntries(ownerLedger({ owners: copro, transactions: tx }, { now: new Date(iso) }).map((o) => [o.short, o]));

  // 15 avril : janvier, février et mars sont échus ; avril est en cours.
  const avril = at('2026-04-15', [paid('Mia', 300), paid('Quentin', 300), paid('Yann', 300)]);
  assert.deepEqual([avril.Mia.expected, avril.Mia.retard, avril.Mia.enRetard, avril.Mia.solde], [300, 0, false, -900]);
  assert.deepEqual([avril.Quentin.expected, avril.Quentin.retard, avril.Quentin.enRetard], [300, 0, false]);   // T1 échu, T2 dû le 1er avril : en cours
  assert.deepEqual([avril.Yann.expected, avril.Yann.retard, avril.Yann.enRetard], [1200, 900, true]);         // l'appel annuel est échu fin janvier

  // 1er mai : la mensualité d'avril et le deuxième trimestre deviennent exigibles.
  const mai = at('2026-05-01', [paid('Mia', 300), paid('Quentin', 300)]);
  assert.deepEqual([mai.Mia.expected, mai.Mia.retard, mai.Mia.enRetard], [400, 100, true]);
  assert.deepEqual([mai.Quentin.expected, mai.Quentin.retard, mai.Quentin.enRetard], [600, 300, true]);

  // Moins d'un euro d'écart (arrondis) n'est pas un retard : même seuil que l'app.
  const juste = at('2026-05-01', [paid('Mia', 399.5)]);
  assert.deepEqual([juste.Mia.retard, juste.Mia.enRetard], [0.5, false]);
});

// calls.js expectedToDate est la référence : le pont en garde une copie, les deux doivent rendre
// le même attendu, au centime, quel que soit le rythme.
test('expectedToDate: identique à calls.js', (t) => {
  const file = fileURLToPath(new URL('../calls.js', import.meta.url));
  if (!existsSync(file)) return t.skip('calls.js absent : pont déployé seul');
  const loaded = createRequire(import.meta.url)(file);
  const K = loaded && loaded.expectedToDate ? loaded : globalThis.LSCalls;
  for (const annual of [0, 0.01, 100, 912.54, 952.63, 1000, 1192.63, 2238.99]) {
    for (const per of ['month', 'quarter', 'year', undefined, 'bizarre']) {
      for (const day of ['2025-12-31', '2026-01-01', '2026-01-31', '2026-02-01', '2026-04-15', '2026-10-01', '2026-12-31', '2027-01-01']) {
        assert.equal(expectedToDate(annual, per, 2026, day), K.expectedToDate(annual, per, 2026, day).expected, `${annual} ${per} ${day}`);
      }
    }
  }
});

// Le pont tourne en UTC, le syndic vit à Bruxelles : c'est son jour qui fait basculer une échéance.
test('todayIso: le jour civil de Bruxelles, pas celui du serveur', () => {
  assert.equal(todayIso(new Date('2026-06-15T10:00:00Z')), '2026-06-15');
  assert.equal(todayIso(new Date('2026-04-30T22:30:00Z')), '2026-05-01');   // 00:30 à Bruxelles (heure d'été)
  assert.equal(todayIso(new Date('2026-12-31T23:30:00Z')), '2027-01-01');   // 00:30 à Bruxelles (heure d'hiver)
  assert.equal(todayIso(new Date('2026-12-31T22:30:00Z')), '2026-12-31');
});

// app.js ownerReport : ce qui précède l'exercice devient un report, tant que le dû des exercices
// précédents est connu. Sans dû connu, les anciens versements ne sont plus une avance.
test('ownerLedger: le versé se borne à l’exercice, le reste devient un report si le dû d’avant est connu', () => {
  const now = new Date('2026-06-15');
  const charges = {
    2025: { applied: { at: '2025-01-02', byOwner: { Alex: { pay: 700, res: 100 }, Sam: { pay: 400, res: 100 } } } },
    2026: { applied: { at: '2026-01-02', byOwner: {} } },
  };
  const tx = [
    { account: 'pay', amount: 800, owner: 'Alex', tx_date: '2025-06-01' },   // 2025, couvert par le dû 2025 (800)
    { account: 'pay', amount: 300, owner: 'Alex', tx_date: '2026-02-01' },   // exercice 2026
    { account: 'pay', amount: 600, owner: 'Sam', tx_date: '2025-06-01' },    // 2025 : 100 de trop
    { account: 'pay', amount: 400, owner: 'Sam', tx_date: '2026-02-01' },
    { account: 'pay', amount: 50, owner: 'Sam' },                            // sans date : dans aucun exercice
  ];
  const led = ownerLedger({ owners, transactions: tx, charges }, { now });
  const alex = led.find((o) => o.short === 'Alex'), sam = led.find((o) => o.short === 'Sam');
  assert.equal(alex.year, 2026);
  assert.deepEqual([alex.verse, alex.report, alex.reportKnown, alex.solde], [300, 0, true, -700]);
  // 5 échéances échues au 15 juin : 5 × 75 + (4 × 8,34 + 8,33) = 416,69 attendus, 300 versés.
  assert.deepEqual([alex.expected, alex.retard, alex.enRetard], [416.69, 116.69, true]);
  assert.deepEqual([sam.verse, sam.report, sam.solde, sam.enRetard], [400, 100, 0, false]);   // 100 + 400 − 500
  // Le report d'avance couvre des échéances : 208,35 attendus, 100 d'avance + 100 versés → 8,35 de retard.
  const less = ownerLedger({ owners, transactions: tx.map((t) => (t.owner === 'Sam' && t.tx_date === '2026-02-01' ? { ...t, amount: 100 } : t)), charges }, { now });
  assert.equal(less.find((o) => o.short === 'Sam').retard, 8.35);
  // Dû de 2025 inconnu : les versements de 2025 ne comptent plus comme une avance.
  const legacy = ownerLedger({ owners, transactions: tx, charges: { 2026: { applied: { at: '2026-01-02' } } } }, { now });
  assert.deepEqual([legacy.find((o) => o.short === 'Alex').report, legacy.find((o) => o.short === 'Alex').solde], [0, 300 - 1000]);
});

// Le budget de N+1 se prépare et s'applique pendant l'année N : les provisions en vigueur
// (ls_owners.due_*) deviennent celles de N+1. Le suivi de N garde le dû enregistré pour N.
test('ownerLedger: appliquer le budget suivant ne change pas le dû de l’exercice en cours', () => {
  const now = new Date('2026-12-10');
  const copro = [{ id: 'o-alex', short: 'Alex', name: 'Alex Martin', due_pay: 1500, due_res: 300 }];   // provisions 2027
  const charges = { 2027: { applied: { at: '2026-12-01', byOwner: { 'o-alex': { pay: 1500, res: 300 } } } } };
  const duesByYear = { 2026: { 'o-alex': { pay: 900, res: 100 } }, 2027: { 'o-alex': { pay: 1500, res: 300 } } };
  const tx = [{ account: 'pay', amount: 1000, owner: 'Alex', tx_date: '2026-03-01' }];
  const [alex] = ownerLedger({ owners: copro, transactions: tx, charges, duesByYear }, { now });
  assert.deepEqual([alex.year, alex.due, alex.dueKnown, alex.solde, alex.enRetard], [2026, 1000, true, 0, false]);
  // L'exercice 2027, lui, lit les provisions en vigueur, avec 2026 en report.
  const [next] = ownerLedger({ owners: copro, transactions: tx, charges, duesByYear }, { now, year: 2027 });
  assert.deepEqual([next.due, next.report, next.expected, next.solde], [1800, 0, 0, -1800]);
  // Sans trace du dû de 2026 (exercices-du.sql pas lancé) : dû inconnu, donc aucun retard inventé.
  const [blind] = ownerLedger({ owners: copro, transactions: tx, charges }, { now });
  assert.deepEqual([blind.due, blind.dueKnown, blind.enRetard], [0, false, false]);
});

// À la clôture, l'app fige le dû de l'exercice (freezeDues) : plus rien ne l'écrase ensuite, pas
// même les provisions en vigueur quand elles portent sur la même année.
test('ownerLedger: un exercice clôturé garde son dû figé', () => {
  const now = new Date('2026-12-10');
  const copro = [{ id: 'o-alex', short: 'Alex', name: 'Alex Martin', due_pay: 1200, due_res: 0 }];
  const duesByYear = { 2026: { 'o-alex': { pay: 600, res: 0 } } };
  const open = ownerLedger({ owners: copro, duesByYear }, { now })[0];
  assert.equal(open.due, 1200);                       // exercice ouvert : les provisions en vigueur font foi
  const closed = ownerLedger({ owners: copro, duesByYear, periods: [{ year: 2026, closed_at: '2026-12-05T10:00:00Z' }] }, { now })[0];
  assert.equal(closed.due, 600);
  const reopened = ownerLedger({ owners: copro, duesByYear, periods: [{ year: 2026, closed_at: null }] }, { now })[0];
  assert.equal(reopened.due, 1200);
});

test('buildAlerts: one overdue_payment per late owner, the amount is what is overdue', () => {
  const now = new Date('2026-07-10');   // six échéances échues : janvier à juin
  const tx = [
    { account: 'pay', amount: 300, owner: 'Alex', tx_date: '2026-02-01' },
    { account: 'pay', amount: 260, owner: 'Sam', tx_date: '2026-02-01' },     // 250,02 attendus : à jour, mais il reste 240 à verser
  ];
  const alerts = buildAlerts({ owners, transactions: tx }, { now });
  const pay = alerts.filter((a) => a.kind === 'overdue_payment');
  assert.equal(pay.length, 1);              // Sam n'est pas en retard : son solde négatif n'est que le reste de l'année
  assert.equal(pay[0].id, 'pay-o-alex-2026-6');   // copropriétaire, exercice, échéances échues
  assert.equal(pay[0].amountCents, 20002);  // 6 × 75 + (4 × 8,34 + 2 × 8,33) = 500,02 attendus − 300 versés
  assert.match(pay[0].title, /Alex Martin : 200,02 € en retard/);
  assert.match(pay[0].detail, /Exercice 2026 · attendu à ce jour 500,02 € \(sur 1000,00 € pour l'année\) · versé 300,00 €$/);
});

// Jarvis ne garde qu'une alerte par identifiant et ne la met jamais à jour : l'identifiant doit
// donc changer quand une nouvelle échéance reste impayée, et seulement à ce moment-là.
test('buildAlerts: the overdue id is stable within a month and changes with each new overdue instalment', () => {
  const tx = [{ account: 'pay', amount: 300, owner: 'Alex', tx_date: '2026-02-01' }];
  const alex = [owners[0]];
  const idAt = (iso) => buildAlerts({ owners: alex, transactions: tx }, { now: new Date(iso) }).filter((a) => a.kind === 'overdue_payment').map((a) => a.id);
  assert.deepEqual(idAt('2026-04-20'), []);                         // 3 échéances échues (250,01) : 300 versés, à jour
  assert.deepEqual(idAt('2026-05-02'), ['pay-o-alex-2026-4']);      // la 4e est échue : 333,35 attendus
  assert.deepEqual(idAt('2026-05-28'), ['pay-o-alex-2026-4']);      // même mois : même alerte
  assert.deepEqual(idAt('2026-06-01'), ['pay-o-alex-2026-5']);      // une échéance de plus : nouvelle alerte
  // Rythme trimestriel : le compteur ne bouge qu'au trimestre.
  const quarterly = [{ ...owners[0], periodicity: 'quarter' }];
  const idQ = (iso) => buildAlerts({ owners: quarterly, transactions: [] }, { now: new Date(iso) }).map((a) => a.id);
  assert.deepEqual([idQ('2026-01-20'), idQ('2026-02-01'), idQ('2026-04-30'), idQ('2026-05-01')], [[], ['pay-o-alex-2026-1'], ['pay-o-alex-2026-1'], ['pay-o-alex-2026-2']]);
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
  const now = new Date('2026-12-15');
  const owners = [{ short: 'Lou', name: 'Lou Petit', due_pay: 1000, due_res: 0 }];
  const draft = [{ account: 'pay', tx_date: '2026-07-05', tiers: 'Lou Petit', amount: 1000, owner: 'Lou', draft: true }];
  const [pending] = ownerLedger({ owners, transactions: draft }, { now });
  assert.equal(pending.verse, 0);
  assert.equal(pending.solde, -1000);
  assert.equal(pending.enRetard, true);

  // La même ligne, une fois validée, solde bien la dette.
  const [settled] = ownerLedger({ owners, transactions: [{ ...draft[0], draft: false }] }, { now });
  assert.equal(settled.verse, 1000);
  assert.equal(settled.solde, 0);
  assert.equal(settled.enRetard, false);
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

test('bankAlerts : renouveler avant échéance, échec qui dure, synchro arrêtée ; silence sinon', () => {
  const now = new Date('2026-10-26T10:00:00Z');
  const day = 86400000;
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();
  // active et loin de l'échéance, synchro réussie : rien
  assert.deepEqual(bankAlerts([{ id: 'a', status: 'active', aspsp_name: 'Swan', valid_until: iso(60 * day), last_ok_at: iso(-day), created_at: iso(-30 * day) }], now), []);
  // échéance dans 10 jours
  const renew = bankAlerts([{ id: 'a', status: 'active', aspsp_name: 'Swan', valid_until: iso(10 * day), created_at: iso(-170 * day) }], now);
  assert.equal(renew.length, 1);
  assert.equal(renew[0].id, 'bank-renew-a');
  assert.equal(renew[0].kind, 'notice');
  assert.equal(renew[0].dueDate, '2026-11-05');
  assert.match(renew[0].title, /reconnecter Swan avant le 05\/11\/2026/);
  // erreur passagère (dernière réussite il y a 10 h) : rien ; au-delà de 36 h : un avis
  assert.deepEqual(bankAlerts([{ id: 'a', status: 'active', valid_until: iso(60 * day), error: 'HTTP 503', last_ok_at: iso(-10 * 3600000), created_at: iso(-30 * day) }], now), []);
  const err = bankAlerts([{ id: 'a', status: 'active', valid_until: iso(60 * day), error: 'HTTP 503', last_ok_at: iso(-2 * day), created_at: iso(-30 * day) }], now);
  assert.deepEqual(err.map((a) => a.id), ['bank-error-a']);
  // expirée, rien d'actif ni en cours : la synchro est arrêtée
  assert.deepEqual(bankAlerts([{ id: 'x', status: 'expired', aspsp_name: 'Swan' }], now).map((a) => a.id), ['bank-expired-x']);
  // expirée mais une reconnexion est en cours, ou déconnectée volontairement : rien
  assert.deepEqual(bankAlerts([{ id: 'n', status: 'auth_ready' }, { id: 'x', status: 'expired' }], now), []);
  assert.deepEqual(bankAlerts([{ id: 'r', status: 'revoked' }], now), []);
  // branchée dans buildAlerts
  assert.ok(buildAlerts({ owners: [], transactions: [], bankLinks: [{ id: 'x', status: 'expired' }] }, { now }).some((a) => a.id === 'bank-expired-x'));
});
