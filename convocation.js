/* ============================================================
   CONVOCATION À L'ASSEMBLÉE GÉNÉRALE — modèle d'e-mail (Outlook) + PDF joint
   ------------------------------------------------------------
   Comme le relevé de compte (statement.js) : un module sans DOM ni réseau,
   chargé avant app.js, exposé en `window.LSConvocation` et en `module.exports`
   (tests : node --test tests/convocation.test.mjs).

   L'e-mail suit le modèle des syndics en ligne : un message court et mis en
   page aux couleurs de LazySyndic, adressé au copropriétaire par son nom,
   qui reprend l'essentiel (date, heure, lieu, ordre du jour, règles de l'AG),
   et une pièce jointe PDF avec la convocation complète et le formulaire de
   procuration. Outlook rend le HTML avec le moteur de Word : tout est en
   tableaux et en styles inline, en hexadécimal (pas de variable CSS, pas de
   SVG, pas de police web).

   d = {
     copro:{name, addr, kbo}, type:'ordinaire'|'extraordinaire',
     dateLabel ('22/06/2026 19h00' tel que saisi), dateLong ('lundi 22 juin 2026' ou ''),
     timeLabel ('19h00' ou ''), start (Date ou null, pour le .ics), lieu,
     points:[{n, title, kind:'decision'|'info', maj:'Majorité absolue', pct:51, body}],
     syndic:{name, email}, sentLabel ('25/10/2026'), delayDays (entier ou null),
     recipient:{name, lots} ou null (message générique), logoSrc ('cid:…' ou URL ou ''),
     logo (Uint8Array PNG, pour le PDF) ou null
   }
   ============================================================ */
(function(root){
'use strict';

/* ---- jetons du design (DESIGN.md), en hexadécimal pour les clients mail ---- */
const T = {
  bg:'#F7F9F7', card:'#FFFFFF', ink:'#1D2A24', muted:'#6C746F', line:'#E0E5E2', soft:'#EEF1EF',
  primary:'#005F45', deep:'#21503D', secondary:'#E6F3EB', mint:'#BFE3CF',
  info:'#3C76A9', infoSoft:'#E2F1FD', warnSoft:'#FFF1D9', warnInk:'#915C08', clay:'#C9854A',
};
const FONT = "'Hanken Grotesk','Segoe UI',Helvetica,Arial,sans-serif";

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const nl2br = s => esc(s).replace(/\r?\n/g, '<br>');
const slug = s => String(s||'').normalize('NFD').replace(/\p{M}/gu,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);

const typeLabel = d => (String(d.type||'ordinaire').toLowerCase() === 'extraordinaire') ? 'extraordinaire' : 'ordinaire';
const coproName = d => String((d.copro||{}).name||'').trim() || 'la copropriété';
// « lundi 22 juin 2026 à 19h00 » — sinon la date telle que saisie
function when(d){
  if (d.dateLong) return cap(d.dateLong) + (d.timeLabel ? ' à ' + d.timeLabel : '');
  return d.dateLabel || 'date à préciser';
}
const greeting = d => (d.recipient && d.recipient.name) ? `${d.recipient.name},` : 'Madame, Monsieur, cher(e) copropriétaire,';
const isDecision = p => p.kind === 'decision';

/* ---- les règles de l'AG, écrites une fois : e-mail, texte brut et PDF ---- */
function rules(d){
  const n = d.delayDays;
  const delay = (typeof n === 'number' && isFinite(n))
    ? `Convocation adressée le ${d.sentLabel}, soit ${n} jour${Math.abs(n) > 1 ? 's' : ''} avant la séance (minimum légal : quinze jours, art. 3.87 §3 du Code civil).`
    : `Convocation adressée le ${d.sentLabel}, au moins quinze jours avant la séance (art. 3.87 §3 du Code civil).`;
  return [
    ['Délai', delay],
    ['Quorum', `L'assemblée délibère valablement si, en début de séance, plus de la moitié des copropriétaires sont présents ou représentés et détiennent au moins la moitié des quotes-parts, ou si les copropriétaires présents ou représentés détiennent plus de trois quarts des quotes-parts (art. 3.87 §5). À défaut, une seconde assemblée sera convoquée, quinze jours au moins après la première, et délibérera quel que soit le quorum.`],
    ['Procuration', `Si vous ne pouvez pas être présent(e), complétez le formulaire de procuration joint en nommant votre mandataire, puis renvoyez-le au syndic ou remettez-le à votre mandataire. Nul ne peut accepter plus de trois procurations, sauf si le total de ses voix et de celles de ses mandants n'excède pas 10 % des voix ; le syndic ne peut pas être mandataire (art. 3.87 §7).`],
    ['Votes', `Sauf majorité renforcée indiquée au point, les décisions se prennent à la majorité absolue des voix exprimées par les copropriétaires présents ou représentés ; abstentions, votes blancs et nuls ne sont pas comptés (art. 3.88).`],
    ['Documents', `Les pièces relatives aux points de l'ordre du jour peuvent être consultées auprès du syndic, sur simple demande, avant la séance.`],
    ['Procès-verbal', `Le procès-verbal est rédigé en fin de séance, signé par le président, le secrétaire et les copropriétaires encore présents, puis vous est transmis par le syndic (art. 3.87 §10).`],
  ];
}

/* ------------------------------------------------------------ objet ---- */
function subject(d){
  return `Convocation — Assemblée générale ${typeLabel(d)} — ${coproName(d)} — ${d.dateLabel || when(d)}`;
}

/* ------------------------------------------------------- texte brut ---- */
function text(d){
  const cn = coproName(d), ty = typeLabel(d);
  const points = (d.points||[]).map(p => {
    const head = `${p.n}. ${p.title}${isDecision(p) ? ` — décision (${p.maj})` : ' — information'}`;
    return p.body ? head + '\n' + p.body.split('\n').map(l => '   ' + l).join('\n') : head;
  }).join('\n\n');
  const extra = rules(d).map(([k, v]) => `${k} — ${v}`).join('\n\n');
  return `${greeting(d)}

En ma qualité de syndic de ${cn}, j'ai le plaisir de vous convoquer à l'assemblée générale ${ty} des copropriétaires, qui se tiendra :

    Date : ${when(d)}
    Lieu : ${d.lieu || '(lieu à préciser)'}

La convocation complète et le formulaire de procuration sont joints à ce message (PDF).

ORDRE DU JOUR

${points || '(aucun point)'}

À SAVOIR

${extra}

Dans l'attente de votre présence,
${d.syndic.name} — Syndic, ${cn}${d.syndic.email ? '\n' + d.syndic.email : ''}

--
Convocation établie avec LazySyndic. Envoyée par e-mail aux copropriétaires ayant accepté ce mode de communication (art. 3.87 §3 du Code civil).
`;
}

/* ------------------------------------------------------- HTML (mail) ---- */
const td = (style, inner, attrs='') => `<td ${attrs} style="${style}">${inner}</td>`;
const base = `font-family:${FONT};`;

function pointRows(d){
  const pts = d.points || [];
  if (!pts.length) return `<tr>${td(`${base}font-size:13px;line-height:19px;color:${T.muted};padding:12px 0`, 'Aucun point à l’ordre du jour pour le moment.')}</tr>`;
  return pts.map((p, i) => {
    const top = i ? `border-top:1px solid ${T.line};` : '';
    const chip = isDecision(p)
      ? `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${T.infoSoft};color:${T.info};${base}font-size:11px;line-height:16px;font-weight:700;white-space:nowrap">Décision</span>`
      : `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${T.soft};color:${T.muted};${base}font-size:11px;line-height:16px;font-weight:700;white-space:nowrap">Information</span>`;
    const maj = isDecision(p) ? `<div style="${base}font-size:11px;line-height:16px;color:${T.muted};margin-top:4px;white-space:nowrap">${esc(p.maj)}${p.pct ? ` · ${p.pct} %` : ''}</div>` : '';
    return `<tr>
${td(`${top}padding:12px 0;width:30px`, `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${T.secondary}" style="width:26px;height:26px;border-radius:13px;${base}font-size:12px;line-height:26px;font-weight:700;color:${T.primary}">${p.n}</td></tr></table>`, 'valign="top"')}
${td(`${top}padding:12px 12px 12px 10px;${base}color:${T.ink}`, `<div style="${base}font-size:14px;line-height:20px;font-weight:700;color:${T.ink}">${esc(p.title)}</div>${p.body ? `<div style="${base}font-size:13px;line-height:19px;color:${T.muted};margin-top:3px">${nl2br(p.body)}</div>` : ''}`, 'valign="top"')}
${td(`${top}padding:12px 0;width:120px`, chip + maj, 'valign="top" align="right"')}
</tr>`;
  }).join('\n');
}

function ruleRows(d){
  return rules(d).map(([k, v], i) => `<tr>
${td(`${i ? `border-top:1px solid ${T.line};` : ''}padding:9px 10px 9px 0;width:96px;${base}font-size:11px;line-height:17px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:${T.primary}`, esc(k), 'valign="top"')}
${td(`${i ? `border-top:1px solid ${T.line};` : ''}padding:9px 0;${base}font-size:13px;line-height:19px;color:${T.ink}`, esc(v), 'valign="top"')}
</tr>`).join('\n');
}

// Le corps seul (ce qui est collé dans un message Outlook) ; html() l'enveloppe dans un document.
function htmlBody(d){
  const cn = esc(coproName(d)), ty = typeLabel(d);
  const logo = d.logoSrc
    ? `<img src="${esc(d.logoSrc)}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0;border-radius:8px">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${T.deep}" style="width:34px;height:34px;border-radius:8px"></td></tr></table>`;
  const sent = `${esc(d.sentLabel)}`;
  const n = (d.points||[]).length, nDec = (d.points||[]).filter(isDecision).length;
  const meta = [n ? `${n} point${n > 1 ? 's' : ''} à l’ordre du jour` : '', nDec ? `${nDec} décision${nDec > 1 ? 's' : ''} à prendre` : ''].filter(Boolean).join(' · ');
  const addr = [d.copro.addr, d.copro.kbo ? 'BCE ' + String(d.copro.kbo).replace(/^\s*BCE\s*/i,'') : ''].filter(Boolean).join(' · ');
  return `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${T.bg}">Assemblée générale ${ty} de ${cn} — ${esc(when(d))}. Ordre du jour, procuration et convocation complète en pièce jointe.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bg}" style="background-color:${T.bg};margin:0;padding:0">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.card}" style="width:600px;max-width:100%;background-color:${T.card};border:1px solid ${T.line};border-radius:10px">

<!-- en-tête -->
<tr><td style="padding:18px 28px;border-bottom:1px solid ${T.line}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${td('width:34px;padding-right:10px', logo, 'valign="middle"')}
${td(`${base}font-size:17px;line-height:22px;color:${T.deep};letter-spacing:-.2px`, `<span style="font-weight:800">Lazy</span><span style="font-weight:600">Syndic</span>`, 'valign="middle"')}
${td(`${base}font-size:12px;line-height:18px;color:${T.muted};white-space:nowrap`, `Convocation · ${sent}`, 'valign="middle" align="right"')}
</tr></table>
</td></tr>

<!-- bandeau -->
<tr><td bgcolor="${T.primary}" style="background-color:${T.primary};padding:28px 28px 26px">
<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.mint}">Assemblée générale ${ty}</div>
<div style="${base}font-size:26px;line-height:32px;font-weight:800;color:#FFFFFF;margin-top:6px;letter-spacing:-.3px">${cn}</div>
${addr ? `<div style="${base}font-size:12px;line-height:18px;color:${T.mint};margin-top:4px">${esc(addr)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px"><tr>
${td(`width:50%;padding:12px 14px;border-left:3px solid ${T.clay}`, `<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.mint}">Date et heure</div><div style="${base}font-size:16px;line-height:22px;font-weight:700;color:#FFFFFF;margin-top:3px">${esc(d.dateLong ? cap(d.dateLong) : (d.dateLabel || 'Date à préciser'))}${d.dateLong && d.timeLabel ? `<br>${esc(d.timeLabel)}` : ''}</div>`, 'valign="top"')}
${td('width:12px', '')}
${td(`width:50%;padding:12px 14px;border-left:3px solid ${T.clay}`, `<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${T.mint}">Lieu</div><div style="${base}font-size:16px;line-height:22px;font-weight:700;color:#FFFFFF;margin-top:3px">${esc(d.lieu || 'Lieu à préciser')}</div>`, 'valign="top"')}
</tr></table>
</td></tr>

<!-- message -->
<tr><td style="padding:28px 28px 8px;${base}color:${T.ink}">
<p style="margin:0 0 14px;${base}font-size:15px;line-height:22px;font-weight:700;color:${T.ink}">${esc(greeting(d))}</p>
<p style="margin:0 0 14px;${base}font-size:14px;line-height:22px;color:${T.ink}">En ma qualité de syndic de <b>${cn}</b>, j’ai le plaisir de vous convoquer à l’assemblée générale ${ty} des copropriétaires, qui se tiendra le <b>${esc(when(d))}</b>${d.lieu ? `, ${esc(d.lieu)}` : ''}.</p>
<p style="margin:0 0 14px;${base}font-size:14px;line-height:22px;color:${T.ink}">Vous trouverez ci-dessous l’ordre du jour${meta ? ` (${meta})` : ''} et les règles de la séance. La convocation complète et le formulaire de procuration sont joints à ce message.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${td(`padding:12px 14px;background-color:${T.warnSoft};border-radius:8px;${base}font-size:13px;line-height:19px;color:${T.warnInk}`, `<b>Pièce jointe</b> — convocation à l’assemblée générale et formulaire de procuration (PDF). Si vous ne pouvez pas être présent(e), renvoyez la procuration complétée au syndic.`, `bgcolor="${T.warnSoft}"`)}
</tr></table>
</td></tr>

<!-- ordre du jour -->
<tr><td style="padding:18px 28px 6px">
<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.primary};padding-bottom:4px;border-bottom:2px solid ${T.primary}">Ordre du jour</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${pointRows(d)}
</table>
</td></tr>

<!-- à savoir -->
<tr><td style="padding:18px 28px 6px">
<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.primary};padding-bottom:4px;border-bottom:2px solid ${T.primary}">À savoir</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${ruleRows(d)}
</table>
</td></tr>

<!-- signature -->
<tr><td style="padding:18px 28px 28px;${base}color:${T.ink}">
<p style="margin:0 0 16px;${base}font-size:14px;line-height:22px;color:${T.ink}">Dans l’attente de votre présence,</p>
<div style="${base}font-size:14px;line-height:20px;font-weight:700;color:${T.ink}">${esc(d.syndic.name)}</div>
<div style="${base}font-size:13px;line-height:19px;color:${T.muted}">Syndic · ${cn}${d.syndic.email ? ` · <a href="mailto:${esc(d.syndic.email)}" style="color:${T.primary};text-decoration:underline">${esc(d.syndic.email)}</a>` : ''}</div>
</td></tr>

<!-- pied -->
<tr><td bgcolor="${T.bg}" style="background-color:${T.bg};padding:16px 28px;border-top:1px solid ${T.line};border-radius:0 0 10px 10px">
<div style="${base}font-size:12px;line-height:18px;font-weight:700;color:${T.deep}">Convocation établie avec LazySyndic</div>
<div style="${base}font-size:11px;line-height:17px;color:${T.muted};margin-top:3px">Envoyée par e-mail aux copropriétaires ayant accepté ce mode de communication (art. 3.87 §3 du Code civil). En cas de divergence, la convocation jointe en PDF fait foi.</div>
</td></tr>

</table>
</td></tr>
</table>`;
}

function html(d){
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(subject(d))}</title></head>
<body style="margin:0;padding:0;background-color:${T.bg};-webkit-text-size-adjust:100%">
${htmlBody(d)}
</body></html>`;
}

/* ---------------------------------------------------------- .ics ---- */
// Un rendez-vous à enregistrer (Outlook l'ouvre comme un élément de calendrier). null sans date lisible.
function ics(d, {durationMin=120}={}){
  const s = d.start instanceof Date && !isNaN(d.start) ? d.start : null;
  if (!s) return null;
  const e = new Date(s.getTime() + durationMin*60000);
  const stamp = x => x.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const escI = t => String(t||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g, m => '\\' + m);
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//LazySyndic//Convocation AG//FR','METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:ag-${stamp(s)}-${slug(coproName(d)).toLowerCase() || 'acp'}@lazysyndic`,
    `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(s)}`, `DTEND:${stamp(e)}`,
    `SUMMARY:${escI(`Assemblée générale ${typeLabel(d)} — ${coproName(d)}`)}`,
    d.lieu ? `LOCATION:${escI(d.lieu)}` : '',
    `DESCRIPTION:${escI((d.points||[]).map(p => `${p.n}. ${p.title}`).join('\n') || 'Ordre du jour : voir la convocation.')}`,
    'END:VEVENT','END:VCALENDAR'];
  // lignes de 75 octets au plus (RFC 5545) — repli simple sur la longueur en caractères
  return lines.filter(Boolean).map(l => l.replace(/(.{74})(?=.)/g, '$1\r\n ')).join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------- .eml ---- */
function b64(bytes){
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64Text = s => b64(new TextEncoder().encode(String(s)));
const lines76 = s => s.replace(/.{1,76}/g, '$&\r\n');
const word = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64Text(s)}?=`;
const bnd = tag => `=_LazySyndic_${tag}_` + Math.random().toString(36).slice(2) + Date.now().toString(36);
const part = (headers, body) => headers.join('\r\n') + '\r\n\r\n' + body;

/* m = { from, fromName, to:[e-mails], subject, text, html,
         logo:{bytes:Uint8Array, cid:'logo@lazysyndic'} | null,   — image inline du HTML
         pdf:{name, bytes:Uint8Array} | null, ics:{name, text} | null } — pièces jointes
   X-Unsent : Outlook ouvre le fichier comme un brouillon prêt à partir, destinataires et pièces jointes en place. */
function eml(m){
  const alt = bnd('alt'), rel = bnd('rel'), mix = bnd('mix');
  const textPart = part([`--${alt}`, 'Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: base64'],
    lines76(b64Text(String(m.text||'').replace(/\r?\n/g, '\r\n'))));
  const htmlPart = part(['Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64'],
    lines76(b64Text(String(m.html||''))));
  let htmlBlock;
  if (m.logo && m.logo.bytes){
    htmlBlock = part([`--${alt}`, `Content-Type: multipart/related; boundary="${rel}"; type="text/html"`], '')
      + `--${rel}\r\n` + htmlPart
      + part([`--${rel}`, 'Content-Type: image/png; name="logo.png"', `Content-ID: <${m.logo.cid || 'logo@lazysyndic'}>`,
              'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64'], lines76(b64(m.logo.bytes)))
      + `--${rel}--\r\n`;
  } else {
    htmlBlock = `--${alt}\r\n` + htmlPart;
  }
  const alternative = textPart + htmlBlock + `--${alt}--\r\n`;

  const head = [];
  if (m.from) head.push(`From: ${m.fromName ? word(m.fromName) + ' ' : ''}<${m.from}>`);
  head.push(`To: ${(m.to||[]).join(', ')}`);
  head.push(`Subject: ${word(m.subject||'')}`);
  head.push('MIME-Version: 1.0', 'X-Unsent: 1');

  const attachments = [];
  if (m.pdf && m.pdf.bytes){
    const f = String(m.pdf.name||'convocation.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
    attachments.push(part([`--${mix}`, `Content-Type: application/pdf; name="${f}"`, `Content-Disposition: attachment; filename="${f}"`, 'Content-Transfer-Encoding: base64'], lines76(b64(m.pdf.bytes))));
  }
  if (m.ics && m.ics.text){
    const f = String(m.ics.name||'assemblee-generale.ics').replace(/[^A-Za-z0-9._-]/g, '_');
    attachments.push(part([`--${mix}`, `Content-Type: text/calendar; charset="utf-8"; method=PUBLISH; name="${f}"`, `Content-Disposition: attachment; filename="${f}"`, 'Content-Transfer-Encoding: base64'], lines76(b64Text(m.ics.text))));
  }
  if (!attachments.length){
    head.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    return head.join('\r\n') + '\r\n\r\n' + alternative;
  }
  head.push(`Content-Type: multipart/mixed; boundary="${mix}"`);
  return head.join('\r\n') + '\r\n\r\n'
    + part([`--${mix}`, `Content-Type: multipart/alternative; boundary="${alt}"`], '') + alternative
    + attachments.join('') + `--${mix}--\r\n`;
}

/* ----------------------------------------------------------- PDF ---- */
const SUBST = {'−':'-','–':'-','‑':'-','‐':'-','→':'->','←':'<-','✓':'OK','✔':'OK','\t':' ','☐':'[ ]'};
// Convocation complète (lettre) + formulaire de procuration, A4, avec pdf-lib (chargé par app.js).
async function buildPdf(PDFLib, d){
  const {PDFDocument, StandardFonts, rgb} = PDFLib;
  const doc = await PDFDocument.create();
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold),
              i: await doc.embedFont(StandardFonts.HelveticaOblique) };
  const cs = new Set(F.r.getCharacterSet());
  const NB = cs.has(0xA0) ? ' ' : ' ';
  const safe = t => [...String(t==null ? '' : t).replace(/\r/g,'')].map(ch => {
    if (ch === '\n' || ch === ' ') return ch;
    if (ch === ' ' || ch === ' ' || ch === ' ' || ch === ' ') return NB;
    if (cs.has(ch.codePointAt(0))) return ch;
    if (SUBST[ch] !== undefined) return SUBST[ch];
    const b = ch.normalize('NFD').replace(/\p{M}/gu,'');
    if (b && [...b].every(c => cs.has(c.codePointAt(0)))) return b;
    return /\s/.test(ch) ? ' ' : '?';
  }).join('');
  const C = { ink:rgb(.114,.165,.141), soft:rgb(.42,.45,.43), faint:rgb(.56,.58,.55), line:rgb(.88,.9,.89),
              zebra:rgb(.967,.971,.965), green:rgb(0,.373,.271), greenSoft:rgb(.902,.953,.922), deep:rgb(.129,.314,.239),
              clay:rgb(.788,.522,.29), warnSoft:rgb(1,.945,.85), warnInk:rgb(.569,.361,.031), white:rgb(1,1,1) };
  const W = 595.28, H = 841.89, M = 48, CW = W - 2*M, BOTTOM = M + 28;
  const cn = coproName(d), ty = typeLabel(d), copro = d.copro || {};
  const logo = d.logo ? await doc.embedPng(d.logo).catch(() => null) : null;
  const pages = [];
  let page, y;
  const tw = (t, f, s) => f.widthOfTextAtSize(t, s);
  function text(t, x, yy, {font=F.r, size=10, color=C.ink, right=false, center=false}={}){
    const s = safe(t), w = tw(s, font, size);
    page.drawText(s, {x: right ? x - w : center ? x - w/2 : x, y: yy, size, font, color});
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
  function newPage(){
    page = doc.addPage([W, H]); pages.push(page); y = H - M;
    if (logo){ const s = 24 / logo.height; page.drawImage(logo, {x:M, y:y - 24, width:logo.width*s, height:24}); }
    else text('LazySyndic', M, y - 17, {font:F.b, size:15, color:C.deep});
    text(`Convocation adressée le ${d.sentLabel || ''}`, W - M, y - 16, {size:8.5, color:C.soft, right:true});
    y -= 34; hline(y, {t:1.4, color:C.deep}); y -= 22;
  }
  const need = h => { if (y - h < BOTTOM) newPage(); };
  // paragraphe replié ; `lh` = interligne relatif, `after` = blanc sous le paragraphe
  function para(t, {font=F.r, size=10, color=C.ink, lh=1.38, after=8, x=M, width=CW, indent=0}={}){
    const lines = wrap(t, font, size, width - indent);
    lines.forEach((l, i) => {
      need(size*lh);
      page.drawText(l, {x: x + (i ? indent : 0), y: y - size, size, font, color});
      y -= size*lh;
    });
    y -= after;
  }
  function heading(t){
    need(30);
    text(t.toUpperCase(), M, y - 9, {font:F.b, size:8.5, color:C.green});
    y -= 14; hline(y, {t:1.2, color:C.green}); y -= 10;
  }

  /* ---- page 1 : la lettre ---- */
  newPage();
  // expéditeur (ACP) à gauche, destinataire à droite
  const topY = y, colR = M + CW/2 + 16;
  text(cn, M, y - 10, {font:F.b, size:10.5});
  let yl = y - 24;
  [copro.addr, copro.kbo ? 'BCE ' + String(copro.kbo).replace(/^\s*BCE\s*/i,'') : ''].filter(Boolean).forEach(l => {
    wrap(l, F.r, 9.5, CW/2 - 16).forEach(s => { page.drawText(s, {x:M, y:yl, size:9.5, font:F.r, color:C.soft}); yl -= 12.5; });
  });
  let yr = y - 10;
  if (d.recipient && d.recipient.name){
    text(d.recipient.name, colR, yr, {font:F.b, size:10.5}); yr -= 14;
    if (d.recipient.lots){ wrap('Lot(s) : ' + d.recipient.lots, F.r, 9.5, CW/2 - 16).forEach(s => { page.drawText(s, {x:colR, y:yr, size:9.5, font:F.r, color:C.soft}); yr -= 12.5; }); }
  } else {
    text('Aux copropriétaires', colR, yr, {font:F.b, size:10.5}); yr -= 14;
    text(cn, colR, yr, {size:9.5, color:C.soft}); yr -= 12.5;
  }
  y = Math.min(yl, yr) - 18;

  text(`Convocation à l'assemblée générale ${ty}`, M, y - 16, {font:F.b, size:19, color:C.green}); y -= 24;
  text(`${cn} · le ${d.sentLabel || ''}`, M, y - 10, {size:9.5, color:C.soft}); y -= 26;

  para(greeting(d), {font:F.b, size:10.5, after:6});
  para(`En ma qualité de syndic de ${cn}, j'ai le plaisir de vous convoquer à l'assemblée générale ${ty} des copropriétaires, qui se tiendra :`, {after:10});

  // encadré date / lieu
  {
    const BH = 52, half = (CW - 10)/2;
    need(BH + 14);
    page.drawRectangle({x:M, y:y-BH, width:half, height:BH, color:C.greenSoft});
    page.drawRectangle({x:M, y:y-BH, width:3, height:BH, color:C.clay});
    page.drawRectangle({x:M+half+10, y:y-BH, width:half, height:BH, color:C.greenSoft});
    page.drawRectangle({x:M+half+10, y:y-BH, width:3, height:BH, color:C.clay});
    text('DATE ET HEURE', M + 12, y - 15, {font:F.b, size:7, color:C.green});
    text('LIEU', M + half + 22, y - 15, {font:F.b, size:7, color:C.green});
    const dl = wrap(when(d), F.b, 11, half - 24), ll = wrap(d.lieu || 'Lieu à préciser', F.b, 11, half - 24);
    dl.slice(0,2).forEach((l, i) => page.drawText(l, {x:M+12, y:y - 31 - i*13, size:11, font:F.b, color:C.ink}));
    ll.slice(0,2).forEach((l, i) => page.drawText(l, {x:M+half+22, y:y - 31 - i*13, size:11, font:F.b, color:C.ink}));
    y -= BH + 14;
  }
  para(`Le formulaire de procuration figure en dernière page ; les règles de la séance sont rappelées ci-dessous.`, {size:9, color:C.soft, after:8});

  /* ordre du jour : n° | point (titre + texte) | majorité | nature */
  heading('Ordre du jour');
  const cols = [{w:22}, {w:CW - 22 - 104 - 64}, {w:104}, {w:64}];
  const PAD = 5, LH = 1.3;
  const pts = d.points || [];
  function rowH(lines){ return Math.max(...lines.map(ls => ls.reduce((h,l) => h + l.size*LH, 0)), 10*LH) + 2*PAD; }
  function drawRow(cells, {zebra=false}={}){
    const lines = cells.map((parts, k) => {
      const out = [];
      parts.filter(p => p && p.t).forEach(p => wrap(p.t, p.font||F.r, p.size||9.5, cols[k].w - 2*PAD).forEach(l => out.push({t:l, font:p.font||F.r, size:p.size||9.5, color:p.color||C.ink})));
      return out;
    });
    const h = rowH(lines);
    if (y - h < BOTTOM){ newPage(); heading('Ordre du jour (suite)'); }
    if (zebra) page.drawRectangle({x:M, y:y-h, width:CW, height:h, color:C.zebra});
    let x = M;
    lines.forEach((ls, k) => {
      let yy = y - PAD;
      ls.forEach(l => { yy -= l.size; page.drawText(l.t, {x:x+PAD, y:yy+1.5, size:l.size, font:l.font, color:l.color}); yy -= l.size*(LH-1); });
      x += cols[k].w;
    });
    y -= h; hline(y, {t:.35});
  }
  if (!pts.length) para('Aucun point à l\'ordre du jour.', {font:F.i, color:C.soft});
  pts.forEach((p, i) => drawRow([
    [{t:String(p.n), font:F.b, color:C.green}],
    [{t:p.title, font:F.b}, p.body && {t:p.body, size:8.8, color:C.soft}],
    [{t: isDecision(p) ? p.maj + (p.pct ? ` (${p.pct} %)` : '') : '', size:8.8, color:C.soft}],
    [{t: isDecision(p) ? 'Décision' : 'Information', size:8.8, color: isDecision(p) ? C.ink : C.soft}],
  ], {zebra: i % 2 === 1}));
  y -= 14;

  /* règles de la séance : encadré, qui ne se sépare pas de son titre */
  {
    const S = 8.4, LHR = 1.32, LBL = 68, PX = 12;
    const items = rules(d).map(([k, v]) => ({k, lines: wrap(v, F.r, S, CW - 2*PX - LBL)}));
    const h = items.reduce((s, it) => s + Math.max(it.lines.length, 1)*S*LHR + 4, 0) + 16;
    if (y - 30 - h < BOTTOM) newPage();
    heading('À savoir');
    page.drawRectangle({x:M, y:y-h, width:CW, height:h, borderColor:C.green, borderWidth:.8});
    let yy = y - 11;
    items.forEach(it => {
      text(it.k.toUpperCase(), M + PX, yy - 7, {font:F.b, size:6.8, color:C.green});
      it.lines.forEach(l => { page.drawText(l, {x:M + PX + LBL, y:yy - S, size:S, font:F.r, color:C.ink}); yy -= S*LHR; });
      yy -= 4;
    });
    y -= h + 14;
  }

  /* signature */
  need(70);
  para('Dans l\'attente de votre présence,', {after:12});
  text(d.syndic.name || 'Le syndic', M, y - 10, {font:F.b, size:10.5}); y -= 14;
  text(`Syndic de ${cn}${d.syndic.email ? ' · ' + d.syndic.email : ''}`, M, y - 10, {size:9.5, color:C.soft}); y -= 14;

  /* ---- page 2 : la procuration ---- */
  newPage();
  text('Procuration', M, y - 16, {font:F.b, size:19, color:C.green}); y -= 24;
  text(`Assemblée générale ${ty} de ${cn} · ${when(d)}${d.lieu ? ' · ' + d.lieu : ''}`, M, y - 10, {size:9.5, color:C.soft}); y -= 28;
  const blank = n => '_'.repeat(n);
  const who = d.recipient && d.recipient.name ? d.recipient.name : blank(38);
  const lots = d.recipient && d.recipient.lots ? d.recipient.lots : blank(26);
  para(`Je/nous soussigné(e)(s) ${who}, propriétaire(s) du/des lot(s) ${lots} dans ${cn},`, {size:10, lh:1.6, after:4});
  para(`donne/donnons par la présente pouvoir à ${blank(40)} (nom du mandataire),`, {size:10, lh:1.6, after:4});
  para(`ou à défaut à ${blank(40)},`, {size:10, lh:1.6, after:8});
  para('à l\'effet de :', {font:F.b, size:10, after:4});
  [
    `assister à l'assemblée générale ${ty} des copropriétaires de ${cn} qui se tiendra le ${when(d)}${d.lieu ? ', ' + d.lieu : ''} ;`,
    `me/nous représenter et exercer tous les droits que j'aurais/nous aurions pu y exercer ;`,
    `prendre part en mon/notre nom à toutes délibérations, discussions et à tous votes ;`,
    `signer tout document nécessaire ;`,
    `plus généralement, faire le nécessaire pour assurer ma/notre représentation à ladite assemblée, ou à celle qui se tiendrait ultérieurement avec le même ordre du jour si le quorum n'était pas atteint lors de la première réunion.`,
  ].forEach(t => para('•  ' + t, {size:9.8, after:3, indent:11}));
  y -= 6;
  para(`Le mandataire est désigné nommément. Nul ne peut accepter plus de trois procurations, sauf si le total de ses voix et de celles de ses mandants n'excède pas 10 % des voix ; le syndic ne peut pas être mandataire (art. 3.87 §7 du Code civil).`, {size:8.6, color:C.soft, after:12});

  const dec = pts.filter(isDecision);
  if (dec.length){
    need(40);
    text('Instructions de vote (recommandées, pour éviter tout malentendu en séance)', M, y - 9, {font:F.b, size:9.5});
    y -= 20;
    const vc = [{w:22}, {w:CW - 22 - 3*58}, {w:58, l:'Pour'}, {w:58, l:'Contre'}, {w:58, l:'Abstention'}];
    let x = M;
    vc.forEach(c => { if (c.l) text(c.l.toUpperCase(), x + c.w/2, y - 7, {font:F.b, size:6.9, color:C.soft, center:true}); x += c.w; });
    y -= 12; hline(y, {t:1, color:C.ink});
    dec.forEach((p, i) => {
      const lines = wrap(p.title, F.r, 9.5, vc[1].w - 2*PAD);
      const h = Math.max(lines.length*9.5*LH, 16) + 2*PAD;
      if (y - h < BOTTOM){ newPage(); text('Instructions de vote (suite)', M, y - 9, {font:F.b, size:9.5}); y -= 20; }
      if (i % 2) page.drawRectangle({x:M, y:y-h, width:CW, height:h, color:C.zebra});
      page.drawText(safe(String(p.n)), {x:M+PAD, y:y-PAD-9.5+1.5, size:9.5, font:F.b, color:C.green});
      let yy = y - PAD;
      lines.forEach(l => { yy -= 9.5; page.drawText(l, {x:M+vc[0].w+PAD, y:yy+1.5, size:9.5, font:F.r, color:C.ink}); yy -= 9.5*(LH-1); });
      let bx = M + vc[0].w + vc[1].w;
      for (let k = 0; k < 3; k++){ page.drawRectangle({x:bx + vc[2].w/2 - 5, y:y - h/2 - 5, width:10, height:10, borderColor:C.ink, borderWidth:.7}); bx += 58; }
      y -= h; hline(y, {t:.35});
    });
    y -= 18;
  }
  need(60);
  para(`Fait à ${blank(28)}, le ${blank(22)}`, {size:10, lh:1.6, after:10});
  para(`Signature (précédée de la mention « Bon pour pouvoir ») : ${blank(34)}`, {size:10, lh:1.6, after:0});

  /* pieds de page */
  pages.forEach((pg, i) => {
    const left = safe(`${cn} · Convocation à l'assemblée générale ${ty} · ${d.dateLabel || when(d)} · établie avec LazySyndic`);
    pg.drawLine({start:{x:M, y:M-6}, end:{x:W-M, y:M-6}, thickness:.4, color:C.line});
    pg.drawText(left, {x:M, y:M-17, size:7.4, font:F.r, color:C.faint});
    const r = safe(`page ${i+1} / ${pages.length}`);
    pg.drawText(r, {x:W-M-tw(r, F.r, 7.4), y:M-17, size:7.4, font:F.r, color:C.faint});
  });
  const now = new Date();
  doc.setTitle(safe(`Convocation à l'assemblée générale ${ty} · ${cn}${d.recipient && d.recipient.name ? ' · ' + d.recipient.name : ''}`));
  doc.setSubject(safe(`Assemblée générale ${ty} du ${d.dateLabel || when(d)}`));
  doc.setAuthor(safe(cn)); doc.setCreator('LazySyndic'); doc.setProducer('LazySyndic (pdf-lib)');
  doc.setLanguage('fr-BE'); doc.setCreationDate(now); doc.setModificationDate(now);
  return await doc.save({useObjectStreams:false});
}

/* ------------------------------------------------------ nom de fichier ---- */
const isoDay = d => d instanceof Date && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : '';
function fileName(d, ext){
  const day = isoDay(d.start) || slug(d.dateLabel) || 'date';
  const who = d.recipient && d.recipient.name ? '_' + slug(d.recipient.name) : '';
  return `Convocation_AG_${slug(coproName(d)) || 'copropriete'}_${day}${who}.${ext}`;
}

const api = { subject, text, html, htmlBody, eml, ics, buildPdf, fileName, rules, when, T };
root.LSConvocation = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
