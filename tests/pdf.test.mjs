// Tests de pdf.js (design system des documents PDF : jetons, formats, composants HTML).
// Lancer : node --test tests/pdf.test.mjs — aucune dépendance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const P = createRequire(import.meta.url)('../pdf.js');

test('formats : montants, signes, pourcentages, dates, périodes', () => {
  assert.equal(P.fmt.eur(1383.84), '1 383,84 €'.replace(' €', ' €').replace(' ', ' '));
  assert.equal(P.fmt.eur(1383.84).replace(/\s/g, ' '), '1 383,84 €');
  assert.equal(P.fmt.eur(-0.001), '0,00 €');                                   // jamais « -0,00 »
  assert.equal(P.fmt.signed(-502.44).replace(/\s/g, ' '), '−502,44 €');
  assert.equal(P.fmt.signed(12).replace(/\s/g, ' '), '+12,00 €');
  assert.equal(P.fmt.signed(0), '0,00 €');
  assert.equal(P.fmt.pct(3), '3,0 %');
  assert.equal(P.fmt.pct(2.5, 2), '2,50 %');
  assert.equal(P.fmt.int(1000), '1 000'.replace(' ', ' '));
  assert.equal(P.fmt.date('2026-10-25'), '25/10/2026');
  assert.equal(P.fmt.date('25/10/26'), '25/10/2026');
  assert.equal(P.fmt.dateLong(new Date(2026, 9, 25)), '25 octobre 2026');
  assert.equal(P.fmt.period('2026-01-01', '2026-10-31'), '01/01/26 → 31/10/26');
  assert.equal(P.fmt.months(1, 10, 2026), 'janvier → octobre 2026');
  assert.equal(P.fmt.months(3, 3, 2026), 'mars 2026');
});

test('jetons : couleurs en hex et en rgb 0..1 pour pdf-lib, tailles jamais sous 10 px', () => {
  assert.equal(P.tokens.color.green, '#21503D');
  assert.deepEqual(P.tokens.rgb.green, [0.129, 0.314, 0.239]);
  assert.deepEqual(P.tokens.rgb.white, [1, 1, 1]);
  assert.ok(Object.values(P.tokens.font.size).every(s => s >= 10));
  assert.equal(P.tokens.font.pt(12), 9);
  assert.equal(P.tokens.page.size, 'A4');
});

test('en-tête, pied, badge : données échappées, métadonnées vides ignorées', () => {
  const h = P.head({ title:'Budget prévisionnel 2027', chip:'Annexe 4', copro:{ name:'ACP <Test>', kbo:'BE 0123.456.789' },
    meta:[{ label:'Exercice', value:'2027' }, { label:'Vide', value:'' }], status:{ kind:'draft', label:'Brouillon' } });
  assert.ok(h.includes('ACP &lt;Test&gt;'));
  assert.ok(h.includes("N° d'entreprise BE 0123.456.789"));
  assert.ok(h.includes('<span class="pdf-meta-l">Exercice</span><span class="pdf-meta-v">2027</span>'));
  assert.ok(!h.includes('Vide'));
  assert.ok(h.includes('pdf-badge-draft'));
  assert.ok(h.includes('<h1 class="pdf-h1">Budget prévisionnel 2027</h1>'));
  const f = P.foot({ copro:{ name:'ACP Démo' }, date:new Date(2026, 9, 25) });
  assert.ok(f.includes('Document généré par LazySyndic — ACP Démo'));
  assert.ok(f.includes('Édité le 25 octobre 2026'));
  assert.equal(P.badge('ok', 'Publié'), '<span class="pdf-badge pdf-badge-ok">Publié</span>');
  const d = P.document({ head:'<h1>t</h1>', body:'<p>b</p>', foot:'<footer>f</footer>' });
  assert.ok(d.startsWith('<div class="pdf-doc"><table class="pdf-page"><thead>'));
  assert.ok(d.includes('<tfoot><tr><td class="pdf-page-foot"><footer>f</footer></td></tr></tfoot>'));
});

test('tableau financier : en-tête répétable, groupes, cellules riches, totaux gardés ensemble', () => {
  const t = P.table({
    cols:[{ label:'Poste' }, { label:'Clé' }, { label:'Budget 2027', align:'right', emph:true }, { label:'Alex', sub:'500 / 1000', align:'right' }],
    groups:[{ label:'Énergie', rows:[[{ text:'Eau', sub:'Vivaqua' }, 'Individuelle (÷ 3)', { text:'1 781,32 €', emph:true }, '593,77 €']] },
            { label:'', rows:[['Chambre de visite', 'Millièmes', '200,00 €', { text:'−100,00 €', neg:true }]] }],
    totals:[{ label:'Total', cells:['', '1 981,32 €', '693,77 €'] }, { label:'Mensualité', kind:'sub', cells:['', '165,11 €', '57,81 €'] }],
    label:'Fonds de roulement',
  });
  assert.ok(t.startsWith('<table class="pdf-table" aria-label="Fonds de roulement"><thead><tr><th class="">Poste</th>'));
  assert.ok(t.includes('<th class="num emph">Budget 2027</th>'));
  assert.ok(t.includes('<th class="num">Alex<div class="pdf-th-sub">500 / 1000</div></th>'));
  assert.ok(t.includes('<tbody class="pdf-group"><tr class="pdf-group-row"><td colspan="4">Énergie</td></tr>'));
  assert.ok(t.includes('<td class="">Eau<div class="pdf-cell-sub">Vivaqua</div></td>'));
  assert.ok(t.includes('<td class="num emph">1 781,32 €</td>'));
  assert.ok(t.includes('<td class="num neg">−100,00 €</td>'));
  assert.ok(t.includes('<tbody class="pdf-totals"><tr class="pdf-tot"><td class="">Total</td>'));
  assert.ok(t.includes('<tr class="pdf-sub-row"><td class="">Mensualité</td>'));
  assert.ok(!t.includes('pdf-empty'));
  const e = P.table({ cols:[{ label:'A' }], rows:[], empty:'Rien' });
  assert.ok(e.includes('<td colspan="1" class="pdf-empty">Rien</td>'));
  const s = P.summary([{ label:'Total annuel', value:'12 897,22 €', sub:'les deux fonds', emph:true }]);
  assert.ok(s.includes('<div class="pdf-kpi pdf-kpi-emph"><div class="pdf-kpi-l">Total annuel</div><div class="pdf-kpi-v">12 897,22 €</div><div class="pdf-kpi-s">les deux fonds</div></div>'));
  assert.equal(P.section('Fonds de roulement', { n:1, chip:'compte de paiement' }), '<h2 class="pdf-h2"><span class="pdf-n">1</span><span class="pdf-h2-t">Fonds de roulement</span><span class="pdf-chip pdf-chip-soft">compte de paiement</span></h2>');
  assert.equal(P.note('Texte <b>', { kind:'legal' }), '<aside class="pdf-note pdf-note-legal">Texte &lt;b&gt;</aside>');
});
