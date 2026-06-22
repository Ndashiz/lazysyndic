-- ============================================================
--  LazySyndic — auto-provisionnement des membres à l'inscription
--  À exécuter UNE FOIS (remplace les emails). Ensuite, dès qu'un
--  copropriétaire s'inscrit (lien magique), il est automatiquement
--  ajouté à ls_members avec son rôle + owner_short. Plus aucune
--  manipulation manuelle après coup.
--
--  ⚠️ Projet partagé avec LazyPO : le trigger ne fait RIEN pour les
--  emails non listés dans ls_invites (les comptes LazyPO ne sont pas
--  affectés). Sécurisé : security definer, jamais piloté par le client.
-- ============================================================

-- 1) Liste des invitations (qui sera quoi à l'inscription)
create table if not exists public.ls_invites (
  email       text primary key,
  role        text not null default 'read' check (role in ('admin','read')),
  owner_short text,
  full_name   text
);
alter table public.ls_invites enable row level security;
drop policy if exists ls_invites_admin on public.ls_invites;
create policy ls_invites_admin on public.ls_invites for all
  using (public.ls_is_admin()) with check (public.ls_is_admin());

-- 2) Pré-déclarer les copropriétaires  ⬅️ REMPLACE LES EMAILS
insert into public.ls_invites (email, role, owner_short, full_name) values
  ('goffin.simon@gmail.com', 'admin', 'Simon', 'Simon Goffin'),
  ('EMAIL_DE_PENG',          'read',  'Peng',  'Peng Ndizeye'),
  ('EMAIL_DE_AUDE',          'read',  'Aude',  'Aude De Changy')
on conflict (email) do update
  set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;

-- 3) Trigger : à l'inscription, si l'email est invité → créer le membre
create or replace function public.ls_provision_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare inv public.ls_invites%rowtype;
begin
  select * into inv from public.ls_invites where lower(email) = lower(new.email);
  if found then
    insert into public.ls_members (id, email, full_name, role, owner_short)
    values (new.id, new.email, coalesce(inv.full_name, new.email), inv.role, inv.owner_short)
    on conflict (id) do update
      set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;
  end if;
  return new;
end $$;

drop trigger if exists ls_on_auth_user_created on auth.users;
create trigger ls_on_auth_user_created
  after insert on auth.users
  for each row execute function public.ls_provision_member();

-- 4) Rattrapage : provisionne aussi ceux DÉJÀ inscrits (si Peng/Aude ont
--    déjà un compte). À lancer après l'étape 2.
insert into public.ls_members (id, email, full_name, role, owner_short)
select u.id, u.email, coalesce(i.full_name, u.email), i.role, i.owner_short
from auth.users u
join public.ls_invites i on lower(u.email) = lower(i.email)
on conflict (id) do update
  set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;
