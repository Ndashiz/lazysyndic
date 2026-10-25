-- ============================================================
--  LazySyndic — calcul des charges : budget prévisionnel par poste
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque.
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : seule la table ls_settings
--  (déjà sous RLS : lecture = membres, écriture = syndic) est touchée.
-- ============================================================

-- charges = { "2026": { "postes": [ { "id", "label", "cat": {"high","sub"} | null,
--                                     "key": "quote" | "indiv", "forecast" } ],
--                       "reserve": [ { "id", "label", "amount", "months", "key", "start": "2026-01" } ],
--                       "applied": { "at", "total", "reserve" } } }
-- Écran Budget & copropriétaires › Calcul des charges. Sans cette colonne, l'écran
-- s'affiche mais rien ne s'enregistre (message « lancez supabase/charges.sql »).
alter table public.ls_settings add column if not exists charges jsonb default '{}'::jsonb;
