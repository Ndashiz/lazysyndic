/* ============================================================
   LazySyndic — couche de données vivante
   Source de vérité unique : les transactions, persistées en
   localStorage. Tout le reste (soldes, donut, graphe, table)
   en est dérivé. L'import CSV alimente ce store.
   ============================================================ */

'use strict';

/* ---------- Helpers monnaie / dates ---------- */
const eur = n => typeof LSPdf!=='undefined' ? LSPdf.fmt.eur(n) : (n).toLocaleString('fr-BE', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' €';   // format de référence : pdf.js
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + eur(Math.abs(n));

// Parse un montant texte FR/EN/BE → float. Gère "1.234,56", "1234.56",
// "−306,77", "(306,77)", " €", espaces insécables.
function parseAmount(raw){
  if (typeof raw === 'number') return raw;
  let s = String(raw).trim().replace(/ /g,' ').replace(/€|EUR/gi,'').trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1,-1); }
  s = s.replace(/[−–—]/g,'-'); // unicode minus → ascii
  if (/^-/.test(s)) { neg = true; s = s.replace(/^-/,''); }
  s = s.replace(/\s/g,'');
  // décider du séparateur décimal : le dernier . ou , rencontré
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) { s = s.replace(/\./g,'').replace(',','.'); }
  else { s = s.replace(/,/g,''); }
  const v = parseFloat(s);
  return isNaN(v) ? NaN : (neg ? -v : v);
}

// Normalise une date vers {iso:'YYYY-MM-DD', disp:'DD/MM/YY'} ; null si illisible.
function parseDate(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  let d, m, y;
  let mm;
  if ((mm = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y=+mm[1]; m=+mm[2]; d=+mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) { d=+mm[1]; m=+mm[2]; y=+mm[3]; }
  else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const pad = n => String(n).padStart(2,'0');
  return { iso:`${y}-${pad(m)}-${pad(d)}`, disp:`${pad(d)}/${pad(m)}/${String(y).slice(2)}`, y, m };
}

const norm = s => String(s||'').toLowerCase().replace(/\s+/g,' ').trim();

/* ---------- Taxonomie ---------- */
// Catégorie haut niveau → classe CSS (couleur) + couleur donut
const CAT_META = {
  // couleurs = jetons du design (primary, info, warning, sage, success, violet) — DESIGN.md
  'Énergie':         {cls:'',    color:'#005F45'},
  'Assurance':       {cls:'ass', color:'#3C76A9'},
  'Frais ACP':       {cls:'acp', color:'#B47819'},
  'Entretien':       {cls:'ent', color:'#72A689'},
  'Charges':         {cls:'in',  color:'#126B47'},
  'Fonds de réserve':{cls:'in',  color:'#6C5594'},
};
const CATS = Object.keys(CAT_META);
function catClass(high){ return (CAT_META[high]||{}).cls || ''; }
function isIncomeCat(high){ return high === 'Charges' || high === 'Fonds de réserve'; }
// Règle de gouvernance — COMPTE DE RÉSERVE : toute sortie de plus de 10 € du
// fonds de réserve (dépense exceptionnelle) doit être justifiée par un commentaire
// et est automatiquement signalée (flag). commentMissing = règle applicable mais
// commentaire absent.
const FDR_RULE = { account:'res', minOut:10 };
function commentRequired(t){ return !!t && t.account===FDR_RULE.account && t.amount < -FDR_RULE.minOut; }
function commentMissing(t){ return commentRequired(t) && !(t.comment && String(t.comment).trim()); }
function isFlagged(t){ return !!(t && (t.flag || commentRequired(t))); }
// Catégories = défauts + catégories personnalisées (settings.categories).
function allCats(){ const custom=((typeof state!=='undefined'&&state&&state.categories)||[]); return [...CATS, ...custom.filter(c=>c&&!CATS.includes(c))]; }
function addCategory(name){
  name=(name||'').trim(); if(!name) return '';
  if(allCats().includes(name)) return name;
  state.categories=state.categories||[]; state.categories.push(name);
  saveState(); dbWrite(db=>db.updateSettings({categories: state.categories}));
  return name;
}

// Sous-catégories : défauts par catégorie + personnalisées (state.subcats).
const SUBCAT_DEFAULTS = {
  'Énergie':          ['Électricité','Gaz','Eau','Chauffage'],
  'Assurance':        ['RC','Incendie','Dégâts des eaux'],
  'Frais ACP':        ['Banque','Frais de gestion','Divers'],
  'Entretien':        ['Nettoyage','Ascenseur','Jardin','Réparations','Communs'],
  'Charges':          ['Compte de paiement','Fonds de réserve'],
  'Fonds de réserve': [],
};
function subcatsOf(high){
  const base = SUBCAT_DEFAULTS[high] || [];
  const custom = ((typeof state!=='undefined' && state && state.subcats && state.subcats[high]) || []);
  return [...base, ...custom.filter(s=>s && !base.includes(s))];
}
function addSubcat(high, name){
  high=(high||'').trim(); name=(name||'').trim();
  if(!high || !name || high==='?') return '';
  if(subcatsOf(high).includes(name)) return name;
  state.subcats = state.subcats || {};
  (state.subcats[high] = state.subcats[high] || []).push(name);
  saveState(); dbWrite(db=>db.updateSettings({subcats: state.subcats}));
  return name;
}
// Options de sous-catégorie pour une catégorie donnée (+ « nouvelle… »).
function subcatOptions(high, sel){
  const opts=[{v:'',l:'— sans sous-catégorie'}, ...subcatsOf(high).map(s=>({v:s,l:s})), {v:'__new__',l:'➕ Nouvelle sous-catégorie…'}];
  return opts.map(o=>`<option value="${o.v}" ${sel===o.v?'selected':''}>${o.l}</option>`).join('');
}

/* ---------- État par défaut (graine = données de démo) ---------- */
// Transactions de démo (issues des annexes réelles, montants anonymisés).
// amount: float signé ; account: 'pay'|'res' ; high: catégorie haut niveau.
const SEED_TX = [
  // compte de paiement
  {date:'17/10/25', tiers:'Vivaqua',       high:'Énergie',   sub:'Eau',        amount:-306.77, account:'pay', note:'Facture eau Q3'},
  {date:'02/06/25', tiers:'Alex Martin',  high:'Charges',   sub:'',           amount:+79.39,  account:'pay', note:'Charge rdc et garage'},
  {date:'31/05/25', tiers:'SWAN',          high:'Frais ACP', sub:'Banque',     amount:-6.00,   account:'pay', note:'Account subscription', flag:true, comment:'Abonnement — vérifier si toujours utile'},
  {date:'12/05/25', tiers:'Engie',         high:'Énergie',   sub:'Électricité',amount:-88.40,  account:'pay', note:'Mensualité élec'},
  {date:'28/04/25', tiers:'AXA',           high:'Assurance', sub:'RC',         amount:-142.00, account:'pay', note:'Prime RC civile'},
  {date:'22/04/25', tiers:'Sam Bernard',  high:'Charges',   sub:'',           amount:+57.50,  account:'pay', note:'Provision'},
  {date:'09/03/25', tiers:'Electrabel',    high:'Énergie',   sub:'Électricité',amount:+4.43,   account:'pay', note:'Régularisation', flag:true, comment:'Remboursement — rapprocher du décompte annuel'},
  {date:'02/03/25', tiers:'Minimax',       high:'Entretien', sub:'Adoucisseur',amount:-61.00,  account:'pay', note:'Entretien adoucisseur'},
  {date:'02/03/25', tiers:'SWAN',          high:'Frais ACP', sub:'Banque',     amount:-0.60,   account:'pay', note:'SEPA transfer fee'},
  // compte de réserve
  {date:'02/06/25', tiers:'Lou Petit',high:'Charges', sub:'Fonds de réserve',    amount:+40.00,  account:'res', note:'Apport réserve'},
  {date:'02/06/25', tiers:'Alex Martin',  high:'Charges', sub:'Fonds de réserve',    amount:+80.00,  account:'res', note:'Apport réserve'},
  {date:'22/04/25', tiers:'Engie',         high:'Énergie',   sub:'Électricité',amount:-22.19,  account:'res', note:'Régul. sur réserve', flag:true, comment:'Dépense passée sur le mauvais compte ?'},
  {date:'02/03/25', tiers:'Sam Bernard',  high:'Charges', sub:'Fonds de réserve',    amount:+40.00,  account:'res', note:'Apport réserve'},
];

const SEED_RULES = [
  ['Electrabel','Énergie','Électricité'],['Vivaqua','Énergie','Eau'],['Engie','Énergie','Électricité'],
  ['SWAN','Frais ACP','Banque'],['AXA','Assurance','RC civile'],['Minimax','Entretien','Adoucisseur'],
  // vocabulaire courant des relevés Swan / Syndic4you
  ['Fond de reserve','Charges','Fonds de réserve'],['Fonds de réserve','Charges','Fonds de réserve'],
  ['Account subscription','Frais ACP','Banque'],['Abonnement','Frais ACP','Banque'],
];
// alias : libellé banque → [entité affichée, est-ce un copropriétaire ?, nom court]
const SEED_ALIASES = [
  ['BERNARD SAM','Sam Bernard',true,'Sam'],
  ['M. ALEX MARTIN','Alex Martin',true,'Alex'],
  ['PETIT LOU','Lou Petit',true,'Lou'],
  ['ELECTRABEL CUSTOMER SOL','Electrabel',false,''],
];
const SEED_CONTRACTS = [
  {name:'Electrabel',ref:'8767id',type:'Énergie',start:'21/01/25',note:'électricité communs',status:'actif',fournisseur:'Electrabel SA — 078 35 33 33'},
  {name:'AXA',ref:'RC-22841',type:'Assurance',start:'01/01/24',note:'RC civile copropriété',status:'actif',fournisseur:'AXA Belgium — courtier Dupont'},
  {name:'Vivaqua',ref:'EAU-3391',type:'Énergie',start:'15/03/23',note:'eau — compteur commun',status:'actif',fournisseur:'Vivaqua — 02 739 52 11'},
  {name:'Minimax',ref:'ADO-118',type:'Entretien',start:'10/06/24',note:'entretien adoucisseur',status:'actif',fournisseur:'Minimax SA'},
  {name:'Engie',ref:'GAZ-5520',type:'Énergie',start:'01/02/22',note:'ancien fournisseur gaz',status:'cloture',end:'31/01/25',endNote:'résilié — passage chez Electrabel',fournisseur:'Engie'},
];
const SEED_REMINDERS = [
  {tx:'Envoyer la convocation AG 2026', due:'fait', done:true},
  {tx:'Contacter le plombier — fuite cave', due:'cette sem.', done:false},
  {tx:'Relancer Sam pour le solde', due:'15 juin', done:false},
  {tx:'Importer relevé Swan de mai', due:'fait', done:true},
];
// Soldes d'ouverture : choisis pour que ouverture + Σ(tx démo) = solde affiché.
const SEED_OPENING = { pay:1358.70, res:358.62 };

/* ---------- Store ---------- */
// En ligne (Supabase configuré) : la source de vérité est la base partagée ;
// hors ligne (preview sans config) : repli localStorage avec données de démo.
// CONFIGURED : identifiants Supabase présents → connexion OBLIGATOIRE (fail-closed).
// ONLINE : configuré ET client Supabase chargé.
const CONFIGURED = !!(window.LS && window.LS.configured);
const ONLINE = !!(window.LS && window.LS.hasClient);
const LS_KEY = 'lazysyndic.v1';
// MODE DÉMO : l'admin teste en prod sur des données fictives locales ;
// aucune écriture ne part vers Supabase. Activé via l'icône de compte.
const DEMO_FLAG = 'lazysyndic.demo';
const DEMO_KEY  = 'lazysyndic.demo.state';
let demoMode = ONLINE && localStorage.getItem(DEMO_FLAG)==='1';
// On écrit dans Supabase seulement en ligne ET hors mode démo.
const writeToDb = () => ONLINE && !demoMode;
let state = CONFIGURED ? freshState() : loadState();   // si configuré, remplacé par boot()
const unlockApp = ()=>document.documentElement.classList.remove('ls-locked');
const lockApp   = ()=>document.documentElement.classList.add('ls-locked');

function freshState(){
  return {
    tx: SEED_TX.map(t => ({...t})),
    // Relevés importés mais pas encore vérifiés. Volontairement hors de `tx` : tant qu'une ligne
    // est là, elle ne pèse sur aucun solde, aucune réconciliation, aucun appel de fonds.
    draftTx: [],
    periods: [],   // exercices comptables (supabase/periods.sql) : clôturés = verrouillés
    rules: SEED_RULES.map(r => [...r]),
    aliases: SEED_ALIASES.map(a => [...a]),
    contracts: SEED_CONTRACTS.map(c => ({...c})),
    reminders: SEED_REMINDERS.map(r => ({...r})),
    opening: {...SEED_OPENING},
    // contributions suivies par copropriétaire (exercice courant). Éditable ;
    // remplacé par le calcul dérivé quand ledgerLive passe à true.
    contrib: { Alex:{due:1002, verse:1002}, Sam:{due:503, verse:503}, Lou:{due:499, verse:344.90} },
    ledgerLive: false,
    subcats: {},   // catégorie → [sous-catégories personnalisées]
    coproName: 'ACP Démo',
    reserveTarget: 2000,
    ibanMap: {},   // IBAN normalisé → 'pay' | 'res' (détection apprenante)
    timeline: [
      {date:'2026-03-09', title:'Régularisation Electrabel', description:'Remboursement en notre faveur sur le décompte annuel.', kind:'manual', subs:[]},
      {date:'2026-03-02', title:'Entretien adoucisseur', description:'Passage Minimax — contrat annuel.', kind:'manual',
        subs:[{title:'Contact client center', done:true},{title:'Rendez-vous fixé', done:true},{title:'Entretien fait', done:false}]},
    ],
    imports: [
      {v:4, label:'Relevé mai 2026', meta:'2 juin · 5 transactions ajoutées · 2 doublons', cur:true},
      {v:3, label:'Relevé mars 2026', meta:'4 avr. · 7 transactions'},
      {v:2, label:'Relevé février 2026', meta:'3 mars · 6 transactions'},
      {v:1, label:'Import initial 2025', meta:'12 janv. · 38 transactions'},
    ],
  };
}
function loadState(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    // Un état enregistré avant les brouillons n'a pas la liste : sans ce repli, le premier import
    // meurt sur un push d'undefined et l'écran ne dit rien.
    if (raw) return {draftTx: [], ...JSON.parse(raw)};
  } catch(e){ console.warn('localStorage illisible', e); }
  return freshState();
}
function saveState(){
  if (demoMode){ try { localStorage.setItem(DEMO_KEY, JSON.stringify(state)); } catch(e){} return; }
  if (ONLINE) return; // en ligne, la persistance passe par les écritures Supabase ciblées
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch(e){ console.warn('Sauvegarde impossible', e); }
}
// En démo, l'admin peut tout éditer localement. Sinon : hors-ligne, ou admin Supabase.
const canWrite = () => demoMode || !ONLINE || (window.LS && window.LS.canWrite);
// Persistance Supabase tolérante : exécute l'écriture, signale et recharge en cas d'échec.
// En mode démo, on n'écrit jamais dans Supabase (les changements restent locaux).
async function dbWrite(fn){
  if (!writeToDb()){ toastSaved(); return; }   // démo / hors-ligne : sauvegarde locale
  try { await fn(window.LS.db); toastSaved(); }
  catch(e){ console.error(e); toastError(e.message||e); }
}
// exposé pour debug / reset manuel
window.LazySyndic = { state:()=>state, reset(){ if(ONLINE){location.reload();return;} state = freshState(); saveState(); location.reload(); } };

/* ---------- Dérivations ---------- */
const txOf = acct => state.tx.filter(t => t.account === acct);
const sum = arr => arr.reduce((a,b)=>a+b, 0);

function balance(acct){
  return (state.opening[acct]||0) + sum(txOf(acct).map(t=>t.amount));
}
// Solde d'un compte à une date (ISO incluse) : ouverture + mouvements datés jusque-là.
function balanceAt(acct, toIso){
  return (state.opening[acct]||0) + sum(txOf(acct).filter(t=>{ const d=parseDate(t.date); return d && d.iso<=toIso; }).map(t=>t.amount));
}
/* ---------- Exercices comptables (supabase/periods.sql) ----------
   Un exercice clôturé fige ses soldes d'ouverture et de clôture, archive le rapport financier
   tel qu'approuvé, et verrouille ses mouvements : la base (trigger ls_transactions_closed_period)
   refuse montant, date, compte, catégorie, tiers, attribution, suppression et validation d'un
   brouillon ; seuls le drapeau et le commentaire restent libres. L'interface masque les gestes,
   la base les refuse. */
const periodsOf = () => (state.periods||[]);
const closedPeriods = () => periodsOf().filter(p=>p.closed_at);
function closedYearOf(iso){ const p=closedPeriods().find(x=>iso && iso>=x.starts && iso<=x.ends); return p ? +p.year : null; }
function txLocked(t){ const d=parseDate(t.date); return closedYearOf(d?d.iso:'')!=null; }
const lockMsg = t => { const d=parseDate(t.date); return `Exercice ${closedYearOf(d?d.iso:'')} clôturé : ce mouvement ne peut plus changer (drapeau et commentaire exceptés).`; };
const periodsHint = m => /ls_periods|schema cache|relation/i.test(m) ? m+' — lancez supabase/periods.sql dans Supabase (SQL Editor).' : m;
function receivables(){ // à recevoir = somme des soldes débiteurs des copropriétaires
  return sum(ownerLedger().filter(o=>o.solde<0).map(o=>-o.solde));
}

// Donut : dépenses (sorties) par catégorie haut niveau, sur un compte.
function donutData(acct){
  const out = txOf(acct).filter(t=>t.amount<0);
  const by = {};
  out.forEach(t => { by[t.high] = (by[t.high]||0) + Math.abs(t.amount); });
  const total = sum(Object.values(by)) || 1;
  return Object.entries(by)
    .sort((a,b)=>b[1]-a[1])
    .map(([high,v])=>({high, v, pct: Math.round(v/total*100), color:(CAT_META[high]||{}).color||'#999'}));
}

// Évolution mensuelle sur l'exercice courant (année du plus récent tx).
function monthlyData(acct){
  const tx = txOf(acct);
  if (!tx.length) return {labels:[], in:[], out:[], bal:[]};
  const years = tx.map(t=>parseDate(t.date)).filter(Boolean).map(d=>d.y);
  const year = Math.max(...years);
  const MON = ['Jan','Fév','Mar','Avr','Mai','Jun','Jui','Aoû','Sep','Oct','Nov','Déc'];
  const lastMonth = Math.max(...tx.map(t=>parseDate(t.date)).filter(d=>d&&d.y===year).map(d=>d.m), 1);
  const inA=[], outA=[], balA=[]; const labels=[];
  let running = state.opening[acct]||0;
  // solde de départ = ouverture + tx des années précédentes
  running += sum(tx.filter(t=>{const d=parseDate(t.date);return d&&d.y<year;}).map(t=>t.amount));
  for (let m=1; m<=lastMonth; m++){
    const mt = tx.filter(t=>{const d=parseDate(t.date);return d&&d.y===year&&d.m===m;});
    const i = sum(mt.filter(t=>t.amount>0).map(t=>t.amount));
    const o = sum(mt.filter(t=>t.amount<0).map(t=>-t.amount));
    running += i - o;
    labels.push(MON[m-1]); inA.push(i); outA.push(o); balA.push(running);
  }
  return {labels, in:inA, out:outA, bal:balA};
}

// Qui paie quoi. « dû » = provision annuelle attendue, posée par « Appliquer aux provisions »
// (Budget › Calcul des charges) ou saisie dans Provisions ; « versé » = entrées attribuées au
// copropriétaire, bornées à l'exercice du dû (ownerLedger, plus bas).
let OWNERS = [
  // Provisions 2026 (Annexe 4) : dû annuel paiement + réserve (mensuel ×12).
  {n:'Alex Martin', short:'Alex', q:500, c:'#2F6B53', due_pay:952.63, due_res:240.00},
  {n:'Sam Bernard', short:'Sam',  q:251, c:'#5B4B86', due_pay:744.54, due_res:168.00},
  {n:'Lou Petit',short:'Lou', q:249, c:'#C9854A', due_pay:742.87, due_res:168.00},
];
const ownersOf = () => (state.owners && state.owners.length) ? state.owners : OWNERS;

// Mappings intégrés (toujours actifs, en plus des règles utilisateur).
// Garantissent la catégorisation même sans règle en base ; les règles
// utilisateur restent prioritaires (testées avant). Libellés déjà normalisés.
const BUILTIN_RULES = [
  ['vivaqua','Énergie','Eau'],
  ['engie','Énergie','Électricité'],
  ['electrabel','Énergie','Électricité'],
  // frais & abonnement bancaires → toujours Frais ACP › Banque
  ['account subscription','Frais ACP','Banque'],
  ['abonnement','Frais ACP','Banque'],
];
// OWNER-DETECT-BEGIN — bloc pur (ni DOM ni réseau), extrait tel quel par tests/owner.test.mjs
// qui fournit norm, state et ownersOf. Ne rien mettre d'autre entre les deux marqueurs.
// Libellé (normalisé) → copropriétaire (nom court), appliqué seulement si ce copropriétaire
// existe. Vide volontairement : les libellés propres à une copropriété (« Charge rdc et
// garage », un nom de jeune fille…) vivent dans ls_settings.owner_rules, appris dans l'app
// (attribution à la main) ou posés en SQL. Rien de nominatif dans le code : le dépôt est public.
const BUILTIN_OWNERS = [];

// Détection auto du copropriétaire d'après le libellé (fallback si non attribué).
// Dans l'ordre : 0. la communication structurée du copropriétaire, si le libellé en porte une
// valide ; 1. la règle apprise sur ce libellé exact (une attribution faite à la
// main, dans la liste ou l'aperçu d'import) ; 2. le nom d'un copropriétaire, court ou
// complet, en mot entier dans le libellé ou la note ; 3. les règles apprises par
// sous-chaîne ; 4. les libellés intégrés. Une règle vers un copropriétaire qui n'existe
// plus est ignorée.
// Les règles apprises passaient en premier : « fond de reserve » → Alex, apprise sur
// une ligne d'Alex, attrapait aussi « FOND DE RESERVE - LOU ». Le nom l'emporte
// désormais sur une règle plus courte que lui ; seule une règle posée sur le libellé
// entier le bat.
function detectOwner(t){
  const tiers = norm(t.tiers), hay = norm(t.tiers + ' ' + (t.note||''));
  const om = (typeof state!=='undefined'&&state&&state.ownerRules)||{};
  const owners = ownersOf(), exists = short => owners.some(o=>o.short===short);
  // 0. la communication structurée du copropriétaire (+++123/4567/89012+++, posée par LazySyndic sur
  //    chaque appel de fonds) : déterministe, elle passe avant tout. Contrôle : reste mod 97 (0 → 97).
  const og = /(?:\+{3}|\*{3})?\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*(?:\+{3}|\*{3})?/.exec(t.tiers + ' ' + (t.note||''));
  if (og){ const d = og[1]+og[2]+og[3], r = Number(d.slice(0,10)) % 97;
    if (d.slice(10) === String(r === 0 ? 97 : r).padStart(2,'0')){ const byOgm = owners.find(o => String(o.ogm||'').replace(/\D/g,'') === d); if (byOgm) return byOgm.short; } }
  if (om[tiers] && exists(om[tiers])) return om[tiers];
  const word = s => !!s && new RegExp('(^|[^\\p{L}\\p{N}])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u').test(hay);
  const named = owners.find(o => word(norm(o.short)) || word(norm(o.n)));
  if (named) return named.short;
  for (const lbl in om){ if(lbl && hay.includes(lbl) && exists(om[lbl])) return om[lbl]; }   // libellés déjà normalisés (appris)
  for (const [lbl, short] of BUILTIN_OWNERS){ if(hay.includes(lbl) && exists(short)) return short; }
  return '';
}
// OWNER-DETECT-END
// Options de catégorie réutilisables (import + liste).
function categoryOptions(sel){
  return [...allCats().map(c=>({v:c,l:c})), {v:'?',l:'À catégoriser'}, {v:'__new__',l:'➕ Nouvelle catégorie…'}]
    .map(o=>`<option value="${o.v}" ${(sel===o.v||(o.v==='?'&&(sel==='?'||!sel)))?'selected':''}>${o.l}</option>`).join('');
}
// Apprentissage : mémorise libellé→catégorie (règle) et libellé→copro (owner_rules).
function learnCategory(label, high){
  if(!canWrite()||!label||!high||high==='?') return;
  const ln=norm(label); const r=state.rules.find(r=>norm(r[0])===ln);
  if(r){ if(r[1]!==high){ r[1]=high; r[2]=''; dbWrite(db=>db.updateRule(r[3],{high,sub:''})); } }
  else { const nr=[label,high,'',null]; state.rules.push(nr); dbWrite(async db=>{ const s=await db.addRule({label,high,sub:''}); nr[3]=s.id; }); }
}
// Apprentissage de la sous-catégorie : mémorise tiers→sous-catégorie sur la règle.
function learnSubcat(label, high, sub){
  if(!canWrite()||!label||!high||high==='?') return;
  const ln=norm(label); const r=state.rules.find(r=>norm(r[0])===ln);
  if(r){ if(r[2]!==sub){ r[2]=sub; dbWrite(db=>db.updateRule(r[3],{sub})); } }
  else { const nr=[label,high,sub,null]; state.rules.push(nr); dbWrite(async db=>{ const s=await db.addRule({label,high,sub}); nr[3]=s.id; }); }
}
// Catégorie + sous-catégorie en une seule écriture de règle (learnCategory puis
// learnSubcat sur une règle neuve écrirait la sous-catégorie avant que l'id existe).
function learnRule(label, high, sub){
  if(!canWrite()||!label||!high||high==='?') return;
  const ln=norm(label); const r=state.rules.find(r=>norm(r[0])===ln);
  if(r){ if(r[1]!==high||(r[2]||'')!==sub){ r[1]=high; r[2]=sub; dbWrite(db=>db.updateRule(r[3],{high,sub})); } }
  else { const nr=[label,high,sub,null]; state.rules.push(nr); dbWrite(async db=>{ const s=await db.addRule({label,high,sub}); nr[3]=s.id; }); }
}
// Sélecteur unique catégorie › sous-catégorie (liste des transactions + détail).
// Valeur d'une option : « catégorie<TAB>sous-catégorie ».
const CAT_SEP='\t';
function catPickOptions(high, sub){
  high=high||'?'; sub=sub||'';
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  const opt=(h,s,l)=>`<option value="${esc(h+CAT_SEP+s)}"${h===high&&s===sub?' selected':''}>${esc(l)}</option>`;
  const cats=allCats(); if(high!=='?' && !cats.includes(high)) cats.push(high);   // catégorie hors liste : garder la valeur actuelle
  const groups=cats.map(c=>{
    const subs=subcatsOf(c); if(c===high && sub && !subs.includes(sub)) subs.push(sub);
    return `<optgroup label="${esc(c)}">${opt(c,'',c)}${subs.map(s=>opt(c,s,c+' › '+s)).join('')}</optgroup>`;
  }).join('');
  return groups + opt('?','','À catégoriser')
    + `<option value="__new__">➕ Nouvelle catégorie…</option>`
    + (high!=='?' ? `<option value="__newsub__">➕ Nouvelle sous-catégorie de « ${esc(high)} »…</option>` : '');
}
// Applique un choix du sélecteur à une transaction : état, Supabase, règle
// apprise, puis les vues qui lisent la catégorie. false = annulé ou inchangé.
function setTxCategory(t, value){
  if(!canWrite()||!t) return false;
  if(txLocked(t)){ showToast(lockMsg(t), 'err'); return false; }
  let high, sub='';
  if(value==='__new__'){ high=addCategory(prompt('Nouvelle catégorie :','')||''); if(!high) return false; }
  else if(value==='__newsub__'){ high=t.high; sub=addSubcat(high, prompt('Nouvelle sous-catégorie pour « '+high+' » :','')||''); if(!sub) return false; }
  else { [high, sub=''] = String(value).split(CAT_SEP); }
  if(!high || (high===t.high && sub===(t.sub||''))) return false;
  t.high=high; t.sub=sub;
  dbWrite(db=>db.updateTransaction(t.id,{high, sub}));
  learnRule(t.tiers, high, sub);
  saveState();
  renderTx(curAcct); renderDashboard(); renderComptabilite();
  return true;
}
function learnOwner(label, short){
  if(!canWrite()||!label) return;
  state.ownerRules=state.ownerRules||{}; const ln=norm(label);
  if(short) state.ownerRules[ln]=short; else delete state.ownerRules[ln];
  dbWrite(db=>db.updateSettings({owner_rules: state.ownerRules}));
}
// Copropriétaire effectif : attribution explicite (t.owner) sinon auto.
function ownerOfTx(t){ return (t.owner!==undefined && t.owner!=='') ? t.owner : detectOwner(t); }
function ownerOptions(sel){
  return '<option value="">—</option>' + ownersOf().map(o=>`<option value="${o.short}" ${o.short===sel?'selected':''}>${o.n}</option>`).join('');
}
// Versé = somme des entrées attribuées au copro, sur un compte (ou tous), entre deux dates ISO
// incluses (facultatives). Une entrée sans date lisible compte comme antérieure à tout.
function verseFromTx(o, acct, from, to){
  return sum(state.tx.filter(t => {
    if (!(t.amount>0 && (!acct||t.account===acct) && ownerOfTx(t)===o.short)) return false;
    if (!from && !to) return true;
    const d = parseDate(t.date), iso = d ? d.iso : '';
    return (!from || iso>=from) && (!to || iso<=to);
  }).map(t=>t.amount));
}
// L'exercice du dû : celui du dernier budget appliqué aux provisions (le dû de chacun en vient),
// sinon l'année civile. Le dû est annuel ; le versé doit l'être aussi.
function appliedYears(){
  return Object.keys(state.charges||{}).filter(y=>/^\d{4}$/.test(y) && (state.charges[y]||{}).applied).map(Number).sort((a,b)=>a-b);
}
function ledgerYear(){ const ys=appliedYears(); return ys.length ? ys[ys.length-1] : new Date().getFullYear(); }
// Dû d'un copropriétaire pour un exercice appliqué : figé à l'application (applied.byOwner), sinon
// recalculé depuis le budget de l'époque (budgets appliqués avant que byOwner n'existe).
function appliedDue(o, y){
  const b=(state.charges||{})[y]; if(!b||!b.applied) return 0;
  const key=o.id||o.short||o.n, bo=b.applied.byOwner||{};
  if (bo[key]) return (+bo[key].pay||0)+(+bo[key].res||0);
  try { const s=budgetSplit(y), i=chargesOwners().findIndex(x=>x.key===key); return i>=0 ? s.total[i] : 0; } catch(e){ return 0; }
}
// Les budgets appliqués avant que l'application ne fige la part de chacun (applied.byOwner) la
// reçoivent une fois, pour que le bridge Jarvis, qui n'a pas charges.js, lise le même dû.
function backfillAppliedByOwner(){
  if (!canWrite()) return;
  let changed=false;
  appliedYears().forEach(y=>{
    const b=state.charges[y]; if (b.applied.byOwner) return;
    try { const s=budgetSplit(y); b.applied.byOwner=Object.fromEntries(chargesOwners().map((o,i)=>[o.key, {pay:s.charges[i].annual, res:s.res[i].reserve}])); changed=true; } catch(e){}
  });
  if (changed) dbWrite(db=>db.updateSettings({charges: state.charges}));
}
// Le grand livre par copropriétaire, borné à l'exercice du dû. Avant, le versé cumulait toutes les
// entrées depuis le premier relevé contre un dû annuel : dès le deuxième budget appliqué, chacun
// paraissait créditeur de ses versements des années d'avant, et plus aucun retard ne se voyait.
//   report = versements d'avant l'exercice − dû des exercices appliqués d'avant
//   solde  = report + versé de l'exercice − dû de l'exercice
// Sans budget appliqué avant l'exercice, les versements antérieurs comptent entiers (rien ne dit
// ce qui était dû) : c'est l'ancien calcul, à l'identique. Même règle dans bridge/alerts.js.
function ownerLedger(){
  const y=ledgerYear(), from=`${y}-01-01`, to=`${y}-12-31`, prior=appliedYears().filter(k=>k<y);
  return ownersOf().map(o => {
    const duePay = +(o.due_pay||0), dueRes = +(o.due_res||0), due = duePay+dueRes;
    const versePay = verseFromTx(o,'pay',from,to), verseRes = verseFromTx(o,'res',from,to), verse = versePay+verseRes;
    const before = verseFromTx(o, null, null, `${y-1}-12-31`);
    const report = Math.round((before - sum(prior.map(k=>appliedDue(o,k))))*100)/100;
    return {...o, year:y, duePay, dueRes, due, versePay, verseRes, verse, report, solde: Math.round((report+verse-due)*100)/100};
  });
}

/* ============================================================
   NAVIGATION
   ============================================================ */
document.querySelectorAll('.nav button[data-s]').forEach(b=>{
  if(b.disabled) return;
  b.onclick=()=>{
    document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    const s=b.dataset.s; if(s==='dash2') return;
    document.querySelectorAll('.screen').forEach(x=>x.classList.remove('on'));
    document.getElementById(s).classList.add('on');
    window.scrollTo({top:0});   // un écran s'ouvre par le haut, pas là où le précédent avait défilé
    if(s==='cpta') renderComptabilite();
    animateBars();
  };
});
function animateBars(){ document.querySelectorAll('.fill[data-w]').forEach(f=>{ setTimeout(()=>f.style.width=f.dataset.w+'%',120); }); }

/* ---- Liens profonds (#imp, #acc?filter=unmapped) ------------------------------
   La routine mensuelle de Jarvis envoie ici : elle doit pouvoir déposer l'utilisateur
   directement sur l'import, ou sur la liste filtrée des mouvements à catégoriser,
   sans qu'il ait à retrouver l'écran lui-même. */
function goToScreen(id){
  const btn = document.querySelector(`.nav button[data-s="${id}"]`);
  if(!btn || btn.disabled) return false;
  btn.click();
  window.scrollTo({top:0, behavior:'smooth'});
  return true;
}
function applyDeepLink(){
  const raw = (location.hash || '').replace(/^#/, '');
  if(!raw) return;
  const [screen, query] = raw.split('?');
  if(!goToScreen(screen)) return;
  const filter = new URLSearchParams(query || '').get('filter');
  if(filter === 'unmapped'){
    // « À catégoriser » = high '?', la même valeur que pose l'import.
    const cf = document.getElementById('catFilter');
    if(cf){ cf.value = '?'; catFilter = '?'; renderTx(curAcct); }
  }
}
window.addEventListener('hashchange', applyDeepLink);

/* ============================================================
   DASHBOARD (dérivé)
   ============================================================ */
function renderDashboard(){
  const balPay = balance('pay'), balRes = balance('res');
  const recv = receivables();
  // KPIs soldes
  const kpis = document.querySelectorAll('#dash .kpis .kpi .v');
  if (kpis.length>=4){
    kpis[0].textContent = eur(balPay);
    kpis[1].textContent = eur(balRes);
    kpis[2].textContent = signed(recv);
    kpis[3].textContent = eur(0);                    // aucune dette fournisseur suivie : zéro, sans signe
    kpis[2].style.color = recv ? 'var(--green)' : 'var(--ink-soft)';
    kpis[3].style.color = 'var(--ink-soft)';
  }
  // qui paie quoi
  const tbl = document.getElementById('ownersTbl');
  if (tbl){
    const ledger = ownerLedger(), ly = ledger.length ? ledger[0].year : '';
    tbl.innerHTML = `<tr><th>Propriétaire</th><th class="num">Quotité</th><th class="num">Dû ${ly}</th><th class="num">Versé ${ly}</th><th class="num">Solde</th><th></th></tr>` +
      ledger.map(o=>{
        const late = o.solde < -0.005;
        const rep = Math.abs(o.report)>=0.005 ? `<div class="sub" style="font-size:11px">report ${o.report<0?'−':'+'}${eur(Math.abs(o.report))}</div>` : '';
        return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${o.short[0]}</span> ${o.n}</div></td>
          <td class="num">${o.q}</td>
          <td class="num">${eur(o.due)}</td>
          <td class="num">${eur(o.verse)}</td>
          <td class="num"${late?' style="color:var(--coral)"':''}>${o.solde<0?'−':''}${eur(Math.abs(o.solde))}${rep}</td>
          <td><span class="badge ${late?'b-late':'b-ok'}">${late?'En retard':'À jour'}</span></td></tr>`;
      }).join('');
  }
  renderDonut('dash', 'pay');
}

function renderDonut(scope, acct){
  const wrap = document.querySelector(`#${scope} .donut-wrap`);
  if (!wrap) return;
  const data = donutData(acct);
  const donut = wrap.querySelector('.donut');
  const legend = wrap.querySelector('.legend');
  if (!data.length){
    if (donut) donut.style.background = 'var(--line-2)';
    if (legend) legend.innerHTML = '<div class="sub">Aucune dépense sur la période</div>';
    return;
  }
  // conic-gradient cumulé
  let acc = 0; const stops = [];
  data.forEach(d=>{ const next = acc + d.pct; stops.push(`${d.color} ${acc}% ${next}%`); acc = next; });
  if (acc < 100 && stops.length) stops.push(`${data[data.length-1].color} ${acc}% 100%`);
  if (donut) donut.style.background = `conic-gradient(${stops.join(',')})`;
  if (legend) legend.innerHTML = data.map(d=>
    `<div><span class="sw" style="background:${d.color}"></span> ${d.high} <span class="pct">${d.pct} %</span></div>`).join('');
}

/* ---------- Pense-bête ---------- */
let showRemHistory = false;
// Échéance : date ISO → JJ/MM/AAAA + indice (en retard / aujourd'hui / dans Nj).
// Tolère l'ancien texte libre (« cette sem. »).
function fmtDue(due){
  if(!due) return '';
  const m=String(due).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return due;
  const label=`${m[3]}/${m[2]}/${m[1]}`;
  const d=new Date(+m[1],+m[2]-1,+m[3]); const today=new Date(); today.setHours(0,0,0,0);
  const diff=Math.round((d-today)/86400000);
  if(diff<0)  return `<span style="color:var(--coral);font-weight:600">${label} · en retard</span>`;
  if(diff===0)return `<span style="color:var(--clay);font-weight:600">aujourd'hui</span>`;
  if(diff<=7) return `<span style="color:var(--clay)">${label} · dans ${diff}j</span>`;
  return label;
}
function renderReminders(){
  const box = document.getElementById('rems'); if (!box) return;
  const active = state.reminders.filter(r=>!r.done)
    .sort((a,b)=>(a.due||'￿').localeCompare(b.due||'￿'));
  const doneList = state.reminders.filter(r=>r.done);
  box.innerHTML = active.length
    ? active.map(r=>{ const i=state.reminders.indexOf(r);
        return `<div class="rem" data-i="${i}"><div class="chk"></div><div class="tx">${r.tx}</div><div class="due">${fmtDue(r.due)}</div></div>`; }).join('')
    : '<div class="sub" style="padding:10px 2px">Rien à faire pour l’instant.</div>';
  const hist = document.getElementById('remsHistory');
  if (hist) hist.innerHTML = doneList.map(r=>{ const i=state.reminders.indexOf(r);
    return `<div class="rem done" data-i="${i}"><div class="chk">✓</div><div class="tx">${r.tx}</div><div class="due">fait · cliquer pour rouvrir</div></div>`; }).join('');
  const count=document.getElementById('remCount');
  if (count) count.textContent = `${active.length} à faire · ${doneList.length} fait${doneList.length>1?'s':''}`;
  const tgl=document.getElementById('remHistoryToggle');
  if (tgl){ tgl.style.display = doneList.length?'block':'none'; tgl.textContent = (showRemHistory?'Masquer':'Voir')+` l'historique (${doneList.length})`; }
  const wrap=document.getElementById('remHistoryWrap');
  if (wrap) wrap.style.display = (showRemHistory && doneList.length)?'block':'none';
}
function toggleReminder(i){
  if(!canWrite()){ return; }
  const rem=state.reminders[i]; if(!rem) return;
  rem.done=!rem.done; saveState(); renderReminders();
  dbWrite(db=>db.updateReminder(rem.id, {done:rem.done}));
  if(rem.done) logTimeline({title:'Tâche terminée', description:rem.tx, kind:'task'});  // audit
}
function addReminderFromInput(){
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const inp=document.getElementById('remAddInput'), dueInp=document.getElementById('remAddDue');
  const tx=inp.value.trim(); if(!tx){ inp.focus(); return; }
  const rem={tx, due:dueInp.value.trim(), done:false};
  state.reminders.push(rem);
  inp.value=''; dueInp.value='';
  document.getElementById('remAddRow').style.display='none';
  document.getElementById('remAddBtn').style.display='block';
  saveState(); renderReminders();
  dbWrite(async db=>{ const saved=await db.addReminder({tx:rem.tx, due:rem.due, done:false}); rem.id=saved.id; });
  logTimeline({title:'Tâche ajoutée', description:rem.tx, kind:'task'});  // audit
}
document.getElementById('rems')?.addEventListener('click',e=>{ const r=e.target.closest('.rem'); if(r) toggleReminder(+r.dataset.i); });
document.getElementById('remsHistory')?.addEventListener('click',e=>{ const r=e.target.closest('.rem'); if(r) toggleReminder(+r.dataset.i); });
document.getElementById('remHistoryToggle')?.addEventListener('click',()=>{ showRemHistory=!showRemHistory; renderReminders(); });
document.getElementById('remAddBtn')?.addEventListener('click',()=>{
  if(!canWrite()){ alert('Lecture seule.'); return; }
  document.getElementById('remAddRow').style.display='flex';
  document.getElementById('remAddBtn').style.display='none';
  document.getElementById('remAddInput').focus();
});
document.getElementById('remAddSave')?.addEventListener('click', addReminderFromInput);
document.getElementById('remAddInput')?.addEventListener('keydown',e=>{ if(e.key==='Enter') addReminderFromInput(); });

/* ============================================================
   COMPTES — table de transactions (dérivée)
   ============================================================ */
let curAcct = 'pay';
let flagOnly = false;
let catFilter='', dirFilter='', ownerFilter='';
let catPicking = null;       // transaction (l'objet : en démo les ids sont null) dont on change la catégorie depuis son badge
const ownerDisp = sh => { const o=ownersOf().find(x=>(x.short||x.n)===sh); return o?o.n:(sh||''); };
function populateTxFilters(){
  const cf=document.getElementById('catFilter');
  if(cf){ const cur=cf.value; cf.innerHTML='<option value="">Toutes catégories</option>'
    + allCats().map(c=>`<option value="${c}" ${c===cur?'selected':''}>${c}</option>`).join('')
    + `<option value="?" ${cur==='?'?'selected':''}>À catégoriser</option>`; }
  const of=document.getElementById('ownerFilter');
  if(of){ const cur=of.value; of.innerHTML='<option value="">Tous les copropriétaires</option>'
    + ownersOf().map(o=>`<option value="${o.short}" ${o.short===cur?'selected':''}>${o.n}</option>`).join(''); }
}

let txCssDone=false;
function ensureTxCss(){
  if(txCssDone) return; txCssDone=true;
  const s=document.createElement('style');
  s.textContent=`
    .cmt-mark{display:inline-flex;align-items:center;gap:5px;margin-top:3px;font-size:11.5px;color:var(--warning-ink);
      background:var(--clay-soft);border-radius:8px;padding:2px 8px;max-width:100%;cursor:help;line-height:1.4}
    .tx-row.editing>td{background:var(--card-2)}
    .tx-row.editing>td:first-child{box-shadow:inset 3px 0 0 var(--green)}
    .tx-row.req>td{background:rgba(194,86,74,.06)}
    .tx-row.req>td:first-child{box-shadow:inset 3px 0 0 var(--coral)}
    .cmt-req-lbl{font-size:11.5px;color:var(--coral);font-weight:600;margin-top:4px}
    .fld.tx-comment.req{border-color:var(--coral);background:var(--coral-soft)}
    .fdr-warn{display:flex;align-items:center;gap:9px;background:var(--coral-soft);color:var(--coral);
      border:1px solid oklch(.88 .05 30);border-radius:11px;padding:9px 14px;font-size:13px;font-weight:600;margin-bottom:10px}
    .fdr-warn .lk{color:var(--coral);text-decoration:underline;font-weight:700;margin-left:auto;cursor:pointer}
    .lk.tx-edit:hover,.lk.tx-done:hover{text-decoration:underline}
    .cat-pick{border:0;font-family:inherit;cursor:pointer;line-height:inherit;min-height:28px}
    .cat-pick .caret{margin-left:4px;font-size:9px;opacity:.45}
    .cat-pick:hover{box-shadow:inset 0 0 0 1.5px currentColor}
    .cat-pick:hover .caret{opacity:1}
    .recon-why{flex-basis:100%;margin:4px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink);display:grid;gap:4px;line-height:1.45}
    .recon-why .lk{font-size:12px;min-height:24px;padding:0 4px}
    .tx-lock{display:inline-grid;place-items:center;width:18px;height:18px;color:var(--ink-faint)}
    .tx-row.locked .cat{opacity:.9}
    #txtable .tx-cell b{max-width:360px;font-weight:600}
    #txtable .tx-cell small.tx-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;max-width:none;white-space:normal;overflow:visible;text-overflow:clip;margin-top:4px;font-size:11.5px}
    #txtable .tx-note{color:var(--muted-foreground);min-width:0}
    #txtable .tx-date{white-space:nowrap}
    #txtable .flagbtn,#txtable .tx-more{width:32px;height:32px;color:var(--ink-faint)}
    #txtable .flagbtn.on{color:var(--warning-ink)}
    #txtable .flagbtn.on svg{fill:currentColor}
    #txtable .cmt-mark{margin-top:0}`;
  document.head.appendChild(s);
}
// Bannière « sorties > 10 € à justifier » (compte de réserve — dépenses exceptionnelles).
function renderFdrWarn(acct){
  const tools=document.getElementById('txTools'); if(!tools) return;
  let warn=document.getElementById('fdrWarn');
  if(!warn){ warn=document.createElement('div'); warn.id='fdrWarn'; tools.parentNode.insertBefore(warn, tools); }
  const pend = txOf(acct).filter(commentMissing).length;
  warn.innerHTML = pend
    ? `<div class="fdr-warn">⚠ ${pend} sortie(s) de plus de ${FDR_RULE.minOut} € sans commentaire — justification obligatoire.<span class="lk" id="fdrFilter">Voir</span></div>`
    : '';
  const f=document.getElementById('fdrFilter');
  if(f) f.onclick=()=>{ // filtre : seulement les flaggées (inclut ces sorties)
    const ff=document.getElementById('flagFilter'); if(ff && !ff.classList.contains('on')) ff.click();
  };
}
let txSelectMode = false;   // mode « Sélectionner » : des cases à cocher pour la corbeille, rien d'autre
// La liste des mouvements, sur le gabarit du design (.tx-cell) : état · mouvement (tiers, catégorie,
// communication, versé par, commentaire) · date · montant · statut · détail. Tout ce qui s'édite
// (catégorie, attribution, commentaire, drapeau, scission, corbeille) vit dans la fiche (⋯), sauf
// le badge de catégorie, cliquable sur place.
function renderTx(acct){
  curAcct = acct;
  ensureTxCss();
  populateTxFilters();
  const tb = document.getElementById('txbody'); if(!tb) return;
  tb.innerHTML = '';
  const rows = txOf(acct).slice().sort((a,b)=>{
    const da=parseDate(a.date), db=parseDate(b.date);
    return (db?db.iso:'').localeCompare(da?da.iso:'');
  });
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const short = (s, n) => { s=String(s||'').trim(); return s.length>n ? s.slice(0,n-1)+'…' : s; };
  const lockSvg = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  const flagSvg = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-7.333-2A6 6 0 0 0 4 15"/></svg>';
  const moreSvg = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';
  rows.forEach(t=>{
    if (flagOnly && !isFlagged(t)) return;
    if (catFilter && (catFilter==='?'? t.high!=='?' : t.high!==catFilter)) return;
    if (dirFilter==='in'  && t.amount<0) return;
    if (dirFilter==='out' && t.amount>0) return;
    if (ownerFilter && ownerOfTx(t)!==ownerFilter) return;
    const reqMiss = commentMissing(t), locked = txLocked(t), hasC = !!(t.comment && t.comment.trim());
    const tr=document.createElement('tr'); tr.className='tx-row'+(isFlagged(t)?' flag':'')+(reqMiss?' req':'')+(locked?' locked':'');
    const catLabel = (t.high==='?'?'À catégoriser':t.high) + (t.sub?(' · '+t.sub):'');
    const picking = catPicking===t;
    const catCell = picking
      ? `<select class="fld tx-catpick quick" style="font-size:12px;padding:4px 6px;max-width:240px">${catPickOptions(t.high, t.sub)}</select>`
      : canWrite() && !locked && !txSelectMode
        ? `<button class="cat cat-pick ${catClass(t.high)}" title="Changer la catégorie">${catLabel}<span class="caret">▾</span></button>`
        : `<span class="cat ${catClass(t.high)}">${catLabel}</span>`;
    const who = t.amount>0 ? `Versé par <b>${escH(ownerDisp(ownerOfTx(t))||'—')}</b>` : '';
    const line2 = [who, hasC ? `<span class="cmt-mark" title="${esc(t.comment)}">${escH(short(t.comment,48))}</span>` : ''].filter(Boolean).join(' · ');
    const st = reqMiss ? ['danger','Commentaire obligatoire'] : (!t.high||t.high==='?') ? ['warning','À catégoriser'] : t.flag ? ['warning','À revoir'] : ['success','Classé'];
    const first = txSelectMode && canWrite() && !locked
      ? `<input type="checkbox" class="tx-sel" data-id="${t.id}" aria-label="Sélectionner ${esc(t.tiers)}">`
      : locked ? `<span class="tx-lock" title="Exercice ${closedYearOf((parseDate(t.date)||{}).iso)} clôturé">${lockSvg}</span>`
      : `<button class="icon-btn flagbtn${t.flag?' on':''}" type="button" aria-pressed="${t.flag?'true':'false'}" aria-label="À revoir" title="${t.flag?'Ne plus marquer « à revoir »':'Marquer « à revoir »'}">${flagSvg}</button>`;
    tr.innerHTML = `<td class="tx-selcell">${first}</td>
      <td><div class="tx-cell"><div style="min-width:0"><b title="${esc(t.tiers)}">${escH(t.tiers)}</b>
        <small class="tx-line">${catCell}${t.note?` <span class="tx-note" title="${esc(t.note)}">${escH(short(t.note,70))}</span>`:''}</small>
        ${line2?`<small class="tx-line">${line2}</small>`:''}</div></div></td>
      <td class="tx-date">${t.date}</td>
      <td class="num ${t.amount>=0?'pos':'neg'}">${signed(t.amount)}</td>
      <td><span class="status ${st[0]}">${st[1]}</span></td>
      <td><button class="icon-btn tx-more" type="button" aria-label="Détail du mouvement" title="Détail : commentaire, attribution, scission">${moreSvg}</button></td>`;
    const fb = tr.querySelector('.flagbtn');
    if (fb) fb.onclick=()=>{ if(!canWrite()) return; t.flag=!t.flag; saveState(); renderTx(acct); dbWrite(db=>db.updateTransaction(t.id, {flag:t.flag})); };
    // changer la catégorie : clic sur le badge → sélecteur sur place
    const pickBtn = tr.querySelector('.cat-pick');
    if (pickBtn) pickBtn.onclick = ()=>{
      if(!canWrite()) return;
      catPicking = t; renderTx(acct);
      const s = document.querySelector('#txbody .tx-catpick.quick');
      if (s){ s.focus(); try{ s.showPicker(); }catch(_){} }   // showPicker absent de certains navigateurs
    };
    const psel = tr.querySelector('.tx-catpick');
    if (psel){
      psel.onchange = ()=>{ catPicking = null; if (!setTxCategory(t, psel.value)) renderTx(acct); };   // annulé : remet la ligne d'aplomb
      // différé : un clic sur un autre badge passe avant et prend la main
      psel.onblur = ()=>setTimeout(()=>{ if(catPicking!==t) return; catPicking=null; renderTx(acct); }, 150);
      psel.onkeydown = e=>{ if(e.key==='Escape'){ catPicking=null; renderTx(acct); } };
    }
    tr.querySelector('.tx-more').onclick=()=>showTxDetail(t);
    tr.style.cursor='pointer';
    tr.addEventListener('click', e=>{ if(e.target.closest('input,select,button,a,.cmt-mark')) return; showTxDetail(t); });
    tb.appendChild(tr);
  });
  if (!tb.children.length){
    const filtered = flagOnly||catFilter||dirFilter||ownerFilter;
    tb.innerHTML = `<tr><td colspan="6" class="sub" style="padding:16px">Aucune transaction ${filtered?'ne correspond aux filtres':'sur ce compte'}.</td></tr>`;
  }
  renderFdrWarn(acct);
  renderTxTools(acct);
}
// Barre d'outils : « Sélectionner » révèle les cases à cocher ; la corbeille n'est qu'à ce prix.
function renderTxTools(acct){
  const head=document.getElementById('txSelHead'), tools=document.getElementById('txTools');
  if(!tools) return;
  const all=txOf(acct);
  if(!canWrite() || !all.length){ tools.style.display='none'; if(head) head.innerHTML=''; txSelectMode=false; return; }
  tools.style.display='flex';
  if(head) head.innerHTML = txSelectMode ? '<input type="checkbox" id="txSelAll" title="Tout sélectionner" aria-label="Tout sélectionner">' : '';
  const selAll=document.getElementById('txSelAll');
  if(selAll) selAll.onchange=()=>{ document.querySelectorAll('#txbody .tx-sel').forEach(c=>{ if(!c.closest('tr').style.display) c.checked=selAll.checked; }); updateTxToolsCount(); };
  tools.innerHTML = txSelectMode
    ? `<button class="btn btn-ghost" id="txDelSel" disabled style="opacity:.5">Mettre à la corbeille (<span id="txSelN">0</span>)</button>
       <button class="btn btn-ghost" id="txSelOff">Terminer</button>
       <span class="sub">Cochez les mouvements à retirer · récupérables 7 jours · un exercice clôturé ne se coche pas</span>`
    : `<button class="btn btn-ghost" id="txSelOn">Sélectionner</button>
       <button class="btn btn-ghost" id="txDelAll" style="color:var(--danger);margin-left:auto">Tout supprimer ce compte (${all.length})</button>`;
  document.getElementById('txDelSel')?.addEventListener('click', ()=>deleteSelectedTx(acct));
  document.getElementById('txSelOn')?.addEventListener('click', ()=>{ txSelectMode=true; renderTx(acct); });
  document.getElementById('txSelOff')?.addEventListener('click', ()=>{ txSelectMode=false; renderTx(acct); });
  document.getElementById('txDelAll')?.addEventListener('click', ()=>deleteAllTx(acct));
  document.querySelectorAll('#txbody .tx-sel').forEach(c=>c.onchange=updateTxToolsCount);
  updateTxToolsCount();
}
function updateTxToolsCount(){
  const n=document.querySelectorAll('#txbody .tx-sel:checked').length;
  const span=document.getElementById('txSelN'); if(span) span.textContent=n;
  const btn=document.getElementById('txDelSel'); if(btn){ btn.disabled=!n; btn.style.opacity=n?'1':'.5'; }
}
function removeTxLocal(ids){ const set=new Set(ids); state.tx=state.tx.filter(t=>!set.has(t.id)); }
// ----- Corbeille (rétention 7 jours) -----
function trashTx(ids){
  const locked=state.tx.filter(t=>ids.includes(t.id) && txLocked(t));
  if(locked.length){ showToast(lockMsg(locked[0]), 'err'); ids=ids.filter(id=>!locked.some(t=>t.id===id)); if(!ids.length) return; }
  const set=new Set(ids), now=new Date().toISOString();
  const moved=state.tx.filter(t=>set.has(t.id)).map(t=>({...t, deleted_at:now}));
  state.tx=state.tx.filter(t=>!set.has(t.id));
  state.trash=[...moved, ...(state.trash||[])];
  saveState(); dbWrite(db=>db.softDeleteTransactions(ids));
}
function restoreTrash(ids){
  if(!canWrite()) return;
  const set=new Set(ids);
  const moved=(state.trash||[]).filter(t=>set.has(t.id)).map(t=>{ const {deleted_at, ...rest}=t; return rest; });
  state.trash=(state.trash||[]).filter(t=>!set.has(t.id));
  state.tx=[...state.tx, ...moved];
  saveState(); dbWrite(db=>db.restoreTransactions(ids)); renderAll();
}
function purgeTrash(ids){
  if(!canWrite()) return;
  if(!confirm(`Supprimer DÉFINITIVEMENT ${ids.length} transaction(s) ? Irréversible.`)) return;
  const set=new Set(ids);
  state.trash=(state.trash||[]).filter(t=>!set.has(t.id));
  saveState(); dbWrite(db=>db.deleteTransactions(ids)); renderTrash();
}
function renderTrash(){
  const box=document.getElementById('trashBox'); if(!box) return;
  const trash=(state.trash||[]);
  if(!trash.length || !canWrite()){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='block';
  const rows=trash.map(t=>{
    const days=Math.max(0, 7-Math.floor((Date.now()-Date.parse(t.deleted_at))/86400000));
    return `<tr><td>${t.date}</td><td>${t.tiers}</td><td class="num ${t.amount<0?'neg':'pos'}">${signed(t.amount)}</td>
      <td class="sub">${t.account==='res'?'réserve':'paiement'} · reste ${days} j</td>
      <td style="text-align:right;white-space:nowrap"><button class="lk restore-one" data-id="${t.id}">restaurer</button> · <button class="lk del purge-one" data-id="${t.id}">suppr. définitive</button></td></tr>`;
  }).join('');
  box.innerHTML=`<div class="mini-h" style="margin-top:22px">🗑 Corbeille (${trash.length}) — récupérable 7 jours</div>
    <div class="card" style="padding:8px 14px"><table><tr><th>Date</th><th>Tiers</th><th class="num">Montant</th><th>Compte</th><th></th></tr>${rows}</table></div>
    <div style="margin-top:8px;display:flex;gap:10px"><button class="btn btn-ghost" id="restoreAll">↺ Tout restaurer</button><button class="btn btn-ghost" id="emptyTrash" style="color:var(--coral)">Vider la corbeille</button></div>`;
  box.querySelectorAll('.restore-one').forEach(b=>b.onclick=()=>restoreTrash([b.dataset.id]));
  box.querySelectorAll('.purge-one').forEach(b=>b.onclick=()=>purgeTrash([b.dataset.id]));
  box.querySelector('#restoreAll').onclick=()=>restoreTrash(trash.map(t=>t.id));
  box.querySelector('#emptyTrash').onclick=()=>purgeTrash(trash.map(t=>t.id));
}
function deleteSelectedTx(acct){
  if(!canWrite()) return;
  const ids=[...document.querySelectorAll('#txbody .tx-sel:checked')].map(c=>c.dataset.id);
  if(!ids.length) return;
  if(!confirm(`Mettre ${ids.length} transaction(s) à la corbeille ?\nRécupérable pendant 7 jours.`)) return;
  const accts=[...new Set(state.tx.filter(t=>ids.includes(t.id)).map(t=>t.account))];
  trashTx(ids);
  const patch={};
  accts.forEach(a=>{ if(txOf(a).length===0){ state.opening=state.opening||{}; state.opening[a]=0;
    state.recon=state.recon||{}; delete state.recon[a]; patch[a==='res'?'opening_res':'opening_pay']=0; } });
  if(Object.keys(patch).length){ patch.recon=state.recon; saveState(); dbWrite(db=>db.updateSettings(patch)); }
  renderAll();
}
function deleteAllTx(acct){ resetAccount(acct); }
// Remise à zéro d'un compte : transactions + solde d'ouverture + réconciliation
// (l'IBAN est conservé). Solde calculé revient à 0,00 €.
function resetAccount(acct){
  if(!canWrite()){ alert('Lecture seule.'); return; }
  if(txOf(acct).some(txLocked)){ showToast('Ce compte a des mouvements dans un exercice clôturé : rouvrez l’exercice (Comptabilité › Exercices) avant de réinitialiser.', 'err'); return; }
  const lbl = acct==='res'?'compte de réserve':'compte de paiement';
  const ids = txOf(acct).map(t=>t.id);
  if(!confirm(`Réinitialiser le ${lbl} ?\n\n${ids.length} transaction(s) → corbeille (récupérables 7 jours), solde d'ouverture remis à 0, réconciliation effacée.`)) return;
  if(ids.length) trashTx(ids);
  state.opening = state.opening||{}; state.opening[acct]=0;
  state.recon = state.recon||{}; delete state.recon[acct];
  saveState();
  dbWrite(db=>db.updateSettings(acct==='res'?{opening_res:0, recon:state.recon}:{opening_pay:0, recon:state.recon}));
  renderAll();
}

/* ---------- graphe évolution mensuelle ---------- */
function buildChart(acct){
  const d = monthlyData(acct), W=820, H=210, pad=34, n=d.labels.length;
  if (!n) return '<div class="sub" style="padding:20px">Pas encore de données pour tracer la courbe.</div>';
  const maxV = Math.max(...d.in, ...d.out)*1.15 || 1;
  const maxB = Math.max(...d.bal, 1)*1.1 || 1;
  const gw = (W-pad*2)/n, bw = Math.min(15, gw/3.4);
  const x = i => pad+gw*i+gw/2;
  const yV = v => H-26-(v/maxV)*(H-60);
  const yB = v => H-26-(v/maxB)*(H-60);
  let bars='';
  for(let i=0;i<n;i++){
    const bi=yV(d.in[i]), bo=yV(d.out[i]), base=H-26;
    bars+=`<rect x="${x(i)-bw-2}" y="${bi}" width="${bw}" height="${base-bi}" rx="3" fill="var(--chart-in)"/>`;
    bars+=`<rect x="${x(i)+2}" y="${bo}" width="${bw}" height="${base-bo}" rx="3" fill="var(--chart-out)"/>`;
    bars+=`<text x="${x(i)}" y="${H-9}" text-anchor="middle" font-size="11" fill="var(--ink-faint)">${d.labels[i]}</text>`;
  }
  const line = d.bal.map((v,i)=>`${i?'L':'M'}${x(i)},${yB(v)}`).join(' ');
  const dots = d.bal.map((v,i)=>`<circle cx="${x(i)}" cy="${yB(v)}" r="3.5" fill="var(--chart-bal)" stroke="#fff" stroke-width="1.5"/>`).join('');
  let grid=''; for(let g=0;g<=3;g++){ const gy=26+g*((H-60)/3); grid+=`<line x1="${pad}" y1="${gy}" x2="${W-pad}" y2="${gy}" stroke="var(--line-2)"/>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${grid}${bars}
    <path d="${line}" fill="none" stroke="var(--chart-bal)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
}
function renderChart(acct){
  const c=document.getElementById('chart'); if(c) c.innerHTML = buildChart(acct);
  const sub=document.getElementById('chartSub');
  if (sub) sub.textContent = (acct==='res'?'Compte de réserve':'Compte de paiement')+' · entrées, sorties & solde';
}

/* ---------- soldes affichés dans l'onglet Comptes ---------- */
function refreshAccountChrome(){
  const segBtns = document.querySelectorAll('#acctseg button');
  if (segBtns[0]) segBtns[0].textContent = `Compte de paiement · ${eur(balance('pay'))}`;
  if (segBtns[1]) segBtns[1].textContent = `Compte de réserve · ${eur(balance('res'))}`;
  renderAcctInfo(curAcct);
}

// Statut de réconciliation : solde calculé vs clôture du dernier relevé.
// Le rapprochement d'un compte : le solde calculé À LA DATE du dernier relevé validé contre la
// clôture qu'il annonce. Avant, c'était le solde total : une saisie ou un relevé plus récent que le
// dernier rapproché, ou un relevé ancien validé après un récent, donnait un faux « déséquilibre ».
function reconStatus(acct){
  const r = (state.recon||{})[acct];
  if (!r || r.closing===undefined || r.closing===null) return null;
  if (txOf(acct).length===0) return null;   // aucune transaction → rapprochement sans objet
  const asOfIso = (parseDate(r.asOf)||{}).iso || '';
  const bal = asOfIso ? balanceAt(acct, asOfIso) : balance(acct);
  const diff = +(bal - Number(r.closing)).toFixed(2);
  const after = asOfIso ? txOf(acct).filter(t=>{ const d=parseDate(t.date); return d && d.iso>asOfIso; }).length : 0;
  return {closing:Number(r.closing), asOf:r.asOf||'', asOfIso, balanceAt:bal, diff, ok:Math.abs(diff)<0.01, after};
}
const reconRow = t => { const d=parseDate(t.date); return {id:t.id, iso:d?d.iso:'', amount:+t.amount||0, tiers:t.tiers||'', date:t.date, t}; };
// Ce qui peut expliquer un écart (recon.js) : une ligne en trop, un doublon, une ligne du montant
// manquant en attente ou à la corbeille, un solde d'ouverture qui s'écarte du premier relevé.
function reconExplain(acct){
  const rs = reconStatus(acct); if (!rs || rs.ok || typeof LSRecon==='undefined') return null;
  const first = reconChain(acct).statements[0];
  return LSRecon.reconcile({ closing:rs.closing, asOfIso:rs.asOfIso, balanceAtAsOf:rs.balanceAt,
    opening:(state.opening||{})[acct]||0, firstOpening: first && first.opening!=null ? first.opening : null,
    tx:txOf(acct).map(reconRow), drafts:(state.draftTx||[]).filter(t=>t.account===acct).map(reconRow),
    trash:(state.trash||[]).filter(t=>t.account===acct).map(reconRow) });
}
// Les relevés validés du compte (fichiers déposés et synchros bancaires), dans l'ordre : chacun doit
// s'ouvrir là où le précédent s'est fermé, sinon un relevé manque entre les deux.
function reconChain(acct){
  const sts=(state.imports||[]).filter(im=>im.stmt && im.stmt.acct===acct && !im.pending).map(im=>({
    v:im.v, label:im.label, opening:im.stmt.opening, closing:im.stmt.closing, from:im.stmt.from||'', asOf:im.stmt.asOf||'',
    fromIso:(parseDate(im.stmt.from)||{}).iso||'', asOfIso:(parseDate(im.stmt.asOf)||{}).iso||'' }));
  return typeof LSRecon!=='undefined' ? LSRecon.chain(sts) : {statements:sts, gaps:[]};
}
let reconCands = [];   // les candidats affichés dans la fiche du compte (en démo les ids sont null : on les garde par index)
// Titulaire du compte, pour le relevé PDF : saisi dans la fiche du compte, sinon lu sur le
// dernier relevé bancaire validé, sinon le nom de la copropriété (une ACP est titulaire de ses comptes).
function acctHolder(acct){
  const typed = String(((state.holders||{})[acct])||'').trim();
  if (typed) return {name:typed, src:'typed'};
  const im = (state.imports||[]).filter(i=>i.stmt && i.stmt.acct===acct && i.stmt.holder && !i.pending)
    .sort((a,b)=>(b.v||0)-(a.v||0))[0];
  if (im) return {name:String(im.stmt.holder).trim(), src:'statement'};
  const copro = String(state.coproName||'').trim();
  return {name:copro, src:copro?'copro':'none'};
}
const holderHint = m => /holders|schema cache|column/i.test(m) ? m+' — lancez supabase/releve.sql dans Supabase (SQL Editor).' : m;

// Carte d'info compte : IBAN + titulaire + solde d'ouverture (éditables) + solde calculé + réconciliation.
function renderAcctInfo(acct){
  const box=document.getElementById('acctInfo'); if(!box) return;
  acct = acct || curAcct || 'pay';
  const ed = canWrite();
  const iban = (state.ibans&&state.ibans[acct])||'';
  const holder = acctHolder(acct);
  const open = (state.opening&&state.opening[acct])||0;
  const bal = balance(acct);
  const rs = reconStatus(acct), ex = rs && !rs.ok ? reconExplain(acct) : null, ch = reconChain(acct);
  reconCands = ex ? ex.candidates : [];
  const txLabel = t => `${escH(t.date)} · ${escH(t.tiers)} · ${signed(t.amount)}`;
  const why = !ex ? '' : (ex.candidates.length ? ex.candidates.map((c, i) =>
      c.kind==='extra' ? `<li>Une ligne en trop ? <b>${txLabel(c.t)}</b>, le montant exact de l'écart. <button class="lk recon-see" data-i="${i}">Voir</button></li>`
    : c.kind==='dup' ? `<li>Deux lignes identiques : <b>${txLabel(c.t)}</b>, un relevé importé deux fois ? <button class="lk recon-see" data-i="${i}">Voir</button></li>`
    : c.kind==='draft' ? `<li>Une ligne du montant manquant attend sa validation : <b>${txLabel(c.t)}</b>. <button class="lk recon-drafts">Voir les relevés à valider</button></li>`
    : c.kind==='trash' ? `<li>Une ligne du montant manquant est à la corbeille : <b>${txLabel(c.t)}</b>.${ed?` <button class="lk recon-restore" data-i="${i}">Restaurer</button>`:''}</li>`
    : `<li>Le solde d'ouverture du compte (${eur(c.opening)}) s'écarte de l'ouverture annoncée par le premier relevé (${eur(c.firstOpening)}), du montant de l'écart.</li>`).join('')
    : `<li>Aucune ligne isolée n'explique l'écart : plusieurs lignes manquent ou sont en trop, ou le solde d'ouverture est faux.</li>`);
  const gaps = ch.gaps.map(g => `<li>Le relevé « ${escH(g.next.label||('v'+g.next.v))} » s'ouvre à ${eur(g.next.opening)} alors que le précédent se fermait à ${eur(g.prev.closing)} : un relevé manque entre le ${escH(g.prev.asOf)} et le ${escH(g.next.from||g.next.asOf)} (${g.diff>0?'+':'−'}${eur(Math.abs(g.diff))}).</li>`).join('');
  const afterTxt = rs && rs.after ? ` · ${rs.after} mouvement${rs.after>1?'s':''} plus récent${rs.after>1?'s':''} que le relevé, hors rapprochement` : '';
  const reconHtml = rs
    ? (rs.ok
        ? `<span class="status success">Réconcilié${rs.asOf?' au '+escH(rs.asOf):''}</span> <span class="sub">solde calculé à cette date ${eur(rs.balanceAt)} = clôture du relevé${afterTxt}</span>${gaps?`<ul class="recon-why">${gaps}</ul>`:''}`
        : `<span class="status danger">Écart ${rs.diff>0?'+':'−'}${eur(Math.abs(rs.diff))}${rs.asOf?' au '+escH(rs.asOf):''}</span> <span class="sub">solde calculé à cette date ${eur(rs.balanceAt)} ≠ clôture du relevé ${eur(rs.closing)}${afterTxt}</span><ul class="recon-why">${why}${gaps}</ul>`)
    : '<span class="sub">Aucun relevé importé pour ce compte — pas encore de rapprochement.</span>';
  box.innerHTML = `
    <div class="grid" style="grid-template-columns:1.3fr 1.3fr 1fr 1fr;gap:14px;align-items:end">
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">IBAN du ${acct==='res'?'compte de réserve':'compte de paiement'}</div>
        <input class="fld" id="acctIban" ${ed?'':'disabled'} style="width:100%;margin-top:4px;font-family:monospace;font-size:12.5px" value="${iban}" placeholder="BE00 0000 0000 0000"></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)" title="Repris sur le relevé de compte PDF envoyé aux copropriétaires">Titulaire du compte${holder.src==='statement'?' <span class="sub">(lu sur le relevé)</span>':holder.src==='copro'?' <span class="sub">(nom de la copropriété)</span>':''}</div>
        <input class="fld" id="acctHolder" ${ed?'':'disabled'} style="width:100%;margin-top:4px" value="${escH(holder.name)}" placeholder="Ex. ACP Résidence du Parc"></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Solde d'ouverture</div>
        <input class="fld" id="acctOpening" ${ed?'':'disabled'} style="width:100%;margin-top:4px" value="${eur(open)}"></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Solde calculé (ouverture + transactions)</div>
        <div style="font-family:var(--display);font-size:22px;font-weight:600;margin-top:2px">${eur(bal)}</div></div>
    </div>
    ${acct==='res' ? `<div style="margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div class="l" style="font-size:12px;color:var(--ink-faint)">Objectif du fonds de réserve</div>
      <input class="fld" id="acctTarget" ${ed?'':'disabled'} style="width:150px" value="${eur(state.reserveTarget||0)}">
      <span class="sub">cible fixée en AG — pilote la jauge de l'accueil</span></div>` : ''}
    <div style="margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${reconHtml}<span style="margin-left:auto;display:flex;gap:14px;flex-wrap:wrap"><button class="lk" id="acctStmt">Relevé de compte (PDF)</button>${ed?`<button class="lk" id="acctReset" style="color:var(--coral)">↺ Réinitialiser ce compte</button>`:''}</span></div>`;
  box.querySelector('#acctStmt')?.addEventListener('click', ()=>window.LazySyndic.openStatement && window.LazySyndic.openStatement(acct));
  box.querySelectorAll('.recon-see').forEach(b=>b.onclick=()=>{ const c=reconCands[+b.dataset.i]; if(c && c.t && c.t.t) showTxDetail(c.t.t); });
  box.querySelectorAll('.recon-restore').forEach(b=>b.onclick=()=>{ const c=reconCands[+b.dataset.i]; if(c && c.t && c.t.id) restoreTrash([c.t.id]); });
  box.querySelectorAll('.recon-drafts').forEach(b=>b.onclick=()=>goToScreen('imp'));
  if (ed){
    const ib=box.querySelector('#acctIban');
    ib.onchange=()=>{ const v=ib.value.trim(); state.ibans=state.ibans||{}; state.ibans[acct]=v;
      dbWrite(db=>db.updateSettings(acct==='res'?{iban_res:v}:{iban_pay:v})); };
    const ho=box.querySelector('#acctHolder');
    ho.onchange=()=>{ const v=ho.value.trim();
      state.holders={...(state.holders||{}), [acct]:v}; saveState();
      dbWrite(async db=>{ try { await db.updateSettings({holders:state.holders}); } catch(e){ throw new Error(holderHint(e.message||String(e))); } });
      renderAcctInfo(acct); };
    const op=box.querySelector('#acctOpening');
    op.onchange=()=>{ const v=parseAmount(op.value); if(isNaN(v)){op.value=eur(open);return;}
      state.opening=state.opening||{}; state.opening[acct]=v;
      dbWrite(db=>db.updateSettings(acct==='res'?{opening_res:v}:{opening_pay:v}));
      refreshAccountChrome(); renderTx(acct); renderChart(acct); renderDashboard(); };
    box.querySelector('#acctReset')?.addEventListener('click', ()=>resetAccount(acct));
    const tg=box.querySelector('#acctTarget');
    if (tg) tg.onchange=()=>{ const v=parseAmount(tg.value); if(isNaN(v)||v<0){tg.value=eur(state.reserveTarget||0);return;}
      state.reserveTarget=v;
      dbWrite(db=>db.updateSettings({reserve_target:v}));
      renderChrome(); renderAcctInfo(acct); };
  }
}

/* onglets compte paiement / réserve */
document.getElementById('acctseg')?.addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  document.querySelectorAll('#acctseg button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  const acct=b.dataset.acct;
  document.getElementById('resTarget').style.display = acct==='res'?'block':'none';
  document.getElementById('statRow') && (document.querySelectorAll('#statRow').forEach(r=>r.style.display = acct==='res'?'none':'grid'));
  document.getElementById('dropAcct').textContent = acct==='res'?'le compte de réserve':'le compte de paiement';
  importTargetAcct = acct;
  renderChart(acct); renderTx(acct); renderAcctInfo(acct); renderAccountStats(acct);
});

/* filtre flaggées */
document.getElementById('flagFilter')?.addEventListener('click', function(){
  this.classList.toggle('on');
  flagOnly = this.classList.contains('on');
  renderTx(curAcct);
});
document.getElementById('catFilter')?.addEventListener('change', function(){ catFilter=this.value; renderTx(curAcct); });
document.getElementById('dirFilter')?.addEventListener('change', function(){ dirFilter=this.value; renderTx(curAcct); });
document.getElementById('ownerFilter')?.addEventListener('change', function(){ ownerFilter=this.value; renderTx(curAcct); });

// (boutons de rapport câblés plus bas, section GÉNÉRATEUR DE RAPPORTS)

/* ============================================================
   IMPORT CSV RÉEL
   ============================================================ */
let importTargetAcct = 'pay';
let parsedRows = null;     // lignes de données (après l'en-tête réel)
let parsedHeaders = null;  // en-têtes de la table de transactions
let mapping = null;        // {date,tiers,amount,credit,debit,note,type}
let dateOrder = 'dmy';     // 'dmy' ou 'mdy' (détecté sur le fichier)
let importMeta = null;     // {opening,closing,from,to,iban,holder} si dispo
let ibanDetected = false;  // compte déduit automatiquement de l'IBAN ?
let recognizedFormat = false; // format relevé reconnu → aperçu direct (pas de mapping manuel)
const normIban = s => String(s||'').toUpperCase().replace(/[^0-9A-Z]/g,'');

// Parse CSV : détecte le séparateur, gère les guillemets.
function parseCSV(text){
  text = text.replace(/^﻿/,''); // BOM
  const firstLine = (text.split(/\r?\n/)[0]||'');
  const counts = {';':(firstLine.match(/;/g)||[]).length, ',':(firstLine.match(/,/g)||[]).length, '\t':(firstLine.match(/\t/g)||[]).length};
  const delim = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][1] ? Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0] : ',';
  const rows=[]; let row=[]; let field=''; let inQ=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i];
    if (inQ){
      if (ch==='"'){ if (text[i+1]==='"'){ field+='"'; i++; } else inQ=false; }
      else field+=ch;
    } else {
      if (ch==='"') inQ=true;
      else if (ch===delim){ row.push(field); field=''; }
      else if (ch==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else if (ch==='\r'){ /* ignore */ }
      else field+=ch;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.some(c=>String(c).trim()!==''));
}

// Parse un relevé PDF (Swan/Syndic4you) → mêmes colonnes qu'un CSV :
// Date | Type | Description | Crédit | Débit. Reconstruit les lignes par
// position (y = ligne, x = colonne) via pdf.js.
async function parsePdfStatement(arrayBuffer){
  if (typeof pdfjsLib === 'undefined') throw new Error('Lecteur PDF non chargé');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({data:arrayBuffer}).promise;
  let items = [];
  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const vh = page.getViewport({scale:1}).height;
    const tc = await page.getTextContent();
    const pageOff = (p-1)*100000;   // pages empilées verticalement
    tc.items.forEach(it=>{
      if (!it.str || !it.str.trim()) return;
      items.push({ str:it.str, x:it.transform[4], y:pageOff + (vh - it.transform[5]) });
    });
  }
  return statementFromPdfItems(items);
}

// Partie sans pdf.js : morceaux de texte positionnés {str,x,y} → {headers,data,meta}.
// Swan édite le même relevé en français (« 14,00 », JJ/MM/AAAA, Virement/Frais) ou en
// anglais (« 14.00 », MM/JJ/AAAA, Credit transfer/Fee) selon la langue du compte. Rien
// ici ne dépend donc des mots : Type et Description sont séparés par l'abscisse de
// l'en-tête « Description », les soldes sont lus à côté de leur libellé.
const PDF_AMOUNT = /^-?\d[\d.,\s  ]*[.,]\d{2}$/;
const PDF_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
function statementFromPdfItems(items){
  const isNum = s => PDF_AMOUNT.test(String(s).trim());
  const find = re => items.find(i=>re.test(i.str.trim()));
  // regrouper en lignes (même y ± tolérance), puis trier par x
  items = [...items].sort((a,b)=> Math.abs(a.y-b.y)>3 ? a.y-b.y : a.x-b.x);
  const rows=[]; let cur=null;
  items.forEach(it=>{
    if (!cur || Math.abs(it.y-cur.y)>3){ cur={y:it.y, items:[it]}; rows.push(cur); }
    else cur.items.push(it);
  });
  rows.forEach(r=>r.items.sort((a,b)=>a.x-b.x));
  const joined = rows.map(r=>r.items.map(i=>i.str).join(' ')).join('\n');

  // métadonnées
  const meta={}; let m;
  // Montant d'un libellé : à sa droite sur la même ligne (« Closing balance … 1 234.56 »)
  // ou juste dessous, dans la même colonne (« Opening balance » puis « 1 200.00 »).
  const amountNear = re=>{
    const lab = find(re); if (!lab) return NaN;
    const c = items.filter(i=>isNum(i.str)).map(i=>({i, dy:i.y-lab.y, dx:Math.abs(i.x-lab.x)}))
      .filter(o=> (Math.abs(o.dy)<=3 && o.i.x>lab.x) || (o.dy>3 && o.dy<=25 && o.dx<80))
      .sort((a,b)=> Math.abs(a.dy)-Math.abs(b.dy) || a.dx-b.dx);
    return c.length ? parseAmount(c[0].i.str) : NaN;
  };
  meta.opening = amountNear(/^(opening balance|solde d['’]ouverture)$/i);
  meta.closing = amountNear(/^(closing balance|solde de cl[oô]ture)$/i);
  if ((m=joined.match(/\b(?:Du|From)\s+(\d{2}\/\d{2}\/\d{4})\s+(?:au|to)\s+(\d{2}\/\d{2}\/\d{4})/i))){ meta.from=m[1]; meta.to=m[2]; }
  if ((m=joined.match(/IBAN\s+([A-Z]{2}[0-9A-Z][0-9A-Z \t]{8,})/))) meta.iban=m[1].replace(/\s+/g,' ').trim();
  const title = find(/^(account statement|relevé de compte)$/i);
  if (title) meta.holder = items.filter(i=>Math.abs(i.y-title.y)<=3 && i.x<title.x).map(i=>i.str.trim()).join(' ') || undefined;

  // colonnes du tableau, d'après sa ligne d'en-tête
  const head = rows.find(r=>r.items.some(i=>/^date$/i.test(i.str.trim())) && r.items.some(i=>/^description$/i.test(i.str.trim())));
  const descX = head ? head.items.find(i=>/^description$/i.test(i.str.trim())).x : null;

  // lignes de transaction : commencent par une date, finissent par 2 montants (crédit, débit)
  const data=[]; let last=null;
  rows.forEach(r=>{
    const its=r.items; if(!its.length) return;
    if(!PDF_DATE.test(its[0].str.trim())){
      // suite d'une description trop longue, repliée sur la ligne du dessous
      if (last && descX!=null && r.y-last.y < 14 && its.every(i=>!isNum(i.str) && i.x>=descX-2 && i.x<last.creditX-1)){
        last.row[2] = (last.row[2]+' '+its.map(i=>i.str.trim()).join(' ')).trim();
        last.y = r.y;
      }
      return;
    }
    last = null;
    const date=its[0].str.trim();
    const nums=its.slice(1).filter(i=>isNum(i.str));
    if(nums.length<2) return;                                        // besoin crédit + débit
    const credit=nums[nums.length-2], debit=nums[nums.length-1];
    const middle=its.slice(1).filter(i=>i!==credit && i!==debit && i.x<credit.x-1);
    const words = list => list.map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();
    let type, desc;
    if (descX!=null){
      type = words(middle.filter(i=>i.x<descX-2));
      desc = words(middle.filter(i=>i.x>=descX-2));
    } else {
      // pas d'en-tête lisible : on reconnaît le type à son libellé
      const all = words(middle);
      const tm = all.match(/^(Frais|Fee|Virement|Credit transfer|Transfer|Pr[ée]l[èe]vement automatique|Pr[ée]l[èe]vement|Direct debit|Paiement|Card payment|Domiciliation|Ch[èe]que|Check)\s*(.*)$/i);
      type = tm ? tm[1] : ''; desc = tm ? tm[2].trim() : all;
    }
    const row = [date, type, desc||type||'—', credit.str.trim(), debit.str.trim()];
    data.push(row);
    last = {row, y:r.y, creditX:credit.x};
  });
  // solde d'ouverture : déduit de clôture − (Σ crédits − Σ débits) si non lu directement
  if (isNaN(meta.opening) && !isNaN(meta.closing)){
    const net = data.reduce((a,r)=> a + (parseAmount(r[3])||0) - (parseAmount(r[4])||0), 0);
    meta.opening = +(meta.closing - net).toFixed(2);
    meta.openingDeduced = true;
  }
  // Ordre des dates : lu sur les mouvements ET la période (le dernier jour du mois dépasse
  // toujours 12, donc tranche même quand aucun mouvement ne le fait) ; à défaut, la langue.
  const en = /\b(account statement|opening balance|closing balance)\b/i.test(joined);
  meta.dateOrder = detectDateOrder([...data.map(r=>r[0]), meta.from, meta.to], en ? 'mdy' : 'dmy');
  return { headers:['Date','Type','Description','Crédit','Débit'], data, meta };
}

// Beaucoup de relevés (Swan/Syndic4you…) ont un préambule de métadonnées
// avant la vraie table. On localise la ligne d'en-tête et on récupère le reste.
function detectTable(rows){
  let headerIdx = -1;
  for (let i=0;i<rows.length;i++){
    const cells = rows[i].map(norm);
    const hasDate = cells.some(c=>c==='date'||c.includes('date'));
    const hasAmt = cells.some(c=>/credit|débit|debit|montant|amount|bedrag/.test(c));
    if (hasDate && hasAmt){ headerIdx = i; break; }
  }
  // métadonnées du préambule (clé en col0, valeur en col1)
  const meta = {};
  const grab = (re)=>{ for (let i=0;i<(headerIdx<0?rows.length:headerIdx);i++){ if (re.test(norm(rows[i][0]||''))) return (rows[i][1]||'').trim(); } return ''; };
  meta.opening = parseAmount(grab(/opening balance|solde.*ouv/));
  meta.closing = parseAmount(grab(/closing balance|solde.*cl[oô]/));
  meta.iban    = grab(/^iban/);
  meta.holder  = grab(/account holder name|titulaire/);
  meta.from    = grab(/^from$|^du$|période.*d[ée]but/);
  meta.to      = grab(/^to$|^au$|période.*fin/);
  if (headerIdx < 0) return {headers: rows[0]||[], data: rows.slice(1), meta};
  return {headers: rows[headerIdx], data: rows.slice(headerIdx+1), meta};
}

// Détecte l'ordre des dates sur l'ensemble de la colonne (jour/mois ambigus).
// `fallback` tranche quand aucune valeur ne le fait (aucun nombre > 12).
function detectDateOrder(values, fallback='dmy'){
  let firstGt12=false, secondGt12=false;
  values.forEach(v=>{
    const m = String(v||'').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}/);
    if (m){ if (+m[1]>12) firstGt12=true; if (+m[2]>12) secondGt12=true; }
  });
  if (secondGt12 && !firstGt12) return 'mdy';  // ex. 01/28/2026
  if (firstGt12 && !secondGt12) return 'dmy';  // ex. 28/01/2026
  return fallback; // défaut belge
}

// Texte copié depuis la liste des transactions de l'app Swan (web) : en-têtes
// « Transaction / Method / Date / Amount », intertitres de mois (« October 2026 »),
// puis par mouvement : libellé, méthode, date en toutes lettres, montant signé
// (« -€0.60 », « +€50.00 »). Une cellule par ligne, ou par tabulation si le
// navigateur a copié le tableau. Pas d'IBAN ni de soldes : le compte se choisit
// à la main dans l'aperçu.
const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,
  janvier:1,'février':2,fevrier:2,mars:3,avril:4,mai:5,juin:6,juillet:7,'août':8,aout:8,septembre:9,octobre:10,novembre:11,'décembre':12,decembre:12};
function monthNum(w){
  w = String(w||'').toLowerCase().replace(/\.$/,'');
  if (MONTHS[w]) return MONTHS[w];
  const hits = w.length>=3 ? [...new Set(Object.keys(MONTHS).filter(k=>k.startsWith(w)).map(k=>MONTHS[k]))] : [];
  return hits.length===1 ? hits[0] : 0;   // « Oct », « sept. » ; « ju » ambigu → rien
}
// « October 2, 2026 » / « Oct 2, 2026 » / « 2 octobre 2026 » → 'YYYY-MM-DD' ; null sinon.
function parseLongDate(s){
  const t = String(s||'').trim();
  let m, d, mo, y;
  if ((m = t.match(/^([A-Za-zÀ-ÿ]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/))){ mo=monthNum(m[1]); d=+m[2]; y=+m[3]; }
  else if ((m = t.match(/^(\d{1,2})(?:er)?\s+([A-Za-zÀ-ÿ]+\.?)\s+(\d{4})$/))){ d=+m[1]; mo=monthNum(m[2]); y=+m[3]; }
  else return null;
  if (!mo || d<1 || d>31) return null;
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function parseSwanPaste(text){
  const isMonthHead = s => { const m=s.match(/^([A-Za-zÀ-ÿ]+)\s+(\d{4})$/); return !!(m && monthNum(m[1])); };
  const isColHead = s => /^(transaction|method|méthode|moyen de paiement|date|amount|montant|status|statut)$/i.test(s);
  // montant signé et/ou en euros — un nombre nu n'en est pas un (référence, n° de facture…)
  const isAmount = s => /^[+\-−]?\s*€?\s*\d[\d\s  .,]*[.,]\d{2}\s*€?$/.test(s) && /[+\-−€]/.test(s);
  const cells = String(text||'').replace(/^﻿/,'').split(/\r?\n|\t/).map(s=>s.trim()).filter(Boolean);
  const data=[]; let buf=[];
  cells.forEach(c=>{
    if (isMonthHead(c) || isColHead(c)) return;
    if (!isAmount(c)){ buf.push(c); return; }
    const di = buf.map(parseLongDate).map((v,i)=>v?i:-1).filter(i=>i>=0).pop();
    if (di===undefined){ buf=[]; return; }            // montant sans date : on ne devine pas
    const iso = parseLongDate(buf[di]);
    const rest = buf.filter((_,i)=>i!==di);
    const amt = parseAmount(c);
    if (!isNaN(amt) && amt!==0){
      const desc = rest[0] || '', type = rest.slice(1).join(' ');
      data.push([iso, type, desc||type||'—', amt>0?amt.toFixed(2):'0.00', amt<0?(-amt).toFixed(2):'0.00']);
    }
    buf=[];
  });
  // l'app liste du plus récent au plus ancien ; le grand livre veut l'ordre chronologique
  // (retourné d'abord : le tri stable garde alors aussi l'ordre des mouvements d'un même jour)
  data.reverse().sort((a,b)=> a[0]<b[0]?-1 : a[0]>b[0]?1 : 0);
  const meta = data.length ? {source:'paste', from:data[0][0], to:data[data.length-1][0]} : {source:'paste'};
  return { headers:['Date','Type','Description','Crédit','Débit'], data, meta };
}
// Parse une date selon l'ordre choisi → {iso, disp}.
function parseImportDate(raw, order){
  const s = String(raw||'').trim();
  let m;
  if ((m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/))) return parseDate(`${m[3]}/${m[2]}/${m[1]}`);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))){
    const a=+m[1], b=+m[2];
    const d = order==='mdy' ? b : a, mo = order==='mdy' ? a : b;
    return parseDate(`${d}/${mo}/${m[3]}`);
  }
  return parseDate(s);
}

// Devine quelle colonne correspond à quel champ.
function guessMapping(headers){
  const H = headers.map(norm);
  const find = (...keys)=>{ for(const k of keys){ const i=H.findIndex(h=>h.includes(k)); if(i>=0) return i; } return -1; };
  const m = {
    date:   find('date','exécution','execution','valeur','boeking','operation'),
    tiers:  find('contrepartie','counterparty','tiers','beneficiary','bénéficiaire','payee','third','name','nom'),
    amount: find('montant','amount','bedrag'),
    credit: find('credit','crédit'),
    debit:  find('debit','débit'),
    note:   find('communication','description','libellé','libelle','référence','reference','mededeling','détails','details','label','notes'),
    type:   find('type','nature'),
  };
  // si pas de colonne tiers dédiée, on s'appuie sur la description
  if (m.tiers < 0) m.tiers = m.note;
  return m;
}

// Extrait le tiers d'un libellé verbeux ("Transfer to engie" → "engie").
function extractTiers(raw){
  let s = String(raw||'').trim();
  s = s.replace(/^(transfer|virement|paiement|payment|sepa)\s+(to|from|vers|de|du|à|a)\s+/i,'');
  s = s.replace(/^(incoming|outgoing|entrant|sortant)\s+/i,'');
  return s.trim() || raw;
}

function categorize(tiers, note, type){
  const hay = norm(tiers + ' ' + (note||''));
  let displayTiers = tiers;
  for (const [label, entity] of state.aliases){
    if (label && hay.includes(norm(label))){ displayTiers = entity; break; }
  }
  const tnorm = norm(displayTiers + ' ' + tiers + ' ' + (note||''));
  for (const [label, high, sub] of state.rules){
    if (label && tnorm.includes(norm(label))) return {tiers:displayTiers, high, sub:sub||''};
  }
  for (const [label, high, sub] of BUILTIN_RULES){      // fallback intégré
    if (tnorm.includes(label)) return {tiers:displayTiers, high, sub:sub||''};
  }
  // toute sortie de type frais → Frais ACP › Banque (seule catégorie des frais)
  if (type && /fee|frais|cost/.test(norm(type))) return {tiers:displayTiers, high:'Frais ACP', sub:'Banque'};
  return {tiers:displayTiers, high:'?', sub:''};
}

// Une ligne de relevé (fichier, collage, ou synchro bancaire) → transaction rangée : règles et
// alias, copropriétaire d'un versement, sous-catégorie par défaut selon le compte. Un seul code
// pour les trois sources : une ligne synchronisée se range exactement comme la même ligne déposée.
function classifyImported({date, rawTiers, note, type, amount, account}){
  const cat = categorize(extractTiers(rawTiers), note, type);
  const t = {date, tiers:cat.tiers||rawTiers||'—', high:cat.high, sub:cat.sub, amount, account, note};
  // Modèle : les contributions des copropriétaires sont des « Charges » ; la
  // sous-catégorie indique le pot. Ancienne catégorie top-level « Fonds de
  // réserve » → normalisée vers Charges › Fonds de réserve.
  if (t.high==='Fonds de réserve'){ t.high='Charges'; t.sub='Fonds de réserve'; }
  // Entrée (montant positif) : on attribue le copropriétaire, et une entrée dont on reconnaît
  // le copropriétaire est une « Charge » (sa contribution). Une entrée sans copropriétaire
  // reconnu reste « à catégoriser » : un remboursement de fournisseur, un versement d'assureur
  // ou de notaire n'est pas une recette de charges. Forcée en « Charges », elle sortait du
  // filtre « À catégoriser » et gonflait le compte de résultats sans que personne ne la voie.
  if (amount>0){
    const det=detectOwner(t); if(det) t.owner=det;
    if (t.high==='?' && det){ t.high='Charges'; t.sub=''; }
  }
  // Sous-catégorie par défaut d'une Charge selon le compte :
  //   paiement → « Compte de paiement » · réserve → « Fonds de réserve »
  if (t.high==='Charges' && !t.sub){
    t.sub = (account==='res') ? 'Fonds de réserve' : 'Compte de paiement';
  }
  return t;
}

// Signature de doublon. Inclut le COMPTE : deux transactions identiques sur
// des comptes différents (paiement vs réserve) ne sont PAS des doublons ; un
// doublon = deux transactions identiques sur le MÊME compte.
function signature(t){
  const d = parseDate(t.date);
  return `${t.account||'pay'}|${d?d.iso:t.date}|${(+t.amount).toFixed(2)}|${norm(t.tiers)}|${norm(t.note)}`;
}

// Construit les transactions interprétées + statut doublon.
// Dédoublonnage multiset : une ligne n'est marquée doublon que si une copie
// identique existe DÉJÀ dans le store (les doublons légitimes intra-fichier,
// ex. deux virements identiques le même jour, sont conservés).
function interpret(){
  // Index des transactions déjà en mémoire, par signature (multiset). Le grand livre ET les
  // brouillons : depuis que l'import passe par une file d'attente, un relevé déjà déposé mais pas
  // encore validé n'est pas dans `tx`. L'oublier ici, c'est annoncer « 0 doublon » sur un relevé
  // redéposé et le compter deux fois à la validation.
  const existingBySig = {};
  [...state.tx, ...(state.draftTx||[])].forEach(t=>{ const s=signature(t); (existingBySig[s]=existingBySig[s]||[]).push(t); });
  const usedCount = {};
  const out = [];
  parsedRows.forEach(cells=>{
    const d = parseImportDate(cells[mapping.date], dateOrder);
    let amount;
    if (mapping.credit>=0 || mapping.debit>=0){
      const cr = mapping.credit>=0 ? (parseAmount(cells[mapping.credit])||0) : 0;
      const de = mapping.debit>=0  ? (parseAmount(cells[mapping.debit])||0)  : 0;
      amount = cr - de;
    } else {
      amount = parseAmount(cells[mapping.amount]);
    }
    if (!d || isNaN(amount) || amount===0) return; // ligne inexploitable / nulle
    const note = (mapping.note>=0 ? cells[mapping.note] : '').trim();
    const rawTiers = (mapping.tiers>=0 ? cells[mapping.tiers] : '').trim();
    const type = (mapping.type>=0 ? cells[mapping.type] : '').trim();
    const t = classifyImported({date:d.disp, rawTiers, note, type, amount, account:importTargetAcct});
    const sig = signature(t);
    const matches = existingBySig[sig] || [];
    const used = usedCount[sig] || 0;
    if (used < matches.length){ t._dupe = true; t._match = matches[used]; t._matchDraft = !!matches[used].importV && !state.tx.includes(matches[used]); usedCount[sig] = used + 1; } // doublon d'une tx existante
    else { t._dupe = false; }
    t._skip = false;   // exclu manuellement
    t._force = false;  // doublon réimporté volontairement
    out.push(t);
  });
  markBankDupes(out.filter(t=>!t._dupe));
  return out;
}

// Mots d'un libellé (sans accents ni mots de service), pour départager deux lignes de même montant.
const DEDUP_STOP = new Set(['transfer','transfert','from','the','virement','vers','des','les','pour','par','sepa',
  'credit','debit','paiement','payment','card','carte','instant','incoming','outgoing','recu','emis']);
function dedupWords(s){
  return new Set(String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
    .split(/[^a-z0-9]+/).filter(w=>w.length>=3 && !DEDUP_STOP.has(w)));
}
// Lignes du fichier déjà arrivées par la synchro bancaire. Elles y portent le libellé de la banque,
// pas celui du fichier : la signature ne les reconnaît pas. Même compte, même montant au centime,
// dates à 3 jours près ; chaque ligne synchronisée n'absorbe qu'une ligne du fichier, et les paires
// dont les libellés partagent le plus de mots passent d'abord. Sans cela, quand Sam et Lou versent
// le même montant le même jour, le versement de Lou pouvait « reconnaître » celui de Sam : Sam
// compté deux fois, Lou oublié. Même règle que le pont (bridge/bank.js dedupe), dans l'autre sens.
function markBankDupes(rows){
  const pool = [...state.tx, ...(state.draftTx||[])]
    .filter(t=>t.bankRef && t.account===importTargetAcct)
    .map(t=>({t, c:Math.round(t.amount*100), at:Date.parse((parseDate(t.date)||{}).iso||''), w:dedupWords(t.tiers+' '+t.note)}))
    .filter(p=>Number.isFinite(p.at));
  if (!pool.length) return;
  const pairs = [];
  rows.forEach((t,i)=>{
    const c = Math.round(t.amount*100), at = Date.parse((parseDate(t.date)||{}).iso||''), w = dedupWords(t.tiers+' '+t.note);
    pool.forEach((p,j)=>{
      if (p.c!==c) return;
      const gap = Math.abs(p.at-at)/86400000;
      if (gap<=3){ let score=0; for (const x of w) if (p.w.has(x)) score++; pairs.push({i, j, score, gap}); }
    });
  });
  pairs.sort((a,b)=>b.score-a.score || a.gap-b.gap || a.i-b.i || a.j-b.j);
  const takenI = new Set(), takenJ = new Set();
  for (const p of pairs){
    if (takenI.has(p.i) || takenJ.has(p.j)) continue;
    takenI.add(p.i); takenJ.add(p.j);
    const t = rows[p.i], hit = pool[p.j].t;
    t._dupe = true; t._match = hit; t._matchBank = true; t._matchDraft = !state.tx.includes(hit);
  }
}

let interpreted = null;

// rend le panneau d'import (mapping → preview)
function showMapping(){
  const after = document.getElementById('afterDrop');
  after.style.display='block';
  // masque le contenu de démo statique
  after.querySelectorAll(':scope > *').forEach(el=>{ if(el.id!=='importLive') el.style.display='none'; });
  let live = document.getElementById('importLive');
  if (!live){ live=document.createElement('div'); live.id='importLive'; after.prepend(live); }
  const opt = (sel)=>parsedHeaders.map((h,i)=>`<option value="${i}" ${i===sel?'selected':''}>${h||('Colonne '+(i+1))}</option>`).join('');
  const field = (f,label,withNone)=>`<div><div class="l" style="font-size:12px;color:var(--ink-faint)">${label}</div>
    <select class="fld mapsel" data-f="${f}" style="width:100%;margin-top:4px">${withNone?'<option value="-1">— aucune —</option>':''}${opt(mapping[f])}</select></div>`;
  // bandeau métadonnées si le préambule en fournit
  const m = importMeta||{};
  const acctLabel = importTargetAcct==='res'?'compte de réserve':'compte de paiement';
  const metaBanner = (!isNaN(m.opening)||m.iban||m.holder) ? `
    <div class="alert" style="background:var(--green-soft);border-color:oklch(.88 .05 160);color:var(--green-deep)">
      <span class="ic">✓</span><div>Relevé détecté${m.holder?` — <b>${m.holder}</b>`:''}${m.iban?` · ${m.iban}`:''}.
      ${!isNaN(m.opening)?`Solde d'ouverture <b>${eur(m.opening)}</b>`:''}${!isNaN(m.closing)?` → clôture <b>${eur(m.closing)}</b>`:''}.
      ${(m.from||m.to)?` Période ${importPeriod(m)}.`:''}
      ${m.iban ? (ibanDetected
        ? `<br><b>Compte reconnu via l'IBAN : ${acctLabel}.</b>`
        : `<br>IBAN inconnu — choisissez le compte ci-dessous, il sera <b>mémorisé</b> pour cet IBAN.`) : ''}</div></div>` : '';
  live.innerHTML = `
    ${metaBanner}
    <div class="card" style="margin-bottom:16px">
      <div class="h-row"><div><h2>Associer les colonnes</h2><div class="sub">${parsedRows.length} ligne(s) de transaction · format de date détecté : <b>${dateOrder==='mdy'?'mois/jour (US)':'jour/mois'}</b></div></div>
        <select class="fld" id="mapAcct" title="${ibanDetected?'Détecté via IBAN':'Mémorisé pour cet IBAN'}">
          <option value="pay" ${importTargetAcct==='pay'?'selected':''}>→ Compte de paiement</option>
          <option value="res" ${importTargetAcct==='res'?'selected':''}>→ Compte de réserve</option>
        </select></div>
      <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:12px">
        ${field('date','Date',false)}
        ${field('tiers','Tiers / description',true)}
        ${field('amount','Montant (signé)',true)}
        ${field('note','Communication',true)}
        ${field('credit','Crédit (entrées)',true)}
        ${field('debit','Débit (sorties)',true)}
        ${field('type','Type (frais…)',true)}
        <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Ordre des dates</div>
          <select class="fld" id="dateOrderSel" style="width:100%;margin-top:4px">
            <option value="dmy" ${dateOrder==='dmy'?'selected':''}>Jour / Mois / Année</option>
            <option value="mdy" ${dateOrder==='mdy'?'selected':''}>Mois / Jour / Année (US)</option>
          </select></div>
      </div>
      <div class="sub" style="margin-top:10px">Astuce : si le relevé a des colonnes <b>Crédit</b> et <b>Débit</b> séparées, laissez « Montant » sur — aucune —.</div>
      <button class="btn btn-primary" id="doInterpret" style="margin-top:14px">Interpréter →</button>
    </div>
    <div id="previewBox"></div>`;
  live.querySelector('#mapAcct').onchange = e=>{ importTargetAcct = e.target.value; };
  live.querySelector('#dateOrderSel').onchange = e=>{ dateOrder = e.target.value; };
  live.querySelectorAll('.mapsel').forEach(s=>s.onchange=()=>{ mapping[s.dataset.f] = +s.value; });
  live.querySelector('#doInterpret').onclick = showPreview;
}

const IMPORT_OPTS = ['Énergie','Assurance','Frais ACP','Entretien','Charges','Fonds de réserve','À catégoriser'];
let previewCssDone = false;
function ensurePreviewCss(){
  if (previewCssDone) return; previewCssDone = true;
  const s=document.createElement('style');
  s.textContent=`
    .pv-row.dup>td{background:var(--coral-soft)}
    .pv-row.dup>td:first-child{box-shadow:inset 3px 0 0 var(--coral)}
    .pv-row.skip>td{opacity:.4}
    .pv-orig{font-size:11.5px;color:var(--coral);margin-top:3px;display:flex;align-items:center;gap:5px}
    .lk.del{color:var(--coral)} .lk:hover{text-decoration:underline}`;
  document.head.appendChild(s);
}
function importStats(){
  const active = interpreted.filter(t=>!t._skip);
  return {
    nNew:  active.filter(t=>!t._dupe || t._force).length,
    nDupe: active.filter(t=>t._dupe && !t._force).length,
    nSkip: interpreted.filter(t=>t._skip).length,
    nUncat:active.filter(t=>(!t._dupe||t._force) && t.high==='?').length,
  };
}
function renderPreviewRow(t,i){
  const amtClass=t.amount>=0?'pos':'neg';
  const isDupe=t._dupe && !t._force;
  const cls='pv-row'+(t._skip?' skip':(isDupe?' dup':''));
  const catCell = isDupe
    ? `<span class="cat ${catClass(t.high)}">${t.high==='?'?'À catégoriser':t.high}</span>`
    : `<select class="fld previewcat" data-i="${i}" ${t._skip?'disabled':''}>${
        [...allCats().map(c=>({v:c,l:c})), {v:'?',l:'À catégoriser'}, {v:'__new__',l:'➕ Nouvelle catégorie…'}].map(o=>
          `<option value="${o.v}" ${(t.high===o.v||(o.v==='?'&&t.high==='?'))?'selected':''}>${o.l}</option>`
        ).join('')}</select>${(!t._skip && t.high && t.high!=='?')?`<br><select class="fld previewsub" data-i="${i}" style="font-size:11px;padding:3px 5px;margin-top:4px;color:var(--ink-soft)">${subcatOptions(t.high, t.sub||'')}</select>`:''}`;
  let status, actions;
  if (t._skip){
    status='<span class="badge" style="background:var(--line-2);color:var(--ink-faint)">Ignorée</span>';
    actions=`<button class="lk" data-act="unskip" data-i="${i}">réintégrer</button>`;
  } else if (isDupe){
    status='<span class="badge b-late">Doublon</span>';
    actions=`<button class="lk" data-act="force" data-i="${i}">importer qd même</button> · <button class="lk del" data-act="skip" data-i="${i}">supprimer</button>`;
  } else {
    status = t.high==='?'
      ? '<span class="badge b-late">À catégoriser</span>'
      : (t._force?'<span class="badge" style="background:var(--clay-soft);color:var(--warning-ink)">Doublon forcé</span>':'<span class="badge b-ok">Nouvelle</span>');
    actions=`<button class="lk del" data-act="skip" data-i="${i}">supprimer</button>`;
  }
  const orig = isDupe && t._match
    ? `<div class="pv-orig">↳ ${t._matchBank?'déjà arrivée par la synchro bancaire':(t._matchDraft?'déjà dans un relevé en attente de validation':'déjà en mémoire')} : ${t._match.date} · ${t._match.tiers} · ${signed(t._match.amount)}</div>` : '';
  const ownerCell = (t.amount>0 && !t._skip && !isDupe)
    ? `<div class="cmt" style="font-style:normal;margin-top:3px"><span style="color:var(--ink-faint)">Versé par :</span> <select class="pv-owner" data-i="${i}">${ownerOptions(t.owner||'')}</select></div>` : '';
  return `<tr class="${cls}"><td>${t.date}</td><td><b>${t.tiers}</b>${ownerCell}${orig}</td>
    <td class="num ${isDupe?'':amtClass}">${signed(t.amount)}</td>
    <td>${catCell}</td><td>${status}</td>
    <td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;
}
// Détection de trou : ce relevé commence-t-il bien après le dernier importé sur ce compte ?
function importGap(){
  const acct=importTargetAcct, m=importMeta||{};
  const r=(state.recon||{})[acct];
  if(!r || !r.asOf || !m.from) return null;
  const lastTo=parseDate(r.asOf), newFrom=parseImportDate(m.from, dateOrder);
  if(!lastTo || !newFrom) return null;
  const days=Math.round((Date.parse(newFrom.iso)-Date.parse(lastTo.iso))/86400000);
  return days>5 ? {asOf:r.asOf, newFrom:newFrom.disp, days} : null;
}
// Période du relevé, affichée à la belge quel que soit le format du fichier (US, ISO…).
function importPeriod(m){
  if (!m || !(m.from||m.to)) return '';
  const f = s => { const d = s ? parseImportDate(s, dateOrder) : null; return d ? d.disp : (s||'?'); };
  return `${f(m.from)} → ${f(m.to)}`;
}
function paintPreview(){
  ensurePreviewCss();
  const box=document.getElementById('previewBox');
  const {nNew,nDupe,nSkip,nUncat}=importStats();
  const m = importMeta||{};
  const gap = importGap();
  const ibanTail = m.iban ? normIban(m.iban).slice(-4) : '';
  const period = importPeriod(m);
  const balLine = !isNaN(m.opening) ? `ouverture ${eur(m.opening)} → clôture ${eur(m.closing)}` : '';
  // Les lignes lues doivent refaire le chemin ouverture → clôture du relevé ; sinon une ligne a
  // été perdue (ou mal lue) en route. Muet quand l'ouverture a elle-même été déduite des lignes.
  const reconGap = (!m.openingDeduced && !isNaN(m.opening) && !isNaN(m.closing))
    ? +(m.opening + sum(interpreted.map(t=>t.amount)) - m.closing).toFixed(2) : 0;
  const pasted = m.source==='paste';
  // En-tête « relevé reconnu » + choix du compte (au lieu des 8 menus)
  const header = `
    <div class="card" style="margin-bottom:14px;background:var(--green-soft);border-color:oklch(.88 .05 160)">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="font-size:26px;line-height:1">✓</div>
        <div style="flex:1;min-width:220px">
          <div style="font-family:var(--display);font-weight:600;font-size:16px;color:var(--green-deep)">${pasted?'Liste Swan reconnue (copiée depuis l’app)':'Relevé reconnu'}${m.holder?` — ${m.holder}`:''}</div>
          <div class="sub" style="color:var(--green-deep)">${parsedRows.length} mouvement(s)${ibanTail?` · IBAN …${ibanTail}`:''}${period?` · ${period}`:''}${balLine?` · ${balLine}`:''}</div>
        </div>
        <div style="text-align:right">
          <div class="l" style="font-size:11px;color:var(--green-deep)">${ibanDetected?'Compte (reconnu via l’IBAN)':(m.iban?'Sur quel compte ? (mémorisé)':'Sur quel compte ?')}</div>
          <select class="fld" id="pvAcct" style="margin-top:4px;font-weight:600${ibanDetected?'':';border-color:var(--clay);box-shadow:0 0 0 3px var(--clay-soft)'}">
            <option value="pay" ${importTargetAcct==='pay'?'selected':''}>💳 Compte de paiement</option>
            <option value="res" ${importTargetAcct==='res'?'selected':''}>🏦 Compte de réserve</option>
          </select>
        </div>
      </div>
    </div>`;
  box.innerHTML = `
    ${header}
    ${reconGap?`<div class="alert"><span class="ic">⚠</span><div><b>Le relevé ne tombe pas juste — écart ${signed(reconGap)}.</b> Ouverture + mouvements lus ≠ clôture annoncée : une ligne manque peut-être, ou a été mal lue. Comparez avec le relevé avant de valider.</div></div>`:''}
    ${gap?`<div class="alert"><span class="ic">⚠</span><div><b>Trou possible — ${gap.days} jours.</b> Ce relevé démarre le ${gap.newFrom}, mais le dernier relevé importé sur ce compte s'arrêtait au ${gap.asOf}. Un relevé (ou des transactions) manque peut-être entre les deux.</div></div>`:''}
    ${nUncat?`<div class="alert"><span class="ic">⚠</span><div><b>${nUncat} transaction(s) non reconnue(s).</b> Choisissez une catégorie, ou ajoutez une règle dans « Règles & alias ».</div></div>`:''}
    <div class="h-row" style="margin:4px 0 6px"><div class="mini-h" style="margin:0">Vérifiez et validez — doublons en rouge</div>
      <a class="lk" id="toMapping" style="font-size:11.5px;color:var(--ink-faint)">⚙ ajuster les colonnes</a></div>
    <div class="card" style="padding:8px 14px">
      <table><tr><th>Date</th><th>Tiers</th><th class="num">Montant</th><th>Catégorie</th><th>Statut</th><th></th></tr>
      <tbody>${interpreted.map((t,i)=>renderPreviewRow(t,i)).join('')}</tbody></table>
    </div>
    <div class="save-bar">
      <div class="n"><b>${nNew} à importer</b> · ${nDupe} doublon(s) écarté(s)${nSkip?` · ${nSkip} supprimée(s)`:''} → ${importTargetAcct==='res'?'compte de réserve':'compte de paiement'}</div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" id="cancelImp2">Annuler</button>
        <button class="btn btn-primary" id="saveImp2" ${nNew?'':'disabled style="opacity:.5"'}>Valider &amp; sauvegarder</button>
      </div>
    </div>`;
  box.querySelector('#pvAcct').onchange = e=>{ importTargetAcct=e.target.value; ibanDetected=false; showPreview(); };
  box.querySelector('#toMapping').onclick = ()=>showMapping();
  box.querySelectorAll('.pv-owner').forEach(s=>s.onchange=()=>{ const t=interpreted[+s.dataset.i]; t.owner=s.value; learnOwner(t.tiers, s.value); });
  box.querySelectorAll('.previewcat').forEach(s=>s.onchange=()=>{
    const t=interpreted[+s.dataset.i];
    if(s.value==='__new__'){ const name=addCategory(prompt('Nom de la nouvelle catégorie :','')||''); if(name){ t.high=name; learnCategory(t.tiers,name); } paintPreview(); return; }
    t.high=s.value; t.sub=''; learnCategory(t.tiers, s.value); paintPreview();
  });
  box.querySelectorAll('.previewsub').forEach(s=>s.onchange=()=>{
    const t=interpreted[+s.dataset.i];
    if(s.value==='__new__'){ const name=addSubcat(t.high, prompt('Nouvelle sous-catégorie pour « '+t.high+' » :','')||''); if(name){ t.sub=name; learnSubcat(t.tiers, t.high, name); } paintPreview(); return; }
    t.sub=s.value; learnSubcat(t.tiers, t.high, s.value); paintPreview();
  });
  box.querySelectorAll('.lk').forEach(b=>b.onclick=()=>{
    const i=+b.dataset.i, t=interpreted[i];
    if(b.dataset.act==='skip') t._skip=true;
    else if(b.dataset.act==='unskip'){ t._skip=false; t._force=false; }
    else if(b.dataset.act==='force') t._force=true;
    paintPreview();
  });
  box.querySelector('#cancelImp2').onclick = resetImport;
  box.querySelector('#saveImp2').onclick = commitImport;
}
function showPreview(){
  // S'assure que le conteneur existe même quand le mapping manuel a été sauté
  // (format reconnu → aperçu direct).
  const after=document.getElementById('afterDrop');
  if(after){ after.style.display='block'; after.querySelectorAll(':scope > *').forEach(el=>{ if(el.id!=='importLive') el.style.display='none'; }); }
  let live=document.getElementById('importLive');
  if(!live){ live=document.createElement('div'); live.id='importLive'; after && after.prepend(live); }
  if(!document.getElementById('previewBox')){ live.innerHTML='<div id="previewBox"></div>'; }
  interpreted = interpret(); paintPreview();
}

async function commitImport(){
  if(!canWrite()){ alert('Lecture seule : seul le syndic peut importer.'); return; }
  // à importer = non supprimées ET (nouvelles OU doublons forcés)
  const toAdd = interpreted
    .filter(t=>!t._skip && (!t._dupe || t._force))
    .map(t=>{ const {_dupe,_match,_matchDraft,_matchBank,_skip,_force, ...rest}=t; return rest; });
  if (!toAdd.length){ alert('Aucune transaction à importer.'); return; }
  // Le prochain numéro doit tenir compte des relevés déjà en attente, sinon deux brouillons
  // partagent le même `import_v` et se valident (ou se jettent) l'un l'autre. En ligne, la base
  // fait foi : la synchro bancaire a pu ouvrir un relevé depuis le chargement de la page.
  let nextV = Math.max(state.imports[0]?.v || 0, ...draftsOf().map(t=>t.importV||0)) + 1;
  if (writeToDb()){
    try { nextV = Math.max(nextV, (await window.LS.db.maxImportV()) + 1); }
    catch(e){ console.warn('numéro de relevé', e.message||e); }
  }
  const acct = importTargetAcct;

  // Ce que le relevé annonce de lui-même. Mis de côté, PAS appliqué : le solde d'ouverture et la
  // clôture de réconciliation décrivent un grand livre où les lignes sont entrées. Les appliquer
  // dès le dépôt ferait afficher un « déséquilibre » de la valeur du relevé entier à l'écran
  // Comptes, pendant tout le temps où il attend d'être vérifié.
  const toNorm = importMeta ? parseImportDate(importMeta.to, dateOrder) : null;
  const fromNorm = importMeta ? parseImportDate(importMeta.from, dateOrder) : null;
  const stmt = {
    acct,
    opening: importMeta && !isNaN(importMeta.opening) ? importMeta.opening : null,
    closing: importMeta && !isNaN(importMeta.closing) ? importMeta.closing : null,
    iban: (importMeta && importMeta.iban) || null,
    holder: (importMeta && importMeta.holder) || null,   // titulaire lu sur le relevé → relevé de compte PDF
    asOf: (toNorm && toNorm.disp) || (toAdd.length ? toAdd[toAdd.length-1].date : ''),
    from: fromNorm ? fromNorm.disp : '',
  };
  const imp = {v:nextV, label:`Import ${new Date().toLocaleDateString('fr-BE')}`,
    meta:`${toAdd.length} transaction(s) — en attente de validation`, cur:false, pending:true, stmt};

  // L'IBAN → compte est une préférence apprise, pas de l'argent : la mémoriser tout de suite rend
  // le prochain dépôt du même compte plus sûr, et l'écarter n'aurait rien corrompu.
  const ibanKey = importMeta && importMeta.iban ? normIban(importMeta.iban) : null;
  const learnIban = ibanKey && (!state.ibanMap || state.ibanMap[ibanKey]!==acct);
  const settingsPatch = {};

  if (writeToDb()){
    try {
      // Brouillon : le relevé est enregistré, mais il n'entre dans les comptes qu'une fois vérifié.
      const saved = await window.LS.db.addTransactions(toAdd, {draft:true, importV:nextV});
      state.draftTx.push(...saved);
      const savedImp = await window.LS.db.addImport(imp);
      state.imports.unshift({id:savedImp.id, ...imp});
      if (learnIban){ state.ibanMap = {...(state.ibanMap||{}), [ibanKey]:acct}; settingsPatch.iban_map = state.ibanMap; }
      if (Object.keys(settingsPatch).length) await window.LS.db.updateSettings(settingsPatch);
    } catch(e){ console.error(e); alert('Import non enregistré : '+(e.message||e)); return; }
  } else {
    // démo ou hors-ligne : tout reste local, mais le même passage par le brouillon
    state.draftTx.push(...toAdd.map((t,i)=>({id:'local-'+Date.now()+'-'+i, ...t, importV:nextV})));
    state.imports.unshift(imp);
    if (learnIban) state.ibanMap = {...(state.ibanMap||{}), [ibanKey]:acct};
    saveState();
  }
  // journal de bord (audit) — avant resetImport qui efface importMeta
  const tlTitle = `Import — ${acct==='res'?'compte de réserve':'compte de paiement'}`;
  const tlDesc = `${toAdd.length} transaction(s) importée(s)`+(importMeta&&(importMeta.from||importMeta.to)?` · période ${importMeta.from||'?'} → ${importMeta.to||'?'}`:'');
  resetImport();
  logTimeline({title:tlTitle, description:tlDesc, kind:'import'});
  renderAll();
  const nUncat = toAdd.filter(t=>!t.high || t.high==='?').length;
  // Le rapport de réconciliation appartient à la validation, pas à l'import : tant que le relevé
  // est en brouillon il ne compte dans aucun solde, donc le comparer à la clôture n'aurait aucun
  // sens (il annoncerait systématiquement un déséquilibre de tout le relevé).
  alert(
    `✓ ${toAdd.length} transaction(s) en brouillon${demoMode?' (démo, non enregistrées en base)':` — relevé v${nextV}`}.\n\n`
    + (nUncat ? `${nUncat} ligne(s) attendent une catégorie. ` : '')
    + `Rien n'entre dans les comptes tant que le relevé n'est pas validé : reprenez-le à tête reposée `
    + `dans « Relevés à valider », en haut de cet écran.`
  );
}

/* ─── Validation d'un relevé importé ────────────────────────────────────────
   Le relevé est en base mais hors du grand livre. On le relit, on complète les
   catégories, puis on le valide — c'est à ce moment-là qu'il compte. */

/** Les brouillons d'un relevé, ou tous quand `v` est omis. */
function draftsOf(v){
  const rows = state.draftTx || [];
  return v===undefined ? rows : rows.filter(t=>t.importV===v);
}

/** Les relevés en attente, du plus récent au plus ancien. */
function pendingImports(){
  const byV = new Map();
  for (const t of draftsOf()){
    const v = t.importV ?? 0;
    const g = byV.get(v) || {v, rows:[], uncat:0, accounts:new Set()};
    g.rows.push(t);
    if (!t.high || t.high==='?') g.uncat++;
    g.accounts.add(t.account);
    byV.set(v, g);
  }
  return [...byV.values()].sort((a,b)=>b.v-a.v);
}

async function confirmDraftImport(v){
  if(!canWrite()){ alert('Lecture seule : seul le syndic peut valider un relevé.'); return; }
  const rows = draftsOf(v);
  if(!rows.length) return;
  const lockedRow = rows.find(txLocked);
  if(lockedRow){ showToast(`Ce relevé contient des mouvements d'un exercice clôturé (${lockedRow.date}) : rouvrez l'exercice avant de le valider, ou écartez-le.`, 'err'); return; }
  const uncat = rows.filter(t=>!t.high || t.high==='?').length;
  if (uncat && !confirm(`${uncat} ligne(s) n'ont pas de catégorie. Valider quand même ? Elles resteront « à trier ».`)) return;

  const rec = state.imports.find(im=>im.v===v);
  const stmt = (rec && rec.stmt) || null;
  const stmtAcct = (stmt && stmt.acct) || rows[0].account;

  // C'est maintenant que le relevé décrit le grand livre : on applique ce qu'il annonçait.
  const settingsPatch = {};
  if (stmt && stmt.opening != null && !((state.opening||{})[stmtAcct])){
    state.opening = {...(state.opening||{}), [stmtAcct]: stmt.opening};
    settingsPatch[stmtAcct==='res'?'opening_res':'opening_pay'] = stmt.opening;
  }
  if (stmt && stmt.iban && !((state.ibans||{})[stmtAcct])){
    state.ibans = {...(state.ibans||{}), [stmtAcct]: stmt.iban};
    settingsPatch[stmtAcct==='res'?'iban_res':'iban_pay'] = stmt.iban;
  }
  if (stmt && stmt.closing != null){
    state.recon = {...(state.recon||{}), [stmtAcct]: {closing: stmt.closing, asOf: stmt.asOf, from: stmt.from}};
    settingsPatch.recon = state.recon;
  }

  if (writeToDb()){
    try {
      await window.LS.db.confirmImport(v);
      await window.LS.db.clearCurrentImport();
      if (rec && rec.id) await window.LS.db.updateImport(rec.id, {cur:true, pending:false, meta:`${rows.length} transaction(s)`});
      if (Object.keys(settingsPatch).length) await window.LS.db.updateSettings(settingsPatch);
    }
    catch(e){ console.error(e); alert('Validation non enregistrée : '+(e.message||e)); return; }
  }
  // Le grand livre récupère les lignes telles quelles — mêmes id, aucune recréation.
  state.tx.push(...rows);
  state.draftTx = draftsOf().filter(t=>t.importV!==v);
  state.imports.forEach(im=>{ im.cur = false; });
  if (rec){ rec.cur = true; rec.pending = false; rec.meta = `${rows.length} transaction(s)`; }
  saveState();
  logTimeline({title:`Relevé v${v} validé`, description:`${rows.length} transaction(s) entrées dans les comptes`, kind:'import'});
  renderAll();

  // Maintenant seulement la réconciliation a un sens : les lignes comptent.
  const accts = [...new Set(rows.map(t=>t.account))];
  let msg = `✓ Relevé v${v} validé — ${rows.length} transaction(s) dans les comptes.`;
  for (const acct of accts){
    const rs = reconStatus(acct);
    const label = acct==='res'?'compte de réserve':'compte de paiement';
    if (rs && !rs.ok){
      const ex = reconExplain(acct);
      const lines = ex && ex.candidates.length ? ex.candidates.map(c =>
          c.kind==='extra' ? `une ligne en trop ? ${c.t.date} · ${c.t.tiers} · ${signed(c.t.amount)}, le montant exact de l'écart`
        : c.kind==='dup' ? `deux lignes identiques : ${c.t.date} · ${c.t.tiers} · ${signed(c.t.amount)}, un relevé importé deux fois ?`
        : c.kind==='draft' ? `une ligne du montant manquant attend sa validation : ${c.t.date} · ${c.t.tiers}`
        : c.kind==='trash' ? `une ligne du montant manquant est à la corbeille : ${c.t.date} · ${c.t.tiers}`
        : `le solde d'ouverture (${eur(c.opening)}) s'écarte de l'ouverture du premier relevé (${eur(c.firstOpening)})`)
        : ['aucune ligne isolée n\'explique l\'écart : plusieurs lignes manquent ou sont en trop, ou le solde d\'ouverture est faux'];
      msg += `\n\n⚠ Écart sur le ${label} au ${rs.asOf} : solde calculé à cette date ${eur(rs.balanceAt)} ≠ clôture du relevé ${eur(rs.closing)} (${rs.diff>0?'+':''}${eur(rs.diff)}).\n`
        + lines.map(l=>'• '+l).join('\n') + `\nLe détail reste dans la fiche du compte (écran Comptes).`;
      const gaps = reconChain(acct).gaps;
      if (gaps.length) msg += `\n• ${gaps.length} trou${gaps.length>1?'s':''} dans la chaîne des relevés : un relevé s'ouvre ailleurs que là où le précédent se fermait.`;
    } else if (rs && rs.ok){
      msg += `\n\n✓ Réconcilié sur le ${label} au ${rs.asOf} : le solde calculé à cette date correspond à la clôture du relevé.`;
    }
  }
  const needJust = rows.filter(commentRequired).length;
  if (needJust){
    msg += `\n\n⚑ ${needJust} sortie(s) de plus de ${FDR_RULE.minOut} € automatiquement signalée(s) : `
      + `un commentaire de justification est OBLIGATOIRE (écran Comptes › compte de réserve).`;
  }
  alert(msg);
}

async function discardDraftImport(v){
  if(!canWrite()){ alert('Lecture seule : seul le syndic peut supprimer un relevé.'); return; }
  const rows = draftsOf(v);
  if(!rows.length) return;
  if(!confirm(`Supprimer le relevé v${v} et ses ${rows.length} ligne(s) non validées ? Le grand livre n'est pas touché.`)) return;
  const rec = state.imports.find(im=>im.v===v);
  if (writeToDb()){
    try {
      await window.LS.db.discardDraftImport(v);
      // La fiche du relevé part avec ses lignes : elle ne portait qu'un solde d'ouverture et une
      // clôture jamais appliqués, et la laisser afficherait un relevé qui n'existe plus.
      if (rec && rec.id) await window.LS.db.deleteImport(rec.id);
    }
    catch(e){ console.error(e); alert('Suppression non enregistrée : '+(e.message||e)); return; }
  }
  state.draftTx = draftsOf().filter(t=>t.importV!==v);
  state.imports = state.imports.filter(im=>im.v!==v);
  saveState();
  logTimeline({title:`Relevé v${v} écarté`, description:`${rows.length} ligne(s) non validées supprimées`, kind:'import'});
  renderAll();
}

function resetImport(){
  parsedRows = parsedHeaders = mapping = interpreted = importMeta = null;
  dateOrder = 'dmy';
  const after = document.getElementById('afterDrop');
  if (after){ after.style.display='none'; const live=document.getElementById('importLive'); if(live) live.remove(); }
}

// Lecture d'un fichier déposé / choisi (CSV, PDF, ou texte copié depuis Swan)
function handleFile(file){
  if (!file) return;
  const isPdf = /\.pdf$/i.test(file.name||'') || file.type==='application/pdf';
  const reader = new FileReader();
  reader.onload = async e=>{
    let parsed;
    try {
      parsed = isPdf ? await parsePdfStatement(e.target.result) : parseStatementText(e.target.result);
    } catch(err){ console.error(err); alert('Lecture du fichier impossible : '+(err.message||err)); return; }
    if (!parsed){ alert('Fichier vide ou illisible.'); return; }
    if (!parsed.data || !parsed.data.length){ alert('Aucune transaction détectée dans ce fichier.'); return; }
    loadStatement(parsed);
  };
  if (isPdf) reader.readAsArrayBuffer(file); else reader.readAsText(file, 'utf-8');
}

// Texte brut : la liste copiée depuis l'app Swan (dates en toutes lettres, montants
// signés — rien d'autre n'y ressemble), sinon un export CSV. null si illisible.
function parseStatementText(text){
  const pasted = parseSwanPaste(text);
  if (pasted.data.length) return pasted;
  const rows = parseCSV(text);
  return rows.length < 2 ? null : detectTable(rows);
}

// Relevé lu (quelle que soit sa source) → écran d'import.
function loadStatement({headers, data, meta}){
  parsedHeaders = headers.map(h=>String(h).trim());
  parsedRows = data;
  importMeta = meta || {};
  mapping = guessMapping(parsedHeaders);
  if (mapping.date<0) mapping.date=0;
  if (mapping.amount<0 && mapping.credit<0 && mapping.debit<0) mapping.amount=Math.min(parsedHeaders.length-1, 2);
  // la période du relevé départage aussi jour/mois (son dernier jour dépasse 12)
  dateOrder = importMeta.dateOrder || detectDateOrder([...parsedRows.map(r=>r[mapping.date]), importMeta.from, importMeta.to]);
  // détection du compte via l'IBAN (apprise aux imports précédents)
  ibanDetected = false;
  const key = importMeta.iban ? normIban(importMeta.iban) : null;
  if (key && state.ibanMap && state.ibanMap[key]){ importTargetAcct = state.ibanMap[key]; ibanDetected = true; }
  // Format Syndic4you/Swan reconnu (Date + Crédit + Débit présents) → on saute
  // l'association manuelle et on va droit à l'aperçu. Sinon : mapping manuel.
  recognizedFormat = mapping.date>=0 && mapping.credit>=0 && mapping.debit>=0;
  showImportScreen();
  if (recognizedFormat) showPreview();
  else showMapping();
}

// ⌘V sur l'écran Import : la liste des transactions copiée depuis l'app Swan (ou un CSV)
// s'importe comme un fichier. Un collage dans un champ de saisie garde son sens habituel.
document.addEventListener('paste', e=>{
  if (!document.getElementById('imp')?.classList.contains('on')) return;
  if (e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (!text || !text.trim()) return;
  e.preventDefault();
  const parsed = parseStatementText(text);
  if (!parsed || !parsed.data || !parsed.data.length){ alert('Le texte collé ne contient aucune transaction reconnaissable.'); return; }
  loadStatement(parsed);
});

let fileInput;
function pickFile(){
  if (!fileInput){
    fileInput = document.createElement('input');
    fileInput.type='file'; fileInput.accept='.csv,.pdf,text/csv,text/plain,application/pdf'; fileInput.style.display='none';
    fileInput.onchange = e=>{ handleFile(e.target.files[0]); fileInput.value=''; };
    document.body.appendChild(fileInput);
  }
  fileInput.click();
}

function showImportScreen(){
  document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('on'));
  document.querySelector('.nav button[data-s="imp"]').classList.add('on');
  document.querySelectorAll('.screen').forEach(x=>x.classList.remove('on'));
  document.getElementById('imp').classList.add('on');
  window.scrollTo({top:0, behavior:'smooth'});
}

// zones de dépôt
function wireDrop(el, onFile){
  if (!el) return;
  el.addEventListener('click', ()=>pickFile());
  ['dragover','dragenter'].forEach(ev=>el.addEventListener(ev,e=>{e.preventDefault();el.classList.add('hot');}));
  ['dragleave'].forEach(ev=>el.addEventListener(ev,e=>{e.preventDefault();el.classList.remove('hot');}));
  el.addEventListener('drop', e=>{
    e.preventDefault(); el.classList.remove('hot');
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });
}
wireDrop(document.getElementById('drop'));
wireDrop(document.getElementById('acctDrop'));

// historique des imports
/* Panneau « Relevés à valider » — en haut de l'écran Import, avant la zone de dépôt : ce qui
   attend passe avant ce qu'on s'apprête à ajouter. */
let openDraftV = null;   // relevé déplié pour vérification

function renderPendingImports(){
  const box = document.getElementById('pendingImports');
  if (!box) return;
  const groups = pendingImports();
  if (!groups.length){ box.innerHTML=''; openDraftV=null; return; }

  const acctLabel = a => a==='res' ? 'compte de réserve' : 'compte de paiement';
  box.innerHTML = groups.map(g=>{
    const open = g.v===openDraftV;
    const accts = [...g.accounts].map(acctLabel).join(' + ');
    const net = sum(g.rows.map(t=>t.amount));
    // Relevé ouvert par la synchro bancaire : il grossit à chaque synchro jusqu'à sa validation.
    const rec = state.imports.find(im=>im.v===g.v);
    const bankStmt = rec && rec.stmt && rec.stmt.source==='bank' ? rec.stmt : null;
    return `
    <div class="card" style="margin-bottom:14px;border-color:var(--clay);background:var(--clay-soft)">
      <div class="h-row" style="align-items:flex-start">
        <div>
          <h2 style="margin:0">${bankStmt ? `${escH(rec.label)} · v${g.v} — à valider` : `Relevé v${g.v} — à valider`}</h2>
          ${bankStmt && bankStmt.closing!=null ? `<div class="sub">Solde ${escH(bankStmt.aspsp||'de la banque')} au ${escH(bankStmt.asOf||'?')} : <b>${eur(bankStmt.closing)}</b> — rapproché du solde calculé à la validation.</div>` : ''}
          <div class="sub">${g.rows.length} mouvement(s) · ${accts} · net ${signed(net)}${
            g.uncat ? ` · <b style="color:var(--warning-ink)">${g.uncat} sans catégorie</b>` : ' · tout est catégorisé'}</div>
          <div class="sub" style="margin-top:4px">Ces lignes ne comptent dans aucun solde tant qu'elles ne sont pas validées.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost dr-toggle" data-v="${g.v}">${open?'Replier':'Vérifier'}</button>
          ${canWrite() ? `<button class="btn btn-ghost dr-discard" data-v="${g.v}" style="color:var(--coral)">Écarter</button>
          <button class="btn btn-primary dr-confirm" data-v="${g.v}">Valider le relevé</button>` : ''}
        </div>
      </div>
      ${open ? `<div class="card" style="padding:8px 14px;margin-top:12px;background:var(--paper)">
        <table><tr><th>Date</th><th>Tiers</th><th class="num">Montant</th><th>Catégorie</th></tr>
        <tbody>${g.rows.map(t=>renderDraftRow(t)).join('')}</tbody></table>
      </div>` : ''}
    </div>`;
  }).join('');

  box.querySelectorAll('.dr-toggle').forEach(b=>b.onclick=()=>{
    openDraftV = (+b.dataset.v===openDraftV) ? null : +b.dataset.v;
    renderPendingImports();
  });
  box.querySelectorAll('.dr-confirm').forEach(b=>b.onclick=()=>confirmDraftImport(+b.dataset.v));
  box.querySelectorAll('.dr-discard').forEach(b=>b.onclick=()=>discardDraftImport(+b.dataset.v));
  box.querySelectorAll('.dr-cat').forEach(s=>s.onchange=()=>{
    const t = draftsOf().find(x=>x.id===s.dataset.id); if(!t) return;
    if(s.value==='__new__'){ const name=addCategory(prompt('Nom de la nouvelle catégorie :','')||''); if(name){ setDraftCat(t, name, ''); } renderPendingImports(); return; }
    setDraftCat(t, s.value, '');
  });
  box.querySelectorAll('.dr-sub').forEach(s=>s.onchange=()=>{
    const t = draftsOf().find(x=>x.id===s.dataset.id); if(!t) return;
    if(s.value==='__new__'){ const name=addSubcat(t.high, prompt('Nouvelle sous-catégorie pour « '+t.high+' » :','')||''); if(name){ setDraftCat(t, t.high, name); } renderPendingImports(); return; }
    setDraftCat(t, t.high, s.value);
  });
}

/** Catégorise une ligne en attente : on apprend la règle et on persiste tout de suite, pour que
 *  le travail de tri survive à un rechargement même si la validation vient plus tard. */
function setDraftCat(t, high, sub){
  if(!canWrite()){ alert('Lecture seule : seul le syndic peut catégoriser un relevé.'); renderPendingImports(); return; }
  t.high = high; t.sub = sub || '';
  learnRule(t.tiers, high, t.sub);
  if (writeToDb()) dbWrite(db=>db.updateTransaction(t.id, {high:t.high, sub:t.sub}));
  else saveState();
  renderPendingImports();
}

function renderDraftRow(t){
  const uncat = !t.high || t.high==='?';
  const cats = [...allCats().map(c=>({v:c,l:c})), {v:'?',l:'À catégoriser'}, {v:'__new__',l:'➕ Nouvelle catégorie…'}];
  return `<tr${uncat?' style="background:var(--clay-soft)"':''}>
    <td>${t.date}</td><td><b>${t.tiers}</b>${t.note?`<div class="cmt">${t.note}</div>`:''}</td>
    <td class="num ${t.amount>=0?'pos':'neg'}">${signed(t.amount)}</td>
    <td>${!canWrite()
      ? `<span class="cat ${catClass(t.high)}">${uncat?'À catégoriser':t.high}${t.sub?` › ${t.sub}`:''}</span>`
      : `<select class="fld dr-cat" data-id="${t.id}">${
        cats.map(o=>`<option value="${o.v}" ${(t.high||'?')===o.v?'selected':''}>${o.l}</option>`).join('')}</select>${
        !uncat?`<br><select class="fld dr-sub" data-id="${t.id}" style="font-size:11px;padding:3px 5px;margin-top:4px;color:var(--ink-soft)">${subcatOptions(t.high, t.sub||'')}</select>`:''}`}</td></tr>`;
}

function renderImports(){
  const box = document.querySelector('#imp .card:last-of-type');
  // la dernière .card de l'écran import est l'historique
  const histCard = [...document.querySelectorAll('#imp .card')].pop();
  if (!histCard) return;
  histCard.innerHTML = state.imports.map(im=>
    im.cur
      ? `<div class="hist cur"><span class="v">v${im.v}</span><div><b>${im.label}</b><div class="meta">${im.meta}</div></div><span class="now">Version actuelle</span></div>`
      : `<div class="hist"><span class="v">v${im.v}</span><div><b>${im.label}</b><div class="meta">${im.meta}</div></div><button class="rb">↺ Revenir à cette version</button></div>`
  ).join('');
}

/* ============================================================
   SYNCHRO BANCAIRE (Enable Banking) — carte de l'écran Import
   Le navigateur ne détient aucun secret. Il dépose une demande dans ls_bank_links ; le pont
   (VPS, bridge/banksync.js), seul à détenir la clé privée Enable Banking, en fait un lien
   d'autorisation ; la banque renvoie sur banque.html avec un code, que l'app dépose à son
   tour ; le pont ouvre la session puis synchronise toutes les quelques heures. Les mouvements
   arrivent en relevé « à valider », exactement comme un fichier déposé, sans catégorie :
   classifyBankDrafts les range ici, avec les mêmes règles qu'un import (classifyImported).
   ============================================================ */
const BANK_CB_KEY = 'ls:bankCallback';    // posé par banque.html, consommé une fois ici
const BANK_COUNTRIES = [['FR','France'],['BE','Belgique'],['NL','Pays-Bas'],['DE','Allemagne'],['ES','Espagne'],['IT','Italie'],['LU','Luxembourg']];
const BANK_LIVE = ['requested','auth_ready','code_received','active','revoke_requested'];
const bank = { links:null, error:'', busy:'', timeout:false, timer:null, syncs:null, syncsMissing:false, historyOpen:false };

const bankAvailable = () => writeToDb() && canWrite();
/** La connexion qui compte : celle en cours ou active, sinon la plus récente. */
function bankCurrent(){
  const L = bank.links || [];
  return L.find(l=>BANK_LIVE.includes(l.status)) || L[0] || null;
}
/** Compte LazySyndic d'un compte bancaire : le choix du syndic, sinon l'IBAN reconnu par le pont. */
function bankAcctOf(l, a){
  const m = l.acct_map || {}, v = m[a.hash] ?? m[a.uid];
  if (v==='skip') return null;
  if (v==='pay' || v==='res') return v;
  return a.acct==='pay' || a.acct==='res' ? a.acct : null;
}
async function bankLoad(){
  try { bank.links = await window.LS.db.bankLinks(); bank.error = ''; }
  catch(e){
    bank.links = [];
    bank.error = /ls_bank_links|schema cache|does not exist|relation/i.test(e.message||'') ? 'missing' : (e.message||String(e));
  }
  // Historique : table arrivée après ls_bank_links. Absente, la carte le dit au lieu d'échouer.
  try { bank.syncs = await window.LS.db.bankSyncs(); bank.syncsMissing = false; }
  catch(e){ bank.syncs = []; bank.syncsMissing = /ls_bank_syncs|schema cache|does not exist|relation/i.test(e.message||''); }
}

/** Historique des synchros (ls_bank_syncs) : une ligne par passage du pont, réussi ou non. */
const BANK_CAUSE = {auto:'Automatique', manual:'À la demande', connect:'Connexion', cli:'Outil (VPS)'};
function bankHistoryHtml(){
  if (bank.syncsMissing) return `<div class="sub" style="margin-top:12px">Historique des synchros : la table <b>ls_bank_syncs</b> manque — relancez le SQL de la synchro bancaire (baseline §12).</div>`;
  const list = bank.syncs || [];
  if (!list.length) return '';
  const when = iso => new Date(iso).toLocaleString('fr-BE', {day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit'});
  const rows = list.map(s=>{
    const added = (s.added_pay||0) + (s.added_res||0), known = (s.known||0) + (s.matched||0);
    const parts = [s.added_pay ? `${s.added_pay} paiement` : '', s.added_res ? `${s.added_res} réserve` : ''].filter(Boolean).join(' · ');
    const result = !s.ok ? '<b style="color:var(--danger)">Échec</b>'
      : added ? `<b>${added} nouveau(x)</b> <span class="sub">${parts}</span>` : '<span class="sub">rien de nouveau</span>';
    const bal = s.balances || {};
    const balTxt = ['pay','res'].filter(k=>bal[k]!=null).map(k=>`${k==='pay'?'💳':'🏦'} ${eur(Number(bal[k]))}`).join('<br>');
    return `<tr><td style="white-space:nowrap">${when(s.at)}</td><td>${BANK_CAUSE[s.cause]||escH(s.cause)}</td>
      <td>${result}${s.error?`<div class="cmt" style="color:var(--danger)">${escH(s.error)}</div>`:''}${(s.warnings||[]).map(w=>`<div class="cmt">⚠ ${escH(w)}</div>`).join('')}</td>
      <td class="num">${known||'—'}</td><td class="num" style="white-space:nowrap">${balTxt||'—'}</td></tr>`;
  }).join('');
  const failed = list.filter(s=>!s.ok).length;
  const arrived = list.reduce((n,s)=>n+(s.added_pay||0)+(s.added_res||0), 0);
  return `<details id="bkHistory" style="margin-top:12px"${bank.historyOpen?' open':''}>
      <summary class="summary-btn">Historique des synchros · ${list.length} dernière(s) · ${arrived} mouvement(s) arrivé(s)${failed?` · <span style="color:var(--danger)">${failed} échec(s)</span>`:''}</summary>
      <table style="margin-top:6px"><tr><th>Quand</th><th>Déclenchée</th><th>Résultat</th><th class="num">Déjà connus</th><th class="num">Soldes banque</th></tr>${rows}</table>
    </details>`;
}
// la liste se redessine toutes les 3 s pendant une attente : elle garde son état déplié
function wireBankHistory(box){
  const d = box.querySelector('#bkHistory');
  if (d) d.ontoggle = ()=>{ bank.historyOpen = d.open; };
}
const bankStamp = () => new Date().toISOString();
const bankDay = iso => iso ? new Date(iso).toLocaleDateString('fr-BE') : '—';
function bankAgo(iso){
  if (!iso) return 'jamais';
  const m = Math.round((Date.now()-Date.parse(iso))/60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  if (m < 36*60) return `il y a ${Math.round(m/60)} h`;
  return `le ${bankDay(iso)}`;
}

/** Les lignes synchronisées arrivent sans catégorie (high vide) : règles, alias et
 *  copropriétaire, comme pour un relevé déposé. Persisté tout de suite. */
async function classifyBankDrafts(){
  if (!canWrite()) return 0;
  const todo = (state.draftTx||[]).filter(t=>t.bankRef && (t.high==null || t.high===''));
  for (const t of todo){
    const c = classifyImported({date:t.date, rawTiers:t.tiers, note:t.note, type:'', amount:t.amount, account:t.account});
    t.tiers = c.tiers; t.high = c.high; t.sub = c.sub||''; if (c.owner) t.owner = c.owner;
  }
  if (todo.length && writeToDb()){
    for (let i=0; i<todo.length; i+=8){
      await Promise.all(todo.slice(i, i+8).map(t=>window.LS.db.updateTransaction(t.id, {tiers:t.tiers, high:t.high, sub:t.sub, owner:t.owner||''})
        .catch(e=>console.warn('classement synchro', e.message||e))));
    }
  }
  return todo.length;
}

/** Après une connexion ou une synchro : les nouveaux brouillons sont en base, pas encore ici. */
async function bankReloadData(){
  try {
    const fresh = await window.LS.db.loadAll();
    fresh.draftTx = fresh.draftTx || [];
    state = fresh;
    if (state.owners && state.owners.length) OWNERS = state.owners;
    backfillAppliedByOwner();
  } catch(e){ console.error(e); showToast('Rechargement impossible : '+(e.message||e), 'err'); return; }
  await classifyBankDrafts();
  renderAll();
}

/** Attend que le pont ait fait sa part (la boîte aux lettres est relue toutes les 3 s). */
function bankWait(id, done, timeoutMs, then){
  clearInterval(bank.timer);
  bank.timeout = false;
  const t0 = Date.now();
  bank.timer = setInterval(async ()=>{
    await bankLoad();
    const l = (bank.links||[]).find(x=>x.id===id);
    const ok = !!(l && done(l));
    if (ok || Date.now()-t0 > timeoutMs){
      clearInterval(bank.timer); bank.timer = null; bank.busy = '';
      if (!ok) bank.timeout = true;
      renderBankCard();
      if (ok && then) await then(l);
      return;
    }
    renderBankCard();
  }, 3000);
}

/** Retour de la banque (banque.html a mis la réponse de côté) : on dépose le code pour le pont. */
async function bankConsumeCallback(){
  let cb = null;
  try { cb = JSON.parse(localStorage.getItem(BANK_CB_KEY)||'null'); localStorage.removeItem(BANK_CB_KEY); } catch(e){}
  if (!cb || !cb.state || Date.now()-(cb.at||0) > 30*60000) return;
  const l = (bank.links||[]).find(x=>x.state===cb.state);
  if (!l){ showToast('Retour de la banque non reconnu : relancez la connexion.', 'err'); return; }
  if (l.status!=='auth_ready') return;      // déjà traité (page rechargée)
  try {
    if (cb.error || !cb.code){
      const why = String(cb.error_description || cb.error || 'autorisation interrompue').slice(0, 300);
      await window.LS.db.bankLinkUpdate(l.id, {status:'error', error:`La banque a répondu : ${why}`, updated_at:bankStamp()});
      await bankLoad();
      return;
    }
    await window.LS.db.bankLinkUpdate(l.id, {status:'code_received', code:cb.code, updated_at:bankStamp()});
  } catch(e){ showToast('Retour de la banque non enregistré : '+(e.message||e), 'err'); return; }
  await bankLoad();
  bank.busy = 'session';
  bankWait(l.id, x=>x.status!=='code_received', 180000, async x=>{
    if (x.status==='active'){ showToast(`${x.aspsp_name} connectée — première synchro faite`); await bankReloadData(); }
  });
}

async function bankInit(){
  if (!bankAvailable()){ renderBankCard(); return; }
  if (await classifyBankDrafts()) renderAll();
  await bankLoad();
  await bankConsumeCallback();
  renderBankCard();
}

function bankRandomState(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID() + '-' + crypto.randomUUID();
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return [...b].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function bankConnect(name, country, psu){
  name = String(name||'').trim();
  if (!name){ showToast('Nom de la banque requis.', 'err'); return; }
  bank.busy = 'connect'; bank.timeout = false; renderBankCard();
  try {
    const row = {status:'requested', aspsp_name:name, aspsp_country:country, psu_type:psu,
      redirect_url:new URL('banque.html', location.href.split('#')[0]).href, state:bankRandomState()};
    const {id} = await window.LS.db.bankLinkAdd(row);
    await bankLoad(); renderBankCard();
    bankWait(id, l=>l.status!=='requested', 60000, l=>{
      if (l.status==='auth_ready' && l.auth_url) location.href = l.auth_url;   // chez la banque, puis retour sur banque.html
    });
  } catch(e){ bank.busy = ''; showToast('Connexion impossible : '+(e.message||e), 'err'); renderBankCard(); }
}

async function bankSyncNow(l){
  if (l.last_sync_at && Date.now()-Date.parse(l.last_sync_at) < 30*60000
      && !confirm('Dernière synchro '+bankAgo(l.last_sync_at)+'. Sans vous, une banque n’accepte que 4 consultations par jour : synchroniser quand même ?')) return;
  const asked = bankStamp();
  bank.busy = 'sync'; bank.timeout = false; renderBankCard();
  try { await window.LS.db.bankLinkUpdate(l.id, {sync_requested_at:asked}); }
  catch(e){ bank.busy = ''; showToast('Demande non enregistrée : '+(e.message||e), 'err'); renderBankCard(); return; }
  bankWait(l.id, x=>x.last_sync_at && Date.parse(x.last_sync_at) >= Date.parse(asked) - 1000, 180000, async x=>{
    const n = Object.values((x.last_sync||{}).added||{}).reduce((a,b)=>a+b, 0);
    if (x.last_sync && x.last_sync.error) showToast('Synchro en échec : '+x.last_sync.error, 'err');
    else showToast(n ? `${n} nouveau(x) mouvement(s) — relevé à valider ci-dessus` : 'Synchro faite — rien de nouveau');
    if (n) await bankReloadData();
  });
}

async function bankSetStatus(l, patch, waitFor){
  try { await window.LS.db.bankLinkUpdate(l.id, {...patch, updated_at:bankStamp()}); }
  catch(e){ showToast('Non enregistré : '+(e.message||e), 'err'); return; }
  await bankLoad(); renderBankCard();
  if (waitFor){ bank.busy = 'revoke'; bankWait(l.id, waitFor, 60000); }
}

function renderBankCard(){
  const box = document.getElementById('bankSync');
  if (!box) return;
  if (!bankAvailable()){ box.innerHTML = ''; return; }
  const wrap = (badge, body) => `<div class="card" style="margin-bottom:16px">
      <div class="h-row" style="align-items:flex-start;gap:12px">
        <div><h2 style="margin:0">Synchronisation bancaire</h2>
          <div class="sub">Les mouvements de la banque arrivent ici d’eux-mêmes, en relevé à valider. Via Enable Banking, en lecture seule.</div></div>
        ${badge||''}
      </div>${body}</div>`;
  const badge = (txt, cls) => `<span class="badge ${cls||''}" style="${cls?'':'background:var(--muted);color:var(--ink-soft)'};white-space:nowrap">${txt}</span>`;
  const btn = (id, label, kind) => `<button class="btn ${kind||'btn-ghost'}" id="${id}" type="button">${label}</button>`;
  if (bank.links===null){ box.innerHTML = wrap('', '<div class="sub" style="margin-top:10px">Chargement…</div>'); return; }
  if (bank.error==='missing'){
    box.innerHTML = wrap(badge('À installer'), `<div class="alert"><span class="ic">⚠</span><div>La table <b>ls_bank_links</b> n’existe pas encore : relancez <b>supabase/migrations/000_baseline.sql</b> dans Supabase (SQL Editor), puis rechargez la page.</div></div>`);
    return;
  }
  const l = bankCurrent();
  const timeoutMsg = bank.timeout ? `<div class="alert"><span class="ic">⚠</span><div><b>Le pont de synchro ne répond pas.</b> Il tourne sur le VPS avec <code>EB_APP_ID</code> et <code>EB_KEY_PATH</code> dans <code>bridge/.env</code> (voir bridge/README.md) ; sans lui, rien n’avance.</div></div>` : '';
  // Défauts = la copro : Swan, liée via « Swan (Belgium) » chez Enable Banking, comptes professionnels.
  const prevName = (l && l.aspsp_name) || 'Swan', prevCountry = (l && l.aspsp_country) || 'BE', prevPsu = (l && l.psu_type) || 'business';
  const form = (label) => `
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:12px">
        <label style="flex:2 1 180px"><div class="l" style="font-size:12px;color:var(--ink-faint)">Banque (nom chez Enable Banking)</div>
          <input class="fld" id="bkName" value="${escH(prevName)}" style="width:100%;margin-top:4px" autocomplete="off"></label>
        <label style="flex:1 1 120px"><div class="l" style="font-size:12px;color:var(--ink-faint)">Pays</div>
          <select class="fld" id="bkCountry" style="width:100%;margin-top:4px">${BANK_COUNTRIES.map(([c,n])=>`<option value="${c}" ${c===prevCountry?'selected':''}>${n}</option>`).join('')}</select></label>
        <label style="flex:1 1 140px"><div class="l" style="font-size:12px;color:var(--ink-faint)">Type de compte</div>
          <select class="fld" id="bkPsu" style="width:100%;margin-top:4px"><option value="business" ${prevPsu==='business'?'selected':''}>Professionnel (ACP)</option><option value="personal" ${prevPsu==='personal'?'selected':''}>Particulier</option></select></label>
        ${btn('bkConnect', bank.busy==='connect' ? 'Préparation…' : label, 'btn-primary')}
      </div>
      <div class="sub" style="margin-top:8px">La banque vous demande votre accord (soldes et mouvements, rien d’autre), puis vous ramène ici. L’accord dure jusqu’à 180 jours selon la banque ; LazySyndic vous prévient avant l’échéance.</div>`;
  const wireForm = () => {
    const b = box.querySelector('#bkConnect');
    if (b) b.onclick = ()=>{ if (bank.busy) return; bankConnect(box.querySelector('#bkName').value, box.querySelector('#bkCountry').value, box.querySelector('#bkPsu').value); };
  };

  // Rien de connecté (ou plus rien) : le formulaire, et la raison si la dernière tentative a échoué.
  if (!l || !BANK_LIVE.includes(l.status)){
    const why = l && (l.status==='error' || l.status==='expired') && l.error
      ? `<div class="alert"><span class="ic">⚠</span><div><b>${l.status==='expired'?'Connexion expirée':'Connexion non aboutie'}.</b> ${escH(l.error)}</div></div>` : '';
    box.innerHTML = wrap(l && l.status==='expired' ? badge('Expirée','b-late') : badge('Non connectée'), why + timeoutMsg + form(l && l.status==='expired' ? 'Reconnecter la banque' : 'Connecter la banque') + bankHistoryHtml());
    wireForm();
    wireBankHistory(box);
    return;
  }

  if (l.status==='requested' || l.status==='auth_ready' || l.status==='code_received'){
    const what = l.status==='requested' ? `Préparation du lien d’autorisation chez ${escH(l.aspsp_name)}…`
      : l.status==='auth_ready' ? `Autorisation en attente chez <b>${escH(l.aspsp_name)}</b>.`
      : `${escH(l.aspsp_name)} a donné son accord : ouverture de la session et première synchro…`;
    box.innerHTML = wrap(badge(l.status==='code_received' ? 'Connexion…' : 'En attente'), `
      <div class="sub" style="margin-top:12px;font-size:14px;color:var(--ink)">${what}</div>${timeoutMsg}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        ${l.status==='auth_ready' && l.auth_url ? `<a class="btn btn-primary" href="${escH(l.auth_url)}">Ouvrir la page de la banque</a>` : ''}
        ${l.status!=='code_received' || bank.timeout ? btn('bkCancel', 'Annuler') : ''}
      </div>`);
    const c = box.querySelector('#bkCancel');
    if (c) c.onclick = ()=>{ clearInterval(bank.timer); bank.busy=''; bankSetStatus(l, {status:'error', error:'Connexion annulée.'}); };
    // page rechargée pendant que le pont travaille : on reprend l'attente (une fois, pas en boucle)
    if (!bank.timer && !bank.timeout && l.status!=='auth_ready') bankWait(l.id, x=>!['requested','code_received'].includes(x.status), 120000, x=>{ if (x.status==='active') bankReloadData(); });
    return;
  }

  if (l.status==='revoke_requested'){
    box.innerHTML = wrap(badge('Déconnexion…'), `<div class="sub" style="margin-top:12px">Fermeture de la session chez ${escH(l.aspsp_name)}…</div>${timeoutMsg}`);
    if (!bank.timer && !bank.timeout) bankWait(l.id, x=>x.status!=='revoke_requested', 60000);
    return;
  }

  // Active.
  const daysLeft = l.valid_until ? Math.floor((Date.parse(l.valid_until)-Date.now())/86400000) : null;
  const soon = daysLeft!=null && daysLeft < 14;
  const accts = (l.accounts||[]).map(a=>{
    const target = bankAcctOf(l, a), key = a.hash || a.uid;
    const v = (l.acct_map||{})[key] ?? (target || '');
    return `<tr>
      <td><b>…${escH(String(a.iban||'').slice(-4) || '????')}</b> <span class="sub">${escH(a.name||a.product||'')}</span></td>
      <td><select class="fld bk-acct" data-key="${escH(key)}" style="${target?'':'border-color:var(--clay);box-shadow:0 0 0 3px var(--clay-soft)'}">
        ${target ? '' : '<option value="" selected>— choisir —</option>'}
        <option value="pay" ${v==='pay'?'selected':''}>💳 Compte de paiement</option>
        <option value="res" ${v==='res'?'selected':''}>🏦 Compte de réserve</option>
        <option value="skip" ${v==='skip'?'selected':''}>Ignorer ce compte</option></select></td>
      <td class="sub">${a.synced_to ? 'à jour au '+escH(bankDay(a.synced_to)) : (target ? 'première synchro à venir' : 'pas synchronisé')}</td>
      <td class="num">${a.balance ? eur(a.balance.amount) : '—'}</td></tr>`;
  }).join('');
  const ls = l.last_sync || {};
  const added = Object.values(ls.added||{}).reduce((x,y)=>x+y, 0);
  const lastLine = l.last_sync_at
    ? `Dernière synchro ${bankAgo(l.last_sync_at)} : ${ls.error ? '<b style="color:var(--danger)">en échec</b>' : (added ? `<b>${added}</b> nouveau(x) mouvement(s)` : 'rien de nouveau')}${(ls.known||ls.matched) ? ` · ${(ls.known||0)+(ls.matched||0)} déjà connu(s)` : ''}.`
    : 'Première synchro en cours…';
  const unmapped = (l.accounts||[]).some(a=>!bankAcctOf(l, a) && (l.acct_map||{})[a.hash||a.uid]!=='skip');
  box.innerHTML = wrap(soon ? badge(daysLeft<0?'Expirée':`Expire dans ${Math.max(0,daysLeft)} j`,'b-late') : badge('Active','b-ok'), `
    <div class="sub" style="margin-top:10px"><b>${escH(l.aspsp_name)}</b> (${escH(l.aspsp_country)}) · accord valable jusqu’au <b>${bankDay(l.valid_until)}</b> · synchro automatique toutes les quelques heures</div>
    ${soon ? `<div class="alert" style="background:var(--warning-soft);border-color:var(--warning);color:var(--warning-ink)"><span class="ic">⏳</span><div><b>L’accord donné à la banque arrive à échéance${daysLeft>=0?` dans ${daysLeft} jour(s)`:''}.</b> Renouvelez-le, sinon plus aucun mouvement n’arrivera.</div></div>` : ''}
    ${unmapped ? `<div class="alert" style="background:var(--warning-soft);border-color:var(--warning);color:var(--warning-ink)"><span class="ic">⚠</span><div>Un compte n’a pas été reconnu par son IBAN : choisissez où vont ses mouvements. Il n’est pas synchronisé d’ici là.</div></div>` : ''}
    ${accts ? `<table style="margin-top:10px"><tr><th>Compte</th><th>Dans LazySyndic</th><th>Synchro</th><th class="num">Solde banque</th></tr>${accts}</table>` : '<div class="sub" style="margin-top:10px">Aucun compte dans cette session.</div>'}
    <div class="sub" style="margin-top:10px">${bank.busy==='sync' ? 'Synchro demandée — le pont s’en charge (moins d’une minute)…' : lastLine}</div>
    ${ls.error ? `<div class="alert"><span class="ic">⚠</span><div>${escH(ls.error)}</div></div>` : ''}
    ${(ls.warnings||[]).map(w=>`<div class="sub" style="color:var(--warning-ink)">⚠ ${escH(w)}</div>`).join('')}
    ${timeoutMsg}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
      ${btn('bkSync', bank.busy==='sync' ? 'Synchro…' : 'Synchroniser maintenant', soon ? 'btn-ghost' : 'btn-primary')}
      ${btn('bkRenew', 'Renouveler l’accord', soon ? 'btn-primary' : 'btn-ghost')}
      <button class="btn btn-ghost" id="bkRevoke" type="button" style="color:var(--coral)">Déconnecter</button>
    </div>
    ${bankHistoryHtml()}`);
  wireBankHistory(box);
  box.querySelectorAll('.bk-acct').forEach(s=>s.onchange=async ()=>{
    if (!s.value) return;
    const map = {...(l.acct_map||{}), [s.dataset.key]: s.value};
    l.acct_map = map;
    try { await window.LS.db.bankLinkUpdate(l.id, {acct_map:map, updated_at:bankStamp()}); toastSaved(); }
    catch(e){ toastError(e.message||e); }
    renderBankCard();
  });
  box.querySelector('#bkSync').onclick = ()=>{ if (!bank.busy) bankSyncNow(l); };
  box.querySelector('#bkRenew').onclick = ()=>{ if (!bank.busy) bankConnect(l.aspsp_name, l.aspsp_country, l.psu_type); };
  box.querySelector('#bkRevoke').onclick = ()=>{
    if (bank.busy) return;
    if (!confirm(`Déconnecter ${l.aspsp_name} ? La synchro s’arrête ; les mouvements déjà arrivés restent.`)) return;
    bankSetStatus(l, {status:'revoke_requested'}, x=>x.status!=='revoke_requested');
  };
}

/* ============================================================
   ASSEMBLÉES GÉNÉRALES  (inchangé — démo interactive)
   ============================================================ */
/* ===== Assemblées générales (persistées en base) ===== */
const MAJ={simple:'Majorité simple',absolue:'Majorité absolue',deuxtiers:'Double tiers',quatrecinq:'Quatre cinquièmes',unanime:'Unanimité'};
const MAJPCT={simple:50,absolue:51,deuxtiers:67,quatrecinq:80,unanime:100};
const AG_STATUS={prep:'En cours de préparation',convoquee:'Convocations envoyées',tenue:'Séance tenue',finalisee:'AG finalisée'};
function agTotalQuot(){ return sum(ownersOf().map(o=>o.q))||1000; }
function agOwnerList(){ return ownersOf().map(o=>({n:o.n, short:o.short||o.n, q:o.q, c:o.c})); }
function majOptions(sel){return Object.entries(MAJ).map(([k,v])=>`<option value="${k}" ${k===sel?'selected':''}>${v}</option>`).join('');}

let curStep=1;
let currentAG=null;
function pickCurrentAG(){ currentAG=(state.ags||[]).find(a=>a.status!=='finalisee')||null; }

function setAgStatus(status){
  const st=document.getElementById('agStatus'); if(!st) return;
  // statuts du design : en préparation = warning, convoquée / tenue = info, finalisée = success
  const map={prep:['var(--warning-soft)','var(--border)','var(--warning-ink)','var(--warning)'],
             convoquee:['var(--info-soft)','var(--border)','var(--info)','var(--info)'],
             tenue:['var(--info-soft)','var(--border)','var(--info)','var(--info)'],
             finalisee:['var(--success-soft)','var(--border)','var(--success)','var(--success)']};
  const c=map[status]||map.prep;
  st.style.background=c[0]; st.style.borderColor=c[1]; st.style.color=c[2];
  const dot=st.querySelector('.dot'); if(dot) dot.style.background=c[3];
  if(st.childNodes[1]) st.childNodes[1].textContent=' '+(AG_STATUS[status]||status);
  else st.appendChild(document.createTextNode(' '+(AG_STATUS[status]||status)));
}

async function agCreateNew(){
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const ag={title:'Assemblée générale', ag_date:'', lieu:'', type:'Ordinaire', status:'prep', presence:{}, points:[]};
  if(writeToDb()){
    try{ const saved=await window.LS.db.agCreate({title:ag.title,type:ag.type,status:'prep',presence:{}});
      ag.id=saved.id; ag.created_at=saved.created_at; }
    catch(e){ alert('Création impossible : '+(e.message||e)); return; }
  } else { ag.id='local-ag-'+Date.now(); }
  state.ags=state.ags||[]; state.ags.unshift(ag);
  curStep=1; renderAG();
}

function renderAG(){
  pickCurrentAG();
  const stepper=document.getElementById('stepper'); if(!stepper) return;
  let createBox=document.getElementById('agCreateBox');
  if(!createBox){ createBox=document.createElement('div'); createBox.id='agCreateBox'; stepper.after(createBox); }
  const has=!!currentAG;
  stepper.style.display=has?'flex':'none';
  if(!has){
    document.querySelectorAll('#ag .agpanel').forEach(p=>p.style.display='none');
    createBox.style.display='block';
    createBox.innerHTML=`<div class="card" style="text-align:center;padding:36px">
      <div style="font-size:40px">🗳️</div>
      <h2 style="font-family:var(--display);font-size:20px;margin-top:8px">Aucune assemblée en cours</h2>
      <div class="sub" style="max-width:480px;margin:8px auto 20px">Créez une assemblée pour préparer l'ordre du jour, convoquer, tenir la séance et générer le PV. Les AG finalisées restent dans l'historique ci-dessous.</div>
      ${canWrite()?'<button class="btn btn-primary" id="agCreate">+ Nouvelle assemblée</button>':'<div class="sub">Seul le syndic peut créer une assemblée.</div>'}</div>`;
    createBox.querySelector('#agCreate')?.addEventListener('click',agCreateNew);
    const tt=document.getElementById('agTitle'); if(tt) tt.textContent='Assemblées générales';
    setAgStatus('prep');
  } else {
    createBox.style.display='none';
    const tt=document.getElementById('agTitle'); if(tt) tt.textContent=currentAG.title||'Assemblée générale';
    const d=document.getElementById('agDate'); if(d) d.value=currentAG.ag_date||'';
    const l=document.getElementById('agLieu'); if(l) l.value=currentAG.lieu||'';
    const ty=document.getElementById('agType'); if(ty) ty.value=currentAG.type||'Ordinaire';
    setAgStatus(currentAG.status);
    renderAgenda(); renderPresences(); renderSeance();
    goStep(curStep);
  }
  renderAGArchive();
}

// édition de l'en-tête (date / lieu / type)
['agDate','agLieu','agType'].forEach(id=>{
  document.getElementById(id)?.addEventListener('change',e=>{
    if(!currentAG||!canWrite()) return;
    const field = id==='agDate'?'ag_date':(id==='agLieu'?'lieu':'type');
    currentAG[field]=e.target.value;
    currentAG.title=(currentAG.type||'AG')+(currentAG.ag_date?(' — '+currentAG.ag_date):'');
    const tt=document.getElementById('agTitle'); if(tt) tt.textContent=currentAG.title;
    dbWrite(db=>db.agUpdate(currentAG.id,{[field]:e.target.value, title:currentAG.title}));
  });
});

function persistPoint(p, patch){ Object.assign(p,patch); dbWrite(db=>db.agPointUpdate(p.id,patch)); }

function renderAgenda(){
  const wrap=document.getElementById('agenda'); if(!wrap||!currentAG) return; wrap.innerHTML='';
  const pts=currentAG.points; const ro=!canWrite();
  pts.forEach((p,i)=>{
    const isDec=p.kind==='decision';
    const card=document.createElement('div'); card.className='card'; card.style.marginBottom='12px';
    card.innerHTML=`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-family:var(--display);font-weight:600;color:var(--ink-faint)">${i+1}</span>
        <input class="fld pt-title" ${ro?'disabled':''} style="flex:1;font-weight:600" value="${(p.title||'').replace(/"/g,'&quot;')}">
        <select class="fld pt-kind" ${ro?'disabled':''} style="width:130px"><option value="decision" ${isDec?'selected':''}>Décision</option><option value="info" ${!isDec?'selected':''}>Information</option></select>
        <button class="flagbtn pt-up" style="opacity:.5" title="Monter">↑</button>
        <button class="flagbtn pt-down" style="opacity:.5" title="Descendre">↓</button>
        <button class="flagbtn pt-del" style="opacity:.5" title="Supprimer">✕</button>
      </div>
      <div ${ro?'':'contenteditable'} class="fld pt-body" style="padding:10px 12px;min-height:44px;font-size:13.5px;color:var(--ink-soft)">${p.body||''}</div>
      <div class="pt-majwrap" style="display:${isDec?'flex':'none'};gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
        <label style="font-size:12px;color:var(--ink-faint)">Majorité requise</label>
        <select class="fld pt-maj" ${ro?'disabled':''}>${majOptions(p.majorite)}</select>
        <span class="cat acp pt-pct">${MAJPCT[p.majorite]} %</span>
        <label style="font-size:12px;color:var(--ink-faint);margin-left:10px">Clé</label>
        <select class="fld pt-cle" ${ro?'disabled':''}><option ${p.cle==='Acte de base'?'selected':''}>Acte de base</option><option ${p.cle!=='Acte de base'?'selected':''}>Individuelle</option></select>
      </div>`;
    if(!ro){
      card.querySelector('.pt-title').onchange=e=>persistPoint(p,{title:e.target.value});
      card.querySelector('.pt-body').onblur=e=>persistPoint(p,{body:e.target.innerText});
      card.querySelector('.pt-kind').onchange=e=>{persistPoint(p,{kind:e.target.value}); renderAgenda(); renderSeance();};
      card.querySelector('.pt-maj').onchange=e=>{persistPoint(p,{majorite:e.target.value}); card.querySelector('.pt-pct').textContent=MAJPCT[e.target.value]+' %'; renderSeance();};
      card.querySelector('.pt-cle').onchange=e=>persistPoint(p,{cle:e.target.value});
      card.querySelector('.pt-up').onclick=()=>movePoint(i,-1);
      card.querySelector('.pt-down').onclick=()=>movePoint(i,1);
      card.querySelector('.pt-del').onclick=()=>delPoint(p,i);
    }
    wrap.appendChild(card);
  });
  const c=document.getElementById('ptCount'); if(c) c.textContent=pts.length+' point'+(pts.length>1?'s':'');
}
function movePoint(i,dir){
  const pts=currentAG.points, j=i+dir; if(j<0||j>=pts.length) return;
  [pts[i],pts[j]]=[pts[j],pts[i]];
  pts.forEach((p,k)=>{ if(p.pos!==k){ p.pos=k; dbWrite(db=>db.agPointUpdate(p.id,{pos:k})); }});
  renderAgenda(); renderSeance();
}
function delPoint(p,i){
  if(!canWrite()) return;
  currentAG.points.splice(i,1);
  dbWrite(db=>db.agPointDelete(p.id));
  renderAgenda(); renderSeance();
}
document.getElementById('addPoint')?.addEventListener('click',()=>{
  if(!currentAG){ alert('Créez d’abord une assemblée.'); return; }
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const pos=currentAG.points.length;
  const p={pos, title:'Nouveau point', body:'', kind:'decision', majorite:'simple', cle:'Acte de base', votes:{}, seance_notes:'', decision:''};
  currentAG.points.push(p);
  renderAgenda(); renderSeance();
  dbWrite(async db=>{ const s=await db.agPointAdd({ag_id:currentAG.id,pos,title:p.title,kind:'decision',majorite:'simple',cle:'Acte de base'}); p.id=s.id; });
});

// --- Ordre du jour standard d'une AG ordinaire : les points que la loi et l'usage ramènent chaque
//     année (comptes de l'exercice écoulé, décharge, commissaire aux comptes, budget prévisionnel
//     avec son Annexe 4, mandat du syndic, divers). Proposés, pas imposés : ceux qui existent déjà
//     ne sont pas doublés, et chacun reste modifiable comme n'importe quel point.
const BUDGET_POINT_RE = /budget\s+pr[ée]visionnel\s+(\d{4})/i;
const budgetPointYear = p => { const m = BUDGET_POINT_RE.exec(String((p&&p.title)||'')); return m ? +m[1] : null; };
function agYearOf(ag){ const d=parseFrDate((ag||{}).ag_date); return d && !isNaN(d) ? d.getFullYear() : new Date().getFullYear(); }
// L'exercice dont l'AG approuve le budget : celui de l'année de l'AG s'il est préparé, sinon le suivant.
function agBudgetYear(ag){
  const y=agYearOf(ag), has=k=>{ const b=(state.charges||{})[k]; return !!b && (((b.postes||[]).length) || ((b.reserve||[]).length)); };
  return has(y) ? y : has(y+1) ? y+1 : y;
}
function standardAgenda(ag){
  const y=agYearOf(ag), N=y-1, by=agBudgetYear(ag), cn=(state.coproName||'').trim()||'la copropriété';
  const bal=a=>eur(balanceAt(a, `${N}-12-31`));
  let budgetBody=`Budget ${by} à préparer dans Budget & copropriétaires › Calcul des charges ; l'Annexe 4 sera jointe à la convocation.`;
  try {
    const b=chargesBudget(by);
    if (b.postes.length || b.reserve.length){
      const s=budgetSplit(by), pay=sum(s.charges.map(c=>c.annual)), res=sum(s.res.map(r=>r.reserve));
      budgetBody=`Fonds de roulement ${eur(pay)} (charges courantes du compte de paiement), fonds de réserve ${eur(res)}, soit ${eur(pay+res)} pour l'année et ${eur((pay+res)/12)} par mois toutes quotités (marge ${LSCharges.cleanMarge(b.marge)} %). Répartition par copropriétaire selon la clé de chaque poste ; contribution au fonds de réserve conforme à l'art. 3.86 § 3. Annexe 4 jointe.`;
    }
  } catch(e){ console.error(e); }
  return [
    { title:`Approbation des comptes ${N}`, kind:'decision', majorite:'simple',
      body:`Comptes de l'exercice ${N} de ${cn} : recettes et dépenses, situation de trésorerie, créances et dettes, présentés dans le rapport financier ${N} joint. Soldes au 31/12/${N} : compte de paiement ${bal('pay')}, compte de réserve ${bal('res')}.` },
    { title:`Décharge au syndic pour l'exercice ${N}`, kind:'decision', majorite:'simple',
      body:`Quitus au syndic pour sa gestion de l'exercice ${N}.` },
    { title:`Désignation du commissaire aux comptes`, kind:'decision', majorite:'simple',
      body:`L'assemblée désigne chaque année un commissaire aux comptes, copropriétaire ou non, chargé de vérifier les comptes (art. 3.91 du Code civil).` },
    { title:`Approbation du budget prévisionnel ${by}`, kind:'decision', majorite:'simple', body:budgetBody },
    { title:`Mandat du syndic`, kind:'decision', majorite:'simple',
      body:`Renouvellement du mandat du syndic ; sa durée ne peut excéder trois ans (art. 3.89 § 1er).` },
    { title:`Divers`, kind:'info', majorite:'simple', body:`Questions des copropriétaires, sans vote.` },
  ];
}
function proposeStandardAgenda(){
  if(!currentAG){ alert('Créez d’abord une assemblée.'); return; }
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const have=currentAG.points.map(p=>norm(p.title));
  const key=t=>norm(t).replace(/\d{4}/g,'').trim();
  const add=standardAgenda(currentAG).filter(sp=>!have.some(h=>h.replace(/\d{4}/g,'').trim()===key(sp.title)));
  if(!add.length){ showToast('Tous les points de l’ordre du jour standard sont déjà là.'); return; }
  add.forEach(sp=>{
    const pos=currentAG.points.length;
    const p={pos, title:sp.title, body:sp.body, kind:sp.kind, majorite:sp.majorite, cle:'Acte de base', votes:{}, seance_notes:'', decision:''};
    currentAG.points.push(p);
    dbWrite(async db=>{ const s=await db.agPointAdd({ag_id:currentAG.id,pos,title:p.title,body:p.body,kind:p.kind,majorite:p.majorite,cle:'Acte de base'}); p.id=s.id; });
  });
  renderAgenda(); renderSeance();
  showToast(`${add.length} point${add.length>1?'s':''} ajouté${add.length>1?'s':''} à l'ordre du jour.`);
}
document.getElementById('agStdAgenda')?.addEventListener('click', proposeStandardAgenda);
// À la finalisation de l'AG, la décision sur « Approbation du budget prévisionnel N » remonte dans le
// budget N : approuvé (badge, Annexe 4, appels de fonds) ou non, avec une ligne de chronologie.
function syncBudgetApproval(ag){
  if(!ag || !canWrite()) return;
  (ag.points||[]).forEach((p,i)=>{
    const y=budgetPointYear(p); if(!y || p.kind!=='decision') return;
    const b=(state.charges||{})[y]; if(!b) return;
    const adopted = p.decision ? p.decision==='Adopté' : agTally(ag,p).adopted;
    const prev=b.approved||null;
    if (adopted){
      if (prev && prev.agId===ag.id) return;
      const d=parseFrDate(ag.ag_date), iso=d&&!isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : todayISO();
      // approuvé par l'AG = publié aux copropriétaires, de fait
      saveCharges(y, b.postes||[], {approved:{agId:ag.id, agTitle:ag.title||'', date:iso, point:i+1}, status:'published', publishedAt:b.publishedAt||new Date().toISOString()});
      logTimeline({title:`Budget ${y} approuvé par l'AG`, kind:'manual', description:`Point ${i+1} « ${p.title} » adopté le ${fmtDateLong(iso)}. L'Annexe 4 et les appels de fonds portent la mention.`});
    } else if (prev && prev.agId===ag.id){
      saveCharges(y, b.postes||[], {approved:null});
      logTimeline({title:`Budget ${y} non approuvé par l'AG`, kind:'manual', description:`Point ${i+1} « ${p.title} » rejeté : le budget reste soumis à une prochaine assemblée.`});
    }
  });
}

// --- Convocation : un e-mail mis en page (modèle Outlook, aux couleurs de LazySyndic) et, en pièce
//     jointe, la convocation complète + le formulaire de procuration (PDF). convocation.js
//     (LSConvocation) construit le texte, le HTML, le .eml et le PDF ; ici : les données depuis
//     l'état, les destinataires et les gestes (aperçu, copier pour Outlook, composer, .eml, PDF),
//     pour tous les copropriétaires ou nominativement pour un seul. ---
function sansAccents(s){ return String(s||'').normalize('NFD').replace(/\p{M}/gu,''); }
// « 22/06/2026 19h00 », « 2026-06-22 », « 22 juin 2026 · 19h00 » → Date (minuit local) ; null sinon
function parseFrDate(s){
  s=sansAccents(s).toLowerCase();
  let m=s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if(m){ let y=+m[3]; if(y<100) y+=2000; return new Date(y,+m[2]-1,+m[1]); }
  m=s.match(/(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})/);
  if(m){ const k=['janvier','fevrier','mars','avril','mai','juin','juillet','aout','septembre','octobre','novembre','decembre'].indexOf(m[2]); if(k>=0) return new Date(+m[3],k,+m[1]); }
  return null;
}
// « 19h00 », « 19:30 », « 19 h » dans la date saisie → 'HHhMM' ; '' sans heure lisible
function agTimeLabel(label){ const m=sansAccents(label).match(/(\d{1,2})\s*[h:]\s*(\d{2})?/i); return m?`${String(+m[1]).padStart(2,'0')}h${m[2]||'00'}`:''; }
// Date + heure de la séance (pour le rendez-vous .ics) ; null sans date lisible
function agStart(ag){
  const d=parseFrDate(ag.ag_date); if(!d) return null;
  const m=sansAccents(ag.ag_date||'').match(/(\d{1,2})\s*[h:]\s*(\d{2})?/i); if(m) d.setHours(+m[1],+(m[2]||0),0,0);
  return d;
}
// Délai entre l'envoi (ou aujourd'hui) et la séance — 15 jours minimum (art. 3.87 §3 C. civ.)
function convocationDelay(ag){
  const d=parseFrDate(ag.ag_date); if(!d) return null;
  const sent=parseFrDate(ag.convocation_date);
  const from=sent||new Date(new Date().getFullYear(),new Date().getMonth(),new Date().getDate());
  return {days:Math.round((d-from)/86400000), sent:!!sent};
}
// Les copropriétaires à convoquer : tous sauf le syndic lui-même (même liste que le relevé de compte)
function convocationRecipients(){
  const m=(window.LS&&window.LS.member)||{};
  const me=String(m.userEmail||m.email||'').toLowerCase();
  const others=ownersOf().filter(o=>!(o.email && o.email.toLowerCase()===me) && o.n!==m.full_name);
  return { syndic:(m.full_name||'').trim()||'Le syndic', from:me, others,
           to: others.filter(o=>o.email).map(o=>o.email), missing: others.filter(o=>!o.email).map(o=>o.n) };
}
// Les données du modèle (convocation.js). `owner` = un copropriétaire pour un message nominatif, sinon générique.
function convocationData(ag, owner){
  const r=convocationRecipients(), d=parseFrDate(ag.ag_date), dl=convocationDelay(ag);
  const lots=owner ? lotsOf().filter(l=>l.owner_id!=null && l.owner_id===owner.id).map(l=>l.designation||l.label).filter(Boolean).join(', ') : '';
  return {
    copro:{name:(state.coproName||'').trim()||'la copropriété', addr:state.coproAddr||'', kbo:state.coproKbo||''},
    type:String(ag.type||'ordinaire').toLowerCase(),
    dateLabel:ag.ag_date||'', dateLong:d?d.toLocaleDateString('fr-BE',{weekday:'long',day:'numeric',month:'long',year:'numeric'}):'',
    timeLabel:agTimeLabel(ag.ag_date||''), start:agStart(ag), lieu:ag.lieu||'',
    points:(ag.points||[]).map((p,i)=>({n:i+1, title:p.title||'', kind:p.kind, maj:MAJ[p.majorite]||'', pct:MAJPCT[p.majorite]||0, body:String(p.body||'').trim()})),
    syndic:{name:r.syndic, email:r.from},
    sentLabel:ag.convocation_date||new Date().toLocaleDateString('fr-BE'),
    delayDays:dl?dl.days:null,
    recipient:owner?{name:owner.n, lots}:null,
    // l'image d'en-tête du mail (le symbole, en PNG : Outlook ne lit pas le SVG) ; remplacée par un cid: dans le .eml
    logoSrc:new URL('brand/icon-180.png',document.baseURI).href,
  };
}
// Le logo horizontal en PNG, pour les PDF (pdf-lib ne lit pas le SVG) ; null si le rendu échoue
let _brandPngP=null;
function brandLogoPng(){
  return _brandPngP = _brandPngP || new Promise(res=>{
    const img=new Image();
    img.onload=()=>{ try{
      const c=document.createElement('canvas'); c.width=263*4; c.height=64*4;
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      c.toBlob(b=>{ if(!b) return res(null); b.arrayBuffer().then(x=>res(new Uint8Array(x)),()=>res(null)); },'image/png');
    }catch(e){ res(null); } };
    img.onerror=()=>res(null);
    img.src='brand/logo.svg';
  });
}
const brandMarkPng=()=>fetch('brand/icon-180.png').then(x=>x.ok?x.arrayBuffer():null).then(b=>b?new Uint8Array(b):null).catch(()=>null);
// Copie le HTML (et sa version texte) dans le presse-papiers : collé dans Outlook, Mail ou Gmail,
// le message garde sa mise en page. À appeler dans le geste, avant tout await (Safari refuse sinon).
function copyRichText(html, text){
  const fallback=()=>{
    const host=document.createElement('div'); host.contentEditable='true';
    host.style.cssText='position:fixed;left:-9999px;top:0;width:600px;opacity:0;pointer-events:none';
    host.innerHTML=html; document.body.appendChild(host);
    const r=document.createRange(); r.selectNodeContents(host); const s=getSelection(); s.removeAllRanges(); s.addRange(r);
    let ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
    s.removeAllRanges(); host.remove(); return ok;
  };
  if(navigator.clipboard && window.ClipboardItem){
    try{
      const item=new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([text],{type:'text/plain'})});
      return navigator.clipboard.write([item]).then(()=>true, ()=>fallback());
    }catch(e){}
  }
  return Promise.resolve(fallback());
}
async function convocationPdf(d){ return LSConvocation.buildPdf(await loadPdfLib(), {...d, logo:await brandLogoPng()}); }
// Les gestes de l'étape 2. `owner` = message nominatif pour ce copropriétaire ; null = tous.
async function convocationAct(act, owner){
  if(!currentAG){ alert('Aucune assemblée.'); return; }
  if(act==='preview'){ openConvPreview(owner); return; }
  const L=LSConvocation, r=convocationRecipients(), d=convocationData(currentAG, owner);
  const to=owner ? (owner.email?[owner.email]:[]) : r.to;
  const subj=L.subject(d), txt=L.text(d);
  const fail=(what,e)=>{ console.error(e); showToast(`${what} impossible à générer : ${e&&e.message||e}`,'err'); };
  if(act==='copy'){
    const ok=await copyRichText(L.htmlBody(d), txt);
    showToast(ok?'Modèle copié : collez-le dans un nouveau message Outlook (⌘V), puis joignez le PDF.':'Copie impossible ici : passez par le fichier .eml.', ok?'':'err');
    return;
  }
  if(act==='compose'){
    const copied=copyRichText(L.htmlBody(d), txt);                    // dans le geste, avant tout await
    const addr=to.map(e=>encodeURIComponent(e).replace(/%40/g,'@')).join(',');
    location.href=`mailto:${addr}?subject=${encodeURIComponent(subj)}`;
    markConvoked();
    let ok=false; try{ ok=await copied; }catch(e){}
    try{ saveBytes(await convocationPdf(d), L.fileName(d,'pdf'));
         showToast(ok?'Message ouvert, modèle copié (⌘V pour le coller) et PDF téléchargé : joignez-le avant d’envoyer.'
                     :'Message ouvert et PDF téléchargé : joignez-le avant d’envoyer.'); }
    catch(e){ fail('PDF',e); }
    return;
  }
  if(act==='pdf'){
    try{ saveBytes(await convocationPdf(d), L.fileName(d,'pdf')); showToast('Convocation et procuration téléchargées (PDF).'); }
    catch(e){ fail('PDF',e); }
    return;
  }
  if(act==='eml'){
    try{
      const [bytes, mark]=await Promise.all([convocationPdf(d), brandMarkPng()]);
      const cid='logo@lazysyndic', ics=L.ics(d);
      const eml=L.eml({from:r.from, fromName:r.syndic, to, subject:subj, text:txt,
        html:L.html({...d, logoSrc: mark ? 'cid:'+cid : d.logoSrc}),
        logo: mark ? {bytes:mark, cid} : null,
        pdf:{name:L.fileName(d,'pdf'), bytes},
        ics: ics ? {name:'assemblee-generale.ics', text:ics} : null});
      downloadBlob(new Blob([eml],{type:'message/rfc822'}), L.fileName(d,'eml'));
      markConvoked();
      showToast('Brouillon prêt, PDF et rendez-vous joints : ouvrez le fichier .eml dans Outlook pour l’envoyer.');
    }catch(e){ fail('Brouillon',e); }
  }
}
function markConvoked(){
  if(!canWrite() || !currentAG || currentAG.status!=='prep') return;
  currentAG.status='convoquee'; currentAG.convocation_date=new Date().toLocaleDateString('fr-BE');
  setAgStatus('convoquee');
  dbWrite(db=>db.agUpdate(currentAG.id,{status:'convoquee',convocation_date:currentAG.convocation_date}));
  renderConvInfo();
}
let _convCss=false;
function convCss(){
  if(_convCss) return; _convCss=true;
  const css=document.createElement('style');
  css.textContent=`
    .cv-list .cv-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:6px 0}
    .cv-list .cv-row+.cv-row{border-top:1px solid var(--border)}
    .cv-acts{display:flex;gap:6px}
    .cv-acts .rb{margin-left:0}
    .cv-acts .rb:disabled{opacity:.45;cursor:not-allowed}
    #convModal{position:fixed;inset:0;background:oklch(.19 .024 166 / .55);z-index:120;display:none;align-items:center;justify-content:center;padding:16px}
    #convModal.open{display:flex}
    .cv-card{width:760px;max-width:100%;max-height:94vh;display:flex;flex-direction:column;border-radius:var(--radius);padding:0;box-shadow:var(--shadow-lg);overflow:hidden}
    .cv-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
    .cv-head h2{margin:0;font-size:16px;flex:1 1 auto}
    .cv-head select{max-width:280px}
    .cv-frame{flex:1 1 auto;min-height:300px;height:62vh;border:0;background:var(--background);width:100%;display:block}
    .cv-bar{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;padding:12px 18px;border-top:1px solid var(--border)}
    .cv-note{font-size:12px;color:var(--muted-foreground);margin-right:auto;flex:1 1 220px}
    @media (max-width:560px){ .cv-bar .btn{flex:1 1 100%;justify-content:center} }`;
  document.head.appendChild(css);
}
let _convModal=null;
function convModal(){
  if(_convModal) return _convModal;
  convCss();
  const m=document.createElement('div'); m.id='convModal';
  m.innerHTML=`<div class="card cv-card" role="dialog" aria-modal="true" aria-labelledby="cvTitle">
    <div class="cv-head"><h2 id="cvTitle">Aperçu de la convocation</h2>
      <select class="fld" id="cvWho" aria-label="Destinataire"></select>
      <button class="btn btn-ghost btn-sm" id="cvClose" aria-label="Fermer">✕</button></div>
    <iframe class="cv-frame" id="cvFrame" title="Aperçu de l’e-mail" sandbox="allow-same-origin"></iframe>
    <div class="cv-bar"><span class="cv-note">Ce que reçoit le copropriétaire. Le PDF joint reprend la convocation complète et le formulaire de procuration.</span>
      <button class="btn btn-ghost btn-sm" data-act="pdf">PDF</button>
      <button class="btn btn-ghost btn-sm" data-act="eml">Fichier .eml</button>
      <button class="btn btn-ghost btn-sm" data-act="copy">Copier pour Outlook</button>
      <button class="btn btn-primary btn-sm" data-act="compose">Composer</button></div></div>`;
  document.body.appendChild(m);
  const close=()=>m.classList.remove('open');
  m.addEventListener('click',e=>{ if(e.target===m) close(); });
  m.querySelector('#cvClose').onclick=close;
  document.addEventListener('keydown',e=>{ if(e.key==='Escape' && m.classList.contains('open')) close(); });
  m.querySelector('#cvWho').onchange=()=>renderConvPreview();
  m.querySelectorAll('.cv-bar [data-act]').forEach(b=>b.onclick=()=>convocationAct(b.dataset.act, convPreviewOwner()));
  return _convModal=m;
}
function convPreviewOwner(){ const v=convModal().querySelector('#cvWho').value; return v===''?null:(convocationRecipients().others[+v]||null); }
function renderConvPreview(){
  if(!currentAG) return;
  convModal().querySelector('#cvFrame').srcdoc=LSConvocation.html(convocationData(currentAG, convPreviewOwner()));
}
function openConvPreview(owner){
  const m=convModal(), sel=m.querySelector('#cvWho'), r=convocationRecipients();
  sel.innerHTML=`<option value="">Tous les copropriétaires (message générique)</option>`
    +r.others.map((o,i)=>`<option value="${i}">${escH(o.n)}${o.email?'':' — sans e-mail'}</option>`).join('');
  const i=owner?r.others.indexOf(owner):-1; sel.value=i>=0?String(i):'';
  renderConvPreview(); m.classList.add('open');
}
function renderConvInfo(){
  const el=document.getElementById('agConvInfo'); if(!el||!currentAG) return;
  convCss();
  const r=convocationRecipients(), dl=convocationDelay(currentAG);
  const who=r.others.map((o,i)=>`<div class="cv-row"><div class="cv-who"><b>${escH(o.n)}</b> ${o.email?`<span class="sub">${escH(o.email)}</span>`:'<span style="color:var(--danger)">— e-mail manquant</span>'}</div>
      <div class="cv-acts"><button class="rb" data-conv="preview" data-i="${i}" title="Aperçu du message nominatif">Aperçu</button><button class="rb" data-conv="compose" data-i="${i}" ${o.email?'':'disabled'} title="Message nominatif dans ma messagerie, PDF téléchargé">Composer</button><button class="rb" data-conv="eml" data-i="${i}" title="Brouillon .eml nominatif, PDF et rendez-vous joints">.eml</button></div></div>`).join('');
  let delay;
  if(!dl) delay=`<div class="alert" style="background:var(--warning-soft);border-color:oklch(.88 .07 80);color:var(--warning-ink)"><span class="ic">i</span> Indiquez la date de l’AG à l’étape 1 (ex. 22/06/2026 19h00) pour vérifier le délai légal de 15 jours.</div>`;
  else if(dl.days>=15) delay=`<div class="alert" style="background:var(--success-soft);border-color:oklch(.88 .05 160);color:var(--success)"><span class="ic">✓</span> Délai légal respecté : ${dl.sent?'envoyée':'envoi'} ${dl.days} jours avant la séance (minimum 15).</div>`;
  else delay=`<div class="alert"><span class="ic">!</span> ${dl.days<0?'La date de l’AG est passée.':`Seulement ${dl.days} jour${dl.days>1?'s':''} avant la séance : le minimum légal est de 15 jours (art. 3.87 §3), sauf urgence.`}</div>`;
  el.innerHTML=`<div class="mini-h" style="margin-top:0">Destinataires — un message nominatif par copropriétaire, ou un envoi groupé</div>
    <div class="sg-signers cv-list">${who||'<div class="sub">Aucun autre copropriétaire.</div>'}</div>
    ${r.missing.length?`<div class="sub" style="margin-top:6px">Ajoutez les e-mails dans <b>Budget &amp; copro › Copropriétaires &amp; lots</b> ; en attendant, complétez le destinataire dans votre messagerie.</div>`:''}
    ${delay}
    ${currentAG.convocation_date?`<div class="sub" style="margin-bottom:10px">Convocation marquée envoyée le ${escH(currentAG.convocation_date)}.</div>`:''}`;
  el.querySelectorAll('[data-conv]').forEach(b=>b.onclick=()=>convocationAct(b.dataset.conv, r.others[+b.dataset.i]||null));
}
document.getElementById('mailConv')?.addEventListener('click',()=>convocationAct('compose',null));
document.getElementById('prevConv')?.addEventListener('click',()=>convocationAct('preview',null));
document.getElementById('copyConv')?.addEventListener('click',()=>convocationAct('copy',null));
document.getElementById('genConv')?.addEventListener('click',()=>convocationAct('eml',null));
document.getElementById('pdfConv')?.addEventListener('click',()=>convocationAct('pdf',null));

function setPresence(short,patch){
  if(!currentAG) return;
  currentAG.presence=currentAG.presence||{};
  currentAG.presence[short]={...(currentAG.presence[short]||{status:'pre'}),...patch};
  dbWrite(db=>db.agUpdate(currentAG.id,{presence:currentAG.presence}));
}
function renderPresences(){
  const wrap=document.getElementById('presences'); if(!wrap||!currentAG) return; wrap.innerHTML='';
  const pres=currentAG.presence||{}; const ro=!canWrite();
  agOwnerList().forEach(o=>{
    const st=(pres[o.short]&&pres[o.short].status)||'pre';
    const card=document.createElement('div'); card.className='card'; card.style.marginBottom='10px';
    card.innerHTML=`<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="a" style="width:28px;height:28px;background:${o.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700">${(o.n||'?')[0]}</span>
      <b style="font-size:14px">${o.n}</b><span style="color:var(--ink-faint);font-size:13px">${o.q} millièmes</span>
      <div class="seg pres" data-short="${o.short}" data-q="${o.q}" style="margin-left:auto">
        <button data-st="pre" class="${st==='pre'?'on':''} p-pre">Présent</button>
        <button data-st="rep" class="${st==='rep'?'on':''} p-rep">Représenté</button>
        <button data-st="exc" class="${st==='exc'?'on':''} p-exc">Excusé</button>
        <button data-st="abs" class="${st==='abs'?'on':''} p-abs">Absent</button>
      </div></div>
      <div class="repname" data-short="${o.short}" style="display:${st==='rep'?'block':'none'};margin-top:10px">
        <input class="fld pres-mand" ${ro?'disabled':''} style="width:100%" placeholder="Nom du mandataire pour ${o.n}…" value="${((pres[o.short]&&pres[o.short].mandataire)||'').replace(/"/g,'&quot;')}">
      </div>`;
    wrap.appendChild(card);
  });
  if(!ro){
    wrap.querySelectorAll('.pres').forEach(seg=>{
      seg.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
        seg.querySelectorAll('button').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
        const short=seg.dataset.short, stt=btn.dataset.st;
        const rep=document.querySelector(`.repname[data-short="${short}"]`); if(rep) rep.style.display=stt==='rep'?'block':'none';
        setPresence(short,{status:stt}); computeQuorum(); renderBureau(); renderSeance();
      });
    });
    wrap.querySelectorAll('.pres-mand').forEach(inp=>inp.onchange=()=>{
      const short=inp.closest('.repname').dataset.short; setPresence(short,{mandataire:inp.value});
    });
  }
  computeQuorum();
  renderBureau();
}
function computeQuorum(){
  if(!currentAG) return;
  const pres=currentAG.presence||{}; let q=0;
  agOwnerList().forEach(o=>{ const s=(pres[o.short]&&pres[o.short].status)||'pre'; if(s==='pre'||s==='rep') q+=o.q; });
  const tot=agTotalQuot();
  const qn=document.getElementById('quorumNum'); if(qn) qn.textContent=q;
  const card=document.getElementById('quorumCard'),ok=q>=Math.floor(tot/2)+1;
  const qt=document.getElementById('quorumTxt'); if(qt) qt.textContent=ok?'Quorum atteint — la séance peut délibérer':'Quorum non atteint';
  if(card){card.style.background=ok?'var(--green-soft)':'var(--coral-soft)';card.style.borderColor=ok?'oklch(.88 .05 160)':'oklch(.88 .05 30)';}
}

function renderSeance(){
  const wrap=document.getElementById('seance'); if(!wrap||!currentAG) return; wrap.innerHTML='';
  const ro=!canWrite();
  currentAG.points.forEach((p,idx)=>{
    const isDec=p.kind==='decision';
    const card=document.createElement('div'); card.className='card'; card.style.marginBottom='12px';
    let votesHtml='';
    if(isDec){
      votesHtml=`<div style="margin-top:12px">${agOwnerList().map(o=>{
        const v=agVote(currentAG,p,o);
        const who=`<span class="a" style="width:24px;height:24px;background:${o.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700">${(o.n||'?')[0]}</span>
          <span style="font-size:13.5px;flex:1">${o.n} <span style="color:var(--ink-faint)">· ${o.q}</span></span>`;
        if(v===null) return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2);opacity:.6">${who}
          <span class="sub">${agPresenceStatus(currentAG,o)==='exc'?'Excusé':'Absent'} — ne vote pas</span></div>`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2)">
          ${who}
          <div class="seg vote" data-pt="${idx}" data-short="${o.short}" data-q="${o.q}">
            <button data-v="pour" class="${v==='pour'?'on':''} vp">Pour</button>
            <button data-v="contre" class="${v==='contre'?'on':''} vc">Contre</button>
            <button data-v="abst" class="${v==='abst'?'on':''} va">Abst.</button>
          </div></div>`;}).join('')}
        <div class="verdict" data-pt="${idx}" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:10px 14px;background:var(--green-soft);border-radius:11px">
          <span class="vtxt" style="font-size:13px;color:var(--ink-soft)"></span>
          <span class="vbadge badge b-ok">Adopté</span></div></div>`;
    } else votesHtml='<div class="sub" style="margin-top:8px">Point informatif — pas de vote</div>';
    card.innerHTML=`<div style="display:flex;align-items:center;gap:10px"><span style="font-family:var(--display);font-weight:600;color:var(--ink-faint)">${idx+1}</span>
      <b style="flex:1;font-size:14.5px">${p.title}</b>${isDec?`<span class="cat acp">${MAJ[p.majorite]}</span>`:'<span class="cat ent">Information</span>'}</div>
      <div class="sub" style="margin-top:10px">Notes de séance — reprises dans le PV</div>
      <div ${ro?'':'contenteditable'} class="fld pt-snotes" style="width:100%;margin-top:4px;min-height:38px;font-size:13px;color:var(--ink-soft);white-space:pre-wrap">${escH(p.seance_notes||'')}</div>${votesHtml}`;
    if(!ro){ const sn=card.querySelector('.pt-snotes'); if(sn) sn.onblur=e=>persistPoint(p,{seance_notes:e.target.innerText}); }
    wrap.appendChild(card);
  });
  if(!ro){
    wrap.querySelectorAll('.vote').forEach(seg=>{
      seg.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
        seg.querySelectorAll('button').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
        const idx=+seg.dataset.pt, short=seg.dataset.short, p=currentAG.points[idx];
        p.votes=p.votes||{}; p.votes[short]=btn.dataset.v;
        dbWrite(db=>db.agPointUpdate(p.id,{votes:p.votes}));
        tally(idx);
      });
    });
  }
  currentAG.points.forEach((p,i)=>{ if(p.kind==='decision') tally(i); });
}
function tally(idx){
  const p=currentAG.points[idx]; if(!p||p.kind!=='decision') return;
  const t=agTally(currentAG,p);
  const v=document.querySelector(`.verdict[data-pt="${idx}"]`); if(!v) return;
  v.querySelector('.vtxt').innerHTML=`Pour <b>${t.pour}</b> · contre <b>${t.contre}</b> · abst. ${t.abst} — ${escH(t.rule)}`;
  const ok=t.adopted; const badge=v.querySelector('.vbadge');
  badge.textContent=ok?'Adopté':'Rejeté'; badge.className='vbadge badge '+(ok?'b-ok':'b-late');
  v.style.background=ok?'var(--green-soft)':'var(--coral-soft)';
}

document.getElementById('genPV')?.addEventListener('click',()=>{
  if(!currentAG){ alert('Aucune assemblée.'); return; }
  const cn=(state.coproName||'').trim()||'la copropriété';
  const pres=currentAG.presence||{};
  const presLbl={pre:'Présent',rep:'Représenté',exc:'Excusé',abs:'Absent'};
  const owners=agOwnerList();
  const presRows=owners.map(o=>{ const s=(pres[o.short]&&pres[o.short].status)||'pre';
    return `<tr><td>${o.n}</td><td>${o.q}</td><td>${presLbl[s]}${pres[o.short]&&pres[o.short].mandataire?(' ('+pres[o.short].mandataire+')'):''}</td></tr>`; }).join('');
  const ptRows=currentAG.points.map((p,i)=>{
    let dec='';
    if(p.kind==='decision'){ const t=agTally(currentAG,p);
      dec=`<div><b>Décision :</b> ${t.adopted?'ADOPTÉ':'REJETÉ'} (pour ${t.pour} · contre ${t.contre} · abst. ${t.abst} — ${t.rule})</div>`; }
    return `<div style="margin:14px 0"><b>${i+1}. ${p.title}</b>${p.body?`<div style="color:#555">${p.body}</div>`:''}${p.seance_notes?`<div style="font-style:italic">Notes : ${p.seance_notes}</div>`:''}${dec}</div>`;
  }).join('');
  const html=`<html><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif;max-width:720px;margin:auto">
    <h1>Procès-verbal — ${currentAG.type||''} ${cn}</h1>
    <p><b>Date :</b> ${currentAG.ag_date||''}<br><b>Lieu :</b> ${currentAG.lieu||''}</p>
    <h2>Présences</h2><table border="1" cellpadding="6" cellspacing="0"><tr><th>Copropriétaire</th><th>Quotité</th><th>Statut</th></tr>${presRows}</table>
    <h2>Ordre du jour & décisions</h2>${ptRows}
    <br><br><table width="100%"><tr>${pvSigners(currentAG).map(s=>`<td>${s.name}<br><small>${s.roles.join(', ')}</small></td>`).join('')}</tr></table>
  </body></html>`;
  const blob=new Blob([html],{type:'application/msword'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='PV-AG.doc';
  document.body.appendChild(a); a.click(); a.remove();
});

function goStep(n){
  curStep=Math.max(1,Math.min(5,n));
  document.querySelectorAll('#stepper .step').forEach(s=>{
    const sn=+s.dataset.step;
    s.classList.toggle('on',sn===curStep);
    s.classList.toggle('done',sn<curStep);
    const circ=s.querySelector('.circ'); if(circ) circ.textContent=sn<curStep?'✓':sn;
  });
  document.querySelectorAll('.agpanel').forEach(p=>{p.style.display=(+p.dataset.panel===curStep)?'block':'none';});
  if(currentAG && curStep===2) renderConvInfo();
  if(currentAG && curStep===5) renderSignBox(currentAG,document.getElementById('agSignBox'));
  window.scrollTo({top:0,behavior:'smooth'});
}
document.querySelectorAll('#ag .nextStep').forEach(b=>b.onclick=()=>goStep(curStep+1));
document.querySelectorAll('#ag .prevStep').forEach(b=>b.onclick=()=>goStep(curStep-1));
document.querySelectorAll('#stepper .step').forEach(s=>s.onclick=()=>goStep(+s.dataset.step));

document.getElementById('completeAG')?.addEventListener('click',function(){
  if(!currentAG){ return; }
  if(!canWrite()){ alert('Lecture seule.'); return; }
  // fige les décisions à partir des votes
  currentAG.points.forEach(p=>{ if(p.kind==='decision'){
    p.decision = agTally(currentAG,p).adopted?'Adopté':'Rejeté';
    dbWrite(db=>db.agPointUpdate(p.id,{decision:p.decision, votes:p.votes||{}}));
  }});
  currentAG.status='finalisee';
  dbWrite(db=>db.agUpdate(currentAG.id,{status:'finalisee'}));
  syncBudgetApproval(currentAG);
  if((currentAG.signature||{}).status!=='signe') _sgOpen.add(String(currentAG.id));
  alert('✓ AG finalisée et archivée. La signature du PV se poursuit dans l’historique, en bas de page.');
  curStep=1; renderAG();
});

const _sgOpen=new Set();   // AG archivées dont la carte « Signature » est dépliée
function renderAGArchive(){
  const box=document.getElementById('agArchive'); if(!box) return;
  const done=(state.ags||[]).filter(a=>a.status==='finalisee');
  if(!done.length){ box.innerHTML='<div class="sub" style="padding:14px">Aucune assemblée archivée pour le moment.</div>'; return; }
  ensureSignCss();
  box.innerHTML=done.map(a=>{
    const n=agOwnerList().filter(o=>agAttends(a,o)).length;
    const adopted=a.points.filter(p=>p.decision==='Adopté').length, dec=a.points.filter(p=>p.kind==='decision').length;
    const open=_sgOpen.has(String(a.id));
    return `<div class="ag-arch" data-id="${escH(a.id)}">
      <div class="hist"><span class="v" style="width:auto">${escH(a.ag_date||a.type||'AG')}</span><div><b>${escH(a.title||'Assemblée générale')}</b><div class="meta">${a.points.length} point(s) · ${n} présent(s)/représenté(s) · ${adopted}/${dec} décision(s) adoptée(s)</div></div>
        <div class="sg-side">${signBadge(a)}<button class="rb sg-toggle">${open?'Fermer':'Signature du PV'}</button></div></div>
      <div class="sg-box sg-arch" style="display:${open?'block':'none'}"></div></div>`;
  }).join('');
  box.querySelectorAll('.ag-arch').forEach(row=>{
    const a=agById(row.dataset.id); if(!a) return;
    if(_sgOpen.has(String(a.id))) renderSignBox(a,row.querySelector('.sg-box'));
    row.querySelector('.sg-toggle').onclick=()=>{ const id=String(a.id); if(_sgOpen.has(id)) _sgOpen.delete(id); else _sgOpen.add(id); renderAGArchive(); };
  });
}

/* ============================================================
   SIGNATURE DU PV — Dokobit, offre gratuite (pas d'API)
   1. le PV part en PDF figé (empreinte SHA-256 gardée dans ls_ag.signature) ;
   2. le syndic le dépose sur Dokobit, chacun signe (itsme / carte eID) ;
   3. le PDF signé revient ici : LSSign (signature.js) lit les signatures,
      vérifie l'intégrité et coche les signataires attendus (art. 3.87 §10).
   Fichiers : bucket privé ls-docs (supabase/ag.sql), ag/<id>/pv-a-signer.pdf et pv-signe.pdf.
   ============================================================ */
const DOKOBIT={url:'https://app.dokobit.com/', free:3};   // offre gratuite : 3 signatures / mois, chaque signataire compte
const PDFLIB_CDN={src:'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
                  sri:'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI'};
let _pdfLibP=null;
const _pvLocal={};          // démo / hors-ligne : les PDF restent en mémoire, jamais dans Supabase
function loadPdfLib(){
  if(window.PDFLib) return Promise.resolve(window.PDFLib);
  return _pdfLibP = _pdfLibP || new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=PDFLIB_CDN.src; s.integrity=PDFLIB_CDN.sri; s.crossOrigin='anonymous';
    s.onload=()=>res(window.PDFLib);
    s.onerror=()=>{ _pdfLibP=null; rej(new Error('pdf-lib n’a pas pu être chargé (hors-ligne ?)')); };
    document.head.appendChild(s);
  });
}
function escH(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function saveBytes(bytes,name){
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})); a.download=name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000);
}
// Les erreurs « colonne / bucket inconnus » = le SQL n'a pas été lancé : on le dit.
function sqlHint(msg){ return /ls-docs|bucket|signature|bureau|email|schema cache|column/i.test(msg) ? msg+' — lancez supabase/ag.sql dans Supabase (SQL Editor).' : msg; }
const agById=id=>(state.ags||[]).find(a=>String(a.id)===String(id));
const pvPath=(ag,kind)=>`ag/${ag.id}/${kind}.pdf`;
function pvFileName(ag,suffix){
  const d=String(ag.ag_date||'').normalize('NFD').replace(/\p{M}/gu,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
  return `PV-AG${d?'-'+d:''}${suffix?'-'+suffix:''}.pdf`;
}

// --- présences & votes (partagés séance / PV / décisions) ---
function agPresenceStatus(ag,o){ const p=(ag.presence||{})[o.short]; return (p&&p.status)||'pre'; }
function agAttends(ag,o){ const s=agPresenceStatus(ag,o); return s==='pre'||s==='rep'; }
function agMandataire(ag,o){ const p=(ag.presence||{})[o.short]; return String((p&&p.mandataire)||'').trim(); }
// Vote d'un copropriétaire ; null s'il n'est ni présent ni représenté (il ne vote pas).
function agVote(ag,p,o){ return agAttends(ag,o) ? ((p.votes&&p.votes[o.short])||'pour') : null; }
// Décompte d'un point (art. 3.88 C. civ.) : majorité des voix exprimées par les présents et
// représentés — abstentions, votes blancs et nuls ne comptent pas. L'unanimité, elle, se compte
// sur TOUS les copropriétaires, absents compris.
function agTally(ag,p){
  const att=agOwnerList().filter(o=>agAttends(ag,o)), tot=agTotalQuot();
  const q=v=>sum(att.filter(o=>agVote(ag,p,o)===v).map(o=>o.q));
  const pour=q('pour'), contre=q('contre'), abst=q('abst'), cast=pour+contre;
  const FR={deuxtiers:[2,3,'deux tiers'], quatrecinq:[4,5,'quatre cinquièmes']}[p.majorite];
  let adopted, rule;
  if(p.majorite==='unanime'){ adopted=pour===tot; rule=`unanimité de tous les copropriétaires (${tot} quotités)`; }
  else if(FR){ adopted=cast>0 && pour*FR[1]>=cast*FR[0]; rule=`${FR[2]} des ${cast} quotités exprimées`; }
  else { adopted=pour*2>cast; rule=`plus de la moitié des ${cast} quotités exprimées`; }
  return {pour, contre, abst, cast, tot, adopted, rule};
}
// Le secrétaire désigné, ou à défaut le syndic connecté.
function agSecretaire(ag){ return String(((ag.bureau||{}).secretaire)||((window.LS&&window.LS.member&&window.LS.member.full_name)||'')).trim(); }

// --- bureau de séance (étape 3) ---
function renderBureau(){
  const el=document.getElementById('agBureau'); if(!el||!currentAG) return;
  const b=currentAG.bureau||{}, ro=!canWrite();
  const att=agOwnerList().filter(o=>agAttends(currentAG,o));
  const syndic=((window.LS&&window.LS.member&&window.LS.member.full_name)||'').trim();
  el.innerHTML=`<h2>Bureau de séance</h2>
    <div class="sub" style="margin:2px 0 12px">Ils signent le PV avec les copropriétaires présents ou leurs mandataires (art. 3.87 §10).</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Président de séance (un copropriétaire)</div>
        <select class="fld" id="agPres" ${ro?'disabled':''} style="width:100%;margin-top:4px"><option value="">— choisir —</option>${
          att.map(o=>`<option value="${escH(o.short)}" ${o.short===b.president?'selected':''}>${escH(o.n)}</option>`).join('')}</select></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Secrétaire${syndic?' — par défaut, le syndic':''}</div>
        <input class="fld" id="agSec" ${ro?'disabled':''} style="width:100%;margin-top:4px" value="${escH(b.secretaire||'')}" placeholder="${escH(syndic||'Nom du secrétaire')}"></div>
    </div>`;
  if(!ro){
    el.querySelector('#agPres').onchange=e=>agSave(currentAG,{bureau:{...(currentAG.bureau||{}),president:e.target.value}});
    el.querySelector('#agSec').onchange=e=>agSave(currentAG,{bureau:{...(currentAG.bureau||{}),secretaire:e.target.value.trim()}});
  }
}
async function agSave(ag,patch){
  Object.assign(ag,patch);
  if(!writeToDb()){ saveState(); toastSaved(); return true; }
  try{ await window.LS.db.agUpdate(ag.id,patch); toastSaved(); return true; }
  catch(e){ console.error(e); showToast(sqlHint('Échec de l’enregistrement : '+(e.message||e)),'err'); return false; }
}

// --- qui signe le PV : président, secrétaire, présents, mandataires (dédoublonnés) ---
function pvSigners(ag){
  const out=[], owners=agOwnerList(), byShort={};
  ownersOf().forEach(o=>{ byShort[o.short||o.n]=o; });
  const add=(name,role,email)=>{
    name=String(name||'').trim(); if(!name) return;
    const ex=out.find(x=>LSSign.sameName(x.name,name));
    if(ex){ if(!ex.roles.includes(role)) ex.roles.push(role); if(!ex.email&&email) ex.email=email; }
    else out.push({name, roles:[role], email:email||''});
  };
  const pres=owners.find(o=>o.short===(ag.bureau||{}).president);
  add(pres&&pres.n,'Président de séance',pres&&(byShort[pres.short]||{}).email);
  add(agSecretaire(ag),'Secrétaire');
  owners.forEach(o=>{
    const s=agPresenceStatus(ag,o);
    if(s==='pre') add(o.n,'Copropriétaire présent',(byShort[o.short]||{}).email);
    else if(s==='rep') add(agMandataire(ag,o),`Mandataire de ${o.n}`);
  });
  return out;
}
function pvMissing(ag){
  const miss=[], owners=agOwnerList();
  if(!String(ag.ag_date||'').trim()) miss.push('la date de l’AG (étape 1)');
  if(!owners.some(o=>agAttends(ag,o))) miss.push('au moins un copropriétaire présent (étape 3)');
  if(!owners.some(o=>o.short===(ag.bureau||{}).president && agAttends(ag,o))) miss.push('le président de séance (étape 3)');
  if(!agSecretaire(ag)) miss.push('le secrétaire (étape 3)');
  owners.forEach(o=>{ if(agPresenceStatus(ag,o)==='rep' && !agMandataire(ag,o)) miss.push(`le mandataire de ${o.n} (étape 3)`); });
  return miss;
}
function pvData(ag){
  const owners=agOwnerList(), tot=agTotalQuot();
  const att=owners.filter(o=>agAttends(ag,o));
  const pres=owners.find(o=>o.short===(ag.bureau||{}).president);
  const LBL={pre:'Présent',rep:'Représenté',exc:'Excusé',abs:'Absent'};
  const voter=o=>agPresenceStatus(ag,o)==='rep'&&agMandataire(ag,o) ? `${o.n} (par ${agMandataire(ag,o)})` : o.n;
  return {
    copro:(state.coproName||'').trim()||'la copropriété', type:ag.type||'Ordinaire',
    dateLabel:ag.ag_date||'', lieu:ag.lieu||'', convocation:ag.convocation_date||'',
    president:pres?pres.n:'', secretaire:agSecretaire(ag),
    presences:owners.map(o=>{ const s=agPresenceStatus(ag,o), m=agMandataire(ag,o);
      return {name:o.n, quot:o.q, status: s==='rep' ? (m?`Représenté par ${m}`:'Représenté') : (LBL[s]||s)}; }),
    attendance:{n:att.length, of:owners.length, q:sum(att.map(o=>o.q)), tot},
    points:ag.points.map((p,i)=>{
      const base={n:i+1, title:p.title||'', body:p.body||'', notes:p.seance_notes||''};
      if(p.kind!=='decision') return {...base, info:true};
      const grp=v=>{ const os=att.filter(o=>agVote(ag,p,o)===v); return {names:os.map(voter), q:sum(os.map(o=>o.q))}; };
      const t=agTally(ag,p);
      return {...base, maj:MAJ[p.majorite]||p.majorite, rule:t.rule, pour:grp('pour'), contre:grp('contre'), abst:grp('abst'), adopted:t.adopted};
    }),
    signers:pvSigners(ag), generatedAt:new Date().toISOString(),
  };
}

// --- 1. figer le PV ---
async function pvPrepare(ag){
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const miss=pvMissing(ag);
  if(miss.length){ alert('Avant de figer le PV, complétez :\n• '+miss.join('\n• ')); return; }
  const sg=ag.signature||{};
  if(sg.signed && !confirm('Ce PV est déjà signé. Le régénérer remet le suivi de signature à zéro. Continuer ?')) return;
  if(!sg.signed && sg.pv && !confirm('Un PV à signer existe déjà. Si des signatures ont commencé sur Dokobit avec l’ancien fichier, il faudra recommencer avec le nouveau. Continuer ?')) return;
  let bytes;
  try{ bytes=await LSSign.buildPvPdf(await loadPdfLib(), pvData(ag)); }
  catch(e){ console.error(e); showToast('PV impossible à générer : '+(e.message||e),'err'); return; }
  const pv={path:pvPath(ag,'pv-a-signer'), sha256:await LSSign.sha256Hex(bytes), size:bytes.length,
            at:new Date().toISOString(), signers:pvSigners(ag)};
  if(writeToDb()){
    try{ await window.LS.db.docUpload(pv.path,bytes); }
    catch(e){ console.error(e); showToast(sqlHint('Envoi du PV impossible : '+(e.message||e)),'err'); return; }
  } else { pv.path=null; _pvLocal[ag.id+':pv']=bytes; delete _pvLocal[ag.id+':signed']; }
  await agSave(ag,{signature:{status:'a_signer', pv, signed:null}});
  saveBytes(bytes,pvFileName(ag));
  rerenderSign(ag);
}
async function pvDownload(ag,which){
  const sg=ag.signature||{}, rec=which==='signed'?sg.signed:sg.pv; if(!rec) return;
  try{
    let bytes=_pvLocal[ag.id+':'+which];
    if(!bytes && rec.path && writeToDb()) bytes=await window.LS.db.docDownload(rec.path);
    if(!bytes){ showToast('Fichier non conservé en mode démo / hors-ligne','err'); return; }
    saveBytes(bytes, which==='signed' ? pvFileName(ag,'signe') : pvFileName(ag));
  }catch(e){ console.error(e); showToast(sqlHint('Téléchargement impossible : '+(e.message||e)),'err'); }
}
// --- 3. le PDF signé revient de Dokobit ---
async function pvImportSigned(ag,file){
  if(!canWrite()){ alert('Lecture seule.'); return; }
  if(/\.(asice|asics|sce|bdoc|edoc|adoc|zip)$/i.test(file.name)){
    alert('Dokobit a rendu un conteneur ('+file.name.split('.').pop()+'), pas un PDF. Sur Dokobit, faites signer le document au format PDF, puis réimportez-le.'); return; }
  const bytes=new Uint8Array(await file.arrayBuffer());
  let res;
  try{ res=await LSSign.readSignatures(bytes); }
  catch(e){ alert('Lecture impossible : '+(e.message||e)); return; }
  if(!res.signatures.length){ alert('Aucune signature électronique dans ce PDF. Sur Dokobit, téléchargez le document signé (pas l’original).'); return; }
  const sg=ag.signature||{};
  const expected=(sg.pv&&sg.pv.signers)||pvSigners(ag);
  // une signature PAdES s'ajoute à la fin du fichier : le PV figé doit en être le début, octet pour octet
  let prefixOk=null;
  if(sg.pv) prefixOk = bytes.length>sg.pv.size && (await LSSign.sha256Hex(bytes.subarray(0,sg.pv.size)))===sg.pv.sha256;
  const m=LSSign.matchSigners(expected,res.signatures);
  const sigs=res.signatures.map(s=>({name:s.name, method:s.method, issuer:s.issuer, at:s.at, atSource:s.atSource, error:s.error||null,
    ok: s.digestOk===false||s.sigOk===false ? false : (s.digestOk&&s.sigOk ? true : null)}));
  const intact=sigs.every(s=>s.ok!==false) && res.tail!=='autre' && prefixOk!==false;
  const complete=m.rows.every(r=>r.sig>=0);
  const signed={path:pvPath(ag,'pv-signe'), sha256:await LSSign.sha256Hex(bytes), size:bytes.length, at:new Date().toISOString(),
    file:file.name, prefixOk, tail:res.tail, timestamps:res.timestamps.length, sigs,
    rows:m.rows.map(r=>({name:r.name, roles:r.roles, sig:r.sig})), extras:m.extras};
  if(writeToDb()){
    try{ await window.LS.db.docUpload(signed.path,bytes); }
    catch(e){ console.error(e); showToast(sqlHint('Envoi du PV signé impossible : '+(e.message||e)),'err'); return; }
  } else { signed.path=null; _pvLocal[ag.id+':signed']=bytes; }
  const was=sg.status, status=!intact ? 'a_verifier' : (complete ? 'signe' : 'partiel');
  await agSave(ag,{signature:{...sg, status, signed}});
  if(status==='signe' && was!=='signe')
    logTimeline({title:`PV de l’AG${ag.ag_date?' du '+ag.ag_date:''} signé`,
      description:`${m.rows.length} signature(s) électronique(s) via Dokobit : ${m.rows.map(r=>r.name).join(', ')}.`, kind:'sign'});
  showToast({signe:'PV signé par tous les signataires', partiel:'PV importé — il manque des signatures', a_verifier:'Attention : signature invalide ou document modifié'}[status], status==='signe'?undefined:'err');
  rerenderSign(ag);
}

// --- rendu ---
function signBadge(ag){
  const st=(ag.signature||{}).status;
  if(st==='signe')    return '<span class="badge b-ok">✍ PV signé</span>';
  if(st==='a_verifier') return '<span class="badge b-late">✍ PV à vérifier</span>';
  if(st==='partiel')  return '<span class="badge sg-b-part">✍ Signatures incomplètes</span>';
  if(st==='a_signer') return '<span class="badge sg-b-wait">✍ En signature</span>';
  return '<span class="badge sg-b-none">PV non signé</span>';
}
function sgFmt(iso){ return iso ? new Date(iso).toLocaleString('fr-BE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; }
function signedReport(sd){
  const METH={itsme:'itsme', eID:'carte eID'};
  const rows=(sd.rows||[]).map(r=>{
    const s=r.sig>=0 ? sd.sigs[r.sig] : null;
    const who=`<b>${escH(r.name)}</b> <span class="sub">${escH((r.roles||[]).join(' · '))}</span>`;
    if(!s) return `<div class="sg-row wait"><span class="ic">…</span><div>${who}<div class="sub">pas encore signé</div></div></div>`;
    const okTxt = s.ok===true ? 'signature valide, document intact' : s.ok===false ? 'signature invalide ou document modifié' : 'document intact (signature non vérifiable ici)';
    const meta=[METH[s.method]||escH(s.issuer), s.at?'le '+sgFmt(s.at)+(s.atSource==='tsa'?' (horodatage certifié)':''):'', okTxt].filter(Boolean).join(' · ');
    return `<div class="sg-row ${s.ok===false?'bad':'ok'}"><span class="ic">${s.ok===false?'!':'✓'}</span><div>${who}<div class="sub">${meta}</div></div></div>`;
  }).join('');
  const extras=(sd.extras||[]).map(k=>sd.sigs[k]).map(s=>`<div class="sg-row extra"><span class="ic">?</span><div><b>${escH(s.name||'Signataire inconnu')}</b> <span class="sub">signataire non attendu</span><div class="sub">${escH(s.issuer)}${s.at?' · le '+sgFmt(s.at):''}</div></div></div>`).join('');
  const warns=[];
  if(sd.prefixOk===false) warns.push('Ce PDF ne prolonge pas le PV figé à l’étape 1 : vérifiez que c’est bien le bon document.');
  if(sd.tail==='autre') warns.push('Le fichier a été modifié après la dernière signature.');
  return rows+extras+(warns.length?`<div class="sg-warn">${warns.map(escH).join('<br>')}</div>`:'')
    +`<div class="sub" style="margin-top:6px">Importé le ${sgFmt(sd.at)} · ${escH(sd.file||'')}</div>`;
}
function renderSignBox(ag,el){
  if(!el) return;
  ensureSignCss();
  const sg=ag.signature||{}, rw=canWrite(), pv=sg.pv, sd=sg.signed;
  const expected=(pv&&pv.signers)||pvSigners(ag), n=expected.length;
  const emails=expected.map(e=>e.email).filter(Boolean);
  el.innerHTML=`<div class="sg-head"><div><b>Signature du PV</b> <span class="sub">— Dokobit, gratuit · itsme ou carte d’identité</span></div>${signBadge(ag)}</div>
  <div class="sg-step ${pv?'done':''}"><span class="sg-n">1</span><div class="sg-body">
    <div class="sg-t">Figer le PV en PDF</div>
    ${pv ? `<div class="sub">Figé le ${sgFmt(pv.at)} · empreinte <code title="SHA-256 ${escH(pv.sha256)}">${escH(pv.sha256.slice(0,12))}…</code></div>`
         : `<div class="sub">Présences, votes nominatifs, décisions, notes de séance et liste des signataires. C’est ce fichier-là qu’on signe : il ne bouge plus.</div>`}
    <div class="sg-acts">${pv?'<button class="btn btn-ghost sg-btn" data-sg="dl-pv">⬇ PV à signer</button>':''}${rw?`<button class="btn ${pv?'btn-ghost':'btn-primary'} sg-btn" data-sg="prepare">${pv?'↻ Régénérer':'📄 Générer le PV à signer'}</button>`:''}</div>
  </div></div>
  <div class="sg-step ${sd?'done':''}"><span class="sg-n">2</span><div class="sg-body">
    <div class="sg-t">Faire signer sur Dokobit</div>
    <ol class="sg-ol"><li>Déposez le PDF sur Dokobit, au <b>format PDF</b> (pas ASiC-E).</li>
      <li>Invitez les signataires ci-dessous ; chacun signe avec <b>itsme</b> ou sa <b>carte d’identité</b> (compte Dokobit gratuit).</li>
      <li>Quand tout le monde a signé, téléchargez le PDF signé.</li></ol>
    <div class="sg-signers">${expected.map(e=>`<div><b>${escH(e.name)}</b> <span class="sub">${escH(e.roles.join(' · '))}${e.email?' · '+escH(e.email):''}</span></div>`).join('')
      || '<div class="sub">Complétez le bureau de séance et les présences (étape 3).</div>'}</div>
    ${n>DOKOBIT.free ? `<div class="sg-warn">${n} signatures : l’offre gratuite en couvre ${DOKOBIT.free} par mois (chaque signataire compte). Étalez sur deux mois ou passez par une offre payante.</div>`
                     : `<div class="sub">${n} signature${n>1?'s':''} sur les ${DOKOBIT.free} gratuites du mois.</div>`}
    <div class="sg-acts"><a class="btn btn-ghost sg-btn" href="${DOKOBIT.url}" target="_blank" rel="noopener noreferrer">Ouvrir Dokobit ↗</a>${emails.length?'<button class="btn btn-ghost sg-btn" data-sg="copy">Copier les e-mails</button>':''}</div>
  </div></div>
  <div class="sg-step ${sg.status==='signe'?'done':''}"><span class="sg-n">3</span><div class="sg-body">
    <div class="sg-t">Ramener le PV signé</div>
    ${sd ? signedReport(sd) : '<div class="sub">LazySyndic lit les signatures du PDF : qui a signé, quand, et si le document est resté intact.</div>'}
    <div class="sg-acts">${sd?'<button class="btn btn-ghost sg-btn" data-sg="dl-signed">⬇ PV signé</button>':''}${rw?`<button class="btn ${sd?'btn-ghost':'btn-primary'} sg-btn" data-sg="import">⇪ ${sd?'Réimporter':'Importer le PDF signé'}</button><input type="file" accept="application/pdf,.pdf" class="sg-file" hidden>`:''}</div>
  </div></div>`;
  el.onclick=ev=>{
    const b=ev.target.closest('[data-sg]'); if(!b) return;
    const act=b.dataset.sg;
    if(act==='prepare') pvPrepare(ag);
    else if(act==='dl-pv') pvDownload(ag,'pv');
    else if(act==='dl-signed') pvDownload(ag,'signed');
    else if(act==='import') el.querySelector('.sg-file').click();
    else if(act==='copy') navigator.clipboard.writeText(emails.join(', ')).then(()=>showToast('E-mails copiés'),()=>prompt('E-mails des signataires :',emails.join(', ')));
  };
  const f=el.querySelector('.sg-file');
  if(f) f.onchange=()=>{ const file=f.files[0]; f.value=''; if(file) pvImportSigned(ag,file); };
}
function rerenderSign(ag){
  if(currentAG && String(currentAG.id)===String(ag.id)) renderSignBox(currentAG,document.getElementById('agSignBox'));
  renderAGArchive();
}
function ensureSignCss(){
  if(document.getElementById('signCss')) return;
  const s=document.createElement('style'); s.id='signCss';
  s.textContent=`
   .sg-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
   .sg-step{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--line-2)}
   .sg-n{flex:0 0 26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12.5px;background:var(--line-2);color:var(--ink-soft)}
   .sg-step.done .sg-n{background:var(--green);color:#fff}
   .sg-body{flex:1;min-width:0}
   .sg-t{font-weight:600;font-size:14px;margin-bottom:3px}
   .sg-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}
   .sg-btn{padding:7px 14px;font-size:13px;text-decoration:none;display:inline-block}
   .sg-ol{margin:4px 0 8px 18px;padding:0;font-size:13px;color:var(--ink-soft)}
   .sg-signers{display:grid;gap:4px;font-size:13.5px;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin:6px 0;overflow-wrap:anywhere}
   .sg-warn{background:var(--clay-soft);color:var(--warning-ink);border-radius:10px;padding:8px 12px;font-size:12.5px;margin-top:8px}
   .sg-row{display:flex;gap:10px;align-items:flex-start;padding:6px 0;font-size:13.5px}
   .sg-row .ic{flex:0 0 20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff;background:var(--ink-faint)}
   .sg-row.ok .ic{background:var(--green)} .sg-row.bad .ic{background:var(--coral)} .sg-row.extra .ic{background:var(--clay)}
   .sg-b-wait,.sg-b-part{background:var(--clay-soft);color:var(--warning-ink)} .sg-b-none{background:var(--line-2);color:var(--ink-faint)}
   .sg-side{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
   .ag-arch .hist .sg-side .rb{margin-left:0}
   .sg-arch{padding:4px 4px 14px;border-bottom:1px solid var(--line-2)}
   @media(max-width:560px){ .ag-arch .hist{flex-wrap:wrap} .sg-side{margin-left:0;justify-content:flex-start} }`;
  document.head.appendChild(s);
}


/* ============================================================
   CONTRATS (persistés)
   ============================================================ */
const TYPECLASS={'Énergie':'','Assurance':'ass','Entretien':'ent','Autre':'acp'};
const escAttr = s => String(s||'').replace(/"/g,'&quot;');
function ctRow(c,idx){
  const tc=TYPECLASS[c.type]||'';
  const supCell = canWrite()
    ? `<input class="fld" style="width:150px;font-size:12.5px;padding:5px 8px" value="${escAttr(c.fournisseur)}" placeholder="Fournisseur…" onchange="setContractSupplier(${idx}, this.value)">`
    : (c.fournisseur || '—');
  if(c.status==='actif'){
    return `<tr><td><b>${c.name}</b><div class="sub" style="margin-top:2px">réf. ${c.ref}</div></td>
      <td>${supCell}</td>
      <td><span class="cat ${tc}">${c.type}</span></td><td>${c.start}</td>
      <td style="color:var(--ink-soft);font-style:italic">${c.note||''}</td>
      <td><span class="badge b-ok">Actif</span></td>
      <td style="text-align:right"><button class="rb" style="background:var(--coral-soft);color:var(--coral)" onclick="openClose(${idx})">Clôturer</button></td></tr>`;
  }
  return `<tr style="opacity:.85"><td><b>${c.name}</b><div class="sub" style="margin-top:2px">réf. ${c.ref}</div></td>
    <td>${c.fournisseur||'—'}</td>
    <td><span class="cat ${tc}">${c.type}</span></td><td>${c.start} → ${c.end}</td>
    <td style="color:var(--ink-soft);font-style:italic">${c.endNote||c.note||''}</td>
    <td><span class="badge" style="background:var(--line-2);color:var(--ink-faint)">Clôturé</span></td><td></td></tr>`;
}
window.setContractSupplier=(idx,val)=>{
  if(!canWrite()){ renderContracts(); return; }
  const c=state.contracts[idx]; if(!c) return;
  c.fournisseur=val.trim();
  saveState(); dbWrite(db=>db.updateContract(c.id,{fournisseur:c.fournisseur}));
};
function renderContracts(){
  const head=`<tr><th>Contrat</th><th>Fournisseur</th><th>Type</th><th>Période</th><th>Commentaire</th><th>Statut</th><th></th></tr>`;
  const C=state.contracts;
  const act=C.filter(c=>c.status==='actif'),clo=C.filter(c=>c.status==='cloture');
  const ab=document.getElementById('ctActiveBody'); if(!ab) return;
  ab.innerHTML=head+act.map(c=>ctRow(c,C.indexOf(c))).join('');
  document.getElementById('ctClosedBody').innerHTML=head+(clo.length?clo.map(c=>ctRow(c,C.indexOf(c))).join(''):'<tr><td colspan="7" class="sub" style="padding:14px">Aucun contrat clôturé.</td></tr>');
  document.getElementById('ctActiveN').textContent=act.length;
  document.getElementById('ctClosedN').textContent=clo.length;
}
document.getElementById('ctAdd')?.addEventListener('click',()=>{
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const name=document.getElementById('ctName').value.trim();
  if(!name){document.getElementById('ctName').focus();return;}
  const c={name,ref:document.getElementById('ctRef').value||'—',type:document.getElementById('ctType').value,
    start:document.getElementById('ctStart').value||'—',note:document.getElementById('ctNote').value,
    fournisseur:document.getElementById('ctSupplier').value.trim(),status:'actif'};
  state.contracts.unshift(c);
  ['ctName','ctRef','ctStart','ctNote','ctSupplier'].forEach(id=>document.getElementById(id).value='');
  saveState(); renderContracts();
  dbWrite(async db=>{ const saved=await db.addContract(c); c.id=saved.id; });
});
let closeIdx=null;
window.openClose=(idx)=>{
  closeIdx=idx;
  document.getElementById('ctModalSub').textContent=state.contracts[idx].name+' · réf. '+state.contracts[idx].ref;
  document.getElementById('ctEndDate').value='';document.getElementById('ctEndNote').value='';
  document.getElementById('ctModal').style.display='flex';
};
document.getElementById('ctModalCancel')?.addEventListener('click',()=>document.getElementById('ctModal').style.display='none');
document.getElementById('ctModalConfirm')?.addEventListener('click',()=>{
  if(closeIdx===null)return;
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const c=state.contracts[closeIdx];
  c.status='cloture';
  c.end=document.getElementById('ctEndDate').value||'—';
  c.endNote=document.getElementById('ctEndNote').value;
  document.getElementById('ctModal').style.display='none';
  saveState(); renderContracts();
  dbWrite(db=>db.updateContract(c.id, {status:'cloture', end:c.end, endNote:c.endNote}));
});
document.getElementById('genCtReport')?.addEventListener('click',()=>{
  const act=state.contracts.filter(c=>c.status==='actif').length,clo=state.contracts.filter(c=>c.status==='cloture').length;
  alert('⬇ Rapport des contrats généré\n\n'+act+' contrat(s) actif(s) · '+clo+' clôturé(s)\n\nChaque contrat avec nom, référence, type, période et commentaire — exportable en PDF.');
});

/* ============================================================
   BUDGET & COPRO  (démo — recalcul des clés en direct)
   ============================================================ */
document.getElementById('budseg')?.addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#budseg button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  document.querySelectorAll('.budpanel').forEach(p=>p.style.display=p.dataset.bud===b.dataset.bud?'block':'none');
});
const ownersById = ()=>{ const m={}; ownersOf().forEach(o=>{ if(o.id) m[o.id]=o; }); return m; };
const lotsOf = ()=> state.lots || [];

// --- Onglet « Copropriétaires & lots » (référentiel réel) ---
// Fiche de la copropriété : nom, adresse, numéro d'entreprise (BCE / TVA) — en tête des rapports
// et de l'Annexe 4. Colonnes copro_name / copro_addr / copro_kbo de ls_settings (supabase/budget.sql).
async function saveCoproField(field, v){
  const key={copro_name:'coproName', copro_addr:'coproAddr', copro_kbo:'coproKbo'}[field]; if(!key) return;
  state[key]=v; saveState();
  if(!writeToDb()){ toastSaved(); renderAll(); return; }
  try{ await window.LS.db.updateSettings({[field]: v||null}); toastSaved(); renderAll(); }
  catch(e){ console.error(e); showToast('Échec de l’enregistrement : '+(e.message||e)+(/schema cache|column/i.test(e.message||'')?' — lancez supabase/budget.sql dans Supabase (SQL Editor).':''),'err'); }
}
function renderBudgetOwn(){
  const cc=document.getElementById('budCopro');
  if (cc){
    ensureChargesCss();
    const ed=canWrite();
    const f=(id,label,val,ph,hint)=>`<label class="copro-f"><span>${label}</span>${ed?`<input class="fld copro-field" data-field="${id}" value="${escH(val||'')}" placeholder="${ph}">`:`<b>${escH(val||'—')}</b>`}${hint?`<span>${hint}</span>`:''}</label>`;
    cc.innerHTML=`<div class="mini-h" style="margin:0 0 10px">Copropriété</div><div class="copro-grid">${f('copro_name','Nom',state.coproName,'ACP …','Sur les rapports, les relevés et les convocations')}${f('copro_addr','Adresse',state.coproAddr,'Rue, n°, code postal, commune','')}${f('copro_kbo','N° d’entreprise (BCE / TVA)',state.coproKbo,'BE 0123.456.789','En tête des rapports et de l’Annexe 4')}</div>`;
    cc.querySelectorAll('.copro-field').forEach(inp=>inp.onchange=()=>saveCoproField(inp.dataset.field, inp.value.trim()));
  }
  const lt=document.getElementById('budLotsTable');
  const by=ownersById();
  const lots=lotsOf().slice().sort((a,b)=>String(a.label).localeCompare(String(b.label),'fr',{numeric:true}));
  if (lt){
    if (!lots.length){
      lt.innerHTML='<tr><td class="sub" style="padding:14px">Aucun lot enregistré.</td></tr>';
    } else {
      const total=sum(lots.map(l=>l.quotite||0));
      lt.innerHTML='<tr><th>Lot</th><th>Désignation</th><th class="num">Quotité</th><th>Identifiant parcellaire</th><th>Propriétaire</th></tr>'
        + lots.map(l=>`<tr><td>${l.label||''}</td><td>${l.designation||''}</td><td class="num">${l.quotite||0}</td><td>${l.parcelle||'—'}</td><td><b>${(by[l.owner_id]||{}).n||'—'}</b></td></tr>`).join('')
        + `<tr><td colspan="2"><b>Total</b></td><td class="num"><b>${total}</b></td><td colspan="2" class="sub">Acte de base — source faisant foi</td></tr>`;
    }
  }
  const ot=document.getElementById('budOwnersRefTable');
  if (ot){
    const ow=ownersOf();
    if (!ow.length){ ot.innerHTML='<tr><td class="sub" style="padding:14px">Aucun propriétaire enregistré.</td></tr>'; return; }
    const ed=canWrite();
    const hasCalls = typeof LSCalls !== 'undefined';
    const missing = hasCalls ? ow.filter(o=>!LSCalls.ogmValid(o.ogm)).length : 0;
    const perSel = o => `<select class="fld own-per" data-key="${escH(o.id||o.short||o.n)}" aria-label="Périodicité des appels de ${escH(o.n)}" style="font-size:12.5px;padding:5px 8px">${['month','quarter','year'].map(k=>`<option value="${k}" ${LSCalls.cleanPeriodicity(o.periodicity)===k?'selected':''}>${({month:'Mensuelle',quarter:'Trimestrielle',year:'Annuelle'})[k]}</option>`).join('')}</select>`;
    ot.innerHTML=`<tr><th>Propriétaire</th><th>Lots détenus</th><th class="num">Quotité cumulée</th><th>E-mail (convocations, signatures)</th>${hasCalls?'<th>Communication structurée</th><th>Appels de fonds</th>':''}</tr>`
      + ow.map(o=>{
          const mine=lotsOf().filter(l=>l.owner_id===o.id).map(l=>l.designation||l.label).join(', ')||'—';
          const mail=ed ? `<input class="fld own-mail" type="email" data-key="${escH(o.id||o.short||o.n)}" value="${escH(o.email||'')}" placeholder="nom@exemple.be" style="width:100%;min-width:180px;font-size:12.5px;padding:5px 8px">`
                              : escH(o.email||'—');
          const ogm = !hasCalls ? '' : LSCalls.ogmValid(o.ogm) ? `<code style="font-size:12.5px;white-space:nowrap">${LSCalls.ogmFormat(o.ogm)}</code>` : `<span class="sub">à attribuer</span>`;
          const per = !hasCalls ? '' : ed ? perSel(o) : ({month:'Mensuels',quarter:'Trimestriels',year:'Annuels'})[LSCalls.cleanPeriodicity(o.periodicity)];
          return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${(o.short||o.n||'?')[0]}</span> ${o.n}</div></td><td>${mine}</td><td class="num">${o.q}</td><td>${mail}</td>${hasCalls?`<td>${ogm}</td><td>${per}</td>`:''}</tr>`;
        }).join('')
      + (hasCalls && ed && missing ? `<tr><td colspan="6" class="sub" style="padding:10px 12px">${missing} copropriétaire${missing>1?'s':''} sans communication structurée : elle figure sur chaque appel de fonds et rend l'attribution des virements certaine. <button class="btn btn-ghost" id="ownAssignOgm" style="padding:4px 10px;font-size:12.5px;margin-left:6px">Attribuer les communications structurées</button></td></tr>` : '');
    ot.querySelectorAll('.own-mail').forEach(inp=>inp.onchange=()=>saveOwnerEmail(inp));
    ot.querySelectorAll('.own-per').forEach(sel=>sel.onchange=()=>saveOwnerField(sel.dataset.key, 'periodicity', LSCalls.cleanPeriodicity(sel.value)));
    ot.querySelector('#ownAssignOgm')?.addEventListener('click', assignOgms);
  }
}
// Une colonne de ls_owners (périodicité, communication) : état local, puis Supabase si on y est.
async function saveOwnerField(key, field, value){
  const o=ownersOf().find(x=>String(x.id||x.short||x.n)===String(key)); if(!o) return;
  o[field]=value;
  if(!writeToDb() || !o.id){ saveState(); toastSaved(); renderAll(); return; }
  try{ await window.LS.db.updateOwner(o.id,{[field]:value}); toastSaved(); renderAll(); }
  catch(e){ console.error(e); showToast(callsHint('Échec de l’enregistrement : '+(e.message||e)),'err'); }
}
const callsHint = m => /ogm|periodicity|schema cache|column/i.test(m) ? m+' — lancez supabase/calls.sql dans Supabase (SQL Editor).' : m;
// Une communication structurée par copropriétaire qui n'en a pas : rang dans la liste + graine
// (son identifiant), unique, posée une fois pour toutes.
async function assignOgms(){
  if(!canWrite() || typeof LSCalls==='undefined') return;
  const ow=ownersOf(), taken=new Set(ow.map(o=>String(o.ogm||'').replace(/\D/g,'')).filter(d=>LSCalls.ogmValid(d)));
  let n=0;
  for (const [i,o] of ow.entries()){
    if (LSCalls.ogmValid(o.ogm)) continue;
    let k=i+1, ogm=LSCalls.ogmFromSeed(o.id||o.short||o.n, k);
    while (taken.has(ogm)) ogm=LSCalls.ogmFromSeed(o.id||o.short||o.n, k+=100);
    taken.add(ogm); o.ogm=ogm; n++;
    if (writeToDb() && o.id){ try { await window.LS.db.updateOwner(o.id,{ogm}); } catch(e){ console.error(e); showToast(callsHint('Échec de l’enregistrement : '+(e.message||e)),'err'); return; } }
  }
  saveState();
  if (n){ logTimeline({title:`Communications structurées attribuées`, kind:'manual', description:`${n} copropriétaire${n>1?'s':''} : la communication figure sur les appels de fonds et attribue les virements.`}); showToast(`${n} communication${n>1?'s':''} structurée${n>1?'s':''} attribuée${n>1?'s':''}.`); }
  renderAll();
}
/* ---------- Appels de fonds (calls.js) ---------- */
// Le modèle de l'appel d'un copropriétaire pour l'exercice du dû : son dû (charges, réserve), sa
// périodicité, sa communication, l'IBAN du compte de paiement, la copropriété, le syndic.
function fundCallModel(o, y){
  const m=(window.LS&&window.LS.member)||{}, b=(state.charges||{})[y]||{};
  const pubAt = b.publishedAt ? new Date(b.publishedAt) : null;
  return LSCalls.callModel({name:o.n, short:o.short, q:o.q, email:o.email, ogm:o.ogm, periodicity:o.periodicity},
    {pay:+o.due_pay||0, res:+o.due_res||0},
    {year:y, qTot:sum(ownersOf().map(x=>+x.q||0))||1000, copro:{name:state.coproName||'', addr:state.coproAddr||'', kbo:state.coproKbo||''},
     iban:(state.ibans||{}).pay||'', syndic:{name:(m.full_name||'').trim()||'Le syndic', email:String(m.userEmail||m.email||'').trim()},
     issuedAt:todayISO(), approved: b.approved && b.approved.date ? `budget ${y} approuvé par l'assemblée générale du ${fmtDateLong(b.approved.date)}` : pubAt && !isNaN(pubAt) ? `budget ${y} publié le ${fmtDateLong(pubAt.toISOString().slice(0,10))}` : ''});
}
async function fundCallPdf(owners, y){
  const models=owners.map(o=>fundCallModel(o, y));
  const bytes=await LSCalls.buildPdf(await loadPdfLib(), models, {logo: await brandLogoPng()});
  saveBytes(bytes, owners.length===1 ? LSCalls.fileName(models[0], 'pdf') : `appels-de-fonds-${y}.pdf`);
  logTimeline({title:`Appel${owners.length>1?'s':''} de fonds ${y} généré${owners.length>1?'s':''}`, kind:'manual', description:owners.map(o=>o.n).join(', ')+'.'});
}
async function fundCallEml(o, y){
  const m=fundCallModel(o, y); const logo=await brandMarkPng(); if(logo) m.logoCid='logo@lazysyndic';
  const pdf=await LSCalls.buildPdf(await loadPdfLib(), [m], {logo: await brandLogoPng()});
  const eml=LSConvocation.eml({from:m.syndic.email||undefined, fromName:m.syndic.name, to:o.email?[o.email]:[], subject:LSCalls.subject(m), text:LSCalls.text(m), html:LSCalls.html(m),
    logo: logo?{bytes:logo, cid:'logo@lazysyndic'}:null, pdf:{name:LSCalls.fileName(m,'pdf'), bytes:pdf}});
  const blob=new Blob([eml],{type:'message/rfc822'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=LSCalls.fileName(m,'eml'); document.body.appendChild(a); a.click(); a.remove();
  logTimeline({title:`Appel de fonds ${y} préparé pour ${o.n}`, kind:'manual', description:`${eur(m.total)} pour l'année, ${eur(m.perPeriod)} ${m.every}. Brouillon .eml ${o.email?`adressé à ${o.email}`:'sans destinataire : e-mail à renseigner dans Copropriétaires & lots'}${m.ogm?'':' · sans communication structurée : à attribuer dans Copropriétaires & lots'}.`});
  showToast(o.email ? `Appel de fonds prêt pour ${o.n} (${o.email}) : il s'ouvre dans votre messagerie.` : `Appel prêt, sans destinataire : ${o.n} n'a pas d'e-mail dans Copropriétaires & lots.`, o.email?'':'err');
}

async function saveOwnerEmail(inp){
  const v=inp.value.trim();
  if(v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)){ showToast('Adresse e-mail invalide','err'); return; }
  const o=ownersOf().find(x=>String(x.id||x.short||x.n)===inp.dataset.key); if(!o) return;
  o.email=v;
  if(!writeToDb() || !o.id){ saveState(); toastSaved(); return; }
  try{ await window.LS.db.updateOwner(o.id,{email:v||null}); toastSaved(); }
  catch(e){ console.error(e); showToast(sqlHint('Échec de l’enregistrement : '+(e.message||e)),'err'); }
}

// --- Onglet « Clés de répartition » (exemple calculé sur les vrais propriétaires) ---
function renderKeys(){
  const t=document.getElementById('budKeysTable'); if(!t) return;
  const ow=ownersOf();
  if (!ow.length){ t.innerHTML='<tr><td class="sub" style="padding:14px">Renseignez les propriétaires pour visualiser les clés.</td></tr>'; return; }
  const tot=sum(ow.map(o=>o.q))||1000, n=ow.length;
  const ex=fn=>ow.map(o=>`${o.short||o.n} ${eur(fn(o))}`).join(' · ');
  t.innerHTML='<tr><th>Clé</th><th>Mode de répartition</th><th>Exemple sur 300 €</th></tr>'
    + `<tr><td><b>Acte de base</b></td><td>Quote-part — au prorata des millièmes (× /${tot})</td><td class="sub">${ex(o=>300*o.q/tot)}</td></tr>`
    + `<tr><td><b>Individuelle</b></td><td>À parts égales — ÷ nombre de propriétaires (÷ ${n})</td><td class="sub">${ex(()=>300/n)}</td></tr>`;
  const note=document.getElementById('budKeysNote');
  if(note) note.textContent=`La clé Individuelle compte chaque propriétaire une seule fois (÷ ${n}), même s'il détient plusieurs lots.`;
}

// --- Onglet « Budget » : postes dérivés des vraies dépenses ---
const defaultKey = high => high==='Frais ACP' ? 'indiv' : 'quote';
// Clés de répartition par sous-poste — d'après la Proposition Budget 2026
// (Annexe 4) : Eau, RC civile et frais ACP en Individuelle ; Électricité,
// Habitation et Entretien en Quote-part.
const BUDGET_KEY_BY_SUB = {
  'eau':'indiv', 'rc civile':'indiv', 'rc civil':'indiv', 'rc':'indiv',
  'banque':'indiv', 'logiciel':'indiv', 'frais de gestion':'indiv', 'divers':'indiv',
  'électricité':'quote', 'electricite':'quote', 'gaz':'quote', 'chauffage':'quote',
  'habitation':'quote', 'incendie':'quote', 'adoucisseur':'quote',
  'nettoyage':'quote', 'ascenseur':'quote', 'jardin':'quote', 'communs':'quote', 'réparations':'quote',
};
function budgetDefaultKey(high, sub){
  const k = BUDGET_KEY_BY_SUB[norm(sub)];
  return k || defaultKey(high);
}
/* --- Onglet « Calcul des charges » (calcul pur dans charges.js) -------------------
   Un poste = un nom, une catégorie de la comptabilité (1 pour 1, ou « nouveau poste »
   sans historique), une clé (millièmes ou individuelle) et une prévision annuelle.
   À côté : le réel de l'année précédente sur le compte de paiement et sa moyenne
   mensuelle. La prévision est répartie par copropriétaire ; le syndic peut en faire le
   « dû — paiement » de chacun. Stocké dans ls_settings.charges (supabase/charges.sql) :
   { "2026": { postes:[…], applied:{at, total} } }.
   ------------------------------------------------------------------------------ */
const CHG_MON = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
let chgYear = null;
const chargesHint = m => /charges|schema cache|column/i.test(m) ? m+' — lancez supabase/charges.sql dans Supabase (SQL Editor).' : m;
// Exercice affiché : la prévision se prépare pour l'année qui suit celle en cours, sur le réel
// de l'année en cours à ce jour ; un budget déjà préparé plus loin l'emporte. Un copropriétaire
// ne voit que les budgets publiés : il arrive sur le plus récent d'entre eux.
const budgetPublished = b => typeof LSCharges!=='undefined' && LSCharges.isPublished(b);
function chargesYear(){
  if (chgYear) return chgYear;
  const all=state.charges||{};
  const ys = Object.keys(all).filter(y=>/^\d{4}$/.test(y) && (((all[y]||{}).postes||[]).length || ((all[y]||{}).reserve||[]).length)).map(Number);
  const pub = canWrite() ? [] : ys.filter(y=>budgetPublished(all[y]));
  return chgYear = pub.length ? Math.max(...pub) : Math.max(new Date().getFullYear()+1, ...ys);
}
// Un exercice = postes de charges courantes (compte de paiement) + postes du fonds de réserve,
// en brouillon (status 'draft', visible du seul syndic) ou publié.
// Les postes reviennent RÉSOLUS (LSCharges.resolve) : estimé N-1, réel N-1 et delta sous `calc`,
// prévision calculée par formule tant que le budget est un brouillon, figée une fois publié.
function chargesBudget(y){ const b=(state.charges||{})[y]||{};
  const status=b.status||'draft', applied=b.applied||null, marge=LSCharges.cleanMarge(b.marge);
  const frozen=LSCharges.isPublished({status, applied});
  const tx=chargesTx(), ref=y-1, cov=LSCharges.coverage(tx, ref), prev=LSCharges.clean(((state.charges||{})[ref]||{}).postes);
  const postes=LSCharges.clean(b.postes).map(p=>LSCharges.resolve(p, {tx, year:ref, cov, prev, marge, frozen}));
  return {postes, reserve:LSCharges.cleanReserve(b.reserve, y), applied, status, publishedAt:b.publishedAt||null, approved:b.approved||null, marge, cov, prev, frozen}; }
// Un brouillon ne montre rien d'autre au copropriétaire : ni réserve, ni répartition.
function hideChargesExtras(){
  const res=document.getElementById('resCard'); if(res){ res.innerHTML=''; res.style.display='none'; }
  const t=document.getElementById('chgSplit'), bar=document.getElementById('chgApply'), title=document.getElementById('chgSplitTitle');
  [t&&t.closest('.card'), bar, title].forEach(el=>{ if(el) el.style.display='none'; });
  if(t) t.innerHTML=''; if(bar) bar.innerHTML='';
}
const CHG_MON_SHORT = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
const ymLabel = s => { const m=/^(\d{4})-(\d{2})$/.exec(s||''); return m ? {m:CHG_MON_SHORT[+m[2]-1], y:m[1]} : null; };
// « janv. 2026 → déc. 2028 », ou « janv. → déc. 2026 » dans la même année
function reservePeriod(p, y){
  const a=ymLabel(p.start), b=ymLabel(LSCharges.reserveSpan(p, y).end); if(!a||!b) return '';
  return a.y===b.y ? `${a.m} → ${b.m} ${b.y}` : `${a.m} ${a.y} → ${b.m} ${b.y}`;
}
// Charges courantes et réserve de chacun pour l'exercice, ligne du minimum légal comprise.
function budgetSplit(y){
  const {postes, reserve}=chargesBudget(y), owners=chargesOwners();
  const charges=LSCharges.split(postes, owners);
  // Minimum légal de réserve : 5 % des charges communes ordinaires de l'exercice précédent
  // (art. 3.86 §3), soit le réel N-1 de chaque poste réparti selon sa clé ; sans réel, la prévision N.
  const lb=LSCharges.legalBase(postes, owners, charges.map(c=>c.annual));
  const res=LSCharges.reserveSplit(reserve, y, owners, lb.base);
  return {postes, reserve, charges, res, legalBasis:lb.basis, legalBase:lb.base,
    total: charges.map((c,i)=>Math.round((c.annual+res[i].reserve)*100)/100),
    monthly: charges.map((c,i)=>Math.round((c.annual+res[i].reserve)*100/12)/100)};
}
function chargesTx(){ return (state.tx||[]).map(t=>({iso:(parseDate(t.date)||{}).iso||'', account:t.account, high:t.high, sub:t.sub||'', amount:+t.amount||0, tiers:t.tiers||''})); }
function chargesOwners(){ return ownersOf().map(o=>({key:o.id||o.short||o.n, q:+o.q||0})); }
function saveCharges(y, postes, extra){
  if(!canWrite()) return;
  const plain=(postes||[]).map(p=>{ const {calc, ...q}=p; return q; });   // la prévision résolue est enregistrée, pas le détail du calcul
  state.charges = {...(state.charges||{}), [y]: {...((state.charges||{})[y]||{}), postes:plain, ...(extra||{})}};
  saveState();
  dbWrite(async db=>{ try { await db.updateSettings({charges: state.charges}); } catch(e){ throw new Error(chargesHint(e.message||String(e))); } });
  renderCharges();
}
// Catégories proposées : celles de la comptabilité, plus celles déjà vues dans les mouvements.
function chargeCats(){
  const by=new Map();
  allCats().filter(LSCharges.isExpenseCat).forEach(h=>by.set(h, new Set(subcatsOf(h))));
  (state.tx||[]).forEach(t=>{ if(!LSCharges.isExpenseCat(t.high)) return;
    if(!by.has(t.high)) by.set(t.high, new Set()); if(t.sub) by.get(t.high).add(t.sub); });
  return by;
}
const catFromKey = k => { const i=String(k||'').indexOf('›'); return i<0 ? null : {high:k.slice(0,i), sub:k.slice(i+1)}; };
// Une catégorie déjà reprise par un autre poste est grisée : le mapping reste 1 pour 1.
function chargeCatOptions(p, postes){
  const others=postes.filter(q=>q.id!==p.id).map(q=>q.cat).filter(Boolean);
  const sel=LSCharges.catKey(p.cat);
  let html=`<option value="" ${sel?'':'selected'}>Nouveau poste (sans historique)</option>`, found=!sel;
  for (const [h, subs] of chargeCats()){
    const list=[{high:h, sub:''}, ...[...subs].map(s=>({high:h, sub:s}))];
    html+=`<optgroup label="${escH(h)}">`+list.map(c=>{
      const k=LSCharges.catKey(c), taken=k!==sel && others.some(o=>LSCharges.overlaps(o,c));
      if(k===sel) found=true;
      return `<option value="${escH(k)}" ${k===sel?'selected':''} ${taken?'disabled':''}>${escH(c.sub||(h+' : toute la catégorie'))}${taken?' (déjà reprise)':''}</option>`;
    }).join('')+'</optgroup>';
  }
  if(!found) html+=`<option value="${escH(sel)}" selected>${escH(LSCharges.catLabel(p.cat))}</option>`;   // catégorie disparue de la liste
  return html;
}
function ensureChargesCss(){
  if(document.getElementById('chgCss')) return;
  const s=document.createElement('style'); s.id='chgCss';
  s.textContent=`
    .chg-year{display:flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums;font-size:15px}
    .chg-year .lk{font-size:20px;line-height:1;min-width:36px;min-height:36px;justify-content:center;padding:0}
    #chgTable td{vertical-align:top}
    #chgTable th,#chgTable td{padding-left:8px;padding-right:8px}
    #chgTable th:first-child,#chgTable td:first-child{padding-left:20px}
    #chgTable th:last-child,#chgTable td:last-child{padding-right:16px}
    #chgTable .fld{font-size:13px;padding:6px 8px}
    #chgTable .chg-label{width:100%;min-width:112px}
    #chgTable .chg-cat{font-size:11.5px;padding:3px 5px;color:var(--ink-faint)}
    #chgTable .chg-poste{min-width:280px;max-width:420px}
    #chgTable .chg-meta{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:4px;align-items:center}
    #chgTable .chg-meta-v{display:inline-flex;flex-direction:column;gap:2px;min-width:0}
    #chgTable .chg-meta .fld{font-size:11.5px;padding:3px 6px}
    #chgTable .chg-fcnote{white-space:normal;max-width:220px}
    /* la première colonne reste en vue quand le tableau défile ; une seule colonne engage : le budget */
    #chgTable th:first-child,#chgTable td:first-child{position:sticky;left:0;z-index:1;background:var(--card);box-shadow:1px 0 0 var(--border)}
    #chgTable tr.chg-group td:first-child{background:var(--muted)}
    #chgTable tr.chg-clash td:first-child{background:var(--coral-soft, oklch(.97 .03 40))}
    #chgTable th.emph{color:var(--primary)}
    #chgTable td.emph{background:var(--secondary)}
    #chgTable tr.chg-group td{background:var(--muted);font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);padding-top:8px;padding-bottom:8px}
    .chg-delta.neg{color:var(--danger);font-weight:600}
    .chg-delta.pos{color:var(--success);font-weight:600}
    .chg-chip,.chg-formula{display:inline-flex;align-items:center;gap:4px;margin-top:4px;border:1px dashed var(--border);border-radius:999px;padding:1px 8px;font-size:11px;white-space:nowrap;color:var(--ink-faint)}
    .chg-formula{color:var(--green-deep);cursor:pointer;font-weight:500}
    .chg-chip i,.chg-formula i{font-style:normal;font-weight:700}
    .chg-head-right{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
    .chg-marge{display:flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap}
    .chg-marge .fld{width:62px;text-align:right;font-size:13px;padding:6px 8px}
    .chg-editor{background:var(--muted);padding:12px 20px 16px;margin:0 0 10px;border-radius:8px;white-space:normal}
    @media (max-width:640px){ .chg-editor{padding:12px 14px 14px} }
    .chg-fx{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;max-width:860px;font-weight:400}
    .chg-fx .sub{white-space:normal}
    .chg-fx-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
    .chg-fx-row label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-faint)}
    .chg-fx-row label:first-child{flex:0 1 320px}
    .chg-fx-row label:last-child{flex:1 1 320px}
    .chg-fx-row label.chg-fx-note{flex:1 1 100%}
    .chg-fx .fld{font-size:13px;padding:7px 9px;width:100%;box-sizing:border-box}
    #chgFx{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
    .chg-fx-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
    .copro-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 18px}
    .copro-f{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-faint)}
    .copro-f .fld{font-size:13px;padding:7px 9px}
    .copro-f b{font-size:13.5px;color:var(--ink)}
    #chgTable .chg-cat{min-width:140px;max-width:220px}
    #chgTable .chg-key{min-width:104px}
    #chgTable .chg-vendor{min-width:110px;width:150px}
    #chgTable .chg-fc{width:100px;text-align:right}
    .chg-sub{font-size:11.5px;color:var(--ink-faint);margin-top:3px;white-space:nowrap}
    .chg-sub .lk{font-size:11.5px}
    .chg-warn{font-size:12px;color:var(--danger);margin-top:4px;white-space:normal}
    tr.chg-clash td{background:var(--coral-soft, oklch(.97 .03 40))}
    tr.chg-tot td{font-weight:600;border-top:1.5px solid var(--border)}
    .chg-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
    .chg-note{font-size:12.5px;color:var(--ink-faint);margin-top:10px}
    .chg-empty{padding:4px 0 0;color:var(--ink-faint)}
    #chgCard{padding-bottom:18px}
    #chgCard>.chg-actions,#chgCard>.chg-note,#chgCard>.chg-empty{margin-left:22px;margin-right:22px}
    @media (max-width:640px){ #chgCard>.chg-actions,#chgCard>.chg-note,#chgCard>.chg-empty{margin-left:14px;margin-right:14px} }
    #resTable td{vertical-align:top}
    #resTable th,#resTable td{padding-left:8px;padding-right:8px}
    #resTable th:first-child,#resTable td:first-child{padding-left:20px}
    #resTable th:last-child,#resTable td:last-child{padding-right:16px}
    #resTable .fld{font-size:13px;padding:6px 8px}
    #resTable .res-label{width:100%;min-width:116px}
    #resTable .res-amt{width:96px;text-align:right}
    #resTable .res-months{width:52px;text-align:right}
    #resTable .res-period{white-space:nowrap}
    #resTable .res-key{min-width:112px}
    #resTable tr.res-legal td{background:var(--muted)}
    #resTable tr.res-legal + tr.res-note td{background:var(--muted);padding-top:0;font-size:12px;color:var(--ink-faint);white-space:normal}
    #resCard{padding-bottom:18px}
    #resCard>.chg-actions{margin-left:22px;margin-right:22px}
    @media (max-width:640px){ #resCard>.chg-actions{margin-left:14px;margin-right:14px} }
    #chgSplit tr.chg-group td{background:var(--muted);font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);padding-top:8px;padding-bottom:8px}
    #chgSplit th .chg-sub{font-weight:400;text-transform:none;letter-spacing:0}
    #chgSplit td .chg-sub{white-space:normal}
    #chgApply{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 18px;font-size:13px}
    #chgApply .ok{color:var(--green-deep)}`;
  document.head.appendChild(s);
}
let chgEdit = null;   // éditeur de formule ouvert : {id du poste, which:'real'|'fc'}
// Champs qu'une formule peut utiliser : [token, libellé] ; « réel » n'existe que pour la prévision.
const chgFieldList = ref => [
  ['réel', `Réel ${ref} ramené à 12 mois`], ['réel à ce jour', `Réel ${ref} à ce jour`], ['mois couverts', `Mois couverts en ${ref}`],
  ['moyenne mensuelle', `Moyenne mensuelle ${ref}`], ['réel précédent', `Réel ${ref-1}`], ['budget précédent', `Budget ${ref}`], ['marge', 'Marge'],
];
// Ligne d'éditeur de formule, sous le poste : champs à insérer, formule, résultat, appliquer.
function formulaEditorRow(p, which, y, ref, cols){
  const c=p.calc, isFc=which==='fc', num=v=>(+v||0).toLocaleString('fr-BE',{minimumFractionDigits:2, maximumFractionDigits:2});
  const cur = isFc ? (p.fcFormula || LSCharges.FC_FORMULA) : c.realFormula;
  const opts = chgFieldList(ref).filter(([k])=>isFc || k!=='réel').map(([k,l])=>{ const v=c.fields[k]||0;
    return `<option value="${escH(k)}">${escH(l)} · ${k==='marge'?num(v*100)+' %':k==='mois couverts'?v:eur(v)}</option>`; }).join('');
  const res = LSCharges.evalFormula(cur, c.fields);
  const what = isFc ? `de l'estimation ${y}` : `du réel ${ref}`;
  return `<div class="chg-editor"><div class="chg-fx" role="group" aria-label="Formule ${escH(what)} · ${escH(p.label||'poste')}">
      <div class="h-row" style="align-items:baseline"><b>Formule ${what} · ${escH(p.label||'poste')}</b><span class="sub">Comme dans un tableur : des champs entre crochets et + − × ÷ ( ) %. Le même éditeur sert au réel et à l'estimation.</span></div>
      <div class="chg-fx-row">
        <label>Insérer un champ de la comptabilité<select class="fld" id="chgFxField" aria-label="Champ de la comptabilité à insérer"><option value="">Choisir un champ…</option>${opts}</select></label>
        <label>Formule<input class="fld" id="chgFx" value="${escH(cur)}" spellcheck="false" autocomplete="off" aria-label="Formule ${escH(what)}"></label>
        ${isFc?`<label class="chg-fx-note">Explication du calcul, reprise dans l'Annexe 4<input class="fld" id="chgFxNote" value="${escH(p.fcNote||'')}" maxlength="160" placeholder="Ex. : contrat indexé de 3 %, ou devis reçu" aria-label="Explication du calcul"></label>`:''}
      </div>
      <div class="chg-fx-foot"><span id="chgFxOut">${res.value!=null?`= <b>${eur(res.value)}</b>`:`<span class="chg-warn">${escH(res.error||'')}</span>`}</span>
        <span class="chg-actions" style="margin:0"><button class="btn btn-ghost" id="chgFxStd">Revenir au calcul standard</button><button class="btn btn-ghost" id="chgFxCancel">Annuler</button><button class="btn btn-primary" id="chgFxApply">Appliquer</button></span></div>
    </div></div>`;
}
function renderCharges(){
  const card=document.getElementById('chgCard'); if(!card || typeof LSCharges==='undefined') return;
  ensureChargesCss();
  const y=chargesYear(), ref=y-1, ed=canWrite();
  const bud=chargesBudget(y), {postes, reserve, cov, prev, marge}=bud, pub=budgetPublished(bud);
  const num = v => (+v||0).toLocaleString('fr-BE',{minimumFractionDigits:2, maximumFractionDigits:2});
  const yearNav = `<div class="chg-year"><button class="lk" id="chgPrev" aria-label="Exercice ${y-1}">‹</button><b>${y}</b><button class="lk" id="chgNext" aria-label="Exercice ${y+1}">›</button></div>`;
  if (!ed && !pub){   // copropriétaire : un brouillon reste invisible jusqu'à sa publication
    card.innerHTML = `<div class="h-row"><div><h2>Charges courantes ${y} · compte de paiement</h2><div class="sub">Le syndic prépare le budget ${y} : il sera consultable ici une fois publié.</div></div>${yearNav}</div>`;
    card.querySelector('#chgPrev').onclick=()=>{ chgYear=y-1; renderCharges(); };
    card.querySelector('#chgNext').onclick=()=>{ chgYear=y+1; renderCharges(); };
    hideChargesExtras();
    return;
  }
  const tx=chargesTx();
  const clash=new Set(LSCharges.conflicts(postes).flat());
  const unc=LSCharges.uncovered(tx, postes, ref), prevB=chargesBudget(ref);
  // la réserve d'un exercice précédent continue tant que sa durée n'est pas écoulée
  const prevRes=prevB.reserve.filter(p=>LSCharges.reserveSpan(p, y).inYear>0);
  const vendors=postes.map(p=>LSCharges.vendorOf(tx, p.cat, ref));
  const today = ref===new Date().getFullYear() ? ' à ce jour' : '';
  const covTxt = `Estimation ${y} établie sur le réel ${ref} du compte de paiement` + (!cov.months ? ` : aucun relevé en ${ref}, saisissez les estimations.`
    : cov.months<12 ? `${today}, relevés de ${CHG_MON[cov.from-1]} à ${CHG_MON[cov.to-1]} ramenés à 12 mois.` : ` sur l'année complète.`)
    + ` « Estimé pour ${ref} » rappelle le budget ${ref} ; l'écart est la différence entre ce budget et le réel. Budget ${y} = réel × (1 + marge) par défaut ; la formule et son explication se modifient poste par poste (ƒ).`;
  const totEst=sum(postes.map(p=>p.calc.est||0)), hasEst=postes.some(p=>p.calc.est!=null);
  const totReal=sum(postes.map(p=>p.calc.real||0)), hasReal=postes.some(p=>p.calc.real!=null);
  const totF=sum(postes.map(p=>p.forecast));
  const totDelta = hasEst && hasReal ? Math.round((totEst-totReal)*100)/100 : null;
  const deltaTxt = d => d==null ? '' : d<-0.005 ? 'dépassement' : d>0.005 ? 'sous le budget' : 'conforme';
  const deltaCell = d => d==null ? '<span class="sub">—</span>' : `<span class="chg-delta ${d<-0.005?'neg':d>0.005?'pos':''}">${d<0?'−':''}${eur(Math.abs(d))}</span>`;
  const chip = (p, which, label) => ed ? `<button class="lk chg-formula" data-id="${escH(p.id)}" data-which="${which}" title="Modifier la formule"><i>ƒ</i>${escH(label)}</button>` : `<span class="chg-chip"><i>ƒ</i>${escH(label)}</span>`;
  // Vue copropriétaire : Poste · Budget N · Ma part ; le syndic garde les colonnes d'analyse.
  const me=(window.LS&&window.LS.member)||{};
  const myIdx = !ed && me.owner_short ? ownersOf().findIndex(o=>(o.short||o.n)===me.owner_short) : -1;
  const mySplit = myIdx>=0 ? budgetSplit(y).charges[myIdx] : null;
  const cols = ed ? 6 : (myIdx>=0 ? 3 : 2);
  const keyLabel = k => k==='indiv' ? 'Individuelle' : 'Millièmes';
  const row = (p,i) => { const c=p.calc, bad=clash.has(p.id);
    const estCell = c.est==null ? `<span class="sub">—</span><div class="chg-sub">${prev.length?`absent du budget ${ref}`:`pas de budget ${ref}`}</div>` : `${eur(c.est)}<div class="chg-sub">budget ${ref}</div>`;
    const realCell = !c.hasRef ? `<span class="sub">—</span><div class="chg-sub">${p.cat?`pas de relevé en ${ref}`:'nouveau poste'}</div>`
      : c.real==null ? `<span class="sub">erreur</span><div class="chg-warn">${escH(c.realError||'')}</div><div>${chip(p,'real', LSCharges.shortFormula(c.realFormula))}</div>`
      : `${eur(c.real)}<div class="chg-sub">${eur(c.toDate)} sur ${c.months} mois</div><div>${chip(p,'real', LSCharges.shortFormula(c.realFormula))}</div>`;
    const fcLabel = p.fcFormula ? LSCharges.shortFormula(p.fcFormula) : 'saisie';
    // Le poste porte tout ce qui le définit : nom, catégorie de la comptabilité, bénéficiaire, clé.
    const meta = ed
      ? `<div class="chg-meta">
          <select class="fld chg-cat" data-i="${i}" aria-label="Catégorie de la comptabilité">${chargeCatOptions(p, postes)}</select>
          <span class="chg-meta-v"><input class="fld chg-vendor" data-i="${i}" value="${escH(p.vendor||'')}" placeholder="Bénéficiaire" aria-label="Bénéficiaire">${!p.vendor && vendors[i] ? `<button class="lk chg-vfill" data-i="${i}" title="Tiers le plus fréquent de la catégorie en ${ref}">= ${escH(vendors[i])}</button>` : ''}</span>
          <select class="fld chg-key" data-i="${i}" aria-label="Clé de répartition"><option value="quote" ${p.key==='quote'?'selected':''}>Millièmes</option><option value="indiv" ${p.key==='indiv'?'selected':''}>Individuelle</option></select>
        </div>`
      : `<div class="chg-sub" style="white-space:normal">${[LSCharges.catLabel(p.cat), p.vendor, keyLabel(p.key)].filter(Boolean).map(escH).join(' · ')}</div>`;
    const budgetCell = `${ed?`<input class="fld chg-fc" data-i="${i}" inputmode="decimal" value="${p.forecast?num(p.forecast):''}" placeholder="0,00" aria-label="Budget ${y} du poste">`:`<b>${eur(p.forecast)}</b>`}
        ${c.fcError?`<div class="chg-warn">${escH(c.fcError)}</div>`:''}
        <div>${chip(p,'fc', fcLabel)}</div>
        ${p.fcNote?`<div class="chg-sub chg-fcnote">${escH(p.fcNote)}</div>`:''}`;
    const share = mySplit ? (mySplit.byPoste||{})[p.id]||0 : 0;
    return `<tr class="${bad?'chg-clash':''}">
      <td class="chg-poste">${ed?`<input class="fld chg-label" data-i="${i}" value="${escH(p.label)}" placeholder="Nom du poste" aria-label="Nom du poste">`:`<b>${escH(p.label||'—')}</b>`}${meta}
        ${bad?'<div class="chg-warn">Catégorie déjà reprise par un autre poste : la dépense serait comptée deux fois.</div>':''}</td>
      ${ed?`<td class="num">${estCell}</td>
      <td class="num">${realCell}</td>
      <td class="num">${deltaCell(c.delta)}${c.delta!=null?`<div class="chg-sub">${deltaTxt(c.delta)}</div>`:''}</td>`:''}
      <td class="num emph">${budgetCell}</td>
      ${ed?`<td><button class="lk chg-del" data-i="${i}" aria-label="Supprimer le poste" title="Supprimer le poste">✕</button></td>`
          : myIdx>=0 ? `<td class="num">${eur(share)}<div class="chg-sub">${eur(share/12)} / mois</div></td>` : ''}
    </tr>`;
  };
  // L'éditeur de formule vit sous le tableau, pas dans une ligne : dans le tableau défilant, à
  // 390 px, ses boutons partaient hors champ à droite.
  const edited = ed && chgEdit ? postes.find(p=>p.id===chgEdit.id) : null;
  const editor = edited ? formulaEditorRow(edited, chgEdit.which, y, ref, cols) : '';
  const rows = LSCharges.groupPostes(postes).map(g=>`<tr class="chg-group"><td colspan="${cols}">${escH(g.label||'Sans catégorie')}</td></tr>` + g.items.map(({p,i})=>row(p,i)).join('')).join('');
  const myTot = mySplit ? mySplit.annual : 0;
  const table = postes.length ? `<div class="table-wrap"><table id="chgTable">
      <tr><th scope="col">Poste</th>${ed?`<th class="num" scope="col">Estimé pour ${ref}</th><th class="num" scope="col">Réel ${ref}</th><th class="num" scope="col">Écart ${ref}</th>`:''}<th class="num emph" scope="col">Budget ${y}</th>${ed?'<th></th>':(myIdx>=0?'<th class="num" scope="col">Ma part</th>':'')}</tr>
      ${rows}
      <tr class="chg-tot"><td>Total · ${postes.length} poste${postes.length>1?'s':''}</td>
        ${ed?`<td class="num">${hasEst?eur(totEst):'—'}<div class="chg-sub">${hasEst?`budget ${ref}`:''}</div></td>
        <td class="num">${hasReal?eur(totReal):'—'}<div class="chg-sub">${hasReal&&cov.months<12?'ramené à 12 mois':''}</div></td>
        <td class="num">${deltaCell(totDelta)}<div class="chg-sub">${deltaTxt(totDelta)}</div></td>`:''}
        <td class="num emph">${eur(totF)}<div class="chg-sub">soit ${eur(totF/12)} / mois</div></td>${ed?'<td></td>':(myIdx>=0?`<td class="num">${eur(myTot)}<div class="chg-sub">${eur(myTot/12)} / mois</div></td>`:'')}</tr>
    </table></div>${editor}`
    : `<div class="chg-empty">Aucun poste de dépense pour ${y}.${ed?'':' Le syndic n’a pas encore préparé ce budget.'}</div>`;
  const seedable = cov.months>0 && LSCharges.seed(tx, ref, cov).some(n=>!postes.some(p=>LSCharges.overlaps(p.cat, n.cat)));
  const actions = !ed ? '' : `<div class="chg-actions">
      <button class="btn btn-ghost" id="chgAdd"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg> Ajouter un poste</button>
      ${seedable?`<button class="btn btn-ghost" id="chgSeed">${postes.length?`Ajouter les catégories de ${ref} sans poste`:`Proposer les postes depuis le réel ${ref}`}</button>`:''}
      ${!postes.length && !reserve.length && (prevB.postes.length||prevRes.length)?`<button class="btn btn-ghost" id="chgCopy">Reprendre le budget ${ref} (${[prevB.postes.length?`${prevB.postes.length} poste${prevB.postes.length>1?'s':''}`:'', prevRes.length?`${prevRes.length} de réserve en cours`:''].filter(Boolean).join(', ')})</button>`:''}
      ${pub ? (bud.applied ? '' : `<button class="btn btn-ghost" id="chgUnpub">Repasser en brouillon</button>`) : (postes.length||reserve.length ? `<button class="btn btn-primary" id="chgPub">Publier le budget ${y}</button>` : '')}
    </div>`;
  const notes = [];
  if (ed && !pub) notes.push(`Brouillon : seul le syndic voit ce budget ${y}, fonds de réserve et répartition compris. « Publier » le rend consultable par les copropriétaires ; l'appliquer aux provisions le publie aussi. À la publication, les estimations calculées par formule sont figées.`);
  if (unc.count) notes.push(`Dépenses ${ref} reprises par aucun poste : ${eur(unc.total)} (${unc.count} mouvement${unc.count>1?'s':''})${unc.uncategorized.count?`, dont ${eur(unc.uncategorized.total)} encore à catégoriser`:''}.`);
  if (postes.some(p=>p.key==='quote') && !sum(ownersOf().map(o=>+o.q||0))) notes.push('Aucune quotité enregistrée : la clé Millièmes ne peut rien répartir (Copropriétaires &amp; lots).');
  const badge = (ed || bud.approved) ? ` <span class="status ${bud.approved?'success':pub?'success':'warning'}" style="vertical-align:middle;margin-left:6px"${pub&&bud.publishedAt?` title="Publié le ${new Date(bud.publishedAt).toLocaleDateString('fr-BE',{day:'numeric',month:'long',year:'numeric'})}"`:''}>${bud.approved?`Approuvé par l'AG du ${fmtDateLong(bud.approved.date)}`:pub?'Publié':'Brouillon'}</span>` : '';
  const margeUi = ed ? `<label class="chg-marge">Marge <input class="fld" id="chgMarge" inputmode="decimal" value="${num(marge)}" aria-label="Marge appliquée aux estimations"> %</label>` : `<span class="sub">Marge ${num(marge)} %</span>`;
  card.innerHTML = `
    <div class="h-row"><div><h2>Charges courantes ${y} · compte de paiement${badge}</h2><div class="sub">${covTxt}</div></div>
      <div class="chg-head-right">${margeUi}${yearNav}</div></div>
    ${table}${actions}${notes.map(n=>`<div class="chg-note">${n}</div>`).join('')}`;

  card.querySelector('#chgPrev').onclick=()=>{ chgYear=y-1; chgEdit=null; renderCharges(); };
  card.querySelector('#chgNext').onclick=()=>{ chgYear=y+1; chgEdit=null; renderCharges(); };
  if (ed){
    const upd=(i, patch)=>saveCharges(y, postes.map((p,k)=>k===i ? {...p, ...patch} : p));
    const updId=(id, patch)=>saveCharges(y, postes.map(p=>p.id===id ? {...p, ...patch} : p));
    card.querySelector('#chgMarge').onchange=e=>{
      const v=e.target.value.trim() ? parseAmount(e.target.value) : NaN;
      if (isNaN(v) || v<0 || v>100){ showToast('Marge invalide : un pourcentage entre 0 et 100, par exemple 3','err'); renderCharges(); return; }
      saveCharges(y, postes, {marge:Math.round(v*100)/100});
    };
    card.querySelectorAll('.chg-label').forEach(inp=>inp.onchange=()=>upd(+inp.dataset.i, {label:inp.value.trim()}));
    card.querySelectorAll('.chg-vendor').forEach(inp=>inp.onchange=()=>upd(+inp.dataset.i, {vendor:inp.value.trim()}));
    card.querySelectorAll('.chg-vfill').forEach(b=>b.onclick=()=>{ const i=+b.dataset.i; upd(i, {vendor:vendors[i]}); });
    card.querySelectorAll('.chg-cat').forEach(s=>s.onchange=()=>{
      const i=+s.dataset.i, p=postes[i], cat=catFromKey(s.value), patch={cat};
      if (cat && !p.label){ patch.label=cat.sub||cat.high; patch.key=budgetDefaultKey(cat.high, cat.sub); }   // poste neuf : nom et clé suggérés
      if (cat && !p.vendor){ const v=LSCharges.vendorOf(tx, cat, ref); if(v) patch.vendor=v; }                       // et bénéficiaire d'après les mouvements
      if (cat && !p.forecast && !p.fcFormula) patch.fcFormula=LSCharges.FC_FORMULA;                                   // et estimation = réel × (1 + marge)
      upd(i, patch);
    });
    card.querySelectorAll('.chg-key').forEach(s=>s.onchange=()=>upd(+s.dataset.i, {key:s.value}));
    card.querySelectorAll('.chg-fc').forEach(inp=>inp.onchange=()=>{
      const v=inp.value.trim() ? parseAmount(inp.value) : 0;
      if (isNaN(v) || v<0){ showToast('Estimation invalide : un montant annuel positif, par exemple 1 250,00','err'); renderCharges(); return; }
      upd(+inp.dataset.i, {forecast:Math.round(v*100)/100, fcFormula:''});   // saisie à la main : la formule s'efface
    });
    card.querySelectorAll('.chg-formula').forEach(b=>b.onclick=()=>{ chgEdit={id:b.dataset.id, which:b.dataset.which}; renderCharges(); });
    const fx=card.querySelector('#chgFx');
    if (fx && chgEdit){
      const p=postes.find(q=>q.id===chgEdit.id), out=card.querySelector('#chgFxOut'), isFc=chgEdit.which==='fc';
      const preview=()=>{ const r=LSCharges.evalFormula(fx.value, p.calc.fields); out.innerHTML = r.value!=null ? `= <b>${eur(r.value)}</b>` : `<span class="chg-warn">${escH(r.error||'')}</span>`; };
      fx.oninput=preview;
      card.querySelector('#chgFxField').onchange=e=>{ const t=e.target.value; if(!t) return; const a=fx.selectionStart??fx.value.length, b=fx.selectionEnd??a;
        fx.value=(fx.value.slice(0,a)+(a&&!/\s$/.test(fx.value.slice(0,a))?' ':'')+'['+t+']'+(/^\s/.test(fx.value.slice(b))||!fx.value.slice(b)?'':' ')+fx.value.slice(b)).replace(/\s{2,}/g,' '); e.target.value=''; fx.focus(); preview(); };
      card.querySelector('#chgFxApply').onclick=()=>{ const f=fx.value.trim(), r=LSCharges.evalFormula(f, p.calc.fields);
        if (r.value==null){ showToast('Formule refusée : '+(r.error||'?'),'err'); return; }
        chgEdit=null; updId(p.id, isFc ? {fcFormula:f, fcNote:String((card.querySelector('#chgFxNote')||{}).value||'').trim()} : {realFormula:f===LSCharges.REAL_FORMULA?'':f}); };
      card.querySelector('#chgFxStd').onclick=()=>{ chgEdit=null; updId(p.id, isFc ? {fcFormula:LSCharges.FC_FORMULA} : {realFormula:''}); };
      card.querySelector('#chgFxCancel').onclick=()=>{ chgEdit=null; renderCharges(); };
      fx.focus();
    }
    card.querySelectorAll('.chg-del').forEach(b=>b.onclick=()=>{
      const i=+b.dataset.i, p=postes[i];
      if (!confirm(`Supprimer le poste « ${p.label||LSCharges.catLabel(p.cat)} » du budget ${y} ?`)) return;
      saveCharges(y, postes.filter((_,k)=>k!==i));
    });
    card.querySelector('#chgAdd').onclick=()=>{
      saveCharges(y, [...postes, {id:LSCharges.newId(), label:'', cat:null, key:'quote', forecast:0}]);
      const l=[...document.querySelectorAll('#chgTable .chg-label')].pop(); if(l) l.focus();
    };
    card.querySelector('#chgSeed')?.addEventListener('click', ()=>{
      const add=LSCharges.seed(tx, ref, cov, c=>budgetDefaultKey(c.high, c.sub)).filter(n=>!postes.some(p=>LSCharges.overlaps(p.cat, n.cat)));
      saveCharges(y, [...postes, ...add]);
      showToast(`${add.length} poste${add.length>1?'s':''} ajouté${add.length>1?'s':''} depuis le réel ${ref} : vérifiez les estimations`);
    });
    card.querySelector('#chgCopy')?.addEventListener('click', ()=>saveCharges(y, prevB.postes.map(p=>({...p, id:LSCharges.newId()})),
      {reserve: prevRes.map(p=>({...p, id:LSCharges.newId()}))}));
    card.querySelector('#chgPub')?.addEventListener('click', ()=>{
      saveCharges(y, postes, {status:'published', publishedAt:new Date().toISOString()});
      logTimeline({title:`Budget ${y} publié`, kind:'manual', description:`${postes.length} poste${postes.length>1?'s':''} de charges courantes et ${reserve.length} de réserve, consultables par les copropriétaires.`});
      showToast(`Budget ${y} publié : les copropriétaires peuvent le consulter.`);
    });
    card.querySelector('#chgUnpub')?.addEventListener('click', ()=>{
      saveCharges(y, postes, {status:'draft'});
      showToast(`Budget ${y} repassé en brouillon : visible du syndic seulement.`);
    });
  }
  renderReserve(y, postes, reserve);
  renderChargesSplit(y);
}
// Fonds de réserve : postes à constituer sur une durée, plus la ligne du minimum légal (charges.js).
function renderReserve(y, postes, reserve){
  const card=document.getElementById('resCard'); if(!card) return;
  card.style.display='';   // peut avoir été masqué par hideChargesExtras (brouillon vu par un copropriétaire)
  const ed=canWrite(), ow=ownersOf(), b=budgetSplit(y), rs=b.res;
  const num = v => (+v||0).toLocaleString('fr-BE',{minimumFractionDigits:2, maximumFractionDigits:2});
  const short = o => escH(o.short||o.n);
  const baseTot=sum(b.legalBase||[]), baseLbl = b.legalBasis==='real' ? `réel ${y-1} ramené à 12 mois` : `prévision ${y}, faute de réel ${y-1}`;
  const minTot=sum(rs.map(r=>r.legalMin)), legalTot=Math.round(sum(rs.map(r=>r.legal))*100)/100;
  const calls=reserve.map(p=>LSCharges.reserveCall(p, y));
  const callTot=Math.round((sum(calls)+legalTot)*100)/100;
  const legalSub = !minTot ? 'sans charges courantes' : legalTot ? 'complément' : 'déjà couvert';
  const note = !minTot ? '' : `Minimum par copropriétaire : ${ow.map((o,i)=>`${short(o)} ${eur(rs[i].legalMin)}`).join(', ')}.`
    + (legalTot ? ` La ligne appelle ce qui manque à chacun : ${ow.map((o,i)=>`${short(o)} ${eur(rs[i].legal)}`).join(', ')}.`
                : ' Les autres postes appellent déjà plus pour chacun, la ligne reste donc à 0,00 €.');
  const lock = '<svg class="i" viewBox="0 0 24 24" role="img" aria-label="Ligne obligatoire, non supprimable"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const rows = reserve.map((p,i)=>{
    const sp=LSCharges.reserveSpan(p, y), per=p.months ? Math.round(p.amount*100/p.months)/100 : 0;
    const callSub = sp.inYear ? `${sp.inYear} mois en ${y}` : `hors de ${y}`;
    return `<tr>
      <td>${ed?`<input class="fld res-label" data-i="${i}" value="${escH(p.label)}" placeholder="Ex. isoler la façade" aria-label="Nom du poste de réserve">`:`<b>${escH(p.label||'—')}</b>`}</td>
      <td class="num">${ed?`<input class="fld res-amt" data-i="${i}" inputmode="decimal" value="${p.amount?num(p.amount):''}" placeholder="0,00" aria-label="Montant à constituer">`:eur(p.amount)}</td>
      <td>${ed?`<label style="display:flex;align-items:center;gap:6px"><input class="fld res-months" data-i="${i}" inputmode="numeric" value="${p.months}" aria-label="Durée en mois"> mois</label>`:`${p.months} mois`}
        <div class="chg-sub res-period">${escH(reservePeriod(p, y))}</div></td>
      <td>${ed?`<select class="fld res-key" data-i="${i}" aria-label="Clé de répartition"><option value="quote" ${p.key==='quote'?'selected':''}>Millièmes</option><option value="indiv" ${p.key==='indiv'?'selected':''}>Individuelle</option></select>`:(p.key==='indiv'?'Individuelle':'Millièmes')}</td>
      <td class="num">${eur(per)}</td>
      <td class="num"><b>${eur(calls[i])}</b><div class="chg-sub">${callSub}</div></td>
      ${ed?`<td><button class="lk res-del" data-i="${i}" aria-label="Supprimer le poste de réserve" title="Supprimer le poste de réserve">✕</button></td>`:''}
    </tr>`;
  }).join('');
  card.innerHTML = `
    <div class="h-row"><div><h2>Fonds de réserve ${y} · compte de réserve</h2>
      <div class="sub">Chaque poste se constitue sur une durée en mois, à partir de janvier ${y}. Appel de l'année = montant ÷ durée × mois couverts en ${y}. La contribution minimum légale complète l'appel de chacun jusqu'à ${LSCharges.LEGAL_RATE} % de ses charges communes ordinaires de l'exercice précédent (art. 3.86 §3), soit le réel ${y-1} ramené à 12 mois${b.legalBasis==='real'?'':`, ou la prévision ${y} tant qu'il n'y a pas de réel ${y-1}`} : elle diminue quand les autres postes appellent déjà davantage.</div></div></div>
    <div class="table-wrap"><table id="resTable">
      <tr><th>Poste</th><th class="num">À constituer</th><th>Durée</th><th>Clé de répartition</th><th class="num">Par mois</th><th class="num">Appel ${y}</th>${ed?'<th></th>':''}</tr>
      <tr class="res-legal"><td><b>Contribution minimum légale</b><div class="chg-sub">Ligne automatique</div></td>
        <td class="num">${eur(minTot)}<div class="chg-sub">${LSCharges.LEGAL_RATE} % de ${eur(baseTot)} · ${baseLbl}</div></td>
        <td>chaque année</td><td>${LSCharges.LEGAL_RATE} % des charges ${y-1} de chacun</td>
        <td class="num">${eur(legalTot/12)}</td>
        <td class="num"><b>${eur(legalTot)}</b><div class="chg-sub">${legalSub}</div></td>${ed?`<td>${lock}</td>`:''}</tr>
      ${note?`<tr class="res-note"><td colspan="${ed?7:6}">${note}</td></tr>`:''}
      ${rows}
      <tr class="chg-tot"><td>Total · ${reserve.length+1} ligne${reserve.length?'s':''}</td><td class="num">${eur(sum(reserve.map(p=>p.amount)))}</td><td></td><td></td>
        <td class="num">${eur(callTot/12)}</td><td class="num">${eur(callTot)}</td>${ed?'<td></td>':''}</tr>
    </table></div>
    ${ed?`<div class="chg-actions"><button class="btn btn-ghost" id="resAdd"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg> Ajouter un poste de réserve</button></div>`:''}`;
  if (!ed) return;
  const upd=(i, patch)=>saveCharges(y, postes, {reserve: reserve.map((p,k)=>k===i ? {...p, ...patch} : p)});
  card.querySelectorAll('.res-label').forEach(inp=>inp.onchange=()=>upd(+inp.dataset.i, {label:inp.value.trim()}));
  card.querySelectorAll('.res-amt').forEach(inp=>inp.onchange=()=>{
    const v=inp.value.trim() ? parseAmount(inp.value) : 0;
    if (isNaN(v) || v<0){ showToast('Montant invalide : un montant positif, par exemple 18 000,00','err'); renderCharges(); return; }
    upd(+inp.dataset.i, {amount:Math.round(v*100)/100});
  });
  card.querySelectorAll('.res-months').forEach(inp=>inp.onchange=()=>{
    const v=Number(String(inp.value).trim());
    if (!Number.isInteger(v) || v<1 || v>600){ showToast('Durée invalide : un nombre entier de mois, de 1 à 600','err'); renderCharges(); return; }
    upd(+inp.dataset.i, {months:v});
  });
  card.querySelectorAll('.res-key').forEach(s=>s.onchange=()=>upd(+s.dataset.i, {key:s.value}));
  card.querySelectorAll('.res-del').forEach(bt=>bt.onclick=()=>{
    const i=+bt.dataset.i, p=reserve[i];
    if (!confirm(`Supprimer le poste de réserve « ${p.label||'sans nom'} » du budget ${y} ?`)) return;
    saveCharges(y, postes, {reserve: reserve.filter((_,k)=>k!==i)});
  });
  card.querySelector('#resAdd').onclick=()=>{
    saveCharges(y, postes, {reserve:[...reserve, {id:LSCharges.newId(), label:'', amount:0, months:12, key:'quote', start:`${y}-01`}]});
    const l=[...document.querySelectorAll('#resTable .res-label')].pop(); if(l) l.focus();
  };
}
// Répartition de la prévision par copropriétaire, poste par poste, et écart avec le « dû » saisi.
function renderChargesSplit(y){
  const t=document.getElementById('chgSplit'), bar=document.getElementById('chgApply'), title=document.getElementById('chgSplitTitle');
  if (!t || !bar) return;
  const ow=ownersOf(), n=ow.length, b=budgetSplit(y), {postes, reserve, charges, res}=b;
  const show = (postes.length>0 || reserve.length>0) && n>0;
  [t.closest('.card'), bar, title].forEach(el=>{ if(el) el.style.display = show ? '' : 'none'; });
  if (!show){ t.innerHTML=''; bar.innerHTML=''; return; }
  const qTot=sum(ow.map(o=>+o.q||0)), cols=3+n;
  const keyLabel = k => k==='indiv' ? `Individuelle (÷ ${n})` : 'Millièmes';
  const cells = vals => vals.map(v=>`<td class="num">${v}</td>`).join('');
  const head = `<tr><th>Poste</th><th>Clé</th><th class="num">Prévision</th>${ow.map(o=>`<th class="num">${escH(o.short||o.n)}<div class="chg-sub">${o.q} / ${qTot} millièmes</div></th>`).join('')}</tr>`;
  const payRows = postes.map(p=>`<tr><td>${escH(p.label||LSCharges.catLabel(p.cat))}</td><td>${keyLabel(p.key)}</td>
      <td class="num">${eur(p.forecast)}</td>${cells(charges.map(r=>eur(r.byPoste[p.id]||0)))}</tr>`).join('');
  const legalTot=Math.round(sum(res.map(r=>r.legal))*100)/100;
  const legalRow = `<tr><td>Contribution minimum légale</td><td>${LSCharges.LEGAL_RATE} % des charges ${y-1}</td><td class="num">${eur(legalTot)}</td>
      ${res.map(r=>`<td class="num">${eur(r.legal)}<div class="chg-sub">min. ${eur(r.legalMin)}${r.legal?'':', couvert'}</div></td>`).join('')}</tr>`;
  const resRows = reserve.map(p=>`<tr><td>${escH(p.label||'—')}</td><td>${keyLabel(p.key)}</td>
      <td class="num">${eur(LSCharges.reserveCall(p, y))}</td>${cells(res.map(r=>eur(r.byPoste[p.id]||0)))}</tr>`).join('');
  const totPay=sum(postes.map(p=>p.forecast)), totRes=Math.round(sum(res.map(r=>r.reserve))*100)/100;
  const duePay=ow.map(o=>+o.due_pay||0), dueRes=ow.map(o=>+o.due_res||0);
  const diffPay=ow.map((o,i)=>Math.abs(duePay[i]-charges[i].annual)>=0.005), diffRes=ow.map((o,i)=>Math.abs(dueRes[i]-res[i].reserve)>=0.005);
  const dueCells = (due, diff) => ow.map((o,i)=>`<td class="num"${diff[i]?' style="color:var(--warning-ink)"':''}>${eur(due[i])}</td>`).join('');
  t.innerHTML = head
    + `<tr class="chg-group"><td colspan="${cols}">Compte de paiement</td></tr>` + payRows
    + `<tr class="chg-sum"><td colspan="2"><b>Charges courantes ${y}</b></td><td class="num"><b>${eur(totPay)}</b></td>${cells(charges.map(r=>`<b>${eur(r.annual)}</b>`))}</tr>`
    + `<tr class="chg-group"><td colspan="${cols}">Compte de réserve</td></tr>` + legalRow + resRows
    + `<tr class="chg-sum"><td colspan="2"><b>Fonds de réserve ${y}</b></td><td class="num"><b>${eur(totRes)}</b></td>${cells(res.map(r=>`<b>${eur(r.reserve)}</b>`))}</tr>`
    + `<tr class="chg-tot"><td colspan="2">Total annuel ${y}</td><td class="num">${eur(totPay+totRes)}</td>${cells(b.total.map(eur))}</tr>`
    + `<tr><td colspan="2">Mensualité</td><td class="num">${eur((totPay+totRes)/12)}</td>${cells(b.monthly.map(v=>`<b>${eur(v)}</b>`))}</tr>`
    + `<tr><td colspan="2" class="sub">Dû actuel, compte de paiement</td><td></td>${dueCells(duePay, diffPay)}</tr>`
    + `<tr><td colspan="2" class="sub">Dû actuel, compte de réserve</td><td></td>${dueCells(dueRes, diffRes)}</tr>`;
  const applied=chargesBudget(y).applied;
  const when = applied && applied.at ? ` le ${new Date(applied.at).toLocaleDateString('fr-BE',{day:'numeric',month:'long',year:'numeric'})}` : '';
  if (!diffPay.some(Boolean) && !diffRes.some(Boolean)) bar.innerHTML = `<span class="ok">✓ Le dû de chaque copropriétaire correspond au budget ${y}, paiement et réserve${when?' (appliqué'+when+')':''}.</span>`;
  else bar.innerHTML = canWrite()
    ? `<button class="btn btn-primary" id="chgApplyBtn">Appliquer aux provisions</button><span class="sub">Le dû de chaque copropriétaire devient sa charge annuelle ${y} sur le compte de paiement et son appel ${y} sur le compte de réserve : le suivi des paiements et des retards s'y fie.</span>`
    : `<span class="sub">Le dû actuel diffère encore du budget calculé pour ${y}.</span>`;
  bar.querySelector('#chgApplyBtn')?.addEventListener('click', ()=>applyCharges(y));
}
async function applyCharges(y){
  if (!canWrite()) return;
  const ow=ownersOf(), b=budgetSplit(y), pay=b.charges.map(r=>r.annual), res=b.res.map(r=>r.reserve);
  const lines=ow.map((o,i)=>`• ${o.n} : paiement ${eur(+o.due_pay||0)} → ${eur(pay[i])} · réserve ${eur(+o.due_res||0)} → ${eur(res[i])} (${eur(b.monthly[i])} / mois)`).join('\n');
  if (!confirm(`Remplacer le dû des copropriétaires par le budget ${y} ?\n\n${lines}\n\nLe suivi des paiements (qui paie quoi, retards) se basera sur ces montants.`)) return;
  const before=ow.map(o=>({pay:+o.due_pay||0, res:+o.due_res||0}));
  ow.forEach((o,i)=>{ o.due_pay=pay[i]; o.due_res=res[i]; });
  if (writeToDb()){
    try { for (const [i,o] of ow.entries()) if (o.id) await window.LS.db.updateOwner(o.id, {due_pay:pay[i], due_res:res[i]}); }
    catch(e){ console.error(e); ow.forEach((o,i)=>{ o.due_pay=before[i].pay; o.due_res=before[i].res; }); toastError(e.message||e); renderProvisions(); renderCharges(); return; }
  }
  const totPay=Math.round(sum(pay)*100)/100, totRes=Math.round(sum(res)*100)/100;
  saveCharges(y, b.postes, {applied:{at:new Date().toISOString(), total:totPay, reserve:totRes,
    byOwner:Object.fromEntries(ow.map((o,i)=>[o.id||o.short||o.n, {pay:pay[i], res:res[i]}]))}, status:'published', publishedAt:chargesBudget(y).publishedAt||new Date().toISOString()});   // appliqué = publié
  logTimeline({title:`Budget ${y} appliqué aux provisions`, kind:'manual',
    description:`Charges courantes ${eur(totPay)} et fonds de réserve ${eur(totRes)} répartis : `+ow.map((o,i)=>`${o.short||o.n} ${eur(b.total[i])}`).join(', ')});
  renderProvisions(); renderDashboard();
}
// Provisions attendues par copropriétaire (le « dû »), éditable par l'admin.
function renderProvisions(){
  const t=document.getElementById('provTable'); if(!t) return;
  const ed=canWrite(); const led=ownerLedger();
  if(!led.length){ t.innerHTML='<tr><td class="sub" style="padding:14px">Aucun propriétaire enregistré.</td></tr>'; return; }
  const num=v=>(+v||0).toLocaleString('fr-BE',{minimumFractionDigits:2, maximumFractionDigits:2});   // 952,63 comme partout, relu par parseAmount
  const ly=led[0].year;
  const calls = ed && typeof LSCalls!=='undefined';
  // Par mois : le dû total réparti selon la périodicité du copropriétaire (mois par défaut) ; en
  // trimestriel ou annuel, l'échéance est indiquée telle quelle, avec la mensualité équivalente dessous.
  const PER_LBL={month:'/ mois', quarter:'/ trimestre', year:'/ an'};
  const perCell=o=>{ const per=typeof LSCalls!=='undefined' ? LSCalls.cleanPeriodicity(o.periodicity) : 'month';
    const first = typeof LSCalls!=='undefined' ? (LSCalls.schedule(o.due, per, ly)[0]||{}).amount||0 : o.due/12;
    return `<b>${eur(first)}</b><div class="chg-sub">${PER_LBL[per]}${per!=='month'?` · ${eur(o.due/12)} / mois`:''}</div>`; };
  t.innerHTML=`<tr><th>Propriétaire</th><th class="num">Dû ${ly} · paiement</th><th class="num">Dû ${ly} · réserve</th><th class="num">Total dû</th><th class="num">Par mois</th><th class="num">Versé ${ly}</th><th class="num">Solde</th>${calls?`<th>Appel de fonds ${ly}</th>`:''}</tr>`
    + led.map(o=>{
      const late=o.solde<-0.005;
      const cell=(cls, v, lbl)=> ed
        ? `<input class="fld ${cls}" data-id="${o.id||''}" value="${num(v)}" inputmode="decimal" aria-label="${escH(lbl)} de ${escH(o.n)}" style="width:92px;text-align:right">`
        : eur(v);
      const key=escH(o.id||o.short||o.n);
      const call = !calls ? '' : o.due>0.005
        ? `<td style="white-space:nowrap"><button class="btn btn-ghost prov-pdf" data-key="${key}" style="padding:4px 10px;font-size:12.5px" title="Document à imprimer ou à joindre">PDF</button> <button class="btn btn-ghost prov-eml" data-key="${key}" style="padding:4px 10px;font-size:12.5px" title="Brouillon d'e-mail avec le PDF joint">E-mail</button><div class="chg-sub">${({month:'mensuel',quarter:'trimestriel',year:'annuel'})[LSCalls.cleanPeriodicity(o.periodicity)]}${LSCalls.ogmValid(o.ogm)?'':' · sans communication structurée'}</div></td>`
        : '<td class="sub">aucun dû</td>';
      return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${(o.short||o.n||'?')[0]}</span> ${o.n}</div></td>
        <td class="num">${cell('prov-pay', o.due_pay, 'Dû paiement')}</td>
        <td class="num">${cell('prov-res', o.due_res, 'Dû réserve')}</td>
        <td class="num">${eur(o.due)}</td>
        <td class="num">${perCell(o)}</td>
        <td class="num">${eur(o.verse)}</td>
        <td class="num"${late?' style="color:var(--coral)"':''}>${o.solde<0?'−':''}${eur(Math.abs(o.solde))}</td>${call}</tr>`;
    }).join('')
    + (calls && led.some(o=>o.due>0.005) ? `<tr><td colspan="8" style="padding:10px 12px"><button class="btn btn-ghost" id="provAllPdf" style="padding:5px 12px;font-size:12.5px">Tous les appels de fonds ${ly} en un PDF</button> <span class="sub">une page par copropriétaire : échéancier, IBAN du compte de paiement, communication structurée.</span></td></tr>` : '');
  if(ed){
    t.querySelectorAll('.prov-pay').forEach(inp=>inp.onchange=()=>saveProvision(inp,'due_pay'));
    t.querySelectorAll('.prov-res').forEach(inp=>inp.onchange=()=>saveProvision(inp,'due_res'));
    const byKey=k=>ownersOf().find(o=>String(o.id||o.short||o.n)===String(k));
    t.querySelectorAll('.prov-pdf').forEach(b=>b.onclick=()=>{ const o=byKey(b.dataset.key); if(o) fundCallPdf([o], ly).catch(e=>showToast(e.message||String(e),'err')); });
    t.querySelectorAll('.prov-eml').forEach(b=>b.onclick=()=>{ const o=byKey(b.dataset.key); if(o) fundCallEml(o, ly).catch(e=>showToast(e.message||String(e),'err')); });
    t.querySelector('#provAllPdf')?.addEventListener('click', ()=>fundCallPdf(ownersOf().filter(o=>(+o.due_pay||0)+(+o.due_res||0)>0.005), ly).catch(e=>showToast(e.message||String(e),'err')));
  }
}
function saveProvision(inp, field){
  const id=inp.dataset.id, v=parseAmount(inp.value);
  if(isNaN(v)){ renderProvisions(); return; }
  const o=(state.owners||[]).find(x=>x.id===id); if(o) o[field]=v;
  dbWrite(db=>db.updateOwner(id,{[field]:v}));
  renderProvisions(); renderDashboard(); renderCharges();
}
// genBudget câblé dans la section GÉNÉRATEUR DE RAPPORTS (Annexe 4).

/* ============================================================
   RÈGLES & ALIAS (persistés)
   ============================================================ */
function renderRules(){
  const t=document.getElementById('ruleTable'); if(!t) return;
  t.innerHTML='<tr><th>Tiers (libellé)</th><th>Catégorie</th><th>Sous-catégorie</th><th></th></tr>';
  state.rules.forEach((r,i)=>t.insertAdjacentHTML('beforeend',`<tr data-i="${i}"><td><input class="fld rl-label" value="${r[0]}" style="width:160px;font-weight:600"></td>
    <td><select class="fld rl-cat">${allCats().map(c=>`<option ${c===r[1]?'selected':''}>${c}</option>`).join('')}<option value="__new__">➕ Nouvelle catégorie…</option></select></td>
    <td><select class="fld rl-sub" style="width:170px">${subcatOptions(r[1], r[2]||'')}</select></td>
    <td style="text-align:right"><button class="flagbtn rl-del" style="opacity:.5">✕</button></td></tr>`));
  t.querySelectorAll('tr[data-i]').forEach(tr=>{
    const i=+tr.dataset.i;
    const rid=()=>state.rules[i][3];
    tr.querySelector('.rl-label').onchange=e=>{if(!canWrite())return;state.rules[i][0]=e.target.value;saveState();dbWrite(db=>db.updateRule(rid(),{label:e.target.value}));};
    tr.querySelector('.rl-cat').onchange=e=>{
      if(!canWrite())return;
      let v=e.target.value;
      if(v==='__new__'){ const n=addCategory(prompt('Nouvelle catégorie :','')||''); if(!n){renderRules();return;} v=n; }
      state.rules[i][1]=v; state.rules[i][2]='';   // changer de catégorie réinitialise la sous-catégorie
      saveState(); dbWrite(db=>db.updateRule(rid(),{high:v, sub:''}));
      renderRules();
    };
    tr.querySelector('.rl-sub').onchange=e=>{
      if(!canWrite())return;
      let v=e.target.value;
      if(v==='__new__'){ const n=addSubcat(state.rules[i][1], prompt('Nouvelle sous-catégorie pour « '+state.rules[i][1]+' » :','')||''); if(!n){renderRules();return;} v=n; }
      state.rules[i][2]=v; saveState(); dbWrite(db=>db.updateRule(rid(),{sub:v}));
      renderRules();
    };
    tr.querySelector('.rl-del').onclick=()=>{if(!canWrite())return;const id=rid();state.rules.splice(i,1);saveState();renderRules();dbWrite(db=>db.deleteRule(id));};
  });
}
function renderAliases(){
  const t=document.getElementById('aliasTable'); if(!t) return;
  t.innerHTML='<tr><th>Libellé tel qu\'il apparaît à la banque</th><th>Rattaché à</th><th></th></tr>';
  state.aliases.forEach((a,i)=>t.insertAdjacentHTML('beforeend',`<tr data-i="${i}"><td><input class="fld al-label" value="${a[0]}" style="width:100%;font-family:monospace;font-size:12.5px"></td>
    <td><input class="fld al-entity" value="${a[1]}" style="width:100%;font-weight:600"></td>
    <td style="text-align:right"><button class="flagbtn al-del" style="opacity:.5">✕</button></td></tr>`));
  t.querySelectorAll('tr[data-i]').forEach(tr=>{
    const i=+tr.dataset.i;
    const aid=()=>state.aliases[i][4];
    tr.querySelector('.al-label').onchange=e=>{if(!canWrite())return;state.aliases[i][0]=e.target.value;saveState();dbWrite(db=>db.updateAlias(aid(),{label:e.target.value}));};
    tr.querySelector('.al-entity').onchange=e=>{if(!canWrite())return;state.aliases[i][1]=e.target.value;saveState();dbWrite(db=>db.updateAlias(aid(),{entity:e.target.value}));};
    tr.querySelector('.al-del').onclick=()=>{if(!canWrite())return;const id=aid();state.aliases.splice(i,1);saveState();renderAliases();dbWrite(db=>db.deleteAlias(id));};
  });
}
document.getElementById('addRule')?.addEventListener('click',()=>{
  if(!canWrite()){alert('Lecture seule.');return;}
  const r=['Nouveau tiers','Énergie','',null]; state.rules.push(r); saveState(); renderRules();
  dbWrite(async db=>{ const s=await db.addRule({label:r[0],high:r[1],sub:r[2]}); r[3]=s.id; });
});
document.getElementById('addAlias')?.addEventListener('click',()=>{
  if(!canWrite()){alert('Lecture seule.');return;}
  const a=['NOUVEAU LIBELLÉ','—',false,'',null]; state.aliases.push(a); saveState(); renderAliases();
  dbWrite(async db=>{ const s=await db.addAlias({label:a[0],entity:a[1],is_owner:false,short:''}); a[4]=s.id; });
});

/* ============================================================
   INIT
   ============================================================ */
// En-têtes pilotés par les données (greeting, sidebar, bannière réserve).
// Page de garde : date de la prochaine assemblée générale (l'AG en cours, pas encore finalisée).
// La date est le texte saisi à l'étape 1 de l'AG ; sans AG en cours, on rappelle la dernière.
function renderNextAG(){
  const box=document.getElementById('agNext'); if(!box) return;
  const ags=state.ags||[];
  const cur=ags.find(a=>a.status!=='finalisee');
  const last=ags.find(a=>a.status==='finalisee');
  const ic='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>';
  const esc=v=>String(v||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let v, sub, cta;
  if(cur){
    v = cur.ag_date ? esc(cur.ag_date) : 'Date à fixer';
    sub = [cur.type?`AG ${esc(cur.type).toLowerCase()}`:'', esc(cur.lieu), AG_STATUS[cur.status]||''].filter(Boolean).join(' · ');
    cta = canWrite() ? 'Préparer l’AG →' : 'Voir l’AG →';
  } else {
    v = 'Aucune AG planifiée';
    sub = last ? `Dernière AG : ${esc(last.ag_date||last.title||'—')}` : 'Aucune assemblée enregistrée pour l’instant';
    cta = canWrite() ? 'Planifier l’AG →' : 'Voir les AG →';
  }
  box.classList.toggle('todo', !cur || !cur.ag_date);
  box.innerHTML=`<div class="agn-ic">${ic}</div>
    <div class="agn-b"><div class="agn-l">Prochaine assemblée générale</div><div class="agn-v">${v}</div><div class="agn-s">${sub}</div></div>
    <button class="btn btn-ghost" type="button" id="agNextGo">${cta}</button>`;
  box.querySelector('#agNextGo').onclick=()=>goToScreen('ag');
}
// revenir sur la page de garde rafraîchit la date (elle se saisit dans l'écran AG)
document.querySelector('.nav button[data-s="dash"]')?.addEventListener('click', renderNextAG);

function renderChrome(){
  const m = (window.LS && window.LS.member) || null;
  const prenom = m ? (((m.full_name||'').trim().split(/\s+/)[0]) || m.owner_short || m.userEmail) : '';
  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('greet', prenom ? `Bonjour ${prenom}` : 'Bonjour');
  renderNextAG();
  // sidebar : copropriété + utilisateur connecté
  const ow = ownersOf(); const total = sum(ow.map(o=>o.q||0));
  set('sideCopro', state.coproName || 'Ma copropriété');
  set('sideMeta', `${ow.length} propriétaire${ow.length>1?'s':''} · ${total}/1000`);
  if (m){
    set('sideAv', (prenom[0]||'·').toUpperCase());
    set('sideUser', prenom||'—');
    set('sideRole', demoMode ? '🧪 Mode démo — cliquer pour quitter'
                    : (m.role==='admin' ? 'Syndic · Admin' : 'Lecture seule'));
  }
  // icône de compte = bascule du mode démo (admin réel uniquement)
  const userBox = document.querySelector('.side-foot .user');
  if (userBox && isRealAdmin()){
    userBox.classList.add('clickable');
    userBox.title = demoMode ? 'Quitter le mode démo' : 'Activer le mode démo (test en prod)';
    userBox.onclick = ()=>toggleDemo();
  }
  // bannière fonds de réserve (dérivée)
  const resBal = balance('res'), tgt = state.reserveTarget||0;
  const pct = tgt>0 ? Math.min(100, Math.round(resBal/tgt*100)) : 0;
  set('resAmt', eur(resBal));
  set('resTarget2', `/ ${tgt.toLocaleString('fr-BE',{maximumFractionDigits:0})} €`);
  set('resRemain', eur(Math.max(0, tgt-resBal)));
  set('resPct', `${pct} % de l'objectif atteint`);
  const f=document.getElementById('resFill'); if(f){ f.dataset.w=pct; f.style.width=pct+'%'; }
  // dates de mise à jour (aujourd'hui) sur tous les écrans
  const today = new Date().toLocaleDateString('fr-BE',{day:'numeric',month:'long',year:'numeric'});
  set('updatedDate', today); set('updatedAcc', today); set('updatedImp', today);
  set('soldesAsOf', 'au '+new Date().toLocaleDateString('fr-BE',{day:'numeric',month:'long'}));
  // note annuelle (ne pas écraser pendant la saisie)
  const an=document.getElementById('annualNote');
  if (an && document.activeElement!==an) an.value = state.annualNote || '';
  renderAccountStats(curAcct);
}
// Statistiques clés du compte, dérivées des transactions réelles.
function renderAccountStats(acct){
  acct = acct || curAcct || 'pay';
  const set=(id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  const txs = txOf(acct).map(t=>({a:t.amount, d:parseDate(t.date)})).filter(x=>x.d)
                        .sort((x,y)=>x.d.iso.localeCompare(y.d.iso));
  if (!txs.length){ ['statDep','statEnt','statTrough'].forEach(id=>set(id,'—'));
    set('statDepSub','pas de données'); set('statEntSub',''); set('statTroughSub',''); return; }
  const n = new Set(txs.map(t=>t.d.iso.slice(0,7))).size || 1;
  const dep = sum(txs.filter(t=>t.a<0).map(t=>-t.a)), ent = sum(txs.filter(t=>t.a>0).map(t=>t.a));
  const depMoy = dep/n, entMoy = ent/n, ecart = entMoy-depMoy;
  set('statDep', '−'+eur(depMoy)); set('statDepSub', `sur ${n} mois`);
  set('statEnt', '+'+eur(entMoy)); set('statEntSub', `écart ${ecart>=0?'+':'−'}${eur(Math.abs(ecart))}/mois · ${ecart>=0?"s'autofinance":'déficitaire'}`);
  const MON=['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  let run=(state.opening&&state.opening[acct])||0, trough=run, tm=null;
  txs.forEach(t=>{ run+=t.a; if(run<trough){ trough=run; tm=t.d; } });
  set('statTrough', eur(trough));
  set('statTroughSub', tm?`creux atteint en ${MON[tm.m-1]} ${tm.y}`:'jamais sous le solde d\'ouverture');
}
// Note annuelle — persistée (settings.annual_note)
document.getElementById('annualNote')?.addEventListener('change', function(){
  if(!canWrite()){ this.value = state.annualNote||''; return; }
  state.annualNote = this.value;
  dbWrite(db=>db.updateSettings({annual_note: this.value}));
});
/* ============================================================
   CHRONOLOGIE (timeline) — événements manuels + audit log
   ============================================================ */
function todayISO(){ const d=new Date(),p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function fmtDateLong(iso){
  const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/); if(!m) return iso||'';
  return new Date(+m[1],+m[2]-1,+m[3]).toLocaleDateString('fr-BE',{day:'numeric',month:'long',year:'numeric'});
}
const TL_KIND={
  manual:{ic:'✎',c:'var(--clay)',l:'Note'},
  import:{ic:'↧',c:'var(--green)',l:'Import'},
  task:  {ic:'✓',c:'#5B4B86',l:'Tâche'},
  sign:  {ic:'✍',c:'#2F5E8C',l:'Signature'},
};
// Ajoute un événement (manuel ou audit) à la chronologie + persiste.
function logTimeline(ev){
  const e={date:ev.date||todayISO(), title:ev.title||'', description:ev.description||'', kind:ev.kind||'manual', subs:Array.isArray(ev.subs)?ev.subs:[]};
  state.timeline = state.timeline||[];
  state.timeline.unshift(e);
  if(writeToDb()) dbWrite(async db=>{ const s=await db.addTimeline({event_date:e.date,title:e.title,description:e.description,kind:e.kind,subs:e.subs}); e.id=s.id; });
  else saveState();
  if(document.getElementById('tlContent')) renderTimeline();
}
// Persiste les sous-étapes d'un événement (et re-rend la chronologie).
function tlUpdateSubs(ev){
  saveState();
  if(writeToDb() && ev.id) dbWrite(db=>db.updateTimeline(ev.id, {subs: ev.subs}));
  renderTimeline();
}
let tlYear=null;
let tlCssDone=false;
function ensureTimelineCss(){
  if(tlCssDone) return; tlCssDone=true;
  const s=document.createElement('style');
  s.textContent=`
    .tl{position:relative;margin:8px 0 0 8px;padding-left:26px}
    .tl::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;background:var(--line)}
    .tl-item{position:relative;margin-bottom:16px}
    .tl-dot{position:absolute;left:-26px;top:2px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;
      color:#fff;font-size:11px;font-weight:700;box-shadow:0 0 0 3px var(--paper)}
    .tl-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:11px 14px}
    .tl-date{font-size:11.5px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.04em;display:flex;gap:8px;align-items:center}
    .tl-title{font-weight:600;font-size:14.5px;margin-top:2px}
    .tl-desc{font-size:13px;color:var(--ink-soft);margin-top:3px;white-space:pre-wrap}
    .tl-subs{margin-top:9px;border-top:1px dashed var(--line);padding-top:8px}
    .tl-sub-list{margin:0;padding:0;list-style:none;counter-reset:tlsub}
    .tl-sub{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0;counter-increment:tlsub}
    .tl-sub::before{content:counter(tlsub) ".";color:var(--ink-faint);font-variant-numeric:tabular-nums;min-width:18px;text-align:right}
    .tl-sub.done .tl-sub-t{text-decoration:line-through;color:var(--ink-faint)}
    .tl-sub-chk{background:none;border:none;cursor:pointer;font-size:15px;padding:0;line-height:1;color:var(--green)}
    .tl-sub-chk-ro{color:var(--ink-faint)}
    .tl-sub-t{flex:1}
    .tl-sub-del{color:var(--ink-faint)!important;opacity:.55;font-size:12px}
    .tl-sub-del:hover{opacity:1}
    .tl-sub-add{display:flex;gap:8px;margin-top:7px;align-items:center}
    .tl-sub-add .tl-sub-input{flex:1;min-width:0;font-size:12.5px;padding:5px 9px}`;
  document.head.appendChild(s);
}
function tlYears(){ return [...new Set((state.timeline||[]).map(e=>(e.date||'').slice(0,4)).filter(Boolean))].sort().reverse(); }
function renderTimeline(){
  const root=document.getElementById('tlContent'); if(!root) return;
  ensureTimelineCss();
  const years=tlYears();
  if(tlYear===null || (years.length && !years.includes(tlYear))) tlYear = years[0] || String(new Date().getFullYear());
  const events=(state.timeline||[]).filter(e=>(e.date||'').slice(0,4)===tlYear)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));   // récent en haut
  const yearOpts=(years.length?years:[tlYear]).map(y=>`<option ${y===tlYear?'selected':''}>${y}</option>`).join('');
  const addForm = canWrite() ? `
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin-bottom:12px">Ajouter un événement</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Date</div><input class="fld" id="tlDate" type="date" value="${todayISO()}" style="margin-top:4px"></div>
        <div style="flex:1;min-width:200px"><div class="l" style="font-size:12px;color:var(--ink-faint)">Titre</div><input class="fld" id="tlTitle" placeholder="Ex. Fuite cave réparée" style="width:100%;margin-top:4px"></div>
        <button class="btn btn-primary" id="tlAdd">+ Ajouter</button>
      </div>
      <div style="margin-top:10px"><div class="l" style="font-size:12px;color:var(--ink-faint)">Description (optionnelle)</div>
        <textarea class="fld" id="tlDesc" style="width:100%;margin-top:4px;min-height:54px;resize:vertical" placeholder="Détails de l'événement…"></textarea></div>
    </div>` : '';
  const items = events.length ? events.map(e=>{
    const k=TL_KIND[e.kind]||TL_KIND.manual;
    const ti=state.timeline.indexOf(e);
    const del = (e.kind==='manual'&&canWrite()) ? ` <button class="lk del tl-del" data-id="${e.id||''}">supprimer</button>` : '';
    const subs = Array.isArray(e.subs) ? e.subs : [];
    const subList = (subs.length || canWrite()) ? `<div class="tl-subs">
        <ol class="tl-sub-list">${subs.map((s,si)=>`<li class="tl-sub${s.done?' done':''}">
          ${canWrite()?`<button class="tl-sub-chk" data-ti="${ti}" data-si="${si}" title="Marquer fait / à faire">${s.done?'☑':'☐'}</button>`:`<span class="tl-sub-chk-ro">${s.done?'☑':'•'}</span>`}
          <span class="tl-sub-t">${s.title||''}</span>
          ${canWrite()?`<button class="lk tl-sub-del" data-ti="${ti}" data-si="${si}" title="Supprimer l'étape">✕</button>`:''}
        </li>`).join('')}</ol>
        ${canWrite()?`<div class="tl-sub-add"><input class="fld tl-sub-input" data-ti="${ti}" placeholder="Ajouter une sous-étape…"><button class="lk tl-sub-add-btn" data-ti="${ti}">+ étape</button></div>`:''}
      </div>` : '';
    return `<div class="tl-item">
      <div class="tl-dot" style="background:${k.c}">${k.ic}</div>
      <div class="tl-card">
        <div class="tl-date">${fmtDateLong(e.date)} · <span style="color:${k.c};font-weight:600">${k.l}</span>${del}</div>
        <div class="tl-title">${e.title}</div>
        ${e.description?`<div class="tl-desc">${e.description}</div>`:''}
        ${subList}
      </div></div>`;
  }).join('') : '<div class="sub" style="padding:14px">Aucun événement pour cet exercice.</div>';
  root.innerHTML = `
    <div class="controls"><div class="l" style="font-size:12px;color:var(--ink-faint)">Exercice</div>
      <select class="fld" id="tlYearSel">${yearOpts}</select>
      <span class="sub">${events.length} événement(s)</span></div>
    ${addForm}
    <div class="tl">${items}</div>`;
  root.querySelector('#tlYearSel').onchange=e=>{ tlYear=e.target.value; renderTimeline(); };
  const addBtn=root.querySelector('#tlAdd');
  if(addBtn) addBtn.onclick=()=>{
    if(!canWrite()){ alert('Lecture seule.'); return; }
    const t=root.querySelector('#tlTitle').value.trim(); if(!t){ root.querySelector('#tlTitle').focus(); return; }
    logTimeline({date:root.querySelector('#tlDate').value||todayISO(), title:t, description:root.querySelector('#tlDesc').value.trim(), kind:'manual'});
  };
  root.querySelectorAll('.tl-del').forEach(b=>b.onclick=()=>{
    if(!canWrite()) return;
    const id=b.dataset.id; const idx=state.timeline.findIndex(x=>x.id===id || (!id&&x===events.find(ev=>ev.id===id)));
    const ev=state.timeline.find(x=>x.id===id);
    if(ev){ state.timeline.splice(state.timeline.indexOf(ev),1); if(writeToDb()&&id) dbWrite(db=>db.deleteTimeline(id)); else saveState(); renderTimeline(); }
  });
  // --- sous-étapes ---
  const addSub=(ti)=>{
    if(!canWrite()) return;
    const inp=root.querySelector(`.tl-sub-input[data-ti="${ti}"]`); if(!inp) return;
    const v=(inp.value||'').trim(); if(!v){ inp.focus(); return; }
    const ev=state.timeline[ti]; if(!ev) return;
    ev.subs=Array.isArray(ev.subs)?ev.subs:[]; ev.subs.push({title:v, done:false});
    tlUpdateSubs(ev);
  };
  root.querySelectorAll('.tl-sub-add-btn').forEach(b=>b.onclick=()=>addSub(+b.dataset.ti));
  root.querySelectorAll('.tl-sub-input').forEach(inp=>inp.addEventListener('keydown',e=>{
    if(e.key==='Enter'){ e.preventDefault(); addSub(+inp.dataset.ti); }
  }));
  root.querySelectorAll('.tl-sub-chk').forEach(b=>b.onclick=()=>{
    if(!canWrite()) return;
    const ev=state.timeline[+b.dataset.ti]; if(!ev||!ev.subs) return;
    const s=ev.subs[+b.dataset.si]; if(!s) return; s.done=!s.done; tlUpdateSubs(ev);
  });
  root.querySelectorAll('.tl-sub-del').forEach(b=>b.onclick=()=>{
    if(!canWrite()) return;
    const ev=state.timeline[+b.dataset.ti]; if(!ev||!ev.subs) return;
    ev.subs.splice(+b.dataset.si,1); tlUpdateSubs(ev);
  });
}

function renderAll(){
  fillReportPeriod();
  renderChrome();
  renderDashboard();
  renderMySituation();
  renderPaymentTracking();
  renderReminders();
  refreshAccountChrome();
  renderBFR();
  renderComptabilite();
  renderTx(curAcct);
  renderChart(curAcct);
  renderContracts();
  renderRules();
  renderAliases();
  renderBudgetOwn();
  renderKeys();
  renderTrash();
  renderCharges();
  renderProvisions();
  renderAG();
  renderTimeline();
  renderPendingImports();
  renderBankCard();
  renderImports();
  animateBars();
}

/* ============================================================
   AUTH + BOOT (en ligne : login Supabase puis chargement partagé)
   ============================================================ */
function applyRoleUI(){
  const ro = ONLINE && !canWrite();
  document.body.classList.toggle('readonly', ro);
}
function loadDemoState(){
  try { const raw=localStorage.getItem(DEMO_KEY); if(raw) return JSON.parse(raw); } catch(e){}
  return freshState();
}
// Accepte des données déjà préchargées (loadAll lancé en parallèle dans boot)
// pour éviter un aller-retour séquentiel.
async function bootData(preloaded){
  if (demoMode){
    state = loadDemoState();
    state.draftTx = state.draftTx || [];
    OWNERS = (state.owners && state.owners.length) ? state.owners
      : [{n:'Alex Martin',short:'Alex',q:500,c:'#2F6B53'},{n:'Sam Bernard',short:'Sam',q:251,c:'#5B4B86'},{n:'Lou Petit',short:'Lou',q:249,c:'#C9854A'}];
  } else {
    try {
      state = preloaded || await window.LS.db.loadAll();
      // Une base d'avant la colonne `draft` ne renvoie pas la liste : mieux vaut aucune ligne en
      // attente qu'un `undefined` qui casse le panneau de validation.
      state.draftTx = state.draftTx || [];
      if (window.LS.canWrite) window.LS.db.purgeOldTrash().catch(()=>{});
      if (state.owners && state.owners.length) OWNERS = state.owners;
      backfillAppliedByOwner();
    } catch(e){
      console.error(e);
      alert('Chargement des données impossible : '+(e.message||e));
      state = freshState();
    }
  }
  applyRoleUI();
  applyDemoUI();
  renderAll();
  // Après le rendu seulement : l'écran ciblé et ses filtres doivent exister pour être atteints.
  applyDeepLink();
  // Synchro bancaire : range les lignes arrivées depuis la dernière visite, puis traite un
  // éventuel retour de la banque (banque.html). Syndic en ligne seulement ; jamais en démo.
  bankInit().catch(e=>console.error('synchro bancaire', e));
}

/* ----- MODE DÉMO ----- */
function injectDemoCSS(){
  if (document.getElementById('demoCss')) return;
  const s=document.createElement('style'); s.id='demoCss';
  s.textContent=`
    #demoBanner{position:fixed;top:0;left:0;right:0;z-index:90;display:none;align-items:center;justify-content:center;gap:10px;
      background:repeating-linear-gradient(45deg,#C9854A,#C9854A 14px,#b9783f 14px,#b9783f 28px);
      color:#2A1B0C;font-size:12.5px;font-weight:700;padding:5px 12px;letter-spacing:.02em}
    #demoBanner button{all:unset;cursor:pointer;background:#2A1B0C;color:#F4E9D9;font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:20px}
    body.demo #demoBanner{display:flex}
    body.demo .app{outline:3px solid var(--clay);outline-offset:-3px}
    body.demo{padding-top:0}
    .side-foot .user.clickable{cursor:pointer;transition:.15s}
    .side-foot .user.clickable:hover{background:rgba(255,255,255,.12)}`;
  document.head.appendChild(s);
  if (!document.getElementById('demoBanner')){
    const b=document.createElement('div'); b.id='demoBanner';
    b.innerHTML=`🧪 MODE DÉMO — données fictives, rien n'est enregistré dans la base <button id="demoExit">Quitter la démo</button>`;
    document.body.appendChild(b);
    b.querySelector('#demoExit').onclick=()=>toggleDemo(false);
  }
}
function applyDemoUI(){
  injectDemoCSS();
  document.body.classList.toggle('demo', !!demoMode);
}
function isRealAdmin(){ return !!(window.LS && window.LS.canWrite); }
function toggleDemo(force){
  if (!isRealAdmin()) return;                    // réservé à l'admin réel
  const next = (typeof force==='boolean') ? force : !demoMode;
  if (next) localStorage.setItem(DEMO_FLAG,'1'); else localStorage.removeItem(DEMO_FLAG);
  location.reload();                             // boot rechargera dans le bon mode
}
window.LazySyndic.toggleDemo = toggleDemo;

/* ----- écran de connexion ----- */
function injectLoginCSS(){
  const s=document.createElement('style');
  s.textContent=`
    #loginOverlay{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center;overflow-y:auto;
      background:var(--paper);background-image:radial-gradient(circle at 1px 1px,rgba(33,40,30,.035) 1px,transparent 0);background-size:22px 22px;padding:24px}
    #loginOverlay.on{display:flex;flex-direction:column;gap:20px}
    .login-shell{display:grid;grid-template-columns:1fr 1fr;width:880px;max-width:100%;background:var(--card);border:1px solid var(--line);
      border-radius:24px;box-shadow:0 2px 4px rgba(33,40,30,.05),0 24px 60px rgba(33,40,30,.12);overflow:hidden}
    .login-aside{background:var(--green-deep);color:#C8D6CC;padding:38px 36px;display:flex;flex-direction:column;gap:22px;position:relative;overflow:hidden}
    .login-aside::after{content:"";position:absolute;right:-90px;bottom:-90px;width:300px;height:300px;border-radius:50%;
      background:radial-gradient(circle,rgba(201,133,74,.2),transparent 65%);pointer-events:none}
    .login-aside img{height:36px;width:auto;align-self:flex-start}
    .login-aside h2{font-family:var(--display);font-weight:700;font-size:27px;line-height:1.15;letter-spacing:-.03em;color:#fff;margin-top:auto}
    .login-aside ul{list-style:none;display:grid;gap:10px;font-size:13.5px}
    .login-aside li{display:flex;gap:10px;align-items:flex-start}
    .login-aside li::before{content:"";flex:none;width:7px;height:7px;border-radius:2px;background:var(--clay);margin-top:7px}
    .login-aside a{color:#E5B98F;font-size:13px;font-weight:600;text-decoration:none;position:relative;z-index:1}
    .login-aside a:hover{color:#fff}
    .login-card{padding:40px 40px 34px;display:flex;flex-direction:column;justify-content:center}
    .login-card .login-mlogo{display:none;height:32px;width:auto;margin-bottom:18px}
    .login-card h1{font-family:var(--display);font-size:26px;font-weight:700;letter-spacing:-.03em}
    .login-card .sub{font-size:13.5px;color:var(--ink-soft);margin:4px 0 24px}
    .login-card label{display:block;font-size:12.5px;font-weight:600;color:var(--ink-soft)}
    .login-card input{width:100%;font-family:inherit;font-size:15px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:#fff;margin:6px 0 16px;color:var(--ink);transition:border-color .15s,box-shadow .15s}
    .login-card input:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 3px var(--green-soft)}
    .login-card .btn{width:100%;justify-content:center;padding:13px 18px;font-size:15px}
    .login-msg{font-size:13px;margin-top:14px;min-height:18px}
    .login-msg.err{color:var(--coral)} .login-msg.ok{color:var(--green)}
    .login-alt{margin-top:16px;text-align:center;font-size:13px;color:var(--ink-soft)}
    .login-alt a{color:var(--green);font-weight:600;cursor:pointer}
    .login-credit{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-faint);text-decoration:none;transition:color .18s}
    .login-credit svg{width:16px;height:15px;flex:none}
    .login-credit b{color:var(--ink-soft);font-weight:600;transition:color .18s}
    .login-credit:hover,.login-credit:hover b{color:var(--ink)}
    @media(max-width:760px){
      .login-shell{grid-template-columns:1fr;width:420px}
      .login-aside{display:none}
      .login-card{padding:30px 24px 26px}
      .login-card .login-mlogo{display:block}
    }
    /* bandeau session + lecture seule */
    #sessionBar{position:fixed;top:10px;right:14px;z-index:60;display:none;align-items:center;gap:10px;font-size:12.5px;
      background:var(--card);border:1px solid var(--line);border-radius:30px;padding:5px 6px 5px 14px;box-shadow:var(--shadow)}
    #sessionBar.on{display:flex}
    #sessionBar .ro{font-weight:600;color:var(--clay)}
    #sessionBar button{all:unset;cursor:pointer;font-size:12px;font-weight:600;color:var(--ink-soft);background:var(--card-2);border:1px solid var(--line);border-radius:20px;padding:5px 12px}
    body.readonly .btn-primary,body.readonly #ctAdd,body.readonly #addRule,body.readonly #addAlias{opacity:.5;cursor:not-allowed}`;
  document.head.appendChild(s);
}
function buildLogin(){
  injectLoginCSS();
  const ov=document.createElement('div'); ov.id='loginOverlay';
  ov.innerHTML=`<div class="login-shell">
    <div class="login-aside">
      <img src="brand/logo-white.svg" alt="LazySyndic" width="148" height="36">
      <h2>La copropriété en pilote automatique.</h2>
      <ul>
        <li>Les comptes de l'immeuble, à jour à chaque relevé</li>
        <li>Le solde de chaque copropriétaire, en clair</li>
        <li>L'assemblée générale préparée pas à pas</li>
      </ul>
      <a href="decouvrir/">Découvrir LazySyndic →</a>
    </div>
    <div class="login-card">
      <img class="login-mlogo" src="brand/logo.svg" alt="LazySyndic" width="132" height="32">
      <h1>Connexion</h1>
      <div class="sub">Accédez aux comptes de votre copropriété.</div>
      <div id="pwBox">
        <label for="loginEmail">Email</label><input id="loginEmail" type="email" placeholder="vous@exemple.be" autocomplete="username">
        <label for="loginPw">Mot de passe</label><input id="loginPw" type="password" placeholder="••••••" autocomplete="current-password">
        <button class="btn btn-primary" id="loginBtn">Se connecter</button>
        <div class="login-alt"><a id="toMagic">Recevoir un lien de connexion par email →</a></div>
      </div>
      <div id="magicBox" style="display:none">
        <label for="magicEmail">Email</label><input id="magicEmail" type="email" placeholder="vous@exemple.be" autocomplete="username">
        <button class="btn btn-primary" id="magicBtn">Envoyer le lien de connexion</button>
        <div class="login-alt"><a id="toPw">← Connexion par mot de passe</a></div>
      </div>
      <div class="login-msg" id="loginMsg" role="status"></div>
    </div>
  </div>
  <a class="login-credit" href="https://lagoffinerie.be" target="_blank" rel="noopener">Site développé par
    <svg viewBox="0 0 120 112" xmlns="http://www.w3.org/2000/svg" style="isolation:isolate" aria-hidden="true"><path d="M62 6 L102 80 L22 80 Z" fill="#EDAF2F" style="mix-blend-mode:multiply"/><rect x="12" y="48" width="58" height="58" rx="15" fill="#2823EE" style="mix-blend-mode:multiply"/><circle cx="90" cy="78" r="27" fill="#E2452C" style="mix-blend-mode:multiply"/></svg>
    <b>La Goffinerie</b></a>`;
  document.body.appendChild(ov);

  const bar=document.createElement('div'); bar.id='sessionBar';
  bar.innerHTML=`<span id="sbWho"></span><button id="logoutBtn">Déconnexion</button>`;
  document.body.appendChild(bar);

  const msg=ov.querySelector('#loginMsg');
  const setMsg=(t,cls)=>{ msg.textContent=t; msg.className='login-msg'+(cls?' '+cls:''); };
  ov.querySelector('#toMagic').onclick=()=>{ov.querySelector('#pwBox').style.display='none';ov.querySelector('#magicBox').style.display='block';setMsg('');};
  ov.querySelector('#toPw').onclick=()=>{ov.querySelector('#magicBox').style.display='none';ov.querySelector('#pwBox').style.display='block';setMsg('');};
  ov.querySelector('#loginBtn').onclick=async()=>{
    const email=ov.querySelector('#loginEmail').value.trim(), pw=ov.querySelector('#loginPw').value;
    if(!email||!pw){setMsg('Email et mot de passe requis.','err');return;}
    setMsg('Connexion…');
    try{ await window.LS.auth.signInPassword(email,pw); }
    catch(e){ setMsg('Échec : '+(e.message||e),'err'); }
  };
  ov.querySelector('#magicBtn').onclick=async()=>{
    const email=ov.querySelector('#magicEmail').value.trim();
    if(!email){setMsg('Email requis.','err');return;}
    setMsg('Envoi…');
    try{ await window.LS.auth.signInMagic(email); setMsg('Lien envoyé ! Vérifiez votre boîte mail.','ok'); }
    catch(e){ setMsg('Échec : '+(e.message||e),'err'); }
  };
  ov.querySelector('#loginEmail').addEventListener('keydown',e=>{if(e.key==='Enter')ov.querySelector('#loginPw').focus();});
  ov.querySelector('#loginPw').addEventListener('keydown',e=>{if(e.key==='Enter')ov.querySelector('#loginBtn').click();});
  bar.querySelector('#logoutBtn').onclick=async()=>{ await window.LS.auth.signOut(); location.reload(); };
}

async function boot(){
  // Pas d'identifiants Supabase (dev local pur) : mode démo, on déverrouille.
  if (!CONFIGURED){ unlockApp(); renderAll(); return; }

  buildLogin();
  const ov=document.getElementById('loginOverlay'), bar=document.getElementById('sessionBar');
  ov.classList.add('on');            // l'app reste verrouillée (ls-locked) tant qu'on n'est pas membre

  // Configuré mais la lib Supabase n'a pas chargé → on reste verrouillé, message clair.
  if (!ONLINE){
    ov.querySelector('#pwBox').style.display='none';
    ov.querySelector('#magicBox').style.display='none';
    ov.querySelector('#loginMsg').textContent='Service de connexion indisponible. Vérifiez votre connexion et rechargez la page.';
    ov.querySelector('#loginMsg').className='login-msg err';
    return;
  }

  // réagit aux connexions / déconnexions
  let bootedFor = null;   // id utilisateur déjà chargé (évite un rechargement complet sur refresh token)
  window.LS.auth.onChange(async (s)=>{
    if (s){
      if (bootedFor === s.user.id) return;   // déjà chargé pour cet utilisateur (TOKEN_REFRESHED, focus…)
      // On lance le chargement des données EN PARALLÈLE du profil membre
      // (la RLS protège : un non-membre récupère 0 ligne, jeté ensuite).
      const dataP = demoMode ? Promise.resolve(undefined)
                  : window.LS.db.loadAll().catch(e=>{ console.error(e); return undefined; });
      let member=null;
      try { member = await window.LS.db.loadMember(s.user); } catch(e){ console.error(e); }
      window.LS.member = member;
      window.LS.canWrite = !!(member && member.role==='admin');
      if (!member){
        // session valide mais pas membre LazySyndic → on déconnecte et on garde verrouillé
        lockApp(); bar.classList.remove('on'); ov.classList.add('on');
        ov.querySelector('#loginMsg').textContent='Ce compte n\'a pas accès à LazySyndic.';
        ov.querySelector('#loginMsg').className='login-msg err';
        await window.LS.auth.signOut();
        return;
      }
      bootedFor = s.user.id;
      // le mode démo est réservé à l'admin réel
      if (demoMode && member.role!=='admin'){ demoMode=false; localStorage.removeItem(DEMO_FLAG); }
      const demoTag = demoMode ? ' · <b style="color:var(--clay)">🧪 Démo</b>' : '';
      bar.querySelector('#sbWho').innerHTML = `${member.full_name||member.userEmail} ${member.role==='admin'?'· <b>Syndic</b>':'· <span class="ro">Lecture seule</span>'}${demoTag}`;
      await bootData(await dataP);   // données déjà préchargées en parallèle
      ov.classList.remove('on');
      bar.classList.add('on');
      unlockApp();               // l'app n'apparaît qu'ici, membre confirmé + données chargées
    } else {
      // déconnecté : on reverrouille et on remet le login
      bootedFor = null;
      lockApp(); bar.classList.remove('on'); ov.classList.add('on');
    }
  });
}
// Différé : hors-ligne, boot() rend tout de suite, et renderAll lit des `let` déclarés plus bas
// (bfrMonths, cfScope…) — encore en zone morte si on l'appelle avant la fin du script.
setTimeout(boot, 0);

/* ============================================================
   GÉNÉRATEUR DE RAPPORTS (PDF via impression navigateur)
   Tout est dérivé du store, filtré sur la période choisie.
   ============================================================ */
// Période par défaut des rapports : l'exercice précédent tant que l'AG de l'année n'est pas
// finalisée (c'est lui que l'AG approuve), l'année en cours ensuite. Posée dans les champs dès
// qu'ils sont vides ; l'utilisateur peut toujours les changer.
function reportDefaultYear(){
  const Y=new Date().getFullYear();
  let done=false;
  try { done=(state.ags||[]).some(a=>a.status==='finalisee' && (parseFrDate(a.ag_date)||new Date(0)).getFullYear()===Y); } catch(e){}
  return done ? Y : Y-1;
}
function fillReportPeriod(){
  const f=document.getElementById('repFrom'), t=document.getElementById('repTo'); if(!f||!t) return;
  if (!f.value.trim() && !t.value.trim()){ const y=reportDefaultYear(); f.value=`01/01/${y}`; t.value=`31/12/${y}`; }
}
(function setupReports(){
  // Identité de la copropriété, lue dans l'état (Supabase) au moment du rapport.
  const COPRO = () => ({
    name: (typeof state!=='undefined' && state.coproName) || 'Ma copropriété',
    addr: (typeof state!=='undefined' && state.coproAddr) || '',
    kbo:  (typeof state!=='undefined' && state.coproKbo)  || '',
  });

  /* ---- CSS rapport + impression ---- */
  const css = document.createElement('style');
  css.textContent = `
    #reportModal{display:none;position:fixed;inset:0;background:rgba(33,40,30,.5);z-index:100;overflow:auto;padding:28px 16px}
    #reportModal.open{display:block}
    .report-toolbar{max-width:820px;margin:0 auto 14px;display:flex;gap:10px;justify-content:flex-end;align-items:center}
    .report-toolbar .rt-title{margin-right:auto;color:#EAF1E8;font-family:var(--display);font-size:16px}
  `;
  document.head.appendChild(css);

  /* ---- modal ---- */
  const modal = document.createElement('div');
  modal.id = 'reportModal';
  modal.innerHTML = `
    <div class="report-toolbar">
      <span class="rt-title" id="rtTitle">Rapport</span>
      <button class="btn btn-ghost" id="reportClose">Fermer</button>
      <button class="btn btn-primary" id="reportPrint">⬇ Imprimer / Enregistrer en PDF</button>
    </div>
    <div id="reportSheet" class="report-sheet"></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#reportClose').onclick = closeReport;
  modal.querySelector('#reportPrint').onclick = ()=>window.print();
  modal.addEventListener('click', e=>{ if(e.target===modal) closeReport(); });
  function closeReport(){ modal.classList.remove('open'); document.body.classList.remove('report-open'); }

  /* ---- données ---- */
  const isoOf = disp => { const d=parseDate(disp); return d?d.iso:''; };
  function defaultPeriod(){
    fillReportPeriod();
    const y = reportDefaultYear();
    const f = document.getElementById('repFrom'), t = document.getElementById('repTo');
    const fd = parseDate(f?f.value:'') || parseDate(`01/01/${y}`);
    const td = parseDate(t?t.value:'') || parseDate(`31/12/${y}`);
    return { fromIso:fd.iso, toIso:td.iso, label:`${fd.disp} → ${td.disp}` };
  }
  function periodForYear(y){ const fd=parseDate(`01/01/${y}`), td=parseDate(`31/12/${y}`); return {fromIso:fd.iso, toIso:td.iso, label:`01/01/${y} → 31/12/${y}`}; }
  const inPeriod = (t, p) => { const i=isoOf(t.date); return i && i>=p.fromIso && i<=p.toIso; };
  function openingAt(acct, fromIso){
    return (state.opening[acct]||0) + sum(state.tx.filter(t=>t.account===acct && isoOf(t.date) && isoOf(t.date)<fromIso).map(t=>t.amount));
  }
  function acctSummary(acct, p){
    const opening = openingAt(acct, p.fromIso);
    const tx = state.tx.filter(t=>t.account===acct && inPeriod(t,p))
                       .sort((a,b)=>isoOf(a.date).localeCompare(isoOf(b.date)));
    const rec = sum(tx.filter(t=>t.amount>0).map(t=>t.amount));
    const dep = sum(tx.filter(t=>t.amount<0).map(t=>-t.amount));
    return { opening, rec, dep, closing:opening+rec-dep, tx };
  }
  function catBreakdown(txList){
    const by = {};
    txList.forEach(t=>{ const k=t.high==='?'?'À catégoriser':t.high; by[k]=by[k]||{in:0,out:0}; if(t.amount>=0)by[k].in+=t.amount; else by[k].out+=-t.amount; });
    return by;
  }

  /* ---- sections HTML ---- */
  // En-tête et pied de tous les rapports : les composants du design system (pdf.js, pdf.css).
  function headEl(title, p, extra){
    const o = extra || {};
    return LSPdf.head({ title, chip:o.chip || title, copro:COPRO(), status:o.status,
      meta:[...(o.meta || []), ...(p && p.label && !o.noPeriod ? [{label:'Période', value:p.label}] : []), {label:'Édité le', value:LSPdf.fmt.dateLong(new Date())}] });
  }
  // Soldes par compte, sur les composants du design system (PDF_DESIGN.md) : une colonne qui engage.
  function soldesSection(accts, p){
    const F = LSPdf.fmt;
    const rows = accts.map(a=>{ const s = acctSummary(a.key, p);
      return [{html:`<b>${escH(a.label)}</b>`}, F.eur(s.opening), F.signed(s.rec), `−${F.eur(s.dep)}`, F.eur(s.closing)]; });
    return LSPdf.section('Soldes : ouverture et clôture', {sub:`Période ${p.label} · ouverture + recettes − dépenses = clôture`})
      + LSPdf.table({label:'Soldes par compte', rows,
          cols:[{label:'Compte'}, {label:'Ouverture', align:'right'}, {label:'Recettes', align:'right'}, {label:'Dépenses', align:'right'}, {label:'Clôture', align:'right', emph:true}]});
  }
  function resultatSection(txList, p, label){
    const by = catBreakdown(txList);
    const keys = Object.keys(by).sort((a,b)=>(by[b].in+by[b].out)-(by[a].in+by[a].out));
    const totIn = sum(keys.map(k=>by[k].in)), totOut = sum(keys.map(k=>by[k].out));
    const grand = totIn+totOut || 1;
    const rows = keys.map(k=>{
      const v = by[k], net = v.in - v.out, share = Math.round((v.in+v.out)/grand*100);
      return `<tr><td>${k}</td>
        <td class="num pos">${v.in?'+'+eur(v.in):'—'}</td>
        <td class="num neg">${v.out?'−'+eur(v.out):'—'}</td>
        <td class="num ${net>=0?'pos':'neg'}">${net>=0?'+':'−'}${eur(Math.abs(net))}</td>
        <td class="num">${share} %</td></tr>`;
    }).join('');
    const res = totIn-totOut;
    return `<h2>Compte de résultats${label?' — '+label:''}</h2>
      <table><tr><th>Catégorie</th><th class="num">Recettes</th><th class="num">Dépenses</th><th class="num">Net</th><th class="num">Part</th></tr>
        ${rows}
        <tr class="tot"><td>Total</td><td class="num pos">+${eur(totIn)}</td><td class="num neg">−${eur(totOut)}</td>
          <td class="num ${res>=0?'pos':'neg'}">${res>=0?'+':'−'}${eur(Math.abs(res))}</td><td class="num">100 %</td></tr>
      </table>
      <div class="r-sub" style="margin-top:8px">Résultat de l'exercice : <b class="${res>=0?'pos':'neg'}">${res>=0?'Excédent ':'Déficit '}${eur(Math.abs(res))}</b></div>`;
  }
  function ownersSection(){
    const led = ownerLedger(), ly = led.length ? led[0].year : '', qTot = sum(led.map(o=>+o.q||0))||1000;
    const sg = v => `${v<0?'−':''}${eur(Math.abs(v))}`;
    const rows = led.map(o=>`<tr><td>${o.n}</td><td class="num">${o.q}/${qTot}</td>
      <td class="num">${sg(o.report)}</td><td class="num">${eur(o.due)}</td><td class="num">${eur(o.verse)}</td>
      <td class="num ${o.solde<0?'neg':'pos'}">${sg(o.solde)}</td>
      <td>${o.solde<-0.005?'En retard':'À jour'}</td></tr>`).join('');
    const tRep=sum(led.map(o=>o.report)), tDue=sum(led.map(o=>o.due)), tVer=sum(led.map(o=>o.verse)), tSol=sum(led.map(o=>o.solde));
    return `<h2>Récapitulatif par copropriétaire — exercice ${ly}</h2>
      <table><tr><th>Copropriétaire</th><th class="num">Quotité</th><th class="num">Report</th><th class="num">Dû ${ly}</th><th class="num">Versé ${ly}</th><th class="num">Solde</th><th>Statut</th></tr>
        ${rows}
        <tr class="tot"><td>Total</td><td class="num">${qTot}/${qTot}</td><td class="num">${sg(tRep)}</td><td class="num">${eur(tDue)}</td><td class="num">${eur(tVer)}</td><td class="num">${sg(tSol)}</td><td></td></tr>
      </table>
      <div class="r-sub" style="margin-top:6px">Report = versements antérieurs à l'exercice, moins le dû des exercices déjà appliqués. Solde = report + versé − dû.</div>`;
  }
  // Mouvements d'un compte sur la période (annexes 2 et 3), sur LSPdf.table : en-tête répété à
  // chaque page, montant signé « − », total qui reste avec le tableau.
  function annexeTxSection(acct, p, title){
    const s = acctSummary(acct, p), F = LSPdf.fmt;
    const rows = s.tx.map(t=>[F.date(t.date), t.tiers, (t.high==='?'?'À catégoriser':t.high)+(t.sub?(' · '+t.sub):''), F.signed(t.amount), t.note||'']);
    return LSPdf.section(title, {sub:`Ouverture ${F.eur(s.opening)} · ${s.tx.length} mouvement${s.tx.length>1?'s':''} · clôture ${F.eur(s.closing)}`})
      + LSPdf.table({label:title, rows, cls:'pdf-dense', empty:'Aucune transaction sur la période.',
          cols:[{label:'Date', w:'78px'}, {label:'Tiers'}, {label:'Catégorie'}, {label:'Montant', align:'right', emph:true}, {label:'Communication'}],
          totals:[{label:`Total de la période`, cells:['', '', F.signed(s.rec - s.dep), '']}]});
  }
  // Annexe 4 = le budget du module « Calcul des charges » dès qu'il a des postes pour l'exercice
  // affiché ; sinon, l'ancienne estimation (toutes les dépenses + 4 %).
  // Annexe 4 : mise en page du modèle pur (LSCharges.annexModel) avec les composants du design
  // system (LSPdf). Trois parties qui se lisent de la même façon : 1 · fonds de roulement,
  // 2 · fonds de réserve, chacun avec la part de chaque copropriétaire, 3 · total par copropriétaire.
  // Aucun montant n'est calculé ici : tout vient du modèle.
  function chargesAnnex(cy, postes, ow){
    const bud=chargesBudget(cy);
    const m=LSCharges.annexModel(bud, budgetSplit(cy), ow.map(o=>({n:o.n, short:o.short, q:+o.q||0})), cy);
    const F=LSPdf.fmt, money=v=>v==null?'—':F.eur(v), ref=m.ref, cov=m.cov;
    const delta=d=>d==null?{text:'—'}:{text:F.signed(d), neg:d<-0.005};
    const keyLabel=k=>k==='indiv'?`Individuelle (÷ ${m.n})`:'Millièmes';
    const ownerCols=m.owners.map(o=>({label:o.short, sub:`${o.q} / ${m.qTot}`, align:'right'}));
    const wide=m.owners.length<=4;   // au-delà de 4 copropriétaires, la part de chacun passe dans un tableau à part
    const dense=wide?' pdf-dense':'';
    const poste=r=>({text:r.label, sub:[r.vendor, r.note].filter(Boolean).join(' · ')});
    // synthèse
    const summary=LSPdf.summary([
      {label:`Fonds de roulement ${cy}`, value:F.eur(m.summary.roulement), sub:'charges courantes · compte de paiement'},
      {label:`Fonds de réserve ${cy}`, value:F.eur(m.summary.reserve), sub:'appels de l’année · compte de réserve'},
      {label:`Total annuel ${cy}`, value:F.eur(m.summary.total), sub:'les deux fonds, toutes quotités', emph:true},
      {label:'Mensualité indicative', value:F.eur(m.summary.monthly), sub:'total annuel ÷ 12'},
    ]);
    // 1 · fonds de roulement
    const colsA=[{label:'Poste'}, {label:'Clé'}, {label:`Estimé ${ref}`, align:'right'}, {label:`Réel ${ref}`, align:'right'}, {label:'Delta', align:'right'}, {label:`Budget ${cy}`, align:'right', emph:true}, ...(wide?ownerCols:[])];
    const rowA=r=>[poste(r), keyLabel(r.key), money(r.est), money(r.real), delta(r.delta), {text:F.eur(r.budget), emph:true}, ...(wide?r.shares.map(F.eur):[])];
    const tA=m.roulement.totals;
    const tableA=LSPdf.table({cols:colsA, cls:'pdf-roulement'+dense, label:`Fonds de roulement ${cy}`, empty:'Aucun poste de charges courantes.',
      groups:m.roulement.groups.map(g=>({label:g.label||'Sans catégorie', rows:g.rows.map(rowA)})),
      totals:[{label:`Total fonds de roulement ${cy}`, cells:['', money(tA.est), money(tA.real), delta(tA.delta), {text:F.eur(tA.budget), emph:true}, ...(wide?tA.shares.map(F.eur):[])]},
              {label:'Mensualité (÷ 12)', kind:'sub', cells:['', '', '', '', F.eur(tA.monthly), ...(wide?tA.sharesMonthly.map(F.eur):[])]}]});
    const sharesA=wide?'':LSPdf.table({cols:[{label:'Poste'}, {label:`Budget ${cy}`, align:'right', emph:true}, ...ownerCols], cls:'pdf-dense', label:`Part de chaque copropriétaire — fonds de roulement ${cy}`,
      groups:m.roulement.groups.map(g=>({label:g.label||'Sans catégorie', rows:g.rows.map(r=>[r.label, {text:F.eur(r.budget), emph:true}, ...r.shares.map(F.eur)])})),
      totals:[{label:`Total fonds de roulement ${cy}`, cells:[{text:F.eur(tA.budget), emph:true}, ...tA.shares.map(F.eur)]}, {label:'Mensualité (÷ 12)', kind:'sub', cells:[F.eur(tA.monthly), ...tA.sharesMonthly.map(F.eur)]}]});
    const covNote=!cov.months ? `Pas de relevé en ${ref} : aucun réel.` : `Réel ${ref} du compte de paiement${cov.months<12?` à ce jour, ${F.months(cov.from, cov.to, ref)} ramenés à 12 mois`:' sur l’année complète'}.`;
    const part1=LSPdf.section(`Fonds de roulement — charges courantes ${cy}`, {n:1, chip:'Compte de paiement', sub:`${covNote} « Estimé ${ref} » = budget ${ref} ; delta = estimé − réel, en rouge quand le budget est dépassé. Budget ${cy} = réel × (1 + ${F.pct(m.marge)} de marge), sauf mention sous le poste.`})
      + tableA + (sharesA ? `<p class="pdf-sub" style="margin-top:12px">Part de chaque copropriétaire, poste par poste :</p>` + sharesA : '');
    // 2 · fonds de réserve
    const L=m.reserve.legal, tB=m.reserve.totals;
    const legalRow=[{text:L.label, sub:L.covered?`couvert : les autres postes appellent déjà plus que le minimum (${m.owners.map((o,i)=>`${o.short} ${F.eur(L.mins[i])}`).join(' · ')})`:`complète l’appel de chacun jusqu’à ${L.rate} % de ses charges courantes`},
      `${L.rate} % des charges de chacun`, F.eur(L.amount), 'chaque année', {text:F.eur(L.call), emph:true}, ...(wide?L.shares.map(F.eur):[])];
    const rowB=r=>[{text:r.label}, keyLabel(r.key), F.eur(r.amount), `${r.months} mois${r.end?`, jusqu’en ${(ymLabel(r.end)||{}).m||''} ${(ymLabel(r.end)||{}).y||''}`:''}`, {text:F.eur(r.call), emph:true}, ...(wide?r.shares.map(F.eur):[])];
    const tableB=LSPdf.table({cols:[{label:'Poste'}, {label:'Clé'}, {label:'À constituer', align:'right'}, {label:'Durée'}, {label:`Appel ${cy}`, align:'right', emph:true}, ...(wide?ownerCols:[])], cls:'pdf-reserve'+dense, label:`Fonds de réserve ${cy}`,
      groups:[{label:'Ligne automatique', rows:[legalRow]}, {label:m.reserve.rows.length?'Postes à constituer':'', rows:m.reserve.rows.map(rowB)}],
      totals:[{label:`Total fonds de réserve ${cy}`, cells:['', F.eur(tB.amount), '', {text:F.eur(tB.call), emph:true}, ...(wide?tB.shares.map(F.eur):[])]},
              {label:'Mensualité (÷ 12)', kind:'sub', cells:['', '', '', F.eur(tB.monthly), ...(wide?tB.sharesMonthly.map(F.eur):[])]}]});
    const sharesB=wide?'':LSPdf.table({cols:[{label:'Poste'}, {label:`Appel ${cy}`, align:'right', emph:true}, ...ownerCols], cls:'pdf-dense', label:`Part de chaque copropriétaire — fonds de réserve ${cy}`,
      rows:[[L.label, {text:F.eur(L.call), emph:true}, ...L.shares.map(F.eur)], ...m.reserve.rows.map(r=>[r.label, {text:F.eur(r.call), emph:true}, ...r.shares.map(F.eur)])],
      totals:[{label:`Total fonds de réserve ${cy}`, cells:[{text:F.eur(tB.call), emph:true}, ...tB.shares.map(F.eur)]}, {label:'Mensualité (÷ 12)', kind:'sub', cells:[F.eur(tB.monthly), ...tB.sharesMonthly.map(F.eur)]}]});
    const part2=LSPdf.section(`Fonds de réserve — appels ${cy}`, {n:2, chip:'Compte de réserve', sub:`Chaque poste se constitue sur une durée en mois à partir de janvier ${cy} ; appel de l’année = montant ÷ durée × mois couverts en ${cy}. La contribution minimum légale complète l’appel de chacun jusqu’à ${L.rate} % de ses charges communes ordinaires de l’exercice précédent${L.basis==='real'?` (réel ${m.ref} ramené à 12 mois${L.base!=null?`, ${F.eur(L.base)} en tout`:''})`:`, calculées ici sur la prévision ${cy} faute de réel ${m.ref}`}.`})
      + tableB + (sharesB ? `<p class="pdf-sub" style="margin-top:12px">Part de chaque copropriétaire, poste par poste :</p>` + sharesB : '');
    // 3 · total par copropriétaire
    const tC=m.recap.totals;
    const tableC=LSPdf.table({cols:[{label:'Copropriétaire'}, {label:'Quotité', align:'right'}, {label:'Roulement', sub:'par an', align:'right'}, {label:'Roulement', sub:'par mois', align:'right'}, {label:'Réserve', sub:'par an', align:'right'}, {label:'Réserve', sub:'par mois', align:'right'}, {label:`Total ${cy}`, sub:'par an', align:'right'}, {label:'Mensualité', sub:'conseillée', align:'right', emph:true}], cls:'pdf-recap pdf-dense', label:`Total ${cy} par copropriétaire`,
      rows:m.recap.rows.map(r=>[r.name, F.int(r.q), F.eur(r.annual), F.eur(r.monthly), F.eur(r.resAnnual), F.eur(r.resMonthly), F.eur(r.total), {text:F.eur(r.totalMonthly), emph:true}]),
      totals:[{label:'Total', cells:[F.int(tC.q), F.eur(tC.annual), F.eur(tC.monthly), F.eur(tC.resAnnual), F.eur(tC.resMonthly), F.eur(tC.total), {text:F.eur(tC.totalMonthly), emph:true}]}]});
    const part3=LSPdf.section(`Total ${cy} par copropriétaire`, {n:3, sub:`Ce que chaque copropriétaire verse en ${cy}, fonds de roulement et fonds de réserve additionnés. La mensualité est le montant du virement permanent conseillé.`}) + tableC;
    const legal=LSPdf.legal([
      `Clés de répartition : « Millièmes » au prorata des quotités de l’acte de base (${F.int(m.qTot)} millièmes) ; « Individuelle » à parts égales entre les ${m.n} copropriétaires. Les parts sont calculées au centime, le dernier centime revenant au premier copropriétaire de la liste.`,
      `Fonds de réserve : la contribution annuelle ne peut être inférieure à ${L.rate} % de la totalité des charges communes ordinaires de l’exercice précédent (art. 3.86, § 3, du Code civil), sauf décision contraire de l’assemblée générale à la majorité des quatre cinquièmes${L.basis==='real'?'':` ; en l’absence de réel ${m.ref}, la base retenue ici est la prévision ${cy}`}. ${bud.approved?`Budget approuvé par l’assemblée générale du ${F.dateLong(bud.approved.date)}.`:'Le budget est soumis à l’approbation de l’assemblée générale.'}`,
    ]);
    return `<h2 class="pdf-h2" style="margin-top:18px"><span class="pdf-h2-t">Annexe 4 — Budget prévisionnel ${cy}</span>${m.draft?LSPdf.badge('draft','Brouillon'):''}</h2>
      <p class="pdf-sub">${m.draft?'Brouillon non publié aux copropriétaires. ':''}Deux fonds, deux comptes : le <b>fonds de roulement</b> paie les charges courantes de l’année depuis le compte de paiement ; le <b>fonds de réserve</b> constitue les travaux et imprévus sur le compte de réserve. Chaque partie donne la part de chaque copropriétaire selon sa clé.</p>
      ${summary}${part1}${part2}${part3}${legal}`;
  }
  // Annexe 4 du rapport : le budget de l'exercice demandé (celui qui suit la période du rapport
  // d'AG, ou l'exercice affiché dans l'onglet Charges). Sans budget préparé, le document le dit ;
  // plus de repli calculé « toutes les dépenses + 4 % » qui ignorait comptes, réserve et marge.
  function budgetSection(cy){
    const ow=ownersOf(), cb=chargesBudget(cy);
    if ((cb.postes.length || cb.reserve.length) && (budgetPublished(cb) || canWrite())) return chargesAnnex(cy, cb.postes, ow);
    const all=state.charges||{};
    const others=Object.keys(all).filter(y=>/^\d{4}$/.test(y) && y!==String(cy) && ((all[y]||{}).postes||[]).length && (budgetPublished(all[y])||canWrite())).sort();
    return `<h2 class="pdf-h2" style="margin-top:18px"><span class="pdf-h2-t">Annexe 4 — Budget prévisionnel ${cy}</span></h2>`
      + LSPdf.note(`Aucun budget prévisionnel ${cy} n'est ${canWrite()?'préparé':'publié'}. Le budget se prépare dans Budget & copropriétaires › Calcul des charges ; l'Annexe 4 le reprend dès qu'il a des postes.${others.length?` Budgets existants : ${others.join(', ')}.`:''}`, {kind:'info', title:'Annexe 4 absente.'});
  }
  function chronoSection(p){
    const evs=(state.timeline||[]).filter(e=>{ const d=e.date||''; return d>=p.fromIso && d<=p.toIso; })
      .sort((a,b)=>(a.date||'').localeCompare(b.date||''));   // ordre chronologique (récit de l'année)
    if(!evs.length) return '';
    const rows=evs.map(e=>{
      const subs=Array.isArray(e.subs)?e.subs:[];
      const subHtml = subs.length ? `<ol class="r-sub" style="margin:4px 0 0 18px;padding:0">${subs.map(s=>`<li>${s.title||''}${s.done?' ✓':''}</li>`).join('')}</ol>` : '';
      return `<tr><td style="white-space:nowrap;vertical-align:top">${fmtDateLong(e.date)}</td>
      <td><b>${e.title}</b>${e.description?`<div class="r-sub">${e.description}</div>`:''}${subHtml}</td></tr>`;
    }).join('');
    return `<h2>Chronologie de l'exercice</h2>
      <table><tr><th style="width:160px">Date</th><th>Événement</th></tr>${rows}</table>`;
  }
  function signatures(){
    return `<div class="sig">
      <div>Le président de séance</div><div>Le secrétaire</div><div>Le commissaire aux comptes</div>
    </div>`;
  }
  function foot(note){ return LSPdf.foot({ copro:COPRO(), note:note === undefined ? 'Les annexes 2, 3 et 4 sont calculées depuis le registre des transactions sur la période indiquée.' : note }); }

  /* ---- assemblage par type ---- */
  const PAY = {key:'pay', label:'Compte de paiement'};
  const RES = {key:'res', label:'Compte de réserve'};
  function buildReport(kind, p){
    let title, body='';
    if (kind==='ag'){
      title = "Rapport financier d'assemblée générale";
      const allTx = state.tx.filter(t=>inPeriod(t,p));
      body = headEl(title,p)
        + soldesSection([PAY,RES],p)
        + resultatSection(allTx,p,'')
        + ownersSection()
        + chronoSection(p)
        + annexeTxSection('pay',p,'Annexe 2 — Transactions du compte de paiement')
        + annexeTxSection('res',p,'Annexe 3 — Transactions du compte de réserve')
        + budgetSection(Number(p.toIso.slice(0,4))+1)
        + signatures() + foot();
    } else if (kind==='pay'){
      title = 'Rapport — Compte de paiement';
      body = headEl(title,p) + soldesSection([PAY],p)
        + annexeTxSection('pay',p,'Détail des mouvements') + foot();
    } else if (kind==='res'){
      title = 'Compte de résultats';
      const tx = state.tx.filter(t=>inPeriod(t,p));
      body = headEl(title,p) + resultatSection(tx,p,'tous comptes')
        + soldesSection([PAY,RES],p) + foot();
    } else if (kind==='budget'){
      const cy=chargesYear(), bud=chargesBudget(cy), draft=!budgetPublished(bud), cov=bud.cov||{months:0};
      title = `Budget prévisionnel ${cy}`;
      const status = draft ? {kind:'draft', label:'Brouillon'} : bud.approved ? {kind:'ok', label:`Approuvé par l'AG du ${LSPdf.fmt.date(bud.approved.date)}`} : {kind:'ok', label:bud.publishedAt ? `Publié le ${LSPdf.fmt.date(bud.publishedAt)}` : 'Publié'};
      const meta = [{label:'Exercice budgétaire', value:String(cy)},
        cov.months ? {label:'Réel de référence', value:LSPdf.fmt.months(cov.from, cov.to, cy-1)} : {label:'Réel de référence', value:`aucun relevé en ${cy-1}`},
        {label:'Marge appliquée', value:LSPdf.fmt.pct(bud.marge)}];
      body = LSPdf.document({ head: headEl(title, p, {chip:'Annexe 4 · Budget prévisionnel', status, meta, noPeriod:true}), body: budgetSection(cy),
        foot: foot(`Budget prévisionnel ${cy} · Annexe 4${draft?' · brouillon':''}`) });
      return {title, body, docTitle:`LazySyndic – ${COPRO().name} – Budget prévisionnel ${cy}`};
    }
    return {title, body};
  }
  function openReport(kind, p){
    p = p || defaultPeriod();
    const {title, body, docTitle} = buildReport(kind, p);
    document.getElementById('reportSheet').innerHTML = body;
    document.getElementById('rtTitle').textContent = title;
    document.title = docTitle || `LazySyndic — ${title} — ${p.label}`;   // le nom du fichier PDF enregistré
    modal.classList.add('open');
    document.body.classList.add('report-open');
    modal.scrollTop = 0;
  }
  window.LazySyndic.openReport = openReport; // debug
  // Clôture d'exercice : construire le rapport financier d'une année (archivé à la clôture) et
  // réafficher un rapport archivé tel quel.
  window.LSReports = { build:buildReport, periodForYear,
    show(title, body, docTitle){
      document.getElementById('reportSheet').innerHTML = body;
      document.getElementById('rtTitle').textContent = title;
      document.title = docTitle || `LazySyndic — ${title}`;
      modal.classList.add('open'); document.body.classList.add('report-open'); modal.scrollTop = 0;
    } };

  /* ---- câblage des boutons ---- */
  document.getElementById('repPay')?.addEventListener('click', ()=>openReport('pay'));
  document.getElementById('repRes')?.addEventListener('click', ()=>openReport('res'));
  document.getElementById('repAG')?.addEventListener('click', ()=>openReport('ag'));
  document.getElementById('genBudget')?.addEventListener('click', ()=>openReport('budget'));
  document.querySelectorAll('.ag-annexes').forEach(b=>b.addEventListener('click', ()=>openReport('ag', periodForYear(b.dataset.year))));
})();

/* ============================================================
   RELEVÉ DE COMPTE (PDF) — pour l'AG, à envoyer aux copropriétaires
   statement.js calcule et dessine le PDF. Ici : le choix des comptes et de la
   période, l'aperçu des soldes, le téléchargement, et pour le syndic un brouillon
   d'e-mail (.eml) adressé aux copropriétaires avec le PDF en pièce jointe.
   La période est celle du champ « Rapports — période » de l'écran Comptes : les
   deux restent alignés, un relevé et un rapport d'AG parlent de la même période.
   ============================================================ */
(function setupStatements(){
  const ACCTS = {pay:'Compte de paiement', res:'Compte de réserve'};
  const css = document.createElement('style');
  css.textContent = `
    #stmtModal{position:fixed;inset:0;background:oklch(.19 .024 166 / .55);z-index:120;display:none;align-items:center;justify-content:center;padding:16px}
    #stmtModal.open{display:flex}
    .st-card{width:640px;max-width:100%;max-height:92vh;overflow:auto;border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-lg)}
    .st-l{font-size:12px;color:var(--ink-faint);margin:16px 0 6px}
    .st-presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .st-chip{all:unset;box-sizing:border-box;cursor:pointer;border:1px solid var(--border);border-radius:999px;padding:5px 12px;font-size:12.5px;color:var(--ink)}
    .st-chip:hover{background:var(--accent)}
    .st-chip.on{background:var(--secondary);border-color:var(--primary);color:var(--primary);font-weight:600}
    .st-chip:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
    .st-dates{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .st-dates .fld{width:160px}
    .st-prev{margin-top:16px;border:1px solid var(--border);border-radius:var(--radius)}
    .st-acc{padding:12px 14px}
    .st-acc+.st-acc{border-top:1px solid var(--border)}
    .st-h{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
    .st-bal{font-weight:700;font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap}
    .st-meta{font-size:12.5px;color:var(--ink-faint);margin-top:3px;overflow-wrap:anywhere}
    .st-warn{font-size:12px;color:var(--warning-ink);margin-top:5px}
    .st-mail{font-size:12px;color:var(--ink-faint);margin-top:12px;overflow-wrap:anywhere}
    .st-bar{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px}
    #stmtModal .btn:disabled{opacity:.5;cursor:not-allowed}
    @media (max-width:560px){ .st-card{padding:18px} .st-bar .btn{flex:1 1 100%;justify-content:center} }`;
  document.head.appendChild(css);

  const modal = document.createElement('div');
  modal.id = 'stmtModal';
  modal.innerHTML = '<div class="card st-card" id="stmtCard" role="dialog" aria-modal="true" aria-labelledby="stTitle"></div>';
  document.body.appendChild(modal);
  const card = modal.querySelector('#stmtCard');
  modal.addEventListener('click', e=>{ if(e.target===modal) close(); });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape' && modal.classList.contains('open')) close(); });
  function close(){ modal.classList.remove('open'); }

  let sel = 'all', from = '', to = '', busy = false;
  const isoOf = s => (parseDate(s)||{}).iso || '';
  const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fr = iso => LSStatement.frDate(iso);
  const accts = () => sel==='all' ? ['pay','res'] : [sel];
  const valid = () => !!(from && to && from<=to);

  function lastAgIso(){
    const t = todayISO();
    return (state.ags||[]).map(a=>parseFrDate(a.ag_date)).filter(Boolean).map(isoLocal).filter(i=>i<=t).sort().pop() || '';
  }
  function presets(){
    const t = todayISO(), y = +t.slice(0,4), out = [];
    const ag = lastAgIso();
    if (ag) out.push({label:'Depuis la dernière AG', from:ag, to:t});
    out.push({label:`Année ${y} à ce jour`, from:`${y}-01-01`, to:t});
    out.push({label:`Exercice ${y-1}`, from:`${y-1}-01-01`, to:`${y-1}-12-31`});
    const first = state.tx.map(x=>isoOf(x.date)).filter(Boolean).sort()[0];
    out.push({label:'Tout l’historique', from:first||`${y}-01-01`, to:t});
    return out;
  }
  function dataFor(acct){
    return LSStatement.statementData({
      acct, label:ACCTS[acct], holder:acctHolder(acct).name, iban:(state.ibans||{})[acct]||'',
      opening:(state.opening||{})[acct]||0, asOf:isoOf(((state.recon||{})[acct]||{}).asOf),
      fromIso:from, toIso:to,
      tx: txOf(acct).map(t=>({iso:isoOf(t.date), tiers:t.tiers, note:t.note, high:t.high, sub:t.sub, comment:t.comment, amount:t.amount})),
    });
  }
  // mêmes destinataires que la convocation : les copropriétaires, sauf le syndic lui-même
  function recipients(){
    const m = (window.LS&&window.LS.member)||{};
    const me = String(m.userEmail||m.email||'').toLowerCase();
    const others = ownersOf().filter(o=>!(o.email && o.email.toLowerCase()===me) && o.n!==m.full_name);
    return { syndic:(m.full_name||'').trim()||'Le syndic', from:me,
             to: others.filter(o=>o.email).map(o=>o.email), missing: others.filter(o=>!o.email).map(o=>o.n) };
  }
  function syncReportPeriod(){
    const f = document.getElementById('repFrom'), t = document.getElementById('repTo');
    if (f && t && valid()){ f.value = fr(from); t.value = fr(to); }
  }

  function previewAcc(a){
    const h = acctHolder(a.acct), warn = [];
    if (h.src==='none') warn.push('Titulaire non renseigné : à compléter dans la fiche du compte.');
    if (h.src==='copro') warn.push('Titulaire : nom de la copropriété repris par défaut, à corriger dans la fiche du compte si la banque indique autre chose.');
    if (!a.iban) warn.push('IBAN non renseigné : à compléter dans la fiche du compte.');
    if (a.asOf && a.toIso>a.asOf) warn.push(`Dernier relevé bancaire importé arrêté au ${fr(a.asOf)} : les mouvements plus récents n’y figurent pas encore.`);
    if (a.undated) warn.push(`${a.undated} mouvement${a.undated>1?'s':''} sans date lisible ne ${a.undated>1?'seront':'sera'} pas repris.`);
    const n = a.rows.length;
    return `<div class="st-acc">
      <div class="st-h"><b>${a.label}</b><span class="st-bal">${eur(a.closing)}</span></div>
      <div class="st-meta">Solde disponible au ${fr(a.toIso)} · ${escH(a.holder||'titulaire non renseigné')}${a.iban?' · '+escH(LSStatement.fmtIban(a.iban)):''}</div>
      <div class="st-meta">Solde au ${fr(a.fromIso)} : ${eur(a.opening)} · entrées +${eur(a.credits)} · sorties −${eur(a.debits)} · ${n} mouvement${n>1?'s':''}</div>
      ${warn.map(w=>`<div class="st-warn">${escH(w)}</div>`).join('')}
    </div>`;
  }
  function render(){
    const ok = valid(), admin = canWrite();
    const rec = recipients();
    const mailInfo = !admin ? '' : `<div class="st-mail">${rec.to.length
        ? `E-mail adressé à ${escH(rec.to.join(', '))}, relevé en pièce jointe.`
        : 'Aucune adresse e-mail de copropriétaire enregistrée : complétez les destinataires dans votre messagerie.'}${rec.missing.length
        ? ` Sans e-mail : ${escH(rec.missing.join(', '))} (à ajouter dans Budget &amp; copro › Copropriétaires &amp; lots).` : ''}</div>`;
    card.innerHTML = `
      <div class="h-row"><h2 id="stTitle">Relevé de compte (PDF)</h2><button class="lk" id="stClose" aria-label="Fermer" style="font-size:16px">✕</button></div>
      <div class="sub" style="margin:-6px 0 2px">À envoyer aux copropriétaires : pour chaque compte, la date d’extraction, le titulaire, l’IBAN, le solde disponible et toutes les transactions de la période.</div>
      <div class="st-l">Comptes</div>
      <div class="seg" id="stAcct">${[['all','Les deux comptes'],['pay',ACCTS.pay],['res',ACCTS.res]]
        .map(([k,l])=>`<button type="button" data-a="${k}" class="${sel===k?'on':''}" aria-pressed="${sel===k}">${l}</button>`).join('')}</div>
      <div class="st-l">Période</div>
      <div class="st-presets">${presets().map(p=>`<button type="button" class="st-chip${p.from===from&&p.to===to?' on':''}" data-f="${p.from}" data-t="${p.to}">${escH(p.label)}</button>`).join('')}</div>
      <div class="st-dates">
        <label class="sub" for="stFrom">Du</label><input class="fld" type="date" id="stFrom" value="${from}">
        <label class="sub" for="stTo">au</label><input class="fld" type="date" id="stTo" value="${to}">
      </div>
      ${ok ? `<div class="st-prev">${accts().map(a=>previewAcc(dataFor(a))).join('')}</div>`
           : '<div class="st-warn" style="margin-top:10px">Choisissez une date de début antérieure ou égale à la date de fin.</div>'}
      ${mailInfo}
      <div class="st-bar">
        <button class="btn btn-ghost" id="stCancel">Fermer</button>
        ${admin?`<button class="btn btn-ghost" id="stMail" ${ok?'':'disabled'}>Préparer l’e-mail aux copropriétaires</button>`:''}
        <button class="btn btn-primary" id="stDl" ${ok?'':'disabled'}>Télécharger le PDF</button>
      </div>`;
    card.querySelector('#stClose').onclick = close;
    card.querySelector('#stCancel').onclick = close;
    card.querySelectorAll('#stAcct button').forEach(b=>b.onclick=()=>{ sel=b.dataset.a; render(); });
    card.querySelectorAll('.st-chip').forEach(b=>b.onclick=()=>{ from=b.dataset.f; to=b.dataset.t; syncReportPeriod(); render(); });
    card.querySelector('#stFrom').onchange = e=>{ from=e.target.value; syncReportPeriod(); render(); };
    card.querySelector('#stTo').onchange = e=>{ to=e.target.value; syncReportPeriod(); render(); };
    card.querySelector('#stDl').onclick = ()=>run('pdf');
    card.querySelector('#stMail')?.addEventListener('click', ()=>run('mail'));
  }

  // Logo de marque en PNG pour le PDF (pdf-lib ne lit pas le SVG) ; partagé avec la convocation.
  const logoPng = () => brandLogoPng();
  function mailText(copro, accounts, extractedAt){
    const cn = copro.name, f = fr(from), t = fr(to), rec = recipients();
    const which = accounts.length>1 ? 'des comptes de paiement et de réserve'
      : (accounts[0].acct==='res' ? 'du compte de réserve' : 'du compte de paiement');
    const lines = accounts.map(a=>`    ${a.label} : ${eur(a.closing)}`);
    if (accounts.length>1) lines.push(`    Total : ${eur(Math.round(sum(accounts.map(a=>a.closing))*100)/100)}`);
    const day = new Date(extractedAt).toLocaleDateString('fr-BE', {day:'numeric', month:'long', year:'numeric'});
    return {
      subject: `Relevé de compte · ${cn} · du ${f} au ${t}`,
      body: `Madame, Monsieur, cher copropriétaire,

Vous trouverez en pièce jointe le relevé ${which} de ${cn} pour la période du ${f} au ${t}.

Solde disponible au ${t} :
${lines.join('\n')}

Le relevé reprend${accounts.length>1?', pour chaque compte,':''} le titulaire, l’IBAN et toutes les transactions de la période. Il a été extrait le ${day}.

Salutations distinguées,
${rec.syndic==='Le syndic' ? `Le syndic de ${cn}` : `${rec.syndic}, syndic de ${cn}`}
`};
  }
  async function run(kind){
    if (busy || !valid()) return;
    busy = true;
    const btn = card.querySelector(kind==='pdf' ? '#stDl' : '#stMail'), label = btn ? btn.textContent : '';
    if (btn){ btn.textContent = 'Génération…'; btn.disabled = true; }
    try {
      const accounts = accts().map(dataFor);
      const copro = { name:(state.coproName||'').trim()||'Ma copropriété', addr:state.coproAddr||'', kbo:state.coproKbo||'' };
      const extractedAt = new Date().toISOString();
      const bytes = await LSStatement.buildStatementPdf(await loadPdfLib(), {copro, extractedAt, accounts, logo:await logoPng()});
      const name = LSStatement.statementFileName({copro, accounts});
      if (kind==='pdf'){ saveBytes(bytes, name); showToast('Relevé téléchargé : '+name); }
      else {
        const rec = recipients(), m = mailText(copro, accounts, extractedAt);
        const eml = LSStatement.statementEml({fromName:rec.syndic, from:rec.from, to:rec.to, subject:m.subject, body:m.body, fileName:name, bytes});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([eml], {type:'message/rfc822'})); a.download = name.replace(/\.pdf$/, '.eml');
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
        showToast('Brouillon prêt, relevé joint : ouvrez le fichier .eml dans votre messagerie pour l’envoyer.');
      }
    } catch(e){ console.error(e); showToast('Relevé impossible à générer : '+(e.message||e), 'err'); }
    finally {
      busy = false;
      if (btn && card.contains(btn)){ btn.textContent = label; btn.disabled = false; }
    }
  }

  function open(acct){
    sel = ACCTS[acct] ? acct : 'all';
    const f = isoOf(document.getElementById('repFrom')?.value), t = isoOf(document.getElementById('repTo')?.value);
    if (f && t && f<=t){ from = f; to = t; }
    else { from = todayISO().slice(0,4)+'-01-01'; to = todayISO(); }
    render();
    modal.classList.add('open');
    card.scrollTop = 0;
    card.querySelector('#stDl')?.focus({preventScroll:true});
  }
  window.LazySyndic.openStatement = open;
  document.getElementById('repStmt')?.addEventListener('click', ()=>open());
})();

/* ============================================================
   SAUVEGARDE & RESTAURATION
   ============================================================ */
function downloadBlob(blob, name){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
}
async function exportBackup(){
  try{
    if(!ONLINE){ alert('Sauvegarde indisponible hors-ligne.'); return; }
    const data = await window.LS.db.dumpAll();
    const payload = { app:'LazySyndic', version:1, exported_at:new Date().toISOString(), data };
    downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),
      `lazysyndic-sauvegarde-${new Date().toISOString().slice(0,10)}.json`);
  }catch(e){ alert('Export impossible : '+(e.message||e)); }
}
function exportTransactionsCSV(){
  const head=['Date','Compte','Tiers','Catégorie','Sous-catégorie','Copropriétaire','Montant','Note','Flag','Commentaire'];
  const rows=[head];
  state.tx.slice().sort((a,b)=>{const da=parseDate(a.date),db=parseDate(b.date);return (da?da.iso:'').localeCompare(db?db.iso:'');})
    .forEach(t=>rows.push([t.date, t.account==='res'?'réserve':'paiement', t.tiers, t.high, t.sub||'',
      ownerOfTx(t), String(t.amount).replace('.',','), t.note||'', isFlagged(t)?'oui':'', t.comment||'']));
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  downloadBlob(new Blob(['﻿'+csv],{type:'text/csv'}), `lazysyndic-transactions-${new Date().toISOString().slice(0,10)}.csv`);
}
async function restoreBackup(file){
  if(!canWrite()){ alert('Lecture seule : seul le syndic peut restaurer.'); return; }
  let parsed; try{ parsed=JSON.parse(await file.text()); }catch(e){ alert('Fichier de sauvegarde illisible.'); return; }
  const data = parsed.data || parsed;
  if(!data.ls_transactions && !data.ls_owners){ alert('Ce fichier ne ressemble pas à une sauvegarde LazySyndic.'); return; }
  const n=(data.ls_transactions||[]).length, o=(data.ls_owners||[]).length;
  if(!confirm(`Restaurer cette sauvegarde ?\n\nCela REMPLACE toutes les données actuelles par celles du fichier (${o} propriétaire(s), ${n} transaction(s)).\nAction irréversible.`)) return;
  try{ await window.LS.db.restore(data); alert('✓ Sauvegarde restaurée.'); location.reload(); }
  catch(e){ alert('Restauration échouée : '+(e.message||e)); }
}
let restoreInput;
document.getElementById('exportBackup')?.addEventListener('click', exportBackup);
document.getElementById('exportCsv')?.addEventListener('click', exportTransactionsCSV);
document.getElementById('restoreBtn')?.addEventListener('click', ()=>{
  if(!canWrite()){ alert('Lecture seule.'); return; }
  if(!restoreInput){ restoreInput=document.createElement('input'); restoreInput.type='file'; restoreInput.accept='.json,application/json'; restoreInput.style.display='none';
    restoreInput.onchange=e=>{ if(e.target.files[0]) restoreBackup(e.target.files[0]); restoreInput.value=''; };
    document.body.appendChild(restoreInput); }
  restoreInput.click();
});

/* ============================================================
   NAVIGATION MOBILE (barre + tiroir)
   ============================================================ */
(function setupMobileNav(){
  if (document.getElementById('mobileBar')) return;
  const bar=document.createElement('div'); bar.id='mobileBar';
  bar.innerHTML=`<button class="burger" aria-label="Menu">☰</button>
    <span class="mbrand"><img src="brand/logo-white.svg" alt="LazySyndic" width="111" height="27"></span>
    <button class="mout" id="mobileLogout" title="Déconnexion">⎋</button>`;
  document.body.appendChild(bar);
  const back=document.createElement('div'); back.id='navBackdrop'; document.body.appendChild(back);
  const open=()=>{ document.body.classList.add('nav-open'); back.classList.add('on'); };
  const close=()=>{ document.body.classList.remove('nav-open'); back.classList.remove('on'); };
  bar.querySelector('.burger').onclick=()=>{ document.body.classList.contains('nav-open')?close():open(); };
  back.onclick=close;
  // refermer le tiroir quand on choisit un écran
  document.querySelectorAll('.nav button[data-s]').forEach(b=>b.addEventListener('click', close));
  // déconnexion mobile
  bar.querySelector('#mobileLogout').onclick=async()=>{
    if(window.LS && window.LS.auth){ try{ await window.LS.auth.signOut(); }catch(e){} }
    location.reload();
  };
})();

/* ============================================================
   VUE COPROPRIÉTAIRE — « Ma situation »
   Affichée pour l'utilisateur connecté lié à un copropriétaire.
   ============================================================ */
function renderMySituation(){
  const dash=document.getElementById('dash'); if(!dash) return;
  let box=document.getElementById('mySituation');
  if(!box){ box=document.createElement('div'); box.id='mySituation'; box.style.marginBottom='18px';
    const top=dash.querySelector('.top'); if(top) top.after(box); else dash.prepend(box); }
  const m=(window.LS&&window.LS.member)||null;
  const short=m&&m.owner_short;
  const led = short ? ownerLedger().find(o=>(o.short||o.n)===short) : null;
  if(!led){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='block';
  const late=led.solde<-0.005;
  const myTx=state.tx.filter(t=>t.amount>0 && ownerOfTx(t)===short)
    .sort((a,b)=>{const da=parseDate(a.date),db=parseDate(b.date);return (db?db.iso:'').localeCompare(da?da.iso:'');});
  const histo = myTx.length
    ? `<div class="mini-h" style="margin:16px 0 6px">Mes paiements (${myTx.length})</div>
       <div style="max-height:230px;overflow:auto"><table>
         <tr><th>Date</th><th>Compte</th><th>Libellé</th><th class="num">Montant</th></tr>
         ${myTx.slice(0,30).map(t=>`<tr><td>${t.date}</td><td>${t.account==='res'?'Réserve':'Paiement'}</td><td>${t.tiers}</td><td class="num pos">+${eur(t.amount)}</td></tr>`).join('')}
       </table></div>`
    : `<div class="sub" style="margin-top:12px">Aucun paiement enregistré pour le moment.</div>`;
  box.innerHTML=`<div class="card" style="border-left:5px solid ${led.c}">
    <div class="h-row"><div style="display:flex;align-items:center;gap:11px">
      <span class="a" style="width:34px;height:34px;background:${led.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:14px">${(led.short||led.n||'?')[0]}</span>
      <div><h2 style="margin:0">Ma situation — ${led.n}</h2><div class="sub">${led.q} millièmes${m.role!=='admin'?' · vue copropriétaire':''}</div></div></div>
      <span class="badge ${late?'b-late':'b-ok'}">${late?'En retard':'À jour'}</span></div>
    <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
      <div class="kpi"><div class="l">Dû ${led.year} (charges + réserve)</div><div class="v">${eur(led.due)}</div></div>
      <div class="kpi"><div class="l">Versé ${led.year}</div><div class="v" style="color:var(--green)">${eur(led.verse)}</div></div>
      <div class="kpi"><div class="l">Solde</div><div class="v" style="color:${late?'var(--coral)':'var(--green)'}">${led.solde<0?'−':''}${eur(Math.abs(led.solde))}</div></div>
    </div>
    ${Math.abs(led.report)>=0.005 ? `<div class="sub" style="margin-top:8px">Report des exercices précédents : ${led.report<0?'−':'+'}${eur(Math.abs(led.report))}</div>` : ''}
    ${typeof LSCalls!=='undefined' && led.due>0.005 ? (()=>{ const cm=fundCallModel(led, led.year); return `<div class="card" style="margin-top:14px;padding:12px 16px;background:var(--secondary);border-left:3px solid var(--clay)">
      <div class="mini-h" style="margin:0 0 6px">Pour vos virements</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 24px;font-size:13.5px">
        <span>${eur(cm.perPeriod)} <span class="sub">${cm.every}</span></span>
        ${cm.iban?`<span>IBAN <b style="font-variant-numeric:tabular-nums">${escH(LSCalls.fmtIban(cm.iban))}</b></span>`:''}
        ${cm.ogm?`<span>Communication <b style="font-variant-numeric:tabular-nums">${escH(cm.ogm)}</b></span>`:'<span class="sub">communication structurée à venir</span>'}
      </div>
      <div style="margin-top:8px"><button class="btn btn-ghost" id="myCallPdf" style="padding:4px 10px;font-size:12.5px">Mon appel de fonds ${led.year} (PDF)</button></div></div>`; })() : ''}
    ${histo}</div>`;
  box.querySelector('#myCallPdf')?.addEventListener('click', ()=>fundCallPdf([led], led.year).catch(e=>showToast(e.message||String(e),'err')));
}

/* ============================================================
   SUIVI DES CHARGES — « qui n'a pas payé »
   Matrice copropriétaire × mois + relance.
   ============================================================ */
function payMonths(){
  const ds=state.tx.filter(t=>t.account==='pay').map(t=>parseDate(t.date)).filter(Boolean);
  if(!ds.length) return [];
  const min=ds.reduce((a,b)=>a.iso<b.iso?a:b), max=ds.reduce((a,b)=>a.iso>b.iso?a:b);
  const out=[]; let y=min.y,m=min.m;
  while((y<max.y||(y===max.y&&m<=max.m)) && out.length<24){ out.push({y,m}); m++; if(m>12){m=1;y++;} }
  return out.slice(-6);
}
function paidInMonth(short, ym){
  return sum(state.tx.filter(t=>{ if(!(t.amount>0 && t.account==='pay' && ownerOfTx(t)===short)) return false;
    const d=parseDate(t.date); return d && d.y===ym.y && d.m===ym.m; }).map(t=>t.amount));
}
function renderPaymentTracking(){
  const dash=document.getElementById('dash'); if(!dash) return;
  let box=document.getElementById('payTracking');
  if(!box){ box=document.createElement('div'); box.id='payTracking'; box.style.marginTop='18px'; dash.appendChild(box); }
  const ow=ownersOf(), months=payMonths();
  if(!ow.length || !months.length){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='block';
  const MON=['Jan','Fév','Mar','Avr','Mai','Jun','Jui','Aoû','Sep','Oct','Nov','Déc'];
  const header='<tr><th>Copropriétaire</th><th class="num">Attendu</th>'
    + months.map(m=>`<th class="num">${MON[m.m-1]} ${String(m.y).slice(2)}</th>`).join('')+'</tr>';
  const per = o => typeof LSCalls!=='undefined' ? LSCalls.cleanPeriodicity(o.periodicity) : 'month';
  const expIn = (o, m) => typeof LSCalls!=='undefined' ? LSCalls.expectedInMonth(o.due_pay||0, per(o), m.y, m.m) : (o.due_pay||0)/12;
  const rows=ow.map(o=>{
    const short=o.short||o.n;
    const first = typeof LSCalls!=='undefined' ? (LSCalls.schedule(o.due_pay||0, per(o), new Date().getFullYear())[0]||{}).amount||0 : (o.due_pay||0)/12;
    const everyLbl = ({month:'/ mois', quarter:'/ trimestre', year:'/ an'})[per(o)];
    const cells=months.map(m=>{
      const paid=paidInMonth(short,m), exp=expIn(o, m); let inner;
      if(exp>0){ inner = paid>=exp*0.95 ? '<span class="badge b-ok">✓</span>'
        : paid>0 ? '<span class="badge" style="background:var(--clay-soft);color:var(--warning-ink)">partiel</span>'
        : '<span class="badge b-late">✗</span>'; }
      else inner = paid>0 ? eur(paid) : '—';
      return `<td class="num" title="${eur(paid)} versé en ${MON[m.m-1]}">${inner}</td>`;
    }).join('');
    return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${short[0]}</span> ${o.n}</div></td><td class="num">${first>0?`${eur(first)}<div class="chg-sub">${everyLbl}</div>`:'—'}</td>${cells}</tr>`;
  }).join('');
  const last=months[months.length-1];
  const late=ow.filter(o=>{ const exp=expIn(o, last); return exp>0 && paidInMonth(o.short||o.n,last) < exp*0.95; });
  const relance = late.length
    ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="sub">⚠ En retard sur ${MON[last.m-1]} ${String(last.y).slice(2)} :</span>`
      + late.map(o=>canWrite()
          ? `<button class="btn btn-ghost relance-btn" data-short="${o.short||o.n}" style="padding:6px 12px;font-size:13px">✉ Relancer ${o.short||o.n}</button>`
          : `<span class="badge b-late">${o.short||o.n}</span>`).join('')+'</div>'
    : '';
  const hint = ow.some(o=>o.due_pay>0) ? '' : ' · renseignez le dû dans Budget → Provisions pour détecter les retards';
  box.innerHTML=`<div class="card">
    <div class="h-row"><div><h2>Suivi des charges payées</h2><div class="sub">par copropriétaire · 6 derniers mois${hint}</div></div></div>
    <div style="overflow-x:auto"><table>${header}${rows}</table></div>
    ${relance}</div>`;
  box.querySelectorAll('.relance-btn').forEach(b=>b.onclick=()=>relanceOwner(b.dataset.short));
}
// Rappel de paiement : un brouillon .eml (X-Unsent) adressé au copropriétaire, aux couleurs du
// design comme la convocation, avec le détail de l'exercice et le compte de paiement à créditer ;
// tracé dans la chronologie. L'envoi reste le geste du syndic, depuis sa messagerie.
async function relanceOwner(short){
  const o=ownerLedger().find(x=>(x.short||x.n)===short); if(!o) return;
  const cn=(state.coproName||'').trim()||'la copropriété';
  const m=(window.LS&&window.LS.member)||{};
  const syndic=(m.full_name||'').trim()||'Le syndic';
  const syndicEmail=String(m.userEmail||m.email||'').trim();
  const to=String(o.email||'').trim();                       // ls_owners.email, comme la convocation et le relevé
  const iban=String((state.ibans||{}).pay||'').trim();
  const ibanTxt=iban && window.LSStatement ? LSStatement.fmtIban(iban) : iban;
  const sg=v=>`${v<0?'−':''}${eur(Math.abs(v))}`;
  const amount=eur(Math.abs(o.solde)), hasRep=Math.abs(o.report)>=0.005;
  const subject=`Rappel de paiement de charges · ${cn}`;
  const text=`Bonjour ${o.n},

Sauf erreur de notre part, votre compte présente un solde en attente de ${amount} au titre des charges de ${cn}, exercice ${o.year} : dû ${eur(o.due)}, versé ${eur(o.verse)}${hasRep?`, report des exercices précédents ${sg(o.report)}`:''}.

Merci de régulariser dès que possible${ibanTxt?` sur le compte de paiement de la copropriété, ${ibanTxt}`:''}. Si un versement a déjà été effectué, n'en tenez pas compte et n'hésitez pas à me le signaler.

Cordialement,
${syndic}, syndic de ${cn}
`;
  const T=LSConvocation.T, base="font-family:'Hanken Grotesk','Segoe UI',Helvetica,Arial,sans-serif;";
  const row=(l,v,b)=>`<tr><td style="${base}font-size:13px;line-height:20px;color:${T.muted};padding:4px 0">${escH(l)}</td><td align="right" style="${base}font-size:13px;line-height:20px;color:${T.ink};padding:4px 0${b?';font-weight:700':''}">${escH(v)}</td></tr>`;
  const html=`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bg}" style="background-color:${T.bg};margin:0;padding:0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.card}" style="width:560px;max-width:100%;background-color:${T.card};border:1px solid ${T.line};border-radius:10px">
<tr><td style="padding:18px 28px;border-bottom:1px solid ${T.line}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="width:34px;padding-right:10px"><img src="cid:logo@lazysyndic" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0;border-radius:8px"></td>
<td valign="middle" style="${base}font-size:17px;line-height:22px;color:${T.deep}"><span style="font-weight:800">Lazy</span><span style="font-weight:600">Syndic</span></td>
<td valign="middle" align="right" style="${base}font-size:12px;line-height:18px;color:${T.muted};white-space:nowrap">Rappel de paiement · ${escH(fmtDateLong(todayISO()))}</td></tr></table></td></tr>
<tr><td bgcolor="${T.primary}" style="background-color:${T.primary};padding:24px 28px">
<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.mint}">${escH(cn)} · exercice ${o.year}</div>
<div style="${base}font-size:26px;line-height:32px;font-weight:800;color:#FFFFFF;margin-top:6px">${escH(amount)} en attente</div></td></tr>
<tr><td style="padding:24px 28px 8px;${base}color:${T.ink}">
<p style="margin:0 0 14px;${base}font-size:15px;line-height:22px;font-weight:700;color:${T.ink}">Bonjour ${escH(o.n)},</p>
<p style="margin:0 0 14px;${base}font-size:14px;line-height:22px;color:${T.ink}">Sauf erreur de notre part, votre compte présente un solde en attente de <b>${escH(amount)}</b> au titre des charges de <b>${escH(cn)}</b>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${T.line};border-bottom:1px solid ${T.line};margin:0 0 14px">
${row(`Dû ${o.year} (charges et réserve)`, eur(o.due))}${row(`Versé ${o.year}`, eur(o.verse))}${hasRep?row('Report des exercices précédents', sg(o.report)):''}${row('Solde', sg(o.solde), true)}</table>
${ibanTxt?`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.secondary}" style="background-color:${T.secondary};border-radius:8px;margin:0 0 14px"><tr><td style="padding:12px 14px;border-left:3px solid ${T.clay}"><div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.deep}">Compte de paiement de la copropriété</div><div style="${base}font-size:16px;line-height:22px;font-weight:700;color:${T.ink};margin-top:3px">${escH(ibanTxt)}</div></td></tr></table>`:''}
<p style="margin:0 0 14px;${base}font-size:14px;line-height:22px;color:${T.ink}">Merci de régulariser dès que possible. Si un versement a déjà été effectué, n'en tenez pas compte et n'hésitez pas à me le signaler.</p>
<p style="margin:0 0 20px;${base}font-size:14px;line-height:22px;color:${T.ink}">Cordialement,<br><b>${escH(syndic)}</b>, syndic de ${escH(cn)}</p></td></tr>
<tr><td style="padding:12px 28px 16px;border-top:1px solid ${T.line};${base}font-size:11px;line-height:16px;color:${T.muted}">Message préparé avec LazySyndic.</td></tr>
</table></td></tr></table>`;
  const logo=await brandMarkPng();
  const eml=LSConvocation.eml({from:syndicEmail||undefined, fromName:syndic, to:to?[to]:[], subject, text, html, logo:logo?{bytes:logo, cid:'logo@lazysyndic'}:null});
  const blob=new Blob([eml],{type:'message/rfc822'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`rappel-${sansAccents(short).replace(/[^A-Za-z0-9_-]+/g,'_')}-${o.year}.eml`;
  document.body.appendChild(a); a.click(); a.remove();
  logTimeline({title:`Rappel de paiement préparé pour ${o.n}`, kind:'manual',
    description:`${amount} en attente, exercice ${o.year} (dû ${eur(o.due)}, versé ${eur(o.verse)}). Brouillon .eml ${to?`adressé à ${to}`:'sans destinataire : e-mail du copropriétaire à renseigner dans Copropriétaires & lots'}.`});
  showToast(to ? `Brouillon de rappel prêt pour ${o.n} (${to}) : il s'ouvre dans votre messagerie.` : `Brouillon prêt, sans destinataire : ${o.n} n'a pas d'e-mail dans Copropriétaires & lots.`, to?'':'err');
}

/* ============================================================
   COLLER depuis Swan : la liste copiée dans l'app (Description ·
   Méthode · Date · Montant, par mois) part droit à l'aperçu d'import.
   Lecture : parseSwanPaste (section IMPORT).
   ============================================================ */
document.getElementById('pasteImport')?.addEventListener('click', ()=>{
  const ta=document.getElementById('pasteArea'); const txt=(ta?.value||'').trim();
  const cnt=document.getElementById('pasteCount');
  if(!txt){ if(cnt) cnt.textContent='Colle d\'abord le texte.'; return; }
  const parsed=parseStatementText(txt);
  if(!parsed || !parsed.data || !parsed.data.length){ if(cnt) cnt.textContent='Aucune transaction reconnue dans ce texte.'; return; }
  if(cnt) cnt.textContent='';
  if(ta) ta.value='';
  document.getElementById('pasteTool')?.removeAttribute('open');
  loadStatement(parsed);
});

/* ============================================================
   DÉTAIL D'UNE TRANSACTION (clic) — communication complète
   ============================================================ */
// La fiche d'un mouvement : tout ce qui s'édite y vit (catégorie, attribution, drapeau,
// commentaire, scission, corbeille). Un exercice clôturé n'y laisse que le drapeau et le commentaire.
function showTxDetail(t){
  let m=document.getElementById('txDetailModal');
  if(!m){
    m=document.createElement('div'); m.id='txDetailModal'; m.setAttribute('role','dialog'); m.setAttribute('aria-modal','true'); m.setAttribute('aria-labelledby','txDetailTitle');
    m.style.cssText='position:fixed;inset:0;background:var(--shade,rgba(33,40,30,.45));z-index:120;display:none;align-items:center;justify-content:center;padding:20px';
    m.innerHTML='<div class="card" id="txDetailCard" style="width:480px;max-width:94vw;max-height:92vh;overflow:auto"></div>';
    m.addEventListener('click',e=>{ if(e.target===m) m.style.display='none'; });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && m.style.display==='flex') m.style.display='none'; });
    document.body.appendChild(m);
  }
  const ed=canWrite(), locked=txLocked(t), free=ed && !locked, reqMiss=commentMissing(t);
  const owner=ownerOfTx(t), ow=ownersOf().find(o=>(o.short||o.n)===owner);
  const line=(l,v)=>v?`<div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--line-2)"><span class="sub" style="flex:0 0 auto">${l}</span><span style="font-weight:600;text-align:right;min-width:0">${v}</span></div>`:'';
  const card=m.querySelector('#txDetailCard');
  card.innerHTML=`
    <div class="h-row"><h2 id="txDetailTitle" style="margin:0">Mouvement du ${t.date}</h2><button class="icon-btn" id="txDetailClose" type="button" aria-label="Fermer">✕</button></div>
    ${locked?`<div class="sub" style="margin:-4px 0 6px">Exercice ${closedYearOf((parseDate(t.date)||{}).iso)} clôturé : seuls le drapeau et le commentaire restent modifiables.</div>`:''}
    ${line('Compte', t.account==='res'?'Compte de réserve':'Compte de paiement')}
    ${line('Tiers', escH(t.tiers))}
    ${line('Montant', `<span class="${t.amount<0?'neg':'pos'}">${signed(t.amount)}</span>`)}
    ${line('Catégorie', free
      ? `<select class="fld txd-cat" aria-label="Catégorie" style="font-size:12.5px;padding:5px 8px;max-width:250px">${catPickOptions(t.high, t.sub)}</select>`
      : `<span class="cat ${catClass(t.high)}">${t.high==='?'?'À catégoriser':t.high}${t.sub?(' · '+t.sub):''}</span>`)}
    ${t.amount>0 ? line('Versé par', free ? `<select class="fld txd-owner" aria-label="Versé par" style="font-size:12.5px;padding:5px 8px">${ownerOptions(owner)}</select>` : escH(ow?ow.n:(owner||'—'))) : ''}
    ${line('À revoir', ed ? `<button class="btn btn-ghost txd-flag" type="button" aria-pressed="${t.flag?'true':'false'}" style="padding:4px 10px;font-size:12.5px">${t.flag?'Marqué · retirer la marque':'Marquer'}</button>` : (t.flag?'Oui':'Non'))}
    <div style="padding:10px 0 4px"><div class="sub" style="margin-bottom:4px">Communication</div>
      <div style="font-family:monospace;font-size:12.5px;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;word-break:break-word">${escH(t.note||'—')}</div></div>
    <div style="padding:6px 0"><label class="sub" for="txdComment" style="display:block;margin-bottom:4px">Commentaire (revue AG)${reqMiss?` · <span style="color:var(--danger);font-weight:600">obligatoire : sortie de plus de ${FDR_RULE.minOut} € sur le compte de réserve</span>`:''}</label>
      ${ed ? `<textarea class="fld" id="txdComment" rows="2" style="width:100%;resize:vertical" placeholder="${reqMiss?'Justification obligatoire…':'Pourquoi cette ligne mérite un mot en AG'}">${escH(t.comment||'')}</textarea>` : `<div>${escH(t.comment||'—')}</div>`}</div>
    ${free ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost txd-split" type="button">Scinder en plusieurs lignes</button><button class="btn btn-ghost txd-trash" type="button" style="color:var(--danger)">Mettre à la corbeille</button></div>` : ''}`;
  card.querySelector('#txDetailClose').onclick=()=>m.style.display='none';
  const dsel=card.querySelector('.txd-cat'); if(dsel) dsel.onchange=()=>{ setTxCategory(t, dsel.value); showTxDetail(t); };
  const osel=card.querySelector('.txd-owner'); if(osel) osel.onchange=()=>{
    t.owner=osel.value; saveState(); dbWrite(db=>db.updateTransaction(t.id, {owner:osel.value})); learnOwner(t.tiers, osel.value);
    renderTx(curAcct); renderDashboard(); renderProvisions(); showTxDetail(t); };
  const fbtn=card.querySelector('.txd-flag'); if(fbtn) fbtn.onclick=()=>{ t.flag=!t.flag; saveState(); dbWrite(db=>db.updateTransaction(t.id, {flag:t.flag})); renderTx(curAcct); showTxDetail(t); };
  const cin=card.querySelector('#txdComment'); if(cin) cin.onchange=()=>{ t.comment=cin.value; saveState(); dbWrite(db=>db.updateTransaction(t.id, {comment:cin.value})); renderTx(curAcct); };
  const sp=card.querySelector('.txd-split'); if(sp) sp.onclick=()=>{ m.style.display='none'; openSplitModal(t); };
  const tb=card.querySelector('.txd-trash'); if(tb) tb.onclick=()=>{ if(!confirm('Mettre ce mouvement à la corbeille ? Récupérable pendant 7 jours.')) return; m.style.display='none'; trashTx([t.id]); renderAll(); };
  m.style.display='flex';
  (card.querySelector('.txd-cat')||card.querySelector('#txDetailClose')).focus();
}

/* ============================================================
   BESOIN EN FONDS DE ROULEMENT (BFR) + COMPTABILITÉ (flux)
   ============================================================ */
let bfrMonths = 3;     // coussin de couverture (mois) — réglable
let cfPeriod  = '12';  // 12 | 24 | ytd | all
let cfScope   = 'all'; // all | pay | res
const CF_MON  = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];

/* ---- Besoin en fonds de roulement ---- */
function renderBFR(){
  const box = document.getElementById('bfrCard'); if(!box) return;
  // dépense courante moyenne mensuelle du compte de paiement
  const pay = txOf('pay').map(t=>({a:t.amount, d:parseDate(t.date)})).filter(x=>x.d);
  const nM = new Set(pay.map(x=>x.d.iso.slice(0,7))).size || 1;
  const depMoy   = sum(pay.filter(x=>x.a<0).map(x=>-x.a)) / nM;
  const creances = receivables();
  const bfr   = depMoy*bfrMonths + creances;
  const dispo = balance('pay');
  const ok    = dispo >= bfr;
  const tip = `Besoin en fonds de roulement (BFR) — le coussin de trésorerie nécessaire pour régler les charges courantes en attendant les appels de charges.
\nCalcul : (dépense courante moyenne mensuelle du compte de paiement × nombre de mois de couverture) + créances des copropriétaires non encore versées.
\nIci : ${eur(depMoy)}/mois × ${bfrMonths} mois + ${eur(creances)} de créances = ${eur(bfr)}.
\nÀ comparer à la trésorerie d'exploitation disponible (solde du compte de paiement) : ${eur(dispo)}.`;
  box.innerHTML = `
    <div class="h-row"><h2>Besoin en fonds de roulement <span title="${tip.replace(/"/g,'&quot;')}" style="cursor:help;color:var(--clay)">ⓘ</span></h2>
      <div class="seg" id="bfrSeg">${[3,6,12].map(n=>`<button data-n="${n}" class="${n===bfrMonths?'on':''}">${n} mois</button>`).join('')}</div></div>
    <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:14px;margin-top:8px">
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">BFR estimé</div>
        <div style="font-family:var(--display);font-size:26px;font-weight:600;color:var(--clay);margin-top:2px">${eur(bfr)}</div>
        <div class="sub">${bfrMonths} mois × ${eur(depMoy)} + créances ${eur(creances)}</div></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Trésorerie d'exploitation</div>
        <div style="font-family:var(--display);font-size:26px;font-weight:600;margin-top:2px">${eur(dispo)}</div>
        <div class="sub">solde du compte de paiement</div></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Couverture</div>
        <div style="margin-top:6px">${ok?'<span class="badge b-ok">✓ Couvert</span>':'<span class="badge b-late">⚠ À renflouer</span>'}</div>
        <div class="sub" style="margin-top:4px">${ok?`marge +${eur(dispo-bfr)}`:`manque ${eur(bfr-dispo)}`}</div></div>
    </div>`;
  box.querySelector('#bfrSeg').addEventListener('click', e=>{
    const b=e.target.closest('button'); if(!b) return;
    bfrMonths = +b.dataset.n; renderBFR();
  });
}

/* ---- Comptabilité : matrice catégories × mois ---- */
function ensureCfCss(){
  if(document.getElementById('cfCss')) return;
  const s=document.createElement('style'); s.id='cfCss';
  s.textContent=`
   .cf-wrap{overflow:auto;max-height:66vh;border:1px solid var(--line);border-radius:12px}
   table.cf{border-collapse:separate;border-spacing:0;font-size:12.5px;min-width:max-content;width:100%}
   table.cf th,table.cf td{padding:7px 12px;white-space:nowrap;text-align:right;border-bottom:1px solid var(--line-2)}
   table.cf thead th{position:sticky;top:0;background:var(--card-2);z-index:2;font-weight:600;color:var(--ink-soft);text-align:right;line-height:1.15}
   table.cf th:first-child,table.cf td:first-child{position:sticky;left:0;text-align:left;background:var(--card);z-index:1;min-width:210px;box-shadow:1px 0 0 var(--line)}
   table.cf thead th:first-child{z-index:3;background:var(--card-2)}
   table.cf tr.cf-grp td{font-weight:700;background:var(--card-2)}
   table.cf tr.cf-grp td:first-child{background:var(--card-2)}
   table.cf tr.cf-sub td:first-child{padding-left:26px;color:var(--ink-soft);font-weight:400}
   table.cf tr.cf-tot td{font-weight:700;border-top:2px solid var(--line)}
   table.cf tr.cf-tot td:first-child{background:var(--card)}
   table.cf td.cf-pos{color:var(--green)} table.cf td.cf-neg{color:var(--coral)}
   table.cf td.cf-z{color:var(--ink-faint)}
   table.cf td.cf-tot-col{box-shadow:-1px 0 0 var(--line);font-weight:700}
   table.cf td.cf-avg-col,table.cf th.cf-avg-col{font-weight:600;font-style:italic;color:var(--ink-soft)}
   table.cf td.cf-avg-col.cf-pos{color:var(--green)} table.cf td.cf-avg-col.cf-neg{color:var(--coral)}`;
  document.head.appendChild(s);
}
function cfTx(){
  return state.tx.map(t=>({...t,_k:(parseDate(t.date)||{}).iso}))
    .filter(t=>t._k).map(t=>({...t,_k:t._k.slice(0,7)}))
    .filter(t=> cfScope==='all' ? true : t.account===cfScope);
}
function cfMonths(){
  const tx=cfTx(); if(!tx.length) return [];
  const keys=tx.map(t=>t._k).sort();
  const minK=keys[0], maxK=keys[keys.length-1];
  let [my,mm]=maxK.split('-').map(Number);
  let start;
  if(cfPeriod==='ytd') start=`${my}-01`;
  else if(cfPeriod==='all') start=minK;
  else { const n=cfPeriod==='24'?24:12; let y=my,m=mm-(n-1); while(m<=0){m+=12;y--;} start=`${y}-${String(m).padStart(2,'0')}`; }
  if(start<minK && cfPeriod!=='all' && cfPeriod!=='ytd'){ /* garder start même si avant données pour montrer les mois vides */ }
  const out=[]; let [y,m]=start.split('-').map(Number);
  let guard=0;
  while(`${y}-${String(m).padStart(2,'0')}`<=maxK && guard++<400){ out.push({key:`${y}-${String(m).padStart(2,'0')}`,y,m}); m++; if(m>12){m=1;y++;} }
  return out;
}
function cfFmt(v){ return (v>=0?'+':'−')+eur(Math.abs(v)).replace(' €',''); }
function cfBuild(){
  const months=cfMonths();
  const mkeys=months.map(m=>m.key);
  const tx=cfTx().filter(t=>mkeys.includes(t._k));
  const agg={}, catTot={};
  tx.forEach(t=>{ const h=t.high||'?', s=t.sub||'(sans sous-catégorie)', k=t._k;
    const ck=h+'¦'+s; (agg[ck]=agg[ck]||{}); agg[ck][k]=(agg[ck][k]||0)+t.amount;
    (catTot[h]=catTot[h]||{}); catTot[h][k]=(catTot[h][k]||0)+t.amount; });
  const present=[...new Set(tx.map(t=>t.high||'?'))];
  const income=['Charges','Fonds de réserve'];
  const order=[...income, ...allCats().filter(c=>!income.includes(c)), '?'].filter((c,i,a)=>present.includes(c)&&a.indexOf(c)===i);
  const subsOf=h=>[...new Set(tx.filter(t=>(t.high||'?')===h).map(t=>t.sub||'(sans sous-catégorie)'))];
  const totIn={},totOut={},totNet={};
  mkeys.forEach(k=>{ let i=0,o=0; tx.forEach(t=>{ if(t._k===k){ if(t.amount>0)i+=t.amount; else o+=t.amount; } }); totIn[k]=i;totOut[k]=o;totNet[k]=i+o; });
  const opening = cfScope==='all' ? ((state.opening&&state.opening.pay||0)+(state.opening&&state.opening.res||0)) : (state.opening&&state.opening[cfScope]||0);
  let run = opening + sum(cfTx().filter(t=>t._k<mkeys[0]).map(t=>t.amount));
  const treso={}; mkeys.forEach(k=>{ run+=totNet[k]; treso[k]=run; });
  return {months,mkeys,agg,catTot,order,subsOf,totIn,totOut,totNet,treso};
}
function renderComptabilite(){
  const box=document.getElementById('cfMatrix'); if(!box) return;
  ensureCfCss();
  renderPeriods();
  const months=cfMonths();
  if(!months.length){ box.innerHTML='<div class="sub" style="padding:20px">Aucune transaction à afficher.</div>';
    const sm=document.getElementById('cfSummary'); if(sm) sm.innerHTML='';
    const pb=document.getElementById('cfPies'); if(pb) pb.innerHTML='';
    const fl=document.getElementById('cfFlow'); if(fl) fl.innerHTML=''; return; }
  const D=cfBuild(); const {mkeys}=D;
  const N=mkeys.length||1;   // nb de mois affichés → pour la moyenne mensuelle
  const rowSum=obj=>mkeys.reduce((a,k)=>a+(obj[k]||0),0);
  const cell=v=>`<td class="${v>0?'cf-pos':(v<0?'cf-neg':'cf-z')}">${v?cfFmt(v):'·'}</td>`;
  const tcell=v=>`<td class="cf-tot-col ${v>0?'cf-pos':(v<0?'cf-neg':'cf-z')}">${v?cfFmt(v):'·'}</td>`;
  const acell=v=>`<td class="cf-avg-col ${v>0?'cf-pos':(v<0?'cf-neg':'cf-z')}">${v?cfFmt(v):'·'}</td>`;  // moyenne/mois
  let h='<div class="cf-wrap"><table class="cf"><thead><tr><th>Catégorie</th>'+
    D.months.map(m=>`<th>${CF_MON[m.m-1]}<br><span style="font-weight:400;color:var(--ink-faint)">${String(m.y).slice(2)}</span></th>`).join('')+
    '<th class="cf-tot-col">Total</th><th class="cf-avg-col">Moy.<br><span style="font-weight:400;color:var(--ink-faint)">/ mois</span></th></tr></thead><tbody>';
  D.order.forEach(cat=>{
    const ct=D.catTot[cat]||{};
    h+=`<tr class="cf-grp"><td>${cat==='?'?'À catégoriser':cat}</td>${mkeys.map(k=>cell(ct[k]||0)).join('')}${tcell(rowSum(ct))}${acell(rowSum(ct)/N)}</tr>`;
    D.subsOf(cat).forEach(s=>{ const a=D.agg[cat+'¦'+s]||{};
      h+=`<tr class="cf-sub"><td>${s}</td>${mkeys.map(k=>cell(a[k]||0)).join('')}${tcell(rowSum(a))}${acell(rowSum(a)/N)}</tr>`; });
  });
  h+=`<tr class="cf-tot"><td>Total entrées</td>${mkeys.map(k=>`<td class="cf-pos">${D.totIn[k]?cfFmt(D.totIn[k]):'·'}</td>`).join('')}<td class="cf-tot-col cf-pos">${cfFmt(rowSum(D.totIn))}</td><td class="cf-avg-col cf-pos">${cfFmt(rowSum(D.totIn)/N)}</td></tr>`;
  h+=`<tr class="cf-tot"><td>Total sorties</td>${mkeys.map(k=>`<td class="cf-neg">${D.totOut[k]?cfFmt(D.totOut[k]):'·'}</td>`).join('')}<td class="cf-tot-col cf-neg">${cfFmt(rowSum(D.totOut))}</td><td class="cf-avg-col cf-neg">${cfFmt(rowSum(D.totOut)/N)}</td></tr>`;
  h+=`<tr class="cf-tot"><td>Flux net</td>${mkeys.map(k=>cell(D.totNet[k])).join('')}${tcell(rowSum(D.totNet))}${acell(rowSum(D.totNet)/N)}</tr>`;
  const tresoAvg = mkeys.reduce((a,k)=>a+(D.treso[k]||0),0)/N;
  h+=`<tr class="cf-tot" style="border-top:none"><td>Trésorerie fin de mois</td>${mkeys.map(k=>`<td>${eur(D.treso[k]).replace(' €','')}</td>`).join('')}<td class="cf-tot-col">—</td><td class="cf-avg-col">${eur(tresoAvg).replace(' €','')}</td></tr>`;
  h+='</tbody></table></div>';
  box.innerHTML=h;
  // cartes de synthèse
  const sIn=rowSum(D.totIn), sOut=rowSum(D.totOut), net=sIn+sOut;
  const card=(l,v,c,extra)=>`<div class="kpi"><div class="l">${l}</div><div class="v"${c?` style="color:${c}"`:''}>${v}</div>${extra||''}</div>`;
  const sm=document.getElementById('cfSummary');
  if(sm) sm.innerHTML =
    card('Entrées sur la période','+'+eur(sIn),'var(--success)')+
    card('Sorties sur la période','−'+eur(Math.abs(sOut)),'')+
    card('Flux net',(net>=0?'+':'−')+eur(Math.abs(net)),net>=0?'var(--success)':'')+
    card('Trésorerie fin de période',eur(D.treso[mkeys[mkeys.length-1]]),'',cfSparkline(mkeys.map(k=>D.treso[k])));
  renderCfFlow(D);
  renderExpensePies();
}
/* ---------- Exercices : carte « Exercices » de l'écran Comptabilité ---------- */
function periodYears(){
  const ys=new Set(periodsOf().map(p=>+p.year));
  state.tx.forEach(t=>{ const d=parseDate(t.date); if(d) ys.add(d.y); });
  ys.add(new Date().getFullYear());
  return [...ys].filter(y=>y>=2000 && y<=2100).sort((a,b)=>a-b);
}
// Un exercice se clôture quand l'année est finie, l'exercice précédent clôturé, chaque compte
// rapproché sur un relevé qui couvre le 31/12, et plus aucun brouillon daté dans l'année.
function periodReady(y){
  const end=`${y}-12-31`, reasons=[], lbl=a=>a==='res'?'réserve':'paiement';
  if (end>=todayISO()) reasons.push(`l'année ${y} n'est pas terminée`);
  const prev=periodsOf().find(p=>+p.year===y-1);
  if (periodYears()[0]<y && !(prev&&prev.closed_at)) reasons.push(`l'exercice ${y-1} n'est pas clôturé`);
  ['pay','res'].forEach(a=>{
    if(!txOf(a).some(t=>{ const d=parseDate(t.date); return d && d.iso<=end; })) return;
    const r=(state.recon||{})[a];
    if(!r || r.closing==null){ reasons.push(`aucun relevé rapproché sur le compte de ${lbl(a)}`); return; }
    const asOf=(parseDate(r.asOf)||{}).iso||'';
    if(!asOf || asOf<end) reasons.push(`le dernier relevé du compte de ${lbl(a)} s'arrête ${asOf?'au '+r.asOf:'avant le 31/12'} : il en faut un qui couvre le 31/12/${y}`);
    const st=reconStatus(a); if(st && !st.ok) reasons.push(`écart de ${eur(Math.abs(st.diff))} sur le compte de ${lbl(a)}`);
  });
  if((state.draftTx||[]).some(t=>{ const d=parseDate(t.date); return d && d.iso<=end; })) reasons.push('des lignes importées de cet exercice attendent encore leur validation');
  return {ok:!reasons.length, reasons};
}
async function closePeriod(y){
  if(!canWrite()) return;
  const ready=periodReady(y); if(!ready.ok){ showToast(`Clôture ${y} impossible : ${ready.reasons.join(' ; ')}.`, 'err'); return; }
  const r2=v=>Math.round((+v||0)*100)/100, end=`${y}-12-31`, prevEnd=`${y-1}-12-31`;
  const ag=(state.ags||[]).find(a=>a.status==='finalisee' && (parseFrDate(a.ag_date)||new Date(0)).getFullYear()===y+1);
  let html=''; try { if(window.LSReports) html=LSReports.build('ag', LSReports.periodForYear(y)).body||''; } catch(e){ console.error(e); }
  const row={year:y, starts:`${y}-01-01`, ends:end, closed_at:new Date().toISOString(),
    opening_pay:r2(balanceAt('pay',prevEnd)), opening_res:r2(balanceAt('res',prevEnd)),
    closing_pay:r2(balanceAt('pay',end)), closing_res:r2(balanceAt('res',end)),
    approved_ag_id:ag?ag.id:null, report_html:html};
  if(!confirm(`Clôturer l'exercice ${y} ?\n\nSoldes au 31/12/${y} : paiement ${eur(row.closing_pay)}, réserve ${eur(row.closing_res)}.\nLes mouvements de ${y} ne pourront plus être modifiés ni supprimés (drapeau et commentaire exceptés) ; le rapport financier ${y} est archivé tel quel.`)) return;
  state.periods=[...periodsOf().filter(p=>+p.year!==y), row].sort((a,b)=>(+a.year)-(+b.year));
  saveState();
  dbWrite(async db=>{ try { await db.periodUpsert(row); } catch(e){ throw new Error(periodsHint(e.message||String(e))); } });
  logTimeline({title:`Exercice ${y} clôturé`, kind:'manual',
    description:`Soldes au 31/12/${y} : paiement ${eur(row.closing_pay)}, réserve ${eur(row.closing_res)}. Rapport financier archivé${ag?` ; comptes approuvés par l'AG « ${ag.title||''} »`:''}.`});
  showToast(`Exercice ${y} clôturé : ses mouvements sont verrouillés.`);
  renderAll();
}
function reopenPeriod(y){
  if(!canWrite()) return;
  if(!confirm(`Rouvrir l'exercice ${y} ?\n\nSes mouvements redeviennent modifiables ; ses soldes figés ne font plus foi jusqu'à la prochaine clôture.`)) return;
  state.periods=periodsOf().map(p=>+p.year===y ? {...p, closed_at:null, closed_by:null} : p);
  saveState();
  dbWrite(async db=>{ try { await db.periodUpdate(y, {closed_at:null, closed_by:null}); } catch(e){ throw new Error(periodsHint(e.message||String(e))); } });
  logTimeline({title:`Exercice ${y} rouvert`, kind:'manual', description:'Ses mouvements sont à nouveau modifiables ; à re-clôturer après correction.'});
  renderAll();
}
function renderPeriods(){
  const card=document.getElementById('periodsCard'); if(!card) return;
  const ed=canWrite(), ys=periodYears();
  const rows=ys.map(y=>{
    const p=periodsOf().find(x=>+x.year===y), closed=!!(p&&p.closed_at), end=`${y}-12-31`, prevEnd=`${y-1}-12-31`;
    const op=closed?p.opening_pay:balanceAt('pay',prevEnd), orr=closed?p.opening_res:balanceAt('res',prevEnd);
    const cp=closed?p.closing_pay:balanceAt('pay',end), cr=closed?p.closing_res:balanceAt('res',end);
    const ready=closed?null:periodReady(y);
    const status=closed
      ? `<span class="badge b-ok">Clôturé</span><div class="sub">le ${fmtDateLong(String(p.closed_at).slice(0,10))}</div>`
      : ready.ok ? `<span class="badge" style="background:var(--secondary);color:var(--primary)">Prêt à clôturer</span>`
      : `<span class="badge" style="background:var(--clay-soft);color:var(--warning-ink)">Ouvert</span>`;
    const why=!closed && !ready.ok ? `<div class="sub" style="white-space:normal;margin-top:4px;max-width:360px">${ready.reasons.map(escH).join(' · ')}</div>` : '';
    const act=closed
      ? `<button class="btn btn-ghost per-report" data-y="${y}" ${p.report_html?'':'disabled'}>Rapport archivé</button>${ed?` <button class="lk per-reopen" data-y="${y}">Rouvrir</button>`:''}`
      : (ed && ready.ok ? `<button class="btn btn-primary per-close" data-y="${y}">Clôturer ${y}</button>` : '');
    return `<tr><td><b>${y}</b>${why}</td><td>${status}</td>
      <td class="num">${eur(op||0)}<div class="sub">réserve ${eur(orr||0)}</div></td>
      <td class="num">${eur(cp||0)}<div class="sub">réserve ${eur(cr||0)}</div></td><td style="white-space:nowrap">${act}</td></tr>`;
  }).join('');
  card.innerHTML=`<div class="h-row"><div><h2>Exercices</h2><div class="sub">Un exercice clôturé fige ses soldes et son rapport financier ; ses mouvements ne changent plus (drapeau et commentaire exceptés), la base le garantit. Il se clôture quand l'année est finie, l'exercice précédent clôturé, les deux comptes rapprochés sur un relevé qui couvre le 31/12, et sans brouillon en attente.</div></div></div>
    <div style="overflow-x:auto"><table><tr><th>Exercice</th><th>Statut</th><th class="num">Ouverture · paiement</th><th class="num">Clôture · paiement</th><th></th></tr>${rows}</table></div>`;
  card.querySelectorAll('.per-close').forEach(b=>b.onclick=()=>closePeriod(+b.dataset.y));
  card.querySelectorAll('.per-reopen').forEach(b=>b.onclick=()=>reopenPeriod(+b.dataset.y));
  card.querySelectorAll('.per-report').forEach(b=>b.onclick=()=>{ const p=periodsOf().find(x=>+x.year===+b.dataset.y);
    if(p && p.report_html && window.LSReports) LSReports.show(`Rapport financier ${p.year} · archivé à la clôture`, p.report_html, `LazySyndic – rapport ${p.year} archivé`); });
}
function exportComptabilite(){
  const months=cfMonths(); if(!months.length){ alert('Rien à exporter.'); return; }
  const D=cfBuild(); const {mkeys}=D;
  const N=mkeys.length||1;
  const rowSum=obj=>mkeys.reduce((a,k)=>a+(obj[k]||0),0);
  const f=v=>(v||0).toFixed(2).replace('.',',');
  const head=['Catégorie',...months.map(m=>`${CF_MON[m.m-1]} ${m.y}`),'Total','Moy./mois'];
  const lines=[head.join(';')];
  D.order.forEach(cat=>{ const ct=D.catTot[cat]||{};
    lines.push([cat==='?'?'À catégoriser':cat,...mkeys.map(k=>f(ct[k])),f(rowSum(ct)),f(rowSum(ct)/N)].join(';'));
    D.subsOf(cat).forEach(s=>{ const a=D.agg[cat+'¦'+s]||{};
      lines.push(['  '+s,...mkeys.map(k=>f(a[k])),f(rowSum(a)),f(rowSum(a)/N)].join(';')); }); });
  lines.push(['Total entrées',...mkeys.map(k=>f(D.totIn[k])),f(rowSum(D.totIn)),f(rowSum(D.totIn)/N)].join(';'));
  lines.push(['Total sorties',...mkeys.map(k=>f(D.totOut[k])),f(rowSum(D.totOut)),f(rowSum(D.totOut)/N)].join(';'));
  lines.push(['Flux net',...mkeys.map(k=>f(D.totNet[k])),f(rowSum(D.totNet)),f(rowSum(D.totNet)/N)].join(';'));
  lines.push(['Trésorerie fin de mois',...mkeys.map(k=>f(D.treso[k])),'',f(mkeys.reduce((a,k)=>a+(D.treso[k]||0),0)/N)].join(';'));
  downloadBlob(new Blob(['﻿'+lines.join('\n')],{type:'text/csv'}), `comptabilite_${cfScope}_${cfPeriod}.csv`);
}
/* contrôles */
document.getElementById('cfPeriod')?.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#cfPeriod button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  cfPeriod=b.dataset.p; renderComptabilite(); });
document.getElementById('cfAcct')?.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#cfAcct button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  cfScope=b.dataset.a; renderComptabilite(); });
document.getElementById('cfExport')?.addEventListener('click', exportComptabilite);

/* ============================================================
   GRAPHIQUES DE LA COMPTABILITÉ
   Flux mensuels (entrées au-dessus de zéro, sorties en dessous), tendance de la
   trésorerie dans sa carte, répartition des dépenses en barres classées.
   Couleurs passées au validateur dataviz (daltonisme, chroma) : le vert et le
   rouge corail de l'app se confondent pour un protanope, pas ce vert et cet orange.
   ============================================================ */
const CF_IN = '#1F7A55', CF_OUT = '#D9822B', CF_MUTED = '#C9D5CC';
let cfSelCat = null;   // catégorie dont on détaille les sous-catégories

function ensureCfChartCss(){
  if(document.getElementById('cfChartCss')) return;
  const s=document.createElement('style'); s.id='cfChartCss';
  s.textContent=`
   .cf-legend{display:flex;gap:16px;font-size:12.5px;color:var(--ink-soft)}
   .cf-legend span{display:inline-flex;align-items:center;gap:7px}
   .cf-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
   #cfFlow{position:relative;margin-top:10px}
   #cfFlow svg{display:block;overflow:visible}
   #cfFlow text{font-size:11px;fill:var(--ink-faint);font-variant-numeric:tabular-nums}
   #cfFlow .hit{fill:transparent;cursor:default}
   .cf-tip{position:absolute;pointer-events:none;background:var(--ink);color:#fff;border-radius:10px;padding:9px 12px;
     font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(33,40,30,.25);white-space:nowrap;transform:translate(-50%,-100%);display:none;z-index:5}
   .cf-tip b{display:block;font-size:12.5px;margin-bottom:2px}
   .cf-tip .r{display:flex;justify-content:space-between;gap:18px;font-variant-numeric:tabular-nums}
   .cf-tip i{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:6px}
   .cf-split{display:flex;gap:36px;flex-wrap:wrap;margin-top:8px;flex:1 1 100%;min-width:0}
   .cf-split>div{flex:1 1 300px;min-width:0}
   .cf-bh{font-size:12px;font-weight:600;color:var(--ink-faint);margin-bottom:8px}
   .cf-bh b{color:var(--ink)}
   .cfb{display:flex;flex-direction:column;gap:2px}
   .cfb-row{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:minmax(90px,150px) minmax(0,1fr) 88px 40px;align-items:center;gap:12px;
     padding:7px 9px;border-radius:9px;font-size:13px;color:var(--ink)}
   button.cfb-row{cursor:pointer}
   button.cfb-row:hover{background:var(--card-2)}
   button.cfb-row:focus-visible{outline:2px solid var(--green);outline-offset:1px}
   .cfb-row.on{background:var(--card-2)}
   .cfb-row.on .cfb-l{font-weight:700}
   .cfb-l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
   .cfb-track{height:12px;border-radius:0 4px 4px 0;background:var(--line-2);overflow:hidden}
   .cfb-bar{display:block;height:100%;border-radius:0 4px 4px 0;min-width:2px}
   .cfb-v{text-align:right;font-variant-numeric:tabular-nums}
   .cfb-p{text-align:right;color:var(--ink-faint);font-variant-numeric:tabular-nums}
   .cf-spark{display:block;margin-top:8px}`;
  document.head.appendChild(s);
}

// Pas « rond » pour un axe : 1, 2, 2,5 ou 5 × 10ⁿ.
function niceStep(span, n){
  const raw=span/Math.max(1,n), p=Math.pow(10,Math.floor(Math.log10(raw||1))), f=raw/p;
  return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p;
}
const cfTick = v => (v<0?'−':'')+Math.abs(v).toLocaleString('fr-BE',{maximumFractionDigits:0})+' €';
const cfSigned = v => (v>0?'+':v<0?'−':'')+eur(Math.abs(v));

// Colonnes mensuelles : entrées vers le haut, sorties vers le bas, une seule échelle.
function renderCfFlow(D){
  const box=document.getElementById('cfFlow'); if(!box) return;
  ensureCfChartCss();
  const ks=D.mkeys, ins=ks.map(k=>D.totIn[k]||0), outs=ks.map(k=>-(D.totOut[k]||0)), n=ks.length;
  if(!ins.some(Boolean) && !outs.some(Boolean)){ box.innerHTML='<div class="sub" style="padding:14px 0">Aucun mouvement sur la période.</div>'; return; }
  const W=Math.max(300, box.clientWidth||880), H=250, L=58, R=8, T=10, B=36, pw=W-L-R, ph=H-T-B;
  const up=Math.max(...ins,0), dn=Math.max(...outs,0);
  const step=niceStep(up+dn, 4), top=Math.ceil(up/step)*step||step, bot=Math.ceil(dn/step)*step;
  const y=v=>T+(top-v)/(top+bot)*ph, y0=y(0);
  const band=pw/n, bw=Math.max(4, Math.min(24, band*0.5));
  const ticks=[]; for(let v=-bot; v<=top+1e-9; v+=step) ticks.push(+v.toFixed(2));
  const col=(x,yA,yB,roundTop)=>{          // bord arrondi côté donnée, carré sur la ligne de base
    const h=Math.abs(yB-yA); if(h<0.5) return '';
    const r=Math.min(4,bw/2,h), x2=x+bw;
    return roundTop
      ? `M${x} ${yB}V${yA+r}Q${x} ${yA} ${x+r} ${yA}H${x2-r}Q${x2} ${yA} ${x2} ${yA+r}V${yB}Z`
      : `M${x} ${yA}V${yB-r}Q${x} ${yB} ${x+r} ${yB}H${x2-r}Q${x2} ${yB} ${x2} ${yB-r}V${yA}Z`;
  };
  let g='', bars='', hits='', xl='';
  ticks.forEach(v=>{ const yy=y(v).toFixed(1);
    g+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="${v===0?'var(--ink-faint)':'var(--line)'}" stroke-width="1"/>`+
       `<text x="${L-10}" y="${yy}" text-anchor="end" dominant-baseline="middle">${cfTick(v)}</text>`; });
  D.months.forEach((m,i)=>{
    const cx=L+band*(i+.5), x=+(cx-bw/2).toFixed(1);
    bars+=`<path d="${col(x,y(ins[i]),y0,true)}" fill="${CF_IN}"/><path d="${col(x,y0,y(-outs[i]),false)}" fill="${CF_OUT}"/>`;
    hits+=`<rect class="hit" data-i="${i}" x="${(L+band*i).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${ph}"/>`;
    const showYear=i===0||m.m===1;
    if(n<=14 || i%2===0) xl+=`<text x="${cx.toFixed(1)}" y="${H-B+16}" text-anchor="middle">${CF_MON[m.m-1]}</text>`;
    if(showYear) xl+=`<text x="${cx.toFixed(1)}" y="${H-B+30}" text-anchor="middle" style="fill:var(--ink-soft);font-weight:600">${m.y}</text>`;
  });
  box.innerHTML=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Entrées et sorties par mois sur la période ; le détail chiffré est dans le tableau ci-dessous">
      <rect class="cf-hl" x="0" y="${T}" width="${band.toFixed(1)}" height="${ph}" fill="var(--card-2)" style="display:none"/>
      ${g}${bars}${xl}${hits}</svg><div class="cf-tip"></div>`;
  const svg=box.querySelector('svg'), hl=box.querySelector('.cf-hl'), tip=box.querySelector('.cf-tip');
  svg.addEventListener('mousemove',e=>{
    const t=e.target.closest('.hit'); if(!t){ hl.style.display='none'; tip.style.display='none'; return; }
    const i=+t.dataset.i, m=D.months[i];
    hl.setAttribute('x',t.getAttribute('x')); hl.style.display='';
    tip.innerHTML=`<b>${CF_MON[m.m-1]} ${m.y}</b>
      <div class="r"><span><i style="background:${CF_IN}"></i>Entrées</span><span>${cfSigned(ins[i])}</span></div>
      <div class="r"><span><i style="background:${CF_OUT}"></i>Sorties</span><span>${cfSigned(-outs[i])}</span></div>
      <div class="r" style="border-top:1px solid rgba(255,255,255,.18);margin-top:3px;padding-top:3px"><span>Net</span><span>${cfSigned(ins[i]-outs[i])}</span></div>`;
    tip.style.display='block';
    const cx=L+band*(i+.5), half=tip.offsetWidth/2;
    tip.style.left=Math.min(Math.max(cx, half), W-half)+'px';
    tip.style.top=(Math.min(y(ins[i]), y0)-10)+'px';
  });
  svg.addEventListener('mouseleave',()=>{ hl.style.display='none'; tip.style.display='none'; });
}

// Tendance de la trésorerie, en petit, dans sa carte (deux échelles ne cohabitent jamais sur un graphique).
function cfSparkline(vals){
  if(vals.length<2) return '';
  const W=180, H=34, P=4, mn=Math.min(...vals), mx=Math.max(...vals), span=(mx-mn)||1;
  const pt=(v,i)=>[P+i*(W-2*P)/(vals.length-1), P+(mx-v)/span*(H-2*P)];
  const d=vals.map((v,i)=>pt(v,i).map(n=>n.toFixed(1)).join(' ')).join(' L');
  const [ex,ey]=pt(vals[vals.length-1], vals.length-1);
  return `<svg class="cf-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="M${d}" fill="none" stroke="var(--ink-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="${CF_IN}" stroke="var(--card)" stroke-width="2"/></svg>`;
}

// agrège les dépenses (sorties) de la période/compte courants
function cfExpenseData(){
  const mkeys=cfMonths().map(m=>m.key);
  const tx=cfTx().filter(t=>mkeys.includes(t._k) && t.amount<0);
  const byCat={}, bySub={};
  tx.forEach(t=>{ const h=t.high||'?', s=t.sub||'(sans sous-catégorie)', v=-t.amount;
    byCat[h]=(byCat[h]||0)+v; (bySub[h]=bySub[h]||{}); bySub[h][s]=(bySub[h][s]||0)+v; });
  const total=sum(Object.values(byCat))||1;
  const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([high,v])=>({high,v}));
  return {cats,bySub,total};
}
// Barres classées : longueur = part du total, valeur et pourcentage au bout.
function cfBarList(rows, total, opts){
  return `<div class="cfb">${rows.map(r=>{
    const pct=r.v/total*100, on=opts.sel===r.key, tag=opts.clickable?'button':'div';
    const color=opts.clickable ? (on?CF_IN:CF_MUTED) : CF_IN;
    return `<${tag} class="cfb-row${on?' on':''}"${opts.clickable?` type="button" data-key="${encodeURIComponent(r.key)}" aria-pressed="${on}"`:''}>
      <span class="cfb-l" title="${r.label}">${r.label}</span>
      <span class="cfb-track"><span class="cfb-bar" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
      <span class="cfb-v">${eur(r.v)}</span><span class="cfb-p">${Math.round(pct)} %</span></${tag}>`;}).join('')}</div>`;
}
function renderExpensePies(){
  const box=document.getElementById('cfPies'); if(!box) return;
  ensureCfChartCss();
  const {cats,bySub,total}=cfExpenseData();
  if(!cats.length){ box.innerHTML='<div class="sub" style="padding:14px">Aucune dépense sur la période sélectionnée.</div>'; return; }
  if(!cfSelCat || !cats.some(c=>c.high===cfSelCat)) cfSelCat=cats[0].high;
  const name=h=>h==='?'?'À catégoriser':h;
  const subs=Object.entries(bySub[cfSelCat]||{}).sort((a,b)=>b[1]-a[1]);
  const subTot=sum(subs.map(e=>e[1]))||1;
  box.innerHTML=`<div class="cf-split">
    <div><div class="cf-bh">Par catégorie · <b>${eur(total)}</b></div>
      ${cfBarList(cats.map(c=>({key:c.high,label:name(c.high),v:c.v})), total, {clickable:true, sel:cfSelCat})}</div>
    <div><div class="cf-bh">Détail de ${name(cfSelCat)} · <b>${eur(subTot)}</b></div>
      ${cfBarList(subs.map(([s,v])=>({key:s,label:s,v})), subTot, {clickable:false})}</div>
  </div>`;
  box.querySelectorAll('button.cfb-row').forEach(b=>b.addEventListener('click',()=>{ cfSelCat=decodeURIComponent(b.dataset.key); renderExpensePies(); }));
}
// Le graphique mensuel suit la largeur de sa carte.
let _cfResize=null;
window.addEventListener('resize',()=>{ clearTimeout(_cfResize); _cfResize=setTimeout(()=>{
  if(document.getElementById('cpta')?.classList.contains('on') && typeof cfBuild==='function' && cfMonths().length) renderCfFlow(cfBuild());
},150); });

/* ============================================================
   BANNIÈRE DE CONFIRMATION (sauvegarde)
   ============================================================ */
let _toastDebounce=null, _toastHide=null;
function ensureToastCss(){
  if(document.getElementById('lsToastCss')) return;
  const s=document.createElement('style'); s.id='lsToastCss';
  s.textContent=`
   .ls-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);z-index:400;
     display:flex;align-items:center;gap:10px;background:var(--green-deep);color:#EAF1E8;
     padding:11px 18px 11px 13px;border-radius:30px;font-size:13.5px;font-weight:600;
     box-shadow:0 8px 26px rgba(33,40,30,.24);opacity:0;pointer-events:none;
     transition:opacity .25s ease,transform .25s cubic-bezier(.2,.7,.2,1)}
   .ls-toast.show{opacity:1;transform:translate(-50%,0)}
   .ls-toast.err{background:var(--coral);pointer-events:auto}
   .ls-toast .x{all:unset;cursor:pointer;margin-left:4px;padding:0 8px;min-height:28px;display:inline-flex;align-items:center;font-weight:700;border-radius:14px}
   .ls-toast .x:hover,.ls-toast .x:focus-visible{background:rgba(255,255,255,.18)}
   .ls-toast .ic{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:50%;
     background:rgba(255,255,255,.22);font-size:11px;flex:0 0 auto}`;
  document.head.appendChild(s);
}
function showToast(msg, kind){
  ensureToastCss();
  let el=document.getElementById('lsToast');
  if(!el){ el=document.createElement('div'); el.id='lsToast'; el.setAttribute('role','status'); el.setAttribute('aria-live','polite'); document.body.appendChild(el); }
  el.innerHTML=`<span class="ic">${kind==='err'?'!':'✓'}</span><span>${msg}</span>${kind==='err'?'<button class="x" type="button" aria-label="Fermer">✕</button>':''}`;
  el.className='ls-toast'+(kind==='err'?' err':'')+' show';   // affichage synchrone (animation CSS pour l'entrée)
  clearTimeout(_toastHide);
  // Une erreur reste affichée jusqu'à sa fermeture : en 4,5 s on n'a pas le temps de la lire.
  if(kind==='err') el.querySelector('.x').onclick=()=>el.classList.remove('show');
  else _toastHide=setTimeout(()=>el.classList.remove('show'), 2000);
}
// Sauvegardes groupées (ex. catégorie + apprentissage de la règle) → une seule bannière.
function toastSaved(){
  clearTimeout(_toastDebounce);
  _toastDebounce=setTimeout(()=>showToast('Modifications enregistrées'), 150);
}
function toastError(m){ showToast('Échec de l’enregistrement : '+m, 'err'); }

/* ============================================================
   SPLIT D'UNE TRANSACTION (répartir une dépense en plusieurs)
   ============================================================ */
function ensureSplitCss(){
  if(document.getElementById('splitCss')) return;
  const s=document.createElement('style'); s.id='splitCss';
  s.textContent=`
   #splitModal{position:fixed;inset:0;background:rgba(33,40,30,.45);z-index:130;display:none;align-items:center;justify-content:center;padding:20px}
   #splitModal.open{display:flex}
   .sp-card{width:560px;max-width:96vw;max-height:90vh;overflow:auto}
   .sp-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
   .sp-row .sp-amt{width:96px;text-align:right;flex:0 0 auto}
   .sp-row .sp-cat{flex:1;min-width:0}
   .sp-row .sp-sub{flex:1;min-width:0;font-size:12px}
   .sp-row .sp-del{color:var(--ink-faint)!important;opacity:.6}
   .sp-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);flex-wrap:wrap}
   .sp-rem.ok{color:var(--green);font-weight:700}
   .sp-rem.bad{color:var(--coral);font-weight:700}`;
  document.head.appendChild(s);
}
// Remplace la transaction d'origine par N transactions catégorisées (somme = montant d'origine).
function splitTransaction(orig, parts){
  if(!canWrite()) return;
  if(txLocked(orig)){ showToast(lockMsg(orig), 'err'); return; }
  const sign = orig.amount<0 ? -1 : 1;
  const stamp = todayISO();
  const children = parts.map((p,i)=>({
    id:'tmp-'+stamp+'-'+i+'-'+Math.round(p.amount*100),
    date:orig.date, tiers:orig.tiers, account:orig.account,
    note:(orig.note?orig.note+' ':'')+`(split ${i+1}/${parts.length})`,
    high:p.high, sub:p.sub||'', amount:sign*Math.abs(p.amount),
    owner:orig.owner||'', flag:!!orig.flag, comment:orig.comment||''
  }));
  // mise à jour optimiste locale
  state.tx = state.tx.filter(t=>t!==orig);
  state.tx.push(...children);
  saveState();
  if(writeToDb()){
    dbWrite(async db=>{
      const saved = await db.addTransactions(children.map(({id,...r})=>r));   // sans id temporaire
      children.forEach((c,i)=>{ const real=saved[i]; if(real){ const idx=state.tx.indexOf(c); if(idx>=0) state.tx[idx]=real; } });
      if(orig.id) await db.deleteTransactions([orig.id]);
    });
  }
  renderAll();
}
function openSplitModal(orig){
  if(!canWrite()) return;
  ensureSplitCss();
  const total = Math.abs(orig.amount);
  const baseHigh = (orig.high && orig.high!=='?') ? orig.high : (allCats()[0]||'Énergie');
  // départ : 2 lignes (la 1re reprend la catégorie d'origine et le montant total)
  let parts = [{amount:total.toFixed(2), high:baseHigh, sub:orig.sub||''},{amount:'', high:baseHigh, sub:''}];
  let m=document.getElementById('splitModal');
  if(!m){ m=document.createElement('div'); m.id='splitModal'; m.innerHTML='<div class="card sp-card" id="splitCard"></div>';
    m.addEventListener('click',e=>{ if(e.target===m) close(); });
    document.body.appendChild(m); }
  const card=m.querySelector('#splitCard');
  function close(){ m.classList.remove('open'); }
  function syncAmounts(){ card.querySelectorAll('.sp-amt').forEach(inp=>{ parts[+inp.dataset.i].amount=inp.value; }); }
  function render(){
    const sum = parts.reduce((a,p)=>a+(parseAmount(p.amount)||0),0);
    const rem = total - sum;
    const valid = Math.abs(rem)<0.01 && parts.filter(p=>(parseAmount(p.amount)||0)>0).length>=2;
    const rowsH = parts.map((p,i)=>`<div class="sp-row" data-i="${i}">
        <input class="fld sp-amt" data-i="${i}" inputmode="decimal" placeholder="0,00" value="${p.amount}">
        <select class="fld sp-cat" data-i="${i}">${categoryOptions(p.high)}</select>
        <select class="fld sp-sub" data-i="${i}">${subcatOptions(p.high, p.sub||'')}</select>
        ${parts.length>1?`<button class="lk sp-del" data-i="${i}" title="Retirer">✕</button>`:''}
      </div>`).join('');
    card.innerHTML=`
      <div class="h-row"><h2>Splitter la transaction</h2><button class="lk" id="spClose" style="font-size:16px">✕</button></div>
      <div class="sub" style="margin:-6px 0 12px">${orig.tiers} · ${orig.date} · <b class="${orig.amount<0?'neg':'pos'}">${signed(orig.amount)}</b> — répartissez le montant entre plusieurs catégories.</div>
      ${rowsH}
      <button class="lk" id="spAdd" style="margin-top:2px">+ ajouter une ligne</button>
      <div class="sp-bar">
        <div>Total ${eur(total)} · alloué <b class="sp-sum">${eur(sum)}</b> · <span class="sp-rem ${Math.abs(rem)<0.01?'ok':'bad'}">reste ${eur(rem)}</span></div>
        <div style="display:flex;gap:8px"><button class="btn btn-ghost" id="spCancel">Annuler</button>
          <button class="btn btn-primary" id="spOk" ${valid?'':'disabled style="opacity:.5;cursor:not-allowed"'}>Confirmer le split</button></div>
      </div>`;
    card.querySelector('#spClose').onclick=close;
    card.querySelector('#spCancel').onclick=close;
    card.querySelector('#spAdd').onclick=()=>{ syncAmounts(); parts.push({amount:'', high:baseHigh, sub:''}); render(); };
    card.querySelectorAll('.sp-amt').forEach(inp=>inp.oninput=()=>{ parts[+inp.dataset.i].amount=inp.value;
      const sum=parts.reduce((a,p)=>a+(parseAmount(p.amount)||0),0), rem=total-sum;
      const ss=card.querySelector('.sp-sum'); if(ss) ss.textContent=eur(sum);
      const el=card.querySelector('.sp-rem'); if(el){ el.textContent='reste '+eur(rem); el.className='sp-rem '+(Math.abs(rem)<0.01?'ok':'bad'); }
      const ok=card.querySelector('#spOk'); const valid=Math.abs(rem)<0.01 && parts.filter(p=>(parseAmount(p.amount)||0)>0).length>=2;
      if(ok){ ok.disabled=!valid; ok.style.cssText=valid?'':'opacity:.5;cursor:not-allowed'; }
    });
    card.querySelectorAll('.sp-cat').forEach(sel=>sel.onchange=()=>{ syncAmounts(); let v=sel.value; const i=+sel.dataset.i;
      if(v==='__new__'){ v=addCategory(prompt('Nouvelle catégorie :','')||''); if(!v){ render(); return; } }
      parts[i].high=v; parts[i].sub=''; render(); });
    card.querySelectorAll('.sp-sub').forEach(sel=>sel.onchange=()=>{ syncAmounts(); let v=sel.value; const i=+sel.dataset.i;
      if(v==='__new__'){ v=addSubcat(parts[i].high, prompt('Nouvelle sous-catégorie pour « '+parts[i].high+' » :','')||''); if(!v){ render(); return; } }
      parts[i].sub=v; render(); });
    card.querySelectorAll('.sp-del').forEach(b=>b.onclick=()=>{ syncAmounts(); parts.splice(+b.dataset.i,1); render(); });
    card.querySelector('#spOk').onclick=()=>{
      syncAmounts();
      const cleaned=parts.map(p=>({amount:parseAmount(p.amount)||0, high:p.high, sub:p.sub})).filter(p=>p.amount>0);
      const sum=cleaned.reduce((a,p)=>a+p.amount,0);
      if(cleaned.length<2){ alert('Indiquez au moins deux lignes avec un montant.'); return; }
      if(Math.abs(sum-total)>0.01){ alert('La somme ('+eur(sum)+') doit égaler '+eur(total)+'.'); return; }
      if(cleaned.some(p=>!p.high||p.high==='?')){ if(!confirm('Une ligne n’a pas de catégorie. Continuer ?')) return; }
      close(); splitTransaction(orig, cleaned);
    };
  }
  render(); m.classList.add('open');
}
