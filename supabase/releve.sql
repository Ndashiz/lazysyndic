-- ============================================================
--  LazySyndic — relevé de compte PDF : titulaire de chaque compte
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque.
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : seule la table ls_settings
--  (déjà sous RLS : lecture = membres, écriture = syndic) est touchée.
-- ============================================================

-- holders = {"pay": "ACP …", "res": "ACP …"} : le titulaire imprimé sur le relevé PDF,
-- saisi dans la fiche du compte (écran Comptes). Sans cette colonne, l'app reprend le
-- titulaire lu sur le dernier relevé bancaire importé, sinon le nom de la copropriété ;
-- seule la saisie manuelle du titulaire échoue (message « lancez supabase/releve.sql »).
alter table public.ls_settings add column if not exists holders jsonb default '{}'::jsonb;
