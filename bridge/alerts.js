// LazySyndic → Jarvis bridge — pure alert-building logic.
// Ported faithfully from app.js (norm / detectOwner / verseFromTx / ownerLedger)
// so the bridge's "impayés" match exactly what the dashboard shows.
// No external dependencies; unit-tested in alerts.test.js.

/** app.js:48 — lowercase, collapse whitespace, trim. */
export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Display euro amount, fr-BE style, deterministic (no ICU dependency). */
export const eur = (n) => `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} €`;

// app.js:303 — built-in label→owner hints (only applied if that owner exists).
const BUILTIN_OWNERS = [
  ['charge rdc et garage', 'Simon'],
  ['charge garage', 'Simon'],
  ['charge retard', 'Simon'],
  ['ndizeye', 'Peng'], ['fei', 'Peng'],
  ['aude', 'Aude'],
];

/**
 * app.js:314 detectOwner — heuristic owner attribution from a transaction's
 * tiers+note, used only when the tx has no explicit `owner`.
 * @param {{tiers?:string, note?:string}} t
 * @param {Array<{short:string, name?:string}>} owners
 * @param {Record<string,string>} ownerRules  normalized-label → owner short
 */
export function detectOwner(t, owners, ownerRules = {}) {
  const hay = norm(`${t.tiers || ''} ${t.note || ''}`);
  for (const lbl in ownerRules) {
    if (lbl && hay.includes(lbl)) return ownerRules[lbl]; // learned labels are pre-normalized
  }
  const exists = (short) => owners.some((o) => o.short === short);
  for (const [lbl, short] of BUILTIN_OWNERS) {
    if (hay.includes(lbl) && exists(short)) return short;
  }
  const o = owners.find((o) => hay.includes(norm(o.short)) || (o.name && hay.includes(norm(o.name))));
  return o ? o.short : '';
}

/** app.js:349 — explicit attribution wins, else heuristic. */
export function ownerOfTx(t, owners, ownerRules) {
  return t.owner !== undefined && t.owner !== '' ? t.owner : detectOwner(t, owners, ownerRules);
}

/**
 * app.js:357 ownerLedger — per-owner due (persisted provisions) vs verse
 * (sum of positive transactions attributed to them). solde = verse − due.
 * @returns Array<{short,name,due,verse,solde,...}>
 */
export function ownerLedger(owners, transactions, ownerRules) {
  const alive = transactions.filter((t) => !t.deleted_at);
  return owners.map((o) => {
    const due = Number(o.due_pay || 0) + Number(o.due_res || 0);
    const verse = alive
      .filter((t) => Number(t.amount) > 0 && ownerOfTx(t, owners, ownerRules) === o.short)
      .reduce((a, t) => a + Number(t.amount), 0);
    return { ...o, due, verse, solde: verse - due };
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
 * @param {{owners:any[], transactions:any[], reminders?:any[], timeline?:any[], ownerRules?:Record<string,string>}} data
 * @param {{now?:Date, documentWindowDays?:number}} [opts]
 * @returns Array<{id,kind,title,detail?,amountCents?,dueDate?}>
 */
export function buildAlerts(data, opts = {}) {
  const { owners = [], transactions = [], reminders = [], timeline = [], ownerRules = {} } = data;
  const now = opts.now || new Date();
  const documentWindowDays = opts.documentWindowDays ?? 60;
  const alerts = [];

  // 1) Impayés — late owners (solde < −0.005), one stable alert per owner.
  for (const o of ownerLedger(owners, transactions, ownerRules)) {
    if (o.solde < -0.005) {
      alerts.push({
        id: `pay-${o.id || o.short}`,
        kind: 'overdue_payment',
        title: `Impayé — ${o.name || o.short} : ${eur(-o.solde)} en attente`,
        detail: `Dû ${eur(o.due)} · versé ${eur(o.verse)}`,
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

  return alerts;
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
 * @param {Array<{tx_date?: string, high?: string, sub?: string, tiers?: string, note?: string, amount?: number, created_at?: string}>} rows
 *        Non-deleted ls_transactions rows.
 */
export function coproStatus(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const unmapped = all.filter((t) => !t.high || t.high === '?');
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
  const outflows = all.filter((t) => Number(t.amount) < 0 && String(t.tx_date || '') >= cutoff);
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
    unmapped: unmapped.length,
    /** Oldest movement still waiting — says how far back the backlog goes. */
    oldestUnmappedDate: dates[0] ?? null,
    /** Most recent line created, i.e. when a statement was last imported. */
    lastImportAt: imported[imported.length - 1] ?? null,
    paidCategories,
    paidRecently,
  };
}
