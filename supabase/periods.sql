-- ============================================================
--  LazySyndic — exercices comptables : clôture et verrouillage
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque. Repris dans migrations/000_baseline.sql (§8 bis).
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : rien hors préfixe ls_.
-- ============================================================

-- Un exercice = une année civile. Clôturé (closed_at posé), il fige ses soldes d'ouverture et
-- de clôture, le rapport financier tel qu'approuvé, et ses lignes : le trigger plus bas refuse
-- toute écriture qui changerait un mouvement validé daté dans un exercice clôturé (montant, date,
-- compte, catégorie, tiers, attribution, suppression, validation d'un brouillon). Seules les
-- annotations (drapeau, commentaire) restent libres. Rouvrir = remettre closed_at à null.
create table if not exists public.ls_periods (
  year           int primary key check (year between 2000 and 2100),
  starts         date not null,
  ends           date not null,
  closed_at      timestamptz,
  closed_by      uuid references auth.users(id),
  opening_pay    numeric(12,2),
  opening_res    numeric(12,2),
  closing_pay    numeric(12,2),
  closing_res    numeric(12,2),
  approved_ag_id uuid references public.ls_ag(id) on delete set null,
  report_html    text,          -- le rapport financier figé à la clôture (HTML des rapports de l'app)
  note           text,
  created_at     timestamptz not null default now()
);
alter table public.ls_periods enable row level security;
drop policy if exists ls_periods_read  on public.ls_periods;
drop policy if exists ls_periods_write on public.ls_periods;
create policy ls_periods_read  on public.ls_periods for select using ((select public.ls_is_member()));
create policy ls_periods_write on public.ls_periods for all using ((select public.ls_is_admin())) with check ((select public.ls_is_admin()));

-- Une date tombe-t-elle dans un exercice clôturé ?
create or replace function public.ls_period_closed(d date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ls_periods p where p.closed_at is not null and d between p.starts and p.ends);
$$;

-- La vraie barrière : l'interface masque les gestes, la base les refuse.
create or replace function public.ls_guard_closed_period()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if not coalesce(old.draft, false) and public.ls_period_closed(old.tx_date) then
      raise exception 'Exercice clôturé : le mouvement du % ne peut plus être supprimé', old.tx_date using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if not coalesce(new.draft, false) and public.ls_period_closed(new.tx_date) then
      raise exception 'Exercice clôturé : impossible d''ajouter un mouvement au %', new.tx_date using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE : une ligne validée d'un exercice clôturé ne change que ses annotations
  if (not coalesce(old.draft, false) and public.ls_period_closed(old.tx_date))
     or (not coalesce(new.draft, false) and public.ls_period_closed(new.tx_date)) then
    if new.tx_date is distinct from old.tx_date or new.amount is distinct from old.amount
       or new.account is distinct from old.account or new.high is distinct from old.high
       or new.sub is distinct from old.sub or new.tiers is distinct from old.tiers
       or new.note is distinct from old.note or new.owner is distinct from old.owner
       or new.draft is distinct from old.draft or new.deleted_at is distinct from old.deleted_at
       or new.import_v is distinct from old.import_v then
      raise exception 'Exercice clôturé : le mouvement du % ne peut plus être modifié (seuls le drapeau et le commentaire restent libres)', old.tx_date using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ls_transactions_closed_period on public.ls_transactions;
create trigger ls_transactions_closed_period
  before insert or update or delete on public.ls_transactions
  for each row execute function public.ls_guard_closed_period();
