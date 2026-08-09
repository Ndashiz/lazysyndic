// Thin PostgREST client for the bridge. Uses the service_role key (server-side
// only — bypasses RLS) so the bridge can read the ls_* tables without a user
// session. Zero dependencies: Node 22's global fetch.

/**
 * @param {string} url  Supabase project URL (https://xxxx.supabase.co)
 * @param {string} serviceRoleKey  Supabase service_role key (SECRET — server only)
 */
export function createRest(url, serviceRoleKey) {
  const base = String(url || '').replace(/\/$/, '');
  if (!base || !serviceRoleKey) throw new Error('supabase_not_configured');
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  /** GET a table with an optional PostgREST query (e.g. "select=*&deleted_at=is.null"). */
  async function select(table, query = 'select=*') {
    const res = await fetch(`${base}/rest/v1/${table}?${query}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase_${table}_http_${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return res.json();
  }

  /** Fetch exactly the columns the alert builder needs, in parallel. */
  async function loadForAlerts() {
    const [owners, transactions, settingsRows, reminders, timeline] = await Promise.all([
      select('ls_owners', 'select=id,short,name,quotite,color,due_pay,due_res,sort'),
      select('ls_transactions', 'select=tx_date,tiers,note,amount,account,owner,deleted_at,draft&deleted_at=is.null'),
      select('ls_settings', 'select=owner_rules&id=eq.1'),
      select('ls_reminders', 'select=id,tx,due,done'),
      // ls_timeline is optional (may not be migrated yet) — tolerate a 404-ish empty.
      select('ls_timeline', 'select=id,event_date,title,description,kind').catch(() => []),
    ]);
    const settings = settingsRows[0] || {};
    return {
      owners: (owners || []).sort((a, b) => (a.sort || 0) - (b.sort || 0)),
      transactions: transactions || [],
      reminders: reminders || [],
      timeline: (timeline || []).map((r) => ({
        id: r.id, date: r.event_date, title: r.title, description: r.description, kind: r.kind || 'manual',
      })),
      ownerRules: settings.owner_rules || {},
    };
  }

  /** Rows the mapping backlog is computed from (the rule itself lives in alerts.js). */
  async function loadCoproRows() {
    return (await select('ls_transactions', 'select=tx_date,high,sub,tiers,note,amount,created_at,deleted_at,draft&deleted_at=is.null')) || [];
  }

  /**
   * Ce que la page de garde calcule (dashboard.js) : le référentiel copro, les mouvements avec
   * leur compte ET leur catégorie, le pense-bête, et les paramètres (soldes d'ouverture, objectif
   * de réserve) — sans lesquels un solde n'est qu'une somme de mouvements.
   */
  async function loadForDashboard() {
    const [owners, transactions, settingsRows, reminders] = await Promise.all([
      select('ls_owners', 'select=id,short,name,quotite,color,due_pay,due_res,sort'),
      select('ls_transactions', 'select=tx_date,tiers,note,amount,account,high,owner,deleted_at,draft&deleted_at=is.null'),
      // `copro_name` a été ajoutée après coup : sur un déploiement qui n'a pas la colonne,
      // PostgREST répond 400 sur toute la requête. On retombe sur les colonnes du schéma
      // d'origine plutôt que de faire échouer la page entière pour un titre.
      select('ls_settings', 'select=opening_pay,opening_res,reserve_target,owner_rules,copro_name&id=eq.1').catch(() =>
        select('ls_settings', 'select=opening_pay,opening_res,reserve_target,owner_rules&id=eq.1'),
      ),
      select('ls_reminders', 'select=id,tx,due,done,sort'),
    ]);
    const settings = (settingsRows || [])[0] || {};
    return {
      owners: (owners || []).sort((a, b) => (a.sort || 0) - (b.sort || 0)),
      transactions: transactions || [],
      reminders: (reminders || []).sort((a, b) => (a.sort || 0) - (b.sort || 0)),
      settings,
      // Les mêmes règles apprises que pour les alertes : sans elles, un versement attribué à la
      // main dans LazySyndic redeviendrait « non attribué » ici, et le tableau « qui paie quoi »
      // contredirait l'alerte « impayé » construite sur les mêmes lignes.
      ownerRules: settings.owner_rules || {},
    };
  }

  return { select, loadForAlerts, loadCoproRows, loadForDashboard };
}
