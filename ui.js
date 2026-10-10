/* ============================================================
   LazySyndic — coque d'interface (design « refined »)
   Source du design : Ndashiz/lazysyndic-refined (Lovable, React) ; ici le
   même système porté en HTML/CSS/JS sans dépendance. Correspondance : DESIGN.md.

   Ce fichier gère ce que le design a ajouté autour de l'app :
   - la barre du haut : fil d'Ariane, recherche de page, notifications, profil
     (déconnexion, mode démo — remplace la pastille #sessionBar d'app.js) ;
   - les pastilles de la navigation (relevés à valider, mouvements à catégoriser) ;
   - la page de garde : bandeau « votre copropriété », derniers mouvements, fil
     de la copropriété, avancement des appels de fonds, date de la prochaine AG ;
   - l'objectif du fonds de réserve sur l'onglet Comptes → réserve.
   Tout est LU dans l'état d'app.js (state, balance, ownerLedger…) : rien n'est
   écrit, ni en local ni dans Supabase. Chargé après app.js ; se redessine dans la
   foulée de renderAll & co.
   ============================================================ */
(function(){
  'use strict';
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const esc = v => String(v==null ? '' : v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const ready = () => typeof state !== 'undefined' && state && Array.isArray(state.tx);
  const strip = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Icônes Lucide (ISC), les mêmes que le design.
  const ICON = {
    upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    filter:'<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    landmark:'<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6h4.5"/>',
    calendar:'<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    in:'<path d="M17 7 7 17"/><path d="M17 17H7V7"/>',
    check:'<path d="M20 6 9 17l-5-5"/>',
    pen:'<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
    flask:'<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
    logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    dots:'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  };
  const ic = (n, cls='i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]||''}</svg>`;

  const MONTHS = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  const isoOf = t => { const d = typeof parseDate === 'function' ? parseDate(t.date) : null; return d ? d.iso : ''; };
  const frDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso||''); return m ? `${m[3]} ${MONTHS[+m[2]-1]} ${m[1]}` : ''; };
  const isoToday = () => { const d = new Date(), p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
  const daysFrom = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso||''); if (!m) return null;
    const a = new Date(+m[1], +m[2]-1, +m[3]), b = new Date(); b.setHours(0,0,0,0); return Math.round((b - a) / 86400000); };
  const relDay = iso => { const n = daysFrom(iso); if (n === null) return '';
    return n === 0 ? 'Aujourd’hui' : n === 1 ? 'Hier' : n > 1 && n < 14 ? `Il y a ${n} jours` : frDate(iso); };
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const writable = () => typeof canWrite === 'function' && canWrite();

  /* ---------- navigation : data-go (écran), data-click (relais vers un bouton existant), data-hash ---------- */
  document.addEventListener('click', e => {
    const go = e.target.closest('[data-go]');
    if (go){ e.preventDefault(); closePops(); if (typeof goToScreen === 'function') goToScreen(go.dataset.go); return; }
    const h = e.target.closest('[data-hash]');
    if (h){ closePops(); const v = '#' + h.dataset.hash;
      if (location.hash === v && typeof applyDeepLink === 'function') applyDeepLink(); else location.hash = v; return; }
    const ck = e.target.closest('[data-click]');
    if (ck){ const t = document.getElementById(ck.dataset.click); if (t) t.click(); return; }
    const tx = e.target.closest('[data-txi]');
    if (tx && ready() && typeof showTxDetail === 'function'){ const t = state.tx[+tx.dataset.txi]; if (t) showTxDetail(t); return; }
    if (!e.target.closest('.pop, .icon-btn, .search')) closePops();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePops(); });

  /* ---------- fil d'Ariane + titre d'onglet ---------- */
  const labelOf = id => { const b = $(`.nav button[data-s="${id}"] .lbl`); return b ? b.textContent : ''; };
  function syncCrumb(){
    const id = ($('.screen.on') || {}).id || 'dash';
    set('tbPage', labelOf(id));
    document.title = `${labelOf(id) || 'LazySyndic'} — LazySyndic`;
  }
  $('.nav')?.addEventListener('click', e => { if (e.target.closest('button[data-s]')){ syncCrumb(); setMenu(false); schedule(); } });

  /* ---------- tiroir mobile (le bouton de la barre du haut remplace la barre verte d'app.js) ---------- */
  function setMenu(open){
    document.body.classList.toggle('nav-open', open);
    $('#navBackdrop')?.classList.toggle('on', open);
    $('#tbMenu')?.setAttribute('aria-expanded', String(open));
  }
  $('#tbMenu')?.addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
  document.addEventListener('click', e => { if (e.target.id === 'navBackdrop') setMenu(false); });

  /* ---------- fenêtres de la barre du haut ---------- */
  const POPS = [['tbBell','tbBellPop', renderBell], ['tbMe','tbMePop', renderMe]];
  function closePops(keep){
    POPS.forEach(([b, p]) => { if (p === keep) return; const pe = $('#'+p); if (pe) pe.hidden = true; $('#'+b)?.setAttribute('aria-expanded','false'); });
    if (keep !== 'tbSearchPop'){ const sp = $('#tbSearchPop'); if (sp) sp.hidden = true; }
  }
  POPS.forEach(([b, p, render]) => {
    const be = $('#'+b), pe = $('#'+p); if (!be || !pe) return;
    be.addEventListener('click', e => {
      e.stopPropagation();
      const open = pe.hidden; closePops(p);
      if (open){ render(pe); pe.hidden = false; } else pe.hidden = true;
      be.setAttribute('aria-expanded', String(open));
    });
  });

  // Ce qui demande l'attention du syndic, dérivé de l'état — rien n'est stocké.
  function alertsList(){
    if (!ready()) return [];
    const out = [];
    const drafts = (state.draftTx || []).length;
    if (drafts) out.push({ic:'upload', t:`${plural(drafts,'mouvement')} à valider`, d:'Un relevé importé attend votre vérification.', go:'imp'});
    const unm = state.tx.filter(t => !t.high || t.high === '?').length;
    if (unm) out.push({ic:'filter', t:`${plural(unm,'mouvement')} à catégoriser`, d:'Ils comptent dans les soldes, pas encore dans la répartition.', hash:'acc?filter=unmapped'});
    ['pay','res'].forEach(a => {
      const r = typeof reconStatus === 'function' ? reconStatus(a) : null;
      if (r && !r.ok) out.push({ic:'landmark', t:`Écart de ${eur(Math.abs(r.diff))} — compte de ${a === 'res' ? 'réserve' : 'paiement'}`, d:'Le solde calculé ne correspond pas à la clôture du dernier relevé.', go:'acc'});
    });
    try {
      ownerLedger().filter(o => o.solde < -0.005).forEach(o =>
        out.push({ic:'users', t:`${o.n} : ${eur(-o.solde)} en retard`, d:'Charges et provisions de l’exercice.', go:'dash'}));
    } catch(e){}
    const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 7); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; })();
    (state.reminders || []).filter(r => !r.done && /^\d{4}-\d{2}-\d{2}$/.test(r.due || '') && r.due <= soon).forEach(r =>
      out.push({ic:'clock', t:r.tx, d: r.due < isoToday() ? `En retard depuis le ${frDate(r.due)}` : `Échéance le ${frDate(r.due)}`, go:'dash'}));
    const ag = (state.ags || []).find(a => a.status !== 'finalisee');
    if (ag) out.push({ic:'calendar', info:true, t: ag.title || 'Assemblée générale',
      d: [ag.ag_date || 'Date à fixer', (typeof AG_STATUS !== 'undefined' && AG_STATUS[ag.status]) || ''].filter(Boolean).join(' · '), go:'ag'});
    return out;
  }
  function renderBell(pe){
    const items = alertsList(), todo = items.filter(x => !x.info).length;
    pe.innerHTML = `<div class="pop-h">Notifications<span>${todo ? 'Ce qui demande votre attention' : 'Rien ne demande votre attention.'}</span></div>`
      + items.map(x => `<button class="pop-item" type="button" ${x.hash ? `data-hash="${esc(x.hash)}"` : `data-go="${x.go}"`}>
          <span class="act-ic">${ic(x.ic)}</span><span><b>${esc(x.t)}</b><small>${esc(x.d)}</small></span></button>`).join('');
  }
  function renderMe(pe){
    const m = (window.LS && window.LS.member) || null;
    const demo = typeof demoMode !== 'undefined' && demoMode;
    const role = demo ? 'Mode démo — données fictives'
      : m ? (m.role === 'admin' ? 'Syndic · administrateur' : 'Lecture seule')
      : 'Mode local — données de ce navigateur';
    const name = m ? (m.full_name || m.userEmail || '—') : 'Sans connexion';
    const mail = m && m.full_name && m.userEmail ? `<span>${esc(m.userEmail)}</span>` : '';
    let h = `<div class="pop-h">${esc(name)}${mail}</div>
      <dl class="detail"><div><dt>Copropriété</dt><dd>${esc((ready() && state.coproName) || '—')}</dd></div><div><dt>Accès</dt><dd>${esc(role)}</dd></div></dl>`;
    const admin = typeof isRealAdmin === 'function' && isRealAdmin();
    const online = !!(window.LS && window.LS.hasClient && window.LS.auth);
    if (admin || online) h += '<div class="pop-sep"></div>';
    if (admin) h += `<button class="pop-item" type="button" id="meDemo"><span class="act-ic">${ic('flask')}</span><span><b>${demo ? 'Quitter le mode démo' : 'Passer en mode démo'}</b><small>${demo ? 'Revenir aux données de la copropriété.' : 'Tester sans rien écrire dans la base.'}</small></span></button>`;
    if (online) h += `<button class="pop-item" type="button" id="meOut"><span class="act-ic">${ic('logout')}</span><span><b>Se déconnecter</b></span></button>`;
    pe.innerHTML = h;
    $('#meDemo', pe)?.addEventListener('click', () => { closePops(); if (typeof toggleDemo === 'function') toggleDemo(); });
    $('#meOut', pe)?.addEventListener('click', async () => { try { await window.LS.auth.signOut(); } catch(e){} location.reload(); });
  }

  /* ---------- recherche (pages, comme dans le design) ---------- */
  const KEYWORDS = {
    dash:'accueil page de garde reserve soldes pense-bete', acc:'transactions mouvements iban solde rapport releve compte paiement reserve',
    cpta:'flux tresorerie bilan entrees sorties', imp:'releve csv pdf swan coller', ag:'assemblee pv proces-verbal convocation vote',
    budget:'charges repartition quotites lots provisions annexe', ct:'contrats fournisseurs prestataires', timeline:'chronologie historique journal notes',
    rules:'regles alias sauvegarde restauration export',
  };
  const input = $('#tbSearch'), sp = $('#tbSearchPop');
  let sel = 0;
  function renderSearch(){
    const q = strip(input.value.trim());
    if (!q){ sp.hidden = true; return; }
    const res = $$('.nav button[data-s]').filter(b => strip(b.textContent).includes(q) || (KEYWORDS[b.dataset.s] || '').includes(q));
    sel = Math.max(0, Math.min(sel, res.length - 1));
    sp.innerHTML = res.length
      ? res.map((b, i) => `<button class="pop-item${i === sel ? ' sel' : ''}" type="button" data-go="${b.dataset.s}"><span class="act-ic">${$('.ic', b).innerHTML}</span><span><b>${esc($('.lbl', b).textContent)}</b></span></button>`).join('')
      : '<div class="pop-empty">Aucun résultat</div>';
    closePops('tbSearchPop'); sp.hidden = false;
  }
  if (input && sp){
    input.addEventListener('input', () => { sel = 0; renderSearch(); });
    input.addEventListener('keydown', e => {
      const items = $$('.pop-item', sp);
      if (e.key === 'ArrowDown'){ sel = Math.min(sel + 1, items.length - 1); renderSearch(); e.preventDefault(); }
      else if (e.key === 'ArrowUp'){ sel = Math.max(sel - 1, 0); renderSearch(); e.preventDefault(); }
      else if (e.key === 'Enter'){ const b = items[sel]; if (b){ input.value = ''; sp.hidden = true; input.blur(); goToScreen(b.dataset.go); } }
      else if (e.key === 'Escape'){ input.value = ''; sp.hidden = true; }
    });
    sp.addEventListener('click', () => { input.value = ''; });
  }

  /* ---------- page de garde ---------- */
  function renderHero(){
    const name = state.coproName || 'Ma copropriété';
    set('bnCopro', name); set('tbCopro', name);
    const lots = typeof lotsOf === 'function' ? lotsOf().length : 0;
    const ow = typeof ownersOf === 'function' ? ownersOf().length : 0;
    set('bnLots', lots ? plural(lots, 'lot') : '');
    $('#bnLots')?.parentElement?.toggleAttribute('hidden', !lots);
    set('bnOwners', plural(ow, 'copropriétaire'));
    // lecture seule : pas d'import proposé
    const w = writable();
    $$('.qa[data-write]').forEach(q => { q.dataset.go = w ? 'imp' : 'acc'; q.lastChild.textContent = w ? 'Importer un relevé' : 'Voir les comptes'; });
    const head = $('#dash .top [data-go="imp"]'); if (head) head.hidden = !w;
  }
  function renderRecent(){
    const box = $('#recentTx'); if (!box) return;
    const list = state.tx.slice().sort((a, b) => isoOf(b).localeCompare(isoOf(a))).slice(0, 5);
    if (!list.length){ box.innerHTML = '<div class="empty">Aucun mouvement pour l’instant — importez un relevé pour commencer.</div>'; return; }
    box.innerHTML = '<table><thead><tr><th>Transaction</th><th>Date</th><th class="num">Montant</th><th>Statut</th><th></th></tr></thead><tbody>'
      + list.map(t => {
        const inc = t.amount > 0, unm = !t.high || t.high === '?';
        const detail = unm ? (t.account === 'res' ? 'Compte de réserve' : 'Compte de paiement') : [t.high, t.sub].filter(Boolean).join(' › ');
        return `<tr><td><div class="tx-cell"><span class="file-ic${inc ? ' in' : ''}">${ic(inc ? 'in' : 'file')}</span>
            <div style="min-width:0"><b>${esc(t.tiers || t.note || '—')}</b><small>${esc(detail)}</small></div></div></td>
          <td class="sub" style="white-space:nowrap">${esc(frDate(isoOf(t)) || t.date)}</td>
          <td class="num ${inc ? 'pos' : 'neg'}" style="white-space:nowrap">${inc ? '+ ' : '− '}${eur(Math.abs(t.amount))}</td>
          <td><span class="status ${unm ? 'warning' : 'success'}">${unm ? 'À catégoriser' : 'Classé'}</span></td>
          <td style="width:1%"><button class="icon-btn" type="button" data-txi="${state.tx.indexOf(t)}" aria-label="Voir le mouvement ${esc(t.tiers || '')}" title="Voir le mouvement">${ic('dots')}</button></td></tr>`;
      }).join('') + '</tbody></table>';
  }
  const KIND_IC = {manual:'pen', import:'upload', task:'check', sign:'file'};
  function renderActivity(){
    const box = $('#activity'); if (!box) return;
    const ev = (state.timeline || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 4);
    box.innerHTML = ev.length
      ? ev.map(e => {
          const d = String(e.description || '');
          return `<div class="act"><span class="act-ic">${ic(KIND_IC[e.kind] || 'file')}</span><div style="min-width:0"><h3>${esc(e.title)}</h3>${d ? `<p>${esc(d.length > 96 ? d.slice(0, 95) + '…' : d)}</p>` : ''}<time datetime="${esc(e.date)}">${esc(relDay(e.date))}</time></div></div>`;
        }).join('')
      : '<div class="empty" style="padding:28px 0">Rien de neuf pour l’instant.</div>';
  }
  function renderOwnersProgress(){
    const box = $('#ownersProgress'); if (!box) return;
    let led = []; try { led = ownerLedger(); } catch(e){}
    const due = led.reduce((a, o) => a + (o.due || 0), 0);
    if (!led.length){ box.innerHTML = ''; return; }
    if (due <= 0){ box.innerHTML = '<div class="sub">Renseignez le dû de chacun dans Budget → Provisions pour suivre les paiements.</div>'; return; }
    const paid = led.reduce((a, o) => a + Math.min(o.verse || 0, o.due || 0), 0);
    const ok = led.filter(o => o.solde >= -0.005).length;
    const pct = Math.min(100, Math.round(paid / due * 100));
    box.innerHTML = `<div class="op-row"><span>${ok} copropriétaire${ok > 1 ? 's' : ''} sur ${led.length} à jour</span><b>${eur(paid)} / ${eur(due)}</b></div>
      <div class="track"><div class="fill" data-w="${pct}" style="width:${pct}%"></div></div>`;
  }
  // Prochaine AG : si la date saisie se lit, la tuile affiche le mois et le jour (comme dans le design).
  const MON_RX = 'janv|févr|fevr|mars|avr|mai|juin|juil|août|aout|sept|oct|nov|déc|dec';
  function agTile(){
    const box = $('#agNext'), tile = box && $('.agn-ic', box); if (!tile) return;
    const ag = (state.ags || []).find(a => a.status !== 'finalisee');
    const raw = ag && ag.ag_date ? String(ag.ag_date) : '';
    let day = 0, mon = -1, m;
    if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(raw))){ day = +m[3]; mon = +m[2] - 1; }
    else if ((m = new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MON_RX})`, 'i').exec(raw))){
      day = +m[1]; const k = strip(m[2]).slice(0, 3);
      mon = ['jan','fev','mar','avr','mai','jui','jui','aou','sep','oct','nov','dec'].indexOf(k);
      if (k === 'jui') mon = /juil/i.test(m[2]) ? 6 : 5;
    }
    else if ((m = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.]\d{2,4})?/.exec(raw))){ day = +m[1]; mon = +m[2] - 1; }
    if (day >= 1 && day <= 31 && mon >= 0 && mon < 12)
      tile.innerHTML = `<div><small>${MONTHS[mon].replace('.', '')}</small><strong>${day}</strong></div>`;
  }
  function renderNavBadges(){
    const drafts = (state.draftTx || []).length, unm = state.tx.filter(t => !t.high || t.high === '?').length;
    const b1 = $('#badgeImp'), b2 = $('#badgeAcc');
    if (b1){ b1.textContent = drafts; b1.hidden = !drafts; b1.title = `${plural(drafts,'mouvement')} à valider`; }
    if (b2){ b2.textContent = unm; b2.hidden = !unm; b2.title = `${plural(unm,'mouvement')} à catégoriser`; }
    const dot = $('#tbBellDot'); if (dot) dot.hidden = !alertsList().some(x => !x.info);
  }
  function renderReserveTarget(){
    if (!$('#rtAmt') || typeof balance !== 'function') return;
    const bal = balance('res'), tgt = state.reserveTarget || 0, pct = tgt > 0 ? Math.max(0, Math.min(100, Math.round(bal / tgt * 100))) : 0;
    set('rtAmt', eur(bal)); set('rtTarget', tgt ? `/ ${eur(tgt)}` : '');
    set('rtPct', tgt ? `${pct} % atteint` : 'Sans objectif');
    set('rtRemain', !tgt ? 'Fixez l’objectif dans la fiche du compte de réserve ci-dessus.'
      : bal >= tgt ? 'Objectif atteint.' : `Reste ${eur(tgt - bal)} à constituer.`);
    const f = $('#rtFill'); if (f){ f.dataset.w = pct; f.style.width = pct + '%'; }
  }
  function renderIdentity(){
    const m = (window.LS && window.LS.member) || null;
    const first = m ? ((m.full_name || '').trim().split(/\s+/)[0] || m.owner_short || m.userEmail || '') : '';
    set('tbAv', (first[0] || '·').toUpperCase());
    const ro = $('#tbRo'); if (ro) ro.hidden = !document.body.classList.contains('readonly');
    const demo = typeof demoMode !== 'undefined' && demoMode;
    set('footEnv', demo ? 'Démonstration — données fictives'
      : (typeof ONLINE !== 'undefined' && !ONLINE) ? 'Mode local — données de ce navigateur'
      : (state.coproName || 'Ma copropriété'));
  }

  function renderShell(){
    syncCrumb();
    if (!ready()) return;
    renderIdentity(); renderHero(); renderRecent(); renderActivity(); renderOwnersProgress();
    agTile(); renderNavBadges(); renderReserveTarget();
  }

  // Se redessiner après chaque rendu d'app.js (regroupé en une passe par tâche).
  let queued = false;
  function schedule(){
    if (queued) return; queued = true;
    Promise.resolve().then(() => { queued = false; try { renderShell(); } catch(e){ console.error('[ui]', e); } });
  }
  ['renderAll','renderDashboard','renderChrome','renderNextAG','renderPendingImports','renderTx','renderTimeline',
   'renderReminders','renderAG','applyRoleUI','applyDemoUI'].forEach(n => {
    const f = window[n]; if (typeof f !== 'function') return;
    window[n] = function(){ const r = f.apply(this, arguments); schedule(); return r; };
  });
  // l'onglet « réserve » de Comptes affiche l'objectif : le remplir quand on y passe
  $('#acctseg')?.addEventListener('click', schedule);
  schedule();
})();
