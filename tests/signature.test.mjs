// Tests de signature.js (lecture PAdES + appariement des signataires).
// Lancer : node --test tests/signature.test.mjs
// Les PDF de tests/fixtures sont FICTIFS (cf. make_fixtures.py) : vraies signatures
// PAdES (pyHanko), faux noms, fausse autorité de certification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../signature.js');
const fx = name => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const EXPECTED = [
  { name: 'Alex Martin', roles: ['Président de séance', 'Secrétaire', 'Copropriétaire présent'] },
  { name: 'Sam Bernard', roles: ['Copropriétaire présent'] },
  { name: 'Jo Petit', roles: ['Mandataire de Lou Petit'] },
];

test('PV non signé : aucune signature, rien après', async () => {
  const r = await S.readSignatures(fx('pv-a-signer.pdf'));
  assert.equal(r.signatures.length, 0);
  assert.equal(r.tail, null);
});

test('3 signatures + horodatage de document : signataires, méthodes, intégrité', async () => {
  const r = await S.readSignatures(fx('pv-signe-3-docts.pdf'));
  assert.deepEqual(r.signatures.map(s => s.name), ['Alex Martin', 'Sam Bernard', 'Jo Petit']);
  assert.deepEqual(r.signatures.map(s => s.method), ['eID', 'itsme', 'itsme']);
  for (const s of r.signatures) {
    assert.equal(s.digestOk, true, s.name);
    assert.equal(s.sigOk, true, s.name);            // ECDSA P-384, RSA PKCS#1, RSA-PSS
    assert.ok(s.at, s.name);
  }
  assert.equal(r.signatures[1].atSource, 'tsa');    // jeton d'horodatage lu
  assert.equal(r.timestamps.length, 1);             // l'horodatage de document n'est pas un signataire
  assert.equal(r.tail, 'none');
  const m = S.matchSigners(EXPECTED, r.signatures);
  assert.deepEqual(m.rows.map(x => x.sig), [0, 1, 2]);
  assert.deepEqual(m.extras, []);
});

test('2 signatures sur 3 : le mandataire manque', async () => {
  const r = await S.readSignatures(fx('pv-signe-2.pdf'));
  const m = S.matchSigners(EXPECTED, r.signatures);
  assert.deepEqual(m.rows.map(x => x.sig), [0, 1, -1]);
});

test('le PV figé est le début exact du PDF signé (signature incrémentale)', async () => {
  const pv = fx('pv-a-signer.pdf'), signed = fx('pv-signe-2.pdf');
  assert.equal(await S.sha256Hex(signed.subarray(0, pv.length)), await S.sha256Hex(pv));
});

test('octet modifié dans le contenu signé : empreintes fausses', async () => {
  const r = await S.readSignatures(fx('pv-altere.pdf'));
  assert.equal(r.signatures.length, 3);
  for (const s of r.signatures) assert.equal(s.digestOk, false, s.name);
});

test('ajout après la dernière signature : signalé', async () => {
  const r = await S.readSignatures(fx('pv-ajout.pdf'));
  assert.equal(r.tail, 'autre');
  for (const s of r.signatures) assert.equal(s.digestOk, true, s.name);
});

test('le numéro national (serialNumber du certificat) ne sort jamais', async () => {
  const r = await S.readSignatures(fx('pv-signe-3-docts.pdf'));
  assert.ok(!JSON.stringify(r).includes('99010100197'));
});

test('pas un PDF : erreur claire', async () => {
  await assert.rejects(S.readSignatures(new TextEncoder().encode('PK\x03\x04 conteneur asice')), /pas un PDF/);
});

test('noms : prénoms en plus, accents, homonymes de famille', () => {
  assert.ok(S.sameName('Alex Martin', 'Alex Jean Martin'));
  assert.ok(S.sameName('Lou Pétit', 'lou petit'));
  assert.ok(!S.sameName('Alex Martin', 'Lou Martin'));
  assert.ok(!S.sameName('', 'Alex Martin'));
});

test('PV généré (si pdf-lib est installé)', async t => {
  let PDFLib;
  try { PDFLib = require('pdf-lib'); } catch { t.skip('npm i --no-save pdf-lib@1.17.1 pour ce test'); return; }
  const b = await S.buildPvPdf(PDFLib, {
    copro: 'ACP Démo', type: 'Ordinaire', dateLabel: '28/10/2026 19h00', lieu: 'RDC',
    president: 'Alex Martin', secretaire: 'Alex Martin',
    presences: [{ name: 'Alex Martin', quot: 500, status: 'Présent' }],
    attendance: { n: 1, of: 1, q: 500, tot: 500 },
    points: [{ n: 1, title: 'Comptes → 2025 ✓', body: '1 234,56 €', maj: 'Majorité absolue',
               rule: 'plus de la moitié des 500 quotités exprimées',
               pour: { names: ['Alex Martin'], q: 500 }, contre: { names: [], q: 0 }, abst: { names: [], q: 0 }, adopted: true }],
    signers: EXPECTED, generatedAt: '2026-10-05T12:00:00Z',
  });
  assert.equal(new TextDecoder().decode(b.subarray(0, 5)), '%PDF-');
  assert.equal((await S.readSignatures(b)).signatures.length, 0);
});
