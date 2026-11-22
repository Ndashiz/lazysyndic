-- LazySyndic — le dû de chaque exercice
-- À lancer une fois dans Supabase (SQL Editor). Rejouable sans risque.
--
-- Les provisions en vigueur (ls_owners.due_pay / due_res) ne disent pas à quel exercice elles se
-- rapportent : dès qu'on applique le budget de l'année suivante, celui de l'année en cours était
-- perdu. La colonne garde, par exercice, ce que chaque copropriétaire devait :
--   { "2026": { "<clé du copropriétaire>": { "pay": 952.63, "res": 240 }, … }, "2027": { … } }
-- L'app la tient à jour toute seule : à chaque modification du dû, avant d'appliquer un nouveau
-- budget, et à la clôture d'un exercice (son dû est alors figé). Lue par le suivi des versements
-- de l'écran Comptabilité.

alter table public.ls_settings add column if not exists dues_by_year jsonb default '{}'::jsonb;

-- Contrôle : doit renvoyer une ligne.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'ls_settings' and column_name = 'dues_by_year';
