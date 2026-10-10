/* ============================================================
   LazySyndic — signature des PV d'AG (Dokobit, offre gratuite)
   ------------------------------------------------------------
   PUR : aucun DOM, aucun réseau, aucun état global. Chargé par
   index.html (window.LSSign) et par les tests Node
   (tests/signature.test.mjs). Deux moitiés :

   • buildPvPdf(PDFLib, data) — le PV en PDF texte, prêt à déposer
     sur Dokobit. La lib pdf-lib est injectée (chargée à la demande
     côté navigateur, depuis node_modules côté tests).
   • readSignatures(bytes)    — lit les signatures PAdES d'un PDF
     revenu de Dokobit (itsme, carte eID…) : signataire, date,
     document intact, signature mathématiquement valide.

   Ce que readSignatures NE fait PAS : valider la chaîne de
   confiance (certificat qualifié, révocation). Dokobit le fait à la
   signature ; ici on vérifie que le fichier n'a pas bougé depuis et
   que chaque signature est bien celle de son certificat.
   On ne lit JAMAIS le serialNumber du sujet : sur une eID belge,
   c'est le numéro de registre national.
   ============================================================ */
(function(root){
'use strict';

const subtle = (root.crypto || globalThis.crypto).subtle;

/* ---------- octets ---------- */
function latin1(b){
  let s=''; for(let i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null, b.subarray(i,i+0x8000));
  return s;
}
const toHex = b => Array.from(b, x=>x.toString(16).padStart(2,'0')).join('');
function fromHex(h){
  if(h.length%2) h+='0';
  const out=new Uint8Array(h.length/2);
  for(let i=0;i<out.length;i++) out[i]=parseInt(h.substr(i*2,2),16);
  return out;
}
function concat(...parts){
  const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let o=0;
  for(const p of parts){ out.set(p,o); o+=p.length; }
  return out;
}
function same(a,b){ if(!a||!b||a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }
async function sha256Hex(b){ return toHex(new Uint8Array(await subtle.digest('SHA-256', b))); }

/* ---------- ASN.1 DER (+ BER à longueur indéfinie, au cas où) ---------- */
// Nœud : {cls, cons, tag, p (début du TLV), start (début du contenu), cend (fin du contenu), end (fin du TLV), kids}
function parse(b, p){
  if(p>=b.length) throw new Error('ASN.1 tronqué');
  const t0=b[p]; let q=p+1, tag=t0&0x1f;
  if(tag===0x1f){ tag=0; let c; do{ c=b[q++]; tag=tag*128+(c&0x7f); }while(c&0x80); }
  let l=b[q++];
  const n={cls:t0>>6, cons:(t0&0x20)!==0, tag, p, start:0, cend:0, end:0, kids:null};
  if(l===0x80){
    if(!n.cons) throw new Error('ASN.1 : longueur indéfinie sur un type simple');
    n.start=q; n.kids=[]; let c=q;
    while(!(b[c]===0 && b[c+1]===0)){ const k=parse(b,c); n.kids.push(k); c=k.end; if(c>=b.length) throw new Error('ASN.1 tronqué'); }
    n.cend=c; n.end=c+2; return n;
  }
  if(l&0x80){ const k=l&0x7f; if(k>4) throw new Error('ASN.1 : longueur invalide'); l=0; for(let i=0;i<k;i++) l=l*256+b[q++]; }
  n.start=q; n.cend=n.end=q+l;
  if(n.end>b.length) throw new Error('ASN.1 tronqué');
  if(n.cons){ n.kids=[]; let c=q; while(c<n.cend){ const k=parse(b,c); n.kids.push(k); c=k.end; } }
  return n;
}
const val = (b,n) => b.subarray(n.start, n.cend);
const isCtx = (n,tag) => n && n.cls===2 && n.tag===tag;
function oid(b,n){
  const v=val(b,n); if(!v.length) return '';
  const out=[Math.min(2,Math.floor(v[0]/40)), v[0]-40*Math.min(2,Math.floor(v[0]/40))]; let x=0;
  for(let i=1;i<v.length;i++){ x=x*128+(v[i]&0x7f); if(!(v[i]&0x80)){ out.push(x); x=0; } }
  return out.join('.');
}
function octets(b,n){ return n.cons ? concat(...n.kids.map(k=>octets(b,k))) : val(b,n); }
function intVal(b,n){ let x=0; for(const c of val(b,n)) x=x*256+c; return x; }
function str(b,n){
  const v=val(b,n);
  if(n.tag===30){ let s=''; for(let i=0;i+1<v.length;i+=2) s+=String.fromCharCode(v[i]<<8|v[i+1]); return s; } // BMPString
  if(n.tag===12) return new TextDecoder('utf-8').decode(v);                                                 // UTF8String
  return latin1(v);                                                                                          // Printable, IA5, T61…
}
function asnTime(b,n){
  const s=latin1(val(b,n));
  const m = n.tag===23
    ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})?$/)
    : s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:[.,]\d+)?(Z|[+-]\d{4})?$/);
  if(!m) return null;
  let y=+m[1]; if(n.tag===23) y+= y<50 ? 2000 : 1900;
  let t=Date.UTC(y,+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
  const tz=m[7]||'Z';
  if(tz!=='Z'){ const sg=tz[0]==='-'?-1:1; t-=sg*((+tz.slice(1,3))*60+(+tz.slice(3,5)))*60000; }
  return new Date(t).toISOString();
}
// Date PDF : D:YYYYMMDDHHmmSS+HH'mm'
function pdfDate(s){
  const m=String(s||'').match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/);
  if(!m) return null;
  let t=Date.UTC(+m[1],(+m[2]||1)-1,+m[3]||1,+m[4]||0,+m[5]||0,+m[6]||0);
  if(m[7]==='+'||m[7]==='-'){ const sg=m[7]==='-'?-1:1; t-=sg*((+m[8]||0)*60+(+m[9]||0))*60000; }
  return new Date(t).toISOString();
}

/* ---------- CMS (signature PAdES = CMS détaché) ---------- */
const OID={
  signedData:'1.2.840.113549.1.7.2', tstInfo:'1.2.840.113549.1.9.16.1.4',
  messageDigest:'1.2.840.113549.1.9.4', signingTime:'1.2.840.113549.1.9.5',
  tsToken:'1.2.840.113549.1.9.16.2.14', ski:'2.5.29.14',
  cn:'2.5.4.3', sn:'2.5.4.4', gn:'2.5.4.42', o:'2.5.4.10',
};
const HASH={'1.3.14.3.2.26':'SHA-1','2.16.840.1.101.3.4.2.1':'SHA-256','2.16.840.1.101.3.4.2.2':'SHA-384','2.16.840.1.101.3.4.2.3':'SHA-512'};
const SIGALG={
  '1.2.840.113549.1.1.1':{k:'RSA'},
  '1.2.840.113549.1.1.5':{k:'RSA',h:'SHA-1'},
  '1.2.840.113549.1.1.11':{k:'RSA',h:'SHA-256'},
  '1.2.840.113549.1.1.12':{k:'RSA',h:'SHA-384'},
  '1.2.840.113549.1.1.13':{k:'RSA',h:'SHA-512'},
  '1.2.840.113549.1.1.10':{k:'PSS'},
  '1.2.840.10045.2.1':{k:'EC'},
  '1.2.840.10045.4.3.2':{k:'EC',h:'SHA-256'},
  '1.2.840.10045.4.3.3':{k:'EC',h:'SHA-384'},
  '1.2.840.10045.4.3.4':{k:'EC',h:'SHA-512'},
};
const CURVE={'1.2.840.10045.3.1.7':['P-256',32],'1.3.132.0.34':['P-384',48],'1.3.132.0.35':['P-521',66]};

function parseCms(b){
  const ci=parse(b,0);
  if(!ci.kids || oid(b,ci.kids[0])!==OID.signedData) throw new Error('signature illisible (pas un CMS SignedData)');
  const sd=ci.kids[1].kids[0], k=sd.kids;
  const encap=k[2];
  let certs=[];
  for(let i=3;i<k.length-1;i++) if(isCtx(k[i],0)) certs=k[i].kids||[];
  const eContentType=oid(b,encap.kids[0]);
  const eContent = encap.kids[1] ? octets(b,encap.kids[1].kids[0]) : null;
  return {b, certs, signerInfos:(k[k.length-1].kids||[]), eContentType, eContent};
}
function rdn(b,name){
  const out={};
  for(const set of name.kids||[]) for(const atv of set.kids||[]){
    const k=oid(b,atv.kids[0]);
    if(k==='2.5.4.5') continue;                          // serialNumber = n° national sur une eID : jamais lu
    (out[k]=out[k]||[]).push(str(b,atv.kids[1]));
  }
  return out;
}
function parseCert(b,c){
  const tbs=c.kids[0], j=isCtx(tbs.kids[0],0)?1:0;
  const issuerN=tbs.kids[j+2], subjectN=tbs.kids[j+4], spki=tbs.kids[j+5];
  const algId=spki.kids[0];
  let ski=null;
  for(const x of tbs.kids.slice(j+6)) if(isCtx(x,3)) for(const ext of x.kids[0].kids){
    if(oid(b,ext.kids[0])!==OID.ski) continue;
    const sub=val(b,ext.kids[ext.kids.length-1]), inner=parse(sub,0);
    ski=toHex(val(sub,inner));
  }
  return {
    serial: toHex(val(b,tbs.kids[j])),
    issuerDer: toHex(b.subarray(issuerN.p, issuerN.end)),
    issuer: rdn(b,issuerN), subject: rdn(b,subjectN),
    spki: b.slice(spki.p, spki.end),
    curve: algId.kids[1] && algId.kids[1].tag===6 ? oid(b,algId.kids[1]) : null,
    ski,
  };
}
function parseSignerInfo(b,si){
  const k=si.kids; let i=1;
  const sid=k[i++];
  const digestAlg=oid(b,k[i++].kids[0]);
  let signedAttrs=null; if(isCtx(k[i],0)) signedAttrs=k[i++];
  const sigAlgN=k[i++];
  const sigVal=octets(b,k[i++]);
  const unsigned = isCtx(k[i],1) ? k[i] : null;
  const attrs={}, uattrs={};
  for(const a of (signedAttrs&&signedAttrs.kids)||[]) attrs[oid(b,a.kids[0])]=a.kids[1].kids[0];
  for(const a of (unsigned&&unsigned.kids)||[]) uattrs[oid(b,a.kids[0])]=a.kids[1].kids[0];
  let signedAttrsDer=null;
  if(signedAttrs){ signedAttrsDer=b.slice(signedAttrs.p, signedAttrs.end); signedAttrsDer[0]=0x31; } // [0] IMPLICIT → SET pour la vérif
  const out={b, digestAlg, sigAlg:oid(b,sigAlgN.kids[0]), sigParams:sigAlgN.kids[1]||null, sigVal, attrs, uattrs, signedAttrsDer,
             sidSki:null, sidSerial:null, sidIssuer:null};
  if(isCtx(sid,0)) out.sidSki=toHex(val(b,sid));
  else { out.sidIssuer=toHex(b.subarray(sid.kids[0].p, sid.kids[0].end)); out.sidSerial=toHex(val(b,sid.kids[1])); }
  return out;
}
function pickCert(cms,si){
  const certs=[];
  for(const c of cms.certs){ try{ certs.push(parseCert(cms.b,c)); }catch(e){ /* certificat exotique : ignoré */ } }
  return certs.find(c=> si.sidSki ? c.ski===si.sidSki : (c.serial===si.sidSerial && c.issuerDer===si.sidIssuer))
      || certs.find(c=> si.sidSerial && c.serial===si.sidSerial)
      || certs[0] || null;
}
// Heure d'un jeton d'horodatage (TimeStampToken → TSTInfo.genTime)
function tstTime(tokenBytes){
  const cms=parseCms(tokenBytes);
  if(cms.eContentType!==OID.tstInfo || !cms.eContent) return null;
  const tst=parse(cms.eContent,0);
  return asnTime(cms.eContent, tst.kids[4]);
}
function derToRaw(sig,n){
  const s=parse(sig,0), out=new Uint8Array(2*n);
  [0,1].forEach(j=>{ let v=val(sig,s.kids[j]); while(v.length>n && v[0]===0) v=v.subarray(1); out.set(v, j*n+n-v.length); });
  return out;
}
// true = valide · false = invalide · null = algorithme non vérifiable ici (brainpool, clé PSS exotique…)
async function verifySig(si,cert,data){
  const alg=SIGALG[si.sigAlg]; if(!alg) return null;
  const hash=alg.h || HASH[si.digestAlg]; if(!hash) return null;
  try{
    if(alg.k==='RSA'){
      const key=await subtle.importKey('spki', cert.spki, {name:'RSASSA-PKCS1-v1_5', hash}, false, ['verify']);
      return await subtle.verify('RSASSA-PKCS1-v1_5', key, si.sigVal, data);
    }
    if(alg.k==='PSS'){
      let h='SHA-1', salt=20;                              // valeurs par défaut de RFC 4055
      for(const p of (si.sigParams&&si.sigParams.kids)||[]){
        if(isCtx(p,0)) h=HASH[oid(si.b,p.kids[0].kids[0])]||h;
        if(isCtx(p,2)) salt=intVal(si.b,p.kids[0]);
      }
      const key=await subtle.importKey('spki', cert.spki, {name:'RSA-PSS', hash:h}, false, ['verify']);
      return await subtle.verify({name:'RSA-PSS', saltLength:salt}, key, si.sigVal, data);
    }
    if(alg.k==='EC'){
      const cv=CURVE[cert.curve]; if(!cv) return null;
      const key=await subtle.importKey('spki', cert.spki, {name:'ECDSA', namedCurve:cv[0]}, false, ['verify']);
      return await subtle.verify({name:'ECDSA', hash}, key, derToRaw(si.sigVal,cv[1]), data);
    }
  }catch(e){ return null; }
  return null;
}

/* ---------- PDF : champs de signature ---------- */
function pdfLiteral(s){
  let out=s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g,(m,c)=>
    c==='n'?'\n':c==='r'?'\r':c==='t'?'\t':c==='b'?'\b':c==='f'?'\f':/^[0-7]/.test(c)?String.fromCharCode(parseInt(c,8)):/\n/.test(c)?'':c);
  if(out.charCodeAt(0)===0xfe && out.charCodeAt(1)===0xff){ let u=''; for(let i=2;i+1<out.length;i+=2) u+=String.fromCharCode(out.charCodeAt(i)<<8|out.charCodeAt(i+1)); out=u; }
  return out;
}
function findSigFields(bytes,s){
  const re=/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g, out=[], seen=new Set(); let m;
  while((m=re.exec(s))){
    const br=[+m[1],+m[2],+m[3],+m[4]], key=br.join(',');
    if(seen.has(key) || br[0]+br[1]>br[2] || br[2]+br[3]>bytes.length) continue;
    const raw=s.slice(br[0]+br[1], br[2]).trim();
    if(raw[0]!=='<' || raw[raw.length-1]!=='>') continue;
    seen.add(key);
    // le dictionnaire de signature = l'objet qui entoure /Contents (hors du hex lui-même)
    const objStart=s.lastIndexOf(' obj', br[0]+br[1]), objEnd=s.indexOf('endobj', br[2]);
    const dict=s.slice(Math.max(0,objStart), br[0]+br[1])+' '+s.slice(br[2], objEnd<0 ? br[2]+4000 : objEnd);
    out.push({br, der:fromHex(raw.slice(1,-1).replace(/\s+/g,'')), dict});
  }
  return out;
}
function signerName(cert){
  const S=cert.subject, first=k=>(S[k]||[])[0]||'';
  const cn=first(OID.cn).replace(/\s*\((signature|authentication|authentification|handtekening)\)\s*$/i,'').trim();
  const gn=first(OID.gn), sn=first(OID.sn);
  return { name: cn || [gn,sn].filter(Boolean).join(' '), match: [cn,gn,sn].filter(Boolean).join(' ') };
}
function issuerLabel(cert){
  const I=cert.issuer;
  return (I[OID.cn]||[])[0] || (I[OID.o]||[])[0] || '';
}
function methodOf(cert){
  const txt=[...(cert.issuer[OID.cn]||[]), ...(cert.issuer[OID.o]||[])].join(' ');
  if(/itsme|belgian mobile id/i.test(txt)) return 'itsme';
  if(/citizen ca|foreigner ca|belgium root/i.test(txt)) return 'eID';
  return 'autre';
}

async function analyse(bytes,f){
  const [a,l1,c,l2]=f.br;
  const sub=(f.dict.match(/\/SubFilter\s*\/([A-Za-z0-9.#_-]+)/)||[])[1]||'';
  const rawM=(f.dict.match(/\/M\s*\(((?:\\.|[^\\)])*)\)/)||[])[1];
  const pdfM=rawM ? pdfLiteral(rawM) : '';                  // (D\07220261005…) chez certains outils
  const pdfName=(f.dict.match(/\/Name\s*\(((?:\\.|[^\\)])*)\)/)||[])[1];
  const out={kind:'signature', end:c+l2, subFilter:sub, name:'', match:'', pdfName:pdfName?pdfLiteral(pdfName):'',
             issuer:'', method:'autre', at:null, atSource:null, digestOk:null, sigOk:null, error:null};
  if(/\/Type\s*\/DocTimeStamp/.test(f.dict) || sub==='ETSI.RFC3161') out.kind='timestamp';
  try{
    const cms=parseCms(f.der);
    if(cms.eContentType===OID.tstInfo){                    // horodatage du document (PAdES B-LTA)
      out.kind='timestamp';
      out.at=tstTime(f.der); out.atSource='tsa';
      return out;
    }
    if(!cms.signerInfos.length) throw new Error('aucun signataire dans la signature');
    const si=parseSignerInfo(cms.b, cms.signerInfos[0]);
    const cert=pickCert(cms,si);
    if(cert){ Object.assign(out, signerName(cert)); out.issuer=issuerLabel(cert); out.method=methodOf(cert); }
    if(!out.name) out.name=out.pdfName;
    // l'heure : jeton d'horodatage > signingTime CMS > /M du PDF (déclaratif)
    const tok=si.uattrs[OID.tsToken];
    if(tok){ try{ out.at=tstTime(cms.b.subarray(tok.p, tok.end)); if(out.at) out.atSource='tsa'; }catch(e){} }
    if(!out.at && si.attrs[OID.signingTime]){ out.at=asnTime(cms.b, si.attrs[OID.signingTime]); out.atSource='cms'; }
    if(!out.at && pdfM){ out.at=pdfDate(pdfM); out.atSource='pdf'; }
    // intégrité : empreinte des octets signés == messageDigest, puis la signature elle-même
    const signed=concat(bytes.subarray(a,a+l1), bytes.subarray(c,c+l2));
    const hash=HASH[si.digestAlg];
    if(si.signedAttrsDer){
      const md=si.attrs[OID.messageDigest];
      if(md && hash) out.digestOk=same(new Uint8Array(await subtle.digest(hash, signed)), octets(cms.b,md));
      if(cert) out.sigOk=await verifySig(si,cert,si.signedAttrsDer);
    } else if(cert) out.sigOk=await verifySig(si,cert,signed);
  }catch(e){ out.error=String(e && e.message || e); }
  return out;
}

/**
 * Lit les signatures d'un PDF.
 * → { signatures:[{name, match, issuer, method:'itsme'|'eID'|'autre', at, atSource:'tsa'|'cms'|'pdf'|null,
 *                  digestOk, sigOk, error, end}],
 *     timestamps:[…], tail:null|'none'|'dss'|'autre', size }
 * tail = ce qui suit la dernière signature : 'none' (rien), 'dss' (données de validation
 * ajoutées après coup — normal en signature longue durée), 'autre' (le fichier a bougé).
 */
async function readSignatures(input){
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const head=latin1(bytes.subarray(0,1024));
  if(!/%PDF-/.test(head)) throw new Error('ce fichier n’est pas un PDF');
  const s=latin1(bytes);
  const all=[];
  for(const f of findSigFields(bytes,s)) all.push(await analyse(bytes,f));
  all.sort((x,y)=>x.end-y.end);
  let tail=null;
  if(all.length){
    const rest=s.slice(Math.max(...all.map(x=>x.end)));
    tail = /^\s*(%%EOF\s*)?$/.test(rest) ? 'none' : (/\/DSS\b/.test(rest) ? 'dss' : 'autre');
  }
  return { signatures:all.filter(x=>x.kind==='signature'), timestamps:all.filter(x=>x.kind==='timestamp'), tail, size:bytes.length };
}

/* ---------- noms ---------- */
function nameTokens(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .split(/[^a-z0-9]+/).filter(t=>t.length>1);
}
// « Alex Martin » == « Alex Jean Martin » (prénoms en plus sur la carte) ; « Alex Martin » != « Lou Martin »
function sameName(a,b){
  const A=nameTokens(a), B=nameTokens(b); if(!A.length || !B.length) return false;
  const [s,l]=A.length<=B.length?[A,B]:[B,A];
  return s.every(t=>l.includes(t));
}
// expected : [{name, roles}] → [{…, sig: index dans sigs ou -1}] + extras (signatures sans attente)
function matchSigners(expected, sigs){
  const used=new Set();
  const rows=expected.map(e=>{
    const i=sigs.findIndex((s,k)=>!used.has(k) && sameName(e.name, s.match||s.name));
    if(i>=0) used.add(i);
    return {...e, sig:i};
  });
  return { rows, extras: sigs.map((s,k)=>k).filter(k=>!used.has(k)) };
}

/* ============================================================
   PV en PDF (pdf-lib)
   data = { copro, type, dateLabel, lieu, convocation, president, secretaire,
            presences:[{name, quot, status}], attendance:{n, of, q, tot},
            points:[{n, title, body, notes, info?, maj, rule, pour, contre, abst, adopted}],
            signers:[{name, roles:[]}], generatedAt (ISO) }
   ============================================================ */
const SUBST={'\u202f':' ','\u2009':' ','\u2007':' ','\t':' ','\u2192':'->','\u2190':'<-','\u2713':'OK','\u2714':'OK','\u2265':'>=','\u2264':'<=','\u2260':'!=','\u2011':'-','\u2010':'-'};
async function buildPvPdf(PDFLib, d){
  const {PDFDocument, StandardFonts, rgb} = PDFLib;
  const doc=await PDFDocument.create();
  const F={ r:await doc.embedFont(StandardFonts.Helvetica), b:await doc.embedFont(StandardFonts.HelveticaBold),
            i:await doc.embedFont(StandardFonts.HelveticaOblique) };
  const cs=new Set(F.r.getCharacterSet());
  const safe=t=>[...String(t==null?'':t).replace(/\r/g,'')].map(ch=>
    ch==='\n'||cs.has(ch.codePointAt(0)) ? ch : (SUBST[ch]!==undefined ? SUBST[ch] : (/\s/.test(ch)?' ':'?'))).join('');
  const C={ ink:rgb(.13,.16,.13), soft:rgb(.40,.43,.40), line:rgb(.80,.82,.79), green:rgb(.13,.40,.27), red:rgb(.62,.20,.15) };
  const W=595.28, H=841.89, M=56, CW=W-2*M, BOTTOM=M+26;
  const pages=[]; let page, y;
  const newPage=()=>{ page=doc.addPage([W,H]); pages.push(page); y=H-M; };
  const need=h=>{ if(y-h<BOTTOM) newPage(); };
  function wrap(text,font,size,width){
    const out=[];
    for(const para of safe(text).split('\n')){
      let line='';
      for(const word of para.split(/ +/)){
        const tryL=line?line+' '+word:word;
        if(font.widthOfTextAtSize(tryL,size)<=width){ line=tryL; continue; }
        if(line) out.push(line);
        let w=word;                                         // mot plus large que la colonne : coupé
        while(font.widthOfTextAtSize(w,size)>width){
          let k=w.length; while(k>1 && font.widthOfTextAtSize(w.slice(0,k),size)>width) k--;
          out.push(w.slice(0,k)); w=w.slice(k);
        }
        line=w;
      }
      out.push(line);
    }
    return out;
  }
  function para(text,{font=F.r,size=10.5,color=C.ink,indent=0,gap=5,lh=1.38}={}){
    for(const l of wrap(text,font,size,CW-indent)){ need(size*lh); page.drawText(l,{x:M+indent,y:y-size,size,font,color}); y-=size*lh; }
    y-=gap;
  }
  function heading(t){ need(40); y-=8; para(t,{font:F.b,size:12.5,gap:2}); page.drawLine({start:{x:M,y:y},end:{x:W-M,y:y},thickness:.6,color:C.line}); y-=10; }
  function table(cols,rows){
    const size=10, lh=1.35, pad=4;
    const draw=(cells,font)=>{
      const lines=cells.map((t,k)=>wrap(t,font,size,cols[k].w-2*pad));
      const h=Math.max(...lines.map(l=>l.length))*size*lh+2*pad;
      need(h);
      let x=M;
      lines.forEach((ls,k)=>{ ls.forEach((l,j)=>{
        const tw=font.widthOfTextAtSize(l,size);
        const tx=cols[k].right ? x+cols[k].w-pad-tw : x+pad;
        page.drawText(l,{x:tx,y:y-pad-size-j*size*lh,size,font,color:C.ink}); }); x+=cols[k].w; });
      y-=h; page.drawLine({start:{x:M,y},end:{x:M+cols.reduce((n,c)=>n+c.w,0),y},thickness:.4,color:C.line});
    };
    draw(cols.map(c=>c.label),F.b);
    rows.forEach(r=>draw(r,F.r));
    y-=8;
  }

  newPage();
  para('Procès-verbal',{font:F.b,size:21,gap:2,color:C.green});
  para(`Assemblée générale ${String(d.type||'ordinaire').toLowerCase()} des copropriétaires — ${d.copro}`,{font:F.b,size:12.5,gap:10});
  para(`Date : ${d.dateLabel||'—'}`,{gap:1});
  para(`Lieu : ${d.lieu||'—'}`,{gap:1});
  if(d.convocation) para(`Convocation envoyée le : ${d.convocation}`,{gap:1});
  y-=4;

  heading('Bureau de séance');
  para(`Président de séance : ${d.president||'—'}`,{gap:1});
  para(`Secrétaire : ${d.secretaire||'—'}`,{gap:2});

  heading('Présences');
  table([{w:CW*0.46,label:'Copropriétaire'},{w:CW*0.16,label:'Quotités',right:true},{w:CW*0.38,label:'Présence'}],
        (d.presences||[]).map(p=>[p.name,String(p.quot),p.status]));
  const at=d.attendance||{};
  para(`Présents ou représentés : ${at.n} copropriétaire(s) sur ${at.of}, totalisant ${at.q} / ${at.tot} quotités.`);

  heading('Ordre du jour et décisions');
  (d.points||[]).forEach(p=>{
    need(60);
    para(`${p.n}. ${p.title||''}`,{font:F.b,size:11,gap:3});
    if(p.body) para(p.body,{indent:14,color:C.soft,gap:3});
    if(p.notes) para(`Débats : ${p.notes}`,{indent:14,font:F.i,gap:3});
    if(p.info){ para('Point d’information — pas de vote.',{indent:14,font:F.i,color:C.soft,gap:8}); return; }
    const g=(lbl,x)=>`${lbl} : ${x.names.length?x.names.join(', '):'—'} (${x.q} quotités)`;
    para(`Majorité requise : ${p.maj} — ${p.rule}.`,{indent:14,gap:1});
    para(g('Pour',p.pour),{indent:14,gap:1});
    para(g('Contre',p.contre),{indent:14,gap:1});
    para(g('Abstention',p.abst),{indent:14,gap:3});
    para(`Décision : ${p.adopted?'ADOPTÉE':'REJETÉE'}`,{indent:14,font:F.b,color:p.adopted?C.green:C.red,gap:8});
  });

  need(240);                                             // texte + première rangée de cadres : jamais séparés
  heading('Signatures');
  para('Le présent procès-verbal a été lu en fin de séance. Conformément à l’article 3.87, § 10, du Code civil, il est signé par le président de séance, le secrétaire et les copropriétaires présents ou leurs mandataires.',{gap:4});
  para('Signature électronique qualifiée (itsme ou carte d’identité, via Dokobit), contenue dans le fichier. Chaque cadre accueille le visuel de la signature ou, sur papier, la signature manuscrite.',{color:C.soft,gap:10});
  // un cadre par signataire, deux par ligne : nom, rôles, place pour signer
  const GAP=14, BW=(CW-GAP)/2, BH=104, PAD=9;
  const signers=d.signers||[];
  for(let i=0;i<signers.length;i+=2){
    need(BH+GAP);
    signers.slice(i,i+2).forEach((s,k)=>{
      const x=M+k*(BW+GAP), top=y;
      page.drawRectangle({x, y:top-BH, width:BW, height:BH, borderColor:C.line, borderWidth:.8});
      const name=wrap(s.name,F.b,10.5,BW-2*PAD)[0]||'';
      page.drawText(name,{x:x+PAD, y:top-PAD-10.5, size:10.5, font:F.b, color:C.ink});
      wrap(s.roles.join(' · '),F.r,8.5,BW-2*PAD).slice(0,2).forEach((l,j)=>
        page.drawText(l,{x:x+PAD, y:top-PAD-24-j*11, size:8.5, font:F.r, color:C.soft}));
      page.drawLine({start:{x:x+PAD,y:top-BH+20},end:{x:x+BW-PAD,y:top-BH+20},thickness:.5,color:C.line,dashArray:[2,2]});
      page.drawText(safe('Signature'),{x:x+PAD, y:top-BH+8, size:7.5, font:F.i, color:C.soft});
    });
    y-=BH+GAP;
  }

  const foot=`${d.copro} — PV de l’AG du ${d.dateLabel||'—'}`;
  pages.forEach((pg,i)=>{
    pg.drawText(safe(foot),{x:M,y:M-14,size:8,font:F.r,color:C.soft});
    const r=safe(`page ${i+1} / ${pages.length}`);
    pg.drawText(r,{x:W-M-F.r.widthOfTextAtSize(r,8),y:M-14,size:8,font:F.r,color:C.soft});
  });
  const when=new Date(d.generatedAt||Date.now());
  doc.setTitle(safe(`PV AG ${d.dateLabel||''} — ${d.copro}`));
  doc.setAuthor(safe(d.secretaire||'LazySyndic'));
  doc.setCreator('LazySyndic'); doc.setProducer('LazySyndic (pdf-lib)');
  doc.setLanguage('fr-BE');
  doc.setCreationDate(when); doc.setModificationDate(when);
  return await doc.save({useObjectStreams:false});
}

const api={ buildPvPdf, readSignatures, matchSigners, sameName, nameTokens, sha256Hex };
root.LSSign=api;
if(typeof module==='object' && module.exports) module.exports=api;
})(typeof window!=='undefined' ? window : globalThis);
