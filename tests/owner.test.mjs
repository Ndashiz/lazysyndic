// Tests de detectOwner (app.js) : à quel copropriétaire rattacher un virement entrant.
// Lancer : node --test tests/owner.test.mjs — aucune dépendance.
// Le bloc OWNER-DETECT-BEGIN … OWNER-DETECT-END d'app.js est extrait tel quel et exécuté
// avec norm, state (ownerRules) et ownersOf fournis ici. Copropriétaires FICTIFS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const block = /\/\/ OWNER-DETECT-BEGIN[^\n]*\n([\s\S]*?)\/\/ OWNER-DETECT-END/.exec(src);
const normLine = /^const norm = .*$/m.exec(src);
assert.ok(block && normLine, 'marqueurs OWNER-DETECT ou définition de norm introuvables dans app.js');

// detectOwner tel qu'il tourne dans l'app, avec des règles apprises et une liste de copros donnés.
function detector(owners, ownerRules){
  const f = new Function('state', 'ownersOf', normLine[0] + '\n' + block[1] + '\nreturn detectOwner;');
  return f({ ownerRules: ownerRules || {} }, () => owners);
}
const COPRO = [
  { short:'Alex', n:'Alex Martin' },
  { short:'Lou',  n:'Lou Petit' },
  { short:'Sam',  n:'Sam Bernard' },
];
const tx = (tiers, note) => ({ tiers, note: note || '' });

test('sans règle apprise : le nom du copro, sinon rien (aucun libellé intégré dans le code)', () => {
  const d = detector(COPRO);
  assert.equal(d(tx('FOND DE RESERVE - LOU')), 'Lou');          // nom court
  assert.equal(d(tx('Alex Martin reserve')), 'Alex');
  assert.equal(d(tx('Virement', 'de la part de Sam Bernard')), 'Sam');   // nom complet, dans la note
  assert.equal(d(tx('Transfer from X Y')), '');                   // libellé propre à une copro : pas dans le code
  assert.equal(d(tx('Charge rdc et garage')), '');                // idem, il vit dans owner_rules…
  assert.equal(detector(COPRO, { 'charge rdc et garage': 'Alex' })(tx('Charge rdc et garage')), 'Alex');   // …appris
  assert.equal(d(tx('Fond de reserve')), '');                    // aucun nom, aucune règle
  assert.deepEqual(/const BUILTIN_OWNERS = \[\];/.test(block[1]), true, 'BUILTIN_OWNERS doit rester vide : rien de nominatif dans un dépôt public');
});

test('la communication structurée du copro l’emporte sur tout, si son contrôle est juste', () => {
  const d = detector([{ short:'Alex', n:'Alex Martin', ogm:'123456789002' }, { short:'Lou', n:'Lou Petit', ogm:'000000009797' }], { 'virement': 'Lou' });
  assert.equal(d(tx('Virement', '+++123/4567/89002+++')), 'Alex');      // avant la règle apprise
  assert.equal(d(tx('VIREMENT LOU PETIT +++123/4567/89002+++')), 'Alex'); // avant le nom
  assert.equal(d(tx('Virement', '***000/0000/09797***')), 'Lou');       // reste 0 → 97, étoiles
  assert.equal(d(tx('Virement', '+++123/4567/89003+++')), 'Lou');       // contrôle faux : on retombe sur la règle
  assert.equal(d(tx('Virement', '+++999/9999/99997+++')), 'Lou');       // inconnue : idem
});

test('le nom du copro l’emporte sur une règle apprise plus courte que le libellé', () => {
  const d = detector(COPRO, { 'fond de reserve': 'Alex' });     // apprise sur une ligne de Alex
  assert.equal(d(tx('Fond de reserve')), 'Alex');               // libellé exact → la règle
  assert.equal(d(tx('FOND DE RESERVE - LOU')), 'Lou');         // le nom d'Lou bat la règle
  assert.equal(d(tx('Fond de reserve', 'virement mensuel')), 'Alex');   // sous-chaîne, sans nom
});

test('une règle posée sur le libellé entier bat le nom', () => {
  const d = detector(COPRO, { 'fond de reserve - lou': 'Alex' });   // attribution faite à la main
  assert.equal(d(tx('FOND DE RESERVE - LOU')), 'Alex');
  assert.equal(d(tx('FOND DE RESERVE - LOU', 'juillet')), 'Alex');  // la note ne change pas le libellé
});

test('règle apprise par sous-chaîne quand aucun nom ne figure', () => {
  const d = detector(COPRO, { 'reserve retard': 'Alex' });
  assert.equal(d(tx('Reserve retard fev mars')), 'Alex');
});

test('le nom se lit en mot entier, pas en morceau d’un autre mot', () => {
  const d = detector([{ short:'Al', n:'Al Petit' }, { short:'Lou', n:'Lou Roux' }]);
  assert.equal(d(tx('Total charges')), '');                      // « al » dans « total »
  assert.equal(d(tx('Loulou')), '');
  assert.equal(d(tx('Virement Al')), 'Al');
  assert.equal(d(tx('Versement de Lou')), 'Lou');
  assert.equal(d(tx('Lou,provision')), 'Lou');                   // ponctuation = limite de mot
});

test('une règle vers un copro qui n’existe plus est ignorée', () => {
  const d = detector(COPRO, { 'fond de reserve': 'Zoé', 'fond de reserve - lou': 'Zoé' });
  assert.equal(d(tx('Fond de reserve')), '');
  assert.equal(d(tx('FOND DE RESERVE - LOU')), 'Lou');
  assert.equal(detector([{ short:'Alex', n:'Alex Martin' }])(tx('FOND DE RESERVE - LOU')), '');   // intégré « aude » sans Lou
});

test('un nom avec un caractère spécial de regex ne casse pas la détection', () => {
  const d = detector([{ short:'J.P.', n:'Jean-Pierre (JP) Roux' }]);
  assert.equal(d(tx('Provision J.P. juin')), 'J.P.');
  assert.equal(d(tx('Virement Jean-Pierre (JP) Roux')), 'J.P.');
  assert.equal(d(tx('JxPx')), '');
});
