-- ============================================================
--  LazySyndic — appels de fonds : communication structurée et périodicité par copropriétaire
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque. Repris dans migrations/000_baseline.sql (§2).
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : seule la table ls_owners (déjà sous RLS) est touchée.
-- ============================================================

-- ogm : la communication structurée belge du copropriétaire (12 chiffres, +++123/4567/89012+++),
-- posée une fois par LazySyndic et jamais recalculée : elle figure sur chaque appel de fonds et
-- rend l'attribution des virements déterministe (étape 0 de detectOwner, app et bridge).
alter table public.ls_owners add column if not exists ogm text;
-- periodicity : 'month' (défaut), 'quarter' ou 'year' — le rythme des appels et du suivi des paiements.
alter table public.ls_owners add column if not exists periodicity text default 'month';
