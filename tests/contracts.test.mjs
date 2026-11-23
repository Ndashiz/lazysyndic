// Tests de contracts.js (« Contrats en cours », Annexe 1 en PDF).
// Lancer : node --test tests/contracts.test.mjs
// Le PDF et sa relecture ont besoin de pdf-lib et pdfjs-dist :
//   npm i --no-save pdf-lib@1.17.1 pdfjs-dist@3.11.174   (sinon ce test est sauté)
// Données FICTIVES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const K = require('../contracts.js');
const tryReq = n => { try { return require(n); } catch { return null; } };
const PDFLib = tryReq('pdf-lib'), pdfjs = tryReq('pdfjs-dist/legacy/build/pdf.js');

const list = [
  { name:'ASSURANCE IMMEUBLE', ref:'01/23.456', type:'Assurance', start:'—', note:'Couvre le bâtiment', fournisseur:'Assureur SA', status:'actif' },
  { name:'Eau', ref:'—', type:'Énergie', start:'15/03/23', note:'', fournisseur:'', status:'actif' },
  { name:'Gaz', ref:'GAZ-1', type:'Énergie', start:'01/02/22', end:'31/01/25', note:'ancien', endNote:'résilié', fournisseur:'Gazier', status:'cloture' },
];

test('modèle : en cours et clôturés, tirets vidés, période sous le nom', () => {
  const m = K.contractsModel(list);
  assert.deepEqual(m.active, [
    { name:'ASSURANCE IMMEUBLE', ref:'01/23.456', supplier:'Assureur SA', sub:'Assurance', desc:'Couvre le bâtiment' },
    { name:'Eau', ref:'', supplier:'', sub:'Énergie · depuis le 15/03/23', desc:'' } ]);
  assert.deepEqual(m.closed, [{ name:'Gaz', ref:'GAZ-1', supplier:'Gazier', sub:'Énergie · 01/02/22 → 31/01/25', desc:'résilié' }]);
  assert.deepEqual(K.contractsModel(null), { active:[], closed:[] });
});

test('nom de fichier ASCII, daté', () => {
  assert.equal(K.contractsFileName({ copro:{name:'ACP Démo 12'}, at:'2026-11-23T10:00:00Z' }), 'Contrats-en-cours_ACP-Demo-12_2026-11-23.pdf');
});

test('PDF : un vrai fichier, tout le texte y est, plusieurs pages quand la liste est longue', async t => {
  if (!PDFLib || !pdfjs){ t.skip('npm i --no-save pdf-lib@1.17.1 pdfjs-dist@3.11.174 pour ce test'); return; }
  const many = [...list, ...Array.from({length:60}, (_, i) => ({ name:`Contrat ${i}`, ref:`R-${i}`, type:'Autre', note:'Une description assez longue pour passer à la ligne dans sa colonne.', fournisseur:'Fournisseur', status:'actif' }))];
  const bytes = await K.buildContractsPdf(PDFLib, { copro:{name:'ACP Démo', addr:'Rue de l’Exemple 1', kbo:'0123.456.789'}, contracts:many, at:'2026-11-23T10:00:00Z' });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const pdf = await pdfjs.getDocument({ data:new Uint8Array(bytes) }).promise;
  assert.ok(pdf.numPages > 1);
  let txt = '';
  for (let i = 1; i <= pdf.numPages; i++) txt += (await (await pdf.getPage(i)).getTextContent()).items.map(x => x.str).join(' ') + '\n';
  for (const s of ['Contrats en cours', 'ACP Démo', 'ASSURANCE IMMEUBLE', '01/23.456', 'Assureur SA', 'Couvre le bâtiment', 'Contrat 59', 'Contrats clôturés', 'Gaz', 'résilié', `Page ${pdf.numPages} / ${pdf.numPages}`])
    assert.ok(txt.includes(s), `manque : ${s}`);
});
