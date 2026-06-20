# Mise en place — backend Supabase (projet partagé LazyPO) + prod

Objectif : données partagées entre les 3 copropriétaires, login par lien
magique, app sur `https://ndashiz.be/lazysyndic/`.

> Le free tier Supabase est limité à 2 projets (déjà atteints). On **réutilise
> le projet de LazyPO**. Tout est préfixé `ls_` ; le script SQL est additif et
> ne touche rien de LazyPO. Les identifiants sont déjà dans `config.js`
> (clé publique). Tu n'as donc **pas** de clé à me transmettre.

## Étape 1 — Créer les tables (≈ 2 min)

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
