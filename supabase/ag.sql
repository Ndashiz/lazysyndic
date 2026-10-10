-- ============================================================
--  LazySyndic — assemblées générales : convocation par e-mail + PV signé
--  (signature via Dokobit, offre gratuite)
--  À lancer À LA MAIN, une fois, dans le SQL Editor Supabase.
--  Idempotent : relançable sans risque.
--
--  Le projet Supabase est PARTAGÉ avec LazyPO : tout ce qui suit
--  est préfixé ls_ / scoped sur le bucket 'ls-docs'.
-- ============================================================

-- 0. E-mail des copropriétaires (convocations, invitations Dokobit).
--    Lisible par les membres comme le reste de ls_owners ; modifiable par le syndic.
alter table public.ls_owners add column if not exists email text;

-- 1. Bureau de séance + suivi de signature, sur l'AG elle-même
--    bureau    = {president: <short du copropriétaire>, secretaire: <nom>}
--    signature = {status, pv:{path, sha256, size, at, signers}, signed:{…}}
alter table public.ls_ag add column if not exists bureau    jsonb not null default '{}'::jsonb;
alter table public.ls_ag add column if not exists signature jsonb not null default '{}'::jsonb;

-- ls_ag / ls_ag_points n'ont jamais été dans schema.sql : on aligne leur RLS
-- sur le reste de l'app (lecture = membres, écriture = syndic). Ne retire rien :
-- une éventuelle policy existante sous un autre nom resterait — voir §4.
do $$
declare t text;
begin
  foreach t in array array['ls_ag','ls_ag_points'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I_read on public.%I;', t, t);
    execute format('drop policy if exists %I_write on public.%I;', t, t);
    execute format('create policy %I_read on public.%I for select using ((select public.ls_is_member()));', t, t);
    execute format('create policy %I_write on public.%I for all using ((select public.ls_is_admin())) with check ((select public.ls_is_admin()));', t, t);
  end loop;
end $$;

-- 2. Chronologie : nouveau type d'événement « sign » (PV signé)
alter table public.ls_timeline drop constraint if exists ls_timeline_kind_check;
alter table public.ls_timeline add constraint ls_timeline_kind_check
  check (kind in ('manual','import','task','sign'));

-- 3. Bucket PRIVÉ pour les PV (à signer + signés) — PDF uniquement, 20 Mo max
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ls-docs', 'ls-docs', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- lecture : tout membre LazySyndic (les copropriétaires récupèrent le PV signé) ;
-- écriture : le syndic seulement.
drop policy if exists ls_docs_read   on storage.objects;
drop policy if exists ls_docs_insert on storage.objects;
drop policy if exists ls_docs_update on storage.objects;
drop policy if exists ls_docs_delete on storage.objects;
create policy ls_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'ls-docs' and (select public.ls_is_member()));
create policy ls_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ls-docs' and (select public.ls_is_admin()));
create policy ls_docs_update on storage.objects for update to authenticated
  using (bucket_id = 'ls-docs' and (select public.ls_is_admin()))
  with check (bucket_id = 'ls-docs' and (select public.ls_is_admin()));
create policy ls_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ls-docs' and (select public.ls_is_admin()));

-- 4. Vérification (lecture seule) — à relire après exécution :
--    a) aucune policy de storage.objects ne doit être ouverte SANS filtre de bucket
--       (sinon un utilisateur LazyPO pourrait lire les PV) ;
--    b) ls_ag / ls_ag_points : seulement *_read / *_write.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where (schemaname = 'storage' and tablename = 'objects')
   or (schemaname = 'public'  and tablename in ('ls_ag','ls_ag_points'))
order by tablename, policyname;
