# LazySyndic

> La copropriété en pilote automatique.

Application web de gestion de copropriété pour **syndic bénévole** : import des
relevés bancaires, catégorisation automatique, suivi des paiements par
copropriétaire, budget & clés de répartition, et génération du rapport d'AG.

## Architecture

- **Front statique** (HTML/CSS/JS, sans build) — `index.html`, `app.js`, `db.js`,
  `ui.js` (barre du haut, notifications, blocs de la page de garde).
- **Design system** : repris de `Ndashiz/lazysyndic-refined` (maquette Lovable) —
  jetons, composants et correspondance écran par écran dans [`DESIGN.md`](DESIGN.md).
- **Présentation** : `decouvrir/` — page marketing autonome (aucune dépendance au
  backend). Un visiteur sans session qui ouvre `index.html` y est renvoyé ; le
  bouton « Se connecter » revient sur `?connexion`. Identité visuelle : `brand/`.
- **Backend partagé** : [Supabase](https://supabase.com) (Postgres + Auth + RLS).
  Les données sont partagées entre les copropriétaires ; l'écriture est réservée
  au syndic (rôle `admin`), la lecture aux membres invités.
- **Connexion** : email + mot de passe ou lien magique.

> Les données réelles vivent dans Supabase. Ce dépôt ne contient que du code et
> des **données de démonstration anonymisées** (noms fictifs).

## Périmètre

Import du relevé Swan/Syndic4you (CSV, PDF en édition française ou anglaise, ou
liste copiée-collée depuis l'app Swan) → catégorisation par règles & alias →
tableau de bord (réserve, soldes, qui-paie-quoi, dépenses par catégorie,
pense-bête) → budget & clés de répartition → générateur de rapports PDF (AG,
compte de paiement, résultats, Annexes 2/3/4) → assemblées générales, de la
convocation au PV signé (voir ci-dessous).

## Assemblées générales et signature des PV

1. **Ordre du jour** — points titrés et documentés, majorité requise par point.
2. **Convocation** — s'ouvre dans la messagerie du syndic (`mailto:`), adressée aux
   e-mails des copropriétaires (Budget & copro › Copropriétaires & lots) ; contrôle
   du délai légal de 15 jours (art. 3.87 §3).
3. **Présences** — présent / représenté (mandataire) / excusé / absent, quorum, et
   **bureau de séance** (président = un copropriétaire, secrétaire).
4. **Séance** — votes et notes par point. Décompte selon l'art. 3.88 : majorité des
   voix **exprimées** par les présents et représentés, abstentions non comptées ;
   l'unanimité se compte sur tous les copropriétaires.
5. **PV signé** via [Dokobit](https://app.dokobit.com/), **offre gratuite** (pas d'API) :
   LazySyndic fige le PV en PDF (empreinte SHA-256 gardée), on le fait signer sur
   Dokobit (itsme ou carte eID), puis on réimporte le PDF signé : `signature.js` lit
   les signatures PAdES, vérifie l'intégrité et coche les signataires attendus
   (art. 3.87 §10). Le suivi continue dans l'historique après la clôture de l'AG.
   L'offre gratuite couvre 3 signatures par mois, chaque signataire compte.

Prérequis : lancer [`supabase/ag.sql`](supabase/ag.sql) à la main (colonnes
`bureau` / `signature` / `email`, bucket privé `ls-docs`). Tests du lecteur de
signatures : `node --test tests/signature.test.mjs`.

## Mise en place du backend

Voir [`supabase/SETUP.md`](supabase/SETUP.md) et [`supabase/schema.sql`](supabase/schema.sql).
Copier `config.example.js` en `config.js` et y renseigner l'URL + la clé anon
Supabase.
