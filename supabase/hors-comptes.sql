-- LazySyndic — mouvements « hors comptes de l'ACP »
-- À lancer une fois dans Supabase (SQL Editor). Rejouable sans risque.
--
-- Une dépense de l'immeuble payée ailleurs que sur les comptes de l'ACP (l'assurance incendie
-- réglée directement à l'assureur, par exemple) entre dans ls_transactions avec account = 'ext'.
-- Elle compte dans la comptabilité, dans sa catégorie ; aucun solde, rapprochement, relevé ni
-- budget ne la lit, puisque tout cela filtre sur 'pay' ou 'res'.
--
-- La colonne n'acceptait que 'pay' et 'res' : on élargit sa contrainte. Rien d'autre ne change
-- (droits, verrou des exercices clôturés, index).

do $$
declare c record;
begin
  -- la contrainte d'origine porte un nom donné par Postgres : on retire celle(s) qui parlent du compte
  for c in
    select conname from pg_constraint
    where conrelid = 'public.ls_transactions'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%account%'
  loop
    execute format('alter table public.ls_transactions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.ls_transactions
  add constraint ls_transactions_account_check check (account in ('pay','res','ext'));

-- Contrôle : doit renvoyer la contrainte avec les trois valeurs.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.ls_transactions'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%account%';
