-- ============================================================
--  LazySyndic — schéma de référence (baseline) : UN script qui rejoue tout.
--
--  Reconstruit la base de production à neuf, ou remet à niveau une base
--  existante : chaque instruction est idempotente (create … if not exists,
--  add column if not exists, drop policy if exists puis create policy,
--  create or replace function, drop trigger if exists). Relançable sans risque.
--
--  ⚠️ PROJET PARTAGÉ (le projet Supabase héberge une autre app) :
--  rien hors préfixe ls_ — tables, fonctions, policies, index préfixés « ls_ »,
--  bucket « ls-docs ». Le script est ADDITIF : il ne touche RIEN de l'existant
--  (pas de profiles, pas d'autre trigger sur auth.users que le nôtre).
--
--  À exécuter À LA MAIN dans Supabase → SQL Editor, puis lancer ../check.sql
--  pour vérifier. Rien n'applique ce fichier automatiquement.
--
--  D'où vient chaque bloc :
--    §0  extensions                      ← schema.sql
--    §1  ls_members, ls_is_admin/member   ← schema.sql §1
--    §2  ls_owners, ls_lots               ← schema.sql §2 + ag.sql §0 (email)
--                                           + due_pay / due_res (lus et écrits par db.js /
--                                           app.js, jamais créés jusqu'ici)
--    §3  ls_transactions                  ← schema.sql §3
--    §4  ls_rules, ls_aliases, ls_contracts, ls_reminders ← schema.sql §4
--    §5  ls_settings                      ← schema.sql §5 + budget.sql + charges.sql + releve.sql
--                                           + recon / owner_rules / iban_pay / iban_res /
--                                           categories / annual_note / budget_keys (idem : utilisés
--                                           par db.js, créés nulle part)
--    §6  ls_imports                       ← schema.sql §5
--    §7  ls_timeline                      ← schema.sql §5 + ag.sql §2 (kind 'sign')
--    §8 bis ls_periods + trigger ls_transactions_closed_period ← periods.sql
--    §8  ls_ag, ls_ag_points              ← NOUVEAU : déduit de db.js (agCreate, agUpdate,
--                                           agPointAdd, agPointUpdate, loadAll) et d'app.js ;
--                                           bureau / signature ← ag.sql §1
--    §9  ls_invites + trigger             ← auto-provision.sql
--    §10 RLS (lecture = membres, écriture = syndic) ← schema.sql §6 + ag.sql §1
--    §11 bucket privé ls-docs + policies  ← ag.sql §3
--
--  Jamais de nom ni d'e-mail réel ici : le dépôt est public. Les exemples
--  (Alex Martin, Sam Bernard, Lou Petit, EMAIL_ADMIN…) sont fictifs.
-- ============================================================

-- ============================================================
--  0. EXTENSIONS
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
--  1. MEMBRES & RÔLES (liste blanche LazySyndic)
--  L'auth (auth.users) est partagée. Seuls les utilisateurs présents dans
--  ls_members ont accès aux données de la copro — un compte quelconque du
--  projet ne voit rien.
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
drop policy if exists ls_members_self on public.ls_members;   -- supprimée : n'empêchait pas l'auto-élévation de rôle
-- Lecture seule pour le client. AUCUNE policy d'écriture : ls_members (rôles)
-- est géré exclusivement côté serveur (SQL editor / service role / trigger §9).
-- Sans cela, un membre « read » pouvait se mettre role='admin' sur sa propre ligne.
-- Perf : un membre ne lit que SA propre ligne (pas de `or ls_is_admin()` qui
-- relançait une sous-requête récursive sur ls_members à chaque évaluation).
create policy ls_members_read on public.ls_members for select using (id = (select auth.uid()));

-- ============================================================
--  2. RÉFÉRENTIEL COPRO
-- ============================================================
create table if not exists public.ls_owners (
  id       uuid primary key default gen_random_uuid(),
  short    text not null,                 -- « Alex » : clé dans presence, votes, owner_rules, ls_members.owner_short
  name     text not null,
  quotite  int  not null,                 -- millièmes
  color    text default '#2F6B53',
  due      numeric(12,2) default 0,       -- HISTORIQUE : jamais lu par l'app (remplacé par due_pay / due_res) ;
  verse    numeric(12,2) default 0,       --   conservés pour ne pas diverger de la prod — ne pas réutiliser
  sort     int default 0,
  email    text,                          -- convocations, invitations Dokobit (ag.sql §0)
  due_pay  numeric(12,2) default 0,       -- dû — compte de paiement (provisions, « Appliquer aux provisions »)
  due_res  numeric(12,2) default 0        -- dû — compte de réserve
);
-- déploiements existants : ajoute les colonnes si absentes
alter table public.ls_owners add column if not exists email   text;
alter table public.ls_owners add column if not exists due_pay numeric(12,2) default 0;
alter table public.ls_owners add column if not exists due_res numeric(12,2) default 0;

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
  created_at timestamptz not null default now(),
  owner      text,                         -- copropriétaire attribué à la main (short)
  deleted_at timestamptz,                  -- corbeille (7 jours)
  draft      boolean default false,        -- brouillon d'import, hors grand livre
  import_v   int                           -- rattache la ligne à son relevé (ls_imports.v)
);
create index if not exists ls_transactions_date_idx    on public.ls_transactions(tx_date);
create index if not exists ls_transactions_account_idx on public.ls_transactions(account);

-- Colonnes ajoutées après coup sur les déploiements existants.
-- `owner` et `deleted_at` étaient déjà écrites et lues par db.js sans figurer dans le schéma :
-- un schéma rejoué à neuf donnait une base sur laquelle l'app plantait.
alter table public.ls_transactions add column if not exists owner      text;
alter table public.ls_transactions add column if not exists deleted_at timestamptz;
-- Un relevé importé n'entre pas dans les comptes tant qu'il n'a pas été vérifié : il arrive en
-- brouillon, se catégorise à tête reposée, et ne rejoint le grand livre qu'à la validation.
-- `import_v` rattache la ligne à son relevé, pour valider (ou jeter) un import d'un bloc.
alter table public.ls_transactions add column if not exists draft    boolean default false;
alter table public.ls_transactions add column if not exists import_v int;
create index if not exists ls_transactions_draft_idx on public.ls_transactions(draft) where draft;

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
  end_date text, end_note text, fournisseur text, sort int default 0
);
-- déploiements existants : ajoute la colonne si absente
alter table public.ls_contracts add column if not exists fournisseur text;
create table if not exists public.ls_reminders (
  id uuid primary key default gen_random_uuid(),
  tx text not null, due text, done boolean default false, sort int default 0
);

-- ============================================================
--  5. PARAMÈTRES (singleton id = 1)
--  Toutes les colonnes que db.js lit (loadAll) ou écrit (updateSettings).
-- ============================================================
create table if not exists public.ls_settings (
  id             int primary key default 1 check (id = 1),
  opening_pay    numeric(12,2) default 0,          -- solde d'ouverture, compte de paiement
  opening_res    numeric(12,2) default 0,          -- solde d'ouverture, compte de réserve
  reserve_target numeric(12,2) default 2000,
  contrib        jsonb default '{}'::jsonb,
  iban_map       jsonb default '{}'::jsonb,        -- IBAN normalisé → 'pay' | 'res' (appris à l'import)
  subcats        jsonb default '{}'::jsonb,        -- catégorie → [sous-catégories perso]
  ledger_live    boolean default false,
  holders        jsonb default '{}'::jsonb,        -- {"pay": "ACP …", "res": "ACP …"} titulaire par compte (releve.sql)
  charges        jsonb default '{}'::jsonb,        -- budget par poste et par exercice (charges.sql)
  copro_name     text,                             -- fiche de la copropriété (budget.sql)
  copro_addr     text,
  copro_kbo      text,                             -- numéro d'entreprise, ex. BE 0123.456.789
  recon          jsonb default '{}'::jsonb,        -- réconciliation {pay:{closing,asOf,from}, res:{…}}
  owner_rules    jsonb default '{}'::jsonb,        -- libellé normalisé → short : attributions apprises (bloc OWNER-DETECT)
  iban_pay       text,                             -- IBAN du compte de paiement (relevés, convocation)
  iban_res       text,                             -- IBAN du compte de réserve
  categories     jsonb default '[]'::jsonb,        -- catégories personnalisées, en plus des défauts (tableau de textes)
  annual_note    text,                             -- note libre du rapport annuel
  budget_keys    jsonb default '{}'::jsonb         -- poste → 'quote' | 'indiv' (ancienne répartition ; lu seulement)
);
insert into public.ls_settings (id) values (1) on conflict (id) do nothing;
-- déploiements existants : ajoute chaque colonne si absente (toutes, pour qu'une base
-- créée par un ancien schema.sql rattrape la définition ci-dessus)
alter table public.ls_settings add column if not exists opening_pay    numeric(12,2) default 0;
alter table public.ls_settings add column if not exists opening_res    numeric(12,2) default 0;
alter table public.ls_settings add column if not exists reserve_target numeric(12,2) default 2000;
alter table public.ls_settings add column if not exists contrib        jsonb default '{}'::jsonb;
alter table public.ls_settings add column if not exists iban_map       jsonb default '{}'::jsonb;
alter table public.ls_settings add column if not exists subcats        jsonb default '{}'::jsonb;
alter table public.ls_settings add column if not exists ledger_live    boolean default false;
alter table public.ls_settings add column if not exists holders        jsonb default '{}'::jsonb;  -- releve.sql
alter table public.ls_settings add column if not exists charges        jsonb default '{}'::jsonb;  -- charges.sql
alter table public.ls_settings add column if not exists copro_name     text;                       -- budget.sql
alter table public.ls_settings add column if not exists copro_addr     text;
alter table public.ls_settings add column if not exists copro_kbo      text;
alter table public.ls_settings add column if not exists recon          jsonb default '{}'::jsonb;
alter table public.ls_settings add column if not exists owner_rules    jsonb default '{}'::jsonb;
alter table public.ls_settings add column if not exists iban_pay       text;
alter table public.ls_settings add column if not exists iban_res       text;
alter table public.ls_settings add column if not exists categories     jsonb default '[]'::jsonb;
alter table public.ls_settings add column if not exists annual_note    text;
alter table public.ls_settings add column if not exists budget_keys    jsonb default '{}'::jsonb;

-- ============================================================
--  6. HISTORIQUE D'IMPORTS (relevés déposés)
-- ============================================================
create table if not exists public.ls_imports (
  id uuid primary key default gen_random_uuid(),
  v int, label text, meta text, cur boolean default false,
  created_at timestamptz not null default now(),
  stmt    jsonb,                           -- {opening, closing, iban, holder, asOf, from} mis de côté jusqu'à la validation
  pending boolean default false            -- relevé déposé mais pas encore validé
);
-- Le relevé est enregistré dès le dépôt, mais son solde d'ouverture et sa clôture ne sont
-- appliqués qu'à la validation : `stmt` les met de côté entre les deux. Écarter le relevé les
-- jette avec lui, au lieu de laisser une réconciliation calée sur un relevé qui n'existe plus.
alter table public.ls_imports add column if not exists stmt    jsonb;
alter table public.ls_imports add column if not exists pending boolean default false;

-- ============================================================
--  7. CHRONOLOGIE / JOURNAL DE BORD (événements manuels + audit log)
-- ============================================================
create table if not exists public.ls_timeline (
  id uuid primary key default gen_random_uuid(),
  event_date  date not null,
  title       text not null,
  description text,
  kind        text default 'manual' check (kind in ('manual','import','task','sign')),  -- 'sign' : PV signé (ag.sql)
  subs        jsonb default '[]'::jsonb,   -- sous-étapes [{title, done}]
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);
-- déploiements existants : ajoute la colonne si absente
alter table public.ls_timeline add column if not exists subs jsonb default '[]'::jsonb;
-- déploiements antérieurs à ag.sql : la contrainte ne connaissait pas 'sign'
alter table public.ls_timeline drop constraint if exists ls_timeline_kind_check;
alter table public.ls_timeline add constraint ls_timeline_kind_check
  check (kind in ('manual','import','task','sign'));

-- ============================================================
--  8. ASSEMBLÉES GÉNÉRALES
--  Ces deux tables n'avaient jamais eu de create table dans le dépôt (ag.sql
--  n'ajoutait que bureau / signature). Colonnes déduites de db.js (loadAll,
--  agCreate, agUpdate, agPointAdd, agPointUpdate) et d'app.js.
--  Types volontairement permissifs : les dates d'AG sont des saisies libres.
-- ============================================================
create table if not exists public.ls_ag (
  id               uuid primary key default gen_random_uuid(),
  title            text,                                  -- « Ordinaire — 12/03/2026 à 19h » (recalculé par l'app)
  type             text default 'Ordinaire',              -- 'Ordinaire' | 'Extraordinaire' (texte, pas de check : liste côté app)
  ag_date          text,                                  -- TEXTE et non date : saisie libre « 12/03/2026 à 19h »,
                                                          --   lue par parseFrDate() + heure extraite à la regex
  lieu             text,
  status           text default 'prep',                   -- 'prep' | 'convoquee' | 'tenue' | 'finalisee' (AG_STATUS d'app.js)
  convocation_date text,                                  -- TEXTE : toLocaleDateString('fr-BE'), « 26/10/2026 »
  presence         jsonb not null default '{}'::jsonb,    -- {short: {status:'pre'|…, mandataire}}
  bureau           jsonb not null default '{}'::jsonb,    -- {president: <short>, secretaire: <nom>} (ag.sql §1)
  signature        jsonb not null default '{}'::jsonb,    -- {status, pv:{path, sha256, size, at, signers}, signed:{…}} (ag.sql §1)
  created_at       timestamptz not null default now()     -- ordre d'affichage (la plus récente d'abord)
);
-- déploiements existants (table créée hors dépôt) : chaque colonne si absente
alter table public.ls_ag add column if not exists title            text;
alter table public.ls_ag add column if not exists type             text default 'Ordinaire';
alter table public.ls_ag add column if not exists ag_date          text;
alter table public.ls_ag add column if not exists lieu             text;
alter table public.ls_ag add column if not exists status           text default 'prep';
alter table public.ls_ag add column if not exists convocation_date text;
alter table public.ls_ag add column if not exists presence         jsonb not null default '{}'::jsonb;
alter table public.ls_ag add column if not exists bureau           jsonb not null default '{}'::jsonb;
alter table public.ls_ag add column if not exists signature        jsonb not null default '{}'::jsonb;
alter table public.ls_ag add column if not exists created_at       timestamptz not null default now();

create table if not exists public.ls_ag_points (
  id           uuid primary key default gen_random_uuid(),
  ag_id        uuid not null references public.ls_ag(id) on delete cascade,
  pos          int not null default 0,                    -- ordre dans l'ordre du jour
  title        text,
  body         text,                                      -- documentation du point (texte libre)
  kind         text default 'decision',                   -- 'decision' | 'info'
  majorite     text default 'simple',                     -- 'simple' | 'absolue' | 'deuxtiers' | 'quatrecinq' | 'unanime' (MAJ d'app.js)
  cle          text default 'Acte de base',               -- clé de répartition citée dans le PV (texte libre)
  votes        jsonb not null default '{}'::jsonb,        -- {short: 'pour' | 'contre' | 'abst'}
  seance_notes text,                                      -- notes de séance reprises dans le PV
  decision     text,                                      -- texte de la décision actée
  created_at   timestamptz not null default now()
);
alter table public.ls_ag_points add column if not exists ag_id        uuid;
alter table public.ls_ag_points add column if not exists pos          int not null default 0;
alter table public.ls_ag_points add column if not exists title        text;
alter table public.ls_ag_points add column if not exists body         text;
alter table public.ls_ag_points add column if not exists kind         text default 'decision';
alter table public.ls_ag_points add column if not exists majorite     text default 'simple';
alter table public.ls_ag_points add column if not exists cle          text default 'Acte de base';
alter table public.ls_ag_points add column if not exists votes        jsonb not null default '{}'::jsonb;
alter table public.ls_ag_points add column if not exists seance_notes text;
alter table public.ls_ag_points add column if not exists decision     text;
alter table public.ls_ag_points add column if not exists created_at   timestamptz not null default now();
create index if not exists ls_ag_points_ag_idx on public.ls_ag_points(ag_id);
-- Clé étrangère rattrapée sur une table créée hors dépôt : seulement si aucune FK n'existe
-- déjà sur ag_id. `not valid` = contrôlée pour les nouvelles lignes, sans relire l'existant
-- (un point orphelin historique ne fait pas échouer le script).
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.ls_ag_points'::regclass and c.contype = 'f'
      and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'ag_id')]
  ) then
    alter table public.ls_ag_points
      add constraint ls_ag_points_ag_id_fkey foreign key (ag_id) references public.ls_ag(id) on delete cascade not valid;
  end if;
end $$;

-- ============================================================
--  8 bis. EXERCICES COMPTABLES (periods.sql) : clôture et verrouillage
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
drop policy if exists ls_periods_read  on public.ls_periods;
drop policy if exists ls_periods_write on public.ls_periods;

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

-- ============================================================
--  9. INVITATIONS + AUTO-PROVISIONNEMENT (auto-provision.sql)
--  Dès qu'un copropriétaire invité s'inscrit (lien magique), il est ajouté à
--  ls_members avec son rôle + owner_short. Le trigger ne fait RIEN pour les
--  e-mails absents de ls_invites : les autres comptes du projet ne sont pas
--  affectés. security definer, jamais piloté par le client.
-- ============================================================
create table if not exists public.ls_invites (
  email       text primary key,
  role        text not null default 'read' check (role in ('admin','read')),
  owner_short text,                                   -- = ls_owners.short
  full_name   text
);
alter table public.ls_invites enable row level security;
drop policy if exists ls_invites_admin on public.ls_invites;
create policy ls_invites_admin on public.ls_invites for all
  using ((select public.ls_is_admin())) with check ((select public.ls_is_admin()));

-- Pré-déclarer les copropriétaires  ⬅️ REMPLACE LES E-MAILS ET LES NOMS (exemples fictifs,
-- les mêmes que schema.sql §7). Tant qu'un e-mail commence par EMAIL_ (valeur d'exemple),
-- la ligne est ignorée : relancer le script tel quel n'insère rien de factice.
insert into public.ls_invites (email, role, owner_short, full_name)
select v.email, v.role, v.owner_short, v.full_name
from (values
  ('EMAIL_ADMIN',     'admin', 'Alex', 'Alex Martin'),
  ('EMAIL_LECTEUR_1', 'read',  'Sam',  'Sam Bernard'),
  ('EMAIL_LECTEUR_2', 'read',  'Lou',  'Lou Petit')
) as v(email, role, owner_short, full_name)
where v.email not like 'EMAIL\_%'
on conflict (email) do update
  set role=excluded.role, owner_short=excluded.owner_short, full_name=excluded.full_name;

-- Trigger : à l'inscription, si l'e-mail est invité → créer le membre
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

-- Rattrapage : provisionne aussi les invités DÉJÀ inscrits (compte créé avant le trigger).
-- `do nothing` (auto-provision.sql faisait `do update`) : rejouer le baseline ne doit jamais
-- changer le rôle d'un membre existant — pour ça, modifier ls_members à la main.
insert into public.ls_members (id, email, full_name, role, owner_short)
select u.id, u.email, coalesce(i.full_name, u.email), i.role, i.owner_short
from auth.users u
join public.ls_invites i on lower(u.email) = lower(i.email)
on conflict (id) do nothing;

-- ============================================================
--  10. RLS — lecture = membres invités, écriture = syndic (admin)
--  Même boucle que schema.sql §6, étendue à ls_ag / ls_ag_points (ag.sql §1).
--  ls_members (§1) et ls_invites (§9) ont leurs propres policies.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'ls_owners','ls_lots','ls_transactions','ls_rules','ls_aliases',
    'ls_contracts','ls_reminders','ls_settings','ls_imports','ls_timeline',
    'ls_ag','ls_ag_points','ls_periods'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I_read on public.%I;', t, t);
    execute format('drop policy if exists %I_write on public.%I;', t, t);
    -- Perf : (select fn()) → la fonction est évaluée UNE fois par requête
    -- (initPlan) au lieu d'une fois par ligne. Prédicat identique → sécurité inchangée.
    execute format('create policy %I_read on public.%I for select using ((select public.ls_is_member()));', t, t);
    execute format('create policy %I_write on public.%I for all using ((select public.ls_is_admin())) with check ((select public.ls_is_admin()));', t, t);
  end loop;
end $$;

-- ============================================================
--  11. STORAGE — bucket PRIVÉ ls-docs pour les PV (à signer + signés)
--  PDF uniquement, 20 Mo max (ag.sql §3). Chemins : ag/<id>/pv-a-signer.pdf, pv-signe.pdf.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ls-docs', 'ls-docs', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- lecture : tout membre LazySyndic (les copropriétaires récupèrent le PV signé) ;
-- écriture : le syndic seulement. Toujours filtré sur bucket_id : une policy de
-- storage.objects sans filtre de bucket ouvrirait les PV aux autres utilisateurs du projet.
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

-- ============================================================
--  Terminé. Vérification : coller ../check.sql dans le SQL Editor — aucune ligne
--  « MANQUANT » ne doit sortir. Ensuite : Authentication → Users → Invite user
--  pour chaque e-mail déclaré dans ls_invites (le trigger fait le reste).
-- ============================================================
