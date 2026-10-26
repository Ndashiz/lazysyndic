/* ============================================================
   LazySyndic — appels de fonds (LSCalls)
   Pur : aucun DOM, aucun réseau, montants calculés en centimes entiers.
   • communication structurée belge (OGM) : ogmFromSeed(), ogmFormat(), ogmValid(), ogmIn()
     12 chiffres, les deux derniers = reste de la division des dix premiers par 97 (0 → 97) ;
     une par copropriétaire, posée une fois (ls_owners.ogm), jamais recalculée
   • schedule(annuel, périodicité, année) — l'échéancier au centime (mensuel, trimestriel, annuel),
     chaque échéance due le 1er du mois qui ouvre sa période ; expectedInMonth() pour le suivi
   • callModel() — tout ce qu'un appel de fonds affiche, sans HTML ; text(), html(), buildPdf()
     en font le message et le document (pdf-lib), fileName() le nom du fichier
   Tests : node --test tests/calls.test.mjs
   ============================================================ */
(function(root){
'use strict';

const cents = n => Math.round((Number(n)||0)*100);
const r2 = n => Math.round((Number(n)||0)*100)/100;
const digits = s => String(s==null ? '' : s).replace(/\D/g,'');
const esc = s => String(s==null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const eur = n => (Math.abs(Number(n)||0) < 0.005 ? 0 : Number(n)||0).toLocaleString('fr-BE', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' €';
const frDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const frDateLong = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${+m[3]} ${MONTHS[+m[2]-1]} ${m[1]}` : ''; };

/* ------------------------------------------------------------
   Communication structurée (OGM / VCS)
   ------------------------------------------------------------ */
function ogmCheck(d10){ const r = Number(d10) % 97; return String(r === 0 ? 97 : r).padStart(2, '0'); }
function ogmFromDigits(d10){ const d = digits(d10).padStart(10, '0').slice(-10); return d + ogmCheck(d); }
// Une communication stable par copropriétaire : un préfixe lisible (001 = premier de la liste) et
// sept chiffres tirés de la graine (son identifiant), puis les deux chiffres de contrôle.
function ogmFromSeed(seed, prefix){
  let h = 2166136261 >>> 0;                                        // FNV-1a 32 bits
  for (const ch of String(seed||'')){ h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const seven = String(h % 10000000).padStart(7, '0');
  const three = String(Math.max(0, Math.min(999, Math.floor(Number(prefix)) || 0))).padStart(3, '0');
  return ogmFromDigits(three + seven);
}
const ogmValid = s => { const d = digits(s); return d.length === 12 && d.slice(10) === ogmCheck(d.slice(0, 10)); };
const ogmFormat = s => { const d = digits(s); return d.length === 12 ? `+++${d.slice(0,3)}/${d.slice(3,7)}/${d.slice(7)}+++` : ''; };
// La communication telle qu'une banque la restitue dans un libellé : « +++123/4567/89012+++ »,
// « ***123/4567/89012*** » ou « 123/4567/89012 » ; renvoie ses 12 chiffres si le contrôle passe, sinon ''.
const OGM_RE = /(?:\+{3}|\*{3})?\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*(?:\+{3}|\*{3})?/;
function ogmIn(text){ const m = OGM_RE.exec(String(text||'')); if (!m) return ''; const d = m[1] + m[2] + m[3]; return ogmValid(d) ? d : ''; }

/* ------------------------------------------------------------
   Échéancier
   ------------------------------------------------------------ */
const PERIODS = { month:{ n:12, label:'mensuel', every:'chaque mois', one:'mensualité' },
                  quarter:{ n:4, label:'trimestriel', every:'chaque trimestre', one:'appel trimestriel' },
                  year:{ n:1, label:'annuel', every:'une fois par an', one:'appel annuel' } };
const cleanPeriodicity = p => PERIODS[p] ? p : 'month';
// Montant annuel réparti en n échéances au centime (le reste sur les premières), dues le 1er du
// mois qui ouvre leur période : janvier, avril, juillet, octobre pour un trimestre.
function schedule(annual, periodicity, year){
  const P = PERIODS[cleanPeriodicity(periodicity)], A = cents(annual), base = Math.floor(A / P.n), rest = A - base * P.n;
  const out = [];
  for (let i = 0; i < P.n; i++){
    const month = 1 + i * (12 / P.n);
    out.push({ n:i + 1, month, due:`${year}-${String(month).padStart(2, '0')}-01`, amount:(base + (i < rest ? 1 : 0)) / 100 });
  }
  return out;
}
// Ce qu'un copropriétaire doit verser au mois m (1-12) selon sa périodicité : 0 hors échéance.
function expectedInMonth(annual, periodicity, year, month){
  return r2(schedule(annual, periodicity, year).filter(e => e.month === month).reduce((s, e) => s + e.amount, 0));
}

/* ------------------------------------------------------------
   Le modèle d'un appel de fonds
   o = {name, short, q, email, ogm, periodicity} ; amounts = {pay, res} (dû annuel : charges courantes,
   fonds de réserve) ; ctx = {year, qTot, copro:{name, addr, kbo}, iban, syndic:{name, email}, issuedAt (ISO),
   approved (texte libre : « budget approuvé par l'AG du … »)}
   ------------------------------------------------------------ */
function callModel(o, amounts, ctx){
  const per = cleanPeriodicity(o.periodicity), P = PERIODS[per];
  const pay = r2(amounts.pay), res = r2(amounts.res), total = r2(pay + res);
  const payRows = schedule(pay, per, ctx.year), resRows = schedule(res, per, ctx.year);
  const rows = payRows.map((r, i) => ({ n:r.n, month:r.month, due:r.due, pay:r.amount, res:resRows[i].amount, amount:r2(r.amount + resRows[i].amount) }));
  return { year:ctx.year, periodicity:per, periodLabel:P.label, every:P.every, one:P.one,
    owner:{ name:o.name || o.short || '', short:o.short || o.name || '', q:Number(o.q) || 0, qTot:Number(ctx.qTot) || 0, email:o.email || '' },
    pay, res, total, perPeriod: rows.length ? rows[0].amount : 0, rows,
    ogm: ogmValid(o.ogm) ? ogmFormat(o.ogm) : '', iban: String(ctx.iban || '').trim(),
    copro: ctx.copro || {}, syndic: ctx.syndic || {}, issuedAt: ctx.issuedAt || '', approved: ctx.approved || '' };
}
const coproName = m => String((m.copro||{}).name||'').trim() || 'la copropriété';
const subject = m => `Appel de fonds ${m.year} · ${coproName(m)}`;
const fmtIban = s => digits(String(s||'').toUpperCase()).length ? String(s||'').toUpperCase().replace(/\s+/g,'').replace(/(.{4})/g,'$1 ').trim() : '';

function text(m){
  const cn = coproName(m);
  const lines = m.rows.map(r => `  ${String(r.n).padStart(2,' ')}. ${frDate(r.due)}   ${eur(r.amount)}${m.res ? `   (charges ${eur(r.pay)} + réserve ${eur(r.res)})` : ''}`).join('\n');
  return `Bonjour ${m.owner.name},

Voici votre appel de fonds ${m.year} pour ${cn}${m.approved ? ` (${m.approved})` : ''}.
Votre part : ${eur(m.total)} pour l'année (charges courantes ${eur(m.pay)}${m.res ? `, fonds de réserve ${eur(m.res)}` : ''}), soit ${eur(m.perPeriod)} ${m.every}.

Échéances :
${lines}

Merci de verser chaque échéance${m.iban ? ` sur le compte de la copropriété ${fmtIban(m.iban)}` : ''}${m.ogm ? `, avec la communication structurée ${m.ogm}` : ''}. Un virement permanent avec cette communication évite tout oubli et toute erreur d'attribution.

Cordialement,
${(m.syndic||{}).name || 'Le syndic'}, syndic de ${cn}
`;
}

const T = { bg:'#F7F9F7', card:'#FFFFFF', ink:'#1D2A24', muted:'#6C746F', line:'#E0E5E2', primary:'#005F45', deep:'#21503D', secondary:'#E6F3EB', mint:'#BFE3CF', clay:'#C9854A' };
const FONT = "'Hanken Grotesk','Segoe UI',Helvetica,Arial,sans-serif";
// Le corps HTML du message (clients mail : tableaux et styles en ligne, pas de variables CSS).
function html(m){
  const cn = esc(coproName(m)), base = `font-family:${FONT};`;
  const td = (st, inner, attrs='') => `<td ${attrs} style="${st}">${inner}</td>`;
  const rows = m.rows.map(r => `<tr>${td(`${base}font-size:13px;line-height:20px;color:${T.ink};padding:5px 0;border-bottom:1px solid ${T.line}`, `${r.n}. ${esc(frDateLong(r.due))}`)}${td(`${base}font-size:13px;line-height:20px;color:${T.ink};padding:5px 0;border-bottom:1px solid ${T.line};font-weight:700`, esc(eur(r.amount)), 'align="right"')}</tr>`).join('');
  const logo = m.logoCid ? `<img src="cid:${esc(m.logoCid)}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0;border-radius:8px">` : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${T.deep}" style="width:34px;height:34px;border-radius:8px"></td></tr></table>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bg}" style="background-color:${T.bg};margin:0;padding:0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.card}" style="width:560px;max-width:100%;background-color:${T.card};border:1px solid ${T.line};border-radius:10px">
<tr><td style="padding:18px 28px;border-bottom:1px solid ${T.line}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${td('width:34px;padding-right:10px', logo, 'valign="middle"')}
${td(`${base}font-size:17px;line-height:22px;color:${T.deep}`, '<span style="font-weight:800">Lazy</span><span style="font-weight:600">Syndic</span>', 'valign="middle"')}
${td(`${base}font-size:12px;line-height:18px;color:${T.muted};white-space:nowrap`, `Appel de fonds · ${esc(frDateLong(m.issuedAt))}`, 'valign="middle" align="right"')}</tr></table></td></tr>
<tr><td bgcolor="${T.primary}" style="background-color:${T.primary};padding:24px 28px">
<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.mint}">${cn} · exercice ${m.year}</div>
<div style="${base}font-size:26px;line-height:32px;font-weight:800;color:#FFFFFF;margin-top:6px">${esc(eur(m.perPeriod))} ${esc(m.every)}</div>
<div style="${base}font-size:13px;line-height:18px;color:${T.mint};margin-top:4px">${esc(eur(m.total))} pour l'année · charges courantes ${esc(eur(m.pay))}${m.res ? ` · fonds de réserve ${esc(eur(m.res))}` : ''}</div></td></tr>
<tr><td style="padding:24px 28px 8px;${base}color:${T.ink}">
<p style="margin:0 0 14px;${base}font-size:15px;line-height:22px;font-weight:700;color:${T.ink}">Bonjour ${esc(m.owner.name)},</p>
<p style="margin:0 0 14px;${base}font-size:14px;line-height:22px;color:${T.ink}">Voici votre appel de fonds ${m.year} pour <b>${cn}</b>${m.approved ? ` (${esc(m.approved)})` : ''}. Votre part est calculée sur ${m.owner.q}${m.owner.qTot ? ` / ${m.owner.qTot}` : ''} millièmes, selon la clé de chaque poste du budget.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr>${td(`${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.muted};padding:0 0 6px;border-bottom:2px solid ${T.line}`, 'Échéance')}${td(`${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.muted};padding:0 0 6px;border-bottom:2px solid ${T.line}`, 'Montant', 'align="right"')}</tr>${rows}</table>
${(m.iban || m.ogm) ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.secondary}" style="background-color:${T.secondary};border-radius:8px;margin:0 0 14px"><tr><td style="padding:12px 14px;border-left:3px solid ${T.clay}">
${m.iban ? `<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.deep}">Compte de la copropriété</div><div style="${base}font-size:16px;line-height:22px;font-weight:700;color:${T.ink};margin-top:3px">${esc(fmtIban(m.iban))}</div>` : ''}
${m.ogm ? `<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.deep};margin-top:${m.iban ? 10 : 0}px">Communication structurée, à reprendre sur chaque virement</div><div style="${base}font-size:18px;line-height:24px;font-weight:800;color:${T.ink};margin-top:3px;letter-spacing:.5px">${esc(m.ogm)}</div>` : ''}
</td></tr></table>` : ''}
<p style="margin:0 0 14px;${base}font-size:14px;line-height:22px;color:${T.ink}">Un virement permanent avec cette communication évite tout oubli et toute erreur d'attribution. L'appel de fonds complet est joint à ce message.</p>
<p style="margin:0 0 20px;${base}font-size:14px;line-height:22px;color:${T.ink}">Cordialement,<br><b>${esc((m.syndic||{}).name || 'Le syndic')}</b>, syndic de ${cn}</p></td></tr>
<tr><td style="padding:12px 28px 16px;border-top:1px solid ${T.line};${base}font-size:11px;line-height:16px;color:${T.muted}">Message préparé avec LazySyndic.</td></tr>
</table></td></tr></table>`;
}

/* ------------------------------------------------------------
   Le document (pdf-lib) : une page par copropriétaire. `models` = un modèle ou une liste.
   ------------------------------------------------------------ */
const SUBST = {'−':'-','–':'-','‑':'-','‐':'-','→':'->','←':'<-','✓':'OK','✔':'OK','\t':' '};
async function buildPdf(PDFLib, models, opts){
  const {PDFDocument, StandardFonts, rgb} = PDFLib;
  const list = Array.isArray(models) ? models : [models];
  const doc = await PDFDocument.create();
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
  const cs = new Set(F.r.getCharacterSet());
  const NB = cs.has(0xA0) ? ' ' : ' ';
  const safe = t => [...String(t==null ? '' : t).replace(/\r/g,'')].map(ch => {
    if (ch === '\n' || ch === ' ') return ch;
    if (ch === ' ' || ch === ' ' || ch === ' ' || ch === ' ') return NB;
    if (cs.has(ch.codePointAt(0))) return ch;
    if (SUBST[ch] !== undefined) return SUBST[ch];
    const b = ch.normalize('NFD').replace(/\p{M}/gu,'');
    if (b && [...b].every(c => cs.has(c.codePointAt(0)))) return b;
    return /\s/.test(ch) ? ' ' : '?';
  }).join('');
  const TK = root.LSPdf && root.LSPdf.tokens && root.LSPdf.tokens.rgb, tk = k => rgb(...TK[k]);
  const C = TK
    ? { ink:tk('ink'), soft:tk('soft'), line:tk('line'), tint:tk('tint'), tint2:tk('tint2'), green:tk('green'), deep:tk('greenDeep') }
    : { ink:rgb(.125,.145,.122), soft:rgb(.361,.38,.325), line:rgb(.89,.906,.882), tint:rgb(.957,.969,.957), tint2:rgb(.914,.941,.918), green:rgb(.129,.314,.239), deep:rgb(.086,.227,.173) };
  const W = 595.28, H = 841.89, M = 48, CW = W - 2*M;
  const logo = opts && opts.logo ? await doc.embedPng(opts.logo).catch(() => null) : null;
  let page, y;
  const tw = (t, f, s) => f.widthOfTextAtSize(t, s);
  function text(t, x, yy, {font=F.r, size=10, color=C.ink, right=false}={}){
    const s = safe(t); page.drawText(s, {x: right ? x - tw(s, font, size) : x, y: yy, size, font, color});
  }
  function wrap(t, font, size, width){
    const out = [];
    for (const para of safe(t).split('\n')){
      let line = '';
      for (const w0 of para.split(/ +/)){
        const tryL = line ? line + ' ' + w0 : w0;
        if (tw(tryL, font, size) <= width){ line = tryL; continue; }
        if (line) out.push(line);
        let w = w0;
        while (tw(w, font, size) > width){ let k = w.length; while (k > 1 && tw(w.slice(0,k), font, size) > width) k--; out.push(w.slice(0,k)); w = w.slice(k); }
        line = w;
      }
      out.push(line);
    }
    return out;
  }
  const hline = (yy, {x1=M, x2=W-M, t=.5, color=C.line}={}) => page.drawLine({start:{x:x1,y:yy}, end:{x:x2,y:yy}, thickness:t, color});
  const para = (t, {font=F.r, size=10, color=C.ink, lh=1.4, after=8, width=CW}={}) => { wrap(t, font, size, width).forEach(l => { page.drawText(l, {x:M, y:y - size, size, font, color}); y -= size * lh; }); y -= after; };

  for (const m of list){
    page = doc.addPage([W, H]); y = H - M;
    const cn = coproName(m);
    if (logo){ const s = 24 / logo.height; page.drawImage(logo, {x:M, y:y - 24, width:logo.width*s, height:24}); }
    else text('LazySyndic', M, y - 17, {font:F.b, size:15, color:C.deep});
    text(`Émis le ${frDateLong(m.issuedAt)}`, W - M, y - 16, {size:8.5, color:C.soft, right:true});
    y -= 34; hline(y, {t:1.4, color:C.deep}); y -= 26;
    text(`Appel de fonds ${m.year}`, M, y, {font:F.b, size:21, color:C.green}); y -= 18;
    text(cn, M, y, {font:F.b, size:11}); y -= 13;
    const addr = [m.copro.addr, m.copro.kbo ? 'BCE ' + String(m.copro.kbo).replace(/^\s*BCE\s*/i,'') : ''].filter(Boolean).join(' · ');
    if (addr){ text(addr, M, y, {size:9, color:C.soft}); y -= 12; }
    y -= 14;
    // destinataire
    page.drawRectangle({x:M, y:y - 54, width:CW, height:60, color:C.tint});
    text(m.owner.name, M + 14, y - 14, {font:F.b, size:12});
    text(`${m.owner.q}${m.owner.qTot ? ` / ${m.owner.qTot}` : ''} millièmes · appels ${m.periodLabel}s`, M + 14, y - 30, {size:9.5, color:C.soft});
    text(eur(m.perPeriod), W - M - 14, y - 16, {font:F.b, size:16, color:C.green, right:true});
    text(m.every, W - M - 14, y - 32, {size:9.5, color:C.soft, right:true});
    y -= 76;
    para(`Votre part du budget ${m.year}${m.approved ? ` (${m.approved})` : ''} s'élève à ${eur(m.total)} pour l'année : charges courantes ${eur(m.pay)}${m.res ? ` et fonds de réserve ${eur(m.res)}` : ''}, calculées selon la clé de répartition de chaque poste.`, {size:10, after:14});
    // échéancier
    const cols = [{l:'N°', w:36}, {l:'Échéance', w:150}, {l:'Charges courantes', w:118, r:true}, {l:'Fonds de réserve', w:112, r:true}, {l:'Montant', w:CW - 36 - 150 - 118 - 112, r:true}];
    let x = M; page.drawRectangle({x:M, y:y - 18, width:CW, height:20, color:C.tint2});
    cols.forEach(c => { text(c.l.toUpperCase(), c.r ? x + c.w - 6 : x + 6, y - 13, {font:F.b, size:7.5, color:C.soft, right:!!c.r}); x += c.w; });
    y -= 20;
    m.rows.forEach((r, i) => {
      if (i % 2) page.drawRectangle({x:M, y:y - 17, width:CW, height:17, color:C.tint});
      let xx = M; const cells = [String(r.n), frDateLong(r.due), eur(r.pay), m.res ? eur(r.res) : '—', eur(r.amount)];
      cols.forEach((c, k) => { text(cells[k], c.r ? xx + c.w - 6 : xx + 6, y - 12.5, {size:9.5, font:k === 4 ? F.b : F.r, right:!!c.r}); xx += c.w; });
      y -= 17;
    });
    hline(y, {t:1, color:C.deep}); y -= 4;
    let xx = M; const tot = ['', `Total ${m.year}`, eur(m.pay), m.res ? eur(m.res) : '—', eur(m.total)];
    cols.forEach((c, k) => { text(tot[k], c.r ? xx + c.w - 6 : xx + 6, y - 12.5, {size:9.5, font:F.b, right:!!c.r}); xx += c.w; });
    y -= 30;
    // paiement
    page.drawRectangle({x:M, y:y - 70, width:CW, height:76, color:C.tint2});
    page.drawRectangle({x:M, y:y - 70, width:3, height:76, color:C.green});
    text('COMPTE DE LA COPROPRIÉTÉ', M + 16, y - 14, {font:F.b, size:7.5, color:C.deep});
    text(m.iban ? fmtIban(m.iban) : 'IBAN à renseigner dans LazySyndic (fiche du compte de paiement)', M + 16, y - 30, {font:F.b, size:12});
    text('COMMUNICATION STRUCTURÉE, À REPRENDRE SUR CHAQUE VIREMENT', M + 16, y - 48, {font:F.b, size:7.5, color:C.deep});
    text(m.ogm || 'à attribuer dans Copropriétaires & lots', M + 16, y - 64, {font:F.b, size:13});
    y -= 90;
    para('Un virement permanent avec cette communication structurée garantit l’attribution de chaque versement à votre compte de copropriétaire. Le suivi des paiements et le décompte de fin d’exercice s’y fient.', {size:9.5, color:C.soft, after:6});
    para(`Budget prévisionnel ${m.year} : fonds de roulement (charges courantes, compte de paiement) et fonds de réserve, répartis selon les quotités de l’acte de base ou à parts égales selon le poste ; contribution au fonds de réserve conforme à l’art. 3.86 § 3 du Code civil.`, {size:8.5, color:C.soft, after:0});
    // pied
    const foot = `${cn} · appel de fonds ${m.year} · ${m.owner.name}`;
    page.drawText(safe(foot), {x:M, y:M - 15, size:7.5, font:F.r, color:C.soft});
    const sy = (m.syndic||{}).name ? `${m.syndic.name}, syndic` : 'LazySyndic';
    page.drawText(safe(sy), {x:W - M - tw(safe(sy), F.r, 7.5), y:M - 15, size:7.5, font:F.r, color:C.soft});
  }
  const first = list[0];
  doc.setTitle(safe(`Appel de fonds ${first ? first.year : ''} · ${first ? coproName(first) : ''}${list.length === 1 ? ' · ' + first.owner.name : ''}`));
  doc.setProducer('LazySyndic'); doc.setCreator('LazySyndic');
  return doc.save();
}
const slug = s => String(s||'').normalize('NFD').replace(/\p{M}/gu,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
function fileName(m, ext){ return `appel-de-fonds-${m.year}${m.owner && m.owner.short ? '-' + slug(m.owner.short) : ''}.${ext || 'pdf'}`; }

const api = { PERIODS, cleanPeriodicity, ogmFromSeed, ogmFromDigits, ogmValid, ogmFormat, ogmIn, schedule, expectedInMonth, callModel, subject, text, html, buildPdf, fileName, fmtIban, eur };
root.LSCalls = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
