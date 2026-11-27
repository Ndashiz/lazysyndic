// Tests de richtext.js (le texte des points d'AG : paragraphes et tableaux).
// Lancer : node --test tests/richtext.test.mjs   (aucune dépendance)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../richtext.js');

// ce que donne un tableau collé depuis Excel ou une page web, entre deux phrases
const BUDGET = [
  'Présentation de la proposition de budget 2027.',
  'Lot\t2026\t2027\tHausse par mois',
  'RDC & GARAGE\t79,39 €\t113,35 €\t+33,96 € (+42,8 %)',
  'ÉTAGE\t62,04 €\t81,19 €\t+19,15 € (+30,9 %)',
  'Total\t141,43 €\t194,54 €\t+53,11 €',
  'Le détail est en annexe.',
].join('\n');

test('blocks : texte, tableau, texte — les rangées gardent leurs cellules', () => {
  const b = T.blocks(BUDGET);
  assert.deepEqual(b.map(x => x.type), ['text', 'table', 'text']);
  assert.equal(b[0].text, 'Présentation de la proposition de budget 2027.');
  assert.equal(b[1].rows.length, 4);
  assert.deepEqual(b[1].rows[1], ['RDC & GARAGE', '79,39 €', '113,35 €', '+33,96 € (+42,8 %)']);
  assert.equal(b[2].text, 'Le détail est en annexe.');
});

test('blocks : sans tabulation, un seul bloc de texte, lignes vides gardées', () => {
  assert.deepEqual(T.blocks('Un.\n\nDeux.\nTrois.'), [{ type:'text', text:'Un.\n\nDeux.\nTrois.' }]);
  assert.deepEqual(T.blocks(''), []);
  assert.deepEqual(T.blocks(null), []);
  assert.equal(T.hasTable('Un.\nDeux.'), false);
});

test('blocks : rangées inégales complétées, deux tableaux séparés par une ligne vide', () => {
  const b = T.blocks('A\tB\tC\n1\t2\n\nX\tY\r\n3\t4');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0].rows, [['A', 'B', 'C'], ['1', '2', '']]);
  assert.deepEqual(b[1].rows, [['X', 'Y'], ['3', '4']]);
});

test('join est l’inverse de blocks ; trim ne mange pas les cellules vides de fin', () => {
  assert.equal(T.join(T.blocks(BUDGET)), BUDGET.replace('2027.\nLot', '2027.\n\nLot').replace('€\nLe', '€\n\nLe'));
  const last = 'A\tB\nTotal\t';
  assert.equal(T.trim('\n ' + last + '\n\n'), last);
  assert.deepEqual(T.blocks(T.trim(last + '\n'))[0].rows, [['A', 'B'], ['Total', '']]);
});

test('align : les colonnes de montants à droite, l’en-tête ne compte pas', () => {
  const rows = T.blocks(BUDGET)[1].rows;
  assert.deepEqual(T.align(rows), ['left', 'right', 'right', 'right']);
  assert.deepEqual(T.align([['Poste', 'Échéance'], ['Curage', 'déc. 2026']]), ['left', 'left']);
  assert.ok(T.isTotal(rows[3]) && !T.isTotal(rows[1]));
  assert.ok(T.isNum('-12 %') && T.isNum('1 250') && !T.isNum('déc. 2026') && !T.isNum('€'));
});

test('plain : des barres entre les cellules', () => {
  assert.match(T.plain(BUDGET), /^Lot \| 2026 \| 2027 \| Hausse par mois$/m);
  assert.ok(!T.plain(BUDGET).includes('\t'));
});

test('html : échappé, en-tête en <th>, total en gras, montants à droite', () => {
  const h = T.html('Voir <b>ci-dessous</b>\nLot\tMontant\nA & B\t10 €\nTotal\t10 €');
  assert.ok(h.includes('Voir &lt;b&gt;ci-dessous&lt;/b&gt;'));
  assert.equal((h.match(/<th /g) || []).length, 2);
  assert.equal((h.match(/<td /g) || []).length, 4);
  assert.ok(h.includes('A &amp; B'));
  assert.match(h, /<td align="right"[^>]*font-weight:700[^>]*>10 €<\/td>/);
  assert.ok(!/<script|onerror/i.test(T.html('<img src=x onerror=alert(1)>\ta')) || T.html('<img src=x onerror=alert(1)>\ta').includes('&lt;img'));
});

test('fit : largeurs naturelles si ça tient, sinon les larges se partagent le reste', () => {
  assert.deepEqual(T.fit([50, 60], 200), [50, 60]);
  const w = T.fit([40, 300, 300], 340);
  assert.equal(w[0], 40);
  assert.equal(w[1], 150); assert.equal(w[2], 150);
  assert.ok(Math.abs(T.fit([500, 500, 500], 300).reduce((a, b) => a + b, 0) - 300) < 1e-9);
});

test('drawTable : l’en-tête se répète après un saut de page, les montants finissent au bord droit', () => {
  const calls = []; let y = 100, pages = 1;
  const rows = [['Lot', 'Montant'], ['A', '10 €'], ['B', '200 €'], ['Total', '210 €']];
  T.drawTable(rows, {
    x: 10, width: 200, size: 10, lh: 1, pad: 2,
    measure: t => t.length * 5, wrap: t => [t],
    y: () => y, setY: v => { y = v; },
    need: h => { if (y - h < 50){ y = 100; pages++; return true; } return false; },
    text: (t, x, yy, bold) => calls.push({ t, x, bold, page: pages }),
    rule: () => {},
  });
  assert.equal(pages, 2);
  assert.equal(calls.filter(c => c.t === 'Lot').length, 2, 'en-tête redessiné sur la page 2');
  assert.ok(calls.filter(c => c.t === 'Lot' || c.t === 'Total').every(c => c.bold));
  const right = c => c.x + c.t.length * 5;                       // bord droit du texte
  const money = calls.filter(c => /€/.test(c.t));
  assert.ok(money.length >= 3 && money.every(c => right(c) === right(money[0])), 'colonne alignée à droite');
});
