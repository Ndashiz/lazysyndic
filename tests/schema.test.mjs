// Tests du schéma : chaque table et chaque colonne que le code utilise doit exister dans
// supabase/migrations/000_baseline.sql. Lancer : node --test tests/schema.test.mjs — aucune dépendance.
//
// Ce n'est PAS un exécuteur : rien n'est évalué, tout est lu par expressions régulières (et un petit
// compteur de parenthèses qui saute chaînes et commentaires) sur le source. Ce que l'on extrait, et d'où :
//
//   db.js — la couche Supabase
//     • sb.from('ls_x') / T('ls_x') puis, maillon par maillon dans la chaîne d'appels :
//         .select('a,b,c')                         → colonnes lues
//         .insert({…}) .update({…}) .upsert({…})    → clés de l'objet littéral ; si l'argument est une
//                                                    variable, sa déclaration `const x = … {…}` dans les
//                                                    30 lignes qui précèdent (+ les affectations `x.col = …`
//                                                    entre la déclaration et l'appel)
//         .eq('col',…) .in('col',…) .not('col',…) .lt('col',…) … → colonnes filtrées
//     • loadAll : res.ls_x … .filter(r=>…).map(r=>…).sort((a,b)=>…) → lectures r.col, a.col, b.col.
//       Seules les fonctions fléchées passées DIRECTEMENT à un maillon comptent : la chaîne de
//       ls_ag_points imbriquée dans celle de ls_ag est lue pour son propre compte.
//       `const settings = res.ls_settings[0]` → settings.col ; `const ownersRows = res.ls_owners…`
//       → ownersRows.map(r=>…) ; `const mapTx = r => ({…})` → ls_transactions.
//     • toute chaîne 'ls_…' (listes de loadAll, dumpAll, restore) → table qui doit exister.
//
//   app.js — les écritures qui traversent db.js telles quelles
//     • un helper de db.js est « transparent » quand il passe un de ses paramètres tel quel à
//       insert/update/upsert : updateSettings(patch), updateOwner(id, patch), agCreate(row), agPointUpdate(id, patch)…
//       (addContract, updateContract, addTransactions recopient champ par champ : ils ne le sont pas, db.js
//       suffit). Pour chacun, chaque appel db.<helper>(…) / window.LS.db.<helper>(…) d'app.js est lu : les
//       objets littéraux de premier niveau parmi ses arguments (y compris les deux branches d'un ternaire
//       `acct==='res'?{iban_res:v}:{iban_pay:v}`) donnent des colonnes ; une clé calculée `[field]` ou un
//       spread `...x` est ignoré (les colonnes visées sont de toute façon lues dans loadAll) ; une variable
//       est résolue comme ci-dessus (`const imp = {…}` ; `settingsPatch.recon = …`).
//
//   000_baseline.sql
//     • create table if not exists public.ls_x ( … )          → colonnes de la définition
//     • alter table public.ls_x add column if not exists col  → colonnes ajoutées après coup
//
// Garde-fous : quelques extractions connues sont vérifiées (ls_settings.recon, ls_ag.presence…) pour qu'une
// regex cassée fasse échouer le test au lieu de le vider ; check.sql doit attendre exactement les colonnes
// du baseline ; et le baseline est relu pour sa relançabilité (if not exists, drop … if exists, ls_ partout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const DB    = read('../db.js');
const APP   = read('../app.js');
const SQL   = read('../supabase/migrations/000_baseline.sql');
const CHECK = read('../supabase/check.sql');

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/* ---------- lexique minimal : chaînes, commentaires, parenthèses ---------- */
// Si src[i] ouvre une chaîne ('…', "…", `…` avec ${…} imbriqués) ou un commentaire (// ou /* */),
// renvoie l'index du premier caractère après ; sinon i.
function skipAtom(src, i){
  const ch = src[i];
  if (ch === "'" || ch === '"' || ch === '`'){
    for (let j = i + 1; j < src.length; j++){
      if (src[j] === '\\'){ j++; continue; }
      if (src[j] === ch) return j + 1;
      if (ch === '`' && src[j] === '$' && src[j + 1] === '{'){ const e = matchClose(src, j + 1, '{', '}'); if (e > 0) j = e; }
    }
    return src.length;
  }
  if (ch === '/' && src[i + 1] === '/'){ const n = src.indexOf('\n', i); return n < 0 ? src.length : n; }
  if (ch === '/' && src[i + 1] === '*'){ const n = src.indexOf('*/', i + 2); return n < 0 ? src.length : n + 2; }
  return i;
}
// Index de la fermeture qui équilibre l'ouverture située en openIdx (src[openIdx] === open), ou -1.
function matchClose(src, openIdx, open, close){
  let depth = 0;
  for (let i = openIdx; i < src.length; i++){
    const j = skipAtom(src, i); if (j !== i){ i = j - 1; continue; }
    if (src[i] === open) depth++;
    else if (src[i] === close){ depth--; if (depth === 0) return i; }
  }
  return -1;
}
// Parcourt `text` hors chaînes/commentaires en appelant fn(ch, i, depth) ; depth = (), [], {} imbriqués.
function walk(text, fn){
  let depth = 0;
  for (let i = 0; i < text.length; i++){
    const j = skipAtom(text, i); if (j !== i){ i = j - 1; continue; }
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    const skipTo = fn(ch, i, depth);
    if (typeof skipTo === 'number') i = skipTo;
  }
}
// Découpe sur `sep` au premier niveau.
function splitTop(text, sep = ','){
  const parts = []; let start = 0;
  walk(text, (ch, i, depth) => { if (ch === sep && depth === 0){ parts.push(text.slice(start, i)); start = i + 1; } });
  parts.push(text.slice(start));
  return parts;
}
// Clés de premier niveau d'un objet littéral `{ a: 1, b, 'c': 2, [calc]: 3, ...spread }` → ['a','b','c'].
function literalKeys(objText){
  const keys = [];
  for (let p of splitTop(objText.slice(1, -1))){
    p = p.trim(); if (!p || p.startsWith('...') || p.startsWith('[')) continue;
    const m = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(p);
    if (m) keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}
// Objets littéraux de premier niveau d'un texte d'argument : `{…}`, ou `cond ? {…} : {…}`.
function topLevelObjects(argText){
  const out = [];
  walk(argText, (ch, i, depth) => {
    if (ch === '{' && depth === 1){ const e = matchClose(argText, i, '{', '}'); if (e < 0) return; out.push(argText.slice(i, e + 1)); return e; }
  });
  return out;
}
// Suit la chaîne `.m(args).m(args)…` qui commence en startIdx ; onCall(méthode, texteDesArgs, indexDesArgs).
function walkChain(src, startIdx, onCall){
  for (let i = startIdx;;){
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i, i + 80));
    if (!m) return;
    const open = i + m[0].length - 1, close = matchClose(src, open, '(', ')');
    if (close < 0) return;
    onCall(m[1], src.slice(open + 1, close), open + 1);
    i = close + 1;
  }
}
// Variables des fonctions fléchées passées directement en argument : `r=>…`, `(a,b)=>…`, `async r=>…`.
function arrowVars(args){
  const vars = [];
  walk(args, (ch, i, depth) => {
    if (ch !== '=' || args[i + 1] !== '>' || depth !== 0) return;
    const before = args.slice(0, i).trimEnd();
    if (before.endsWith(')')){ const o = before.lastIndexOf('('); vars.push(...before.slice(o + 1, -1).split(',').map(s => s.trim()).filter(Boolean)); }
    else { const w = /([A-Za-z_$][\w$]*)$/.exec(before); if (w) vars.push(w[1]); }
  });
  return vars;
}
// Lectures `v.col` d'une variable (pas `v.méthode(`), dans un texte.
function propReads(text, v){
  const out = [], re = new RegExp(`(?<![\\w$.])${v.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)(?![\\w$]|\\s*\\()`, 'g');
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}
// L'argument est une variable : on cherche `const|let|var x =` dans les `lines` lignes qui précèdent l'appel,
// sans franchir une fonction de premier niveau. Colonnes = clés du premier objet littéral de la déclaration
// + affectations `x.col = …` entre la déclaration et l'appel. null si rien n'est trouvé.
function resolveIdent(src, name, callIdx, lines = 30){
  let start = callIdx;
  for (let n = 0; n <= lines && start > 0; n++) start = src.lastIndexOf('\n', start - 1);
  const region = src.slice(Math.max(0, start), callIdx);
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, 'g');
  let last = null; for (const m of region.matchAll(decl)) last = m;
  if (!last) return null;
  const after = region.slice(last.index + last[0].length);
  if (/^(?:async\s+)?function\b|^\}/m.test(after)) return null;      // la déclaration n'est pas dans la même fonction
  const cols = [];
  const brace = after.indexOf('{'), semi = after.indexOf(';');
  if (brace >= 0 && (semi < 0 || brace < semi)){ const e = matchClose(after, brace, '{', '}'); if (e > 0) cols.push(...literalKeys(after.slice(brace, e + 1))); }
  for (const m of after.matchAll(new RegExp(`(?<![\\w$.])${name}\\.([A-Za-z_$][\\w$]*)(?![\\w$])\\s*=(?!=)`, 'g'))) cols.push(m[1]);
  return cols;
}

/* ---------- 1. colonnes utilisées par le code ---------- */
const used = new Map();                      // table → Map(colonne → Set('fichier:ligne'))
const usedTables = new Map();                // table → Set('fichier:ligne')
function addTable(table, where){ if (!usedTables.has(table)) usedTables.set(table, new Set()); usedTables.get(table).add(where); }
function addCol(table, col, where){
  addTable(table, where);
  if (!used.has(table)) used.set(table, new Map());
  const cols = used.get(table);
  if (!cols.has(col)) cols.set(col, new Set());
  cols.get(col).add(where);
}
const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'order', 'contains']);
const WRITES  = new Set(['insert', 'update', 'upsert']);

// 1a. tables nommées dans db.js
for (const m of DB.matchAll(/'(ls_\w+)'/g)) addTable(m[1], `db.js:${lineOf(DB, m.index)}`);

// 1b. chaînes sb.from('ls_x') / T('ls_x') de db.js
for (const m of DB.matchAll(/(?:\bT|\bsb\.from)\(\s*'(ls_\w+)'\s*\)/g)){
  const table = m[1];
  walkChain(DB, m.index + m[0].length, (method, args, argIdx) => {
    const where = `db.js:${lineOf(DB, argIdx)}`;
    if (method === 'select'){
      const s = /^\s*'([^']*)'/.exec(args);
      if (s && s[1].trim() !== '*') s[1].split(',').forEach(c => addCol(table, c.trim(), where));
    } else if (WRITES.has(method)){
      const a = args.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(a)) (resolveIdent(DB, a, argIdx) || []).forEach(c => addCol(table, c, where));
      else topLevelObjects(args).forEach(o => literalKeys(o).forEach(c => addCol(table, c, where)));
    } else if (FILTERS.has(method)){
      const s = /^\s*'([^']+)'/.exec(args);
      if (s) addCol(table, s[1], where);
    }
  });
}

// 1c. lectures de loadAll (res.ls_x … .map(r=>…)), alias (settings, ownersRows) et mapTx
const loadAllAt = DB.indexOf('async function loadAll(){');
assert.ok(loadAllAt > 0, 'db.js : loadAll introuvable');
const loadAllEnd = matchClose(DB, DB.indexOf('{', loadAllAt), '{', '}');
const LOAD = DB.slice(loadAllAt, loadAllEnd + 1);
function readsOfChain(src, table, startIdx, base){
  walkChain(src, startIdx, (method, args, argIdx) => {
    const where = `db.js:${lineOf(DB, base + argIdx)}`;
    for (const v of arrowVars(args)) for (const c of propReads(args, v)) addCol(table, c, where);
  });
}
for (const m of LOAD.matchAll(/\(?\bres\.(ls_\w+)(?:\s*\|\|\s*\[\]\s*\))?/g)) readsOfChain(LOAD, m[1], m.index + m[0].length, loadAllAt);
for (const m of LOAD.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?res\.(ls_\w+)/g)){
  const [, alias, table] = m;
  for (const o of LOAD.matchAll(new RegExp(`(?<![\\w$.])${alias}\\b`, 'g'))){
    if (o.index === m.index + m[0].indexOf(alias)) continue;                 // la déclaration elle-même
    readsOfChain(LOAD, table, o.index + alias.length, loadAllAt);
  }
  for (const c of propReads(LOAD, alias)) addCol(table, c, `db.js:loadAll(${alias}.${c})`);
}
const mapTxAt = DB.search(/const mapTx\s*=\s*r\s*=>\s*\(/);
assert.ok(mapTxAt >= 0, 'db.js : mapTx introuvable');
{
  const open = DB.indexOf('(', DB.indexOf('=>', mapTxAt)), close = matchClose(DB, open, '(', ')');
  for (const c of propReads(DB.slice(open, close + 1), 'r')) addCol('ls_transactions', c, `db.js:${lineOf(DB, mapTxAt)} (mapTx)`);
}

// 1d. helpers transparents de db.js → objets littéraux passés depuis app.js
const passThrough = {};                      // helper → table
for (const m of DB.matchAll(/async\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)){
  const params = m[2].split(',').map(s => s.trim().replace(/=.*$/, '').trim()).filter(Boolean);
  const open = m.index + m[0].length - 1, close = matchClose(DB, open, '{', '}');
  const w = /(?:\bT|\bsb\.from)\(\s*'(ls_\w+)'\s*\)\s*\.\s*(?:insert|update|upsert)\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(DB.slice(open, close + 1));
  if (w && params.includes(w[2])) passThrough[m[1]] = w[1];
}
for (const [helper, table] of Object.entries(passThrough)){
  for (const m of APP.matchAll(new RegExp(`\\bdb\\.${helper}\\(`, 'g'))){
    const open = m.index + m[0].length - 1, close = matchClose(APP, open, '(', ')');
    if (close < 0) continue;
    const where = `app.js:${lineOf(APP, open)} (${helper})`;
    for (const arg of splitTop(APP.slice(open + 1, close))){
      const a = arg.trim(); if (!a) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(a)) (resolveIdent(APP, a, open) || []).forEach(c => addCol(table, c, where));
      else topLevelObjects(arg).forEach(o => literalKeys(o).forEach(c => addCol(table, c, where)));
    }
  }
}

/* ---------- 2. colonnes définies par le baseline ---------- */
function parseBaseline(sql){
  const s = sql.replace(/--[^\n]*/g, '');
  const tables = {};
  for (const m of s.matchAll(/create table if not exists public\.(ls_\w+)\s*\(/gi)){
    const open = m.index + m[0].length - 1, close = matchClose(s, open, '(', ')');
    const cols = (tables[m[1]] ??= new Set());
    for (const part of splitTop(s.slice(open + 1, close))){
      const w = /^\s*([A-Za-z_]\w*)/.exec(part);
      if (w && !/^(constraint|primary|unique|check|foreign|exclude)$/i.test(w[1])) cols.add(w[1]);
    }
  }
  for (const m of s.matchAll(/alter table public\.(ls_\w+)\s+add column if not exists\s+([A-Za-z_]\w*)/gi)) (tables[m[1]] ??= new Set()).add(m[2]);
  return tables;
}
const baseline = parseBaseline(SQL);

/* ---------- tests ---------- */
test('garde-fous : l’extraction trouve bien ce que l’on sait être dans le code', () => {
  const has = (t, c) => used.has(t) && used.get(t).has(c);
  for (const [t, c] of [
    ['ls_members', 'owner_short'], ['ls_transactions', 'import_v'], ['ls_transactions', 'deleted_at'], ['ls_transactions', 'tx_date'],
    ['ls_settings', 'recon'], ['ls_settings', 'owner_rules'], ['ls_settings', 'charges'], ['ls_settings', 'copro_kbo'], ['ls_settings', 'iban_map'],
    ['ls_owners', 'due_pay'], ['ls_owners', 'email'], ['ls_ag', 'presence'], ['ls_ag', 'bureau'], ['ls_ag', 'ag_date'], ['ls_ag', 'convocation_date'],
    ['ls_ag_points', 'votes'], ['ls_ag_points', 'seance_notes'], ['ls_ag_points', 'ag_id'], ['ls_contracts', 'end_date'], ['ls_imports', 'stmt'],
    ['ls_timeline', 'event_date'],
  ]) assert.ok(has(t, c), `extraction cassée : ${t}.${c} aurait dû être trouvée`);
  assert.ok(Object.keys(passThrough).length >= 15, `helpers transparents : ${Object.keys(passThrough).join(', ')}`);
  assert.equal(passThrough.updateSettings, 'ls_settings');
  assert.equal(passThrough.agPointUpdate, 'ls_ag_points');
  assert.equal(passThrough.addContract, undefined, 'addContract recopie champ par champ : pas transparent');
  assert.ok(usedTables.size >= 13, `tables utilisées : ${[...usedTables.keys()].join(', ')}`);
});

test('chaque table et chaque colonne utilisée par db.js / app.js existe dans 000_baseline.sql', t => {
  const missing = [];
  for (const [table, where] of usedTables) if (!baseline[table]) missing.push(`${table} (create table absent) ← ${[...where].slice(0, 3).join(', ')}`);
  for (const [table, cols] of used){
    if (!baseline[table]) continue;
    for (const [col, where] of cols) if (!baseline[table].has(col)) missing.push(`${table}.${col} ← ${[...where].slice(0, 3).join(', ')}`);
  }
  const nCols = [...used.values()].reduce((n, m) => n + m.size, 0);
  t.diagnostic(`${usedTables.size} tables, ${nCols} colonnes utilisées, ${Object.keys(baseline).length} tables dans le baseline`);
  assert.deepEqual(missing, [], 'Colonnes utilisées par le code mais absentes du baseline :\n  ' + missing.join('\n  '));
});

test('check.sql attend exactement les tables et colonnes du baseline', () => {
  const tbl = /attendu_tables\(t\) as \(values([\s\S]*?)\),\s*attendu_colonnes/.exec(CHECK);
  const col = /attendu_colonnes\(t, c\) as \(values([\s\S]*?)\),\s*presentes/.exec(CHECK);
  assert.ok(tbl && col, 'check.sql : blocs attendu_tables / attendu_colonnes introuvables');
  const expTables = new Set([...tbl[1].matchAll(/'(ls_\w+)'/g)].map(m => m[1]));
  const expCols = new Set([...col[1].matchAll(/\('(ls_\w+)',\s*'(\w+)'\)/g)].map(m => `${m[1]}.${m[2]}`));
  const baseCols = new Set(Object.entries(baseline).flatMap(([t, cs]) => [...cs].map(c => `${t}.${c}`)));
  assert.deepEqual([...expTables].sort(), Object.keys(baseline).sort(), 'tables attendues par check.sql ≠ baseline');
  assert.deepEqual([...expCols].filter(x => !baseCols.has(x)), [], 'check.sql attend des colonnes que le baseline ne crée pas');
  assert.deepEqual([...baseCols].filter(x => !expCols.has(x)), [], 'le baseline crée des colonnes que check.sql n’attend pas');
});

test('le baseline est relançable et ne sort pas du préfixe ls_', () => {
  const s = SQL.replace(/--[^\n]*/g, '');
  assert.equal((s.match(/create table(?! if not exists)/gi) || []).length, 0, 'create table sans if not exists');
  assert.equal((s.match(/create (?:unique )?index(?! if not exists)/gi) || []).length, 0, 'create index sans if not exists');
  assert.equal((s.match(/add column(?! if not exists)/gi) || []).length, 0, 'add column sans if not exists');
  assert.equal((s.match(/create function/gi) || []).length, 0, 'create function sans or replace');
  assert.equal((s.match(/\bdrop table\b/gi) || []).length, 0, 'un baseline ne détruit rien');
  for (const m of s.matchAll(/create policy (\S+)/gi))
    assert.ok(s.slice(0, m.index).includes(`drop policy if exists ${m[1]}`), `create policy ${m[1]} sans drop policy if exists avant`);
  for (const m of s.matchAll(/create trigger (\w+)/gi))
    assert.ok(s.slice(0, m.index).includes(`drop trigger if exists ${m[1]}`), `create trigger ${m[1]} sans drop trigger if exists avant`);
  for (const m of s.matchAll(/add constraint (\w+)/gi)){
    const before = s.slice(Math.max(0, m.index - 800), m.index);
    assert.ok(before.includes(`drop constraint if exists ${m[1]}`) || /if not exists \(/.test(before), `add constraint ${m[1]} ni précédé d'un drop, ni gardé par un if not exists`);
  }
  for (const m of s.matchAll(/insert into (\S+)[\s\S]*?;/gi)) assert.ok(/on conflict/i.test(m[0]), `insert into ${m[1]} sans on conflict`);
  // rien hors préfixe ls_ (projet partagé)
  for (const re of [/create table if not exists public\.(\w+)/gi, /create policy (\w+)/gi, /create (?:unique )?index if not exists (\w+)/gi,
                    /create or replace function public\.(\w+)/gi, /create trigger (\w+)/gi, /alter table public\.(\S+)/gi])
    for (const m of s.matchAll(re)) assert.ok(/^(ls_|%I)/.test(m[1]), `hors préfixe ls_ : ${m[0]}`);
  assert.ok(/'ls-docs'/.test(s) && !/storage\.buckets[\s\S]*?values \('(?!ls-docs)/.test(s), 'bucket hors ls-docs');
  // dépôt public : aucun e-mail, aucun nom réel
  assert.ok(!/@/.test(SQL), 'un @ dans le baseline : pas d’e-mail réel dans un dépôt public');
  assert.ok(/EMAIL_ADMIN/.test(SQL) && /Alex Martin/.test(SQL), 'les exemples fictifs (EMAIL_ADMIN / Alex Martin) doivent rester tels quels');
});
