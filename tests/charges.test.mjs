// Tests de charges.js (calcul des charges par poste).
// Lancer : node --test tests/charges.test.mjs — aucune dépendance.
// Données FICTIVES (Alex/Sam/Lou, 500/251/249 millièmes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const C = createRequire(import.meta.url)('../charges.js');
const tx = [
  // 2025 : registre commencé en mars, dernier mouvement en octobre → 8 mois couverts
  { iso:'2025-03-02', account:'pay', high:'Énergie', sub:'Électricité', amount:-80 },
  { iso:'2025-05-12', account:'pay', high:'Énergie', sub:'Électricité', amount:-88.4 },
  { iso:'2025-06-09', account:'pay', high:'Énergie', sub:'Électricité', amount:4.4 },       // remboursement
  { iso:'2025-07-17', account:'pay', high:'Énergie', sub:'Eau', amount:-306.77 },
  { iso:'2025-04-28', account:'pay', high:'Assurance', sub:'RC', amount:-142 },
  { iso:'2025-05-31', account:'pay', high:'Frais ACP', sub:'', amount:-6 },
  { iso:'2025-08-02', account:'pay', high:'Frais ACP', sub:'Banque', amount:-0.6 },
  { iso:'2025-09-01', account:'pay', high:'?', sub:'', amount:-25 },                           // à catégoriser
  { iso:'2025-09-02', account:'pay', high:'Charges', sub:'Alex', amount:300 },                 // rentrée
  { iso:'2025-10-17', account:'res', high:'Entretien', sub:'Réparations', amount:-900 },       // compte de réserve : hors charges
  { iso:'2024-12-20', account:'pay', high:'Énergie', sub:'Électricité', amount:-70, note:'année précédente' },
].map(t => ({...t, iso: t.iso}));
// le registre de l'exemple commence en mars 2025 : on retire le mouvement de 2024 pour la couverture
const tx25 = tx.filter(t => t.iso >= '2025-01-01');
const owners = [{key:'Alex', q:500}, {key:'Sam', q:251}, {key:'Lou', q:249}];

test('couverture : seuls les mois réellement couverts par les relevés comptent', () => {
  assert.deepEqual(C.coverage(tx25, 2025), {months:8, from:3, to:10});
  assert.deepEqual(C.coverage(tx, 2025), {months:10, from:1, to:10});    // le registre commence en 2024
  assert.deepEqual(C.coverage(tx25, 2023), {months:0, from:0, to:0});
  assert.deepEqual(C.coverage([{iso:'2024-02-01'},{iso:'2026-01-05'}], 2025), {months:12, from:1, to:12});
});

test('réel N-1 : dépenses nettes du compte de paiement, moyenne sur les mois couverts', () => {
  const cov = C.coverage(tx25, 2025);
  const elec = C.reference(tx25, {high:'Énergie', sub:'Électricité'}, 2025, cov);
  assert.equal(elec.total, 164);                       // 80 + 88,40 − 4,40
  assert.equal(elec.avg, 20.5);                        // 164 / 8
  assert.equal(elec.count, 3);
  const energie = C.reference(tx25, {high:'Énergie', sub:''}, 2025, cov);
  assert.equal(energie.total, 470.77);                 // toute la catégorie : électricité + eau
  assert.equal(C.reference(tx25, {high:'Entretien', sub:'Réparations'}, 2025, cov).total, 0);  // réserve exclue
  assert.equal(C.reference(tx25, null, 2025, cov), null);                                       // nouveau poste
  assert.equal(C.reference(tx25, {high:'Énergie', sub:'Gaz'}, 2025, C.coverage([], 2025)).avg, null);
});

test('mapping 1 pour 1 : une catégorie entière recouvre ses sous-catégories', () => {
  const p = [
    {id:'a', cat:{high:'Énergie', sub:''}}, {id:'b', cat:{high:'Énergie', sub:'Eau'}},
    {id:'c', cat:{high:'Assurance', sub:'RC'}}, {id:'d', cat:{high:'Assurance', sub:'Incendie'}},
    {id:'e', cat:null}, {id:'f', cat:null},
  ];
  assert.deepEqual(C.conflicts(p), [['a','b']]);
  assert.equal(C.overlaps({high:'Assurance', sub:'RC'}, {high:'Assurance', sub:'RC'}), true);
});

test('répartition : millièmes ou parts égales, au centime près', () => {
  const postes = [
    {id:'elec', key:'quote', forecast:1000},
    {id:'eau', key:'indiv', forecast:100},
    {id:'neuf', key:'quote', forecast:0.01},
  ];
  const r = C.split(postes, owners);
  assert.deepEqual(r.map(o => o.byPoste.elec), [500, 251, 249]);
  assert.deepEqual(r.map(o => o.byPoste.eau), [33.34, 33.33, 33.33]);
  assert.deepEqual(r.map(o => o.byPoste.neuf), [0.01, 0, 0]);
  assert.equal(Math.round(r.reduce((s, o) => s + o.annual, 0)*100), 110001);   // somme des parts = total
  assert.equal(r[0].annual, 533.35);
  assert.equal(r[0].monthly, 44.45);
  // 100 € en individuel sur 7 copropriétaires : 14,29 × 2 + 14,28 × 5
  const seven = C.split([{id:'x', key:'indiv', forecast:100}], Array.from({length:7}, (_, i) => ({key:i, q:1})));
  assert.equal(seven.reduce((s, o) => s + Math.round(o.annual*100), 0), 10000);
  assert.deepEqual(C.split([{id:'x', key:'quote', forecast:50}], [{key:'a', q:0}]).map(o => o.annual), [0]);
});

test('postes proposés depuis N-1 : sans doublon, rentrées et compte de réserve exclus', () => {
  const cov = C.coverage(tx25, 2025);
  const keyFor = c => (c.sub === 'Eau' || c.high === 'Frais ACP') ? 'indiv' : 'quote';
  const s = C.seed(tx25, 2025, cov, keyFor);
  assert.deepEqual(s.map(p => C.catLabel(p.cat)),
    ['Énergie › Eau', 'Énergie › Électricité', 'Assurance › RC', 'Frais ACP (toute la catégorie)']);
  assert.deepEqual(s.map(p => p.forecast), [461, 246, 213, 10]);   // moyenne × 12, à l'euro supérieur
  assert.deepEqual(s.map(p => p.key), ['indiv', 'quote', 'quote', 'indiv']);
  assert.deepEqual(C.conflicts(s), []);
  assert.equal(new Set(s.map(p => p.id)).size, s.length);
});

test('dépenses non reprises : catégories sans poste et mouvements à catégoriser', () => {
  const postes = [{id:'a', cat:{high:'Énergie', sub:''}}, {id:'b', cat:null}];
  const u = C.uncovered(tx25, postes, 2025);
  assert.equal(u.total, 173.6);                  // RC 142 + frais 6 + 0,60 + à catégoriser 25
  assert.equal(u.count, 4);
  assert.deepEqual(u.uncategorized, {total:25, count:1});
});

test('données relues : nettoyées', () => {
  const c = C.clean([{id:'x', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:'120.456'},
                     {label:'Nouveau', cat:{}, key:'??', forecast:'abc'}, null, 'texte']);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], {id:'x', label:'Eau', vendor:'', realFormula:'', fcFormula:'', fcNote:'', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:120.46});
  assert.equal(c[1].cat, null);
  assert.equal(c[1].key, 'quote');
  assert.equal(c[1].forecast, 0);
  assert.ok(c[1].id);
});

test('réserve : appel de chaque année, montant reconstitué au centime', () => {
  const facade = { id:'f', amount:18000, months:36, key:'quote', start:'2026-01' };
  assert.deepEqual([2025, 2026, 2027, 2028, 2029].map(y => C.reserveCall(facade, y)), [0, 6000, 6000, 6000, 0]);
  assert.deepEqual(C.reserveSpan(facade, 2026), { inYear:12, before:0, end:'2028-12' });
  const juillet = { amount:1200, months:12, start:'2026-07' };
  assert.deepEqual([2026, 2027].map(y => C.reserveCall(juillet, y)), [600, 600]);
  const tiers = { amount:1000, months:3, start:'2026-11' };          // 333,33 / 333,34 / 333,33
  assert.equal(C.reserveCall(tiers, 2026), 666.67);
  assert.equal(C.reserveCall(tiers, 2027), 333.33);
  assert.equal(C.reserveCall({ amount:500, months:0, start:'2026-01' }, 2026), 0);
});

test('réserve : minimum légal de 5 % complété poste par poste, par copropriétaire', () => {
  const charges = [937.01, 583.92, 581.07];
  const travaux = [
    { id:'f', amount:18000, months:36, key:'quote', start:'2026-01' },
    { id:'e', amount:4800, months:24, key:'quote', start:'2026-01' },
    { id:'i', amount:1080, months:12, key:'indiv', start:'2026-01' },
  ];
  const r = C.reserveSplit(travaux, 2026, owners, charges);
  assert.deepEqual(r.map(o => o.legalMin), [46.85, 29.2, 29.05]);
  assert.deepEqual(r.map(o => o.legal), [0, 0, 0]);                 // déjà couvert
  assert.deepEqual(r.map(o => o.reserve), [4560, 2468.4, 2451.6]);
  assert.deepEqual(r.map(o => o.byPoste.f), [3000, 1506, 1494]);
  assert.deepEqual(r.map(o => o.monthly), [380, 205.7, 204.3]);
  // peu de réserve : la ligne comble ce qui manque à chacun, et seulement ça
  const peu = C.reserveSplit([{ id:'p', amount:60, months:12, key:'indiv', start:'2026-01' }], 2026, owners, charges);
  assert.deepEqual(peu.map(o => o.legal), [26.85, 9.2, 9.05]);
  assert.deepEqual(peu.map(o => o.reserve), [46.85, 29.2, 29.05]);
  // aucun poste : la ligne seule fait le minimum
  assert.deepEqual(C.reserveSplit([], 2026, owners, charges).map(o => o.reserve), [46.85, 29.2, 29.05]);
});

// art. 3.86 §3 : 5 % « de la totalité des charges communes ordinaires de l'exercice précédent »,
// donc le réel N-1 de chaque poste (ramené à 12 mois) réparti selon sa clé, pas la prévision N.
test('réserve : la base du minimum légal est le réel N-1 par poste, la prévision seulement à défaut', () => {
  const postes = [
    { id:'a', key:'quote', forecast:1200, calc:{ real:1000 } },   // 1000 aux millièmes : 500 / 251 / 249
    { id:'b', key:'indiv', forecast:600,  calc:{ real:300 } },    // 300 en parts égales : 100 chacun
    { id:'c', key:'quote', forecast:50,   calc:{ real:null } },   // nouveau poste : pas de réel
    { id:'d', key:'quote', forecast:10,   calc:{ real:-20 } },    // remboursement net : ne retire rien
  ];
  const lb = C.legalBase(postes, owners, [999, 999, 999]);
  assert.equal(lb.basis, 'real');
  assert.deepEqual(lb.base, [600, 351, 349]);
  assert.deepEqual(C.reserveSplit([], 2026, owners, lb.base).map(o => o.legalMin), [30, 17.55, 17.45]);
  // aucun réel : la prévision de chacun, et le modèle de l'Annexe 4 le dit
  const fb = C.legalBase([{ id:'c', key:'quote', forecast:50, calc:{ real:null } }], owners, [937.01, 583.92, 581.07]);
  assert.deepEqual(fb, { basis:'forecast', base:[937.01, 583.92, 581.07] });
  const split = { charges:[], res:C.reserveSplit([], 2026, owners, fb.base), total:[], monthly:[], legalBasis:fb.basis, legalBase:fb.base };
  const m = C.annexModel({ postes:[], reserve:[] }, split, [{n:'Alex', short:'Alex', q:500}, {n:'Sam', short:'Sam', q:251}, {n:'Lou', short:'Lou', q:249}], 2026);
  assert.equal(m.reserve.legal.basis, 'forecast');
  assert.equal(m.reserve.legal.base, 2102);
});

test('réserve : données relues nettoyées', () => {
  const c = C.cleanReserve([{ id:'x', label:'Façade', amount:'18000', months:'36', key:'quote', start:'2026-01' },
                            { label:'Sans durée', amount:-5, months:'abc', start:'janvier' }, null], 2027);
  assert.deepEqual(c[0], { id:'x', label:'Façade', amount:18000, months:36, key:'quote', start:'2026-01' });
  assert.equal(c[1].amount, 0);
  assert.equal(c[1].months, 12);
  assert.equal(c[1].start, '2027-01');
  assert.equal(c.length, 2);
});

test('bénéficiaire : le tiers le plus fréquent des dépenses de la catégorie, sans les libellés bancaires', () => {
  const rows = [
    { iso:'2025-02-10', account:'pay', high:'Énergie', sub:'Électricité', amount:-22.19, tiers:'Engie' },
    { iso:'2025-05-20', account:'pay', high:'Énergie', sub:'Électricité', amount:-54.43, tiers:'REF 2210814498/ 709935001629/ 5176206287' },
    { iso:'2025-06-15', account:'pay', high:'Énergie', sub:'Électricité', amount:-34.43, tiers:'engie' },             // même nom, casse différente
    { iso:'2025-09-08', account:'pay', high:'Énergie', sub:'Électricité', amount:202.89, tiers:'Luminus' },           // remboursement : pas une dépense
    { iso:'2025-07-17', account:'pay', high:'Énergie', sub:'Eau', amount:-306.77, tiers:'Vivaqua' },
    { iso:'2025-08-02', account:'pay', high:'Frais ACP', sub:'Banque', amount:-0.6, tiers:'SEPA Credit Transfer' },
    { iso:'2025-08-31', account:'pay', high:'Frais ACP', sub:'Banque', amount:-6, tiers:'Account subscription' },
    { iso:'2025-10-17', account:'res', high:'Entretien', sub:'Réparations', amount:-900, tiers:'Toiture SA' },        // compte de réserve : hors charges
    { iso:'2024-12-20', account:'pay', high:'Énergie', sub:'Électricité', amount:-70, tiers:'Lampiris' },            // autre année
  ];
  assert.equal(C.vendorOf(rows, {high:'Énergie', sub:'Électricité'}, 2025), 'Engie');
  assert.equal(C.vendorOf(rows, {high:'Énergie', sub:''}, 2025), 'Engie');            // toute la catégorie : Engie 2, Vivaqua 1
  assert.equal(C.vendorOf(rows, {high:'Énergie', sub:'Électricité'}, 2024), 'Lampiris');
  assert.equal(C.vendorOf(rows, {high:'Frais ACP', sub:'Banque'}, 2025), '');          // que des libellés génériques
  assert.equal(C.vendorOf(rows, {high:'Entretien', sub:''}, 2025), '');                // réserve : hors compte de paiement
  assert.equal(C.vendorOf(rows, null, 2025), '');
  const s = C.seed(rows, 2025, C.coverage(rows, 2025));
  assert.equal(s.find(p => p.cat.sub === 'Eau').vendor, 'Vivaqua');
  assert.equal(s.find(p => p.cat.sub === 'Banque').vendor, '');
});

test('poste du budget précédent : même catégorie, sinon même nom', () => {
  const prev = [
    { id:'a', label:'Électricité', cat:{high:'Énergie', sub:'Électricité'}, key:'indiv', forecast:262 },
    { id:'b', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:1066 },
    { id:'c', label:'Chambre de visite', cat:null, key:'quote', forecast:500 },
  ];
  assert.equal(C.matchPrev(prev, { label:'Courant', cat:{high:'Énergie', sub:'Électricité'} }).id, 'a');   // la catégorie prime sur le nom
  assert.equal(C.matchPrev(prev, { label:'Énergie', cat:{high:'Énergie', sub:''} }).id, 'a');             // la catégorie entière recouvre ses sous-catégories
  assert.equal(C.matchPrev(prev, { label:'chambre de visite ', cat:null }).id, 'c');                        // nouveau poste : par le nom
  assert.equal(C.matchPrev(prev, { label:'Ascenseur', cat:{high:'Entretien', sub:''} }), null);
  assert.equal(C.matchPrev(undefined, { label:'Eau', cat:null }), null);
});

test('postes relus : le bénéficiaire est gardé et borné', () => {
  const c = C.clean([{ id:'x', label:'Eau', vendor:'Vivaqua', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:1066 }, { label:'Sans', vendor:'x'.repeat(100) }]);
  assert.equal(c[0].vendor, 'Vivaqua');
  assert.equal(c[1].vendor.length, 80);
  assert.equal(C.clean([{ label:'Ancien' }])[0].vendor, '');
});

test('un budget est un brouillon tant qu\'il n\'est pas publié ; appliqué aux provisions = publié', () => {
  assert.equal(C.isPublished({ postes:[] }), false);
  assert.equal(C.isPublished({ status:'draft' }), false);
  assert.equal(C.isPublished({ status:'published' }), true);
  assert.equal(C.isPublished({ applied:{ at:'2026-10-25T10:00:00Z', total:1371 } }), true);
  assert.equal(C.isPublished(null), false);
});

test('formule façon tableur : nombres, champs, priorités, parenthèses, pourcentage', () => {
  const f = { 'réel à ce jour': 1441.2, 'mois couverts': 10, 'marge': 0.03, 'réel': 1729.44 };
  assert.deepEqual(C.evalFormula('[réel à ce jour] × 12 ÷ [mois couverts]', f), { value: 1729.44, error: null });
  assert.deepEqual(C.evalFormula('[réel] × (1 + [marge])', f), { value: 1781.32, error: null });
  assert.deepEqual(C.evalFormula('[Reel] * (1 + 3 %)', f), { value: 1781.32, error: null });        // accents et casse indifférents, % postfixe, * pour ×
  assert.deepEqual(C.evalFormula('6 × 12', f), { value: 72, error: null });
  assert.deepEqual(C.evalFormula('1 227,00 + 2,5', f), { value: 1229.5, error: null });             // virgule décimale, espace de milliers
  assert.deepEqual(C.evalFormula('2 + 3 × 4', f), { value: 14, error: null });                      // × avant +
  assert.deepEqual(C.evalFormula('-(2 + 3) × 4', f), { value: -20, error: null });
  assert.deepEqual(C.evalFormula('200', f), { value: 200, error: null });
  assert.equal(C.evalFormula('[loyer] × 2', f).error, 'champ inconnu : loyer');
  assert.equal(C.evalFormula('[réel] ÷ 0', f).error, 'division par zéro');
  assert.equal(C.evalFormula('2 +', f).error, 'formule incomplète');
  assert.equal(C.evalFormula('2 ) 3', f).error, 'caractère inattendu : )');
  assert.equal(C.evalFormula('alert(1)', f).error, 'caractère inattendu : a');                        // jamais de code
  assert.equal(C.evalFormula('', f).error, 'formule vide');
  assert.equal(C.shortFormula(C.REAL_FORMULA), 'réel à ce jour × 12 ÷ mois couverts');
});

test('poste résolu : estimé N-1, réel ramené à 12 mois, delta, prévision par formule ou saisie', () => {
  const tx26 = [
    { iso:'2026-02-12', account:'pay', high:'Énergie', sub:'Eau', amount:-306.77, tiers:'Vivaqua' },
    { iso:'2026-08-04', account:'pay', high:'Énergie', sub:'Eau', amount:-380, tiers:'Vivaqua' },
    { iso:'2026-01-05', account:'pay', high:'Charges', sub:'', amount:79.39 },
    { iso:'2026-10-16', account:'pay', high:'Énergie', sub:'Électricité', amount:-16.5 },
    { iso:'2025-06-03', account:'pay', high:'Énergie', sub:'Eau', amount:-199.39, tiers:'Vivaqua' },
  ];
  const cov = C.coverage(tx26, 2026);                       // janvier → octobre : 10 mois
  const prev = [{ id:'p', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:1227 }];
  const ctx = { tx: tx26, year: 2026, cov, prev, marge: 3, frozen: false };
  const eau = C.resolve({ id:'a', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:0, realFormula:'', fcFormula:C.FC_FORMULA, fcNote:'' }, ctx);
  assert.equal(eau.calc.toDate, 686.77);
  assert.equal(eau.calc.months, 10);
  assert.equal(eau.calc.real, 824.12);                       // 686,77 × 12 ÷ 10
  assert.equal(eau.calc.est, 1227);
  assert.equal(eau.calc.delta, 402.88);                      // sous le budget
  assert.equal(eau.forecast, 848.84);                        // 824,12 × 1,03
  assert.equal(eau.calc.fields['réel précédent'], 199.39);
  // réel à la formule libre, prévision saisie à la main
  const saisi = C.resolve({ id:'b', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:900, realFormula:'[réel à ce jour]', fcFormula:'', fcNote:'devis' }, ctx);
  assert.equal(saisi.calc.real, 686.77);
  assert.equal(saisi.forecast, 900);
  // formule fausse : erreur lisible, la prévision enregistrée reste
  const faux = C.resolve({ id:'c', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:900, realFormula:'', fcFormula:'[réel] × [taux]', fcNote:'' }, ctx);
  assert.equal(faux.forecast, 900);
  assert.equal(faux.calc.fcError, 'champ inconnu : taux');
  // budget publié : la prévision enregistrée fait foi, même avec une formule
  const gele = C.resolve({ id:'d', label:'Eau', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:800, realFormula:'', fcFormula:C.FC_FORMULA, fcNote:'' }, { ...ctx, frozen: true });
  assert.equal(gele.forecast, 800);
  // nouveau poste sans catégorie : pas de réel, pas de delta, montant saisi
  const neuf = C.resolve({ id:'e', label:'Chambre de visite', cat:null, key:'quote', forecast:200, realFormula:'', fcFormula:'', fcNote:'' }, ctx);
  assert.equal(neuf.calc.hasRef, false);
  assert.equal(neuf.calc.real, null);
  assert.equal(neuf.calc.delta, null);
  assert.equal(neuf.forecast, 200);
  assert.equal(C.cleanMarge('abc'), 3);
  assert.equal(C.cleanMarge(2.5), 2.5);
});

test('postes groupés par catégorie, dans l\'ordre d\'apparition, sans catégorie en dernier', () => {
  const g = C.groupPostes([
    { id:'1', label:'Divers', cat:null },
    { id:'2', label:'Eau', cat:{high:'Énergie', sub:'Eau'} },
    { id:'3', label:'RC', cat:{high:'Assurance', sub:'RC'} },
    { id:'4', label:'Électricité', cat:{high:'Énergie', sub:'Électricité'} },
  ]);
  assert.deepEqual(g.map(x => [x.label, x.items.map(i => i.p.id)]), [['Énergie', ['2', '4']], ['Assurance', ['3']], ['', ['1']]]);
  assert.deepEqual(C.groupPostes([]), []);
});

test('modèle de l\'Annexe 4 : rien d\'autre que les sommes de resolve et de split', () => {
  const owners = [{ n:'Alex Martin', short:'Alex', q:500 }, { n:'Sam Bernard', short:'Sam', q:251 }, { n:'Lou Petit', short:'Lou', q:249 }];
  const postes = [
    { id:'a', label:'Eau', vendor:'Vivaqua', cat:{high:'Énergie', sub:'Eau'}, key:'indiv', forecast:1781.32, fcNote:'réel + 3 %', calc:{ est:1227, real:1729.44, delta:-502.44 } },
    { id:'b', label:'Électricité', vendor:'Engie', cat:{high:'Énergie', sub:'Électricité'}, key:'quote', forecast:234.72, fcNote:'', calc:{ est:187.5, real:227.88, delta:-40.38 } },
    { id:'c', label:'Chambre de visite', vendor:'', cat:null, key:'quote', forecast:200, fcNote:'devis', calc:{ est:null, real:null, delta:null } },
  ];
  const reserve = [{ id:'f', label:'Isoler la façade', amount:18000, months:36, key:'quote', start:'2027-01' }];
  const ow = owners.map(o => ({ key:o.short, q:o.q }));
  const charges = C.split(postes, ow), res = C.reserveSplit(reserve, 2027, ow, charges.map(c => c.annual));
  const split = { charges, res, total: charges.map((c, i) => Math.round((c.annual + res[i].reserve) * 100) / 100), monthly: charges.map((c, i) => Math.round((c.annual + res[i].reserve) * 100 / 12) / 100) };
  const m = C.annexModel({ postes, reserve, marge:3, cov:{ months:10, from:1, to:10 }, status:'draft' }, split, owners, 2027);
  assert.equal(m.draft, true);
  assert.deepEqual(m.summary, { roulement:2216.04, reserve:6000, total:8216.04, monthly:684.67 });
  assert.deepEqual(m.roulement.groups.map(g => [g.label, g.rows.map(r => r.label)]), [['Énergie', ['Eau', 'Électricité']], ['', ['Chambre de visite']]]);
  const eau = m.roulement.groups[0].rows[0];
  assert.deepEqual([eau.est, eau.real, eau.delta, eau.budget], [1227, 1729.44, -502.44, 1781.32]);
  assert.deepEqual(eau.shares, [593.78, 593.77, 593.77]);                         // ÷ 3 au centime : le reste au premier de la liste
  assert.equal(Math.round(eau.shares.reduce((s, v) => s + v, 0) * 100) / 100, eau.budget);
  assert.deepEqual(m.roulement.totals, { est:1414.5, real:1957.32, delta:-542.82, budget:2216.04, monthly:184.67, shares:charges.map(c => c.annual), sharesMonthly:charges.map(c => c.monthly) });
  assert.equal(Math.round(m.roulement.totals.shares.reduce((s, v) => s + v, 0) * 100) / 100, 2216.04);
  assert.equal(m.reserve.legal.covered, true);                                    // 6 000 € de travaux couvrent largement 5 % des charges
  assert.equal(m.reserve.rows[0].call, 6000);
  assert.deepEqual(m.reserve.rows[0].shares, [3000, 1506, 1494]);
  assert.deepEqual(m.reserve.totals.shares, res.map(r => r.reserve));
  assert.equal(m.recap.rows[0].name, 'Alex Martin');
  assert.equal(m.recap.rows[0].total, split.total[0]);
  assert.equal(m.recap.totals.total, 8216.04);
  assert.equal(m.recap.totals.totalMonthly, 684.67);
  // sans estimé ni réel (nouvelle copro) : les colonnes restent vides, pas de delta inventé
  const vide = C.annexModel({ postes:[postes[2]], reserve:[], marge:3, cov:{ months:0 }, status:'published', applied:null }, { charges:C.split([postes[2]], ow), res:C.reserveSplit([], 2027, ow, [0, 0, 0]), total:[0,0,0], monthly:[0,0,0] }, owners, 2027);
  assert.equal(vide.draft, false);
  assert.deepEqual([vide.roulement.totals.est, vide.roulement.totals.real, vide.roulement.totals.delta], [null, null, null]);
});
