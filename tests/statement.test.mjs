// Tests de statement.js (relevé de compte PDF).
// Lancer : node --test tests/statement.test.mjs
// Le PDF et sa relecture ont besoin de pdf-lib et pdfjs-dist :
//   npm i --no-save pdf-lib@1.17.1 pdfjs-dist@3.11.174   (sinon ces tests sont sautés)
// Données FICTIVES (ACP Démo, Alex/Sam/Lou).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../statement.js');
const tryReq = id => { try { return require(id); } catch { return null; } };
const PDFLib = tryReq('pdf-lib');
const pdfjs = tryReq('pdfjs-dist/legacy/build/pdf.js');

const TX = [
  { iso:'2025-12-20', tiers:'Engie', note:'Engie', high:'Énergie', sub:'Électricité', amount:-40 },
  { iso:'2026-01-01', tiers:'Alex Martin', note:'Provisions janvier', high:'Charges', sub:'Alex', amount:100.1 },
  { iso:'2026-01-15', tiers:'SEPA Credit Transfer', note:'SEPA Credit Transfer', high:'?', sub:'', amount:0.2, comment:'à vérifier' },
  { iso:'2026-01-15', tiers:'Account subscription', note:'', high:'Frais ACP', sub:'Banque', amount:-0.3 },
  { iso:'2026-01-31', tiers:'Sam Bernard', note:'Provisions', high:'Charges', sub:'Sam', amount:50 },
  { iso:'2026-02-01', tiers:'Après la période', high:'Charges', amount:999 },
  { iso:'', tiers:'Sans date', amount:5 },
];
const base = { acct:'pay', label:'Compte de paiement', holder:'ACP Démo', iban:'be68539007547034', opening:10,
               fromIso:'2026-01-01', toIso:'2026-01-31', asOf:'2026-01-20', tx:TX };

test('solde de début = ouverture + tout ce qui précède la période', () => {
  const d = S.statementData(base);
  assert.equal(d.opening, -30);                       // 10 − 40 (décembre)
  assert.equal(d.rows.length, 4);                     // bornes incluses, hors février, hors sans date
  assert.equal(d.credits, 150.3);                     // en centimes : pas de 150.29999…
  assert.equal(d.debits, 0.3);
  assert.equal(d.closing, 120);                       // −30 + 150,30 − 0,30
  assert.equal(d.rows.at(-1).balance, d.closing);
  assert.deepEqual(d.rows.map(r => r.balance), [70.1, 70.3, 70, 120]);
  assert.equal(d.undated, 1);
});

test('libellés : doublon tiers/communication supprimé, catégorie lisible, note gardée', () => {
  const d = S.statementData(base);
  const [jan1, sepa, fee] = d.rows;
  assert.equal(jan1.label, 'Alex Martin');
  assert.equal(jan1.detail, 'Provisions janvier');
  assert.equal(jan1.category, 'Charges › Alex');
  assert.equal(sepa.detail, '');                      // même libellé de banque : une seule fois
  assert.equal(sepa.category, 'À catégoriser');
  assert.equal(sepa.comment, 'à vérifier');
  assert.equal(fee.label, 'Account subscription');
});

test('même jour : ordre d’origine conservé ; période vide : solde de début = solde disponible', () => {
  const d = S.statementData(base);
  assert.deepEqual(d.rows.slice(1,3).map(r => r.label), ['SEPA Credit Transfer', 'Account subscription']);
  const empty = S.statementData({ ...base, fromIso:'2026-03-01', toIso:'2026-03-31' });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.opening, empty.closing);
  assert.equal(empty.closing, 10 - 40 + 100.1 + 0.2 - 0.3 + 50 + 999);
});

test('formats : montants, dates, IBAN, nom de fichier', () => {
  assert.equal(S.money(1234.5).replace(/\s/g,' '), '1 234,50 €');
  assert.equal(S.money(-2), '-2,00 €');
  assert.equal(S.money(3, true), '+3,00 €');
  assert.equal(S.frDate('2026-01-31'), '31/01/2026');
  assert.equal(S.fmtIban('be68539007547034'), 'BE68 5390 0754 7034');
  const one = S.statementData(base);
  assert.equal(S.statementFileName({ copro:{name:'ACP Démo — Rue de l’Exemple 1'}, accounts:[one] }),
    'Releve_ACP-Demo-Rue-de-l-Exemple-1_paiement_2026-01-01_2026-01-31.pdf');
  assert.match(S.statementFileName({ copro:{name:'ACP Démo'}, accounts:[one, { ...one, acct:'res' }] }), /_comptes_/);
});

async function pdfText(bytes){
  const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++){
    const c = await (await pdf.getPage(i)).getTextContent();
    pages.push(c.items.map(it => it.str).join(' ').replace(/ /g, ' '));
  }
  return { n: pdf.numPages, pages, all: pages.join('\n') };
}

test('PDF : date d’extraction, compte, titulaire, IBAN, solde disponible et chaque mouvement', async t => {
  if (!PDFLib || !pdfjs){ t.skip('npm i --no-save pdf-lib@1.17.1 pdfjs-dist@3.11.174 pour ce test'); return; }
  const a = S.statementData(base);
  const bytes = await S.buildStatementPdf(PDFLib, { copro:{name:'ACP Démo', addr:'Rue de l’Exemple 1, 1000 Bruxelles', kbo:'0123.456.789'},
    extractedAt:'2026-10-25T12:30:00Z', accounts:[a] });
  assert.equal(String.fromCharCode(...bytes.slice(0,5)), '%PDF-');
  const { all, n } = await pdfText(bytes);
  assert.equal(n, 1);
  for (const s of ['Relevé de compte', 'ACP Démo', 'Compte de paiement', 'TITULAIRE DU COMPTE', 'BE68 5390 0754 7034',
                   "DATE D'EXTRACTION", 'Extrait le 25 octobre 2026', 'du 01/01/2026 au 31/01/2026',
                   'SOLDE DISPONIBLE AU 31/01/2026', 'Solde disponible au 31/01/2026 : 120,00 €',
                   'Alex Martin', 'Provisions janvier', 'Charges › Alex', 'Account subscription', 'Note : à vérifier',
                   'À catégoriser', '4 mouvements sur la période', 'arrêté au 20/01/2026', '1 mouvement sans date lisible'])
    assert.ok(all.includes(s), `absent du PDF : ${s}`);
  assert.ok(!all.includes('Après la période'));
  assert.ok(!all.includes('?'), 'un caractère hors WinAnsi a été remplacé par « ? »');
});

test('PDF : deux comptes, synthèse, beaucoup de lignes sur plusieurs pages, en-têtes répétés', async t => {
  if (!PDFLib || !pdfjs){ t.skip('pdf-lib / pdfjs-dist absents'); return; }
  const many = Array.from({length:120}, (_,i) => ({ iso:`2026-0${1+(i%9)}-1${i%9}`, tiers:`Fournisseur ${i}`,
    note:`Communication structurée +++090/9337/55493+++ numéro ${i}`, high:'Entretien', sub:'Jardin', amount: i%3 ? -12.34 : 45.67 }));
  const pay = S.statementData({ ...base, fromIso:'2026-01-01', toIso:'2026-10-25', tx:many });
  const res = S.statementData({ acct:'res', label:'Compte de réserve', holder:'', iban:'', opening:500, fromIso:'2026-01-01', toIso:'2026-10-25', tx:[] });
  const bytes = await S.buildStatementPdf(PDFLib, { copro:{name:'ACP Démo'}, extractedAt:'2026-10-25T12:30:00Z', accounts:[pay, res] });
  const { pages, all, n } = await pdfText(bytes);
  assert.ok(n >= 4, `pages : ${n}`);
  assert.ok(pages[0].includes('Synthèse des comptes') && pages[0].includes('Total disponible'));
  for (let i = 0; i < 120; i++) assert.ok(all.includes(`Fournisseur ${i} `) || all.includes(`Fournisseur ${i}\n`) || all.endsWith(`Fournisseur ${i}`), `ligne ${i}`);
  const resPage = pages.findIndex(p => p.includes('Compte de réserve') && p.includes('Aucun mouvement sur la période'));
  assert.ok(resPage > 0, 'le compte de réserve commence sur sa propre page');
  assert.ok(pages[resPage].includes('Non renseigné'));
  assert.ok(pages.slice(1, resPage).every(p => p.includes('(suite)') && p.includes('LIBELLÉ')), 'pages de suite : en-tête + colonnes');
  assert.ok(pages.every((p, i) => p.includes(`page ${i+1} / ${n}`)));
});

test('PDF : les totaux ne restent jamais seuls sur une page', async t => {
  if (!PDFLib || !pdfjs){ t.skip('pdf-lib / pdfjs-dist absents'); return; }
  for (let n = 1; n <= 70; n++){
    const tx = Array.from({length:n}, (_,i) => ({ iso:'2026-01-0'+(1+i%9), tiers:`Fournisseur ${i}`, note:i%2?`Facture ${i}`:'', high:'Entretien', amount:-10 }));
    const a = S.statementData({ ...base, tx });
    const { pages } = await pdfText(await S.buildStatementPdf(PDFLib, { copro:{name:'ACP Démo'}, extractedAt:'2026-10-25T12:30:00Z', accounts:[a] }));
    const p = pages.find(x => x.includes('Totaux de la période'));
    assert.ok(p && p.includes('Fournisseur ') && p.includes('Solde disponible au 31/01/2026 :'), `n = ${n} : totaux isolés`);
  }
});

test('e-mail : destinataires, brouillon, PDF joint intact', () => {
  const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
  const eml = S.statementEml({ fromName:'Zoé Martin', from:'zoe@exemple.be', to:['sam@exemple.be','lou@exemple.be'],
    subject:'Relevé de compte · ACP Démo', body:'Bonjour,\nCi-joint le relevé.', fileName:'Releve_ACP-Demo.pdf', bytes });
  const head = eml.slice(0, eml.indexOf('\r\n\r\n')).split('\r\n');
  assert.equal(head[0], `From: =?UTF-8?B?${Buffer.from('Zoé Martin').toString('base64')}?= <zoe@exemple.be>`);
  assert.ok(head.includes('To: sam@exemple.be, lou@exemple.be'));
  assert.ok(head.includes('X-Unsent: 1'));
  assert.ok(head.includes(`Subject: =?UTF-8?B?${Buffer.from('Relevé de compte · ACP Démo').toString('base64')}?=`));
  assert.ok(eml.includes('filename="Releve_ACP-Demo.pdf"'));
  const boundary = eml.match(/boundary="([^"]+)"/)[1];
  const parts = eml.split(`--${boundary}`);
  assert.equal(parts.length, 4);                       // préambule, texte, PDF, fin
  const body = Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g,''), 'base64').toString('utf8');
  assert.equal(body, 'Bonjour,\r\nCi-joint le relevé.');
  const att = Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g,''), 'base64');
  assert.deepEqual(new Uint8Array(att), bytes);
  assert.ok(eml.split('\r\n').every(l => l.length <= 998), 'ligne trop longue pour un e-mail');
});
