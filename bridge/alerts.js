// LazySyndic → Jarvis bridge — pure alert-building logic.
// Ported faithfully from app.js (norm / detectOwner / verseFromTx / ownerLedger / duesOf) and
// calls.js (expectedToDate) so the bridge's "impayés" match exactly what the dashboard shows.
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
 * tiers+note, used only when the tx has no explicit `owner`. Order: 0. the owner's structured
 * communication, when the label carries a valid one; 1. learned rule on the
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
  // 0. structured communication (+++123/4567/89012+++) set by LazySyndic on each fund call: deterministic, wins.
  const og = /(?:\+{3}|\*{3})?\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*(?:\+{3}|\*{3})?/.exec(`${t.tiers || ''} ${t.note || ''}`);
  if (og) {
    const d = og[1] + og[2] + og[3], r = Number(d.slice(0, 10)) % 97;
    if (d.slice(10) === String(r === 0 ? 97 : r).padStart(2, '0')) {
      const byOgm = owners.find((o) => String(o.ogm || '').replace(/\D/g, '') === d);
      if (byOgm) return byOgm.short;
    }
  }
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
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Le jour civil du syndic (app.js todayISO, lu dans son navigateur). Le pont tourne en UTC sur le
 * VPS : sans fuseau, l'échéance d'un mois et le changement d'exercice basculeraient une ou deux
 * heures plus tard que dans l'app.
 */
export function todayIso(now = new Date(), timeZone = 'Europe/Brussels') {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(now).map((x) => [x.type, x.value]),
    );
    if (p.year && p.month && p.day) return `${p.year}-${p.month}-${p.day}`;
  } catch { /* fuseau inconnu de ce Node : date locale du serveur */ }
  const two = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

// calls.js PERIODS / cleanPeriodicity — nombre d'échéances par an ; rythme inconnu : mensuel.
const PERIOD_N = { month: 12, quarter: 4, year: 1 };
/** calls.js schedule — le dû annuel réparti en échéances au centime (le reste sur les premières),
 *  dues le 1er du mois qui ouvre leur période : janvier, avril, juillet, octobre pour un trimestre. */
function schedule(annual, periodicity) {
  const n = PERIOD_N[periodicity] || 12, total = Math.round((Number(annual) || 0) * 100);
  const base = Math.floor(total / n), rest = total - base * n;
  return Array.from({ length: n }, (_, i) => ({ month: 1 + i * (12 / n), amount: (base + (i < rest ? 1 : 0)) / 100 }));
}
/**
 * calls.js expectedToDate (kept 1:1, alerts.test.js compare les deux) — ce qui est attendu d'un
 * copropriétaire à une date : une échéance compte une fois son mois TERMINÉ. En avril, trois
 * mensualités sont attendues ; celle d'avril le sera le 1er mai. Exercice passé : tout ; à venir : rien.
 */
export function expectedToDate(annual, periodicity, year, today) {
  return round2(echues(annual, periodicity, year, today).reduce((s, e) => s + e.amount, 0));
}
/** Les échéances échues à une date (leur nombre ne dépend que du rythme, pas du montant). */
function echues(annual, periodicity, year, today) {
  const rows = schedule(annual, periodicity), y = String(year), t = String(today || '');
  const ty = t.slice(0, 4), tm = Number(t.slice(5, 7)) || 0;
  return ty > y ? rows : ty < y ? [] : rows.filter((e) => e.month < tm);
}

const filled = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0;
/** app.js ownerKey — la clé d'un copropriétaire dans dues_by_year et applied.byOwner. */
const ownerKey = (o) => String(o.id || o.short || '');
// Les budgets appliqués avant l'arrivée des identifiants rangent encore leur part par nom court.
const dueRow = (dues, o) => { const r = dues[ownerKey(o)] || dues[o.short] || {}; return { pay: Number(r.pay) || 0, res: Number(r.res) || 0 }; };

/**
 * app.js ownerLedger — le grand livre par copropriétaire pour un exercice, par défaut l'année
 * civile en cours (kept 1:1 : ownerLedger / ownerYear / ownerReport / duesOf / duesYear).
 *
 * Le dû est celui DE l'exercice, pas les provisions du moment (app.js duesOf) :
 *   1. exercice clôturé (ls_periods.closed_at) : le dû figé dans ls_settings.dues_by_year ;
 *   2. exercice des provisions en vigueur (l'année en cours, ou l'exercice ultérieur dont le
 *      budget est déjà appliqué) : ls_owners.due_pay / due_res ;
 *   3. sinon dues_by_year, sinon la part figée à l'application du budget (applied.byOwner) ;
 *   4. sinon inconnu : dû 0, `dueKnown` false.
 *
 *   versé   = entrées validées attribuées au copropriétaire, datées de l'exercice, sur les deux
 *             comptes de l'ACP (pay, res) — un mouvement « hors comptes » (ext) n'en est pas un
 *   report  = solde laissé par les exercices précédents dont le dû est connu, 0 sinon
 *   solde   = report + versé − dû de l'année : ce qui reste à recevoir d'ici la fin de l'exercice
 *   attendu = les échéances échues à ce jour, selon le rythme de chacun (expectedToDate)
 *   retard  = attendu − versé − report, s'il est positif : ce qui devrait déjà être payé
 *
 * « En retard » se dit du retard, jamais du solde : en cours d'année le solde est négatif pour
 * tout le monde, puisqu'il reste des échéances à venir. Le seuil (0,99 €) est celui de l'app.
 *
 * @param {{owners?:any[], transactions?:any[], ownerRules?:Record<string,string>,
 *          charges?:Record<string,any>, duesByYear?:Record<string,any>, periods?:any[]}} data
 *        charges = budgets par exercice ; duesByYear = ls_settings.dues_by_year ;
 *        periods = ls_periods (year, closed_at).
 * @param {{now?:Date, year?:number}} [opts]
 * @returns Array<{short,name,year,due,dueKnown,verse,report,expected,echeances,retard,enRetard,solde,...}>
 *          `echeances` (propre au pont) = le nombre d'échéances échues : il date l'alerte « impayé ».
 */
export function ownerLedger(data = {}, opts = {}) {
  const { owners = [], transactions = [], ownerRules = {} } = data;
  const charges = data.charges || {}, duesByYear = data.duesByYear || {}, periods = data.periods || [];
  const today = todayIso(opts.now || new Date());
  const yearNow = Number(today.slice(0, 4)), y = Number(opts.year) || yearNow;

  const applied = appliedYears(charges);
  const duesYear = Math.max(yearNow, applied.length ? applied[applied.length - 1] : 0);
  const closed = (k) => periods.some((p) => Number(p.year) === k && p.closed_at);
  const duesNow = Object.fromEntries(owners.map((o) => [ownerKey(o), { pay: round2(o.due_pay), res: round2(o.due_res) }]));
  const duesOf = (k) => {
    const rec = duesByYear[k];
    if (closed(k) && filled(rec)) return rec;      // clôturé : le dû figé fait foi
    if (k === duesYear) return duesNow;            // l'exercice des provisions en vigueur
    if (filled(rec)) return rec;
    const b = charges[k];
    return b && b.applied && filled(b.applied.byOwner) ? b.applied.byOwner : null;
  };

  // Les brouillons sont exclus : un relevé déposé mais pas encore validé n'est pas de l'argent
  // reçu. Le compter effacerait l'alerte « impayé » d'un copropriétaire sur la foi d'un import
  // que le syndic peut encore écarter.
  const paidBy = new Map();   // nom court → [{iso, account, amount}]
  for (const t of transactions) {
    if (t.deleted_at || t.draft || !(Number(t.amount) > 0)) continue;
    if (t.account !== 'pay' && t.account !== 'res') continue;
    const short = ownerOfTx(t, owners, ownerRules);
    if (!short) continue;
    if (!paidBy.has(short)) paidBy.set(short, []);
    // tx_date vide : dans aucun exercice, comme dans l'app (parseDate qui échoue → iso '').
    paidBy.get(short).push({ iso: String(t.tx_date || '').slice(0, 10), account: t.account, amount: Number(t.amount) });
  }
  /** app.js ownerYear — versé et dû sur un exercice, compte par compte. due = null : dû inconnu. */
  const ownerYear = (o, k) => {
    const dues = duesOf(k), from = `${k}-01-01`, to = `${k}-12-31`;
    const paid = (acct) => round2((paidBy.get(o.short) || [])
      .reduce((a, t) => a + (t.account === acct && t.iso >= from && t.iso <= to ? t.amount : 0), 0));
    return { due: dues ? dueRow(dues, o) : null, paid: { pay: paid('pay'), res: paid('res') } };
  };
  /** app.js ownerReport — retard (négatif) ou avance (positif) laissés par les exercices
   *  précédents, en remontant tant que leur dû est connu. null si le précédent ne l'est pas. */
  const ownerReport = (o) => {
    let r = 0, n = 0;
    for (let k = y - 1; k >= 2000 && n < 30; k--) {
      const s = ownerYear(o, k);
      if (!s.due) break;
      r += s.paid.pay + s.paid.res - (s.due.pay + s.due.res);
      n++;
    }
    return n ? round2(r) : null;
  };

  return owners.map((o) => {
    const s = ownerYear(o, y), rep = ownerReport(o);
    const duePay = s.due ? s.due.pay : 0, dueRes = s.due ? s.due.res : 0, due = round2(duePay + dueRes);
    const verse = round2(s.paid.pay + s.paid.res), report = rep === null ? 0 : rep;
    const expected = round2(expectedToDate(duePay, o.periodicity, y, today) + expectedToDate(dueRes, o.periodicity, y, today));
    const retard = Math.max(0, round2(expected - verse - report));
    return {
      ...o, year: y, duePay, dueRes, due, dueKnown: !!s.due, versePay: s.paid.pay, verseRes: s.paid.res, verse,
      report, reportKnown: rep !== null, expected, echeances: echues(0, o.periodicity, y, today).length,
      retard, enRetard: retard > 0.99, solde: round2(report + verse - due),
    };
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
 * @param {{owners:any[], transactions:any[], reminders?:any[], timeline?:any[], ownerRules?:Record<string,string>, charges?:Record<string,any>, duesByYear?:Record<string,any>, periods?:any[], bankLinks?:any[]}} data
 * @param {{now?:Date, documentWindowDays?:number}} [opts]
 * @returns Array<{id,kind,title,detail?,amountCents?,dueDate?}>
 */
export function buildAlerts(data, opts = {}) {
  const { reminders = [], timeline = [] } = data;
  const now = opts.now || new Date();
  const documentWindowDays = opts.documentWindowDays ?? 60;
  const alerts = [];

  // 1) Impayés — un copropriétaire EN RETARD : des échéances échues restent impayées. Le reste à
  //    verser de l'exercice (solde négatif) n'est pas un impayé.
  //    L'identifiant porte l'exercice et le nombre d'échéances échues : Jarvis ne garde qu'une
  //    alerte par identifiant et ne la met jamais à jour. Avec un identifiant par copropriétaire,
  //    un retard réglé puis revenu, ou qui grossit d'une échéance, ne serait plus jamais signalé.
  //    Stable tant qu'aucune nouvelle échéance n'échoit : pas de doublon d'un passage à l'autre.
  for (const o of ownerLedger(data, { now })) {
    if (o.enRetard) {
      alerts.push({
        id: `pay-${o.id || o.short}-${o.year}-${o.echeances}`,
        kind: 'overdue_payment',
        title: `Impayé — ${o.name || o.short} : ${eur(o.retard)} en retard`,
        detail: `Exercice ${o.year} · attendu à ce jour ${eur(o.expected)} (sur ${eur(o.due)} pour l'année) · versé ${eur(o.verse)}${Math.abs(o.report) >= 0.005 ? ` · report ${o.report < 0 ? '−' : '+'}${eur(Math.abs(o.report))}` : ''}`,
        amountCents: Math.round(o.retard * 100),
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
