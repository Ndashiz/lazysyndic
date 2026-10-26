// LazySyndic → Jarvis bridge — pure alert-building logic.
// Ported faithfully from app.js (norm / detectOwner / verseFromTx / ownerLedger)
// so the bridge's "impayés" match exactly what the dashboard shows.
// No external dependencies; unit-tested in alerts.test.js.

/** app.js:48 — lowercase, collapse whitespace, trim. */
export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Display euro amount, fr-BE style, deterministic (no ICU dependency). */
export const eur = (n) => `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} €`;

// app.js OWNER-DETECT — built-in label→owner hints (only applied if that owner exists). Kept
// empty on purpose: labels specific to one building live in ls_settings.owner_rules (learned in
// the app or set in SQL), never in code — the repo is public.
const BUILTIN_OWNERS = [];

/**
 * app.js detectOwner (bloc OWNER-DETECT) — heuristic owner attribution from a transaction's
 * tiers+note, used only when the tx has no explicit `owner`. Order: 1. learned rule on the
 * exact label (a manual attribution); 2. an owner's short or full name as a whole word in the
 * label or note; 3. learned rules by substring; 4. built-in labels. A rule pointing at an owner
 * that no longer exists is ignored. Learned rules used to come first: « fond de reserve » → Alex
 * also caught « FOND DE RESERVE - LOU »; the name now beats any rule shorter than the label.
 * @param {{tiers?:string, note?:string}} t
 * @param {Array<{short:string, name?:string}>} owners
 * @param {Record<string,string>} ownerRules  normalized-label → owner short
 */
export function detectOwner(t, owners, ownerRules = {}) {
  const tiers = norm(t.tiers), hay = norm(`${t.tiers || ''} ${t.note || ''}`);
  const exists = (short) => owners.some((o) => o.short === short);
  if (ownerRules[tiers] && exists(ownerRules[tiers])) return ownerRules[tiers];
  const word = (s) => !!s && new RegExp('(^|[^\\p{L}\\p{N}])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u').test(hay);
  const named = owners.find((o) => word(norm(o.short)) || word(norm(o.name)));
  if (named) return named.short;
  for (const lbl in ownerRules) {
    if (lbl && hay.includes(lbl) && exists(ownerRules[lbl])) return ownerRules[lbl]; // learned labels are pre-normalized
  }
  for (const [lbl, short] of BUILTIN_OWNERS) {
    if (hay.includes(lbl) && exists(short)) return short;
  }
  return '';
}

/** app.js:349 — explicit attribution wins, else heuristic. */
export function ownerOfTx(t, owners, ownerRules) {
  return t.owner !== undefined && t.owner !== '' ? t.owner : detectOwner(t, owners, ownerRules);
}

/** app.js appliedYears — les exercices dont le budget a été appliqué aux provisions. */
function appliedYears(charges) {
  return Object.keys(charges || {})
    .filter((y) => /^\d{4}$/.test(y) && charges[y] && charges[y].applied)
    .map(Number)
    .sort((a, b) => a - b);
}
/** app.js ledgerYear — l'exercice du dû : le dernier budget appliqué, sinon l'année civile. */
export function ledgerYear(charges, now = new Date()) {
  const ys = appliedYears(charges);
  return ys.length ? ys[ys.length - 1] : now.getFullYear();
}
/** app.js appliedDue — la part de chacun figée à l'application (`applied.byOwner`, clé = id du
 *  copropriétaire). L'app recalcule un budget appliqué avant cette colonne ; ici, sans charges.js,
 *  il compte 0 jusqu'à ce qu'un admin rouvre l'app (backfillAppliedByOwner). */
function appliedDue(o, b) {
  const bo = (b && b.applied && b.applied.byOwner) || {};
  const r = bo[o.id] || bo[o.short];
  return r ? Number(r.pay || 0) + Number(r.res || 0) : 0;
}
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * app.js ownerLedger — le grand livre par copropriétaire, borné à l'exercice du dû (kept 1:1).
 *   report = versements d'avant l'exercice − dû des exercices appliqués d'avant
 *   solde  = report + versé de l'exercice − dû de l'exercice
 * Sans budget appliqué avant l'exercice, les versements antérieurs comptent entiers (rien ne dit
 * ce qui était dû) : c'est l'ancien calcul « versé cumulé − dû », à l'identique.
 * @param {Record<string, any>} [charges]  ls_settings.charges (budgets par exercice)
 * @returns Array<{short,name,year,due,verse,report,solde,...}>
 */
export function ownerLedger(owners, transactions, ownerRules, charges = {}, now = new Date()) {
  // Les brouillons sont exclus : un relevé déposé mais pas encore validé n'est pas de l'argent
  // reçu. Le compter effacerait l'alerte « impayé » d'un copropriétaire sur la foi d'un import
  // que le syndic peut encore écarter.
  const alive = transactions.filter((t) => !t.deleted_at && !t.draft);
  const y = ledgerYear(charges, now), from = `${y}-01-01`, to = `${y}-12-31`, prevEnd = `${y - 1}-12-31`;
  const prior = appliedYears(charges).filter((k) => k < y);
  const total = (rows) => rows.reduce((a, t) => a + Number(t.amount), 0);
  return owners.map((o) => {
    const due = Number(o.due_pay || 0) + Number(o.due_res || 0);
    const mine = alive.filter((t) => Number(t.amount) > 0 && ownerOfTx(t, owners, ownerRules) === o.short);
    // tx_date vide : antérieure à tout, comme dans l'app (parseDate qui échoue → iso '').
    const verse = total(mine.filter((t) => { const d = String(t.tx_date || ''); return d >= from && d <= to; }));
    const before = total(mine.filter((t) => String(t.tx_date || '') <= prevEnd));
    const report = round2(before - prior.reduce((a, k) => a + appliedDue(o, charges[k]), 0));
    return { ...o, year: y, due, verse, report, solde: round2(report + verse - due) };
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Accept ISO 'YYYY-MM-DD' or display 'DD/MM/YY(YY)' → ISO, else undefined.
function toIsoDate(v) {
  const s = String(v || '');
  if (ISO_DATE.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return undefined;
  let y = +m[3];
  if (y < 100) y += 2000;
  return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}

/**
 * Build the alert list Jarvis expects (docs/08-lazysyndic-bridge.md §1).
 * @param {{owners:any[], transactions:any[], reminders?:any[], timeline?:any[], ownerRules?:Record<string,string>, charges?:Record<string,any>}} data
 * @param {{now?:Date, documentWindowDays?:number}} [opts]
 * @returns Array<{id,kind,title,detail?,amountCents?,dueDate?}>
 */
export function buildAlerts(data, opts = {}) {
  const { owners = [], transactions = [], reminders = [], timeline = [], ownerRules = {}, charges = {} } = data;
  const now = opts.now || new Date();
  const documentWindowDays = opts.documentWindowDays ?? 60;
  const alerts = [];

  // 1) Impayés — late owners (solde < −0.005), one stable alert per owner.
  for (const o of ownerLedger(owners, transactions, ownerRules, charges, now)) {
    if (o.solde < -0.005) {
      alerts.push({
        id: `pay-${o.id || o.short}`,
        kind: 'overdue_payment',
        title: `Impayé — ${o.name || o.short} : ${eur(-o.solde)} en attente`,
        detail: `Exercice ${o.year} · dû ${eur(o.due)} · versé ${eur(o.verse)}${Math.abs(o.report) >= 0.005 ? ` · report ${o.report < 0 ? '−' : '+'}${eur(Math.abs(o.report))}` : ''}`,
        amountCents: Math.round(-o.solde * 100),
      });
    }
  }

  // 2) Avis — open reminders (pense-bête not done).
  for (const r of reminders) {
    if (r.done) continue;
    const title = String(r.tx || '').trim();
    if (!title) continue;
    const dueDate = toIsoDate(r.due);
    alerts.push({
      id: `rem-${r.id}`,
      kind: 'notice',
      title: `Rappel — ${title}`,
      ...(dueDate ? { dueDate } : {}),
    });
  }

  // 3) Documents — recent timeline entries (journal). Heuristic window; tune via
  //    documentWindowDays. Skips imports/tasks noise, keeps manual document events.
  const cutoff = new Date(now.getTime() - documentWindowDays * 86400000);
  for (const e of timeline) {
    if (e.kind && e.kind !== 'manual') continue; // only manual journal entries as "documents"
    const iso = toIsoDate(e.date);
    if (iso && new Date(iso) < cutoff) continue;
    const title = String(e.title || '').trim();
    if (!title) continue;
    alerts.push({
      id: `tl-${e.id}`,
      kind: 'document',
      title: `Document — ${title}`,
      ...(e.description ? { detail: String(e.description).trim() } : {}),
      ...(iso ? { dueDate: iso } : {}),
    });
  }

  // 4) Synchro bancaire — une connexion qui expire en silence arrête la synchro sans bruit.
  alerts.push(...bankAlerts(data.bankLinks || [], now));

  return alerts;
}

const dayFr = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

/**
 * Avis sur la synchro bancaire (ls_bank_links, du plus récent au plus ancien) :
 *  - connexion active qui expire dans moins de 14 jours → la renouveler ;
 *  - connexion active en échec depuis plus de 36 h → regarder l'erreur ;
 *  - dernière connexion expirée, sans connexion active ni demande en cours → la synchro est arrêtée.
 * Une connexion déconnectée volontairement (revoked) ou remplacée ne dit rien.
 */
export function bankAlerts(links, now = new Date()) {
  const list = Array.isArray(links) ? links : [];
  const t = now.getTime();
  const active = list.find((l) => l.status === 'active');
  if (active) {
    const out = [];
    const until = active.valid_until ? Date.parse(active.valid_until) : NaN;
    if (Number.isFinite(until) && until - t < 14 * 86400000) {
      out.push({
        id: `bank-renew-${active.id}`, kind: 'notice',
        title: `Synchro bancaire — reconnecter ${active.aspsp_name || 'la banque'} avant le ${dayFr(active.valid_until)}`,
        detail: 'Le consentement donné à la banque arrive à échéance ; ensuite, plus aucun mouvement n’arrive dans LazySyndic.',
        dueDate: String(active.valid_until).slice(0, 10),
      });
    }
    // Une erreur passagère se rattrape à la synchro suivante : on ne parle qu'au-delà de 36 h
    // sans synchro réussie (depuis la mise en service, si aucune n'a jamais réussi).
    const okAt = Date.parse(active.last_ok_at || active.created_at || '');
    if (active.error && Number.isFinite(okAt) && t - okAt > 36 * 3600000) {
      out.push({ id: `bank-error-${active.id}`, kind: 'notice', title: 'Synchro bancaire en échec', detail: String(active.error).slice(0, 300) });
    }
    return out;
  }
  const pending = list.some((l) => ['requested', 'auth_ready', 'code_received'].includes(l.status));
  const latest = list.find((l) => l.status !== 'error' && l.status !== 'requested' && l.status !== 'auth_ready');
  if (!pending && latest && latest.status === 'expired') {
    return [{
      id: `bank-expired-${latest.id}`, kind: 'notice',
      title: `Synchro bancaire arrêtée — connexion ${latest.aspsp_name || ''} expirée`.replace(/\s+—/, ' —').trim(),
      detail: 'Reconnectez la banque dans LazySyndic › Import › Synchronisation bancaire.',
    }];
  }
  return [];
}

/**
 * The mapping backlog Jarvis's monthly routine needs.
 *
 * A line lands from the import with `high = '?'` — LazySyndic's marker for « À catégoriser ».
 * So "the mapping is finished" has an exact definition here, and only here: no transaction
 * left at '?'. Jarvis used to keep its own uncategorised copy of the statement and guess from
 * label regexes, because nothing exposed this.
 *
 * Pure on purpose: the I/O lives in supabase.js, the rule lives here and is testable.
 *
 * @param {Array<{tx_date?: string, high?: string, sub?: string, tiers?: string, note?: string, amount?: number, created_at?: string, draft?: boolean}>} rows
 *        Non-deleted ls_transactions rows, drafts included — they are what is still pending.
 */
export function coproStatus(rows) {
  const all = Array.isArray(rows) ? rows : [];
  // Un relevé importé attend d'être validé avant d'entrer dans les comptes. Tant qu'il est là, il
  // reste du travail : `unmapped` compte donc les lignes sans catégorie ET les lignes en attente
  // de validation, même déjà catégorisées. C'est ce compteur que Jarvis lit pour décider si
  // l'étape de la routine peut se fermer, et la réponse est non dans les deux cas.
  const pendingValidation = all.filter((t) => t.draft);
  const unmapped = all.filter((t) => t.draft || !t.high || t.high === '?');
  const dates = unmapped.map((t) => t.tx_date).filter(Boolean).sort();
  const imported = all.map((t) => t.created_at).filter(Boolean).sort();
  // What was actually paid over the last two months — bills settle for the previous period, so
  // one month alone would miss them.
  //
  // By CATEGORY, not by supplier name. On real imported rows the name is nowhere to be found:
  // a Swan export has no dedicated counterparty column, so mapCols() copies the description into
  // `tiers`, and both fields end up holding the bank's own wording ("SEPA Credit Transfer",
  // "Account subscription", a structured communication). The category, on the other hand, is
  // exactly what the user assigns when mapping — and it survives a change of supplier, which has
  // already happened here (Engie resiliated, moved to Electrabel). "L'électricité est payée" is
  // the question being asked; "Engie a été payé" only ever approximated it.
  const cutoff = new Date(Date.now() - 62 * 86400000).toISOString().slice(0, 10);
  // Les brouillons sont exclus : « l'électricité est payée » se lit dans les comptes, et un relevé
  // non validé n'y est pas encore. Le cocher sur la foi d'un import ferait sauter l'étape.
  const outflows = all.filter((t) => !t.draft && Number(t.amount) < 0 && String(t.tx_date || '') >= cutoff);
  const seen = new Set();
  const paidCategories = [];
  for (const t of outflows) {
    const high = String(t.high || '').trim();
    const sub = String(t.sub || '').trim();
    if (!high || high === '?') continue;
    const key = `${high}\u0000${sub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    paidCategories.push({ high, sub });
  }
  // Le texte brut reste exposé : il ne sert plus à cocher, mais à diagnostiquer un relevé dont
  // les libellés ne ressemblent à rien.
  const paidRecently = [
    ...new Set(
      outflows.map((t) => `${String(t.tiers || '').trim()} ${String(t.note || '').trim()}`.trim()).filter(Boolean),
    ),
  ];
  return {
    total: all.length,
    /** Lignes qui demandent encore quelque chose : sans catégorie, ou en attente de validation. */
    unmapped: unmapped.length,
    /** Dont celles d'un relevé importé mais pas encore validé. */
    pendingValidation: pendingValidation.length,
    /** Oldest movement still waiting — says how far back the backlog goes. */
    oldestUnmappedDate: dates[0] ?? null,
    /** Most recent line created, i.e. when a statement was last imported. */
    lastImportAt: imported[imported.length - 1] ?? null,
    paidCategories,
    paidRecently,
  };
}
