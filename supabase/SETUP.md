# Mise en place — backend Supabase (projet partagé LazyPO) + prod

Objectif : données partagées entre les 3 copropriétaires, login par lien
magique, app sur `https://ndashiz.be/lazysyndic/`.

> Le free tier Supabase est limité à 2 projets (déjà atteints). On **réutilise
> le projet de LazyPO**. Tout est préfixé `ls_` ; le script SQL est additif et
> ne touche rien de LazyPO. Les identifiants sont déjà dans `config.js`
> (clé publique). Tu n'as donc **pas** de clé à me transmettre.

## Base neuve ou base existante : un seul script

1. **SQL Editor → New query** : colle tout [`migrations/000_baseline.sql`](migrations/000_baseline.sql)
   → **Run**. Idempotent : il crée ce qui manque (tables, colonnes, fonctions, trigger, RLS,
   bucket `ls-docs`) et ne touche à rien de ce qui existe déjà — relançable à volonté, sur une
   base vide comme sur la prod. Remplace d'abord les e-mails d'exemple (`EMAIL_ADMIN`…) dans le
   bloc `ls_invites` si tu veux pré-déclarer les copropriétaires ; tels quels, ils sont ignorés.
2. Colle ensuite [`check.sql`](check.sql) → **Run** : aucune ligne « MANQUANT » ne doit sortir
   (le commentaire en tête dit ce qu'une base complète renvoie).
3. `node --test tests/schema.test.mjs` vérifie, sans base, que chaque colonne utilisée par
   `db.js` / `app.js` existe dans le baseline — à relancer dès qu'une colonne apparaît dans le code.

Les scripts par fonctionnalité (`schema.sql`, `ag.sql`, `auto-provision.sql`, `budget.sql`,
`charges.sql`, `releve.sql`, `calls.sql`, `periods.sql`, `budgets.sql`) restent comme **historique** : tout leur contenu est repris dans le
baseline, il n'y a plus à les lancer un par un. Les étapes ci-dessous datent de la mise en place
initiale ; l'étape 1 est remplacée par le baseline, les étapes 2 à 4 restent valables.

## Étape 1 — Créer les tables (historique : remplacé par le baseline)

Supabase (projet LazyPO) → **SQL Editor → New query** → colle tout
[`schema.sql`](schema.sql) → **Run**. Crée `ls_members`, `ls_owners`,
`ls_transactions`, etc. + la sécurité RLS.

## Étape 2 — Inviter les 3 copropriétaires

**Authentication → Users → Invite user** pour chaque email (Alex, Sam, Lou).
Ça crée leur compte (auth partagée avec LazyPO).

## Étape 3 — Fixer les rôles

**SQL Editor**, exécute le bloc 7 de `schema.sql` en remplaçant les emails
(Alex = `admin`, Sam/Lou = `read`). Optionnel : bloc 8 pour amorcer les
propriétaires/lots et les soldes d'ouverture.

## Étape 4 — Autoriser la redirection

**Authentication → URL Configuration → Redirect URLs** : ajoute
`https://ndashiz.be/lazysyndic/` (et `http://localhost:8099/` pour les tests
locaux). N'enlève pas les URLs de LazyPO.

## Étape 5 — Me dire « c'est fait »

Dès que le SQL est passé et les 3 invités, je teste le login + la lecture/écriture
en local, je nettoie les noms réels du code et de l'historique git, puis on passe
le repo en public et on active GitHub Pages → en ligne sur `ndashiz.be/lazysyndic/`.

## Sécurité

- Clé `anon` publique : sans membre `ls_members`, RLS bloque tout. Un compte
  LazyPO lambda ne voit aucune donnée copro.
- Les vraies données (relevés, transactions) vivent dans Supabase, jamais dans Git.
