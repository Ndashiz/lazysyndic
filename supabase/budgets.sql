-- ============================================================
--  LazySyndic — budgets prévisionnels : une ligne par exercice, brouillon du seul syndic,
--  verrou après publication (revue d'octobre 2026 : D3, B5, B6)
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque. Repris dans migrations/000_baseline.sql (§8 ter).
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : rien hors préfixe ls_.
-- ============================================================

-- Avant : ls_settings.charges, un seul jsonb pour tous les exercices, réécrit en entier à chaque
-- poste modifié et lu par tout membre, brouillons compris. Désormais une ligne par exercice :
--   • lecture : un copropriétaire ne reçoit que les budgets publiés — c'est la RLS, pas l'écran ;
--   • écriture : le syndic, et seulement tant que c'est un brouillon. Un budget publié ne change
--     plus (postes, réserve, marge, instantané), sauf à le repasser en brouillon ; s'il est appliqué
--     aux provisions (le dû de chacun en vient), le repasser en brouillon annule l'application
--     dans le même geste, sinon la base refuse ;
--   • instantané : à la publication, l'app fige les copropriétaires (clé, nom, quotité) et la base
--     du minimum légal du moment ; l'Annexe 4, la répartition et le dû à appliquer s'y tiennent,
--     quoi qu'il arrive ensuite aux quotités. Posé une fois, il ne change plus.
create table if not exists public.ls_budgets (
  year          int primary key check (year between 2000 and 2100),
  status        text not null default 'draft' check (status in ('draft','published')),
  postes        jsonb not null default '[]'::jsonb,   -- [{id,label,vendor,cat,key,forecast,realFormula,fcFormula,fcNote}]
  reserve       jsonb not null default '[]'::jsonb,   -- [{id,label,amount,months,key,start}]
  marge         numeric(5,2) not null default 3,       -- % appliqué aux estimations par formule
  applied       jsonb,                                 -- {at,total,reserve,byOwner:{clé:{pay,res}}} : appliqué aux provisions
  approved      jsonb,                                 -- {agId,agTitle,date,point} : approuvé par l'AG
  snapshot      jsonb,                                 -- {at,owners:[{key,n,short,q}],legalBasis,legalBase:[]} figé à la publication
  published_at  timestamptz,
  published_by  uuid references auth.users(id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
alter table public.ls_budgets enable row level security;
drop policy if exists ls_budgets_read  on public.ls_budgets;
drop policy if exists ls_budgets_write on public.ls_budgets;
-- Un brouillon n'existe que pour le syndic ; un budget publié se lit comme le reste (membres).
create policy ls_budgets_read  on public.ls_budgets for select
  using ((select public.ls_is_admin()) or (status = 'published' and (select public.ls_is_member())));
create policy ls_budgets_write on public.ls_budgets for all
  using ((select public.ls_is_admin())) with check ((select public.ls_is_admin()));

-- La vraie barrière : l'interface fige les champs, la base refuse l'écriture.
create or replace function public.ls_guard_budget()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    return old;   -- la suppression reste libre : seule la restauration d'une sauvegarde l'emploie
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, auth.uid());
    end if;
    return new;
  end if;
  -- UPDATE d'un budget publié
  if old.status = 'published' then
    if new.status = 'draft' then
      if new.applied is not null then
        raise exception 'Budget % appliqué aux provisions : annulez l''application pour le repasser en brouillon', old.year using errcode = 'check_violation';
      end if;
      -- repasser en brouillon : tout redevient libre, l'instantané, la date et l'approbation tombent
      new.snapshot := null; new.published_at := null; new.published_by := null; new.approved := null;
      return new;
    end if;
    if new.postes is distinct from old.postes or new.reserve is distinct from old.reserve
       or new.marge is distinct from old.marge
       or (old.snapshot is not null and new.snapshot is distinct from old.snapshot)
       or new.published_at is distinct from old.published_at or new.published_by is distinct from old.published_by then
      raise exception 'Budget % publié : postes, réserve, marge et instantané ne changent plus (repassez-le en brouillon)', old.year using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- brouillon → publié : horodaté ici, quoi que l'app ait envoyé
  if new.status = 'published' then
    new.published_at := coalesce(new.published_at, now());
    new.published_by := auth.uid();
  end if;
  return new;
end $$;
drop trigger if exists ls_budgets_guard on public.ls_budgets;
create trigger ls_budgets_guard
  before insert or update or delete on public.ls_budgets
  for each row execute function public.ls_guard_budget();

-- Reprise de l'existant : chaque exercice de ls_settings.charges devient une ligne (un budget
-- appliqué est publié de fait), puis la colonne est vidée — sinon les brouillons y resteraient
-- lisibles par tout membre. Relançable : un exercice déjà en table n'est pas touché.
insert into public.ls_budgets (year, status, postes, reserve, marge, applied, approved, published_at)
select (e.key)::int,
       case when e.value->>'status' = 'published' or jsonb_typeof(e.value->'applied') = 'object' then 'published' else 'draft' end,
       case when jsonb_typeof(e.value->'postes') = 'array' then e.value->'postes' else '[]'::jsonb end,
       case when jsonb_typeof(e.value->'reserve') = 'array' then e.value->'reserve' else '[]'::jsonb end,
       case when (e.value->>'marge') ~ '^\d+(\.\d+)?$' then (e.value->>'marge')::numeric else 3 end,
       case when jsonb_typeof(e.value->'applied') = 'object' then e.value->'applied' end,
       case when jsonb_typeof(e.value->'approved') = 'object' then e.value->'approved' end,
       case when (e.value->>'publishedAt') ~ '^\d{4}-\d{2}-\d{2}' then (e.value->>'publishedAt')::timestamptz end
from public.ls_settings s, jsonb_each(coalesce(s.charges, '{}'::jsonb)) e
where s.id = 1 and e.key ~ '^\d{4}$' and jsonb_typeof(e.value) = 'object'
on conflict (year) do nothing;
update public.ls_settings set charges = '{}'::jsonb where id = 1 and charges <> '{}'::jsonb;
