/* ============================================================
   LazySyndic — rapprochement bancaire (LSRecon)
   Pur : aucun DOM, aucun réseau.
   • reconcile() — l'écart entre le solde calculé À LA DATE du relevé et la clôture annoncée par
     le relevé, et ce qui peut l'expliquer : une ligne en trop du montant exact de l'écart, deux
     lignes identiques (relevé importé deux fois), une ligne du montant manquant qui attend sa
     validation ou qui est à la corbeille, un solde d'ouverture qui s'écarte de l'ouverture du
     premier relevé. Un mouvement plus récent que le relevé n'est jamais un écart.
   • chain() — la chaîne des relevés d'un compte : chacun doit s'ouvrir là où le précédent s'est
     fermé ; sinon un relevé manque entre les deux.
   Tests : node --test tests/recon.test.mjs
   ============================================================ */
(function(root){
'use strict';
const r2 = n => Math.round((Number(n)||0)*100)/100;
const same = (a, b) => Math.abs((Number(a)||0) - (Number(b)||0)) < 0.005;
const norm = s => String(s||'').toLowerCase().replace(/\s+/g, ' ').trim();

// o = { closing, asOfIso, balanceAtAsOf, opening, firstOpening|null,
//       tx:[{id, iso, amount, tiers, date}] (lignes validées du compte), drafts:[…], trash:[…] }
// → { diff, ok, candidates:[{kind:'extra'|'dup'|'draft'|'trash'|'opening', …}], afterCount, afterTotal }
function reconcile(o){
  const diff = r2(o.balanceAtAsOf - o.closing), ok = Math.abs(diff) < 0.01;
  const upTo = (o.tx||[]).filter(t => !o.asOfIso || !t.iso || t.iso <= o.asOfIso);
  const after = (o.tx||[]).filter(t => o.asOfIso && t.iso && t.iso > o.asOfIso);
  const candidates = [];
  if (!ok){
    // deux lignes identiques (date, montant, tiers) : la seconde est en trop si elle vaut l'écart
    const seen = new Map();
    upTo.forEach(t => { const k = `${t.iso}|${r2(t.amount)}|${norm(t.tiers)}`;
      if (seen.has(k)){ if (same(t.amount, diff)) candidates.push({ kind:'dup', t, twin:seen.get(k) }); } else seen.set(k, t); });
    const dupIds = new Set(candidates.flatMap(c => [c.t, c.twin]));   // la paire entière : son jumeau n'est pas « en trop » en plus
    // une ligne en trop : le montant exact de l'écart, même signe
    upTo.filter(t => same(t.amount, diff) && !dupIds.has(t)).forEach(t => candidates.push({ kind:'extra', t }));
    // une ligne manquante : le montant opposé, en attente de validation ou à la corbeille
    (o.drafts||[]).filter(t => same(t.amount, -diff) && (!o.asOfIso || !t.iso || t.iso <= o.asOfIso)).forEach(t => candidates.push({ kind:'draft', t }));
    (o.trash||[]).filter(t => same(t.amount, -diff)).forEach(t => candidates.push({ kind:'trash', t }));
    // le solde d'ouverture du compte, s'il s'écarte de l'ouverture du premier relevé du montant de l'écart
    if (o.firstOpening != null && o.opening != null && same(r2(o.opening - o.firstOpening), diff)) candidates.push({ kind:'opening', opening:r2(o.opening), firstOpening:r2(o.firstOpening) });
  }
  return { diff, ok, candidates, afterCount: after.length, afterTotal: r2(after.reduce((s, t) => s + (Number(t.amount)||0), 0)) };
}

// statements = [{v, label, opening, closing, fromIso, asOfIso, …}] → { statements (triés par date), gaps:[{prev, next, diff}] }
function chain(statements){
  const s = (statements||[]).filter(st => st && st.closing != null && st.asOfIso).slice()
    .sort((a, b) => a.asOfIso.localeCompare(b.asOfIso) || (a.v||0) - (b.v||0));
  const gaps = [];
  for (let i = 1; i < s.length; i++){
    const p = s[i-1], n = s[i];
    if (n.opening != null && !same(n.opening, p.closing)) gaps.push({ prev:p, next:n, diff:r2(n.opening - p.closing) });
  }
  return { statements:s, gaps };
}

const api = { reconcile, chain };
root.LSRecon = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
