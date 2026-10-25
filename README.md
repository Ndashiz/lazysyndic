# LazySyndic

> La copropriété en pilote automatique.

Application web de gestion de copropriété pour **syndic bénévole** : import des
relevés bancaires, catégorisation automatique, suivi des paiements par
copropriétaire, budget & clés de répartition, et génération du rapport d'AG.

## Architecture

- **Front statique** (HTML/CSS/JS, sans build) — `index.html`, `app.js`, `db.js`,
  `ui.js` (barre du haut, notifications, blocs de la page de garde),
  `signature.js` (PV en PDF, lecture des signatures), `statement.js` (relevé de compte PDF),
  `charges.js` (calcul des charges par poste).
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
compte de paiement, résultats, Annexes 2/3/4) → calcul des charges par poste → relevé de compte PDF à envoyer aux
copropriétaires → assemblées générales, de la convocation au PV signé (voir ci-dessous).

Un virement entrant est rattaché à un copropriétaire dans cet ordre : la règle apprise
sur son libellé exact (une attribution faite à la main), puis le nom d'un copropriétaire,
court ou complet, en mot entier dans le libellé ou la note, puis les règles apprises par
sous-chaîne, puis les libellés intégrés. Un nom dans le libellé l'emporte donc sur une
règle plus courte que lui. Code : bloc `OWNER-DETECT` d'`app.js` ; tests :
`node --test tests/owner.test.mjs` (aucune dépendance).

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

## Calcul des charges

Écran **Budget & copropriétaires** › « Calcul des charges ». Un budget par exercice
(flèches ‹ ›) ; l'écran s'ouvre sur l'année qui suit celle en cours, puisque la prévision
se prépare pour l'année d'après sur le réel à ce jour. Un budget est fait de postes de dépense :

- **Poste** : un nom, une **catégorie de la comptabilité** (une catégorie entière ou une
  sous-catégorie) ou « nouveau poste » sans historique. Le lien est **1 pour 1** : une
  catégorie déjà reprise par un poste est grisée pour les autres, et une catégorie entière
  exclut ses sous-catégories, pour qu'aucune dépense ne compte deux fois.
- **Clé de répartition** : **Millièmes** (au prorata des quotités) ou **Individuelle**
  (parts égales, chaque copropriétaire une fois).
- **Bénéficiaire** : le fournisseur du poste, texte libre, proposé d'après le tiers le plus
  fréquent des dépenses de la catégorie (les libellés bancaires et les références ne comptent
  pas) ; repris sous le poste dans l'Annexe 4.
- **Budget de l'année précédente** : ce qui avait été prévu pour la même catégorie (sinon le
  même nom) dans le budget d'avant, à côté du réel, à l'écran comme dans l'Annexe 4.
- **Moyenne de l'année précédente** : dépenses nettes du compte de paiement dans la
  catégorie (remboursements déduits), divisées par les mois couverts par les relevés.
  Un registre commencé en mars compte 10 mois, pas 12. Un nouveau poste n'a pas de moyenne.
- **Prévision** : montant annuel saisi, ou « = moyenne × 12 » arrondi à l'euro supérieur.

« Proposer les postes depuis le réel » crée un poste par catégorie dépensée l'année
précédente. Les dépenses qu'aucun poste ne reprend sont signalées sous le tableau. La
prévision est répartie par copropriétaire au centime près, et « Appliquer aux provisions »
en fait le « dû — paiement » de chacun : le suivi des paiements et des retards s'y fie.
L'Annexe 4 du rapport d'AG reprend ce budget dès qu'il a des postes.

**Fonds de réserve** (même écran, carte suivante) : des postes à constituer sur le compte
de réserve, par exemple « Isoler la façade ». Chacun a un montant, une durée en mois (à
partir de janvier de l'exercice) et une clé. L'appel de l'année = montant ÷ durée × mois
couverts dans l'année ; la somme des années redonne le montant au centime. « Reprendre le
budget » d'un exercice précédent recopie les postes de réserve encore en cours. Une ligne
automatique « Contribution minimum légale » complète l'appel de chaque copropriétaire
jusqu'à 5 % de ses charges courantes de l'année, et baisse quand les autres postes
appellent déjà plus. « Appliquer aux provisions » remplit alors le dû du compte de
paiement et celui du compte de réserve.

Prérequis : lancer [`supabase/charges.sql`](supabase/charges.sql) à la main (colonne
`ls_settings.charges`). Code : `charges.js` (calcul pur) ; tests :
`node --test tests/charges.test.mjs` (aucune dépendance).

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
