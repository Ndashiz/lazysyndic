/* ============================================================
   LazySyndic — calcul des charges : budget prévisionnel par poste
   Pur : aucun DOM, aucun réseau, montants calculés en centimes entiers.
   • un budget = {postes, reserve, applied, status:'draft'|'published', publishedAt} : brouillon
     tant que le syndic ne l'a pas publié (isPublished) ; l'appliquer aux provisions le publie
   • un poste = {id, label, vendor, cat:{high, sub}|null, key:'quote'|'indiv', forecast,
                 realFormula, fcFormula, fcNote}
     vendor = le bénéficiaire (fournisseur), texte libre, proposé par vendorOf()
     realFormula = formule du réel N-1 ('' = standard : réel à ce jour ramené à 12 mois)
     fcFormula = formule de la prévision ('' = montant saisi) ; fcNote = explication libre
   • un budget porte aussi `marge` (en %, 3 par défaut) : [marge] dans les formules
   • evalFormula() — formule façon tableur ; resolve() — un poste avec estimé N-1, réel N-1,
     delta et prévision calculés ; groupPostes() — les postes par catégorie
     cat null = nouveau poste, sans historique ; cat.sub vide = toute la catégorie
   • reference()  — réel de l'année précédente et moyenne mensuelle d'une catégorie
   • split()      — prévision répartie par copropriétaire (millièmes ou parts égales)
   • legalBase()  — base du minimum légal de réserve : réel N-1 par poste (art. 3.86 §3), sinon prévision
   • seed()       — postes proposés depuis les dépenses de l'année de référence
   Tests : node --test tests/charges.test.mjs
   ============================================================ */
(function(root){
'use strict';

const cents = n => Math.round((Number(n)||0)*100);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const INCOME = new Set(['Charges', 'Fonds de réserve']);   // rentrées, jamais un poste de dépense
const ACCT = 'pay';                                       // les charges courantes sortent du compte de paiement
const yearOf = t => String(t.iso||'').slice(0,4);

function catLabel(c){ return !c ? 'Nouveau poste' : c.sub ? `${c.high} › ${c.sub}` : `${c.high} (toute la catégorie)`; }
function catKey(c){ return c ? c.high + '›' + (c.sub||'') : ''; }
// deux catégories qui comptent les mêmes mouvements : même catégorie, et l'une la prend en entier
function overlaps(a, b){ return !!(a && b && a.high === b.high && (!a.sub || !b.sub || a.sub === b.sub)); }
function matches(t, c){ return !!c && t.high === c.high && (!c.sub || (t.sub||'') === c.sub); }
const isExpenseCat = high => !!high && high !== '?' && !INCOME.has(high);
// Un budget reste un brouillon, visible du seul syndic, jusqu'à sa publication ; un budget déjà
// appliqué aux provisions est publié de fait (le dû de chacun en découle).
const isPublished = b => !!b && (b.status === 'published' || !!b.applied);
const cleanMarge = v => Number.isFinite(+v) && +v >= 0 && +v <= 100 ? Math.round(+v * 100) / 100 : 3;

/* ------------------------------------------------------------
   Formules façon tableur. Une formule = nombres (virgule ou point, espaces de milliers), champs
   entre crochets (« [réel à ce jour] »), + − × ÷ (ou * /), parenthèses et % postfixe (÷ 100).
   Jamais de code : l'analyseur ne connaît que ça ; un champ inconnu, une division par zéro ou un
   reste inattendu donnent une erreur lisible, pas une exception.
   ------------------------------------------------------------ */
const REAL_FORMULA = '[réel à ce jour] × 12 ÷ [mois couverts]';
const FC_FORMULA = '[réel] × (1 + [marge])';
const normKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
function evalFormula(src, fields){
  const keys = {}; for (const k in (fields || {})) keys[normKey(k)] = Number(fields[k]) || 0;
  const s = String(src || '').replace(/[\u00a0\u202f]/g, ' ');
  let i = 0;
  const fail = m => { throw new Error(m); };
  const skip = () => { while (i < s.length && s[i] === ' ') i++; };
  function primary(){
    skip(); const c = s[i];
    if (c === undefined) fail('formule incomplète');
    if (c === '(') { i++; const v = expr(); skip(); if (s[i] !== ')') fail('parenthèse fermante manquante'); i++; return v; }
    if (c === '[') { const j = s.indexOf(']', i); if (j < 0) fail('crochet fermant manquant'); const name = s.slice(i + 1, j).trim(); i = j + 1; const k = normKey(name); if (!(k in keys)) fail('champ inconnu : ' + name); return keys[k]; }
    if (c === '-' || c === '−') { i++; return -primary(); }
    const m = /^\d+(?: \d{3})*(?:[.,]\d+)?|^[.,]\d+/.exec(s.slice(i));
    if (!m) fail('caractère inattendu : ' + c);
    i += m[0].length; return parseFloat(m[0].replace(/ /g, '').replace(',', '.'));
  }
  function postfix(){ let v = primary(); for (;;) { skip(); if (s[i] === '%') { i++; v = v / 100; } else return v; } }
  function term(){ let v = postfix(); for (;;) { skip(); const c = s[i]; if (c === '×' || c === '*' || c === 'x' || c === 'X') { i++; v *= postfix(); } else if (c === '÷' || c === '/' || c === ':') { i++; const d = postfix(); if (!d) fail('division par zéro'); v /= d; } else return v; } }
  function expr(){ let v = term(); for (;;) { skip(); const c = s[i]; if (c === '+') { i++; v += term(); } else if (c === '-' || c === '−') { i++; v -= term(); } else return v; } }
  try {
    skip(); if (i >= s.length) return { value: null, error: 'formule vide' };
    const v = expr(); skip(); if (i < s.length) fail('caractère inattendu : ' + s[i]);
    if (!Number.isFinite(v)) fail('résultat non numérique');
    return { value: Math.round(v * 100) / 100, error: null };
  } catch (e) { return { value: null, error: e.message }; }
}
// « [réel à ce jour] × 12 ÷ [mois couverts] » → « réel à ce jour × 12 ÷ mois couverts » (pastille)
const shortFormula = f => String(f || '').replace(/\[([^\]]+)\]/g, '$1').replace(/\s+/g, ' ').trim();

// Les champs qu'une formule peut utiliser pour un poste, année de référence `year` (= N-1) :
// réel à ce jour, mois couverts, moyenne mensuelle, réel de l'année d'avant, budget N-1, marge.
// `réel` (ramené à 12 mois par realFormula) s'y ajoute pour la formule de la prévision.
function fieldsFor(tx, p, year, cov, prev, marge){
  const r = p.cat ? reference(tx, p.cat, year, cov) : null;
  const r2 = p.cat ? reference(tx, p.cat, year - 1, coverage(tx, year - 1)) : null;
  const q = matchPrev(prev, p);
  return {
    'réel à ce jour': r ? r.total : 0,
    'mois couverts': cov ? cov.months : 0,
    'moyenne mensuelle': r && r.avg != null ? r.avg : 0,
    'réel précédent': r2 ? r2.total : 0,
    'budget précédent': q ? q.forecast : 0,
    'marge': cleanMarge(marge) / 100,
  };
}
// Un poste résolu : estimé N-1 (poste correspondant du budget N-1), réel N-1 par sa formule,
// delta = estimé − réel, et la prévision par sa formule quand il en a une. Un budget publié
// (`frozen`) garde la prévision enregistrée : les relevés qui arrivent ensuite ne la bougent plus.
function resolve(p, ctx){
  const f = fieldsFor(ctx.tx, p, ctx.year, ctx.cov, ctx.prev, ctx.marge);
  const hasRef = !!p.cat && !!ctx.cov && ctx.cov.months > 0;
  const rf = p.realFormula || REAL_FORMULA;
  const real = hasRef ? evalFormula(rf, f) : { value: null, error: null };
  f['réel'] = real.value == null ? 0 : real.value;
  const q = matchPrev(ctx.prev, p), est = q ? q.forecast : null;
  const delta = est != null && real.value != null ? Math.round((est - real.value) * 100) / 100 : null;
  let forecast = p.forecast, fc = { value: null, error: null };
  if (p.fcFormula && !ctx.frozen) { fc = evalFormula(p.fcFormula, f); if (fc.value != null) forecast = Math.max(0, fc.value); }
  return { ...p, forecast, calc: { fields: f, hasRef, real: real.value, realError: real.error, realFormula: rf, est, delta, fcError: fc.error, toDate: f['réel à ce jour'], months: f['mois couverts'] } };
}
// Le modèle de l'Annexe 4, prêt à être mis en page : synthèse, fonds de roulement (par groupe,
// avec la part de chacun), fonds de réserve, total par copropriétaire. `bud` = un budget résolu
// (postes avec calc, reserve, marge, cov, status/applied), `split` = le résultat de la répartition
// (charges:[{annual, monthly, byPoste}], res:[{reserve, monthly, byPoste, legal, legalMin}],
// total[], monthly[]), `owners` = [{n, short, q}]. Aucun montant n'est recalculé autrement
// qu'en additionnant ce que split et resolve ont déjà établi.
function annexModel(bud, split, owners, cy){
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100, sum = a => r2(a.reduce((s, v) => s + (Number(v) || 0), 0));
  const postes = bud.postes || [], reserve = bud.reserve || [], res = split.charges || [], rs = split.res || [];
  const own = (owners || []).map(o => ({ name:o.n || o.short || '', short:o.short || o.n || '', q:Number(o.q) || 0 }));
  const n = own.length || 1, qTot = sum(own.map(o => o.q)) || 1000;
  const hasEst = postes.some(p => p.calc && p.calc.est != null), hasReal = postes.some(p => p.calc && p.calc.real != null);
  const totEst = sum(postes.map(p => p.calc ? p.calc.est || 0 : 0)), totReal = sum(postes.map(p => p.calc ? p.calc.real || 0 : 0));
  const totF = sum(postes.map(p => p.forecast));
  const groups = groupPostes(postes).map(g => ({ label:g.label, rows:g.items.map(({ p }) => ({
    id:p.id, label:p.label || catLabel(p.cat), vendor:p.vendor || '', note:p.fcNote || '', key:p.key,
    est:p.calc ? p.calc.est : null, real:p.calc ? p.calc.real : null, delta:p.calc ? p.calc.delta : null,
    budget:r2(p.forecast), shares:res.map(r => r2((r.byPoste || {})[p.id] || 0)),
  })) }));
  const roulement = { groups, hasEst, hasReal, totals:{
    est: hasEst ? totEst : null, real: hasReal ? totReal : null, delta: hasEst && hasReal ? r2(totEst - totReal) : null,
    budget: totF, monthly: r2(totF / 12), shares: res.map(r => r2(r.annual)), sharesMonthly: res.map(r => r2(r.monthly)),
  } };
  const legalTot = sum(rs.map(r => r.legal)), minTot = sum(rs.map(r => r.legalMin)), resTot = sum(rs.map(r => r.reserve));
  const resRows = reserve.map(p => { const sp = reserveSpan(p, cy); return {
    id:p.id, label:p.label || '—', auto:false, key:p.key, amount:r2(p.amount), months:p.months, end:sp.end,
    call:r2(reserveCall(p, cy)), shares:rs.map(r => r2((r.byPoste || {})[p.id] || 0)),
  }; });
  const legal = { label:'Contribution minimum légale', auto:true, rate:LEGAL_RATE, amount:minTot, call:legalTot, covered:legalTot === 0,
    shares:rs.map(r => r2(r.legal)), mins:rs.map(r => r2(r.legalMin)),
    // sur quoi portent les 5 % : le réel N-1 (la loi) ou, faute de réel, la prévision N
    basis: split.legalBasis === 'real' ? 'real' : 'forecast', base: split.legalBase ? sum(split.legalBase) : null };
  const fonds = { legal, rows:resRows, totals:{ amount:sum(reserve.map(p => p.amount)), call:resTot, monthly:r2(resTot / 12),
    shares:rs.map(r => r2(r.reserve)), sharesMonthly:rs.map(r => r2(r.monthly)) } };
  const recap = { rows:own.map((o, i) => ({ name:o.name, short:o.short, q:o.q,
      annual:r2((res[i] || {}).annual || 0), monthly:r2((res[i] || {}).monthly || 0),
      resAnnual:r2((rs[i] || {}).reserve || 0), resMonthly:r2((rs[i] || {}).monthly || 0),
      total:r2((split.total || [])[i] || 0), totalMonthly:r2((split.monthly || [])[i] || 0) })),
    totals:{ q:qTot, annual:totF, monthly:r2(totF / 12), resAnnual:resTot, resMonthly:r2(resTot / 12), total:r2(totF + resTot), totalMonthly:r2((totF + resTot) / 12) } };
  return { cy, ref:cy - 1, draft:!isPublished(bud), publishedAt:bud.publishedAt || null, marge:cleanMarge(bud.marge), cov:bud.cov || { months:0 }, n, qTot, owners:own,
    summary:{ roulement:totF, reserve:resTot, total:r2(totF + resTot), monthly:r2((totF + resTot) / 12) }, roulement, reserve:fonds, recap };
}
// Les postes par catégorie de la comptabilité, dans l'ordre d'apparition ; sans catégorie en dernier.
function groupPostes(postes){
  const by = new Map();
  (postes || []).forEach((p, i) => { const k = p.cat && p.cat.high ? p.cat.high : ''; if (!by.has(k)) by.set(k, []); by.get(k).push({ p, i }); });
  const out = [...by.entries()].filter(([k]) => k).map(([k, items]) => ({ label: k, items }));
  if (by.has('')) out.push({ label: '', items: by.get('') });
  return out;
}

// Bénéficiaire probable d'une catégorie : le tiers le plus fréquent de ses dépenses de l'année
// (alias déjà résolus à l'import). Les libellés bancaires génériques et les références
// (« SEPA Credit Transfer », « REF 2210… », « +++…+++ ») ne nomment personne : ignorés.
const GENERIC_TIERS = /sepa|credit transfer|instant transfer|direct debit|subscription|abonnement|^ref\b|^\+\+\+|^\d/i;
function vendorOf(tx, cat, year){
  if (!cat) return '';
  const seen = new Map();
  tx.filter(t => t.account === ACCT && yearOf(t) === String(year) && t.amount < 0 && matches(t, cat)).forEach(t => {
    const s = String(t.tiers || '').trim();
    if (!s || GENERIC_TIERS.test(s)) return;
    const e = seen.get(s.toLowerCase()) || { label: s, count: 0 };
    e.count++; seen.set(s.toLowerCase(), e);
  });
  let best = null;
  for (const e of seen.values()) if (!best || e.count > best.count) best = e;
  return best ? best.label : '';
}

// Le poste du budget précédent qui correspond à `p` : même catégorie (ou recouvrement),
// sinon même nom ; null quand rien ne correspond. Sert à rappeler ce qui avait été prévu.
function matchPrev(prev, p){
  const list = Array.isArray(prev) ? prev : [];
  const byCat = p.cat ? list.find(q => overlaps(q.cat, p.cat)) : null;
  if (byCat) return byCat;
  const name = String(p.label || '').trim().toLowerCase();
  return name ? (list.find(q => String(q.label || '').trim().toLowerCase() === name) || null) : null;
}

// Paires de postes rattachés à des catégories qui se recouvrent : une dépense y serait comptée deux fois.
function conflicts(postes){
  const out = [];
  postes.forEach((p, i) => postes.forEach((q, j) => { if (j > i && overlaps(p.cat, q.cat)) out.push([p.id, q.id]); }));
  return out;
}

// Mois de `year` couverts par les relevés : du premier au dernier mouvement connu, tous comptes.
// Un registre commencé en mars ne compte pas janvier et février comme des mois sans dépense.
function coverage(tx, year){
  const isos = tx.map(t => t.iso).filter(i => ISO.test(i||'')).sort();
  const y = String(year), none = {months:0, from:0, to:0};
  if (!isos.length) return none;
  const first = isos[0], last = isos[isos.length-1];
  if (last.slice(0,4) < y || first.slice(0,4) > y) return none;
  const from = first.slice(0,4) < y ? 1 : +first.slice(5,7);
  const to = last.slice(0,4) > y ? 12 : +last.slice(5,7);
  return {months: to - from + 1, from, to};
}

// Réel de l'année de référence pour une catégorie : dépenses nettes du compte de paiement
// (un remboursement vient en déduction), et moyenne mensuelle sur les mois couverts.
// null pour un nouveau poste : pas de catégorie, donc pas d'historique.
function reference(tx, cat, year, cov){
  if (!cat) return null;
  const rows = tx.filter(t => t.account === ACCT && yearOf(t) === String(year) && matches(t, cat));
  const c = 0 - rows.reduce((s, t) => s + cents(t.amount), 0);   // 0 - 0 : jamais « -0,00 € »
  const months = cov ? cov.months : 0;
  return { total: c/100, count: rows.length, months, avg: months ? Math.round(c / months)/100 : null };
}

// Montant A (centimes) réparti selon des poids, au centime près : la somme des parts vaut A
// (méthode du plus fort reste ; à égalité, l'ordre de la liste).
function shares(A, w){
  const W = w.reduce((a, b) => a + b, 0);
  if (!W || !A) return w.map(() => 0);
  const raw = w.map(x => A * x / W), base = raw.map(Math.floor);
  const rest = A - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({i, f: r - Math.floor(r)})).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; k < rest; k++) base[order[k % order.length].i]++;
  return base;
}

// owners = [{key, q}] : millièmes (« quote ») ou une part par copropriétaire (« indiv »),
// quel que soit le nombre de lots qu'il détient.
function split(postes, owners){
  const wQuote = owners.map(o => Math.max(0, Number(o.q)||0)), wIndiv = owners.map(() => 1);
  const per = owners.map(() => ({})), tot = owners.map(() => 0);
  postes.forEach(p => {
    shares(cents(p.forecast), p.key === 'indiv' ? wIndiv : wQuote)
      .forEach((v, i) => { per[i][p.id] = v/100; tot[i] += v; });
  });
  return owners.map((o, i) => ({ key: o.key, annual: tot[i]/100, monthly: Math.round(tot[i]/12)/100, byPoste: per[i] }));
}

// Dépenses de l'année de référence qu'aucun poste ne reprend (mouvements « à catégoriser » compris).
function uncovered(tx, postes, year){
  const cats = postes.map(p => p.cat).filter(Boolean);
  const rows = tx.filter(t => t.account === ACCT && yearOf(t) === String(year) && t.amount < 0
    && (t.high === '?' || !t.high || isExpenseCat(t.high)) && !cats.some(c => matches(t, c)));
  const unc = rows.filter(t => !t.high || t.high === '?');
  const total = rows.reduce((s, t) => s - cents(t.amount), 0), tUnc = unc.reduce((s, t) => s - cents(t.amount), 0);
  return { total: total/100, count: rows.length, uncategorized: { total: tUnc/100, count: unc.length } };
}

let _n = 0;
const newId = () => 'p' + Date.now().toString(36) + (++_n).toString(36) + Math.random().toString(36).slice(2,6);

// Postes proposés depuis les dépenses de l'année de référence : une catégorie entière quand
// certains mouvements n'ont pas de sous-catégorie, sinon une ligne par sous-catégorie — jamais
// deux postes sur les mêmes mouvements. Prévision = moyenne mensuelle × 12, arrondie à l'euro supérieur.
function seed(tx, year, cov, keyFor){
  const y = String(year), byHigh = new Map();
  tx.filter(t => t.account === ACCT && yearOf(t) === y && isExpenseCat(t.high)).forEach(t => {
    const h = byHigh.get(t.high) || {subs:new Set(), bare:false};
    if (t.sub) h.subs.add(t.sub); else h.bare = true;
    byHigh.set(t.high, h);
  });
  const out = [];
  for (const [high, h] of byHigh){
    const cats = h.bare ? [{high, sub:''}] : [...h.subs].sort((a, b) => a.localeCompare(b, 'fr')).map(sub => ({high, sub}));
    cats.forEach(cat => {
      const r = reference(tx, cat, year, cov);
      if (!(r.total > 0) || r.avg == null) return;            // remboursements nets : rien à budgéter
      out.push({ id:newId(), label: cat.sub || cat.high, vendor: vendorOf(tx, cat, year), cat, key: keyFor ? keyFor(cat) : 'quote', forecast: Math.ceil(r.avg * 12), realFormula: '', fcFormula: FC_FORMULA, fcNote: '' });
    });
  }
  return out.sort((a, b) => b.forecast - a.forecast);
}

// Données relues (Supabase, sauvegarde) : rien d'inattendu ne passe.
function clean(list){
  return (Array.isArray(list) ? list : []).filter(p => p && typeof p === 'object').map(p => ({
    id: String(p.id || newId()),
    label: String(p.label || '').slice(0, 80),
    vendor: String(p.vendor || '').slice(0, 80),
    realFormula: String(p.realFormula || '').slice(0, 200),
    fcFormula: String(p.fcFormula || '').slice(0, 200),
    fcNote: String(p.fcNote || '').slice(0, 160),
    cat: p.cat && p.cat.high ? { high: String(p.cat.high), sub: String(p.cat.sub || '') } : null,
    key: p.key === 'indiv' ? 'indiv' : 'quote',
    forecast: Number.isFinite(+p.forecast) ? Math.round(+p.forecast * 100)/100 : 0,
  }));
}

/* ------------------------------------------------------------
   Fonds de réserve (compte de réserve)
   Un poste = {id, label, amount, months, key, start:'YYYY-MM'} : un montant à constituer
   en `months` mois à partir de `start` (janvier de l'exercice où il est créé).
   L'appel d'une année = la part du montant qui tombe dans ses mois, calculée sur le cumul
   (arrondi(A × mois écoulés ÷ durée)) : la somme des années redonne le montant au centime.
   ------------------------------------------------------------ */
const LEGAL_RATE = 5;   // % : le fonds de réserve reçoit au moins 5 % des charges courantes de chacun
const ym = s => { const m = /^(\d{4})-(\d{2})$/.exec(String(s||'')); return m ? (+m[1])*12 + (+m[2] - 1) : null; };
const ymStr = i => `${Math.floor(i/12)}-${String(i%12 + 1).padStart(2,'0')}`;
// mois du poste dans l'année, mois déjà passés avant elle, et dernier mois du poste
function reserveSpan(p, year){
  const s = ym(p.start), n = Math.max(0, Math.floor(Number(p.months)||0));
  if (s == null || !n) return { inYear:0, before:0, end:'' };
  const y0 = year*12, y1 = y0 + 11, e = s + n - 1;
  return {
    inYear: Math.max(0, Math.min(e, y1) - Math.max(s, y0) + 1),
    before: Math.max(0, Math.min(e, y0 - 1) - s + 1),
    end: ymStr(e),
  };
}
function reserveCall(p, year){
  const A = cents(p.amount), n = Math.max(0, Math.floor(Number(p.months)||0));
  if (!A || !n) return 0;
  const sp = reserveSpan(p, year), upto = k => Math.round(A * k / n);
  return (upto(sp.before + sp.inYear) - upto(sp.before)) / 100;
}
// Base du minimum légal : « la totalité des charges communes ordinaires de l'exercice précédent »
// (art. 3.86 §3 du Code civil), soit le réel N-1 de chaque poste ramené à 12 mois (calc.real),
// réparti selon la clé du poste. Sans aucun réel (nouvelle copro, premier exercice), repli sur la
// prévision N de chacun (`fallback`), en le disant : basis 'forecast'.
function legalBase(postes, owners, fallback){
  const wQuote = owners.map(o => Math.max(0, Number(o.q)||0)), wIndiv = owners.map(() => 1);
  const withReal = (postes || []).filter(p => p && p.calc && p.calc.real != null);
  if (!withReal.length) return { basis:'forecast', base: owners.map((_, i) => Number((fallback || [])[i]) || 0) };
  const tot = owners.map(() => 0);
  withReal.forEach(p => shares(Math.max(0, cents(p.calc.real)), p.key === 'indiv' ? wIndiv : wQuote).forEach((v, i) => { tot[i] += v; }));
  return { basis:'real', base: tot.map(c => c/100) };
}
// owners = [{key, q}] ; legalBaseAmounts = la base du minimum légal de chacun, dans le même ordre
// (legalBase : réel N-1, sinon prévision N). Chacun reçoit sa part de chaque poste ; la ligne
// « contribution minimum légale » complète son appel jusqu'à 5 % de sa base, jamais sous zéro.
function reserveSplit(reserve, year, owners, legalBaseAmounts){
  const wQuote = owners.map(o => Math.max(0, Number(o.q)||0)), wIndiv = owners.map(() => 1);
  const per = owners.map(() => ({})), tot = owners.map(() => 0);
  reserve.forEach(p => {
    shares(cents(reserveCall(p, year)), p.key === 'indiv' ? wIndiv : wQuote)
      .forEach((v, i) => { per[i][p.id] = v/100; tot[i] += v; });
  });
  return owners.map((o, i) => {
    const min = Math.round(cents((legalBaseAmounts||[])[i]) * LEGAL_RATE / 100);
    const legal = Math.max(0, min - tot[i]);
    return { key:o.key, byPoste:per[i], others:tot[i]/100, legalMin:min/100, legal:legal/100,
             reserve:(tot[i] + legal)/100, monthly: Math.round((tot[i] + legal)/12)/100 };
  });
}
function cleanReserve(list, year){
  return (Array.isArray(list) ? list : []).filter(p => p && typeof p === 'object').map(p => ({
    id: String(p.id || newId()),
    label: String(p.label || '').slice(0, 80),
    amount: Number.isFinite(+p.amount) && +p.amount > 0 ? Math.round(+p.amount * 100)/100 : 0,
    months: Math.min(600, Math.max(1, Math.floor(Number(p.months)) || 12)),
    key: p.key === 'indiv' ? 'indiv' : 'quote',
    start: ym(p.start) != null ? String(p.start) : `${year || new Date().getFullYear()}-01`,
  }));
}

/* ------------------------------------------------------------
   Instantané des copropriétaires à la publication
   Un budget publié est un document : sa répartition est celle des copropriétaires du jour de la
   publication (clé, nom, quotité) et de la base du minimum légal d'alors. Corriger une quotité ou
   ajouter un copropriétaire ensuite ne change ni l'Annexe 4 publiée ni le dû à appliquer : l'écran
   le signale (ownersDiff), et le syndic repasse le budget en brouillon pour le republier.
   ------------------------------------------------------------ */
// owners de l'app = [{id?, n, short, q}] → [{key, n, short, q}] ; la clé est celle de split
// (id du copropriétaire, sinon son nom court) : c'est elle qui relie l'instantané au dû de chacun.
function ownersSnapshot(owners){
  return (Array.isArray(owners) ? owners : []).filter(o => o && typeof o === 'object').map(o => ({
    key: String(o.key || o.id || o.short || o.n || o.name || ''),
    n: String(o.n || o.name || o.short || ''),
    short: String(o.short || o.n || o.name || ''),
    q: Math.max(0, Number(o.q) || 0),
  }));
}
// Ce qui a changé depuis l'instantané : arrivés, partis, quotités modifiées. La clé fait l'identité.
function ownersDiff(snapshot, current){
  const snap = ownersSnapshot(snapshot), cur = ownersSnapshot(current);
  const s = new Map(snap.map(o => [o.key, o])), c = new Map(cur.map(o => [o.key, o]));
  const added = cur.filter(o => !s.has(o.key));
  const removed = snap.filter(o => !c.has(o.key));
  const changed = cur.filter(o => s.has(o.key) && s.get(o.key).q !== o.q).map(o => ({ key:o.key, short:o.short, from:s.get(o.key).q, to:o.q }));
  return { same: !added.length && !removed.length && !changed.length, added, removed, changed };
}
// Instantané relu (Supabase, sauvegarde) : {at, owners, legalBasis, legalBase} ou null.
function cleanSnapshot(s){
  if (!s || typeof s !== 'object') return null;
  const owners = ownersSnapshot(s.owners);
  if (!owners.length) return null;
  return {
    at: typeof s.at === 'string' ? s.at : '',
    owners,
    legalBasis: s.legalBasis === 'real' ? 'real' : 'forecast',
    legalBase: owners.map((_, i) => { const v = +(Array.isArray(s.legalBase) ? s.legalBase[i] : 0); return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }),
  };
}

const api = { catLabel, catKey, overlaps, matches, conflicts, coverage, reference, shares, split, uncovered, seed, clean, newId, isExpenseCat, vendorOf, matchPrev, isPublished,
              cleanMarge, evalFormula, shortFormula, fieldsFor, resolve, groupPostes, annexModel, REAL_FORMULA, FC_FORMULA,
              reserveSpan, reserveCall, legalBase, reserveSplit, cleanReserve, LEGAL_RATE,
              ownersSnapshot, ownersDiff, cleanSnapshot };
root.LSCharges = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
