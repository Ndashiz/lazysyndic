// Synchro bancaire (Enable Banking) — le moteur : il lit la table ls_bank_links et fait avancer
// chaque connexion d'une étape. Supabase sert de boîte aux lettres entre l'app (navigateur, sans
// secret) et le pont (VPS, seul détenteur de la clé privée Enable Banking) :
//
//   app      : insère une demande          → status 'requested'   (banque, pays, state, retour)
//   pont     : POST /auth                   → status 'auth_ready'  (auth_url)
//   app      : envoie le syndic sur auth_url ; la banque le renvoie sur banque.html?code=…&state=…
//   app      : dépose le code               → status 'code_received'
//   pont     : POST /sessions               → status 'active'      (comptes, échéance) + 1re synchro
//   pont     : toutes les `syncHours`, ou quand l'app pose sync_requested_at → synchro
//   app      : « Déconnecter »              → status 'revoke_requested' → pont : DELETE /sessions → 'revoked'
//
// Les mouvements arrivent en brouillon dans un relevé « à valider » par compte (ls_imports
// pending, stmt.source = 'bank') : rien n'entre dans les soldes sans la validation du syndic.

import {
  isoDay, addDays, dispDate, normIban, mapBankTx, assignRefs, dedupe, syncFrom, pickBalance,
  mapAccount, effectiveAcct, carryOver, trimSeen, findAspsp, consentUntil, syncDue, okRedirect,
  LOOSE_DAYS, DEFAULT_HISTORY_DAYS,
} from './bank.js';
import { EnableBankingError } from './enablebanking.js';

const WORKING = ['requested', 'code_received', 'active', 'revoke_requested'];
const STALE_MS = 15 * 60 * 1000;           // une demande ou un code plus vieux est abandonné
const acctLabel = (a) => (a === 'res' ? 'compte de réserve' : 'compte de paiement');
const round2 = (n) => Math.round(n * 100) / 100;
const fmtIban = (s) => normIban(s).replace(/(.{4})(?=.)/g, '$1 ');
const short = (e) => String(e?.message || e).slice(0, 400);

/**
 * @param {{rest:any, eb:any, log?:Console, syncHours?:number, redirectAllow?:string[], now?:()=>number}} o
 */
export function createBankSync({ rest, eb, log = console, syncHours = 8, redirectAllow = [], now = () => Date.now() }) {
  let running = null;
  let quietUntil = 0, quietHistoryUntil = 0;
  // « Synchroniser maintenant » posé depuis l'app après la dernière synchro
  const manualAsked = (l) => !!l.sync_requested_at && Date.parse(l.sync_requested_at) > (l.last_sync_at ? Date.parse(l.last_sync_at) : 0);
  const stamp = () => new Date(now()).toISOString();
  const patchLink = (id, patch) => rest.update('ls_bank_links', `id=eq.${id}`, { ...patch, updated_at: stamp() });

  /** Un passage : chaque connexion en cours avance d'une étape. Jamais deux passages à la fois. */
  function tick({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      let links;
      try {
        links = await rest.select('ls_bank_links', `select=*&status=in.(${WORKING.join(',')})&order=created_at.asc`);
      } catch (e) {
        // table absente (baseline pas relancé) : un message par heure, pas toutes les 20 s
        if (now() > quietUntil) { log.error('bank: ls_bank_links illisible —', short(e)); quietUntil = now() + 3600e3; }
        return [];
      }
      const out = [];
      for (const link of links) {
        try { out.push(await step(link, { force })); }
        catch (e) { log.error(`bank: connexion ${link.id} (${link.status}) —`, short(e)); out.push({ id: link.id, error: short(e) }); }
      }
      return out;
    })().finally(() => { running = null; });
    return running;
  }

  async function step(link, { force }) {
    switch (link.status) {
      case 'requested': return startAuth(link);
      case 'code_received': return exchange(link);
      case 'revoke_requested': return revoke(link);
      case 'active':
        if (link.valid_until && Date.parse(link.valid_until) <= now()) {
          await patchLink(link.id, { status: 'expired', error: 'Le consentement donné à la banque est arrivé à échéance : reconnectez la banque.' });
          return { id: link.id, status: 'expired' };
        }
        if (!force && !syncDue(link, now(), syncHours)) return { id: link.id, status: 'idle' };
        return syncLink(link, force ? 'cli' : manualAsked(link) ? 'manual' : 'auto');
      default: return { id: link.id, status: link.status };
    }
  }

  async function fail(link, message) {
    await patchLink(link.id, { status: 'error', error: message, code: null });
    return { id: link.id, status: 'error', error: message };
  }

  /* ---------- 1. demande de connexion → lien d'autorisation de la banque ---------- */
  async function startAuth(link) {
    if (now() - Date.parse(link.created_at) > STALE_MS) return fail(link, 'Demande abandonnée : relancez la connexion depuis l’app.');
    if (!okRedirect(link.redirect_url, redirectAllow)) return fail(link, `Adresse de retour refusée : ${link.redirect_url}`);
    try {
      const list = await eb.aspsps(link.aspsp_country);
      const aspsp = findAspsp(list, link.aspsp_name);
      if (!aspsp) {
        const probe = String(link.aspsp_name || '').toLowerCase().slice(0, 3);
        const near = list.map((a) => a.name).filter((n) => probe && n.toLowerCase().includes(probe)).slice(0, 8);
        return fail(link, `« ${link.aspsp_name} » n’est pas proposée par Enable Banking pour ce pays (${link.aspsp_country}).`
          + (near.length ? ` Noms proches : ${near.join(', ')}.` : ` ${list.length} banque(s) disponibles : vérifiez le pays ou le nom exact (node eb.js banks ${link.aspsp_country}).`));
      }
      const types = Array.isArray(aspsp.psu_types) ? aspsp.psu_types : [];
      const psuType = types.includes(link.psu_type) ? link.psu_type : (types[0] || link.psu_type || 'business');
      const validUntil = consentUntil(aspsp, now());
      const r = await eb.startAuth({
        aspspName: aspsp.name, country: aspsp.country || link.aspsp_country, psuType,
        redirectUrl: link.redirect_url, state: link.state, validUntil,
      });
      if (!r || !r.url) return fail(link, 'Enable Banking n’a pas renvoyé de lien d’autorisation.');
      await patchLink(link.id, { status: 'auth_ready', auth_url: r.url, aspsp_name: aspsp.name, psu_type: psuType, valid_until: validUntil, error: null });
      log.log(`bank: lien d'autorisation prêt pour ${aspsp.name} (${link.aspsp_country})`);
      return { id: link.id, status: 'auth_ready' };
    } catch (e) {
      return fail(link, `Démarrage refusé par Enable Banking : ${short(e)}`);
    }
  }

  /* ---------- 2. code renvoyé par la banque → session + première synchro ---------- */
  async function exchange(link) {
    if (now() - Date.parse(link.updated_at || link.created_at) > STALE_MS) return fail(link, 'Le code de la banque a expiré : relancez la connexion.');
    let s;
    try { s = await eb.createSession(link.code); }
    catch (e) { return fail(link, `La banque n’a pas validé l’accès : ${short(e)}`); }
    const settings = (await rest.select('ls_settings', 'select=iban_pay,iban_res,iban_map&id=eq.1').catch(() => []))[0] || {};
    const prev = await rest.select('ls_bank_links',
      `select=id,status,session_id,accounts,seen,acct_map&id=neq.${link.id}&status=in.(active,expired,replaced,revoked,error)&order=created_at.desc&limit=5`).catch(() => []);
    const accounts = carryOver((s.accounts || []).map((a) => mapAccount(a, settings)), prev);
    const seen = trimSeen(Object.assign({}, ...prev.slice().reverse().map((p) => p.seen || {})), isoDay(now()));
    const acctMap = { ...((prev.find((p) => p.acct_map && Object.keys(p.acct_map).length) || {}).acct_map || {}), ...(link.acct_map || {}) };
    const validUntil = (s.access && s.access.valid_until) || link.valid_until;
    await patchLink(link.id, { status: 'active', session_id: s.session_id, accounts, seen, acct_map: acctMap, valid_until: validUntil, code: null, error: null });
    log.log(`bank: connexion active — ${accounts.length} compte(s)`);
    // L'ancienne connexion s'efface : une seule synchro par compte.
    for (const p of prev.filter((x) => x.status === 'active')) {
      await patchLink(p.id, { status: 'replaced' });
      if (p.session_id) await eb.deleteSession(p.session_id).catch(() => {});
    }
    return syncLink({ ...link, status: 'active', session_id: s.session_id, accounts, seen, acct_map: acctMap, valid_until: validUntil, last_sync_at: null }, 'connect');
  }

  /* ---------- 3. déconnexion demandée depuis l'app ---------- */
  async function revoke(link) {
    if (link.session_id) {
      await eb.deleteSession(link.session_id).catch((e) => {
        if (!(e instanceof EnableBankingError) || ![404, 410, 422].includes(e.status)) throw e;
      });
    }
    await patchLink(link.id, { status: 'revoked', code: null, error: null });
    return { id: link.id, status: 'revoked' };
  }

  /* ---------- 4. synchro ---------- */
  /**
   * Une ligne d'historique par synchro (ls_bank_syncs), réussie ou non, même sans nouveauté :
   * c'est ce que le syndic relit dans la carte. Jamais bloquant : sans la table (SQL pas encore
   * lancé), la synchro continue et un message par heure le signale.
   */
  async function logSync(link, cause, result, accounts) {
    const balances = {};
    for (const a of accounts) {
      const acct = effectiveAcct(a, link.acct_map || {});
      if (acct && a.balance) balances[acct] = a.balance.amount;
    }
    await rest.insert('ls_bank_syncs', {
      link_id: link.id, at: result.at, cause, ok: !result.error,
      added_pay: result.added.pay || 0, added_res: result.added.res || 0,
      known: result.known || 0, matched: result.matched || 0,
      balances, warnings: result.warnings || [], error: result.error || null,
    }).catch((e) => {
      if (now() > quietHistoryUntil) { log.error('bank: historique non écrit —', short(e)); quietHistoryUntil = now() + 3600e3; }
    });
  }

  /** @param {'auto'|'manual'|'connect'|'cli'} cause  ce qui a déclenché la synchro (historique) */
  async function syncLink(link, cause = 'auto') {
    const today = isoDay(now());
    const seen = { ...(link.seen || {}) };
    const accounts = (link.accounts || []).map((a) => ({ ...a }));
    const result = { at: stamp(), added: {}, known: 0, matched: 0, warnings: [] };
    try {
      // Exercices clôturés (ls_periods, s'il existe) : la base y refuse toute validation.
      const closed = await rest.select('ls_periods', 'select=starts,ends&closed_at=not.is.null').catch(() => []);
      for (const a of accounts) {
        const acct = effectiveAcct(a, link.acct_map || {});
        if (!acct) continue;
        const r = await syncAccount(link, a, acct, today, seen, closed);
        result.added[acct] = (result.added[acct] || 0) + r.added;
        result.known += r.known;
        result.matched += r.matched;
        if (r.warning) result.warnings.push(r.warning);
      }
    } catch (e) {
      result.error = short(e);
      const base = { accounts, seen: trimSeen(seen, today), last_sync_at: result.at, last_sync: result, error: result.error };
      // Une session expirée ou révoquée côté banque répond par une erreur sur les comptes.
      if (e instanceof EnableBankingError && [401, 403, 404, 422].includes(e.status) && link.session_id) {
        const s = await eb.getSession(link.session_id).catch(() => null);
        if (s && s.status && s.status !== 'AUTHORIZED') {
          await patchLink(link.id, { ...base, status: s.status === 'REVOKED' ? 'revoked' : 'expired', error: `Session ${s.status} côté banque : reconnectez la banque.` });
          await logSync(link, cause, { ...result, error: `Session ${s.status} côté banque : ${result.error}` }, accounts);
          return { id: link.id, status: 'expired', error: result.error };
        }
      }
      await patchLink(link.id, base);   // last_sync_at posé : pas de nouvel essai avant la prochaine échéance
      await logSync(link, cause, result, accounts);
      log.error('bank: synchro en échec —', result.error);
      return { id: link.id, status: 'active', ...result };
    }
    await patchLink(link.id, { accounts, seen: trimSeen(seen, today), last_sync_at: result.at, last_ok_at: result.at, last_sync: result, error: null });
    await logSync(link, cause, result, accounts);
    const n = Object.values(result.added).reduce((x, y) => x + y, 0);
    log.log(`bank: synchro faite — ${n} nouveau(x) mouvement(s), ${result.known + result.matched} déjà connu(s)`);
    return { id: link.id, status: 'active', ...result };
  }

  async function syncAccount(link, a, acct, today, seen, closed = []) {
    let latest = null;
    if (!a.synced_to) {
      const r = await rest.select('ls_transactions', `select=tx_date&account=eq.${acct}&deleted_at=is.null&order=tx_date.desc&limit=1`);
      latest = r[0] && r[0].tx_date ? String(r[0].tx_date).slice(0, 10) : null;
    }
    let dateFrom = syncFrom({ syncedTo: a.synced_to, latestLedgerDate: latest, today });
    let warning = null, raw;
    try {
      raw = await eb.transactions(a.uid, { dateFrom });
    } catch (e) {
      // Historique trop ancien pour la banque : on retente sur les 89 derniers jours.
      const floor = addDays(today, -DEFAULT_HISTORY_DAYS);
      if (!(e instanceof EnableBankingError) || e.status < 400 || e.status >= 500 || e.status === 429 || dateFrom >= floor) throw e;
      dateFrom = floor;
      raw = await eb.transactions(a.uid, { dateFrom });
      warning = `${acctLabel(acct)} : la banque limite l’historique, synchro à partir du ${dispDate(floor)}.`;
    }
    const rows = assignRefs((raw || []).map(mapBankTx).filter(Boolean)).filter((r) => r.tx_date >= dateFrom);
    const existing = await rest.select('ls_transactions',
      `select=tx_date,amount,tiers,note,bank_ref,deleted_at&account=eq.${acct}&tx_date=gte.${addDays(dateFrom, -LOOSE_DAYS)}`);
    const knownRefs = new Set(existing.filter((r) => r.bank_ref).map((r) => r.bank_ref));
    for (const k of Object.keys(seen)) if (k.startsWith(`${acct}:`)) knownRefs.add(k.slice(acct.length + 1));
    const dd = dedupe(rows, { knownRefs, loose: existing.filter((r) => !r.bank_ref && !r.deleted_at) });
    const { known, matched } = dd;
    // Un mouvement daté d'un exercice clôturé ne pourrait jamais être validé, et bloquerait la
    // validation de tout son relevé : il est écarté, et le syndic prévenu.
    const inClosed = (d) => (closed || []).some((p) => p && p.starts && p.ends && d >= String(p.starts).slice(0, 10) && d <= String(p.ends).slice(0, 10));
    const fresh = dd.fresh.filter((r) => !inClosed(r.tx_date));
    const blocked = dd.fresh.length - fresh.length;
    if (blocked) warning = `${acctLabel(acct)} : ${blocked} mouvement(s) daté(s) d’un exercice clôturé, non importé(s) — à saisir à la main si l’exercice est rouvert.`;

    let balance = null;
    try { balance = pickBalance(await eb.balances(a.uid)); }
    catch (e) { warning = warning || `${acctLabel(acct)} : solde illisible (${short(e)}).`; }

    const open = await openBankImport(acct);
    if (fresh.length) {
      const v = open ? open.v : await nextImportV();
      await rest.insert('ls_transactions', fresh.map((r) => ({
        tx_date: r.tx_date, tiers: r.tiers, note: r.note, amount: r.amount, account: acct,
        high: null, sub: '', owner: '', flag: false, comment: '', draft: true, import_v: v, bank_ref: r.bank_ref,
      })));
      await saveImport(open, v, link, a, acct, balance, today);
      await rest.insert('ls_timeline', {
        event_date: today, kind: 'import', title: `Synchro bancaire — ${acctLabel(acct)}`,
        description: `${fresh.length} mouvement(s) ajouté(s) au relevé v${v}, à valider dans Import.`,
      }).catch(() => {});
    } else if (open) {
      await saveImport(open, open.v, link, a, acct, balance, today);   // seul le solde a pu bouger
    }
    for (const r of rows) seen[`${acct}:${r.bank_ref}`] = r.tx_date;
    a.synced_to = today;
    a.balance = balance;
    return { added: fresh.length, known, matched, warning };
  }

  async function openBankImport(acct) {
    const r = await rest.select('ls_imports', `select=id,v,stmt&pending=eq.true&stmt->>source=eq.bank&stmt->>acct=eq.${acct}&order=v.desc&limit=1`);
    return r[0] || null;
  }

  async function nextImportV() {
    const [imp, tx] = await Promise.all([
      rest.select('ls_imports', 'select=v&v=not.is.null&order=v.desc&limit=1'),
      rest.select('ls_transactions', 'select=import_v&import_v=not.is.null&order=import_v.desc&limit=1'),
    ]);
    return Math.max(Number(imp[0]?.v) || 0, Number(tx[0]?.import_v) || 0) + 1;
  }

  /**
   * La fiche du relevé (ls_imports) : période, IBAN, titulaire, et le solde de la banque comme
   * clôture — l'app le rapproche du solde calculé à la validation. Le solde d'ouverture n'est
   * déduit que si le compte n'a aucune autre ligne (premier relevé du compte).
   */
  async function saveImport(open, v, link, a, acct, balance, today) {
    const rows = await rest.select('ls_transactions', `select=tx_date,amount&import_v=eq.${v}&deleted_at=is.null&draft=eq.true`);
    const dates = rows.map((r) => String(r.tx_date).slice(0, 10)).sort();
    const total = rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) / 100;
    const others = await rest.select('ls_transactions',
      `select=id&account=eq.${acct}&deleted_at=is.null&or=(import_v.is.null,import_v.neq.${v})&limit=1`);
    const prevStmt = (open && open.stmt) || {};
    const stmt = {
      ...prevStmt,
      acct, source: 'bank', aspsp: link.aspsp_name,
      iban: a.iban ? fmtIban(a.iban) : (prevStmt.iban || null),
      holder: a.name || prevStmt.holder || null,
      from: dates.length ? dispDate(dates[0]) : (prevStmt.from || ''),
      asOf: dispDate((balance && balance.date) || today),
      closing: balance ? balance.amount : (prevStmt.closing ?? null),
      opening: balance && !others.length ? round2(balance.amount - total) : null,
    };
    const meta = `${rows.length} transaction(s) — en attente de validation`;
    if (open) await rest.update('ls_imports', `id=eq.${open.id}`, { stmt, meta });
    else await rest.insert('ls_imports', { v, label: `Synchro ${link.aspsp_name} — ${acctLabel(acct)}`, meta, cur: false, pending: true, stmt });
  }

  return { tick, step, syncLink };
}
