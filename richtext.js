/* ============================================================
   TEXTE DES POINTS D'AG — paragraphes et tableaux
   ------------------------------------------------------------
   Le texte d'un point (ls_ag_points.body) et ses notes de séance (seance_notes) restent du
   texte brut. Un tableau y est écrit comme le donne un copier-coller depuis Excel, Numbers ou
   un tableau de page web : des lignes qui se suivent, une par rangée, les cellules séparées
   par une tabulation. La première rangée est l'en-tête ; une rangée qui commence par « Total »
   est mise en gras ; une colonne de montants s'aligne à droite.

   Module sans DOM ni réseau, chargé avant signature.js et convocation.js, exposé en
   `window.LSText` et en `module.exports` (tests : node --test tests/richtext.test.mjs).
   L'écran (app.js) s'en sert pour l'éditeur, le PV et la convocation pour leurs PDF, leur
   e-mail et la version Word.
   ============================================================ */
(function(root){
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cell = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Retire les blancs autour du texte sans toucher aux tabulations : la dernière rangée d'un
// tableau peut finir par des cellules vides, et `String.trim()` les emporterait.
function trim(text){ return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/^[ \n]+/, '').replace(/[ \n]+$/, ''); }

/** Le texte découpé en blocs : {type:'text', text} et {type:'table', rows:[[cellule, …], …]}.
 *  Toutes les rangées d'un tableau ont le même nombre de cellules. */
function blocks(text){
  const out = []; let para = [], rows = [];
  const flushP = () => { const t = para.join('\n').replace(/^\n+|\n+$/g, ''); if (t.trim()) out.push({type:'text', text:t}); para = []; };
  const flushT = () => {
    if (!rows.length) return;
    const n = Math.max(...rows.map(r => r.length));
    out.push({type:'table', rows: rows.map(r => r.concat(Array(n - r.length).fill('')))}); rows = [];
  };
  for (const line of String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')){
    if (line.includes('\t')){ flushP(); rows.push(line.split('\t').map(cell)); }
    else { flushT(); para.push(line.replace(/\s+$/, '')); }
  }
  flushP(); flushT();
  return out;
}
const hasTable = text => String(text == null ? '' : text).includes('\t');
/** Les blocs remis en texte (l'inverse de `blocks`). */
function join(bl){
  return (bl || []).map(b => b.type === 'table' ? b.rows.map(r => r.map(cell).join('\t')).join('\n') : b.text).join('\n\n');
}

// « 79,39 € », « +33,96 € (+42,8 %) », « 1 250 », « -12 % » : un nombre, son signe, son unité.
const isNum = s => /\d/.test(s) && !/[^\d\s+\-−–.,'’€%()/]/.test(s);
const hasHead = rows => rows.length > 1;
const isTotal = row => /^(sous[- ]?)?total\b/i.test(String(row && row[0] || '').trim());
/** L'alignement de chaque colonne : 'right' si toutes ses cellules remplies (hors en-tête) sont des nombres. */
function align(rows){
  const body = hasHead(rows) ? rows.slice(1) : rows;
  return (rows[0] || []).map((_, k) => {
    const vals = body.map(r => r[k] || '').filter(Boolean);
    return vals.length && vals.every(isNum) ? 'right' : 'left';
  });
}

/* ------------------------------------------------------- texte brut ---- */
/** Pour un e-mail en texte brut : les cellules séparées par une barre. */
function plain(text){
  return blocks(text).map(b => b.type === 'table' ? b.rows.map(r => r.join(' | ')).join('\n') : b.text).join('\n\n');
}

/* ------------------------------------------------------------- HTML ---- */
/** HTML échappé, styles en ligne (e-mail, Word : pas de feuille de style).
 *  st = {p, table, th, td, total} : le style de chaque élément ; l'alignement à droite s'ajoute seul. */
function html(text, st){
  st = Object.assign({
    p: 'margin:0 0 6px',
    table: 'border-collapse:collapse;margin:6px 0 10px',
    th: 'border:1px solid #C9CFC8;padding:4px 8px;font-weight:700;background-color:#EEF2EE',
    td: 'border:1px solid #C9CFC8;padding:4px 8px',
    total: 'font-weight:700',
  }, st || {});
  return blocks(text).map(b => {
    if (b.type === 'text') return `<div style="${st.p}">${esc(b.text).replace(/\n/g, '<br>')}</div>`;
    const al = align(b.rows), head = hasHead(b.rows);
    const tr = (r, i) => {
      const h = head && i === 0, tot = !h && isTotal(r);
      return '<tr>' + r.map((c, k) => {
        const css = (h ? st.th : st.td) + (tot ? ';' + st.total : '') + `;text-align:${al[k]};vertical-align:top`;
        return `<${h ? 'th' : 'td'} align="${al[k]}" valign="top" style="${css}">${esc(c) || '&nbsp;'}</${h ? 'th' : 'td'}>`;
      }).join('') + '</tr>';
    };
    return `<table cellpadding="0" cellspacing="0" border="0" style="${st.table}">${b.rows.map(tr).join('')}</table>`;
  }).join('');
}

/* -------------------------------------------------------------- PDF ---- */
/** Largeurs de colonnes : chacune à sa largeur naturelle si le tout tient ; sinon les colonnes
 *  étroites gardent la leur et les larges se partagent ce qui reste. */
function fit(nat, avail){
  const total = nat.reduce((a, b) => a + b, 0);
  if (total <= avail) return nat.slice();
  const w = nat.slice(); let free = avail, open = nat.map((_, k) => k);
  while (open.length){
    const share = free / open.length;
    const small = open.filter(k => nat[k] <= share);
    if (!small.length){ open.forEach(k => { w[k] = share; }); break; }
    small.forEach(k => { w[k] = nat[k]; free -= nat[k]; });
    open = open.filter(k => !small.includes(k));
  }
  return w;
}
/** Dessine un tableau dans un PDF sans connaître la bibliothèque : `io` mesure et trace.
 *  io = { x, width, size, lh, pad (haut/bas), padX (gauche/droite),
 *         measure(t, bold) → largeur, wrap(t, bold, largeur) → [lignes],
 *         y() → haut de la rangée à venir, setY(y),
 *         need(h) → true si une nouvelle page a été ouverte pour loger h,
 *         text(t, x, yBase, bold), rule(x1, x2, y, fort), fill(x, yHaut, w, h) (facultatif) }
 *  L'en-tête se répète en haut de chaque page. */
function drawTable(rows, io){
  if (!rows || !rows.length) return;
  const size = io.size || 9, lh = io.lh || 1.32, pad = io.pad == null ? 4 : io.pad, px = io.padX == null ? pad + 3 : io.padX;
  const head = hasHead(rows), al = align(rows);
  const bold = (r, i) => (head && i === 0) || isTotal(r);
  const nat = rows[0].map((_, k) => Math.max(...rows.map((r, i) => io.measure(r[k] || '', bold(r, i)))) + 2*px + .5);
  const w = fit(nat, io.width), tw = w.reduce((a, b) => a + b, 0);
  const drawRow = (r, i) => {
    const b = bold(r, i);
    const lines = r.map((c, k) => c ? io.wrap(c, b, Math.max(w[k] - 2*px, 1)) : []);
    const h = Math.max(1, ...lines.map(l => l.length)) * size * lh + 2*pad;
    if (io.need(h) && head && i > 0) drawRow(rows[0], 0);
    const top = io.y(); let x = io.x;
    if (head && i === 0){ if (io.fill) io.fill(io.x, top, tw, h); if (!io.fill) io.rule(io.x, io.x + tw, top, true); }
    lines.forEach((ls, k) => {
      ls.forEach((l, j) => io.text(l, al[k] === 'right' ? x + w[k] - px - io.measure(l, b) : x + px, top - pad - size - j*size*lh + size*.12, b));
      x += w[k];
    });
    io.setY(top - h);
    io.rule(io.x, io.x + tw, top - h, head && i === 0);
  };
  rows.forEach(drawRow);
}

const api = { blocks, join, hasTable, trim, plain, html, align, isTotal, isNum, hasHead, fit, drawTable, esc };
root.LSText = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
