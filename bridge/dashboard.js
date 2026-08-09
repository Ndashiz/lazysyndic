// LazySyndic → Jarvis bridge — la page de garde, telle qu'elle est calculée dans l'app.
//
// Jarvis affichait de LazySyndic une boîte d'alertes et un compteur de mapping : deux choses
// que la copropriété ne montre nulle part sous cette forme. Ouvrir « LazySyndic » dans Jarvis
// et ouvrir LazySyndic donnaient deux images différentes du même immeuble.
//
// Ce module porte les dérivations de l'écran #dash (app.js : balance / receivables /
// ownerLedger / donutData + la bannière fonds de réserve) pour que Jarvis lise LES MÊMES
// chiffres au lieu d'en inventer de proches. Les règles restent ici, pures et testables ;
// les I/O vivent dans supabase.js.
//
// Les montants sortent en CENTIMES entiers : c'est la convention `…Cents` de Jarvis, celle
// que son mode démo sait masquer et que son front sait formater.

import { ownerLedger } from './alerts.js';

/** app.js:52 CAT_META — catégorie haut niveau → couleur du donut. */
const CAT_COLORS = {
  'Énergie': '#2F6B53',
  'Assurance': '#C9854A',
  'Frais ACP': '#C2564A',
  'Entretien': '#7BA98E',
  'Charges': '#2F6B53',
  'Fonds de réserve': '#5B4B86',
};
const FALLBACK_COLOR = '#999999';

/** Arrondi au centime — `0.1 + 0.2` en euros ne doit pas devenir 30.000000000000004 centimes. */
const cents = (n) => Math.round(Number(n || 0) * 100);

/**
 * Les mouvements qui comptent : ni supprimés, ni en brouillon.
 *
 * app.js tient les deux à l'écart de `state.tx` (les brouillons vivent dans `state.draftTx`),
 * donc ils ne pèsent sur aucun solde là-bas non plus. Compter un relevé déposé mais pas encore
 * validé ferait bouger le solde affiché dans Jarvis sans qu'il ait bougé dans LazySyndic.
 */
const alive = (transactions) => (transactions || []).filter((t) => !t.deleted_at && !t.draft);

/** app.js:243 balance — solde d'ouverture du compte + tous ses mouvements. */
export function balanceCents(transactions, account, openingByAccount = {}) {
  const opening = cents(openingByAccount[account]);
  return alive(transactions)
    .filter((t) => t.account === account)
    .reduce((sum, t) => sum + cents(t.amount), opening);
}

/**
 * app.js:251 donutData — répartition des SORTIES par catégorie haut niveau, sur un compte.
 * Les lignes encore à catégoriser (`high` vide ou '?') sont regroupées telles quelles :
 * les cacher donnerait un camembert à 100 % qui ne couvre pas toutes les dépenses.
 */
export function expenseBreakdown(transactions, account, opts = {}) {
  const uncategorisedLabel = opts.uncategorisedLabel || 'À catégoriser';
  const out = alive(transactions).filter((t) => t.account === account && Number(t.amount) < 0);
  const by = new Map();
  for (const t of out) {
    const raw = String(t.high || '').trim();
    const high = !raw || raw === '?' ? uncategorisedLabel : raw;
    by.set(high, (by.get(high) || 0) + Math.abs(cents(t.amount)));
  }
  const totalCents = [...by.values()].reduce((a, b) => a + b, 0);
  const categories = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([high, amountCents]) => ({
      high,
      amountCents,
      // Même arrondi que le conic-gradient de l'app : les parts peuvent ne pas faire 100.
      pct: totalCents > 0 ? Math.round((amountCents / totalCents) * 100) : 0,
      color: CAT_COLORS[high] || FALLBACK_COLOR,
    }));
  return { totalCents, categories };
}

/** Le pense-bête : ouverts d'abord, triés par échéance (app.js:480 renderReminders). */
export function reminderBoard(reminders = []) {
  const open = reminders
    .filter((r) => !r.done && String(r.tx || '').trim())
    .sort((a, b) => String(a.due || '￿').localeCompare(String(b.due || '￿')))
    .map((r) => ({
      id: String(r.id),
      text: String(r.tx).trim(),
      ...(r.due ? { due: String(r.due) } : {}),
    }));
  return { open, openCount: open.length, doneCount: reminders.filter((r) => r.done).length };
}

/**
 * La page de garde de LazySyndic, en une lecture.
 *
 * @param {{owners?:any[], transactions?:any[], reminders?:any[], settings?:any,
 *          ownerRules?:Record<string,string>}} data
 * @returns Le même immeuble que l'écran #dash : réserve, soldes, qui paie quoi, pense-bête,
 *          répartition des dépenses.
 */
export function buildDashboard(data = {}) {
  const { owners = [], transactions = [], reminders = [], settings = {}, ownerRules = {} } = data;

  const opening = { pay: settings.opening_pay, res: settings.opening_res };
  const payCents = balanceCents(transactions, 'pay', opening);
  const resCents = balanceCents(transactions, 'res', opening);

  // app.js:357 ownerLedger — le pont le partage déjà avec les alertes « impayé », donc la
  // ligne rouge du tableau et l'alerte du même copropriétaire ne peuvent pas diverger.
  const ledger = ownerLedger(owners, transactions, ownerRules);
  const ownerRows = ledger.map((o) => {
    const balanceCts = cents(o.solde);
    return {
      short: String(o.short || ''),
      name: String(o.name || o.short || ''),
      quotite: Number(o.quotite || 0),
      color: String(o.color || '#2F6B53'),
      dueCents: cents(o.due),
      paidCents: cents(o.verse),
      balanceCents: balanceCts,
      // app.js:430 — le seuil est en euros là-bas (−0,005), soit un demi-centime ici.
      late: balanceCts < 0,
    };
  });

  // app.js:246 receivables — « à recevoir » = ce que doivent les copropriétaires débiteurs.
  const receivableCents = ownerRows
    .filter((o) => o.balanceCents < 0)
    .reduce((sum, o) => sum + -o.balanceCents, 0);

  const targetCents = cents(settings.reserve_target);
  const dates = alive(transactions)
    .map((t) => String(t.tx_date || ''))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  return {
    coproName: String(settings.copro_name || '').trim() || 'Ma copropriété',
    /** Dernier mouvement enregistré — dit jusqu'où les soldes sont à jour. */
    lastMovementDate: dates[dates.length - 1] ?? null,
    reserve: {
      currentCents: resCents,
      targetCents,
      remainingCents: Math.max(0, targetCents - resCents),
      // app.js:2379 — plafonné à 100 : une réserve au-delà de l'objectif ne déborde pas la jauge.
      pct: targetCents > 0 ? Math.min(100, Math.round((resCents / targetCents) * 100)) : 0,
    },
    balances: {
      payCents,
      resCents,
      receivableCents,
      // app.js n'affiche pas encore de « à payer » calculé (la case est à 0). Le champ existe
      // pour que Jarvis n'ait pas à inventer la case le jour où LazySyndic la remplira.
      payableCents: 0,
    },
    owners: ownerRows,
    reminders: reminderBoard(reminders),
    // Le donut de la page de garde porte sur le COMPTE DE PAIEMENT (app.js:442).
    expenses: expenseBreakdown(transactions, 'pay'),
  };
}
