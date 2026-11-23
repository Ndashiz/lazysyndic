-- LazySyndic — postes non prévus au budget
-- À lancer une fois dans Supabase (SQL Editor). Rejouable sans risque.
--
-- Un budget publié est figé (ls_budgets, trigger ls_guard_budget). Une dépense que personne
-- n'avait prévue en cours d'exercice se suit donc À CÔTÉ du budget voté, qui ne change pas :
--   { "2026": [ { "id": "p…", "label": "Réparation toiture", "cat": { "high": "Entretien", "sub": "Toiture" },
--                "note": "fuite d'avril", "at": "2026-04-03" }, … ] }
-- Pas de montant prévu : la catégorie de la comptabilité suffit, le dépensé vient des mouvements.
-- Lue par Comptabilité › Exercice en cours. Lecture par les membres, écriture par le syndic :
-- les règles de ls_settings s'appliquent telles quelles.

alter table public.ls_settings add column if not exists budget_extras jsonb default '{}'::jsonb;

-- Contrôle : doit renvoyer une ligne.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'ls_settings' and column_name = 'budget_extras';
