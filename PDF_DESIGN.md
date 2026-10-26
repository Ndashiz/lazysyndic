# Documents PDF de LazySyndic — design system

Tout ce que LazySyndic imprime ou dessine parle le même langage : mêmes couleurs, même
typographie, mêmes formats de montants et de dates, mêmes composants. Ce document dit où ça
vit, comment on s'en sert et comment on migre un document.

## Architecture

| Pièce | Rôle |
|---|---|
| [`pdf.js`](pdf.js) (`LSPdf`) | jetons (`tokens`), formats (`fmt`), composants HTML (`head`, `foot`, `document`, `summary`, `section`, `table`, `badge`, `note`, `amount`, `legal`). Pur, sans DOM : testé sous Node (`node --test tests/pdf.test.mjs`). |
| [`pdf.css`](pdf.css) | la feuille des documents HTML : la feuille blanche de l'aperçu à l'écran, la page A4 à l'impression (`@page`), la répétition des en-têtes et des pieds, les règles de coupure. Elle style aussi les anciennes classes (`r-head`, `r-sub`, `chip`, `tot`, `sig`, `r-foot`) : rien ne casse tant qu'un rapport n'est pas migré. |
| `app.js` › `setupReports` | assemble les rapports HTML (`buildReport`) et les ouvre dans la fenêtre d'aperçu ; le navigateur fait le PDF (« Imprimer / Enregistrer en PDF »). `headEl` et `foot` sont des composants `LSPdf`. |
| `charges.js` › `annexModel` | le modèle pur de l'Annexe 4 : tout ce que le document affiche, sans HTML. |
| `statement.js`, `signature.js`, `convocation.js` | documents dessinés avec pdf-lib (relevé de compte, PV, convocation) : moteur différent, mêmes jetons disponibles via `LSPdf.tokens.rgb`. |

Deux moteurs cohabitent : **HTML imprimé** pour les rapports composés de tableaux (le budget
en est le document de référence), **pdf-lib** pour les documents qui partent en pièce jointe
ou se signent (relevé, PV, convocation). On ne change pas de moteur pour une refonte graphique.

## Jetons

- **Couleurs** (`LSPdf.tokens.color`, et en `rgb` 0..1 pour pdf-lib) : `ink` #20251F texte ·
  `soft` #5C6153 secondaire (4,6:1 sur blanc) · `faint` #8A8F80 mentions (jamais sous 10 px) ·
  `line` #E3E7E1 filets · `rule` #20251F filets forts · `tint` #F4F7F4 fonds légers ·
  `tint2` #E9F0EA colonne mise en avant et totaux · `green` #21503D titres et identité ·
  `greenSoft` #E2ECE3 puces · `warning` / `warningSoft` brouillon · `danger` #B42318 dépassement.
  Les mêmes valeurs sont les variables `--pdf-*` de `pdf.css`.
- **Typographie** : Hanken Grotesk (la police de l'app), repli system-ui. Tailles :
  h1 22 · h2 14 · corps 12,5 · tableau 11,5 (11 en dense) · petit 10,5 · micro 10. Rien sous
  10 px à l'impression. Chiffres tabulaires partout (`font-variant-numeric`).
- **Page** : A4, marges 14 mm · 12 mm · 18 mm · 12 mm (`@page`), numéro « Page n / N » en
  bas à droite par `@page @bottom-right` (Chrome, Edge ; absent sous Safari et Firefox, qui
  ignorent les boîtes de marge).

## Formats (`LSPdf.fmt`)

| Fonction | Rend | Règle |
|---|---|---|
| `eur(n)` | `1 383,84 €` | virgule décimale, espace fine de milliers, jamais « −0,00 » ; `app.js` `eur()` délègue ici |
| `signed(n)` | `−502,44 €`, `+12,00 €` | signe typographique « − », pas un tiret |
| `pct(n, d)` | `3,0 %` | une décimale par défaut |
| `int(n)` | `1 000` | quotités, compteurs |
| `date(d)` / `dateLong(d)` | `25/10/2026` / `25 octobre 2026` | accepte ISO, `jj/mm/aa`, `Date` |
| `period(from, to)` | `01/01/26 → 31/10/26` | comme les relevés et les rapports existants |
| `months(from, to, y)` | `mars → octobre 2025` | la couverture des relevés |

## Composants

```js
LSPdf.document({ head, body, foot })      // le pied se répète en bas de chaque page (tfoot)
LSPdf.head({ title, chip, copro:{name, addr, kbo}, meta:[{label, value}], status:{kind, label} })
LSPdf.foot({ copro, note, date })
LSPdf.summary([{ label, value, sub, emph }])           // tuiles de synthèse, une seule en emph
LSPdf.section('Fonds de roulement', { n:1, chip:'Compte de paiement', sub })
LSPdf.table({ cols, groups|rows, totals, cls, label, empty })
LSPdf.badge('draft'|'ok'|'warning'|'danger'|'neutral', 'Brouillon')
LSPdf.note(texte, { kind:'info'|'legal'|'warning', title })
LSPdf.amount(v, { emph, label }) · LSPdf.legal([lignes])
```

`table` : `cols = [{label, sub, align:'right', emph, w}]` ; une cellule est une valeur ou
`{text|html, sub, cls, neg, emph}` ; `groups = [{label, rows}]` dessine une bande par
catégorie ; `totals = [{label, cells, kind:'tot'|'sub'}]`. L'en-tête est un `thead` répété à
chaque page ; un groupe (`tbody`) ne se coupe pas quand il tient sur une page ; les totaux
restent avec le tableau.

## Règles d'usage

1. **Le modèle d'abord, le HTML ensuite.** Un document part d'un objet pur (comme
   `LSCharges.annexModel`) testé sous Node ; la mise en page n'additionne rien. Les formules,
   clés de répartition et règles métier ne vivent jamais dans un template.
2. **Aucune couleur en dur dans un document** : les classes de `pdf.css` ou les jetons.
   La couleur ne porte pas de sens à elle seule : un dépassement est marqué par le signe « − »
   et la graisse, le rouge vient en plus (`neg`).
3. **Une seule colonne mise en avant par tableau** (`emph`) : le montant qui engage.
4. **Libellés longs** : ils passent à la ligne, la première colonne garde 120 px ; au-delà de
   quatre copropriétaires, la part de chacun va dans un tableau à part (`pdf-dense`).
5. **Statut visible** : un brouillon porte le badge « Brouillon » dans l'en-tête et dans le
   pied ; le nom du fichier PDF vient de `document.title` (`LazySyndic – copro – document`).
6. **Mentions légales** en fin de document (`legal`), petit corps, filet léger.
7. **Jamais de dépendance** : ni bibliothèque de PDF côté rapports HTML, ni police hors Hanken.

## Documents et état de migration

| Document | Moteur | État |
|---|---|---|
| Budget prévisionnel (Annexe 4) | HTML | **migré** : `annexModel` + composants, synthèse, trois parties, pagination testée sur 2, 5 et 7 pages |
| Rapport financier d'AG (`ag`) | HTML | en-tête, pied, `soldesSection` et `annexeTxSection` migrés (`LSPdf.section` + `LSPdf.table`) ; `resultatSection`, `ownersSection`, `chronoSection`, `signatures` encore en classes anciennes (stylées par `pdf.css`) — prochain candidat : `resultatSection` |
| Compte de paiement (`pay`), Compte de résultats (`res`) | HTML | idem : en-tête et pied migrés |
| Relevé de compte | pdf-lib (`statement.js`) | couleurs sur `LSPdf.tokens.rgb`, plus d'italique, rien sous 7,5 pt, pied en `soft` ; police Helvetica tant que Hanken Grotesk n'est pas embarquée (fontkit + TTF vendorisée), d'où « - » et « du … au … » à la place de « − » et « → » |
| Procès-verbal d'AG | pdf-lib (`signature.js`) | idem |
| Convocation | pdf-lib (`convocation.js`) | idem ; le fichier n'était pas suivi par git |

## Vérifier un document

- Tests : `node --test tests/pdf.test.mjs tests/charges.test.mjs`.
- Rendu : ouvrir le rapport dans l'app et « Imprimer / Enregistrer en PDF » ; en headless,
  Chrome + protocole DevTools (`Page.printToPDF`, `preferCSSPageSize`) depuis une copie
  hors-ligne de l'app, avec trois volumes : données de démo, 6 copropriétaires × 25 postes,
  budget presque vide. Contrôler : aucun tableau qui déborde (`scrollWidth` = largeur), en-têtes
  répétés, totaux non orphelins, montants identiques à la version précédente.
