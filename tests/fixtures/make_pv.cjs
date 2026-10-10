const PDFLib=require('pdf-lib'); const S=require('../../signature.js'); const fs=require('fs');
const data={copro:'ACP Démo — Rue de l’Exemple 1', type:'Ordinaire', dateLabel:'22 juin 2026 · 19h00', lieu:'Appartement RDC — sur place', convocation:'05/06/2026',
 president:'Alex Martin', secretaire:'Alex Martin',
 presences:[{name:'Alex Martin',quot:500,status:'Présent'},{name:'Sam Bernard',quot:251,status:'Présent'},{name:'Lou Petit',quot:249,status:'Représenté par Jo Petit'}],
 attendance:{n:3,of:3,q:1000,tot:1000},
 points:[{n:1,title:'Approbation des comptes 2025',body:'Comptes arrêtés au 31/12/2025, solde réserve 1 234,56 € → voir annexe.',notes:'Aucune remarque ✓',maj:'Majorité simple',rule:'plus de la moitié des 1000 quotités exprimées',pour:{names:['Alex Martin','Sam Bernard'],q:751},contre:{names:['Jo Petit (pour Lou Petit)'],q:249},abst:{names:[],q:0},adopted:true},
  {n:2,title:'Information — travaux de toiture',body:'Devis reçus ; décision à la prochaine AG.',info:true},
  {n:3,title:'Décharge au syndic',maj:'Majorité simple',rule:'plus de la moitié des 1000 quotités exprimées',pour:{names:['Sam Bernard'],q:251},contre:{names:['Alex Martin'],q:500},abst:{names:['Jo Petit (pour Lou Petit)'],q:249},adopted:false}],
 signers:[{name:'Alex Martin',roles:['Président de séance','Secrétaire','Copropriétaire présent']},{name:'Sam Bernard',roles:['Copropriétaire présent']},{name:'Jo Petit',roles:['Mandataire de Lou Petit']}],
 generatedAt:'2026-10-05T12:00:00Z'};
(async()=>{ const b=await S.buildPvPdf(PDFLib,data); fs.writeFileSync(__dirname+'/pv-a-signer.pdf',b); console.log('pdf',b.length, await S.sha256Hex(b)); })();
