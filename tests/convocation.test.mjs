// Tests de convocation.js (convocation à l'AG : e-mail mis en page, .eml, .ics, PDF).
// Lancer : node --test tests/convocation.test.mjs — aucune dépendance ; le test PDF a besoin
// de pdf-lib (npm i --no-save pdf-lib@1.17.1), sinon il est sauté.
// Données FICTIVES (ACP Démo, Alex/Sam/Lou).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../convocation.js');
const tryReq = id => { try { return require(id); } catch { return null; } };
const PDFLib = tryReq('pdf-lib');

const base = () => ({
  copro: { name:'ACP Démo', addr:'Rue Fictive 1, 1000 Bruxelles', kbo:'0123.456.789' },
  type:'ordinaire', dateLabel:'22/06/2026 19h00', dateLong:'lundi 22 juin 2026', timeLabel:'19h00',
  start: new Date(2026, 5, 22, 19, 0), lieu:'Appartement RDC',
  points: [
    { n:1, title:'Approbation des comptes <2025>', kind:'decision', maj:'Majorité absolue', pct:51, body:'Comptes joints.\nQuestions bienvenues.' },
    { n:2, title:'Toiture : état des lieux', kind:'info', maj:'', pct:0, body:'' },
    { n:3, title:'Travaux de façade', kind:'decision', maj:'Double tiers', pct:67, body:'Deux devis en annexe.' },
  ],
  syndic: { name:'Alex Martin', email:'alex@exemple.be' },
  sentLabel:'25/10/2026', delayDays:240, recipient:null,
  logoSrc:'https://exemple.be/brand/icon-180.png', logo:null,
});
const b64dec = s => Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
// les parties d'un .eml : leur Content-Type et leur corps brut (base64), jusqu'à la frontière suivante
function parts(eml){
  const out = [], lines = eml.split('\r\n');
  for (let i = 0; i < lines.length; i++){
    const m = /^Content-Type: ([^;]+)/.exec(lines[i]); if (!m) continue;
    while (i < lines.length && lines[i] !== '') i++;                       // fin des en-têtes
    const body = [];
    for (i++; i < lines.length && !lines[i].startsWith('--'); i++) body.push(lines[i]);
    out.push({ type:m[1], raw:body.join('\r\n') }); i--;
  }
  return out;
}

test('objet et texte brut : copropriété, type, date, lieu, points et règles de la séance', () => {
  const d = base();
  assert.equal(C.subject(d), 'Convocation — Assemblée générale ordinaire — ACP Démo — 22/06/2026 19h00');
  const t = C.text(d);
  assert.match(t, /^Madame, Monsieur, cher\(e\) copropriétaire,/);
  assert.match(t, /syndic de ACP Démo/);
  assert.match(t, /Date : Lundi 22 juin 2026 à 19h00/);
  assert.match(t, /Lieu : Appartement RDC/);
  assert.match(t, /1\. Approbation des comptes <2025> — décision \(Majorité absolue\)\n   Comptes joints\.\n   Questions bienvenues\./);
  assert.match(t, /2\. Toiture : état des lieux — information/);
  assert.match(t, /Quorum — /); assert.match(t, /Procuration — /); assert.match(t, /art\. 3\.88/);
  assert.match(t, /240 jours avant la séance/);
  assert.match(t, /Alex Martin — Syndic, ACP Démo\nalex@exemple\.be/);
});

test('sans date lisible ni délai : la date telle que saisie, le rappel des quinze jours', () => {
  const d = { ...base(), dateLong:'', timeLabel:'', start:null, delayDays:null, dateLabel:'fin juin, 19h' };
  assert.equal(C.when(d), 'fin juin, 19h');
  assert.match(C.text(d), /Date : fin juin, 19h/);
  assert.match(C.text(d), /au moins quinze jours avant la séance/);
  assert.equal(C.ics(d), null);
});

test('HTML : bandeau, points échappés et typés, règles, pièce jointe, signature, logo', () => {
  const h = C.html(base());
  assert.match(h, /^<!DOCTYPE html>/);
  assert.match(h, /<title>Convocation — Assemblée générale ordinaire — ACP Démo/);
  assert.match(h, /Assemblée générale ordinaire<\/div>/);
  assert.match(h, />ACP Démo<\/div>/);
  assert.match(h, /Rue Fictive 1, 1000 Bruxelles · BCE 0123\.456\.789/);
  assert.match(h, /Lundi 22 juin 2026<br>19h00/);
  assert.match(h, />Appartement RDC<\/div>/);
  assert.match(h, /Approbation des comptes &lt;2025&gt;/);              // échappé
  assert.doesNotMatch(h, /<2025>/);
  assert.match(h, /Comptes joints\.<br>Questions bienvenues\./);
  assert.equal((h.match(/>Décision<\/span>/g) || []).length, 2);
  assert.equal((h.match(/>Information<\/span>/g) || []).length, 1);
  assert.match(h, /Majorité absolue · 51 %/); assert.match(h, /Double tiers · 67 %/);
  assert.match(h, /3 points à l’ordre du jour · 2 décisions à prendre/);
  assert.match(h, /<b>Pièce jointe<\/b>/);
  for (const k of ['Délai', 'Quorum', 'Procuration', 'Votes', 'Documents', 'Procès-verbal']) assert.match(h, new RegExp('>' + k + '</td>'));
  assert.match(h, /src="https:\/\/exemple\.be\/brand\/icon-180\.png"/);
  assert.match(h, /mailto:alex@exemple\.be/);
  // moteur Word d'Outlook : tableaux et styles inline, pas de variable CSS ni de SVG
  assert.doesNotMatch(h, /var\(--/); assert.doesNotMatch(h, /<svg/); assert.doesNotMatch(h, /<style/);
  assert.match(h, /#005F45/);
  // le corps seul (presse-papiers) est contenu dans le document
  assert.ok(h.includes(C.htmlBody(base())));
});

test('nominatif : le copropriétaire est nommé, ses lots repris', () => {
  const d = { ...base(), recipient:{ name:'Sam Bernard', lots:'App. 2e étage' } };
  assert.match(C.text(d), /^Sam Bernard,\n/);
  assert.match(C.html(d), /font-weight:700;color:#1D2A24">Sam Bernard,<\/p>/);
  assert.equal(C.fileName(d, 'eml'), 'Convocation_AG_ACP-Demo_2026-06-22_Sam-Bernard.eml');
  assert.equal(C.fileName(base(), 'pdf'), 'Convocation_AG_ACP-Demo_2026-06-22.pdf');
});

test('.ics : un rendez-vous de deux heures, ordre du jour en description', () => {
  const ics = C.ics(base());
  assert.match(ics, /BEGIN:VCALENDAR\r\n/); assert.match(ics, /METHOD:PUBLISH/);
  const s = /DTSTART:(\d{8}T\d{6}Z)/.exec(ics), e = /DTEND:(\d{8}T\d{6}Z)/.exec(ics);
  assert.ok(s && e, 'DTSTART / DTEND en UTC');
  const toDate = x => new Date(x.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
  assert.equal(toDate(e[1]) - toDate(s[1]), 2*3600*1000);
  assert.equal(toDate(s[1]).getTime(), new Date(2026, 5, 22, 19, 0).getTime());
  assert.match(ics, /SUMMARY:Assemblée générale ordinaire — ACP Démo/);
  assert.match(ics, /LOCATION:Appartement RDC/);
  assert.match(ics.replace(/\r\n /g, ''), /DESCRIPTION:1\. Approbation des comptes <2025>\\n2\. Toiture : état des lieux\\n3\. Travaux de façade/);
  assert.ok(ics.split('\r\n').every(l => l.length <= 75), 'lignes de 75 caractères au plus');
});

test('.eml : brouillon Outlook (X-Unsent), texte + HTML avec logo inline, PDF et .ics joints', () => {
  const d = base();
  const eml = C.eml({ from:'alex@exemple.be', fromName:'Alex Martin', to:['sam@exemple.be', 'lou@exemple.be'],
    subject:C.subject(d), text:C.text(d), html:C.html({ ...d, logoSrc:'cid:logo@lazysyndic' }),
    logo:{ bytes:new Uint8Array([137, 80, 78, 71]), cid:'logo@lazysyndic' },
    pdf:{ name:'Convocation AG.pdf', bytes:new Uint8Array([37, 80, 68, 70]) },
    ics:{ name:'assemblee-generale.ics', text:C.ics(d) } });
  const head = eml.split('\r\n\r\n')[0];
  assert.match(head, /^From: Alex Martin <alex@exemple\.be>\r\nTo: sam@exemple\.be, lou@exemple\.be\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(head, /\r\nX-Unsent: 1\r\n/);
  assert.match(head, /Content-Type: multipart\/mixed; boundary="=_LazySyndic_mix_/);
  assert.match(eml, /Content-Type: multipart\/alternative; boundary="=_LazySyndic_alt_/);
  assert.match(eml, /Content-Type: multipart\/related; boundary="=_LazySyndic_rel_[^"]+"; type="text\/html"/);
  const p = parts(eml);
  const txt = p.find(x => x.type === 'text/plain'), html = p.find(x => x.type === 'text/html');
  assert.match(b64dec(txt.raw), /Madame, Monsieur, cher\(e\) copropriétaire,/);
  assert.match(b64dec(html.raw), /src="cid:logo@lazysyndic"/);
  assert.match(eml, /Content-Type: image\/png; name="logo\.png"\r\nContent-ID: <logo@lazysyndic>\r\nContent-Disposition: inline/);
  assert.match(eml, /Content-Type: application\/pdf; name="Convocation_AG\.pdf"\r\nContent-Disposition: attachment; filename="Convocation_AG\.pdf"/);
  assert.match(eml, /Content-Type: text\/calendar; charset="utf-8"; method=PUBLISH; name="assemblee-generale\.ics"/);
  assert.equal(b64dec(p.find(x => x.type === 'application/pdf').raw), '%PDF');
  // les lignes base64 ne dépassent pas 76 caractères, les frontières sont fermées
  assert.ok(eml.split('\r\n').filter(l => /^[A-Za-z0-9+/=]+$/.test(l)).every(l => l.length <= 76));
  assert.equal((eml.match(/--=_LazySyndic_(?:mix|alt|rel)_[A-Za-z0-9]+--\r\n/g) || []).length, 3);
});

test('.eml sans pièce jointe ni logo : multipart/alternative seul, pas de From sans adresse', () => {
  const d = base();
  const eml = C.eml({ from:'', to:[], subject:'Objet', text:'Texte', html:'<p>HTML</p>', logo:null, pdf:null, ics:null });
  assert.doesNotMatch(eml, /^From:/m);
  assert.match(eml, /^To: \r\nSubject: Objet\r\nMIME-Version: 1\.0\r\nX-Unsent: 1\r\nContent-Type: multipart\/alternative; boundary=/);
  assert.doesNotMatch(eml, /multipart\/(mixed|related)/);
  assert.equal(b64dec(parts(eml).find(x => x.type === 'text/html').raw), '<p>HTML</p>');
  void d;
});

test('PDF : lettre + procuration, deux pages, métadonnées', { skip: !PDFLib && 'pdf-lib absent (npm i --no-save pdf-lib@1.17.1)' }, async () => {
  const d = { ...base(), recipient:{ name:'Sam Bernard', lots:'App. 2e étage' } };
  const bytes = await C.buildPdf(PDFLib, d);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2 && doc.getPageCount() <= 3, 'lettre (une ou deux pages) + procuration');
  assert.equal(doc.getTitle(), "Convocation à l'assemblée générale ordinaire · ACP Démo · Sam Bernard");
  assert.equal(doc.getAuthor(), 'ACP Démo');
  assert.equal(doc.getCreator(), 'LazySyndic');
  // beaucoup de points : l'ordre du jour et les instructions de vote passent sur d'autres pages sans casser
  const many = { ...base(), points: Array.from({ length: 40 }, (_, i) => ({ n:i+1, title:`Point ${i+1} — un intitulé assez long pour replier la ligne du tableau`, kind:'decision', maj:'Majorité absolue', pct:51, body:'Texte du point, sur une ligne ou deux, pour remplir la page.' })) };
  const big = await PDFLib.PDFDocument.load(await C.buildPdf(PDFLib, many));
  assert.ok(big.getPageCount() >= 4);
});
