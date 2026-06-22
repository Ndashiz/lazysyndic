/* ============================================================
   LazySyndic — couche de données vivante
   Source de vérité unique : les transactions, persistées en
   localStorage. Tout le reste (soldes, donut, graphe, table)
   en est dérivé. L'import CSV alimente ce store.
   ============================================================ */

'use strict';

/* ---------- Helpers monnaie / dates ---------- */
const eur = n => (n).toLocaleString('fr-BE', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' €';
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
  'Énergie':         {cls:'',    color:'#2F6B53'},
  'Assurance':       {cls:'ass', color:'#C9854A'},
  'Frais ACP':       {cls:'acp', color:'#C2564A'},
  'Entretien':       {cls:'ent', color:'#7BA98E'},
  'Charges':         {cls:'in',  color:'#2F6B53'},
  'Fonds de réserve':{cls:'in',  color:'#5B4B86'},
};
const CATS = Object.keys(CAT_META);
function catClass(high){ return (CAT_META[high]||{}).cls || ''; }
function isIncomeCat(high){ return high === 'Charges' || high === 'Fonds de réserve'; }
// Catégories = défauts + catégories personnalisées (settings.categories).
function allCats(){ const custom=((typeof state!=='undefined'&&state&&state.categories)||[]); return [...CATS, ...custom.filter(c=>c&&!CATS.includes(c))]; }
function addCategory(name){
  name=(name||'').trim(); if(!name) return '';
  if(allCats().includes(name)) return name;
  state.categories=state.categories||[]; state.categories.push(name);
  saveState(); dbWrite(db=>db.updateSettings({categories: state.categories}));
  return name;
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
  {date:'02/06/25', tiers:'Lou Petit',high:'Fonds de réserve', sub:'',    amount:+40.00,  account:'res', note:'Apport réserve'},
  {date:'02/06/25', tiers:'Alex Martin',  high:'Fonds de réserve', sub:'',    amount:+80.00,  account:'res', note:'Apport réserve'},
  {date:'22/04/25', tiers:'Engie',         high:'Énergie',   sub:'Électricité',amount:-22.19,  account:'res', note:'Régul. sur réserve', flag:true, comment:'Dépense passée sur le mauvais compte ?'},
  {date:'02/03/25', tiers:'Sam Bernard',  high:'Fonds de réserve', sub:'',    amount:+40.00,  account:'res', note:'Apport réserve'},
];

const SEED_RULES = [
  ['Electrabel','Énergie','Électricité'],['Vivaqua','Énergie','Eau'],['Engie','Énergie','Électricité'],
  ['SWAN','Frais ACP','Banque'],['AXA','Assurance','RC civile'],['Minimax','Entretien','Adoucisseur'],
  // vocabulaire courant des relevés Swan / Syndic4you
  ['Fond de reserve','Fonds de réserve',''],['Fonds de réserve','Fonds de réserve',''],
  ['Account subscription','Frais ACP','Logiciel'],['Abonnement','Frais ACP','Logiciel'],
];
// alias : libellé banque → [entité affichée, est-ce un copropriétaire ?, nom court]
const SEED_ALIASES = [
  ['BERNARD SAM','Sam Bernard',true,'Sam'],
  ['M. ALEX MARTIN','Alex Martin',true,'Alex'],
  ['PETIT LOU','Lou Petit',true,'Lou'],
  ['ELECTRABEL CUSTOMER SOL','Electrabel',false,''],
];
const SEED_CONTRACTS = [
  {name:'Electrabel',ref:'8767id',type:'Énergie',start:'21/01/25',note:'électricité communs',status:'actif'},
  {name:'AXA',ref:'RC-22841',type:'Assurance',start:'01/01/24',note:'RC civile copropriété',status:'actif'},
  {name:'Vivaqua',ref:'EAU-3391',type:'Énergie',start:'15/03/23',note:'eau — compteur commun',status:'actif'},
  {name:'Minimax',ref:'ADO-118',type:'Entretien',start:'10/06/24',note:'entretien adoucisseur',status:'actif'},
  {name:'Engie',ref:'GAZ-5520',type:'Énergie',start:'01/02/22',note:'ancien fournisseur gaz',status:'cloture',end:'31/01/25',endNote:'résilié — passage chez Electrabel'},
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
    rules: SEED_RULES.map(r => [...r]),
    aliases: SEED_ALIASES.map(a => [...a]),
    contracts: SEED_CONTRACTS.map(c => ({...c})),
    reminders: SEED_REMINDERS.map(r => ({...r})),
    opening: {...SEED_OPENING},
    // contributions suivies par copropriétaire (exercice courant). Éditable ;
    // remplacé par le calcul dérivé quand ledgerLive passe à true.
    contrib: { Alex:{due:1002, verse:1002}, Sam:{due:503, verse:503}, Lou:{due:499, verse:344.90} },
    ledgerLive: false,
    coproName: 'ACP Démo',
    reserveTarget: 2000,
    ibanMap: {},   // IBAN normalisé → 'pay' | 'res' (détection apprenante)
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
    if (raw) return JSON.parse(raw);
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
  if (!writeToDb()) return;
  try { await fn(window.LS.db); }
  catch(e){ console.error(e); alert('Action non enregistrée : '+(e.message||e)); }
}
// exposé pour debug / reset manuel
window.LazySyndic = { state:()=>state, reset(){ if(ONLINE){location.reload();return;} state = freshState(); saveState(); location.reload(); } };

/* ---------- Dérivations ---------- */
const txOf = acct => state.tx.filter(t => t.account === acct);
const sum = arr => arr.reduce((a,b)=>a+b, 0);

function balance(acct){
  return (state.opening[acct]||0) + sum(txOf(acct).map(t=>t.amount));
}
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

// Qui paie quoi. « dû » = provision annuelle attendue (issue du budget, plus tard).
// « versé » : tant qu'on n'a pas un exercice complet importé, on s'appuie sur les
// contributions suivies dans l'état (state.contrib). Dès qu'un import réel couvre
// l'exercice, on bascule sur le calcul dérivé des transactions (verseFromTx).
let OWNERS = [
  {n:'Alex Martin', short:'Alex', q:500, c:'#2F6B53'},
  {n:'Sam Bernard', short:'Sam',  q:251, c:'#5B4B86'},
  {n:'Lou Petit',short:'Lou', q:249, c:'#C9854A'},
];
const ownersOf = () => (state.owners && state.owners.length) ? state.owners : OWNERS;
// Un virement entrant est rattaché à un copro si son tiers (résolu via alias)
// contient le nom court OU le nom complet du copro.
// Détection auto du copropriétaire d'après le libellé (fallback si non attribué).
function detectOwner(t){
  const hay = norm(t.tiers + ' ' + (t.note||''));
  const om = (typeof state!=='undefined'&&state&&state.ownerRules)||{};
  for (const lbl in om){ if(lbl && hay.includes(lbl)) return om[lbl]; }   // libellés déjà normalisés
  const o = ownersOf().find(o => hay.includes(norm(o.short)) || (o.n && hay.includes(norm(o.n))));
  return o ? o.short : '';
}
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
// Versé = somme des entrées attribuées au copro, sur un compte (ou tous).
function verseFromTx(o, acct){
  return sum(state.tx.filter(t => t.amount>0 && (!acct||t.account===acct) && ownerOfTx(t)===o.short).map(t=>t.amount));
}
function ownerLedger(){
  return ownersOf().map(o => {
    const duePay = +(o.due_pay||0), dueRes = +(o.due_res||0), due = duePay+dueRes;
    const versePay = verseFromTx(o,'pay'), verseRes = verseFromTx(o,'res'), verse = versePay+verseRes;
    return {...o, duePay, dueRes, due, versePay, verseRes, verse, solde: verse-due};
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
    animateBars();
  };
});
function animateBars(){ document.querySelectorAll('.fill[data-w]').forEach(f=>{ setTimeout(()=>f.style.width=f.dataset.w+'%',120); }); }

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
    kpis[2].textContent = '+'+eur(recv);
    kpis[3].textContent = '−'+eur(0);
  }
  // qui paie quoi
  const tbl = document.querySelector('#dash .card table');
  if (tbl){
    const ledger = ownerLedger();
    tbl.innerHTML = '<tr><th>Propriétaire</th><th class="num">Quotité</th><th class="num">Dû</th><th class="num">Versé</th><th class="num">Solde</th><th></th></tr>' +
      ledger.map(o=>{
        const late = o.solde < -0.005;
        return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${o.short[0]}</span> ${o.n}</div></td>
          <td class="num">${o.q}</td>
          <td class="num">${eur(o.due)}</td>
          <td class="num">${eur(o.verse)}</td>
          <td class="num"${late?' style="color:var(--coral)"':''}>${o.solde<0?'−':''}${eur(Math.abs(o.solde))}</td>
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
    : '<div class="sub" style="padding:8px 4px">Rien à faire 🎉</div>';
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
function populateTxFilters(){
  const cf=document.getElementById('catFilter');
  if(cf){ const cur=cf.value; cf.innerHTML='<option value="">Toutes catégories</option>'
    + allCats().map(c=>`<option value="${c}" ${c===cur?'selected':''}>${c}</option>`).join('')
    + `<option value="?" ${cur==='?'?'selected':''}>À catégoriser</option>`; }
  const of=document.getElementById('ownerFilter');
  if(of){ const cur=of.value; of.innerHTML='<option value="">Tous les copropriétaires</option>'
    + ownersOf().map(o=>`<option value="${o.short}" ${o.short===cur?'selected':''}>${o.n}</option>`).join(''); }
}

function renderTx(acct){
  curAcct = acct;
  populateTxFilters();
  const tb = document.getElementById('txbody'); if(!tb) return;
  tb.innerHTML = '';
  const rows = txOf(acct).slice().sort((a,b)=>{
    const da=parseDate(a.date), db=parseDate(b.date);
    return (db?db.iso:'').localeCompare(da?da.iso:'');
  });
  rows.forEach(t=>{
    if (flagOnly && !t.flag) return;
    if (catFilter && (catFilter==='?'? t.high!=='?' : t.high!==catFilter)) return;
    if (dirFilter==='in'  && t.amount<0) return;
    if (dirFilter==='out' && t.amount>0) return;
    if (ownerFilter && ownerOfTx(t)!==ownerFilter) return;
    const idx = state.tx.indexOf(t);
    const tr=document.createElement('tr'); tr.className='tx-row'+(t.flag?' flag':'');
    const catLabel = t.high + (t.sub?(' · '+t.sub):'');
    const amtClass = t.amount>=0 ? 'pos' : 'neg';
    const note = t.note||'';
    const cmt = t.flag && t.comment
      ? `<div class="cmt">✎ ${t.comment}</div>`
      : (t.flag ? '' : '<div class="cmt-add">+ commentaire</div>');
    const ownerSel = t.amount>0
      ? `<div class="cmt" style="font-style:normal"><span style="color:var(--ink-faint)">Versé par :</span> <select class="tx-owner" ${canWrite()?'':'disabled'}>${ownerOptions(ownerOfTx(t))}</select></div>`
      : '';
    tr.innerHTML = `<td class="tx-selcell">${canWrite()?`<input type="checkbox" class="tx-sel" data-id="${t.id}">`:''}</td>
      <td><button class="flagbtn">⚑</button></td>
      <td>${t.date}</td>
      <td><b>${t.tiers}</b></td>
      <td>${canWrite()?`<select class="fld tx-cat" style="font-size:12px;padding:4px 6px">${categoryOptions(t.high)}</select>`:`<span class="cat ${catClass(t.high)}">${catLabel}</span>`}</td>
      <td class="num ${amtClass}">${signed(t.amount)}</td>
      <td>${ownerSel}${note}${cmt}</td>`;
    tr.querySelector('.flagbtn').onclick=()=>{
      if(!canWrite()) return;
      t.flag = !t.flag; saveState(); renderTx(acct);
      dbWrite(db=>db.updateTransaction(t.id, {flag:t.flag}));
    };
    const addBtn = tr.querySelector('.cmt-add');
    if (addBtn) addBtn.onclick = ()=>{
      if(!canWrite()) return;
      const c = prompt('Commentaire (la ligne sera flaggée) :', '');
      if (c!==null){ t.flag=true; t.comment=c; saveState(); renderTx(acct);
        dbWrite(db=>db.updateTransaction(t.id, {flag:true, comment:c})); }
    };
    const osel = tr.querySelector('.tx-owner');
    if (osel) osel.onchange = ()=>{
      if(!canWrite()) return;
      t.owner = osel.value;
      saveState();
      dbWrite(db=>db.updateTransaction(t.id, {owner: osel.value}));
      learnOwner(t.tiers, osel.value);
      renderDashboard(); renderProvisions();
    };
    const csel = tr.querySelector('.tx-cat');
    if (csel) csel.onchange = ()=>{
      if(!canWrite()) return;
      let val=csel.value;
      if(val==='__new__'){ const name=addCategory(prompt('Nouvelle catégorie :','')||''); if(!name){ renderTx(acct); return; } val=name; }
      t.high=val; t.sub='';
      saveState(); dbWrite(db=>db.updateTransaction(t.id,{high:val, sub:''}));
      learnCategory(t.tiers, val);
      renderAll();
    };
    tb.appendChild(tr);
  });
  if (!tb.children.length){
    const filtered = flagOnly||catFilter||dirFilter||ownerFilter;
    tb.innerHTML = `<tr><td colspan="7" class="sub" style="padding:16px">Aucune transaction ${filtered?'ne correspond aux filtres':'sur ce compte'}.</td></tr>`;
  }
  renderTxTools(acct);
}

// Barre d'outils de suppression (admin) : sélection + tout supprimer.
function renderTxTools(acct){
  const head=document.getElementById('txSelHead'), tools=document.getElementById('txTools');
  if(!tools) return;
  if(!canWrite()){ tools.style.display='none'; if(head) head.innerHTML=''; return; }
  const all=txOf(acct);
  if(head) head.innerHTML = all.length?'<input type="checkbox" id="txSelAll" title="Tout sélectionner">':'';
  const selAll=document.getElementById('txSelAll');
  if(selAll) selAll.onchange=()=>{ document.querySelectorAll('#txbody .tx-sel').forEach(c=>{ if(!c.closest('tr').style.display) c.checked=selAll.checked; }); updateTxToolsCount(); };
  tools.style.display=all.length?'flex':'none';
  tools.innerHTML = `<button class="btn btn-ghost" id="txDelSel" disabled style="opacity:.5">🗑 Supprimer la sélection (<span id="txSelN">0</span>)</button>
    <button class="btn btn-ghost" id="txDelAll" style="color:var(--coral)">🗑 Tout supprimer ce compte (${all.length})</button>`;
  document.getElementById('txDelSel').onclick=()=>deleteSelectedTx(acct);
  document.getElementById('txDelAll').onclick=()=>deleteAllTx(acct);
  document.querySelectorAll('#txbody .tx-sel').forEach(c=>c.onchange=updateTxToolsCount);
  updateTxToolsCount();
}
function updateTxToolsCount(){
  const n=document.querySelectorAll('#txbody .tx-sel:checked').length;
  const span=document.getElementById('txSelN'); if(span) span.textContent=n;
  const btn=document.getElementById('txDelSel'); if(btn){ btn.disabled=!n; btn.style.opacity=n?'1':'.5'; }
}
function removeTxLocal(ids){ const set=new Set(ids); state.tx=state.tx.filter(t=>!set.has(t.id)); }
function deleteSelectedTx(acct){
  if(!canWrite()) return;
  const ids=[...document.querySelectorAll('#txbody .tx-sel:checked')].map(c=>c.dataset.id);
  if(!ids.length) return;
  if(!confirm(`Supprimer définitivement ${ids.length} transaction(s) ?`)) return;
  removeTxLocal(ids); saveState();
  dbWrite(db=>db.deleteTransactions(ids));
  renderAll();
}
function deleteAllTx(acct){
  if(!canWrite()) return;
  const ids=txOf(acct).map(t=>t.id);
  if(!ids.length) return;
  if(!confirm(`Supprimer TOUTES les ${ids.length} transactions du ${acct==='res'?'compte de réserve':'compte de paiement'} ?\nAction irréversible.`)) return;
  removeTxLocal(ids); saveState();
  dbWrite(db=>db.deleteTransactions(ids));
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
    bars+=`<rect x="${x(i)-bw-2}" y="${bi}" width="${bw}" height="${base-bi}" rx="3" fill="var(--green)"/>`;
    bars+=`<rect x="${x(i)+2}" y="${bo}" width="${bw}" height="${base-bo}" rx="3" fill="var(--coral)"/>`;
    bars+=`<text x="${x(i)}" y="${H-9}" text-anchor="middle" font-size="11" fill="var(--ink-faint)">${d.labels[i]}</text>`;
  }
  const line = d.bal.map((v,i)=>`${i?'L':'M'}${x(i)},${yB(v)}`).join(' ');
  const dots = d.bal.map((v,i)=>`<circle cx="${x(i)}" cy="${yB(v)}" r="3.5" fill="var(--clay)" stroke="#fff" stroke-width="1.5"/>`).join('');
  let grid=''; for(let g=0;g<=3;g++){ const gy=26+g*((H-60)/3); grid+=`<line x1="${pad}" y1="${gy}" x2="${W-pad}" y2="${gy}" stroke="var(--line-2)"/>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${grid}${bars}
    <path d="${line}" fill="none" stroke="var(--clay)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
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
function reconStatus(acct){
  const r = (state.recon||{})[acct];
  if (!r || r.closing===undefined || r.closing===null) return null;
  const diff = +(balance(acct) - Number(r.closing)).toFixed(2);
  return {closing:Number(r.closing), asOf:r.asOf||'', diff, ok:Math.abs(diff)<0.01};
}
// Carte d'info compte : IBAN + solde d'ouverture (éditables) + solde calculé + réconciliation.
function renderAcctInfo(acct){
  const box=document.getElementById('acctInfo'); if(!box) return;
  acct = acct || curAcct || 'pay';
  const ed = canWrite();
  const iban = (state.ibans&&state.ibans[acct])||'';
  const open = (state.opening&&state.opening[acct])||0;
  const bal = balance(acct);
  const rs = reconStatus(acct);
  const reconHtml = rs
    ? (rs.ok
        ? `<span class="badge b-ok">✓ Réconcilié</span> <span class="sub">solde calculé = clôture du relevé (${eur(rs.closing)}${rs.asOf?' au '+rs.asOf:''})</span>`
        : `<span class="badge b-late">⚠ Déséquilibre ${rs.diff>0?'+':''}${eur(rs.diff)}</span> <span class="sub">calculé ${eur(bal)} ≠ clôture du relevé ${eur(rs.closing)}${rs.asOf?' au '+rs.asOf:''} — transaction manquante ou en trop ?</span>`)
    : '<span class="sub">Aucun relevé importé pour ce compte — pas encore de réconciliation.</span>';
  box.innerHTML = `
    <div class="grid" style="grid-template-columns:1.4fr 1fr 1fr;gap:14px;align-items:end">
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">IBAN du ${acct==='res'?'compte de réserve':'compte de paiement'}</div>
        <input class="fld" id="acctIban" ${ed?'':'disabled'} style="width:100%;margin-top:4px;font-family:monospace;font-size:12.5px" value="${iban}" placeholder="BE00 0000 0000 0000"></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Solde d'ouverture</div>
        <input class="fld" id="acctOpening" ${ed?'':'disabled'} style="width:100%;margin-top:4px" value="${eur(open)}"></div>
      <div><div class="l" style="font-size:12px;color:var(--ink-faint)">Solde calculé (ouverture + transactions)</div>
        <div style="font-family:'Fraunces',serif;font-size:22px;font-weight:600;margin-top:2px">${eur(bal)}</div></div>
    </div>
    <div style="margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${reconHtml}</div>`;
  if (ed){
    const ib=box.querySelector('#acctIban');
    ib.onchange=()=>{ const v=ib.value.trim(); state.ibans=state.ibans||{}; state.ibans[acct]=v;
      dbWrite(db=>db.updateSettings(acct==='res'?{iban_res:v}:{iban_pay:v})); };
    const op=box.querySelector('#acctOpening');
    op.onchange=()=>{ const v=parseAmount(op.value); if(isNaN(v)){op.value=eur(open);return;}
      state.opening=state.opening||{}; state.opening[acct]=v;
      dbWrite(db=>db.updateSettings(acct==='res'?{opening_res:v}:{opening_pay:v}));
      refreshAccountChrome(); renderTx(acct); renderChart(acct); renderDashboard(); };
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
  // regrouper en lignes (même y ± tolérance), puis trier par x
  items.sort((a,b)=> Math.abs(a.y-b.y)>3 ? a.y-b.y : a.x-b.x);
  const rows=[]; let cur=null;
  items.forEach(it=>{
    if (!cur || Math.abs(it.y-cur.y)>3){ cur={y:it.y, items:[it]}; rows.push(cur); }
    else cur.items.push(it);
  });
  rows.forEach(r=>r.items.sort((a,b)=>a.x-b.x));
  const joined = rows.map(r=>r.items.map(i=>i.str).join(' ')).join('\n');

  // métadonnées
  const meta={}; let m;
  if ((m=joined.match(/ouverture[^\d]{0,8}([\d.\s]*\d,\d{2})/i))) meta.opening=parseAmount(m[1]);
  if ((m=joined.match(/cl[oô]ture[^\d]{0,8}([\d.\s]*\d,\d{2})/i))) meta.closing=parseAmount(m[1]);
  if ((m=joined.match(/Du\s+(\d{2}\/\d{2}\/\d{4})\s+au\s+(\d{2}\/\d{2}\/\d{4})/i))){ meta.from=m[1]; meta.to=m[2]; }
  if ((m=joined.match(/IBAN\s+([A-Z]{2}[0-9A-Z][0-9A-Z \t]{8,})/))) meta.iban=m[1].replace(/\s+/g,' ').trim();

  // lignes de transaction : commencent par une date JJ/MM/AAAA, finissent par 2 montants
  const isNum = s => /^-?\d[\d.\s  ]*,\d{2}$/.test(String(s).trim());
  const data=[];
  rows.forEach(r=>{
    const its=r.items; if(!its.length) return;
    if(!/^\d{2}\/\d{2}\/\d{4}$/.test(its[0].str.trim())) return;     // pas une ligne de transaction
    const date=its[0].str.trim();
    const nums=its.slice(1).filter(i=>isNum(i.str));
    if(nums.length<2) return;                                        // besoin crédit + débit
    const credit=nums[nums.length-2].str.trim();
    const debit =nums[nums.length-1].str.trim();
    const firstNumX=nums[nums.length-2].x;
    const middle=its.slice(1).filter(i=>!isNum(i.str) && i.x<firstNumX-1).map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();
    let type='', desc=middle;
    const tm=middle.match(/^(Frais|Virement|Pr[ée]l[èe]vement automatique|Pr[ée]l[èe]vement|Paiement|Domiciliation|Ch[èe]que)\s*(.*)$/i);
    if(tm){ type=tm[1]; desc=tm[2].trim(); }
    data.push([date, type, desc||type||'—', credit, debit]);
  });
  // solde d'ouverture : déduit de clôture − (Σ crédits − Σ débits) si non lu directement
  if ((meta.opening===undefined || isNaN(meta.opening)) && !isNaN(meta.closing)){
    const net = data.reduce((a,r)=> a + (parseAmount(r[3])||0) - (parseAmount(r[4])||0), 0);
    meta.opening = +(meta.closing - net).toFixed(2);
  }
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
function detectDateOrder(values){
  let firstGt12=false, secondGt12=false;
  values.forEach(v=>{
    const m = String(v||'').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}/);
    if (m){ if (+m[1]>12) firstGt12=true; if (+m[2]>12) secondGt12=true; }
  });
  if (secondGt12 && !firstGt12) return 'mdy';  // ex. 01/28/2026
  if (firstGt12 && !secondGt12) return 'dmy';  // ex. 28/01/2026
  return 'dmy'; // défaut belge
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
  // frais bancaires reconnus via la colonne Type
  if (type && /fee|frais|cost/.test(norm(type))) return {tiers:displayTiers, high:'Frais ACP', sub:'Banque'};
  return {tiers:displayTiers, high:'?', sub:''};
}

function signature(t){
  const d = parseDate(t.date); return `${d?d.iso:t.date}|${(+t.amount).toFixed(2)}|${norm(t.tiers)}|${norm(t.note)}`;
}

// Construit les transactions interprétées + statut doublon.
// Dédoublonnage multiset : une ligne n'est marquée doublon que si une copie
// identique existe DÉJÀ dans le store (les doublons légitimes intra-fichier,
// ex. deux virements identiques le même jour, sont conservés).
function interpret(){
  // index des transactions déjà en mémoire, par signature (multiset)
  const existingBySig = {};
  state.tx.forEach(t=>{ const s=signature(t); (existingBySig[s]=existingBySig[s]||[]).push(t); });
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
    const cat = categorize(extractTiers(rawTiers), note, type);
    const t = {date:d.disp, tiers:cat.tiers||rawTiers||'—', high:cat.high, sub:cat.sub, amount, account:importTargetAcct, note};
    // Entrée venant d'un copropriétaire → proposer « Charges » (paiement de charge) + l'attribuer.
    if (amount>0){ const det=detectOwner(t); if(det){ t.owner=det; if(t.high==='?'){ t.high='Charges'; t.sub=''; } } }
    const sig = signature(t);
    const matches = existingBySig[sig] || [];
    const used = usedCount[sig] || 0;
    if (used < matches.length){ t._dupe = true; t._match = matches[used]; usedCount[sig] = used + 1; } // doublon d'une tx existante
    else { t._dupe = false; }
    t._skip = false;   // exclu manuellement
    t._force = false;  // doublon réimporté volontairement
    out.push(t);
  });
  return out;
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
    <div class="alert" style="background:var(--green-soft);border-color:#BcD6c2;color:var(--green-deep)">
      <span class="ic">✓</span><div>Relevé détecté${m.holder?` — <b>${m.holder}</b>`:''}${m.iban?` · ${m.iban}`:''}.
      ${!isNaN(m.opening)?`Solde d'ouverture <b>${eur(m.opening)}</b>`:''}${!isNaN(m.closing)?` → clôture <b>${eur(m.closing)}</b>`:''}.
      ${(m.from||m.to)?` Période ${m.from} → ${m.to}.`:''}
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
    .lk{all:unset;cursor:pointer;font-size:12px;font-weight:600;color:var(--green)}
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
        ).join('')}</select>`;
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
      : (t._force?'<span class="badge" style="background:var(--clay-soft);color:#8A551F">Doublon forcé</span>':'<span class="badge b-ok">Nouvelle</span>');
    actions=`<button class="lk del" data-act="skip" data-i="${i}">supprimer</button>`;
  }
  const orig = isDupe && t._match
    ? `<div class="pv-orig">↳ déjà en mémoire : ${t._match.date} · ${t._match.tiers} · ${signed(t._match.amount)}</div>` : '';
  const ownerCell = (t.amount>0 && !t._skip && !isDupe)
    ? `<div class="cmt" style="font-style:normal;margin-top:3px"><span style="color:var(--ink-faint)">Versé par :</span> <select class="pv-owner" data-i="${i}">${ownerOptions(t.owner||'')}</select></div>` : '';
  return `<tr class="${cls}"><td>${t.date}</td><td><b>${t.tiers}</b>${ownerCell}${orig}</td>
    <td class="num ${isDupe?'':amtClass}">${signed(t.amount)}</td>
    <td>${catCell}</td><td>${status}</td>
    <td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;
}
function paintPreview(){
  ensurePreviewCss();
  const box=document.getElementById('previewBox');
  const {nNew,nDupe,nSkip,nUncat}=importStats();
  const m = importMeta||{};
  const ibanTail = m.iban ? normIban(m.iban).slice(-4) : '';
  const period = (m.from||m.to) ? `${m.from||'?'} → ${m.to||'?'}` : '';
  const balLine = !isNaN(m.opening) ? `ouverture ${eur(m.opening)} → clôture ${eur(m.closing)}` : '';
  // En-tête « relevé reconnu » + choix du compte (au lieu des 8 menus)
  const header = `
    <div class="card" style="margin-bottom:14px;background:var(--green-soft);border-color:#BcD6c2">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="font-size:26px;line-height:1">✓</div>
        <div style="flex:1;min-width:220px">
          <div style="font-family:'Fraunces',serif;font-weight:600;font-size:16px;color:var(--green-deep)">Relevé reconnu${m.holder?` — ${m.holder}`:''}</div>
          <div class="sub" style="color:var(--green-deep)">${parsedRows.length} mouvement(s)${ibanTail?` · IBAN …${ibanTail}`:''}${period?` · ${period}`:''}${balLine?` · ${balLine}`:''}</div>
        </div>
        <div style="text-align:right">
          <div class="l" style="font-size:11px;color:var(--green-deep)">${ibanDetected?'Compte (reconnu via l’IBAN)':'Sur quel compte ? (mémorisé)'}</div>
          <select class="fld" id="pvAcct" style="margin-top:4px;font-weight:600${ibanDetected?'':';border-color:var(--clay);box-shadow:0 0 0 3px var(--clay-soft)'}">
            <option value="pay" ${importTargetAcct==='pay'?'selected':''}>💳 Compte de paiement</option>
            <option value="res" ${importTargetAcct==='res'?'selected':''}>🏦 Compte de réserve</option>
          </select>
        </div>
      </div>
    </div>`;
  box.innerHTML = `
    ${header}
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
    t.high=s.value; learnCategory(t.tiers, s.value); paintPreview();
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
    .map(t=>{ const {_dupe,_match,_skip,_force, ...rest}=t; return rest; });
  if (!toAdd.length){ alert('Aucune transaction à importer.'); return; }
  const nextV = (state.imports[0]?.v || 0) + 1;
  const imp = {v:nextV, label:`Import ${new Date().toLocaleDateString('fr-BE')}`, meta:`${toAdd.length} transaction(s) ajoutée(s)`, cur:true};
  // mémoriser l'IBAN → compte (détection apprenante)
  const acct = importTargetAcct;
  const ibanKey = importMeta && importMeta.iban ? normIban(importMeta.iban) : null;
  const learnIban = ibanKey && (!state.ibanMap || state.ibanMap[ibanKey]!==acct);

  // Solde d'ouverture (au 1er relevé du compte), IBAN du compte, et clôture
  // du relevé (pour la réconciliation) — alimentés depuis le relevé.
  const settingsPatch = {};
  if (importMeta && !isNaN(importMeta.opening) && !((state.opening||{})[acct])){
    state.opening = {...(state.opening||{}), [acct]: importMeta.opening};
    settingsPatch[acct==='res'?'opening_res':'opening_pay'] = importMeta.opening;
  }
  if (importMeta && importMeta.iban && !((state.ibans||{})[acct])){
    state.ibans = {...(state.ibans||{}), [acct]: importMeta.iban};
    settingsPatch[acct==='res'?'iban_res':'iban_pay'] = importMeta.iban;
  }
  if (importMeta && !isNaN(importMeta.closing)){
    const asOf = importMeta.to || (toAdd.length ? toAdd[toAdd.length-1].date : '');
    state.recon = {...(state.recon||{}), [acct]: {closing: importMeta.closing, asOf}};
    settingsPatch.recon = state.recon;
  }

  if (writeToDb()){
    try {
      const saved = await window.LS.db.addTransactions(toAdd);   // renvoie les lignes avec id
      state.tx.push(...saved);
      await window.LS.db.clearCurrentImport();
      const savedImp = await window.LS.db.addImport(imp);
      state.imports.forEach(im=>im.cur=false);
      state.imports.unshift({id:savedImp.id, ...imp});
      if (learnIban){ state.ibanMap = {...(state.ibanMap||{}), [ibanKey]:acct}; settingsPatch.iban_map = state.ibanMap; }
      if (Object.keys(settingsPatch).length) await window.LS.db.updateSettings(settingsPatch);
    } catch(e){ console.error(e); alert('Import non enregistré : '+(e.message||e)); return; }
  } else {
    // démo ou hors-ligne : tout reste local
    state.tx.push(...toAdd.map((t,i)=>({id:'local-'+Date.now()+'-'+i, ...t})));
    state.imports.forEach(im=>im.cur=false);
    state.imports.unshift(imp);
    if (learnIban) state.ibanMap = {...(state.ibanMap||{}), [ibanKey]:acct};
    saveState();
  }
  resetImport();
  renderAll();
  // Alerte de réconciliation : solde calculé vs clôture du relevé
  const rs = reconStatus(acct);
  let msg = `✓ ${toAdd.length} transaction(s) ${demoMode?'ajoutées (démo, non enregistrées en base)':'sauvegardée(s) — version v'+nextV+' créée'}.`;
  if (rs && !rs.ok){
    msg += `\n\n⚠ DÉSÉQUILIBRE sur le ${acct==='res'?'compte de réserve':'compte de paiement'} : `
      + `solde calculé ${eur(balance(acct))} ≠ clôture du relevé ${eur(rs.closing)} (écart ${rs.diff>0?'+':''}${eur(rs.diff)}).`
      + `\nVérifiez une transaction manquante, en double, ou un solde d'ouverture erroné.`;
  } else if (rs && rs.ok){
    msg += `\n\n✓ Réconcilié : le solde calculé correspond à la clôture du relevé.`;
  }
  alert(msg);
}

function resetImport(){
  parsedRows = parsedHeaders = mapping = interpreted = importMeta = null;
  dateOrder = 'dmy';
  const after = document.getElementById('afterDrop');
  if (after){ after.style.display='none'; const live=document.getElementById('importLive'); if(live) live.remove(); }
}

// Lecture d'un fichier déposé / choisi (CSV ou PDF)
function handleFile(file){
  if (!file) return;
  const isPdf = /\.pdf$/i.test(file.name||'') || file.type==='application/pdf';
  const reader = new FileReader();
  reader.onload = async e=>{
    let headers, data, meta;
    try {
      if (isPdf){
        ({headers, data, meta} = await parsePdfStatement(e.target.result));
      } else {
        const rows = parseCSV(e.target.result);
        if (rows.length < 2){ alert('Fichier vide ou illisible.'); return; }
        ({headers, data, meta} = detectTable(rows));
      }
    } catch(err){ console.error(err); alert('Lecture du fichier impossible : '+(err.message||err)); return; }
    if (!data || !data.length){ alert('Aucune transaction détectée dans ce fichier.'); return; }
    parsedHeaders = headers.map(h=>String(h).trim());
    parsedRows = data;
    importMeta = meta;
    mapping = guessMapping(parsedHeaders);
    if (mapping.date<0) mapping.date=0;
    if (mapping.amount<0 && mapping.credit<0 && mapping.debit<0) mapping.amount=Math.min(parsedHeaders.length-1, 2);
    dateOrder = detectDateOrder(parsedRows.map(r=>r[mapping.date]));
    // détection du compte via l'IBAN (apprise aux imports précédents)
    ibanDetected = false;
    const key = meta && meta.iban ? normIban(meta.iban) : null;
    if (key && state.ibanMap && state.ibanMap[key]){ importTargetAcct = state.ibanMap[key]; ibanDetected = true; }
    // Format Syndic4you/Swan reconnu (Date + Crédit + Débit présents) → on saute
    // l'association manuelle et on va droit à l'aperçu. Sinon : mapping manuel.
    recognizedFormat = mapping.date>=0 && mapping.credit>=0 && mapping.debit>=0;
    showImportScreen();
    if (recognizedFormat) showPreview();
    else showMapping();
  };
  if (isPdf) reader.readAsArrayBuffer(file); else reader.readAsText(file, 'utf-8');
}

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
   ASSEMBLÉES GÉNÉRALES  (inchangé — démo interactive)
   ============================================================ */
/* ===== Assemblées générales (persistées en base) ===== */
const MAJ={simple:'Majorité simple',absolue:'Majorité absolue',deuxtiers:'Double tiers',quatrecinq:'Quatre cinquièmes',unanime:'Unanimité'};
const MAJPCT={simple:50,absolue:51,deuxtiers:67,quatrecinq:80,unanime:100};
const AG_STATUS={prep:'En cours de préparation',convoquee:'Convocations envoyées',tenue:'Séance tenue',finalisee:'AG finalisée'};
function agTotalQuot(){ return sum(ownersOf().map(o=>o.q))||1000; }
function majNeed(maj){ const tot=agTotalQuot();
  if(maj==='unanime') return tot;
  if(maj==='quatrecinq') return Math.ceil(tot*4/5);
  if(maj==='deuxtiers') return Math.ceil(tot*2/3);
  return Math.floor(tot/2)+1; // simple / absolue : > moitié
}
function agOwnerList(){ return ownersOf().map(o=>({n:o.n, short:o.short||o.n, q:o.q, c:o.c})); }
function majOptions(sel){return Object.entries(MAJ).map(([k,v])=>`<option value="${k}" ${k===sel?'selected':''}>${v}</option>`).join('');}

let curStep=1;
let currentAG=null;
function pickCurrentAG(){ currentAG=(state.ags||[]).find(a=>a.status!=='finalisee')||null; }

function setAgStatus(status){
  const st=document.getElementById('agStatus'); if(!st) return;
  const map={prep:['var(--coral-soft)','#E8BDB4','#8C342A','var(--coral)'],
             convoquee:['var(--clay-soft)','#E0C49B','#8A551F','var(--clay)'],
             tenue:['var(--clay-soft)','#E0C49B','#8A551F','var(--clay)'],
             finalisee:['var(--green-soft)','#BcD6c2','var(--green-deep)','var(--green)']};
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
      <h2 style="font-family:'Fraunces',serif;font-size:20px;margin-top:8px">Aucune assemblée en cours</h2>
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
        <span style="font-family:'Fraunces',serif;font-weight:600;color:var(--ink-faint)">${i+1}</span>
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

document.getElementById('genConv')?.addEventListener('click',()=>{
  if(!currentAG){ alert('Aucune assemblée.'); return; }
  const points=currentAG.points.map((p,i)=>`${i+1}. ${p.title}${p.kind==='decision'?' ('+MAJ[p.majorite]+')':' (information)'}`).join('\n');
  const cn=(state.coproName||'').trim()||'la copropriété';
  const m=(window.LS&&window.LS.member)||{};
  const syndic=(m.full_name||'').trim()||'Le syndic';
  const syndicEmail=m.userEmail||m.email||'syndic@exemple.be';
  const dateHeure=currentAG.ag_date||'(date à préciser)';
  const lieu=currentAG.lieu||'(lieu à préciser)';
  const dest=ownersOf().map(o=>o.n).filter(n=>n!==m.full_name).join(', ');
  const eml=`From: ${syndic} (Syndic) <${syndicEmail}>
To: ${dest}
Subject: Convocation - Assemblee generale ${currentAG.type||'ordinaire'} - ${cn} - ${dateHeure}
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"

Madame, Monsieur, cher coproprietaire,

En ma qualite de syndic de ${cn}, j'ai l'honneur de vous convoquer a
l'assemblee generale qui se tiendra :

    Date : ${dateHeure}
    Lieu : ${lieu}

Conformement au reglement d'ordre interieur, cette convocation vous est adressee
au moins 15 jours avant l'assemblee.

ORDRE DU JOUR
-------------
${points}

Tout coproprietaire empeche peut se faire representer par procuration ecrite.

Salutations distinguees,
${syndic} - Syndic, ${cn}
`;
  const blob=new Blob([eml],{type:'message/rfc822'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='convocation-AG.eml';
  document.body.appendChild(a); a.click(); a.remove();
  if(canWrite() && currentAG.status==='prep'){
    currentAG.status='convoquee'; currentAG.convocation_date=new Date().toLocaleDateString('fr-BE');
    setAgStatus('convoquee');
    dbWrite(db=>db.agUpdate(currentAG.id,{status:'convoquee',convocation_date:currentAG.convocation_date}));
  }
});

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
        setPresence(short,{status:stt}); computeQuorum();
      });
    });
    wrap.querySelectorAll('.pres-mand').forEach(inp=>inp.onchange=()=>{
      const short=inp.closest('.repname').dataset.short; setPresence(short,{mandataire:inp.value});
    });
  }
  computeQuorum();
}
function computeQuorum(){
  if(!currentAG) return;
  const pres=currentAG.presence||{}; let q=0;
  agOwnerList().forEach(o=>{ const s=(pres[o.short]&&pres[o.short].status)||'pre'; if(s==='pre'||s==='rep') q+=o.q; });
  const tot=agTotalQuot();
  const qn=document.getElementById('quorumNum'); if(qn) qn.textContent=q;
  const card=document.getElementById('quorumCard'),ok=q>=Math.floor(tot/2)+1;
  const qt=document.getElementById('quorumTxt'); if(qt) qt.textContent=ok?'Quorum atteint — la séance peut délibérer':'Quorum non atteint';
  if(card){card.style.background=ok?'var(--green-soft)':'var(--coral-soft)';card.style.borderColor=ok?'#BcD6c2':'#E8BDB4';}
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
        const v=(p.votes&&p.votes[o.short])||'pour';
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2)">
          <span class="a" style="width:24px;height:24px;background:${o.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700">${(o.n||'?')[0]}</span>
          <span style="font-size:13.5px;flex:1">${o.n} <span style="color:var(--ink-faint)">· ${o.q}</span></span>
          <div class="seg vote" data-pt="${idx}" data-short="${o.short}" data-q="${o.q}">
            <button data-v="pour" class="${v==='pour'?'on':''} vp">Pour</button>
            <button data-v="contre" class="${v==='contre'?'on':''} vc">Contre</button>
            <button data-v="abst" class="${v==='abst'?'on':''} va">Abst.</button>
          </div></div>`;}).join('')}
        <div class="verdict" data-pt="${idx}" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:10px 14px;background:var(--green-soft);border-radius:11px">
          <span style="font-size:13px;color:var(--ink-soft)">Pour : <b class="pourq">0</b>/${agTotalQuot()} · requis ${majNeed(p.majorite)} (${MAJ[p.majorite]})</span>
          <span class="vbadge badge b-ok">Adopté</span></div></div>`;
    } else votesHtml='<div class="sub" style="margin-top:8px">Point informatif — pas de vote</div>';
    card.innerHTML=`<div style="display:flex;align-items:center;gap:10px"><span style="font-family:'Fraunces',serif;font-weight:600;color:var(--ink-faint)">${idx+1}</span>
      <b style="flex:1;font-size:14.5px">${p.title}</b>${isDec?`<span class="cat acp">${MAJ[p.majorite]}</span>`:'<span class="cat ent">Information</span>'}</div>
      <div ${ro?'':'contenteditable'} class="fld pt-snotes" style="width:100%;margin-top:10px;min-height:38px;font-size:13px;color:var(--ink-soft)">${p.seance_notes||''}</div>${votesHtml}`;
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
  let pour=0; agOwnerList().forEach(o=>{ const v=(p.votes&&p.votes[o.short])||'pour'; if(v==='pour') pour+=o.q; });
  const need=majNeed(p.majorite);
  const v=document.querySelector(`.verdict[data-pt="${idx}"]`); if(!v) return;
  v.querySelector('.pourq').textContent=pour;
  const ok=pour>=need; const badge=v.querySelector('.vbadge');
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
    if(p.kind==='decision'){ let pour=0; owners.forEach(o=>{const v=(p.votes&&p.votes[o.short])||'pour'; if(v==='pour')pour+=o.q;});
      const ok=pour>=majNeed(p.majorite); dec=`<div><b>Décision :</b> ${ok?'ADOPTÉ':'REJETÉ'} (${pour}/${agTotalQuot()} pour · ${MAJ[p.majorite]})</div>`; }
    return `<div style="margin:14px 0"><b>${i+1}. ${p.title}</b>${p.body?`<div style="color:#555">${p.body}</div>`:''}${p.seance_notes?`<div style="font-style:italic">Notes : ${p.seance_notes}</div>`:''}${dec}</div>`;
  }).join('');
  const html=`<html><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif;max-width:720px;margin:auto">
    <h1>Procès-verbal — ${currentAG.type||''} ${cn}</h1>
    <p><b>Date :</b> ${currentAG.ag_date||''}<br><b>Lieu :</b> ${currentAG.lieu||''}</p>
    <h2>Présences</h2><table border="1" cellpadding="6" cellspacing="0"><tr><th>Copropriétaire</th><th>Quotité</th><th>Statut</th></tr>${presRows}</table>
    <h2>Ordre du jour & décisions</h2>${ptRows}
    <br><br><table width="100%"><tr><td>Le président</td><td>Le secrétaire</td><td>Le commissaire</td></tr></table>
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
    let pour=0; agOwnerList().forEach(o=>{const v=(p.votes&&p.votes[o.short])||'pour'; if(v==='pour')pour+=o.q;});
    p.decision = pour>=majNeed(p.majorite)?'Adopté':'Rejeté';
    dbWrite(db=>db.agPointUpdate(p.id,{decision:p.decision, votes:p.votes||{}}));
  }});
  currentAG.status='finalisee';
  dbWrite(db=>db.agUpdate(currentAG.id,{status:'finalisee'}));
  alert('✓ AG finalisée et archivée. Vous pouvez en créer une nouvelle.');
  curStep=1; renderAG();
});

function renderAGArchive(){
  const box=document.getElementById('agArchive'); if(!box) return;
  const done=(state.ags||[]).filter(a=>a.status==='finalisee');
  if(!done.length){ box.innerHTML='<div class="sub" style="padding:14px">Aucune assemblée archivée pour le moment.</div>'; return; }
  box.innerHTML=done.map(a=>{
    const pres=a.presence||{}; const n=Object.values(pres).filter(x=>x&&(x.status==='pre'||x.status==='rep')).length;
    const adopted=a.points.filter(p=>p.decision==='Adopté').length, dec=a.points.filter(p=>p.kind==='decision').length;
    return `<div class="hist"><span class="v" style="width:auto">${a.ag_date||a.type||'AG'}</span><div><b>${a.title||'Assemblée générale'}</b><div class="meta">${a.points.length} point(s) · ${n} présent(s)/représenté(s) · ${adopted}/${dec} décision(s) adoptée(s)</div></div></div>`;
  }).join('');
}


/* ============================================================
   CONTRATS (persistés)
   ============================================================ */
const TYPECLASS={'Énergie':'','Assurance':'ass','Entretien':'ent','Autre':'acp'};
function ctRow(c,idx){
  const tc=TYPECLASS[c.type]||'';
  if(c.status==='actif'){
    return `<tr><td><b>${c.name}</b><div class="sub" style="margin-top:2px">réf. ${c.ref}</div></td>
      <td><span class="cat ${tc}">${c.type}</span></td><td>${c.start}</td>
      <td style="color:var(--ink-soft);font-style:italic">${c.note||''}</td>
      <td><span class="badge b-ok">Actif</span></td>
      <td style="text-align:right"><button class="rb" style="background:var(--coral-soft);color:var(--coral)" onclick="openClose(${idx})">Clôturer</button></td></tr>`;
  }
  return `<tr style="opacity:.85"><td><b>${c.name}</b><div class="sub" style="margin-top:2px">réf. ${c.ref}</div></td>
    <td><span class="cat ${tc}">${c.type}</span></td><td>${c.start} → ${c.end}</td>
    <td style="color:var(--ink-soft);font-style:italic">${c.endNote||c.note||''}</td>
    <td><span class="badge" style="background:var(--line-2);color:var(--ink-faint)">Clôturé</span></td><td></td></tr>`;
}
function renderContracts(){
  const head=`<tr><th>Contrat</th><th>Type</th><th>Période</th><th>Commentaire</th><th>Statut</th><th></th></tr>`;
  const C=state.contracts;
  const act=C.filter(c=>c.status==='actif'),clo=C.filter(c=>c.status==='cloture');
  const ab=document.getElementById('ctActiveBody'); if(!ab) return;
  ab.innerHTML=head+act.map(c=>ctRow(c,C.indexOf(c))).join('');
  document.getElementById('ctClosedBody').innerHTML=head+(clo.length?clo.map(c=>ctRow(c,C.indexOf(c))).join(''):'<tr><td colspan="6" class="sub" style="padding:14px">Aucun contrat clôturé.</td></tr>');
  document.getElementById('ctActiveN').textContent=act.length;
  document.getElementById('ctClosedN').textContent=clo.length;
}
document.getElementById('ctAdd')?.addEventListener('click',()=>{
  if(!canWrite()){ alert('Lecture seule.'); return; }
  const name=document.getElementById('ctName').value.trim();
  if(!name){document.getElementById('ctName').focus();return;}
  const c={name,ref:document.getElementById('ctRef').value||'—',type:document.getElementById('ctType').value,
    start:document.getElementById('ctStart').value||'—',note:document.getElementById('ctNote').value,status:'actif'};
  state.contracts.unshift(c);
  ['ctName','ctRef','ctStart','ctNote'].forEach(id=>document.getElementById(id).value='');
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
const MARGIN=1.04;
const ownersById = ()=>{ const m={}; ownersOf().forEach(o=>{ if(o.id) m[o.id]=o; }); return m; };
const lotsOf = ()=> state.lots || [];

// --- Onglet « Copropriétaires & lots » (référentiel réel) ---
function renderBudgetOwn(){
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
    ot.innerHTML='<tr><th>Propriétaire</th><th>Lots détenus</th><th class="num">Quotité cumulée</th></tr>'
      + ow.map(o=>{
          const mine=lotsOf().filter(l=>l.owner_id===o.id).map(l=>l.designation||l.label).join(', ')||'—';
          return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${(o.short||o.n||'?')[0]}</span> ${o.n}</div></td><td>${mine}</td><td class="num">${o.q}</td></tr>`;
        }).join('');
  }
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
function budgetPostes(){
  const by={};
  state.tx.filter(t=>t.amount<0).forEach(t=>{
    const label=(t.high==='?'?'À catégoriser':t.high)+(t.sub?(' · '+t.sub):'');
    by[label]=by[label]||{label, high:t.high, r:0};
    by[label].r+=Math.abs(t.amount);
  });
  return Object.values(by).sort((a,b)=>b.r-a.r).map(p=>({...p, k:(state.budgetKeys&&state.budgetKeys[p.label])||defaultKey(p.high)}));
}
function persistBudgetKeys(){
  if(!ONLINE) return;
  window.LS.db.updateSettings({budget_keys: state.budgetKeys}).catch(()=>{}); // best-effort
}
function renderBudget(){
  const t=document.getElementById('budTable'); if(!t) return;
  const ow=ownersOf(); const tot=sum(ow.map(o=>o.q))||1000, n=ow.length||1;
  const postes=budgetPostes();
  t.innerHTML='<tr><th>Poste</th><th>Clé</th><th class="num">Réalité</th><th class="num">Budget (+4 %)</th></tr>';
  if (!postes.length){
    t.insertAdjacentHTML('beforeend','<tr><td colspan="4" class="sub" style="padding:14px">Aucune dépense enregistrée — importez un relevé pour bâtir le budget.</td></tr>');
  }
  postes.forEach((po,i)=>{
    const bud=po.r*MARGIN;
    t.insertAdjacentHTML('beforeend',`<tr><td>${po.label}</td>
      <td><select class="fld budkey" data-i="${i}"><option value="quote" ${po.k==='quote'?'selected':''}>Quote-part</option><option value="indiv" ${po.k==='indiv'?'selected':''}>Individuelle</option></select></td>
      <td class="num">${eur(po.r)}</td><td class="num"><b>${eur(bud)}</b></td></tr>`);
  });
  t.querySelectorAll('.budkey').forEach(s=>s.onchange=()=>{
    if(!canWrite()){ s.value=postes[s.dataset.i].k; alert('Lecture seule.'); return; }
    state.budgetKeys=state.budgetKeys||{}; state.budgetKeys[postes[s.dataset.i].label]=s.value;
    persistBudgetKeys(); renderBudget();
  });
  const split={}; ow.forEach(o=>split[o.short||o.n]=0);
  postes.forEach(po=>{ const bud=po.r*MARGIN;
    ow.forEach(o=>{ split[o.short||o.n]+= po.k==='indiv' ? bud/n : bud*o.q/tot; });
  });
  const ot=document.getElementById('budOwners'); if(!ot) return;
  ot.innerHTML='<tr><th>Propriétaire</th><th class="num">Charge annuelle</th><th class="num">Mensualité</th></tr>'
    + ow.map(o=>{ const k=o.short||o.n; return `<tr><td><div class="who"><span class="a" style="width:24px;height:24px;background:${o.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700">${k[0]}</span> ${o.n}</div></td>
      <td class="num"><b>${eur(split[k]||0)}</b></td><td class="num">${eur((split[k]||0)/12)}</td></tr>`; }).join('');
}
// Provisions attendues par copropriétaire (le « dû »), éditable par l'admin.
function renderProvisions(){
  const t=document.getElementById('provTable'); if(!t) return;
  const ed=canWrite(); const led=ownerLedger();
  if(!led.length){ t.innerHTML='<tr><td class="sub" style="padding:14px">Aucun propriétaire enregistré.</td></tr>'; return; }
  t.innerHTML='<tr><th>Propriétaire</th><th class="num">Dû — paiement</th><th class="num">Dû — réserve</th><th class="num">Total dû</th><th class="num">Versé</th><th class="num">Solde</th></tr>'
    + led.map(o=>{
      const late=o.solde<-0.005;
      return `<tr><td><div class="who"><span class="a" style="background:${o.c}">${(o.short||o.n||'?')[0]}</span> ${o.n}</div></td>
        <td class="num"><input class="fld prov-pay" ${ed?'':'disabled'} data-id="${o.id||''}" value="${(o.due_pay||0).toFixed(2)}" style="width:92px;text-align:right"></td>
        <td class="num"><input class="fld prov-res" ${ed?'':'disabled'} data-id="${o.id||''}" value="${(o.due_res||0).toFixed(2)}" style="width:92px;text-align:right"></td>
        <td class="num">${eur(o.due)}</td>
        <td class="num">${eur(o.verse)}</td>
        <td class="num"${late?' style="color:var(--coral)"':''}>${o.solde<0?'−':''}${eur(Math.abs(o.solde))}</td></tr>`;
    }).join('');
  if(ed){
    t.querySelectorAll('.prov-pay').forEach(inp=>inp.onchange=()=>saveProvision(inp,'due_pay'));
    t.querySelectorAll('.prov-res').forEach(inp=>inp.onchange=()=>saveProvision(inp,'due_res'));
  }
}
function saveProvision(inp, field){
  const id=inp.dataset.id, v=parseAmount(inp.value);
  if(isNaN(v)){ renderProvisions(); return; }
  const o=(state.owners||[]).find(x=>x.id===id); if(o) o[field]=v;
  dbWrite(db=>db.updateOwner(id,{[field]:v}));
  renderProvisions(); renderDashboard();
}
// genBudget câblé dans la section GÉNÉRATEUR DE RAPPORTS (Annexe 4).

/* ============================================================
   RÈGLES & ALIAS (persistés)
   ============================================================ */
function renderRules(){
  const t=document.getElementById('ruleTable'); if(!t) return;
  t.innerHTML='<tr><th>Tiers (libellé)</th><th>Catégorie</th><th>Sous-catégorie</th><th></th></tr>';
  state.rules.forEach((r,i)=>t.insertAdjacentHTML('beforeend',`<tr data-i="${i}"><td><input class="fld rl-label" value="${r[0]}" style="width:160px;font-weight:600"></td>
    <td><select class="fld rl-cat">${allCats().map(c=>`<option ${c===r[1]?'selected':''}>${c}</option>`).join('')}</select></td>
    <td><input class="fld rl-sub" value="${r[2]||''}" style="width:140px"></td>
    <td style="text-align:right"><button class="flagbtn rl-del" style="opacity:.5">✕</button></td></tr>`));
  t.querySelectorAll('tr[data-i]').forEach(tr=>{
    const i=+tr.dataset.i;
    const rid=()=>state.rules[i][3];
    tr.querySelector('.rl-label').onchange=e=>{if(!canWrite())return;state.rules[i][0]=e.target.value;saveState();dbWrite(db=>db.updateRule(rid(),{label:e.target.value}));};
    tr.querySelector('.rl-cat').onchange=e=>{if(!canWrite())return;state.rules[i][1]=e.target.value;saveState();dbWrite(db=>db.updateRule(rid(),{high:e.target.value}));};
    tr.querySelector('.rl-sub').onchange=e=>{if(!canWrite())return;state.rules[i][2]=e.target.value;saveState();dbWrite(db=>db.updateRule(rid(),{sub:e.target.value}));};
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
function renderChrome(){
  const m = (window.LS && window.LS.member) || null;
  const prenom = m ? (((m.full_name||'').trim().split(/\s+/)[0]) || m.owner_short || m.userEmail) : '';
  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('greet', prenom ? `Bonjour ${prenom} 👋` : 'Bonjour 👋');
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
function renderAll(){
  renderChrome();
  renderDashboard();
  renderReminders();
  refreshAccountChrome();
  renderTx(curAcct);
  renderChart(curAcct);
  renderContracts();
  renderRules();
  renderAliases();
  renderBudgetOwn();
  renderKeys();
  renderBudget();
  renderProvisions();
  renderAG();
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
async function bootData(){
  if (demoMode){
    state = loadDemoState();
    OWNERS = (state.owners && state.owners.length) ? state.owners
      : [{n:'Alex Martin',short:'Alex',q:500,c:'#2F6B53'},{n:'Sam Bernard',short:'Sam',q:251,c:'#5B4B86'},{n:'Lou Petit',short:'Lou',q:249,c:'#C9854A'}];
  } else {
    try {
      state = await window.LS.db.loadAll();
      if (state.owners && state.owners.length) OWNERS = state.owners;
    } catch(e){
      console.error(e);
      alert('Chargement des données impossible : '+(e.message||e));
      state = freshState();
    }
  }
  applyRoleUI();
  applyDemoUI();
  renderAll();
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
    #loginOverlay{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center;
      background:var(--green-deep);background-image:radial-gradient(circle at 1px 1px,rgba(255,255,255,.05) 1px,transparent 0);background-size:22px 22px;padding:20px}
    #loginOverlay.on{display:flex}
    .login-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);width:380px;max-width:92vw;padding:30px 30px 26px}
    .login-card .brand{font-family:'Fraunces',serif;font-size:27px;font-weight:600}
    .login-card .brand .z{font-style:italic;color:var(--clay)}
    .login-card .sub{font-size:13px;color:var(--ink-soft);margin:2px 0 20px}
    .login-card label{font-size:12px;color:var(--ink-faint)}
    .login-card input{width:100%;font-family:inherit;font-size:14px;padding:11px 13px;border:1px solid var(--line);border-radius:11px;background:var(--card-2);margin:4px 0 14px}
    .login-card .btn{width:100%;justify-content:center}
    .login-msg{font-size:12.5px;margin-top:12px;min-height:16px}
    .login-msg.err{color:var(--coral)} .login-msg.ok{color:var(--green)}
    .login-alt{margin-top:14px;text-align:center;font-size:12.5px;color:var(--ink-soft)}
    .login-alt a{color:var(--green);font-weight:600;cursor:pointer}
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
  ov.innerHTML=`<div class="login-card">
    <div class="brand">Lazy<span class="z">Syndic</span></div>
    <div class="sub">La copropriété en pilote automatique</div>
    <div id="pwBox">
      <label>Email</label><input id="loginEmail" type="email" placeholder="vous@exemple.be" autocomplete="username">
      <label>Mot de passe</label><input id="loginPw" type="password" placeholder="••••••" autocomplete="current-password">
      <button class="btn btn-primary" id="loginBtn">Se connecter</button>
      <div class="login-alt"><a id="toMagic">Recevoir un lien magique par email →</a></div>
    </div>
    <div id="magicBox" style="display:none">
      <label>Email</label><input id="magicEmail" type="email" placeholder="vous@exemple.be" autocomplete="username">
      <button class="btn btn-primary" id="magicBtn">Envoyer le lien de connexion</button>
      <div class="login-alt"><a id="toPw">← Connexion par mot de passe</a></div>
    </div>
    <div class="login-msg" id="loginMsg"></div>
  </div>`;
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
  window.LS.auth.onChange(async (s)=>{
    if (s){
      let member=null;
      try { member = await window.LS.db.loadMember(); } catch(e){ console.error(e); }
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
      // le mode démo est réservé à l'admin réel
      if (demoMode && member.role!=='admin'){ demoMode=false; localStorage.removeItem(DEMO_FLAG); }
      const demoTag = demoMode ? ' · <b style="color:var(--clay)">🧪 Démo</b>' : '';
      bar.querySelector('#sbWho').innerHTML = `${member.full_name||member.userEmail} ${member.role==='admin'?'· <b>Syndic</b>':'· <span class="ro">Lecture seule</span>'}${demoTag}`;
      await bootData();          // charge les données
      ov.classList.remove('on');
      bar.classList.add('on');
      unlockApp();               // l'app n'apparaît qu'ici, membre confirmé + données chargées
    } else {
      // déconnecté : on reverrouille et on remet le login
      lockApp(); bar.classList.remove('on'); ov.classList.add('on');
    }
  });
}
boot();

/* ============================================================
   GÉNÉRATEUR DE RAPPORTS (PDF via impression navigateur)
   Tout est dérivé du store, filtré sur la période choisie.
   ============================================================ */
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
    .report-toolbar .rt-title{margin-right:auto;color:#EAF1E8;font-family:'Fraunces',serif;font-size:16px}
    .report-sheet{max-width:820px;margin:0 auto;background:#fff;color:#20251F;padding:46px 52px;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-size:13px;line-height:1.5}
    .report-sheet h1{font-family:'Fraunces',serif;font-size:26px;font-weight:600;margin:0 0 2px}
    .report-sheet h2{font-family:'Fraunces',serif;font-size:16px;font-weight:600;margin:26px 0 8px;padding-bottom:5px;border-bottom:2px solid #21503D;color:#21503D}
    .report-sheet .r-sub{color:#5C6153;font-size:12px}
    .report-sheet table{width:100%;border-collapse:collapse;margin-top:6px}
    .report-sheet th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#5C6153;text-align:left;padding:6px 8px;border-bottom:1.5px solid #20251F}
    .report-sheet td{padding:5px 8px;border-bottom:1px solid #E6DECE;font-size:12px}
    .report-sheet td.num,.report-sheet th.num{text-align:right;font-variant-numeric:tabular-nums}
    .report-sheet tr.tot td{font-weight:700;border-top:1.5px solid #20251F;border-bottom:none}
    .report-sheet .pos{color:#2F6B53}.report-sheet .neg{color:#C2564A}
    .report-sheet .r-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px double #21503D;padding-bottom:14px;margin-bottom:6px}
    .report-sheet .r-brand{font-family:'Fraunces',serif;font-size:20px;color:#21503D}
    .report-sheet .r-brand .z{font-style:italic;color:#C9854A}
    .report-sheet .chip{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:#E2ECE3;color:#21503D}
    .report-sheet .sig{display:flex;gap:40px;margin-top:40px;flex-wrap:wrap}
    .report-sheet .sig div{flex:1;min-width:180px;border-top:1px solid #20251F;padding-top:6px;font-size:11.5px;color:#5C6153}
    .report-sheet .r-foot{margin-top:34px;padding-top:10px;border-top:1px solid #E6DECE;font-size:10.5px;color:#8A8F80;text-align:center}
    @media print{
      body.report-open .app, body.report-open #ctModal{display:none !important}
      body.report-open #reportModal{position:static;display:block !important;background:#fff;padding:0;overflow:visible}
      body.report-open .report-toolbar{display:none !important}
      body.report-open .report-sheet{box-shadow:none;max-width:none;margin:0;padding:0;border-radius:0}
      body.report-open .report-sheet h2{break-after:avoid}
      body.report-open .report-sheet tr{break-inside:avoid}
      @page{margin:16mm 14mm}
    }`;
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
    const f = document.getElementById('repFrom'), t = document.getElementById('repTo');
    const fd = parseDate(f?f.value:'01/01/2025') || parseDate('01/01/2025');
    const td = parseDate(t?t.value:'31/12/2025') || parseDate('31/12/2025');
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
  function headEl(title, p){
    return `<div class="r-head">
      <div><div class="r-brand">Lazy<span class="z">Syndic</span></div>
        <div style="margin-top:6px"><b>${COPRO().name}</b>${(COPRO().addr||COPRO().kbo)?`<div class="r-sub">${[COPRO().addr,COPRO().kbo].filter(Boolean).join(' · ')}</div>`:''}</div></div>
      <div style="text-align:right"><span class="chip">${title}</span>
        <div class="r-sub" style="margin-top:8px">Période : <b>${p.label}</b></div>
        <div class="r-sub">Édité le 4 juin 2026</div></div>
    </div>
    <h1 style="margin-top:18px">${title}</h1>`;
  }
  function soldesSection(accts, p){
    const rows = accts.map(a=>{
      const s = acctSummary(a.key, p);
      return `<tr><td><b>${a.label}</b></td>
        <td class="num">${eur(s.opening)}</td>
        <td class="num pos">+${eur(s.rec)}</td>
        <td class="num neg">−${eur(s.dep)}</td>
        <td class="num"><b>${eur(s.closing)}</b></td></tr>`;
    }).join('');
    return `<h2>Soldes — ouverture / clôture</h2>
      <table><tr><th>Compte</th><th class="num">Ouverture</th><th class="num">Recettes</th><th class="num">Dépenses</th><th class="num">Clôture</th></tr>${rows}</table>`;
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
    const led = ownerLedger();
    const rows = led.map(o=>`<tr><td>${o.n}</td><td class="num">${o.q}/1000</td>
      <td class="num">${eur(o.due)}</td><td class="num">${eur(o.verse)}</td>
      <td class="num ${o.solde<0?'neg':'pos'}">${o.solde<0?'−':''}${eur(Math.abs(o.solde))}</td>
      <td>${o.solde<-0.005?'En retard':'À jour'}</td></tr>`).join('');
    const tDue=sum(led.map(o=>o.due)), tVer=sum(led.map(o=>o.verse));
    return `<h2>Récapitulatif par copropriétaire</h2>
      <table><tr><th>Copropriétaire</th><th class="num">Quotité</th><th class="num">Dû</th><th class="num">Versé</th><th class="num">Solde</th><th>Statut</th></tr>
        ${rows}
        <tr class="tot"><td>Total</td><td class="num">1000/1000</td><td class="num">${eur(tDue)}</td><td class="num">${eur(tVer)}</td><td class="num">${eur(tVer-tDue)}</td><td></td></tr>
      </table>`;
  }
  function annexeTxSection(acct, p, title){
    const s = acctSummary(acct, p);
    const rows = s.tx.map(t=>`<tr><td>${t.date}</td><td>${t.tiers}</td>
      <td>${t.high}${t.sub?(' · '+t.sub):''}</td>
      <td class="num ${t.amount>=0?'pos':'neg'}">${signed(t.amount)}</td>
      <td>${t.note||''}</td></tr>`).join('') || '<tr><td colspan="5" class="r-sub">Aucune transaction sur la période.</td></tr>';
    return `<h2>${title}</h2>
      <div class="r-sub">Ouverture ${eur(s.opening)} · ${s.tx.length} mouvement(s) · clôture ${eur(s.closing)}</div>
      <table><tr><th>Date</th><th>Tiers</th><th>Catégorie</th><th class="num">Montant</th><th>Communication</th></tr>${rows}</table>`;
  }
  function budgetSection(){
    const ow=ownersOf(); const tot=sum(ow.map(o=>o.q))||1000, n=ow.length||1;
    const postes=budgetPostes();
    const rows = postes.map(po=>{
      const bud=po.r*MARGIN;
      const key = po.k==='indiv'?('Individuelle (÷'+n+')'):'Quote-part (millièmes)';
      return `<tr><td>${po.label}</td><td>${key}</td><td class="num">${eur(po.r)}</td><td class="num"><b>${eur(bud)}</b></td></tr>`;
    }).join('') || '<tr><td colspan="4" class="r-sub">Aucune dépense sur la période.</td></tr>';
    const split={}; ow.forEach(o=>split[o.short||o.n]=0);
    postes.forEach(po=>{ const bud=po.r*MARGIN; ow.forEach(o=>{ split[o.short||o.n]+= po.k==='indiv'?bud/n:bud*o.q/tot; }); });
    const totR=sum(postes.map(p=>p.r)), totB=totR*MARGIN;
    const owRows = ow.map(o=>{ const k=o.short||o.n; return `<tr><td>${o.n}</td><td class="num"><b>${eur(split[k]||0)}</b></td><td class="num">${eur((split[k]||0)/12)}</td></tr>`; }).join('');
    return `<h2>Annexe 4 — Budget prévisionnel (marge +4 %)</h2>
      <table><tr><th>Poste</th><th>Clé de répartition</th><th class="num">Réalité</th><th class="num">Budget</th></tr>
        ${rows}<tr class="tot"><td>Total</td><td></td><td class="num">${eur(totR)}</td><td class="num">${eur(totB)}</td></tr></table>
      <h2 style="font-size:14px;border:none;color:#20251F;margin-top:18px">Charge annuelle par copropriétaire</h2>
      <table><tr><th>Copropriétaire</th><th class="num">Charge annuelle</th><th class="num">Mensualité</th></tr>${owRows}</table>`;
  }
  function signatures(){
    return `<div class="sig">
      <div>Le président de séance</div><div>Le secrétaire</div><div>Le commissaire aux comptes</div>
    </div>`;
  }
  function foot(){ return `<div class="r-foot">Document généré par LazySyndic — ${COPRO().name}. Les annexes 2, 3 et 4 sont calculées depuis le registre des transactions sur la période indiquée.</div>`; }

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
        + annexeTxSection('pay',p,'Annexe 2 — Transactions du compte de paiement')
        + annexeTxSection('res',p,'Annexe 3 — Transactions du compte de réserve')
        + budgetSection()
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
      title = 'Budget prévisionnel (Annexe 4)';
      body = headEl(title,p) + budgetSection() + foot();
    }
    return {title, body};
  }
  function openReport(kind, p){
    p = p || defaultPeriod();
    const {title, body} = buildReport(kind, p);
    document.getElementById('reportSheet').innerHTML = body;
    document.getElementById('rtTitle').textContent = title;
    document.title = `LazySyndic — ${title} — ${p.label}`;
    modal.classList.add('open');
    document.body.classList.add('report-open');
    modal.scrollTop = 0;
  }
  window.LazySyndic.openReport = openReport; // debug

  /* ---- câblage des boutons ---- */
  document.getElementById('repPay')?.addEventListener('click', ()=>openReport('pay'));
  document.getElementById('repRes')?.addEventListener('click', ()=>openReport('res'));
  document.getElementById('repAG')?.addEventListener('click', ()=>openReport('ag'));
  document.getElementById('genBudget')?.addEventListener('click', ()=>openReport('budget'));
  document.querySelectorAll('.ag-annexes').forEach(b=>b.addEventListener('click', ()=>openReport('ag', periodForYear(b.dataset.year))));
})();
