/* ============================================================
   LazySyndic — relevé de compte en PDF, à envoyer aux copropriétaires
   • statementData(o)              — les chiffres d'un compte sur une période
                                     (pur : aucun DOM, aucun réseau, centimes entiers)
   • buildStatementPdf(PDFLib, d)  — le PDF ; pdf-lib est injectée, chargée à la
                                     demande par app.js comme pour le PV
   • statementFileName(d)          — nom de fichier ASCII
   • statementEml(m)               — brouillon d'e-mail .eml, PDF en pièce jointe
   Tests : node --test tests/statement.test.mjs
   ============================================================ */
(function(root){
'use strict';

const cents = n => Math.round((Number(n)||0)*100);
const add = arr => arr.reduce((a,b)=>a+b, 0);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const squash = s => String(s||'').toLowerCase().replace(/\s+/g,' ').trim();

// 2026-01-31 → 31/01/2026
function frDate(iso){ const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }
// 1234.5 → « 1 234,50 € » ; plus = true ajoute « + » devant un montant positif
function money(n, plus){
  const v = Math.abs(n).toLocaleString('fr-BE', {minimumFractionDigits:2, maximumFractionDigits:2});
  return (n < 0 ? '-' : (plus && n > 0 ? '+' : '')) + v + ' €';
}
// BE68539007547034 → BE68 5390 0754 7034
function fmtIban(s){ const c=String(s||'').replace(/\s+/g,'').toUpperCase(); return c ? c.replace(/(.{4})(?=.)/g,'$1 ') : ''; }
function extractLabel(isoDateTime){
  const d = new Date(isoDateTime || Date.now());
  const day = d.toLocaleDateString('fr-BE', {day:'numeric', month:'long', year:'numeric'});
  const time = d.toLocaleTimeString('fr-BE', {hour:'2-digit', minute:'2-digit'});
  return `${day} à ${time}`;
}

/* ------------------------------------------------------------
   o = { acct, label, holder, iban, opening, asOf (ISO, dernier relevé importé),
         fromIso, toIso,
         tx: [{ iso, tiers, note, high, sub, comment, amount }] }  ← TOUTES les lignes du compte
   Le solde de début = solde d'ouverture du compte + tout ce qui précède `fromIso` ;
   le solde disponible = solde de début + les mouvements de la période (bornes incluses).
   ------------------------------------------------------------ */
function statementData(o){
  const all = Array.isArray(o.tx) ? o.tx : [];
  const dated = all.filter(t => t && ISO.test(t.iso||''));
  let bal = cents(o.opening) + add(dated.filter(t => t.iso < o.fromIso).map(t => cents(t.amount)));
  const openingC = bal;
  const rows = dated.map((t,i) => ({t, i}))
    .filter(({t}) => t.iso >= o.fromIso && t.iso <= o.toIso)
    .sort((a,b) => a.t.iso.localeCompare(b.t.iso) || a.i - b.i)   // même jour : ordre d'origine
    .map(({t}) => {
      const c = cents(t.amount); bal += c;
      const tiers = String(t.tiers||'').trim(), note = String(t.note||'').trim();
      return {
        iso: t.iso,
        label: tiers || note || 'Mouvement',
        // chez Swan, tiers et communication portent souvent le même libellé : une seule fois
        detail: note && squash(note) !== squash(tiers) ? note : '',
        category: (!t.high || t.high === '?') ? 'À catégoriser' : t.high + (t.sub ? ' › ' + t.sub : ''),
        comment: String(t.comment||'').trim(),
        amount: c/100, balance: bal/100,
      };
    });
  const inC  = add(rows.filter(r => r.amount > 0).map(r => cents(r.amount)));
  const outC = -add(rows.filter(r => r.amount < 0).map(r => cents(r.amount)));
  return {
    acct: o.acct, label: o.label || 'Compte', holder: String(o.holder||'').trim(), iban: String(o.iban||'').trim(),
    fromIso: o.fromIso, toIso: o.toIso, asOf: ISO.test(o.asOf||'') ? o.asOf : '',
    opening: openingC/100, credits: inC/100, debits: outC/100, closing: bal/100,
    rows, undated: all.length - dated.length,
  };
}

/* ------------------------------------------------------------
   d = { copro:{name, addr, kbo}, extractedAt (ISO), accounts:[statementData…], logo? (PNG) }
   Un compte = une section qui commence sur une nouvelle page ; avec plusieurs comptes,
   la première page s'ouvre sur la synthèse des soldes disponibles.
   ------------------------------------------------------------ */
const SUBST = {'−':'-','–':'-','‑':'-','‐':'-','→':'->','←':'<-','✓':'OK','✔':'OK','\t':' '};
async function buildStatementPdf(PDFLib, d){
  const {PDFDocument, StandardFonts, rgb} = PDFLib;
  const doc = await PDFDocument.create();
  // Pas d'italique (charte) : deux graisses suffisent. Hanken Grotesk n'est pas encore embarquée
  // (pdf-lib + fontkit, police vendorisée) : Helvetica, et safe() replie les signes hors WinAnsi.
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
  const cs = new Set(F.r.getCharacterSet());
  const NB = cs.has(0xA0) ? ' ' : ' ';                  // espace insécable : un montant ne se coupe pas
  const safe = t => [...String(t==null ? '' : t).replace(/\r/g,'')].map(ch => {
    if (ch === '\n' || ch === ' ') return ch;
    if (ch === ' ' || ch === ' ' || ch === ' ' || ch === ' ') return NB;
    if (cs.has(ch.codePointAt(0))) return ch;
    if (SUBST[ch] !== undefined) return SUBST[ch];
    const base = ch.normalize('NFD').replace(/\p{M}/gu,'');  // lettre hors WinAnsi : sans son accent
    if (base && [...base].every(c => cs.has(c.codePointAt(0)))) return base;
    return /\s/.test(ch) ? ' ' : '?';
  }).join('');
  // Les couleurs du design system des documents (pdf.js, LSPdf.tokens.rgb) : le relevé parle la
  // même langue que l'Annexe 4 et les rapports. Repli sur les mêmes valeurs si pdf.js n'est pas là
  // (tests Node du relevé seul).
  const TK = root.LSPdf && root.LSPdf.tokens && root.LSPdf.tokens.rgb, tk = k => rgb(...TK[k]);
  const C = TK
    ? { ink:tk('ink'), soft:tk('soft'), faint:tk('faint'), line:tk('line'), zebra:tk('tint'), green:tk('green'), greenSoft:tk('greenSoft'), deep:tk('greenDeep') }
    : { ink:rgb(.125,.145,.122), soft:rgb(.361,.38,.325), faint:rgb(.541,.561,.502), line:rgb(.89,.906,.882),
        zebra:rgb(.957,.969,.957), green:rgb(.129,.314,.239), greenSoft:rgb(.886,.925,.89), deep:rgb(.086,.227,.173) };
  const W = 595.28, H = 841.89, M = 40, CW = W - 2*M, BOTTOM = M + 24;
  const copro = d.copro || {}, coproName = String(copro.name||'').trim() || 'Copropriété';
  const accounts = d.accounts || [];
  const extracted = extractLabel(d.extractedAt);
  const logo = d.logo ? await doc.embedPng(d.logo).catch(() => null) : null;

  const pages = [];                     // {page, acct}
  let page, y, cur = null;
  const tw = (t, f, s) => f.widthOfTextAtSize(t, s);
  function text(t, x, yy, {font=F.r, size=9, color=C.ink, right=false}={}){
    const s = safe(t); page.drawText(s, {x: right ? x - tw(s,font,size) : x, y: yy, size, font, color});
  }
  function wrap(t, font, size, width){
    const out = [];
    for (const para of safe(t).split('\n')){
      let line = '';
      for (const word of para.split(/ +/)){
        const tryL = line ? line + ' ' + word : word;
        if (tw(tryL, font, size) <= width){ line = tryL; continue; }
        if (line) out.push(line);
        let w = word;                                          // mot plus large que la colonne : coupé
        while (tw(w, font, size) > width){
          let k = w.length; while (k > 1 && tw(w.slice(0,k), font, size) > width) k--;
          out.push(w.slice(0,k)); w = w.slice(k);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }
  const hline = (yy, {x1=M, x2=W-M, t=.5, color=C.line}={}) => page.drawLine({start:{x:x1,y:yy}, end:{x:x2,y:yy}, thickness:t, color});

  /* ---- tableau : cellules multi-lignes, en-tête répété sur chaque page ---- */
  const PAD = 3.6, LH = 1.28;
  // une cellule = [{t, font, size, color}] ; chaque morceau est replié dans la largeur de la colonne
  function cell(cols, k, parts){
    const out = [];
    parts.filter(p => p && p.t !== '' && p.t != null).forEach(p => {
      const font = p.font || F.r, size = p.size || 8.4, color = p.color || C.ink;
      wrap(p.t, font, size, cols[k].w - 2*PAD).forEach(l => out.push({t:l, font, size, color}));
    });
    return out;
  }
  const cellH = lines => lines.reduce((h,l) => h + l.size*LH, 0);
  function drawRow(cols, cells, {zebra=false, top=false, onBreak, keep=0}={}){
    const h = Math.max(...cells.map(cellH), 8.4*LH) + 2*PAD;
    // keep : la place à garder sous cette ligne pour ce qui doit la suivre (les totaux)
    if (y - h - keep < BOTTOM){ newPage(cur); if (onBreak) onBreak(); }
    if (zebra) page.drawRectangle({x:M, y:y-h, width:cols.reduce((n,c)=>n+c.w,0), height:h, color:C.zebra});
    if (top) hline(y, {t:1, color:C.ink});
    let x = M;
    cells.forEach((lines, k) => {
      let yy = y - PAD;
      lines.forEach(l => {
        yy -= l.size;
        const lx = cols[k].right ? x + cols[k].w - PAD - tw(l.t, l.font, l.size) : x + PAD;
        page.drawText(l.t, {x:lx, y:yy+1.2, size:l.size, font:l.font, color:l.color});
        yy -= l.size*(LH-1);
      });
      x += cols[k].w;
    });
    y -= h;
    if (!zebra && !top) hline(y, {t:.35});
  }
  function drawHead(cols){
    const cells = cols.map((c,k) => cell(cols, k, [{t:c.label.toUpperCase(), font:F.b, size:7.5, color:C.soft}]));
    const h = Math.max(...cells.map(cellH)) + 2*PAD;
    if (y - h - 20 < BOTTOM) newPage(cur);
    let x = M;
    cells.forEach((lines, k) => {
      let yy = y - PAD;
      lines.forEach(l => { yy -= l.size;
        const lx = cols[k].right ? x + cols[k].w - PAD - tw(l.t, l.font, l.size) : x + PAD;
        page.drawText(l.t, {x:lx, y:yy+1, size:l.size, font:l.font, color:l.color}); yy -= l.size*(LH-1); });
      x += cols[k].w;
    });
    y -= h; hline(y, {t:1.1, color:C.ink});
  }

  /* ---- pages ---- */
  function newPage(acct){
    page = doc.addPage([W, H]); pages.push({page, acct});
    y = H - M;
    if (pages.length > 1 && acct && acct._started){             // page de suite : en-tête court
      text(coproName, M, y - 8, {font:F.b, size:8.5});
      text(`${acct.label} · du ${frDate(acct.fromIso)} au ${frDate(acct.toIso)} (suite)`, W - M, y - 8, {size:8.5, color:C.soft, right:true});
      y -= 16; hline(y); y -= 10;
    }
  }
  function docHeader(){
    const top = y;
    if (logo){ const s = 26 / logo.height; page.drawImage(logo, {x:M, y:top - 26, width:logo.width*s, height:26}); }
    else text('LazySyndic', M, top - 18, {font:F.b, size:15, color:C.deep});
    text(`Extrait le ${extracted}`, W - M, top - 10, {size:8.5, color:C.soft, right:true});
    y = top - 38; hline(y, {t:1.4, color:C.deep}); y -= 26;
    text('Relevé de compte', M, y, {font:F.b, size:21, color:C.green}); y -= 17;
    text(coproName, M, y, {font:F.b, size:10.5}); y -= 12.5;
    const sub = [copro.addr, copro.kbo ? 'BCE ' + String(copro.kbo).replace(/^\s*BCE\s*/i,'') : ''].filter(Boolean).join(' · ');
    if (sub){ text(sub, M, y, {size:8.5, color:C.soft}); y -= 12; }
    y -= 8;
  }
  function synthesis(){
    const cols = [{w:150,label:'Compte'},{w:CW-150-138-112,label:'Titulaire'},{w:138,label:'IBAN'},{w:112,label:'Solde disponible',right:true}];
    text('Synthèse des comptes', M, y - 10, {font:F.b, size:11, color:C.deep}); y -= 20;
    drawHead(cols);
    accounts.forEach(a => drawRow(cols, [
      cell(cols,0,[{t:a.label, font:F.b}]), cell(cols,1,[{t:a.holder||'Non renseigné'}]),
      cell(cols,2,[{t:fmtIban(a.iban)||'Non renseigné'}]),
      cell(cols,3,[{t:money(a.closing), font:F.b}, {t:'au ' + frDate(a.toIso), size:7.5, color:C.soft}]),
    ]));
    const tot = add(accounts.map(a => cents(a.closing)))/100;
    drawRow(cols, [cell(cols,0,[{t:'Total disponible', font:F.b}]), [], [], cell(cols,3,[{t:money(tot), font:F.b, color:C.green}])], {top:true});
    y -= 22;
  }
  function infoGrid(a){
    const cells = [
      ['Titulaire du compte', a.holder || 'Non renseigné'], ['IBAN', fmtIban(a.iban) || 'Non renseigné'],
      ['Période', `du ${frDate(a.fromIso)} au ${frDate(a.toIso)}`], ["Date d'extraction", extracted],
    ];
    const colW = CW/2;
    for (let r = 0; r < 2; r++){
      let rowH = 0;
      cells.slice(r*2, r*2+2).forEach(([lbl, val], k) => {
        const x = M + k*colW;
        text(lbl.toUpperCase(), x, y - 7, {font:F.b, size:7.5, color:C.soft});
        const lines = wrap(val, F.r, 10, colW - 12);
        lines.forEach((l, j) => page.drawText(l, {x, y:y - 20 - j*12.5, size:10, font:F.r, color:C.ink}));
        rowH = Math.max(rowH, 22 + lines.length*12.5);
      });
      y -= rowH;
    }
    y -= 6;
  }
  function summary(a){
    const boxes = [
      {lbl:`Solde au ${frDate(a.fromIso)}`, val:money(a.opening), w:1},
      {lbl:'Entrées de la période', val:money(a.credits, true), w:1, color:C.green},
      {lbl:'Sorties de la période', val:money(-a.debits), w:1},
      {lbl:`Solde disponible au ${frDate(a.toIso)}`, val:money(a.closing), w:1.35, strong:true},
    ];
    const GAP = 8, unit = (CW - GAP*(boxes.length-1)) / add(boxes.map(b => b.w)), BH = 50;
    let x = M;
    boxes.forEach(b => {
      const w = unit*b.w;
      page.drawRectangle({x, y:y-BH, width:w, height:BH, color: b.strong ? C.greenSoft : undefined,
        borderColor: b.strong ? C.green : C.line, borderWidth: b.strong ? 1 : .7});
      text(b.lbl.toUpperCase(), x + 9, y - 14, {font:F.b, size:7.5, color: b.strong ? C.green : C.soft});
      text(b.val, x + 9, y - 36, {font:F.b, size: b.strong ? 15 : 12.5, color: b.strong ? C.green : (b.color || C.ink)});
      x += w + GAP;
    });
    y -= BH + 12;
  }
  function notes(a){
    const n = a.rows.length;
    const out = [`${n} mouvement${n>1?'s':''} sur la période.`];
    if (a.asOf){
      out.push(`Mouvements enregistrés jusqu'au dernier relevé bancaire importé, arrêté au ${frDate(a.asOf)}.`
        + (a.toIso > a.asOf ? ' Les mouvements postérieurs ne figurent pas encore dans ce relevé.' : ''));
    }
    if (a.undated) out.push(`${a.undated} mouvement${a.undated>1?'s':''} sans date lisible ${a.undated>1?'ne sont':"n'est"} pas repris.`);
    out.forEach(t => wrap(t, F.r, 8.2, CW).forEach(l => { page.drawText(l, {x:M, y:y-8, size:8.2, font:F.r, color:C.soft}); y -= 11; }));
    y -= 10;
  }
  const TX = (() => {
    const dW = 54, cW = 96, aW = 62, bW = 68;
    return [{w:dW,label:'Date'},{w:CW-dW-cW-2*aW-bW,label:'Libellé'},{w:cW,label:'Catégorie'},
            {w:aW,label:'Débit',right:true},{w:aW,label:'Crédit',right:true},{w:bW,label:'Solde',right:true}];
  })();
  const KEEP = 46;                                           // ligne des totaux + solde disponible
  function txTable(a){
    const head = () => drawHead(TX);
    head();
    drawRow(TX, [cell(TX,0,[{t:frDate(a.fromIso)}]), cell(TX,1,[{t:'Solde au début de la période', font:F.r, color:C.soft}]), [], [], [],
                 cell(TX,5,[{t:money(a.opening), font:F.b}])], {onBreak:head, keep: a.rows.length ? 0 : 2*KEEP});
    if (!a.rows.length)
      drawRow(TX, [[], cell(TX,1,[{t:'Aucun mouvement sur la période.', font:F.r, color:C.soft}]), [], [], [], []], {onBreak:head, keep:KEEP});
    a.rows.forEach((r, i) => drawRow(TX, [
      cell(TX,0,[{t:frDate(r.iso)}]),
      cell(TX,1,[{t:r.label}, r.detail && {t:r.detail, size:7.5, color:C.soft}, r.comment && {t:'Note : ' + r.comment, size:7.5, color:C.soft}]),
      cell(TX,2,[{t:r.category, size:7.6, color: r.category === 'À catégoriser' ? C.faint : C.soft}]),
      cell(TX,3,[r.amount < 0 && {t:money(-r.amount)}]),
      cell(TX,4,[r.amount > 0 && {t:money(r.amount), color:C.green}]),
      cell(TX,5,[{t:money(r.balance)}]),
    ], {zebra: i % 2 === 1, onBreak:head, keep: i === a.rows.length-1 ? KEEP : 0}));   // la dernière ligne ne quitte pas les totaux
    drawRow(TX, [[], cell(TX,1,[{t:'Totaux de la période', font:F.b}]), [],
      cell(TX,3,[{t:money(a.debits), font:F.b}]), cell(TX,4,[{t:money(a.credits), font:F.b, color:C.green}]),
      cell(TX,5,[{t:money(a.closing), font:F.b}])], {top:true, onBreak:head});
    y -= 6;
    if (y - 16 < BOTTOM) newPage(cur);
    text(`Solde disponible au ${frDate(a.toIso)} : ${money(a.closing)}`, W - M - PAD, y - 10, {font:F.b, size:10.5, color:C.green, right:true});
    y -= 20;
  }

  if (!accounts.length){ newPage(null); docHeader(); text('Aucun compte sélectionné.', M, y, {font:F.r, color:C.soft}); }
  accounts.forEach((a, k) => {
    cur = a; newPage(a); docHeader();
    if (k === 0 && accounts.length > 1) synthesis();
    a._started = true;
    if (y < 300) newPage(a);
    text(a.label, M, y - 12, {font:F.b, size:14, color:C.ink}); y -= 26;
    infoGrid(a); summary(a); notes(a); txTable(a);
  });
  accounts.forEach(a => { delete a._started; });

  pages.forEach(({page:pg, acct}, i) => {
    const left = safe(`${coproName} · Relevé de compte${acct ? ' · ' + acct.label : ''} · extrait le ${extracted}`);
    pg.drawLine({start:{x:M, y:M-4}, end:{x:W-M, y:M-4}, thickness:.4, color:C.line});
    pg.drawText(left, {x:M, y:M-15, size:7.5, font:F.r, color:C.soft});
    const r = safe(`page ${i+1} / ${pages.length}`);
    pg.drawText(r, {x:W-M-tw(r, F.r, 7.5), y:M-15, size:7.5, font:F.r, color:C.soft});
  });
  const when = new Date(d.extractedAt || Date.now());
  const p0 = accounts[0];
  doc.setTitle(safe(`Relevé de compte · ${coproName}` + (p0 ? ` · du ${frDate(p0.fromIso)} au ${frDate(p0.toIso)}` : '')));
  doc.setSubject(safe(accounts.map(a => a.label).join(', ')));
  doc.setAuthor(safe(coproName));
  doc.setCreator('LazySyndic'); doc.setProducer('LazySyndic (pdf-lib)');
  doc.setLanguage('fr-BE');
  doc.setCreationDate(when); doc.setModificationDate(when);
  return await doc.save({useObjectStreams:false});
}

const slug = s => String(s||'').normalize('NFD').replace(/\p{M}/gu,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
function statementFileName(d){
  const a = d.accounts || [];
  const which = a.length > 1 ? 'comptes' : (a[0] ? ({pay:'paiement', res:'reserve'}[a[0].acct] || slug(a[0].label)) : 'compte');
  const p = a[0] || {};
  return `Releve_${slug((d.copro||{}).name) || 'copropriete'}_${which}_${p.fromIso||''}_${p.toIso||''}.pdf`;
}

/* ------------------------------------------------------------
   m = { fromName, from, to:[e-mails], subject, body, fileName, bytes (Uint8Array) }
   X-Unsent : Outlook (et d'autres) ouvrent le fichier en brouillon prêt à partir.
   ------------------------------------------------------------ */
function b64(bytes){
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64Text = s => b64(new TextEncoder().encode(String(s)));
const lines76 = s => s.replace(/.{1,76}/g, '$&\r\n');
const word = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64Text(s)}?=`;
function statementEml(m){
  const boundary = '=_LazySyndic_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const file = String(m.fileName || 'releve.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
  const head = [];
  if (m.from) head.push(`From: ${m.fromName ? word(m.fromName) + ' ' : ''}<${m.from}>`);
  head.push(`To: ${(m.to||[]).join(', ')}`);
  head.push(`Subject: ${word(m.subject||'')}`);
  head.push('MIME-Version: 1.0', 'X-Unsent: 1', `Content-Type: multipart/mixed; boundary="${boundary}"`);
  return head.join('\r\n') + '\r\n\r\n'
    + `--${boundary}\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + lines76(b64Text(String(m.body||'').replace(/\r?\n/g, '\r\n')))
    + `--${boundary}\r\nContent-Type: application/pdf; name="${file}"\r\nContent-Disposition: attachment; filename="${file}"\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + lines76(b64(m.bytes))
    + `--${boundary}--\r\n`;
}

const api = { statementData, buildStatementPdf, statementFileName, statementEml, money, frDate, fmtIban };
root.LSStatement = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
