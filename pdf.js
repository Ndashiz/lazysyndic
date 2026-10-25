/* ============================================================
   LazySyndic — design system des documents PDF (LSPdf)
   Un seul langage pour tout ce que l'app imprime ou dessine : jetons (couleurs, typographie),
   formats (montants, dates, pourcentages) et composants HTML (en-tête, pied, synthèse, tableau
   financier, badge, encadré). Pur : aucun DOM, aucun réseau ; testé sous Node.
   • Les documents HTML (rapports, Annexe 4) assemblent ces composants et s'impriment avec
     pdf.css ; le navigateur fait le PDF (« Imprimer / Enregistrer en PDF »).
   • Les documents pdf-lib (relevé, PV, convocation) lisent les mêmes jetons via LSPdf.tokens.rgb.
   Règles d'usage : PDF_DESIGN.md.
   ============================================================ */
(function(root){
'use strict';

/* ---------- jetons ---------- */
const color = {
  ink:'#20251F',        // texte
  soft:'#5C6153',       // texte secondaire (4,6:1 sur blanc)
  faint:'#8A8F80',      // mentions, pieds de page (3,2:1 : jamais sous 10 px)
  line:'#E3E7E1',       // filets de tableau
  rule:'#20251F',       // filets forts (totaux, en-têtes)
  tint:'#F4F7F4',       // fonds très légèrement teintés (groupes, synthèse)
  tint2:'#E9F0EA',      // colonne mise en avant, lignes de total
  green:'#21503D',      // titres, identité
  greenDeep:'#163A2C',
  greenSoft:'#E2ECE3',  // puces, badges
  warning:'#8A5A00', warningSoft:'#FFF1D6',
  danger:'#B42318', dangerSoft:'#FBEAE7',
  white:'#FFFFFF',
};
const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h); const n = parseInt(m[1], 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => Math.round(v * 1000) / 1000); };
const rgb = {}; for (const k in color) rgb[k] = hexRgb(color[k]);
const font = {
  family: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  // tailles en px (écran) et en pt pour pdf-lib (× 0,75) : jamais sous 10 px à l'impression
  size: { h1:22, h2:14, h3:12, body:11.5, table:11, small:10.5, micro:10, kpi:20, kpiLabel:10 },
  pt: s => Math.round(s * 0.75 * 10) / 10,
};
const page = { size:'A4', margin:{ top:'14mm', right:'12mm', bottom:'18mm', left:'12mm' }, widthMm:210, heightMm:297 };
const tokens = { color, rgb, font, page };

/* ---------- formats ---------- */
const MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const toDate = d => d instanceof Date ? d : (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) ? new Date(d.slice(0,4), +d.slice(5,7)-1, +d.slice(8,10)) : (typeof d === 'string' && /^\d{2}\/\d{2}\/\d{2,4}$/.test(d)) ? (m => new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2]-1, +m[1]))(/^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(d)) : new Date(d);
const pad = n => String(n).padStart(2, '0');
const fmt = {
  // 1 383,84 € — virgule décimale, espace fine insécable de milliers, signe « − » typographique
  eur(n){ const v = Number(n) || 0; return (Math.abs(v) < 0.005 ? 0 : v).toLocaleString('fr-BE', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' €'; },
  signed(n){ const v = Number(n) || 0; return (v > 0.005 ? '+' : v < -0.005 ? '−' : '') + fmt.eur(Math.abs(v)); },
  int(n){ return (Number(n) || 0).toLocaleString('fr-BE', { maximumFractionDigits:0 }); },
  pct(n, digits){ const d = digits == null ? 1 : digits; return (Number(n) || 0).toLocaleString('fr-BE', { minimumFractionDigits:d, maximumFractionDigits:d }) + ' %'; },
  date(d){ const x = toDate(d); return isNaN(x) ? '' : `${pad(x.getDate())}/${pad(x.getMonth()+1)}/${x.getFullYear()}`; },
  dateLong(d){ const x = toDate(d); return isNaN(x) ? '' : `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`; },
  // 01/01/26 → 31/10/26, comme les relevés et les rapports existants
  period(from, to){ const f = toDate(from), t = toDate(to); const s = x => isNaN(x) ? '?' : `${pad(x.getDate())}/${pad(x.getMonth()+1)}/${String(x.getFullYear()).slice(2)}`; return `${s(f)} → ${s(t)}`; },
  months(from, to, year){ return from === to ? `${MONTHS[from-1]} ${year}` : `${MONTHS[from-1]} → ${MONTHS[to-1]} ${year}`; },
};

/* ---------- composants HTML ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const cls = (...a) => a.filter(Boolean).join(' ');

// Badge de statut : ok (publié, validé), draft (brouillon), warning, danger, neutral.
function badge(kind, label){ return `<span class="pdf-badge pdf-badge-${esc(kind || 'neutral')}">${esc(label)}</span>`; }

// En-tête commun : marque, copropriété, titre, puce du type de document, métadonnées, statut.
// meta = [{label, value}] ; status = {kind, label} ; brand = {src, alt}
function head(o){
  const c = o.copro || {};
  const meta = (o.meta || []).filter(m => m && m.value != null && m.value !== '').map(m => `<div class="pdf-meta"><span class="pdf-meta-l">${esc(m.label)}</span><span class="pdf-meta-v">${esc(m.value)}</span></div>`).join('');
  const brand = o.brand || { src:'brand/logo.svg', alt:'LazySyndic' };
  return `<header class="pdf-head">
    <div class="pdf-head-l">
      <img class="pdf-brand" src="${esc(brand.src)}" alt="${esc(brand.alt)}" width="123" height="30">
      <div class="pdf-copro"><b>${esc(c.name || 'Ma copropriété')}</b>${c.addr ? `<div>${esc(c.addr)}</div>` : ''}${c.kbo ? `<div>N° d'entreprise ${esc(c.kbo)}</div>` : ''}</div>
    </div>
    <div class="pdf-head-r">
      ${o.chip ? `<span class="pdf-chip">${esc(o.chip)}</span>` : ''}${o.status ? ' ' + badge(o.status.kind, o.status.label) : ''}
      ${meta}
    </div>
  </header>
  <h1 class="pdf-h1">${esc(o.title)}${o.subtitle ? `<span class="pdf-h1-sub">${esc(o.subtitle)}</span>` : ''}</h1>`;
}

// Pied commun : qui a généré, pour qui, quand ; une mention optionnelle. Répété en bas de
// chaque page imprimée par document() ; le numéro de page vient de pdf.css (@page) là où le
// navigateur le sait, sinon il manque — voir PDF_DESIGN.md.
function foot(o){
  o = o || {};
  const c = o.copro || {};
  return `<footer class="pdf-foot"><span>${esc(o.text || `Document généré par LazySyndic — ${c.name || 'Ma copropriété'}`)}</span>${o.note ? `<span class="pdf-foot-note">${esc(o.note)}</span>` : ''}${o.date !== false ? `<span>${esc(o.dateLabel || 'Édité le')} ${fmt.dateLong(o.date || new Date())}</span>` : ''}</footer>`;
}

// Le document : un tableau de page dont le pied se répète en bas de chaque feuille (tfoot).
function document(o){
  return `<div class="pdf-doc${o.cls ? ' ' + esc(o.cls) : ''}"><table class="pdf-page"><thead><tr><td class="pdf-page-top"></td></tr></thead><tfoot><tr><td class="pdf-page-foot">${o.foot || ''}</td></tr></tfoot><tbody><tr><td class="pdf-page-body">${o.head || ''}${o.body || ''}</td></tr></tbody></table></div>`;
}

// Synthèse financière : des tuiles label / montant / précision. emph = la tuile principale.
function summary(items){
  return `<section class="pdf-summary">${(items || []).map(t => `<div class="pdf-kpi${t.emph ? ' pdf-kpi-emph' : ''}"><div class="pdf-kpi-l">${esc(t.label)}</div><div class="pdf-kpi-v">${esc(t.value)}</div>${t.sub ? `<div class="pdf-kpi-s">${esc(t.sub)}</div>` : ''}</div>`).join('')}</section>`;
}

// Titre de section numéroté, avec une puce (le compte concerné) et une phrase d'explication.
function section(title, o){
  o = o || {};
  return `<h2 class="pdf-h2">${o.n != null ? `<span class="pdf-n">${esc(o.n)}</span>` : ''}<span class="pdf-h2-t">${esc(title)}</span>${o.chip ? `<span class="pdf-chip pdf-chip-soft">${esc(o.chip)}</span>` : ''}</h2>${o.sub ? `<p class="pdf-sub">${esc(o.sub)}</p>` : ''}`;
}

// Encadré : info (fond teinté), legal (filet, petit corps), warning.
function note(text, o){ o = o || {}; return `<aside class="pdf-note pdf-note-${esc(o.kind || 'info')}">${o.title ? `<b>${esc(o.title)}</b> ` : ''}${o.html ? text : esc(text)}</aside>`; }

// Un montant mis en avant (un total, une mensualité).
function amount(v, o){ o = o || {}; return `<span class="pdf-amount${o.emph ? ' pdf-amount-emph' : ''}">${esc(o.text != null ? o.text : fmt.eur(v))}</span>${o.label ? `<span class="pdf-amount-l">${esc(o.label)}</span>` : ''}`; }

// Tableau financier.
//   cols   = [{label, sub, align:'left'|'right', emph, w}]
//   groups = [{label, rows}] ou rows = [...] ; une ligne = [cellule…] ; une cellule = valeur
//            ou {text|html, sub, cls, neg, emph}
//   totals = [{label, cells:[…], kind:'tot'|'sub'}] : lignes de total, gardées avec le tableau
//   En-tête répété à chaque page (thead) ; un groupe ne se coupe pas quand il tient sur une page.
function table(o){
  const cols = o.cols || [];
  const cell = (c, i, tag) => {
    const col = cols[i] || {};
    const v = (c && typeof c === 'object' && !Array.isArray(c)) ? c : { text: c };
    const inner = (v.html != null ? v.html : esc(v.text == null ? '' : v.text)) + (v.sub ? `<div class="pdf-cell-sub">${esc(v.sub)}</div>` : '');
    return `<${tag} class="${cls(col.align === 'right' && 'num', col.emph && 'emph', v.cls, v.neg && 'neg')}">${inner}</${tag}>`;
  };
  const row = (r, extra) => `<tr${extra ? ` class="${extra}"` : ''}>${(r || []).map((c, i) => cell(c, i, 'td')).join('')}</tr>`;
  const thead = `<thead><tr>${cols.map((c, i) => `<th class="${cls(c.align === 'right' && 'num', c.emph && 'emph')}"${c.w ? ` style="width:${esc(c.w)}"` : ''}>${esc(c.label)}${c.sub ? `<div class="pdf-th-sub">${esc(c.sub)}</div>` : ''}</th>`).join('')}</tr></thead>`;
  const groups = o.groups ? o.groups : [{ label:'', rows:o.rows || [] }];
  const body = groups.map(g => `<tbody class="pdf-group">${g.label ? `<tr class="pdf-group-row"><td colspan="${cols.length}">${esc(g.label)}</td></tr>` : ''}${(g.rows || []).map(r => row(r)).join('')}</tbody>`).join('');
  const empty = !groups.some(g => (g.rows || []).length) ? `<tbody><tr><td colspan="${cols.length}" class="pdf-empty">${esc(o.empty || 'Aucune ligne.')}</td></tr></tbody>` : '';
  const totals = (o.totals || []).length ? `<tbody class="pdf-totals">${o.totals.map(t => row([{ text:t.label }, ...(t.cells || [])], t.kind === 'sub' ? 'pdf-sub-row' : 'pdf-tot')).join('')}</tbody>` : '';
  return `<table class="pdf-table${o.cls ? ' ' + esc(o.cls) : ''}"${o.label ? ` aria-label="${esc(o.label)}"` : ''}>${thead}${body}${empty}${totals}</table>`;
}

// Mentions légales / métadonnées en petit corps, en fin de document.
function legal(lines){ return `<section class="pdf-legal">${(lines || []).map(l => `<p>${esc(l)}</p>`).join('')}</section>`; }

const api = { tokens, fmt, esc, badge, head, foot, document, summary, section, note, amount, table, legal };
root.LSPdf = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
