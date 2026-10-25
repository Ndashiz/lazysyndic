# LazySyndic

> La copropriété en pilote automatique.

Application web de gestion de copropriété pour **syndic bénévole** : import des
relevés bancaires, catégorisation automatique, suivi des paiements par
copropriétaire, budget & clés de répartition, et génération du rapport d'AG.

## Architecture

- **Front statique** (HTML/CSS/JS, sans build) — `index.html`, `app.js`, `db.js`,
  `ui.js` (barre du haut, notifications, blocs de la page de garde),
  `signature.js` (PV en PDF, lecture des signatures), `statement.js` (relevé de compte PDF).
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
compte de paiement, résultats, Annexes 2/3/4) → relevé de compte PDF à envoyer aux
copropriétaires → assemblées générales, de la convocation au PV signé (voir ci-dessous).

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

## Relevé de compte (PDF)

Écran **Comptes bancaires** › « Relevé de compte (PDF) » (carte des rapports, ou lien
dans la fiche d'un compte). On choisit le compte (paiement, réserve ou les deux) et la
période : depuis la dernière AG, l'année en cours, l'exercice précédent, tout
l'historique ou deux dates libres. La période est celle du champ « Rapports — période ».

Le PDF reprend, pour chaque compte : la **date d'extraction**, le **nom du compte**,
le **titulaire**, l'IBAN, le solde au début de la période, les entrées, les sorties,
le **solde disponible** à la fin de la période et **toutes les transactions** avec le
solde après chaque mouvement. Avec les deux comptes, une synthèse des soldes ouvre le
document. Le PDF est un vrai fichier (pdf-lib), pas une impression du navigateur.

- **Titulaire** : saisi dans la fiche du compte ; sinon lu sur le dernier relevé
  bancaire validé ; sinon le nom de la copropriété. La saisie demande
  [`supabase/releve.sql`](supabase/releve.sql), à lancer à la main.
- **Envoi** : le syndic peut préparer un brouillon d'e-mail (`.eml`) adressé aux
  copropriétaires (mêmes adresses que la convocation), PDF en pièce jointe. Il s'ouvre
  dans la messagerie, prêt à partir.
- Les mouvements postérieurs au dernier relevé importé n'y figurent pas encore : la
  fenêtre et le PDF le signalent.

Code : `statement.js` (chiffres et PDF, sans DOM) ; tests :
`node --test tests/statement.test.mjs` (avec `npm i --no-save pdf-lib@1.17.1 pdfjs-dist@3.11.174`).

## Mise en place du backend

Voir [`supabase/SETUP.md`](supabase/SETUP.md) et [`supabase/schema.sql`](supabase/schema.sql).
Copier `config.example.js` en `config.js` et y renseigner l'URL + la clé anon
Supabase.
