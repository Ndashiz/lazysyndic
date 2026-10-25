/* ============================================================
   LazySyndic — calcul des charges : budget prévisionnel par poste
   Pur : aucun DOM, aucun réseau, montants calculés en centimes entiers.
   • un budget = {postes, reserve, applied, status:'draft'|'published', publishedAt} : brouillon
     tant que le syndic ne l'a pas publié (isPublished) ; l'appliquer aux provisions le publie
   • un poste = {id, label, vendor, cat:{high, sub}|null, key:'quote'|'indiv', forecast}
     vendor = le bénéficiaire (fournisseur), texte libre, proposé par vendorOf()
     cat null = nouveau poste, sans historique ; cat.sub vide = toute la catégorie
   • reference()  — réel de l'année précédente et moyenne mensuelle d'une catégorie
   • split()      — prévision répartie par copropriétaire (millièmes ou parts égales)
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
      out.push({ id:newId(), label: cat.sub || cat.high, vendor: vendorOf(tx, cat, year), cat, key: keyFor ? keyFor(cat) : 'quote', forecast: Math.ceil(r.avg * 12) });
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
// owners = [{key, q}] ; chargesAnnual = charge courante annuelle de chacun, dans le même ordre.
// Chacun reçoit sa part de chaque poste ; la ligne « contribution minimum légale » complète
// son appel jusqu'à 5 % de ses charges courantes, jamais en dessous de zéro.
function reserveSplit(reserve, year, owners, chargesAnnual){
  const wQuote = owners.map(o => Math.max(0, Number(o.q)||0)), wIndiv = owners.map(() => 1);
  const per = owners.map(() => ({})), tot = owners.map(() => 0);
  reserve.forEach(p => {
    shares(cents(reserveCall(p, year)), p.key === 'indiv' ? wIndiv : wQuote)
      .forEach((v, i) => { per[i][p.id] = v/100; tot[i] += v; });
  });
  return owners.map((o, i) => {
    const min = Math.round(cents((chargesAnnual||[])[i]) * LEGAL_RATE / 100);
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

const api = { catLabel, catKey, overlaps, matches, conflicts, coverage, reference, shares, split, uncovered, seed, clean, newId, isExpenseCat, vendorOf, matchPrev, isPublished,
              reserveSpan, reserveCall, reserveSplit, cleanReserve, LEGAL_RATE };
root.LSCharges = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
