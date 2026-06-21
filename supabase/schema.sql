-- ============================================================
--  LazySyndic — schéma Supabase (Postgres)
--  ⚠️ PROJET PARTAGÉ AVEC LAZYPO : toutes les tables, fonctions et
--  politiques sont préfixées « ls_ » et ce script est ADDITIF —
--  il ne touche RIEN de l'existant (pas de profiles, pas de trigger
--  sur auth.users). À exécuter dans Supabase → SQL Editor.
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
--  1. MEMBRES & RÔLES (liste blanche LazySyndic)
--  L'auth (auth.users) est partagée avec LazyPO. Seuls les
--  utilisateurs présents dans ls_members ont accès aux données
--  de la copro — un compte LazyPO quelconque ne voit rien.
-- ============================================================
create table if not exists public.ls_members (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  owner_short text,                                   -- lien vers ls_owners.short
  role        text not null default 'read'
              check (role in ('admin','read')),
  created_at  timestamptz not null default now()
);
alter table public.ls_members enable row level security;

create or replace function public.ls_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.ls_members where id = auth.uid()), false);
$$;
create or replace function public.ls_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ls_members where id = auth.uid());
$$;

drop policy if exists ls_members_read on public.ls_members;
drop policy if exists ls_members_self on public.ls_members;   -- supprimée : empêchait pas l'auto-élévation de rôle
-- Lecture seule pour le client. AUCUNE policy d'écriture : ls_members (rôles)
-- est géré exclusivement côté serveur (SQL editor / service role). Sans cela,
-- un membre « read » pouvait se mettre role='admin' sur sa propre ligne.
create policy ls_members_read on public.ls_members for select using (id = auth.uid() or public.ls_is_admin());

-- ============================================================
--  2. RÉFÉRENTIEL COPRO
-- ============================================================
create table if not exists public.ls_owners (
  id       uuid primary key default gen_random_uuid(),
  short    text not null,
  name     text not null,
  quotite  int  not null,
  color    text default '#2F6B53',
  due      numeric(12,2) default 0,
  verse    numeric(12,2) default 0,
  sort     int default 0
);
create table if not exists public.ls_lots (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  designation text,
  quotite     int not null,
  parcelle    text,
  owner_id    uuid references public.ls_owners(id) on delete set null
);

-- ============================================================
--  3. TRANSACTIONS (cœur)
-- ============================================================
create table if not exists public.ls_transactions (
  id         uuid primary key default gen_random_uuid(),
  tx_date    date not null,
  tiers      text not null,
  high       text,
  sub        text,
  amount     numeric(12,2) not null,       -- signé : + entrée, − sortie
  account    text not null check (account in ('pay','res')),
  note       text,
  flag       boolean default false,
  comment    text,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ls_transactions_date_idx on public.ls_transactions(tx_date);
create index if not exists ls_transactions_account_idx on public.ls_transactions(account);

-- ============================================================
--  4. RÈGLES, ALIAS, CONTRATS, RAPPELS
-- ============================================================
create table if not exists public.ls_rules (
  id uuid primary key default gen_random_uuid(),
  label text not null, high text not null, sub text, sort int default 0
);
create table if not exists public.ls_aliases (
  id uuid primary key default gen_random_uuid(),
  label text not null, entity text not null, is_owner boolean default false, short text, sort int default 0
);
create table if not exists public.ls_contracts (
  id uuid primary key default gen_random_uuid(),
  name text not null, ref text, type text, start text, note text,
  status text default 'actif' check (status in ('actif','cloture')),
  end_date text, end_note text, sort int default 0
);
create table if not exists public.ls_reminders (
  id uuid primary key default gen_random_uuid(),
  tx text not null, due text, done boolean default false, sort int default 0
);

-- ============================================================
--  5. PARAMÈTRES (singleton) & HISTORIQUE D'IMPORTS
-- ============================================================
create table if not exists public.ls_settings (
  id             int primary key default 1 check (id = 1),
  opening_pay    numeric(12,2) default 0,
  opening_res    numeric(12,2) default 0,
  reserve_target numeric(12,2) default 2000,
  contrib        jsonb default '{}'::jsonb,
  iban_map       jsonb default '{}'::jsonb,   -- IBAN normalisé → 'pay' | 'res'
  ledger_live    boolean default false
);
insert into public.ls_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.ls_imports (
  id uuid primary key default gen_random_uuid(),
  v int, label text, meta text, cur boolean default false,
  created_at timestamptz not null default now()
);

-- ============================================================
--  6. RLS — lecture = membres invités, écriture = admin
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'ls_owners','ls_lots','ls_transactions','ls_rules','ls_aliases',
    'ls_contracts','ls_reminders','ls_settings','ls_imports'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I_read on public.%I;', t, t);
    execute format('drop policy if exists %I_write on public.%I;', t, t);
    execute format('create policy %I_read on public.%I for select using (public.ls_is_member());', t, t);
    execute format('create policy %I_write on public.%I for all using (public.ls_is_admin()) with check (public.ls_is_admin());', t, t);
  end loop;
end $$;

-- ============================================================
--  7. APRÈS AVOIR INVITÉ LES 3 COPROPRIÉTAIRES
--  (Authentication → Users → Invite user, pour chaque email)
--  Exécuter en remplaçant les emails — fixe les rôles LazySyndic
--  sans dépendre d'aucun trigger :
-- ============================================================
-- insert into public.ls_members (id, email, full_name, role, owner_short)
--   select id, email, 'Alex Martin', 'admin', 'Alex' from auth.users where email='EMAIL_SIMON'
--   on conflict (id) do update set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;
-- insert into public.ls_members (id, email, full_name, role, owner_short)
--   select id, email, 'Sam Bernard', 'read', 'Sam' from auth.users where email='EMAIL_PENG'
--   on conflict (id) do update set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;
-- insert into public.ls_members (id, email, full_name, role, owner_short)
--   select id, email, 'Lou Petit', 'read', 'Lou' from auth.users where email='EMAIL_AUDE'
--   on conflict (id) do update set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;

-- ============================================================
--  8. (OPTIONNEL) Amorçage du référentiel propriétaires/lots.
--  Personnalisez les noms ici, OU faites-le ensuite dans l'app
--  (côté admin). Laissé en commentaire pour ne rien imposer.
-- ============================================================
-- insert into public.ls_owners (short,name,quotite,color,due,verse,sort) values
--   ('Alex','Alex Martin',500,'#2F6B53',1002,1002,1),
--   ('Sam','Sam Bernard',251,'#5B4B86',503,503,2),
--   ('Lou','Lou Petit',249,'#C9854A',499,344.90,3);
-- update public.ls_settings set opening_pay=1358.70, opening_res=358.62 where id=1;
