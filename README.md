# LazySyndic

> La copropriété en pilote automatique.

Application web de gestion de copropriété pour **syndic bénévole** : import des
relevés bancaires, catégorisation automatique, suivi des paiements par
copropriétaire, budget & clés de répartition, et génération du rapport d'AG.

## Architecture

- **Front statique** (HTML/CSS/JS, sans build) — `index.html`, `app.js`, `db.js`.
- **Backend partagé** : [Supabase](https://supabase.com) (Postgres + Auth + RLS).
  Les données sont partagées entre les copropriétaires ; l'écriture est réservée
  au syndic (rôle `admin`), la lecture aux membres invités.
- **Connexion** : email + mot de passe ou lien magique.

> Les données réelles vivent dans Supabase. Ce dépôt ne contient que du code et
> des **données de démonstration anonymisées** (noms fictifs).

## Périmètre

Import CSV bancaire (format Swan/Syndic4you géré) → catégorisation par règles &
alias → tableau de bord (réserve, soldes, qui-paie-quoi, dépenses par catégorie,
pense-bête) → budget & clés de répartition → générateur de rapports PDF (AG,
compte de paiement, résultats, Annexes 2/3/4). Module AG (convocation + notes +
PV) interactif.

## Mise en place du backend

Voir [`supabase/SETUP.md`](supabase/SETUP.md) et [`supabase/schema.sql`](supabase/schema.sql).
Copier `config.example.js` en `config.js` et y renseigner l'URL + la clé anon
Supabase.
