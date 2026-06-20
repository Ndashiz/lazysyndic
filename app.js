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
const ONLINE = !!(window.LS && window.LS.hasClient);
const LS_KEY = 'lazysyndic.v1';
let state = ONLINE ? freshState() : loadState();   // en ligne, remplacé par boot()

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
  if (ONLINE) return; // en ligne, la persistance passe par les écritures Supabase ciblées
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch(e){ console.warn('Sauvegarde impossible', e); }
}
const canWrite = () => !ONLINE || (window.LS && window.LS.canWrite);
// Persistance Supabase tolérante : exécute l'écriture, signale et recharge en cas d'échec.
async function dbWrite(fn){
  if (!ONLINE) return;
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
function verseFromTx(short){
  return sum(state.tx.filter(t => t.amount>0 && isIncomeCat(t.high) && norm(t.tiers).includes(norm(short)))
                     .map(t=>t.amount));
}
function ownerLedger(){
  return ownersOf().map(o => {
    const c = (state.contrib && state.contrib[o.short]) || {due:0, verse:0};
    const verse = state.ledgerLive ? verseFromTx(o.short) : c.verse;
    return {...o, due:c.due, verse, solde: verse - c.due};
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
function renderReminders(){
  const box = document.getElementById('rems');
  if (!box) return;
  box.innerHTML = state.reminders.map((r,i)=>
    `<div class="rem${r.done?' done':''}" data-i="${i}"><div class="chk">${r.done?'✓':''}</div><div class="tx">${r.tx}</div><div class="due">${r.done?'fait':r.due}</div></div>`).join('');
  const done = state.reminders.filter(r=>r.done).length;
  const sub = document.querySelector('#dash .card .h-row .sub');
  // (le sous-titre "2 / 4 faits" est sur la carte pense-bête)
  document.querySelectorAll('#dash .card').forEach(c=>{
    const h = c.querySelector('h2');
    if (h && h.textContent.trim()==='Pense-bête'){ const s=c.querySelector('.sub'); if(s) s.textContent = `${done} / ${state.reminders.length} faits`; }
  });
}
document.getElementById('rems')?.addEventListener('click',e=>{
  const r=e.target.closest('.rem'); if(!r) return;
  if(!canWrite()) return;
  const i=+r.dataset.i; const rem=state.reminders[i]; rem.done = !rem.done; saveState(); renderReminders();
  dbWrite(db=>db.updateReminder(rem.id, {done:rem.done}));
});

/* ============================================================
   COMPTES — table de transactions (dérivée)
   ============================================================ */
let curAcct = 'pay';
let flagOnly = false;

function renderTx(acct){
  curAcct = acct;
  const tb = document.getElementById('txbody'); if(!tb) return;
  tb.innerHTML = '';
  const rows = txOf(acct).slice().sort((a,b)=>{
    const da=parseDate(a.date), db=parseDate(b.date);
    return (db?db.iso:'').localeCompare(da?da.iso:'');
  });
  rows.forEach(t=>{
    if (flagOnly && !t.flag) return;
    const idx = state.tx.indexOf(t);
    const tr=document.createElement('tr'); tr.className='tx-row'+(t.flag?' flag':'');
    const catLabel = t.high + (t.sub?(' · '+t.sub):'');
    const amtClass = t.amount>=0 ? 'pos' : 'neg';
    const note = t.note||'';
    const cmt = t.flag && t.comment
      ? `<div class="cmt">✎ ${t.comment}</div>`
      : (t.flag ? '' : '<div class="cmt-add">+ commentaire</div>');
    tr.innerHTML = `<td><button class="flagbtn">⚑</button></td>
      <td>${t.date}</td>
      <td><b>${t.tiers}</b></td>
      <td><span class="cat ${catClass(t.high)}">${catLabel}</span></td>
      <td class="num ${amtClass}">${signed(t.amount)}</td>
      <td>${note}${cmt}</td>`;
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
    tb.appendChild(tr);
  });
  if (!tb.children.length){
    tb.innerHTML = `<tr><td colspan="6" class="sub" style="padding:16px">Aucune transaction${flagOnly?' flaggée':''} sur ce compte.</td></tr>`;
  }
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
  renderChart(acct); renderTx(acct);
});

/* filtre flaggées */
document.getElementById('flagFilter')?.addEventListener('click', function(){
  this.classList.toggle('on');
  flagOnly = this.classList.contains('on');
  renderTx(curAcct);
});

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
  const existingCount = {};
  state.tx.forEach(t=>{ const s=signature(t); existingCount[s]=(existingCount[s]||0)+1; });
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
    const sig = signature(t);
    if (existingCount[sig] > 0){ t._dupe = true; existingCount[sig]--; }
    else t._dupe = false;
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
  const metaBanner = (!isNaN(m.opening)||m.iban||m.holder) ? `
    <div class="alert" style="background:var(--green-soft);border-color:#BcD6c2;color:var(--green-deep)">
      <span class="ic">✓</span><div>Relevé détecté${m.holder?` — <b>${m.holder}</b>`:''}${m.iban?` · ${m.iban}`:''}.
      ${!isNaN(m.opening)?`Solde d'ouverture <b>${eur(m.opening)}</b>`:''}${!isNaN(m.closing)?` → clôture <b>${eur(m.closing)}</b>`:''}.
      ${(m.from||m.to)?`Période ${m.from} → ${m.to}.`:''}</div></div>` : '';
  live.innerHTML = `
    ${metaBanner}
    <div class="card" style="margin-bottom:16px">
      <div class="h-row"><div><h2>Associer les colonnes</h2><div class="sub">${parsedRows.length} ligne(s) de transaction · format de date détecté : <b>${dateOrder==='mdy'?'mois/jour (US)':'jour/mois'}</b></div></div>
        <select class="fld" id="mapAcct">
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
function showPreview(){
  interpreted = interpret();
  const box = document.getElementById('previewBox');
  const nNew = interpreted.filter(t=>!t._dupe).length;
  const nDupe = interpreted.filter(t=>t._dupe).length;
  const nUncat = interpreted.filter(t=>!t._dupe && t.high==='?').length;
  const rows = interpreted.map((t,i)=>{
    const amtClass = t.amount>=0?'pos':'neg';
    const sel = t._dupe
      ? `<span class="cat">${t.high==='?'?'À catégoriser':t.high}</span>`
      : `<select class="fld previewcat" data-i="${i}">${IMPORT_OPTS.map(o=>{
          const val = o==='À catégoriser'?'?':o;
          return `<option value="${val}" ${(t.high===val||(o==='À catégoriser'&&t.high==='?'))?'selected':''}>${o}</option>`;
        }).join('')}</select>`;
    return `<tr class="${t._dupe?'dupe':''}"><td>${t.date}</td><td><b>${t.tiers}</b></td>
      <td class="num ${t._dupe?'':amtClass}">${signed(t.amount)}</td>
      <td>${sel}</td>
      <td>${t._dupe?'<span class="badge" style="background:var(--line-2);color:var(--ink-faint)">Doublon écarté</span>':(t.high==='?'?'<span class="badge b-late">À catégoriser</span>':'<span class="badge b-ok">Nouvelle</span>')}</td></tr>`;
  }).join('');
  box.innerHTML = `
    ${nUncat?`<div class="alert"><span class="ic">⚠</span><div><b>${nUncat} transaction(s) non reconnue(s).</b> Choisissez une catégorie ci-dessous, ou ajoutez une règle dans « Règles & alias ».</div></div>`:''}
    <div class="mini-h">Validation — vérifiez les catégories proposées</div>
    <div class="card" style="padding:8px 14px">
      <table><tr><th>Date</th><th>Tiers</th><th class="num">Montant</th><th>Catégorie</th><th>Statut</th></tr>
      <tbody>${rows}</tbody></table>
    </div>
    <div class="save-bar">
      <div class="n"><b>${nNew} nouvelle(s)</b> transaction(s) · <b>${nDupe} doublon(s)</b> écarté(s) → ${importTargetAcct==='res'?'compte de réserve':'compte de paiement'}</div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" id="cancelImp2">Annuler</button>
        <button class="btn btn-primary" id="saveImp2">Valider &amp; sauvegarder</button>
      </div>
    </div>`;
  box.querySelectorAll('.previewcat').forEach(s=>s.onchange=()=>{ interpreted[+s.dataset.i].high = s.value; });
  box.querySelector('#cancelImp2').onclick = resetImport;
  box.querySelector('#saveImp2').onclick = commitImport;
}

async function commitImport(){
  if(!canWrite()){ alert('Lecture seule : seul le syndic peut importer.'); return; }
  const toAdd = interpreted.filter(t=>!t._dupe).map(t=>{ const {_dupe, ...rest}=t; return rest; });
  const nextV = (state.imports[0]?.v || 0) + 1;
  const imp = {v:nextV, label:`Import ${new Date().toLocaleDateString('fr-BE')}`, meta:`${toAdd.length} transaction(s) ajoutée(s)`, cur:true};
  if (ONLINE){
    try {
      const saved = await window.LS.db.addTransactions(toAdd);   // renvoie les lignes avec id
      state.tx.push(...saved);
      await window.LS.db.clearCurrentImport();
      const savedImp = await window.LS.db.addImport(imp);
      state.imports.forEach(im=>im.cur=false);
      state.imports.unshift({id:savedImp.id, ...imp});
    } catch(e){ console.error(e); alert('Import non enregistré : '+(e.message||e)); return; }
  } else {
    state.tx.push(...toAdd);
    state.imports.forEach(im=>im.cur=false);
    state.imports.unshift(imp);
    saveState();
  }
  resetImport();
  renderAll();
  alert(`✓ ${toAdd.length} transaction(s) sauvegardée(s) — version v${nextV} créée.`);
}

function resetImport(){
  parsedRows = parsedHeaders = mapping = interpreted = importMeta = null;
  dateOrder = 'dmy';
  const after = document.getElementById('afterDrop');
  if (after){ after.style.display='none'; const live=document.getElementById('importLive'); if(live) live.remove(); }
}

// Lecture d'un fichier déposé / choisi
function handleFile(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    const rows = parseCSV(e.target.result);
    if (rows.length < 2){ alert('Fichier vide ou illisible.'); return; }
    const {headers, data, meta} = detectTable(rows);
    parsedHeaders = headers.map(h=>String(h).trim());
    parsedRows = data;
    importMeta = meta;
    mapping = guessMapping(parsedHeaders);
    if (mapping.date<0) mapping.date=0;
    if (mapping.amount<0 && mapping.credit<0 && mapping.debit<0) mapping.amount=Math.min(parsedHeaders.length-1, 2);
    dateOrder = detectDateOrder(parsedRows.map(r=>r[mapping.date]));
    showImportScreen();
    showMapping();
  };
  reader.readAsText(file, 'utf-8');
}

let fileInput;
function pickFile(){
  if (!fileInput){
    fileInput = document.createElement('input');
    fileInput.type='file'; fileInput.accept='.csv,text/csv,text/plain'; fileInput.style.display='none';
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
const MAJ={simple:'Majorité simple',absolue:'Majorité absolue',deuxtiers:'Double tiers',quatrecinq:'Quatre cinquièmes',unanime:'Unanimité'};
const MAJPCT={simple:50,absolue:51,deuxtiers:67,quatrecinq:80,unanime:100};
const MAJTHRESH={simple:501,absolue:501,deuxtiers:667,quatrecinq:800,unanime:1000};
const POINTS=[
  {t:'Désignation du président et du secrétaire de séance',type:'Décision',maj:'simple',key:'Acte de base'},
  {t:'Approbation des comptes de l’exercice 2025',type:'Décision',maj:'absolue',key:'Acte de base'},
  {t:'Décharge au syndic bénévole',type:'Décision',maj:'simple',key:'Acte de base'},
  {t:'Approbation du budget prévisionnel 2026',type:'Décision',maj:'absolue',key:'Acte de base'},
  {t:'Réfection de la toiture — choix du devis',type:'Décision',maj:'deuxtiers',key:'Acte de base'},
  {t:'Divers',type:'Information',maj:null,key:null},
];
const AG_OWNERS=[{n:'Alex',q:500,c:'#2F6B53'},{n:'Sam',q:251,c:'#5B4B86'},{n:'Lou',q:249,c:'#C9854A'}];

function majOptions(sel){return Object.entries(MAJ).map(([k,v])=>`<option value="${k}" ${k===sel?'selected':''}>${v}</option>`).join('');}
function renderAgenda(){
  const wrap=document.getElementById('agenda'); if(!wrap) return; wrap.innerHTML='';
  POINTS.forEach((p,i)=>{
    const isDec=p.type==='Décision';
    const card=document.createElement('div'); card.className='card'; card.style.marginBottom='12px';
    card.innerHTML=`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-family:'Fraunces',serif;font-weight:600;color:var(--ink-faint)">${i+1}</span>
        <input class="fld" style="flex:1;font-weight:600" value="${p.t}">
        <span class="cat ${isDec?'':'ent'}">${p.type}</span>
        <button class="flagbtn" style="opacity:.5" title="Monter">↑</button>
        <button class="flagbtn" style="opacity:.5" title="Descendre">↓</button>
        <button class="flagbtn" style="opacity:.5" title="Supprimer">✕</button>
      </div>
      <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:12px">
        <div style="display:flex;gap:2px;padding:6px 8px;background:var(--card-2);border-bottom:1px solid var(--line);font-size:13px;color:var(--ink-soft)">
          <b style="padding:2px 6px;font-weight:700">B</b><i style="padding:2px 6px">I</i><u style="padding:2px 6px">U</u><span style="padding:2px 6px">⛓</span><span style="padding:2px 6px">• ⁝</span><span style="padding:2px 6px">1.</span>
        </div>
        <div contenteditable style="padding:10px 12px;min-height:44px;font-size:13.5px;color:var(--ink-soft)">${i===1?'Présentation des annexes 2, 3 et 4. Solde de clôture '+eur(balance('pay'))+' au compte de paiement.':'Décrivez le point ici…'}</div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div style="display:${isDec?'flex':'none'};gap:10px;align-items:center">
          <label style="font-size:12px;color:var(--ink-faint)">Majorité requise</label>
          <select class="fld majsel" data-i="${i}">${majOptions(p.maj)}</select>
          <span class="cat acp pctlbl" data-i="${i}">${isDec?MAJPCT[p.maj]+' %':''}</span>
        </div>
        <div style="display:${isDec?'flex':'none'};gap:10px;align-items:center">
          <label style="font-size:12px;color:var(--ink-faint)">Clé</label>
          <select class="fld"><option>Acte de base (quotités)</option><option>Individuelle (÷ propriétaires)</option></select>
        </div>
        ${isDec?'':'<span class="sub">Point informatif — non soumis au vote</span>'}
      </div>`;
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('.majsel').forEach(s=>s.onchange=()=>{
    const i=s.dataset.i; document.querySelector(`.pctlbl[data-i="${i}"]`).textContent=MAJPCT[s.value]+' %';
  });
}
document.getElementById('addPoint')?.addEventListener('click',()=>{POINTS.push({t:'Nouveau point',type:'Décision',maj:'simple',key:'Acte de base'});renderAgenda();});
document.getElementById('genConv')?.addEventListener('click',()=>{
  const points=POINTS.map((p,i)=>`${i+1}. ${p.t}${p.type==='Décision'?' ('+MAJ[p.maj]+')':' (information)'}`).join('\n');
  const eml=`From: Alex Martin (Syndic) <syndic@exemple.be>
To: Lou Petit <lou@exemple.be>, Sam Bernard <sam@exemple.be>
Subject: Convocation - Assemblee generale ordinaire - ACP DÃ©mo - 22 juin 2026
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"

Madame, Monsieur, cher coproprietaire,

En ma qualite de syndic benevole de l'ACP DÃ©mo, j'ai l'honneur de vous
convoquer a l'assemblee generale ORDINAIRE qui se tiendra :

    Date : le 22 juin 2026 a 19h00
    Lieu : Appartement RDC, 1 rue Exemple, 1000 Ville

Conformement au reglement d'ordre interieur, cette convocation vous est adressee
au moins 15 jours avant l'assemblee.

ORDRE DU JOUR
-------------
${points}

Tout coproprietaire empeche peut se faire representer par procuration ecrite.

Salutations distinguees,
Alex Martin - Syndic benevole, ACP DÃ©mo
`;
  const blob=new Blob([eml],{type:'message/rfc822'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='convocation-AG-2026.eml';
  document.body.appendChild(a); a.click(); a.remove();
});

function renderSeance(){
  const wrap=document.getElementById('seance'); if(!wrap) return; wrap.innerHTML='';
  POINTS.forEach((p,i)=>{
    const isDec=p.type==='Décision';
    const card=document.createElement('div'); card.className='card'; card.style.marginBottom='12px';
    let votes='';
    if(isDec){
      votes=`<div style="margin-top:12px">
        ${AG_OWNERS.map(o=>`
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2)">
            <span class="a" style="width:24px;height:24px;background:${o.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700">${o.n[0]}</span>
            <span style="font-size:13.5px;flex:1">${o.n} <span style="color:var(--ink-faint)">· ${o.q}</span></span>
            <div class="seg vote" data-p="${i}" data-q="${o.q}">
              <button class="vp on">Pour</button><button class="vc">Contre</button><button class="va">Abst.</button>
            </div>
          </div>`).join('')}
        <div class="verdict" data-p="${i}" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:10px 14px;background:var(--green-soft);border-radius:11px">
          <span style="font-size:13px;color:var(--ink-soft)">Pour : <b class="pourq">1000</b>/1000 · requis ${MAJTHRESH[p.maj]} (${MAJ[p.maj]})</span>
          <span class="vbadge badge b-ok">Adopté</span>
        </div></div>`;
    } else { votes='<div class="sub" style="margin-top:8px">Point informatif — pas de vote</div>'; }
    card.innerHTML=`
      <div style="display:flex;align-items:center;gap:10px"><span style="font-family:'Fraunces',serif;font-weight:600;color:var(--ink-faint)">${i+1}</span>
        <b style="flex:1;font-size:14.5px">${p.t}</b>${isDec?`<span class="cat acp">${MAJ[p.maj]}</span>`:'<span class="cat ent">Information</span>'}</div>
      <div contenteditable class="fld" style="width:100%;margin-top:10px;min-height:38px;font-size:13px;color:var(--ink-soft)">Notes de séance…</div>
      ${votes}`;
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('.vote').forEach(seg=>{
    seg.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
      seg.querySelectorAll('button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');
      tally(seg.dataset.p);
    });
  });
  POINTS.forEach((p,i)=>{if(p.type==='Décision')tally(i);});
}
function tally(pi){
  let pour=0;
  document.querySelectorAll(`.vote[data-p="${pi}"]`).forEach(seg=>{
    if(seg.querySelector('.vp').classList.contains('on'))pour+=parseInt(seg.dataset.q);
  });
  const maj=POINTS[pi].maj, need=MAJTHRESH[maj];
  const v=document.querySelector(`.verdict[data-p="${pi}"]`); if(!v)return;
  v.querySelector('.pourq').textContent=pour;
  const ok=pour>=need; const badge=v.querySelector('.vbadge');
  badge.textContent=ok?'Adopté':'Rejeté'; badge.className='vbadge badge '+(ok?'b-ok':'b-late');
  v.style.background=ok?'var(--green-soft)':'var(--coral-soft)';
}
document.getElementById('genPV')?.addEventListener('click',()=>alert('⬇ PV généré au format Word (.docx)\n\nReprend l’ordre du jour, les présences, les votes en quotités, les décisions et le bloc signatures. Modifiable avant diffusion.'));

let curStep=1;
function goStep(n){
  curStep=Math.max(1,Math.min(5,n));
  document.querySelectorAll('#stepper .step').forEach(s=>{
    const sn=+s.dataset.step;
    s.classList.toggle('on',sn===curStep);
    s.classList.toggle('done',sn<curStep);
    s.querySelector('.circ').textContent=sn<curStep?'✓':sn;
  });
  document.querySelectorAll('.agpanel').forEach(p=>{p.style.display=(+p.dataset.panel===curStep)?'block':'none';});
  const st=document.getElementById('agStatus');
  if(curStep===5){st.style.background='var(--clay-soft)';st.style.borderColor='#E0C49B';st.style.color='#8A551F';st.querySelector('.dot').style.background='var(--clay)';st.childNodes[1].textContent=' Finalisation';}
  window.scrollTo({top:0,behavior:'smooth'});
}
document.querySelectorAll('#ag .nextStep').forEach(b=>b.onclick=()=>goStep(curStep+1));
document.querySelectorAll('#ag .prevStep').forEach(b=>b.onclick=()=>goStep(curStep-1));
document.querySelectorAll('#stepper .step').forEach(s=>s.onclick=()=>goStep(+s.dataset.step));
document.getElementById('completeAG')?.addEventListener('click',function(){
  this.textContent='✓ AG complétée — archivée';this.disabled=true;this.style.opacity=.7;
  const st=document.getElementById('agStatus');
  st.style.background='var(--green-soft)';st.style.borderColor='#BcD6c2';st.style.color='var(--green-deep)';
  st.querySelector('.dot').style.background='var(--green)';st.childNodes[1].textContent=' AG finalisée';
});
function renderPresences(){
  const wrap=document.getElementById('presences'); if(!wrap) return; wrap.innerHTML='';
  AG_OWNERS.forEach((o,i)=>{
    const card=document.createElement('div'); card.className='card'; card.style.marginBottom='10px';
    card.innerHTML=`<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="a" style="width:28px;height:28px;background:${o.c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700">${o.n[0]}</span>
      <b style="font-size:14px">${o.n}</b><span style="color:var(--ink-faint);font-size:13px">${o.q} millièmes</span>
      <div class="seg pres" data-i="${i}" data-q="${o.q}" style="margin-left:auto">
        <button class="p-pre on">Présent</button><button class="p-rep">Représenté</button><button class="p-exc">Excusé</button><button class="p-abs">Absent</button>
      </div>
    </div>
    <div class="repname" data-i="${i}" style="display:none;margin-top:10px">
      <input class="fld" style="width:100%" placeholder="Nom du mandataire présent pour ${o.n}…">
    </div>`;
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('.pres').forEach(seg=>{
    seg.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
      seg.querySelectorAll('button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');
      const rep=document.querySelector(`.repname[data-i="${seg.dataset.i}"]`);
      rep.style.display=btn.classList.contains('p-rep')?'block':'none';
      computeQuorum();
    });
  });
  computeQuorum();
}
function computeQuorum(){
  let q=0;
  document.querySelectorAll('.pres').forEach(seg=>{
    const b=seg.querySelector('button.on');
    if(b&&(b.classList.contains('p-pre')||b.classList.contains('p-rep')))q+=parseInt(seg.dataset.q);
  });
  const qn=document.getElementById('quorumNum'); if(qn) qn.textContent=q;
  const card=document.getElementById('quorumCard'),ok=q>=500;
  const qt=document.getElementById('quorumTxt'); if(qt) qt.textContent=ok?'Quorum atteint — la séance peut délibérer':'Quorum non atteint';
  if(card){card.style.background=ok?'var(--green-soft)':'var(--coral-soft)';card.style.borderColor=ok?'#BcD6c2':'#E8BDB4';}
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
const POSTES=[
  {p:'Eau (Vivaqua)',k:'quote',r:620},
  {p:'Électricité communs (Electrabel)',k:'quote',r:188},
  {p:'Assurance habitation',k:'quote',r:430},
  {p:'RC civile (AXA)',k:'indiv',r:142},
  {p:'Frais bancaires (Swan)',k:'indiv',r:79},
  {p:'Frais logiciel (syndic)',k:'indiv',r:120},
  {p:'Entretien adoucisseur',k:'quote',r:122},
];
const RESERVE={Alex:80,Sam:40,Lou:40};
function renderBudget(){
  const t=document.getElementById('budTable'); if(!t) return;
  t.innerHTML='<tr><th>Poste</th><th>Clé</th><th class="num">Réalité 25</th><th class="num">Budget 26</th></tr>';
  POSTES.forEach((po,i)=>{
    const bud=po.r*MARGIN;
    t.insertAdjacentHTML('beforeend',`<tr><td>${po.p}</td>
      <td><select class="fld budkey" data-i="${i}"><option value="quote" ${po.k==='quote'?'selected':''}>Quote-part</option><option value="indiv" ${po.k==='indiv'?'selected':''}>Individuelle</option></select></td>
      <td class="num">${eur(po.r)}</td><td class="num"><b>${eur(bud)}</b></td></tr>`);
  });
  t.querySelectorAll('.budkey').forEach(s=>s.onchange=()=>{POSTES[s.dataset.i].k=s.value;renderBudget();});
  const split={Alex:0,Sam:0,Lou:0};
  POSTES.forEach(po=>{
    const bud=po.r*MARGIN;
    if(po.k==='indiv'){const each=bud/3;split.Alex+=each;split.Sam+=each;split.Lou+=each;}
    else{split.Alex+=bud*500/1000;split.Sam+=bud*251/1000;split.Lou+=bud*249/1000;}
  });
  const ot=document.getElementById('budOwners');
  ot.innerHTML='<tr><th>Propriétaire</th><th class="num">Charge annuelle</th><th class="num">Mensualité</th><th class="num">Fonds de réserve</th></tr>';
  [['Alex','#2F6B53'],['Sam','#5B4B86'],['Lou','#C9854A']].forEach(([n,c])=>{
    ot.insertAdjacentHTML('beforeend',`<tr><td><div class="who"><span class="a" style="width:24px;height:24px;background:${c};border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700">${n[0]}</span> ${n}</div></td>
      <td class="num"><b>${eur(split[n])}</b></td><td class="num">${eur(split[n]/12)}</td><td class="num">${eur(RESERVE[n])}/mois</td></tr>`);
  });
}
// genBudget câblé dans la section GÉNÉRATEUR DE RAPPORTS (Annexe 4).

/* ============================================================
   RÈGLES & ALIAS (persistés)
   ============================================================ */
function renderRules(){
  const t=document.getElementById('ruleTable'); if(!t) return;
  t.innerHTML='<tr><th>Tiers (libellé)</th><th>Catégorie</th><th>Sous-catégorie</th><th></th></tr>';
  state.rules.forEach((r,i)=>t.insertAdjacentHTML('beforeend',`<tr data-i="${i}"><td><input class="fld rl-label" value="${r[0]}" style="width:160px;font-weight:600"></td>
    <td><select class="fld rl-cat">${CATS.map(c=>`<option ${c===r[1]?'selected':''}>${c}</option>`).join('')}</select></td>
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
function renderAll(){
  renderDashboard();
  renderReminders();
  refreshAccountChrome();
  renderTx(curAcct);
  renderChart(curAcct);
  renderContracts();
  renderRules();
  renderAliases();
  renderBudget();
  renderImports();
  animateBars();
}
renderAgenda();
renderSeance();
renderPresences();

/* ============================================================
   AUTH + BOOT (en ligne : login Supabase puis chargement partagé)
   ============================================================ */
function applyRoleUI(){
  const ro = ONLINE && !canWrite();
  document.body.classList.toggle('readonly', ro);
}
async function bootData(){
  try {
    state = await window.LS.db.loadAll();
    if (state.owners && state.owners.length) OWNERS = state.owners;
  } catch(e){
    console.error(e);
    alert('Chargement des données impossible : '+(e.message||e));
    state = freshState();
  }
  applyRoleUI();
  renderAll();
}

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
  if (!ONLINE){ renderAll(); return; }   // mode démo hors-ligne
  buildLogin();
  const ov=document.getElementById('loginOverlay'), bar=document.getElementById('sessionBar');
  const session = await window.LS.auth.session();
  if (!session){ ov.classList.add('on'); }
  // réagit aux connexions / déconnexions
  window.LS.auth.onChange(async (s)=>{
    if (s){
      const member = await window.LS.db.loadMember();
      window.LS.member = member;
      window.LS.canWrite = !!(member && member.role==='admin');
      if (!member){
        ov.querySelector('#loginMsg').textContent='Ce compte n\'a pas accès à LazySyndic.';
        ov.querySelector('#loginMsg').className='login-msg err';
        return;
      }
      ov.classList.remove('on');
      bar.classList.add('on');
      bar.querySelector('#sbWho').innerHTML = `${member.full_name||member.userEmail} ${member.role==='admin'?'· <b>Syndic</b>':'· <span class="ro">Lecture seule</span>'}`;
      await bootData();
    } else {
      bar.classList.remove('on'); ov.classList.add('on');
    }
  });
}
boot();

/* ============================================================
   GÉNÉRATEUR DE RAPPORTS (PDF via impression navigateur)
   Tout est dérivé du store, filtré sur la période choisie.
   ============================================================ */
(function setupReports(){
  const COPRO = { name:'ACP DÃ©mo', addr:'1 rue Exemple, 1000 Ville', kbo:'BE 0000.000.000' };

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
        <div style="margin-top:6px"><b>${COPRO.name}</b><div class="r-sub">${COPRO.addr} · ${COPRO.kbo}</div></div></div>
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
    const rows = POSTES.map(po=>{
      const bud = po.r*MARGIN;
      const key = po.k==='indiv'?'Individuelle (÷3)':'Quote-part (millièmes)';
      return `<tr><td>${po.p}</td><td>${key}</td><td class="num">${eur(po.r)}</td><td class="num"><b>${eur(bud)}</b></td></tr>`;
    }).join('');
    const split={Alex:0,Sam:0,Lou:0};
    POSTES.forEach(po=>{ const bud=po.r*MARGIN;
      if(po.k==='indiv'){const e=bud/3;split.Alex+=e;split.Sam+=e;split.Lou+=e;}
      else{split.Alex+=bud*500/1000;split.Sam+=bud*251/1000;split.Lou+=bud*249/1000;} });
    const totR=sum(POSTES.map(p=>p.r)), totB=totR*MARGIN;
    const ow = [['Alex Martin','Alex'],['Sam Bernard','Sam'],['Lou Petit','Lou']].map(([n,k])=>
      `<tr><td>${n}</td><td class="num"><b>${eur(split[k])}</b></td><td class="num">${eur(split[k]/12)}</td><td class="num">${eur(RESERVE[k])}/mois</td></tr>`).join('');
    return `<h2>Annexe 4 — Budget prévisionnel (marge +4 %)</h2>
      <table><tr><th>Poste</th><th>Clé de répartition</th><th class="num">Réalité</th><th class="num">Budget</th></tr>
        ${rows}<tr class="tot"><td>Total</td><td></td><td class="num">${eur(totR)}</td><td class="num">${eur(totB)}</td></tr></table>
      <h2 style="font-size:14px;border:none;color:#20251F;margin-top:18px">Charge annuelle par copropriétaire</h2>
      <table><tr><th>Copropriétaire</th><th class="num">Charge annuelle</th><th class="num">Mensualité</th><th class="num">Fonds de réserve</th></tr>${ow}</table>`;
  }
  function signatures(){
    return `<div class="sig">
      <div>Le président de séance</div><div>Le secrétaire</div><div>Le commissaire aux comptes</div>
    </div>`;
  }
  function foot(){ return `<div class="r-foot">Document généré par LazySyndic — ${COPRO.name}. Les annexes 2, 3 et 4 sont calculées depuis le registre des transactions sur la période indiquée.</div>`; }

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
