/* ============================================================
   LazySyndic — « Contrats en cours » (Annexe 1) en PDF, téléchargé en un clic
   • contractsModel(list)          — contrats en cours et clôturés, prêts à mettre en page
                                     (pur : aucun DOM, aucun réseau)
   • buildContractsPdf(PDFLib, d)  — le PDF ; pdf-lib est injectée, chargée à la demande
                                     par app.js comme pour le relevé de compte
   • contractsFileName(d)          — nom de fichier ASCII
   Même mise en page que le relevé de compte (statement.js) : A4, Helvetica, en-tête répété.
   Tests : node --test tests/contracts.test.mjs
   ============================================================ */
(function(root){
'use strict';

const v = x => { const s = String(x == null ? '' : x).trim(); return s === '—' ? '' : s; };
// d = [{name, ref, type, start, end, note, endNote, fournisseur, status}] → {active:[…], closed:[…]}
// Une ligne = {name, sub, ref, supplier, desc} ; sub = type et période, sous le nom.
function contractsModel(list){
  const row = (c, closed) => ({
    name: v(c.name), ref: v(c.ref), supplier: v(c.fournisseur),
    sub: [v(c.type), closed ? [v(c.start), v(c.end)].filter(Boolean).join(' → ') : (v(c.start) ? `depuis le ${v(c.start)}` : '')].filter(Boolean).join(' · '),
    desc: closed ? (v(c.endNote) || v(c.note)) : v(c.note),
  });
  const all = (Array.isArray(list) ? list : []).filter(c => c && typeof c === 'object');
  return { active: all.filter(c => c.status !== 'cloture').map(c => row(c, false)), closed: all.filter(c => c.status === 'cloture').map(c => row(c, true)) };
}

const SUBST = {'−':'-','–':'-','‑':'-','‐':'-','→':'->','←':'<-','✓':'OK','✔':'OK','\t':' '};
// d = { copro:{name, addr, kbo}, contracts:[…], at (ISO, date d'édition), logo (PNG, Uint8Array) }
async function buildContractsPdf(PDFLib, d){
  const {PDFDocument, StandardFonts, rgb} = PDFLib;
  const doc = await PDFDocument.create();
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
  const cs = new Set(F.r.getCharacterSet());
  const safe = t => [...String(t == null ? '' : t).replace(/\r/g, '')].map(ch => {
    if (ch === '\n' || ch === ' ') return ch;
    if (cs.has(ch.codePointAt(0))) return ch;
    if (SUBST[ch] !== undefined) return SUBST[ch];
    const base = ch.normalize('NFD').replace(/\p{M}/gu, '');     // lettre hors WinAnsi : sans son accent
    if (base && [...base].every(c => cs.has(c.codePointAt(0)))) return base;
    return /\s/.test(ch) ? ' ' : '?';
  }).join('');
  const TK = root.LSPdf && root.LSPdf.tokens && root.LSPdf.tokens.rgb, tk = k => rgb(...TK[k]);
  const C = TK
    ? { ink:tk('ink'), soft:tk('soft'), faint:tk('faint'), line:tk('line'), green:tk('green'), deep:tk('greenDeep') }
    : { ink:rgb(.125,.145,.122), soft:rgb(.361,.38,.325), faint:rgb(.541,.561,.502), line:rgb(.89,.906,.882), green:rgb(.129,.314,.239), deep:rgb(.086,.227,.173) };
  const W = 595.28, H = 841.89, M = 40, CW = W - 2*M, BOTTOM = M + 24;
  const copro = d.copro || {}, coproName = String(copro.name || '').trim() || 'Copropriété';
  const model = contractsModel(d.contracts), when = new Date(d.at || Date.now());
  const edited = when.toLocaleDateString('fr-BE', {day:'numeric', month:'long', year:'numeric'});
  const logo = d.logo ? await doc.embedPng(d.logo).catch(() => null) : null;

  const pages = []; let page, y;
  const tw = (t, f, s) => f.widthOfTextAtSize(t, s);
  function text(t, x, yy, {font=F.r, size=9, color=C.ink, right=false}={}){
    const s = safe(t); page.drawText(s, {x: right ? x - tw(s, font, size) : x, y: yy, size, font, color});
  }
  function wrap(t, font, size, width){
    const out = [];
    for (const para of safe(t).split('\n')){
      let line = '';
      for (const word of para.split(/ +/)){
        const tryL = line ? line + ' ' + word : word;
        if (tw(tryL, font, size) <= width){ line = tryL; continue; }
        if (line) out.push(line);
        let w = word;                                            // mot plus large que la colonne : coupé
        while (tw(w, font, size) > width){
          let k = w.length; while (k > 1 && tw(w.slice(0, k), font, size) > width) k--;
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }
  const hline = (yy, {t=.5, color=C.line}={}) => page.drawLine({start:{x:M, y:yy}, end:{x:W - M, y:yy}, thickness:t, color});
  function newPage(){
    page = doc.addPage([W, H]); pages.push(page); y = H - M;
    if (pages.length > 1){                                       // page de suite : en-tête court
      text(coproName, M, y - 8, {font:F.b, size:8.5});
      text('Contrats en cours (suite)', W - M, y - 8, {size:8.5, color:C.soft, right:true});
      y -= 16; hline(y); y -= 10;
    }
  }

  /* ---- tableau : cellules multi-lignes, en-tête répété sur chaque page ---- */
  const PAD = 5, LH = 1.3;
  const COLS = [{label:'Nom', w:CW*.26}, {label:'Référence', w:CW*.2}, {label:'Fournisseur', w:CW*.18}, {label:'Description', w:CW*.36}];
  const cell = (k, parts) => parts.filter(p => p && p.t).flatMap(p => { const font = p.font || F.r, size = p.size || 9, color = p.color || C.ink;
    return wrap(p.t, font, size, COLS[k].w - 2*PAD).map(t => ({t, font, size, color})); });
  const cellH = lines => lines.reduce((h, l) => h + l.size*LH, 0);
  function drawCells(cells, yTop){
    let x = M;
    cells.forEach((lines, k) => { let yy = yTop - PAD;
      lines.forEach(l => { yy -= l.size; page.drawText(l.t, {x:x + PAD, y:yy + 1.2, size:l.size, font:l.font, color:l.color}); yy -= l.size*(LH - 1); });
      x += COLS[k].w; });
  }
  function drawHead(){
    const cells = COLS.map((c, k) => cell(k, [{t:c.label.toUpperCase(), font:F.b, size:7.5, color:C.soft}]));
    const h = Math.max(...cells.map(cellH)) + 2*PAD;
    drawCells(cells, y); y -= h; hline(y, {t:1.1, color:C.ink});
  }
  function drawRow(r){
    const cells = [cell(0, [{t:r.name, font:F.b}, {t:r.sub, size:7.8, color:C.faint}]), cell(1, [{t:r.ref}]), cell(2, [{t:r.supplier}]), cell(3, [{t:r.desc}])];
    const h = Math.max(...cells.map(cellH), 9*LH) + 2*PAD;
    if (y - h < BOTTOM){ newPage(); drawHead(); }
    drawCells(cells, y); y -= h; hline(y, {t:.35});
  }
  function section(title, sub, rows, empty){
    if (y - 90 < BOTTOM) newPage();
    text(title, M, y, {font:F.b, size:12, color:C.green}); y -= 6; hline(y, {t:.9, color:C.green}); y -= 13;
    text(sub, M, y, {size:8.5, color:C.soft}); y -= 12;
    drawHead();
    if (!rows.length){ y -= 16; text(empty, M + PAD, y, {size:9, color:C.faint}); y -= 10; hline(y, {t:.35}); }
    rows.forEach(drawRow);
    y -= 22;
  }

  /* ---- document ---- */
  newPage();
  const top = y;
  if (logo){ const s = 26 / logo.height; page.drawImage(logo, {x:M, y:top - 26, width:logo.width*s, height:26}); }
  else text('LazySyndic', M, top - 18, {font:F.b, size:15, color:C.deep});
  text('Annexe 1 · Contrats en cours', W - M, top - 10, {font:F.b, size:8.5, color:C.green, right:true});
  text(`Édité le ${edited}`, W - M, top - 22, {size:8.5, color:C.soft, right:true});
  y = top - 38; hline(y, {t:1.4, color:C.deep}); y -= 26;
  text('Contrats en cours', M, y, {font:F.b, size:21, color:C.green}); y -= 17;
  text(coproName, M, y, {font:F.b, size:10.5}); y -= 12.5;
  const sub = [copro.addr, copro.kbo ? 'BCE ' + String(copro.kbo).replace(/^\s*BCE\s*/i, '') : ''].filter(Boolean).join(' · ');
  if (sub){ text(sub, M, y, {size:8.5, color:C.soft}); y -= 12; }
  y -= 16;
  const n = (k, one, many) => `${k} ${k > 1 ? many : one}`;
  section(`Contrats liant ${coproName}`, `${n(model.active.length, 'contrat en cours', 'contrats en cours')} au ${when.toLocaleDateString('fr-BE')}`, model.active, 'Aucun contrat en cours.');
  if (model.closed.length) section('Contrats clôturés', n(model.closed.length, 'contrat arrivé à terme ou résilié', 'contrats arrivés à terme ou résiliés'), model.closed, '');

  pages.forEach((p, i) => { page = p;                             // pied de page : document, pagination
    hline(M + 10, {t:.5});
    text(`Document généré par LazySyndic — ${coproName} · Annexe 1 · Contrats en cours`, M, M - 2, {size:7.5, color:C.faint});
    text(`Page ${i + 1} / ${pages.length}`, W - M, M - 2, {size:7.5, color:C.faint, right:true}); });

  doc.setTitle(safe(`Contrats en cours · ${coproName}`));
  doc.setSubject('Annexe 1 - Contrats en cours'); doc.setAuthor(safe(coproName));
  doc.setCreator('LazySyndic'); doc.setProducer('LazySyndic (pdf-lib)'); doc.setLanguage('fr-BE');
  doc.setCreationDate(when); doc.setModificationDate(when);
  return await doc.save({useObjectStreams:false});
}

const slug = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
// Contrats-en-cours_ACP-Demo_2026-11-23.pdf
function contractsFileName(d){
  const iso = String(d.at || new Date().toISOString()).slice(0, 10);
  return `Contrats-en-cours_${slug((d.copro || {}).name) || 'copropriete'}_${iso}.pdf`;
}

const api = { contractsModel, buildContractsPdf, contractsFileName };
root.LSContracts = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
