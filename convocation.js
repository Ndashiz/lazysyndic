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
     syndic:{name, email}, sentLabel ('25/10/2026'),
     recipient:{name, lots} ou null (message générique),
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
  ink2:'#3A4741',        // texte courant, un cran sous l'encre des titres (9,6:1 sur blanc)
  clayDeep:'#A5632C',    // l'argile du logo, assombrie pour porter du texte blanc (4,7:1)
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
// Pas de ligne « Délai » (retirée à la demande du syndic, 2026-11-20) : le message ne dit pas combien
// de jours séparent l'envoi de la séance. La date d'envoi reste dans l'en-tête ; c'est l'étape 2 de
// l'app qui signale au syndic un délai inférieur aux quinze jours légaux.
function rules(d){
  return [
    ['Quorum', `L'assemblée délibère valablement si, en début de séance, plus de la moitié des copropriétaires sont présents ou représentés et détiennent au moins la moitié des quotes-parts, ou si les copropriétaires présents ou représentés détiennent plus de trois quarts des quotes-parts (art. 3.87 §5). À défaut, une seconde assemblée sera convoquée, quinze jours au moins après la première, et délibérera quel que soit le quorum.`],
    ['Procuration', `Si vous ne pouvez pas être présent(e), complétez le formulaire de procuration joint en nommant votre mandataire, puis renvoyez-le au syndic ou remettez-le à votre mandataire. Nul ne peut accepter plus de trois procurations, sauf si le total de ses voix et de celles de ses mandants n'excède pas 10 % des voix ; le syndic ne peut pas être mandataire (art. 3.87 §7).`],
    ['Votes', `Sauf majorité renforcée indiquée au point, les décisions se prennent à la majorité absolue des voix exprimées par les copropriétaires présents ou représentés ; abstentions, votes blancs et nuls ne sont pas comptés (art. 3.88).`],
    ['Documents', `Les pièces relatives aux points de l'ordre du jour peuvent être consultées auprès du syndic, sur simple demande, avant la séance.`],
    ['Procès-verbal', `Le procès-verbal est rédigé en fin de séance, signé par le président, le secrétaire et les copropriétaires encore présents, puis vous est transmis par le syndic (art. 3.87 §10).`],
  ];
}

/* ------------------------------------------------------------ objet ---- */
// Pas de tiret cadratin dans ce que lit le copropriétaire : deux-points, virgules, points médians.
function subject(d){
  const day = d.dateLong || d.dateLabel;
  return `Convocation à l'assemblée générale ${typeLabel(d)}${day ? ' du ' + day : ''} · ${coproName(d)}`;
}

/* ------------------------------------------------------- texte brut ---- */
function text(d){
  const cn = coproName(d), ty = typeLabel(d);
  const points = (d.points||[]).map(p => {
    const head = `${p.n}. ${p.title} · ${isDecision(p) ? `décision (${p.maj})` : 'information'}`;
    return p.body ? head + '\n' + p.body.split('\n').map(l => '   ' + l).join('\n') : head;
  }).join('\n\n');
  const extra = rules(d).map(([k, v]) => `${k} : ${v}`).join('\n\n');
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
${d.syndic.name}
Syndic de ${cn}${d.syndic.email ? '\n' + d.syndic.email : ''}

--
Convocation établie avec LazySyndic. Envoyée par e-mail aux copropriétaires ayant accepté ce mode de communication (art. 3.87 §3 du Code civil).
`;
}

/* ------------------------------------------------------- HTML (mail) ----
   Une invitation plutôt qu'un courrier : l'en-tête dit de quoi il s'agit, le « billet » blanc posé
   sur le bandeau dit quand et où (une page de calendrier, lisible d'un coup d'œil), deux boutons
   permettent de répondre au syndic, puis viennent l'ordre du jour et ce qu'il faut savoir. Le cadre
   légal reste, en petit : le PDF joint le reprend en entier et fait foi.
   Tout en tableaux, styles inline, couleurs en hexadécimal : c'est le moteur de Word qui rend le
   message dans Outlook. Les coins arrondis y sont simplement carrés. ------------------------- */
const td = (style, inner, attrs='') => `<td ${attrs} style="${style}">${inner}</td>`;
const base = `font-family:${FONT};`;
const TBL = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const PAD = 28;                                                   // marge intérieure de la carte
const MOIS = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
const JOURS = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const validDate = x => x instanceof Date && !isNaN(x);
const eyebrow = (t, color) => `<div style="${base}font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${color}">${t}</div>`;
const h2 = t => `<div style="${base}font-size:18px;line-height:24px;font-weight:800;letter-spacing:-.2px;color:${T.ink}">${t}</div>`;
// pastille en ligne, sous le titre du point : la ligne se replie d'elle-même sur un téléphone, sans
// media query (un <style> ne survit pas au copier-coller dans un message). Word ignore le padding
// d'un <span> : dans Outlook la pastille est un simple surlignage, lisible quand même.
const chip = (label, bg, fg) => `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background-color:${bg};color:${fg};${base}font-size:11px;line-height:16px;font-weight:700;white-space:nowrap">${label}</span>`;
// bouton « à l'épreuve des balles » : la cellule porte le fond, le lien porte le texte
const button = (href, label, solid) => `<table ${TBL} align="left"><tr><td style="padding:0 10px 8px 0"><table ${TBL}><tr><td align="center" bgcolor="${solid ? T.primary : T.card}" style="background-color:${solid ? T.primary : T.card};border:1px solid ${T.primary};border-radius:8px"><a href="${esc(href)}" style="display:inline-block;padding:11px 18px;${base}font-size:14px;line-height:20px;font-weight:700;color:${solid ? '#FFFFFF' : T.primary};text-decoration:none">${label}</a></td></tr></table></td></tr></table>`;

// Le symbole de LazySyndic (la façade à pignon du logo), dessiné en cellules de tableau : aucune image.
// Une image jointe au message (cid:) le casse dès qu'on y répond ou qu'on le transfère dans Mail
// (macOS, iOS) : Mail sort les images jointes du tableau, les affiche en taille réelle et coupe la
// mise en page en deux. Une image distante, elle, est bloquée par défaut dans Outlook. Ici, rien à
// charger ni à joindre : le symbole survit à la réponse, au transfert et au copier-coller.
const CREAM = '#F4F0E6';
// Des cellules VIDES, hauteur donnée : pas le moindre caractère dedans. Avec un &nbsp;, Mail applique
// sa taille de police minimale (9 px) à chaque rangée de 1 à 4 px et la façade s'étire en tour de
// 63 px (vu le 2026-11-20). Les deux <div> bornent en plus la hauteur : si un client gonfle quand
// même une rangée, le symbole est rogné au lieu de déformer l'en-tête.
const px = (w, h, color) => `<td width="${w}" height="${h}" bgcolor="${color}" style="width:${w}px;height:${h}px;background-color:${color};font-size:1px;line-height:1px;mso-line-height-rule:exactly;padding:0"></td>`;
function mark(size = 32){
  const step = (w, h) => `<table ${TBL} align="center" width="${w}" style="width:${w}px"><tr>${px(w, h, CREAM)}</tr></table>`;
  const band = (h, a, b) => `<tr>${px(3, h, CREAM)}${px(3, h, a)}${px(4, h, CREAM)}${px(3, h, b)}${px(3, h, CREAM)}</tr>`;
  const clip = (w, h, more='') => `width:${w}px;height:${h}px;max-height:${h}px;overflow:hidden;font-size:1px;line-height:1px;${more}`;
  return `<div style="${clip(size, size, `border-radius:${Math.round(size/4)}px`)}"><table ${TBL} width="${size}" bgcolor="${T.deep}" style="width:${size}px;background-color:${T.deep};border-radius:${Math.round(size/4)}px"><tr><td align="center" valign="middle" height="${size}" style="height:${size}px;padding:0;font-size:1px;line-height:1px"><div style="${clip(16, 18, 'margin:0 auto')}">`
    + step(4, 3) + step(8, 2) + step(12, 3)                                     // le pignon à gradins
    + `<table ${TBL} align="center" width="16" style="width:16px">${band(1, CREAM, CREAM)}${band(3, T.deep, T.deep)}${band(2, CREAM, CREAM)}${band(4, T.clay, T.deep)}</table>`   // deux fenêtres, puis la fenêtre d'argile et la porte
    + `</div></td></tr></table></div>`;
}

// La page de calendrier du billet ; '' sans date lisible.
function dateTile(d){
  if (!validDate(d.start)) return '';
  const s = d.start;
  return `<table ${TBL} width="78" style="width:78px;border:1px solid ${T.line};border-radius:10px">
<tr><td align="center" bgcolor="${T.clayDeep}" style="background-color:${T.clayDeep};border-radius:9px 9px 0 0;padding:5px 0;${base}font-size:11px;line-height:14px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#FFFFFF">${esc(MOIS[s.getMonth()])} ${s.getFullYear()}</td></tr>
<tr><td align="center" style="padding:7px 0 0;${base}font-size:32px;line-height:34px;font-weight:800;letter-spacing:-.5px;color:${T.ink}">${s.getDate()}</td></tr>
<tr><td align="center" style="padding:0 0 8px;${base}font-size:12px;line-height:16px;color:${T.muted}">${JOURS[s.getDay()]}</td></tr>
</table>`;
}

// Deux réponses en un clic : un message déjà rédigé à l'attention du syndic. '' sans son e-mail.
function replyLinks(d){
  const to = String((d.syndic||{}).email||'').trim();
  if (!to) return null;
  const cn = coproName(d), day = d.dateLong || d.dateLabel || '', who = d.recipient && d.recipient.name ? d.recipient.name : '';
  const ag = `l'assemblée générale ${typeLabel(d)}${day ? ' du ' + day : ''} (${cn})`;
  const enc = t => encodeURIComponent(t).replace(/'/g, '%27');      // pas d'apostrophe nue : certains clients mail coupent le lien dessus
  const href = (subj, body) => `mailto:${enc(to).replace(/%40/g,'@')}?subject=${enc(subj)}&body=${enc(body.replace(/\n/g,'\r\n'))}`;
  return {
    yes: href(`Présence à l'assemblée générale · ${cn}`, `Bonjour,\n\nJe serai présent(e) à ${ag}.\n\n${who}`),
    proxy: href(`Procuration pour l'assemblée générale · ${cn}`, `Bonjour,\n\nJe ne pourrai pas assister à ${ag}.\nJe donne procuration à : \n\nJe joins le formulaire de procuration complété et signé.\n\n${who}`),
  };
}

function pointRows(d){
  const pts = d.points || [];
  if (!pts.length) return `<tr>${td(`${base}font-size:14px;line-height:20px;color:${T.muted};padding:14px 0`, 'Aucun point à l’ordre du jour pour le moment.')}</tr>`;
  return pts.map(p => {
    const top = `border-top:1px solid ${T.line};`;
    const tag = isDecision(p)
      ? `${chip('Décision', T.secondary, T.primary)} <span style="${base}font-size:12px;line-height:18px;color:${T.muted}">${esc(p.maj)}${p.pct ? ` · ${p.pct} %` : ''}</span>`
      : chip('Information', T.soft, T.muted);
    return `<tr>
${td(`${top}padding:14px 0;width:40px`, `<table ${TBL}><tr><td align="center" bgcolor="${T.secondary}" style="background-color:${T.secondary};width:28px;height:28px;border-radius:8px;${base}font-size:13px;line-height:28px;font-weight:800;color:${T.primary}">${p.n}</td></tr></table>`, 'valign="top" width="40"')}
${td(`${top}padding:17px 0 15px`, `<div style="${base}font-size:15px;line-height:21px;font-weight:700;color:${T.ink}">${esc(p.title)}</div><div style="margin-top:6px;line-height:20px">${tag}</div>${p.body ? `<div style="${base}font-size:13px;line-height:19px;color:${T.muted};margin-top:7px">${nl2br(p.body)}</div>` : ''}`, 'valign="top"')}
</tr>`;
  }).join('\n');
}

// « En pratique » : les trois règles qui demandent un geste, dites comme on les dirait.
const PRATIQUE = [['Procuration', 'Vous ne pouvez pas venir ?'], ['Documents', 'Consulter les documents'], ['Procès-verbal', 'Après la séance']];
const LEGAL = ['Quorum', 'Votes'];
function pratiqueRows(d){
  const r = new Map(rules(d));
  return PRATIQUE.map(([k, title], i) => `<tr>${td(`${i ? `border-top:1px solid ${T.line};` : ''}padding:${i ? 14 : 0}px 0 ${i === PRATIQUE.length - 1 ? 0 : 14}px`,
    `<div style="${base}font-size:14px;line-height:20px;font-weight:700;color:${T.ink}">${title}</div><div style="${base}font-size:13px;line-height:20px;color:${T.ink2};margin-top:2px">${esc(r.get(k) || '')}</div>`, `data-rule="${esc(k)}"`)}</tr>`).join('\n');
}
function legalRows(d){
  const r = new Map(rules(d));
  return LEGAL.map(k => `<tr>
${td(`padding:0 12px 8px 0;width:64px;${base}font-size:12px;line-height:18px;font-weight:700;color:${T.ink}`, esc(k), `valign="top" width="64" data-rule="${esc(k)}"`)}
${td(`padding:0 0 8px;${base}font-size:12px;line-height:18px;color:${T.muted}`, esc(r.get(k) || ''), 'valign="top"')}
</tr>`).join('\n');
}

// Le corps seul (ce qui est collé dans un message Outlook) ; html() l'enveloppe dans un document.
function htmlBody(d){
  const cn = esc(coproName(d)), ty = typeLabel(d);
  const logo = mark(32);
  const n = (d.points||[]).length, nDec = (d.points||[]).filter(isDecision).length;
  const meta = [n ? `${n} point${n > 1 ? 's' : ''}` : '', nDec ? `${nDec} décision${nDec > 1 ? 's' : ''} à prendre` : ''].filter(Boolean).join(' · ');
  const addr = [d.copro.addr, d.copro.kbo ? 'BCE ' + String(d.copro.kbo).replace(/^\s*BCE\s*/i,'') : ''].filter(Boolean).join(' · ');
  const tile = dateTile(d), links = replyLinks(d);
  const dayTxt = d.dateLong ? cap(d.dateLong) : (d.dateLabel || 'Date à préciser');
  const hourTxt = d.dateLong ? (d.timeLabel ? `à ${esc(d.timeLabel)}` : '') : '';
  const fact = (label, value, sub) => `${eyebrow(label, T.primary)}<div style="${base}font-size:16px;line-height:22px;font-weight:700;color:${T.ink};margin-top:2px">${value}${sub ? ` <span style="color:${T.primary};white-space:nowrap">${sub}</span>` : ''}</div>`;
  const side = `padding-left:${PAD}px;padding-right:${PAD}px;`;
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${T.bg}">Assemblée générale ${ty} de ${cn}, ${esc(when(d))}. Ordre du jour ci-dessous, convocation complète et procuration en pièce jointe.</div>
<table ${TBL} width="100%" bgcolor="${T.bg}" style="background-color:${T.bg};margin:0;padding:0;width:100%;table-layout:fixed">
<tr><td align="center" style="padding:24px 8px 8px">
<table ${TBL} width="600" bgcolor="${T.card}" style="width:600px;max-width:100%;background-color:${T.card};border:1px solid ${T.line};border-radius:14px">

<!-- en-tête -->
<tr><td style="padding:18px ${PAD}px">
<table ${TBL} width="100%"><tr>
${td('width:32px;padding-right:10px', logo, 'valign="middle" width="32"')}
${td(`${base}font-size:17px;line-height:22px;color:${T.deep};letter-spacing:-.2px`, `<span style="font-weight:800">Lazy</span><span style="font-weight:600">Syndic</span>`, 'valign="middle"')}
${td(`${base}font-size:12px;line-height:18px;color:${T.muted}`, `Envoyée le ${esc(d.sentLabel)}`, 'valign="middle" align="right"')}
</tr></table>
</td></tr>

<!-- bandeau : de quoi il s'agit, puis le billet (quand, où) -->
<tr><td bgcolor="${T.deep}" style="background-color:${T.deep};padding:30px ${PAD}px 32px">
${eyebrow('Convocation', T.mint)}
<div style="${base}font-size:28px;line-height:34px;font-weight:800;letter-spacing:-.4px;color:#FFFFFF;margin-top:6px">Assemblée générale ${ty}</div>
<div style="${base}font-size:15px;line-height:22px;font-weight:700;color:#FFFFFF;margin-top:8px" data-copro>${cn}</div>
${addr ? `<div style="${base}font-size:13px;line-height:19px;color:${T.mint}">${esc(addr)}</div>` : ''}
<table ${TBL} width="100%" bgcolor="${T.card}" style="background-color:${T.card};border-radius:12px;margin-top:22px"><tr>
${tile ? td('padding:18px 0 18px 18px;width:78px', tile, 'valign="top" width="96"') : ''}
${td('padding:18px 20px', `<table ${TBL} width="100%">
<tr>${td('padding:0 0 12px', fact('Quand', esc(dayTxt), hourTxt), 'data-when')}</tr>
<tr>${td(`padding:12px 0 0;border-top:1px solid ${T.line}`, fact('Où', esc(d.lieu || 'Lieu à préciser')), 'data-where')}</tr>
</table>`, 'valign="top"')}
</tr></table>
</td></tr>

<!-- message -->
<tr><td style="padding:30px ${PAD}px 6px;${base}color:${T.ink}">
<p style="margin:0 0 12px;${base}font-size:17px;line-height:24px;font-weight:700;color:${T.ink}">${esc(greeting(d))}</p>
<p style="margin:0 0 12px;${base}font-size:15px;line-height:24px;color:${T.ink2}">En ma qualité de syndic de <b style="color:${T.ink}">${cn}</b>, j’ai le plaisir de vous convoquer à l’assemblée générale ${ty} des copropriétaires, qui se tiendra le <b style="color:${T.ink}">${esc(when(d))}</b>${d.lieu ? `, ${esc(d.lieu)}` : ''}.</p>
<p style="margin:0;${base}font-size:15px;line-height:24px;color:${T.ink2}">Vous trouverez ci-dessous l’ordre du jour et ce qu’il faut savoir avant la séance.</p>
</td></tr>
${links ? `
<!-- répondre -->
<tr><td style="padding:16px ${PAD}px 4px">
${button(links.yes, 'Je serai présent(e)', true)}
${button(links.proxy, 'Je donne procuration', false)}
</td></tr>
<tr><td style="padding:0 ${PAD}px 4px;${base}font-size:12px;line-height:18px;color:${T.muted}">Un clic prépare votre réponse au syndic, il ne reste qu’à l’envoyer.</td></tr>` : ''}

<!-- pièce jointe -->
<tr><td style="padding:18px ${PAD}px 6px">
<table ${TBL} width="100%" bgcolor="${T.bg}" style="background-color:${T.bg};border:1px solid ${T.line};border-radius:10px"><tr>
${td('padding:14px 0 14px 14px;width:44px', `<table ${TBL}><tr><td align="center" bgcolor="${T.warnSoft}" style="background-color:${T.warnSoft};width:44px;height:44px;border-radius:8px;${base}font-size:11px;line-height:44px;font-weight:800;letter-spacing:.6px;color:${T.warnInk}">PDF</td></tr></table>`, 'valign="middle" width="58"')}
${td(`padding:14px 16px 14px 14px;${base}`, `<div style="${base}font-size:14px;line-height:20px;font-weight:700;color:${T.ink}" data-attachment>Convocation complète et formulaire de procuration</div><div style="${base}font-size:13px;line-height:19px;color:${T.muted}">En pièce jointe de ce message. En cas de divergence, le PDF fait foi.</div>`, 'valign="middle"')}
</tr></table>
</td></tr>

<!-- ordre du jour -->
<tr><td style="padding:26px ${PAD}px 0">
<table ${TBL} width="100%"><tr>
${td('padding:0 0 10px', h2('Ordre du jour'), 'valign="bottom"')}
${td(`padding:0 0 12px 12px;${base}font-size:12px;line-height:18px;color:${T.muted}`, esc(meta), 'valign="bottom" align="right" data-meta')}
</tr></table>
<table ${TBL} width="100%" style="border-bottom:1px solid ${T.line}">
${pointRows(d)}
</table>
</td></tr>

<!-- en pratique -->
<tr><td style="padding:28px ${PAD}px 0">
${h2('En pratique')}
<table ${TBL} width="100%" bgcolor="${T.bg}" style="background-color:${T.bg};border-radius:10px;margin-top:10px"><tr><td style="padding:18px 20px">
<table ${TBL} width="100%">
${pratiqueRows(d)}
</table>
</td></tr></table>
</td></tr>

<!-- cadre légal -->
<tr><td style="padding:22px ${PAD}px 0">
${eyebrow('Cadre légal', T.muted)}
<table ${TBL} width="100%" style="margin-top:8px">
${legalRows(d)}
</table>
</td></tr>

<!-- signature -->
<tr><td style="${side}padding-top:14px;padding-bottom:30px">
<table ${TBL} width="100%"><tr><td style="border-top:1px solid ${T.line};padding-top:22px;${base}color:${T.ink}">
<div style="${base}font-size:15px;line-height:24px;color:${T.ink2}">Dans l’attente de votre présence,</div>
<div style="${base}font-size:16px;line-height:22px;font-weight:800;color:${T.ink};margin-top:12px" data-syndic>${esc(d.syndic.name)}</div>
<div style="${base}font-size:13px;line-height:19px;color:${T.muted}">Syndic de ${cn}${d.syndic.email ? ` · <a href="mailto:${esc(d.syndic.email)}" style="color:${T.primary};text-decoration:underline">${esc(d.syndic.email)}</a>` : ''}</div>
</td></tr></table>
</td></tr>

</table>

<!-- pied, hors de la carte -->
<table ${TBL} width="600" style="width:600px;max-width:100%"><tr><td align="center" style="padding:16px ${PAD}px 28px">
<div style="${base}font-size:12px;line-height:18px;font-weight:700;color:${T.deep}">Convocation établie avec LazySyndic</div>
<div style="${base}font-size:11px;line-height:17px;color:${T.muted};margin-top:2px">Envoyée par e-mail aux copropriétaires ayant accepté ce mode de communication (art. 3.87 §3 du Code civil).</div>
</td></tr></table>
</td></tr>
</table>`;
}

function html(d){
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject(d))}</title></head>
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
    `SUMMARY:${escI(`Assemblée générale ${typeLabel(d)} · ${coproName(d)}`)}`,
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
         logo:{bytes:Uint8Array, cid:'logo@lazysyndic'} | null,   — image inline du HTML ; À ÉVITER : Mail la
                                                                    sort du tableau à la réponse (voir mark())
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
              clay:rgb(.788,.522,.29), clayDeep:rgb(.647,.388,.173), warnSoft:rgb(1,.945,.85), warnInk:rgb(.569,.361,.031), white:rgb(1,1,1) };
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

  // le billet, comme dans l'e-mail : la page de calendrier, puis quand et où
  {
    const hasDay = validDate(d.start), TILE = 54, TH = 62, PX = 14;
    const tx = M + PX + (hasDay ? TILE + 16 : 0), wTxt = CW - (tx - M) - PX;
    const dl = wrap(when(d), F.b, 12, wTxt).slice(0, 2), ll = wrap(d.lieu || 'Lieu à préciser', F.b, 12, wTxt).slice(0, 3);
    const BH = Math.max(32 + 15*(dl.length + ll.length), hasDay ? TH : 0) + 2*PX;
    need(BH + 14);
    page.drawRectangle({x:M, y:y-BH, width:CW, height:BH, color:C.greenSoft});
    if (hasDay){
      const x0 = M + PX, ty = y - PX, s = d.start;
      page.drawRectangle({x:x0, y:ty-TH, width:TILE, height:TH, color:C.white, borderColor:C.line, borderWidth:.6});
      page.drawRectangle({x:x0, y:ty-16, width:TILE, height:16, color:C.clayDeep});
      text(`${MOIS[s.getMonth()]} ${s.getFullYear()}`.toUpperCase(), x0 + TILE/2, ty - 11.3, {font:F.b, size:6.6, color:C.white, center:true});
      text(String(s.getDate()), x0 + TILE/2, ty - 41, {font:F.b, size:24, center:true});
      text(JOURS[s.getDay()], x0 + TILE/2, ty - 54, {size:7.5, color:C.soft, center:true});
    }
    let cy = y - PX;
    const block = (label, lines) => {
      cy -= 7; text(label, tx, cy, {font:F.b, size:7, color:C.green}); cy -= 5;
      lines.forEach(l => { cy -= 12; page.drawText(l, {x:tx, y:cy, size:12, font:F.b, color:C.ink}); cy -= 3; });
    };
    block('QUAND', dl); cy -= 8; block('OÙ', ll);
    y -= BH + 14;
  }
  y -= 4;

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

  /* Pas d'encadré « À savoir » dans la lettre (retiré à la demande du syndic, 2026-11-20) : le rappel
     des règles alourdissait la page. Deux phrases restent, parce qu'elles servent : où consulter les
     documents (la convocation doit le dire, art. 3.87 §3) et où trouver la procuration. */
  const docsTxt = new Map(rules(d)).get('Documents');
  const proxyTxt = `Si vous ne pouvez pas être présent(e), vous pouvez vous faire représenter : le formulaire de procuration figure en dernière page.`;
  // la fin de la lettre ne se sépare pas : jamais une signature seule en haut d'une page
  need((wrap(docsTxt, F.r, 10, CW).length + wrap(proxyTxt, F.r, 10, CW).length) * 10*1.38 + 6 + 16 + 56);
  para(docsTxt, {after:6});
  para(proxyTxt, {after:16});

  /* signature */
  para('Dans l\'attente de votre présence,', {after:12});
  text(d.syndic.name || 'Le syndic', M, y - 10, {font:F.b, size:10.5}); y -= 14;
  text(`Syndic de ${cn}${d.syndic.email ? ' · ' + d.syndic.email : ''}`, M, y - 10, {size:9.5, color:C.soft}); y -= 14;

  /* ---- page 2 : la procuration ---- */
  newPage();
  text('Procuration', M, y - 16, {font:F.b, size:19, color:C.green}); y -= 24;
  // replié : un lieu un peu long sortait de la page
  para(`Assemblée générale ${ty} de ${cn} · ${when(d)}${d.lieu ? ' · ' + d.lieu : ''}`, {size:9.5, color:C.soft, after:16});
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

  // Pas de tableau « Instructions de vote » (retiré à la demande du syndic, 2026-11-20) : la procuration
  // tient en une page, mandat et signature.
  y -= 10;
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

const api = { subject, text, html, htmlBody, mark, eml, ics, buildPdf, fileName, rules, when, T };
root.LSConvocation = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
