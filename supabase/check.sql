-- ============================================================
--  LazySyndic — vérification du schéma (LECTURE SEULE)
--  À coller tel quel dans Supabase → SQL Editor, après migrations/000_baseline.sql.
--  Une seule requête ; les anomalies sortent EN PREMIER (section en MAJUSCULES).
--
--  Sur une base complète, le résultat doit contenir :
--    • AUCUNE ligne « TABLE MANQUANTE », « COLONNE MANQUANTE », « BUCKET MANQUANT »,
--      « FONCTION MANQUANTE », « TRIGGER MANQUANT » ni « RLS DÉSACTIVÉE » ;
--    • section « colonne » : les 16 tables ls_* et leurs colonnes (la liste attendue
--      ci-dessous = la définition de 000_baseline.sql, vérifiée par tests/schema.test.mjs) ;
--    • section « policy » : ls_<table>_read + ls_<table>_write pour les 13 tables de données
--      (ls_owners, ls_lots, ls_transactions, ls_rules, ls_aliases, ls_contracts, ls_reminders,
--      ls_settings, ls_imports, ls_timeline, ls_ag, ls_ag_points, ls_periods), ls_members_read seule
--      (jamais d'écriture côté client), ls_invites_admin, ls_bank_links_admin (syndic seul,
--      lecture comprise), et sur storage.objects :
--      ls_docs_read / ls_docs_insert / ls_docs_update / ls_docs_delete ;
--    • section « bucket » : ls-docs, privé, 20971520 o, application/pdf ;
--    • section « fonction » : ls_is_admin, ls_is_member (boolean), ls_provision_member (trigger) ;
--    • section « trigger » : ls_on_auth_user_created et ls_transactions_closed_period, actifs.
--  Rien d'autre n'est listé : le projet est partagé, seul le préfixe ls_ nous regarde.
-- ============================================================
with attendu_tables(t) as (values
  ('ls_members'), ('ls_owners'), ('ls_lots'), ('ls_transactions'), ('ls_rules'), ('ls_aliases'),
  ('ls_contracts'), ('ls_reminders'), ('ls_settings'), ('ls_imports'), ('ls_timeline'),
  ('ls_ag'), ('ls_ag_points'), ('ls_periods'), ('ls_invites'), ('ls_bank_links')
),
attendu_colonnes(t, c) as (values
  ('ls_members','id'), ('ls_members','email'), ('ls_members','full_name'), ('ls_members','owner_short'),
  ('ls_members','role'), ('ls_members','created_at'),
  ('ls_owners','id'), ('ls_owners','short'), ('ls_owners','name'), ('ls_owners','quotite'), ('ls_owners','color'),
  ('ls_owners','due'), ('ls_owners','verse'), ('ls_owners','sort'), ('ls_owners','email'),
  ('ls_owners','due_pay'), ('ls_owners','due_res'),
  ('ls_lots','id'), ('ls_lots','label'), ('ls_lots','designation'), ('ls_lots','quotite'), ('ls_lots','parcelle'),
  ('ls_lots','owner_id'),
  ('ls_transactions','id'), ('ls_transactions','tx_date'), ('ls_transactions','tiers'), ('ls_transactions','high'),
  ('ls_transactions','sub'), ('ls_transactions','amount'), ('ls_transactions','account'), ('ls_transactions','note'),
  ('ls_transactions','flag'), ('ls_transactions','comment'), ('ls_transactions','created_by'),
  ('ls_transactions','created_at'), ('ls_transactions','owner'), ('ls_transactions','deleted_at'),
  ('ls_transactions','draft'), ('ls_transactions','import_v'), ('ls_transactions','bank_ref'),
  ('ls_rules','id'), ('ls_rules','label'), ('ls_rules','high'), ('ls_rules','sub'), ('ls_rules','sort'),
  ('ls_aliases','id'), ('ls_aliases','label'), ('ls_aliases','entity'), ('ls_aliases','is_owner'),
  ('ls_aliases','short'), ('ls_aliases','sort'),
  ('ls_contracts','id'), ('ls_contracts','name'), ('ls_contracts','ref'), ('ls_contracts','type'),
  ('ls_contracts','start'), ('ls_contracts','note'), ('ls_contracts','status'), ('ls_contracts','end_date'),
  ('ls_contracts','end_note'), ('ls_contracts','fournisseur'), ('ls_contracts','sort'),
  ('ls_reminders','id'), ('ls_reminders','tx'), ('ls_reminders','due'), ('ls_reminders','done'), ('ls_reminders','sort'),
  ('ls_settings','id'), ('ls_settings','opening_pay'), ('ls_settings','opening_res'), ('ls_settings','reserve_target'),
  ('ls_settings','contrib'), ('ls_settings','iban_map'), ('ls_settings','subcats'), ('ls_settings','ledger_live'),
  ('ls_settings','holders'), ('ls_settings','charges'), ('ls_settings','copro_name'), ('ls_settings','copro_addr'),
  ('ls_settings','copro_kbo'), ('ls_settings','recon'), ('ls_settings','owner_rules'), ('ls_settings','iban_pay'),
  ('ls_settings','iban_res'), ('ls_settings','categories'), ('ls_settings','annual_note'), ('ls_settings','budget_keys'),
  ('ls_imports','id'), ('ls_imports','v'), ('ls_imports','label'), ('ls_imports','meta'), ('ls_imports','cur'),
  ('ls_imports','created_at'), ('ls_imports','stmt'), ('ls_imports','pending'),
  ('ls_timeline','id'), ('ls_timeline','event_date'), ('ls_timeline','title'), ('ls_timeline','description'),
  ('ls_timeline','kind'), ('ls_timeline','subs'), ('ls_timeline','created_by'), ('ls_timeline','created_at'),
  ('ls_ag','id'), ('ls_ag','title'), ('ls_ag','type'), ('ls_ag','ag_date'), ('ls_ag','lieu'), ('ls_ag','status'),
  ('ls_ag','convocation_date'), ('ls_ag','presence'), ('ls_ag','bureau'), ('ls_ag','signature'), ('ls_ag','created_at'),
  ('ls_ag_points','id'), ('ls_ag_points','ag_id'), ('ls_ag_points','pos'), ('ls_ag_points','title'),
  ('ls_ag_points','body'), ('ls_ag_points','kind'), ('ls_ag_points','majorite'), ('ls_ag_points','cle'),
  ('ls_ag_points','votes'), ('ls_ag_points','seance_notes'), ('ls_ag_points','decision'), ('ls_ag_points','created_at'),
  ('ls_periods','year'), ('ls_periods','starts'), ('ls_periods','ends'), ('ls_periods','closed_at'), ('ls_periods','closed_by'),
  ('ls_periods','opening_pay'), ('ls_periods','opening_res'), ('ls_periods','closing_pay'), ('ls_periods','closing_res'),
  ('ls_periods','approved_ag_id'), ('ls_periods','report_html'), ('ls_periods','note'), ('ls_periods','created_at'),
  ('ls_invites','email'), ('ls_invites','role'), ('ls_invites','owner_short'), ('ls_invites','full_name'),
  ('ls_bank_links','id'), ('ls_bank_links','status'), ('ls_bank_links','aspsp_name'), ('ls_bank_links','aspsp_country'),
  ('ls_bank_links','psu_type'), ('ls_bank_links','redirect_url'), ('ls_bank_links','state'), ('ls_bank_links','auth_url'),
  ('ls_bank_links','code'), ('ls_bank_links','session_id'), ('ls_bank_links','valid_until'), ('ls_bank_links','accounts'),
  ('ls_bank_links','acct_map'), ('ls_bank_links','seen'), ('ls_bank_links','sync_requested_at'), ('ls_bank_links','last_sync_at'),
  ('ls_bank_links','last_ok_at'), ('ls_bank_links','last_sync'), ('ls_bank_links','error'), ('ls_bank_links','created_by'),
  ('ls_bank_links','created_at'), ('ls_bank_links','updated_at')
),
presentes as (
  select table_name::text as t, column_name::text as c, data_type::text as data_type,
         column_default::text as column_default, is_nullable::text as is_nullable, ordinal_position
  from information_schema.columns
  where table_schema = 'public' and table_name like 'ls\_%'
),
lignes as (
  -- anomalies (ordre négatif = en tête du résultat)
  select -9 as ordre, 'TABLE MANQUANTE' as section, a.t as objet, null::text as nom,
         'lancer migrations/000_baseline.sql' as detail
  from attendu_tables a
  left join information_schema.tables i on i.table_schema = 'public' and i.table_name = a.t
  where i.table_name is null
  union all
  select -8, 'COLONNE MANQUANTE', a.t, a.c, 'lancer migrations/000_baseline.sql (add column if not exists)'
  from attendu_colonnes a
  left join presentes p on p.t = a.t and p.c = a.c
  where p.c is null
  union all
  select -7, 'BUCKET MANQUANT', 'storage.buckets', 'ls-docs', 'baseline §11'
  where not exists (select 1 from storage.buckets where id = 'ls-docs')
  union all
  select -6, 'FONCTION MANQUANTE', 'public', v.f, 'baseline §1 / §9'
  from (values ('ls_is_admin'), ('ls_is_member'), ('ls_provision_member')) as v(f)
  where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = v.f)
  union all
  select -5, 'TRIGGER MANQUANT', 'auth.users', 'ls_on_auth_user_created', 'baseline §9'
  where not exists (select 1 from pg_trigger where tgname = 'ls_on_auth_user_created')
  union all
  select -4, 'RLS DÉSACTIVÉE', c.relname::text, null, 'enable row level security manquant'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'ls\_%' and not c.relrowsecurity
  union all
  -- inventaire
  select 1, 'colonne', p.t, p.c,
         p.data_type
         || case when p.is_nullable = 'NO' then ' not null' else '' end
         || case when p.column_default is not null then ' default ' || p.column_default else '' end
  from presentes p
  union all
  select 2, 'policy', schemaname || '.' || tablename, policyname::text,
         cmd || ' · ' || array_to_string(roles, ',')
  from pg_policies
  where (schemaname = 'public'  and tablename like 'ls\_%')
     or (schemaname = 'storage' and tablename = 'objects' and policyname like 'ls\_docs\_%')
  union all
  select 3, 'bucket', 'storage.buckets', id::text,
         case when public then 'PUBLIC ⚠️ (doit être privé)' else 'privé' end
         || ' · ' || coalesce(file_size_limit::text, '?') || ' o · '
         || coalesce(array_to_string(allowed_mime_types, ','), '*')
  from storage.buckets where id = 'ls-docs'
  union all
  select 4, 'fonction', 'public', p.proname::text, pg_get_function_result(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('ls_is_admin', 'ls_is_member', 'ls_provision_member')
  union all
  select 5, 'trigger', 'auth.users', tgname::text,
         case when tgenabled = 'D' then 'DÉSACTIVÉ ⚠️' else 'actif' end
  from pg_trigger where tgname = 'ls_on_auth_user_created' and not tgisinternal
)
select section, objet, nom, detail
from lignes
order by ordre, section, objet, nom;
