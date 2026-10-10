# Design system — correspondance avec `lazysyndic-refined`

L'interface reprend le design produit sous Lovable dans
[`Ndashiz/lazysyndic-refined`](https://github.com/Ndashiz/lazysyndic-refined)
(React + TanStack + Tailwind + shadcn/ui, données fictives). Rien de cette pile
n'est importé : le design est porté en HTML/CSS/JS sans build, et toute la
logique métier reste celle d'`app.js`.

| Fichier | Rôle |
|---|---|
| `index.html` (premier `<style>`) | jetons + composants du design (= `src/styles.css` du dépôt Lovable) |
| `index.html` (dernier `<style>`) | surcharges des styles qu'`app.js` injecte dans `<head>` (connexion, toasts, chronologie, comptabilité, mode démo) |
| `ui.js` | barre du haut, pastilles de navigation, blocs ajoutés à la page de garde — lit l'état d'`app.js`, n'écrit rien |
| `img/residence.jpg` | photo du bandeau « Votre copropriété » et de l'écran de connexion (celle du design) |

## Jetons

Les jetons du design sont la source. Les anciens noms restent en alias parce
que les gabarits d'`app.js` les utilisent (`var(--coral)`, `var(--ink-faint)`…).

| Jeton (design) | Valeur | Hex | Ancien nom LazySyndic |
|---|---|---|---|
| `--background` | `oklch(.979 .003 150)` | `#F7F9F7` | `--paper` |
| `--foreground` | `oklch(.27 .021 165)` | `#1D2A24` | `--ink` |
| `--card` | `oklch(1 0 0)` | `#FFFFFF` | `--card` |
| `--muted` | `oklch(.956 .005 150)` | `#EEF1EF` | `--card-2` |
| `--muted-foreground` | `oklch(.55 .012 160)` | `#6C746F` | `--ink-soft`, `--ink-faint` |
| `--primary` | `oklch(.43 .09 167)` | `#005F45` | `--green` |
| `--primary-hover` ¹ | `oklch(.38 .085 167)` | `#005039` | `--green-deep` |
| `--secondary` | `oklch(.951 .017 160)` | `#E6F3EB` | `--green-soft` |
| `--accent` | `oklch(.942 .024 160)` | `#DFF1E6` | (survol) |
| `--border` / `--input` | `oklch(.918 .007 160)` | `#E0E5E2` | `--line`, `--line-2` |
| `--success` / `-soft` | `oklch(.47 .1 160)` / `oklch(.946 .031 158)` | `#126B47` / `#DDF4E5` | — |
| `--warning` / `-soft` | `oklch(.62 .125 72)` / `oklch(.964 .035 80)` | `#B47819` / `#FFF1D9` | `--clay-soft` |
| `--warning-ink` ¹ | `oklch(.52 .11 70)` | `#915C08` | `--clay` |
| `--info` / `-soft` | `oklch(.55 .1 247)` / `oklch(.95 .023 244)` | `#3C76A9` / `#E2F1FD` | — |
| `--danger` / `-soft` ¹ | `oklch(.53 .15 30)` / `oklch(.955 .025 30)` | `#B24133` / `#FFEAE6` | `--coral`, `--coral-soft` |
| `--radius` | `.5rem` | 8 px | `--radius` (était 18 px) |
| `--font-sans` | Hanken Grotesk | | `--display` (inchangé) |

¹ Ajouts au design, chacun pour une raison précise :
- `--warning-ink` : le `--warning` du design fait 3,7:1 sur blanc, sous le seuil
  de 4,5:1 pour du texte de 11 px. Il reste pour les fonds et pictos ; le texte
  des pastilles « à catégoriser », « en retard »… utilise `--warning-ink`.
- `--danger` : le design garde le rouge shadcn par défaut (`#E7000B`), qu'il
  n'utilise nulle part. LazySyndic en a besoin (retards, suppressions, erreurs) :
  brique, dans la famille de l'ancien corail, 5,7:1 sur blanc.
- `--primary-hover` : le bouton shadcn fait `bg-primary/90` ; une teinte pleine
  évite la transparence sur fond vert pâle.

Graphiques : `--chart-in #1F7A55` / `--chart-out #D9822B` (paire entrées /
sorties validée daltonisme le 2026-10-09, gardée), `--chart-bal` = `--info`
pour la courbe de solde. Catégories du camembert (`CAT_META` dans `app.js`) :
Énergie `primary`, Assurance `info`, Frais ACP `warning`, Entretien sauge
`#72A689`, Charges `success`, Fonds de réserve violet `#6C5594`.

## Composants

| Design (classe / composant) | LazySyndic | Note |
|---|---|---|
| `.app-layout`, `.app-sidebar` (240 px, blanche) | `.app`, `.side` | la barre latérale passe du vert plein au blanc |
| `.brand` (pictogramme + « lazysyndic. ») | `.brand` + `brand/logo.svg` | **logo LazySyndic conservé** (façade, charte `brand/`) |
| `.workspace-picker` | `.workspace` (`#sideCopro`, `#sideMeta`) | sans chevron : il n'y a qu'une copropriété |
| `.nav-label`, `.nav-item`, `.nav-item.active` | `.nav-label`, `.nav button`, `.nav button.on` | pictos Lucide du design ; écart avant « Assemblées » |
| pastille « 3 » sur Import | `.nav-badge` `#badgeImp`, `#badgeAcc` | réelles : mouvements à valider / à catégoriser |
| « Besoin d'un coup de main ? » | `.side-link` « Un coup de main ? » | `mailto:info@lagoffinerie.be` |
| `.user-profile`, `.avatar` | `.user`, `.av` | le clic bascule toujours le mode démo (admin) |
| `.app-topbar`, `.topbar-breadcrumb` | `.topbar`, `.crumbs` | collée en haut sur mobile, où elle remplace la barre verte |
| `.search-box` (filtre les pages) | `.search` `#tbSearch` | pages + mots-clés (« iban », « pv », « alias »…), flèches + Entrée |
| cloche → dialogue « Notifications » | `#tbBell` → `.pop` | **réelle** : à valider, à catégoriser, écarts de rapprochement, retards, rappels ≤ 7 j, AG en cours |
| avatar → dialogue « Votre espace » | `#tbMe` → `.pop` | identité, accès, mode démo, déconnexion (remplace `#sessionBar`) |
| `.page-heading` (h1 + description + actions) | `.top` (h1 + `.desc` + `.heading-actions`) | |
| `.date-pill` | `.updated` | |
| `.residence-banner` | `.residence` | nom, nombre de lots (si renseignés) et de copropriétaires réels |
| `.quick-panel`, `.quick-action` | `.card` + `.qa` | en lecture seule, « Importer » devient « Voir les comptes » |
| `.stats-grid`, `.stat-card` | `.stats.kpis`, `.kpi` | `app.js` remplit toujours `.kpi .v` dans le même ordre |
| `.data-panel`, `.panel-header` | `.card.data-panel`, `.h-row` | tableau bord à bord, en-tête sur fond `--background` |
| tableau « Derniers mouvements » | `#recentTx` | 5 derniers mouvements réels ; « ⋯ » ouvre la fiche (`showTxDetail`) |
| `.activity-list` « Le fil » | `#activity` | 4 derniers événements de la chronologie |
| « Appels de fonds · T4 » (barre) | `#ownersProgress` au-dessus de « Qui paie quoi » | versé / dû de l'exercice |
| `.meeting-row`, `.meeting-date` | `.agnext`, `.agn-ic` | si la date saisie se lit, la tuile affiche mois + jour |
| `.status.success / .warning / .info` | `.status.*` ; `.badge.b-ok / .b-late` | `.badge` sans point (app.js y met déjà ✓ / ⚠) |
| `Button` default / outline / secondary | `.btn-primary` / `.btn-ghost` / `.rb`, `.seg button.on` | hauteur 36 px, rayon 6 px |
| `.filter-tabs` | `.seg` | séparateur entre deux groupes |
| `Input`, `select` | `.fld`, `select` | chevron dessiné, anneau de focus `--ring` |
| zone de dépôt (pointillés + tuile + bouton) | `.drop`, `.drop.compact` | |
| `Dialog` | `#ctModal`, `#splitModal`, fiche mouvement | voile `--shade`, rayon 8 px |
| sonner (toast) | `.ls-toast` | carte blanche bordée |
| `.page-footer` | `.page-footer` (`#footEnv`) | « Démonstration », « Mode local » ou nom de la copropriété |

Montants : comme dans le design, **les entrées sont en vert, les sorties dans la
couleur du texte** précédées d'un « − » (tableaux, comptabilité). Le rouge est
réservé à ce qui demande une action (retards, écarts, suppressions).

## Écrans

| Route du design | Écran (`data-s`) | Titre | Description |
|---|---|---|---|
| `/` | `dash` | Bonjour {prénom} | Tout ce qu'il faut savoir sur votre copropriété, aujourd'hui. |
| `/comptes` | `acc` | Comptes bancaires | Tous les mouvements de votre copropriété. |
| `/comptabilite` | `cpta` | Comptabilité | Les flux de trésorerie de votre copropriété, dérivés des transactions. |
| `/import` | `imp` | Importer des relevés | Préparez vos mouvements bancaires avant leur validation. |
| `/assemblees` | `ag` | Assemblées générales (ou titre de l'AG en cours) | Les décisions qui font avancer votre copropriété. |
| `/budget` | `budget` | Budget & copropriétaires | Un budget partagé, une répartition transparente. |
| `/contrats` | `ct` | Contrats & prestataires | Vos partenaires au service de l'immeuble. |
| `/historique` | `timeline` | Vie de l'immeuble | Le fil des interventions et des événements… |
| `/regles` | `rules` | Règles de catégorisation | Règles, alias de tiers et sauvegardes. |

Page de garde, de haut en bas : bandeau + raccourcis → 4 chiffres clés (paiement,
réserve avec jauge d'objectif, à recevoir, à payer) → derniers mouvements + fil →
prochaine AG + pense-bête → qui paie quoi + répartition des dépenses → suivi des
charges payées (inchangé).

## Écarts assumés

- **Pas de React / Tailwind / shadcn** : l'app reste sans build.
- **Logo** : le design utilisait un pictogramme générique et « lazy**syndic**. » ;
  l'identité validée (`brand/`) est gardée.
- **Pas de soleil** après « Bonjour », pas d'italique (charte).
- **« Ajouter un mouvement »** (saisie manuelle du design) n'existe pas dans
  LazySyndic : le bouton principal de la page de garde est « Importer un relevé ».
- **Photo** du bandeau : c'est celle du design, pas l'immeuble réel ; la
  remplacer = écraser `img/residence.jpg` (1280 × 768).
- Mode sombre (`.dark` du design) : jamais activé dans le design, non porté.

## Fusion avec le travail AG / signature non commité

Les panneaux de l'assistant AG (étapes 1 à 5), `renderTx`, `TL_KIND` et
`setAgStatus` n'ont pas été touchés : le restylage passe par les jetons et par
la feuille de surcharges. Reste à faire à la fusion : remplacer les
`font-family:'Fraunces'` du code AG par `var(--display)`.
