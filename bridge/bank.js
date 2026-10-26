// Synchro bancaire (Enable Banking) — la partie pure : ni réseau, ni Supabase, testée dans
// bank.test.js. Les entrées/sorties vivent dans banksync.js.
//
// Ce que le pont écrit est un BROUILLON de relevé, exactement comme un fichier déposé dans
// l'écran Import : `draft = true`, rattaché à une ligne ls_imports « en attente », hors de tous
// les soldes tant que le syndic ne l'a pas validé. La catégorie reste vide (`high` null) : c'est
// l'app qui passe les règles, alias et copropriétaires à l'ouverture (app.js classifyBankDrafts),
// pour qu'une ligne synchronisée soit rangée par le même code qu'une ligne importée.

import crypto from 'node:crypto';

const DAY = 86400000;
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (iso, n) => isoDay(Date.parse(`${iso}T00:00:00Z`) + n * DAY);
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
/** 'YYYY-MM-DD' → 'DD/MM/YY', le format d'affichage que l'app range dans ls_imports.stmt. */
export const dispDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : ''; };
export const normIban = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cents = (n) => Math.round(Number(n) * 100);

/** Recouvrement à chaque synchro : une écriture comptabilisée avec quelques jours de retard
 *  (date de comptabilisation antérieure à la dernière synchro) est quand même rattrapée. */
export const OVERLAP_DAYS = 5;
/** Écart toléré entre la date d'un relevé déposé à la main et celle que donne la banque. */
export const LOOSE_DAYS = 3;
/** Historique demandé à défaut d'autre repère ; la plupart des banques s'arrêtent à 90 jours. */
export const DEFAULT_HISTORY_DAYS = 89;

/** Montant signé : Enable Banking donne un montant positif et un sens (CRDT entrée, DBIT sortie). */
export function signedAmount(tx) {
  const raw = Number(String(tx?.transaction_amount?.amount ?? '').replace(',', '.'));
  if (!Number.isFinite(raw)) return NaN;
  const ind = String(tx?.credit_debit_indicator || '').toUpperCase();
  if (ind === 'DBIT') return -Math.abs(raw);
  if (ind === 'CRDT') return Math.abs(raw);
  return raw;
}

/** Date de comptabilisation, à défaut date de valeur, à défaut date d'opération. */
export function txDate(tx) {
  const d = tx?.booking_date || tx?.value_date || tx?.transaction_date || '';
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '';
}

/**
 * Un mouvement Enable Banking → les champs d'une ligne ls_transactions.
 * Le tiers est la contrepartie : le bénéficiaire d'une sortie, le donneur d'ordre d'une entrée.
 * La communication (remittance_information) va dans la note. null si inexploitable : pas de
 * date, montant nul ou illisible, ou mouvement pas encore comptabilisé (en attente, rejeté…).
 */
export function mapBankTx(tx) {
  if (tx?.status && String(tx.status).toUpperCase() !== 'BOOK') return null;
  const tx_date = txDate(tx), amount = signedAmount(tx);
  if (!tx_date || !Number.isFinite(amount) || cents(amount) === 0) return null;
  const party = amount < 0 ? tx.creditor : tx.debtor;
  const remit = clean((Array.isArray(tx.remittance_information) ? tx.remittance_information : [tx.remittance_information]).filter(Boolean).join(' '));
  const code = clean(tx.bank_transaction_code?.description);
  const tiers = clean(party?.name) || remit || code || clean(tx.note) || '—';
  const note = remit && remit !== tiers ? remit : (code && code !== tiers ? code : '');
  return {
    tx_date, amount: cents(amount) / 100, tiers, note,
    ref: clean(tx.entry_reference) || clean(tx.transaction_id) || '',
    // pour l'empreinte de secours seulement
    _fp: [tx_date, cents(amount), clean(party?.name), remit, clean(tx.reference_number), code].join('|'),
  };
}

/**
 * Référence stable de chaque mouvement (`bank_ref`) : la référence de la banque
 * (entry_reference, sinon transaction_id) ; à défaut une empreinte de son contenu. Deux mouvements
 * identiques le même jour (deux frais de 0,60 €) gardent chacun la leur grâce au rang « #2 ».
 */
export function assignRefs(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const base = r.ref || `h:${crypto.createHash('sha1').update(r._fp).digest('hex').slice(0, 20)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const { _fp, ref, ...row } = r;
    return { ...row, bank_ref: n === 1 ? base : `${base}#${n}` };
  });
}

// Mots d'un libellé, pour départager deux lignes de même montant : « Transfer from Sam » et
// « Sam Bernard » partagent « sam ». Les mots de service des banques ne comptent pas.
const STOP = new Set(['transfer', 'transfert', 'from', 'the', 'virement', 'vers', 'des', 'les', 'pour', 'par', 'sepa',
  'credit', 'debit', 'paiement', 'payment', 'card', 'carte', 'instant', 'incoming', 'outgoing', 'recu', 'emis']);
export function words(s) {
  return new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
const overlap = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

/**
 * Écarte ce qui est déjà là.
 *  - `knownRefs` : les références déjà en base (y compris les lignes supprimées : une ligne mise à
 *    la corbeille ne revient pas) et celles déjà vues par une synchro précédente (un relevé
 *    synchronisé puis écarté ne revient pas non plus) ;
 *  - `loose` : les lignes déjà en base SANS référence bancaire (relevé PDF/CSV, collage, saisie) :
 *    même compte, même montant au centime, dates à `LOOSE_DAYS` jours près. Chaque ligne existante
 *    n'absorbe qu'un mouvement, et les paires dont les libellés partagent le plus de mots passent
 *    d'abord : quand Sam et Lou versent le même montant le même jour et que le relevé n'a que Lou,
 *    c'est le versement de Lou qui est reconnu, celui de Sam qui arrive.
 * @returns {{fresh:any[], known:number, matched:number}}
 */
export function dedupe(rows, { knownRefs = new Set(), loose = [] } = {}) {
  const pending = [];
  let known = 0;
  for (const r of rows) { if (knownRefs.has(r.bank_ref)) known++; else pending.push(r); }
  const pool = loose.map((p) => ({ d: String(p.tx_date || '').slice(0, 10), c: cents(p.amount), w: words(`${p.tiers || ''} ${p.note || ''}`) }));
  const pairs = [];
  pending.forEach((r, i) => {
    const c = cents(r.amount), w = words(`${r.tiers || ''} ${r.note || ''}`);
    pool.forEach((p, j) => {
      if (p.c !== c) return;
      const gap = Math.abs(daysBetween(r.tx_date, p.d));
      if (gap <= LOOSE_DAYS) pairs.push({ i, j, score: overlap(w, p.w), gap });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.gap - b.gap || a.i - b.i || a.j - b.j);
  const takenR = new Set(), takenP = new Set();
  for (const p of pairs) {
    if (takenR.has(p.i) || takenP.has(p.j)) continue;
    takenR.add(p.i); takenP.add(p.j);
  }
  const fresh = pending.filter((_, i) => !takenR.has(i)).sort((a, b) => a.tx_date.localeCompare(b.tx_date));
  return { fresh, known, matched: takenR.size };
}

/** Premier jour demandé à la banque : la dernière synchro, sinon la dernière ligne du compte, moins
 *  le recouvrement ; sans aucun repère, les 89 derniers jours. */
export function syncFrom({ syncedTo, latestLedgerDate, today }) {
  const anchor = syncedTo || latestLedgerDate;
  return anchor ? addDays(anchor, -OVERLAP_DAYS) : addDays(today, -DEFAULT_HISTORY_DAYS);
}

/** Le solde à rapprocher : le solde comptable du jour (ITBD), sinon de clôture (CLBD), sinon le
 *  solde attendu (XPCD), sinon le premier. {amount, type, date} ou null. */
export function pickBalance(balances) {
  const list = (Array.isArray(balances) ? balances : []).filter((b) => Number.isFinite(Number(b?.balance_amount?.amount)));
  for (const type of ['ITBD', 'CLBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD']) {
    const b = list.find((x) => String(x.balance_type || '').toUpperCase() === type);
    if (b) return toBalance(b);
  }
  return list[0] ? toBalance(list[0]) : null;
}
function toBalance(b) {
  const date = String(b.reference_date || b.last_change_date_time || '').slice(0, 10);
  return { amount: cents(b.balance_amount.amount) / 100, type: String(b.balance_type || ''), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '' };
}

/**
 * Un compte de la session → ce que le pont en garde, et sur quel compte LazySyndic il tombe :
 * l'IBAN appris à l'import (ls_settings.iban_map), sinon les IBAN saisis dans la fiche de
 * chaque compte (iban_pay / iban_res). null = à choisir dans l'app.
 */
export function mapAccount(a, settings = {}) {
  const iban = normIban(a?.account_id?.iban || (a?.all_account_ids || []).find((x) => x?.scheme_name === 'IBAN')?.identification);
  const map = settings.iban_map || {};
  let acct = (iban && (map[iban] === 'pay' || map[iban] === 'res')) ? map[iban] : null;
  if (!acct && iban && iban === normIban(settings.iban_pay)) acct = 'pay';
  if (!acct && iban && iban === normIban(settings.iban_res)) acct = 'res';
  return {
    uid: a.uid, hash: a.identification_hash || '', iban,
    name: clean(a.name), product: clean(a.product || a.details), currency: a.currency || 'EUR',
    acct, synced_to: null, balance: null,
  };
}

/** Compte LazySyndic effectif : le choix fait dans l'app (acct_map, par empreinte ou uid) l'emporte. */
export function effectiveAcct(account, acctMap = {}) {
  const v = acctMap[account.hash] ?? acctMap[account.uid];
  if (v === 'skip') return null;
  if (v === 'pay' || v === 'res') return v;
  return account.acct === 'pay' || account.acct === 'res' ? account.acct : null;
}

/** Reprise d'une connexion précédente (renouvellement du consentement) : même compte = même
 *  empreinte (identification_hash) ou même IBAN ; on garde où la synchro s'était arrêtée. */
export function carryOver(accounts, previous = []) {
  return accounts.map((a) => {
    for (const link of previous) {
      const old = (link.accounts || []).find((o) => (a.hash && o.hash === a.hash) || (a.iban && o.iban === a.iban));
      if (old && old.synced_to && (!a.synced_to || old.synced_to > a.synced_to)) return { ...a, synced_to: old.synced_to };
    }
    return a;
  });
}

/** Les références vues récemment ; au-delà de `keepDays` le recouvrement ne les redemande plus. */
export function trimSeen(seen, today, keepDays = 60) {
  const cut = addDays(today, -keepDays), out = {};
  for (const [ref, d] of Object.entries(seen || {})) if (String(d) >= cut) out[ref] = d;
  return out;
}

/** La banque d'Enable Banking qui porte ce nom (exact, sans casse ; sinon seule à le contenir). */
export function findAspsp(list, name) {
  const n = clean(name).toLowerCase();
  if (!n) return null;
  const exact = list.filter((a) => clean(a.name).toLowerCase() === n);
  if (exact.length) return exact[0];
  const part = list.filter((a) => clean(a.name).toLowerCase().includes(n));
  return part.length === 1 ? part[0] : null;
}

/** Fin du consentement demandé : le maximum de la banque, plafonné à 180 jours, moins 1 h de marge. */
export function consentUntil(aspsp, now = Date.now(), capDays = 180) {
  const max = Number(aspsp?.maximum_consent_validity) || 90 * 86400;
  const s = Math.min(max, capDays * 86400) - 3600;
  return new Date(now + s * 1000).toISOString();
}

/** Synchro due : demandée depuis l'app après la dernière, ou plus vieille que `hours`. */
export function syncDue(link, now = Date.now(), hours = 8) {
  const last = link.last_sync_at ? Date.parse(link.last_sync_at) : 0;
  const asked = link.sync_requested_at ? Date.parse(link.sync_requested_at) : 0;
  if (asked > last) return true;
  return now - last >= hours * 3600 * 1000;
}

/** Une adresse de retour acceptable : https, ou http sur la machine locale (tests). */
export function okRedirect(url, allow = []) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) return false;
  return !allow.length || allow.includes(u.href);
}
