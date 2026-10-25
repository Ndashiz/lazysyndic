-- ============================================================
--  LazySyndic — fiche de la copropriété : nom, adresse, numéro d'entreprise (BCE / TVA)
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque.
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : seule la table ls_settings
--  (déjà sous RLS : lecture = membres, écriture = syndic) est touchée.
-- ============================================================

-- Saisis dans Budget & copropriétaires › Copropriétaires & lots › « Copropriété » ; repris en
-- tête des rapports, de l'Annexe 4 et des relevés. db.js les lisait déjà (copro_name, copro_addr,
-- copro_kbo) : sans ces colonnes, la saisie échoue avec le message « lancez supabase/budget.sql ».
alter table public.ls_settings add column if not exists copro_name text;
alter table public.ls_settings add column if not exists copro_addr text;
alter table public.ls_settings add column if not exists copro_kbo  text;   -- numéro d'entreprise, ex. BE 0123.456.789
