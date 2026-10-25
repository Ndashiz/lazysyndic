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
  { short:'Simon', n:'Simon Dupont' },
  { short:'Aude',  n:'Aude Martin' },
  { short:'Peng',  n:'Peng Bernard' },
];
const tx = (tiers, note) => ({ tiers, note: note || '' });

test('sans règle apprise : nom du copro, puis libellés intégrés, sinon rien', () => {
  const d = detector(COPRO);
  assert.equal(d(tx('FOND DE RESERVE - AUDE')), 'Aude');        // nom court
  assert.equal(d(tx('Simon Goffin reseve')), 'Simon');
  assert.equal(d(tx('Virement', 'de la part de Peng Bernard')), 'Peng');   // nom complet, dans la note
  
  assert.equal(d(tx('Charge rdc et garage')), 'Simon');
  assert.equal(d(tx('Fond de reserve')), '');                    // aucun nom, aucune règle
});

test('le nom du copro l’emporte sur une règle apprise plus courte que le libellé', () => {
  const d = detector(COPRO, { 'fond de reserve': 'Simon' });     // apprise sur une ligne de Simon
  assert.equal(d(tx('Fond de reserve')), 'Simon');               // libellé exact → la règle
  assert.equal(d(tx('FOND DE RESERVE - AUDE')), 'Aude');         // le nom d'Aude bat la règle
  assert.equal(d(tx('Fond de reserve', 'virement mensuel')), 'Simon');   // sous-chaîne, sans nom
});

test('une règle posée sur le libellé entier bat le nom', () => {
  const d = detector(COPRO, { 'fond de reserve - aude': 'Simon' });   // attribution faite à la main
  assert.equal(d(tx('FOND DE RESERVE - AUDE')), 'Simon');
  assert.equal(d(tx('FOND DE RESERVE - AUDE', 'juillet')), 'Simon');  // la note ne change pas le libellé
});

test('règle apprise par sous-chaîne quand aucun nom ne figure', () => {
  const d = detector(COPRO, { 'reserve retard': 'Simon' });
  assert.equal(d(tx('Reserve retard fev mars')), 'Simon');
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
  const d = detector(COPRO, { 'fond de reserve': 'Zoé', 'fond de reserve - aude': 'Zoé' });
  assert.equal(d(tx('Fond de reserve')), '');
  assert.equal(d(tx('FOND DE RESERVE - AUDE')), 'Aude');
  assert.equal(detector([{ short:'Alex', n:'Alex Martin' }])(tx('FOND DE RESERVE - AUDE')), '');   // intégré « aude » sans Aude
});

test('un nom avec un caractère spécial de regex ne casse pas la détection', () => {
  const d = detector([{ short:'J.P.', n:'Jean-Pierre (JP) Roux' }]);
  assert.equal(d(tx('Provision J.P. juin')), 'J.P.');
  assert.equal(d(tx('Virement Jean-Pierre (JP) Roux')), 'J.P.');
  assert.equal(d(tx('JxPx')), '');
});
