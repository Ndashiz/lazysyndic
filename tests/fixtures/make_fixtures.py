# Fabrique les PDF PAdES de tests/signature.test.mjs, à partir de pv-a-signer.pdf
# (généré par make_pv.cjs). Rien ne tourne en CI : relancer à la main si le format change.
#   npm i --no-save pdf-lib@1.17.1 && node make_pv.cjs
#   pip install pyhanko && python make_fixtures.py
# 3 signataires FICTIFS : « Alex Martin » (eID-like, ECDSA P-384/SHA-384), « Sam Bernard »
# (itsme-like, RSA + horodatage), « Jo Petit » (RSA-PSS), + horodatage de document et variantes altérées.
# + horodatage de document, + variantes altérées. Noms fictifs uniquement.
import datetime, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec
from pyhanko.sign import signers, fields, timestamps
from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko_certvalidator.registry import SimpleCertificateStore
from asn1crypto import x509 as ax, keys as ak

now = datetime.datetime(2026,10,5,10,0,tzinfo=datetime.timezone.utc)
def name(**kw):
    m={'cn':NameOID.COMMON_NAME,'gn':NameOID.GIVEN_NAME,'sn':NameOID.SURNAME,'c':NameOID.COUNTRY_NAME,'o':NameOID.ORGANIZATION_NAME,'serial':NameOID.SERIAL_NUMBER}
    return x509.Name([x509.NameAttribute(m[k],v) for k,v in kw.items()])
def mk(subject, key, issuer_name, issuer_key, ca=False, eku_ts=False):
    b=(x509.CertificateBuilder().subject_name(subject).issuer_name(issuer_name).public_key(key.public_key())
       .serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=30)).not_valid_after(now+datetime.timedelta(days=3650))
       .add_extension(x509.BasicConstraints(ca=ca,path_length=None),critical=True)
       .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),critical=False))
    if eku_ts: b=b.add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.TIME_STAMPING]),critical=True)
    return b.sign(issuer_key, hashes.SHA256())
A=lambda c: ax.Certificate.load(c.public_bytes(serialization.Encoding.DER))
K=lambda k: ak.PrivateKeyInfo.load(k.private_bytes(serialization.Encoding.DER,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))

root_k=rsa.generate_private_key(public_exponent=65537,key_size=2048); root_n=name(cn='LazySyndic TEST Root',c='BE')
root=mk(root_n,root_k,root_n,root_k,ca=True)
eid_k=ec.generate_private_key(ec.SECP384R1()); eid_n=name(cn='Citizen CA TEST',c='BE'); eid_ca=mk(eid_n,eid_k,root_n,root_k,ca=True)
its_k=rsa.generate_private_key(public_exponent=65537,key_size=2048); its_n=name(cn='itsme Sign Issuing CA TEST',o='Belgian Mobile ID TEST',c='BE'); its_ca=mk(its_n,its_k,root_n,root_k,ca=True)
tsa_k=rsa.generate_private_key(public_exponent=65537,key_size=2048); tsa=mk(name(cn='TEST TSA',c='BE'),tsa_k,root_n,root_k,eku_ts=True)

alex_k=ec.generate_private_key(ec.SECP384R1())
alex=mk(name(cn='Alex Martin (Signature)',sn='Martin',gn='Alex Jean',serial='99010100197',c='BE'),alex_k,eid_n,eid_k)
sam_k=rsa.generate_private_key(public_exponent=65537,key_size=2048)
sam=mk(name(cn='Sam Bernard',gn='Sam',sn='Bernard',c='BE'),sam_k,its_n,its_k)
jo_k=rsa.generate_private_key(public_exponent=65537,key_size=2048)
jo=mk(name(cn='Jo Petit',gn='Jo',sn='Petit',c='BE'),jo_k,its_n,its_k)

store=lambda *cs: SimpleCertificateStore.from_certs([A(c) for c in cs])
tsr=DummyTimeStamper(tsa_cert=A(tsa),tsa_key=K(tsa_k),certs_to_embed=store(root),fixed_dt=now+datetime.timedelta(minutes=7))

def sign(src,dst,cert,key,chain,field,md,pss=False,ts=None):
    s=signers.SimpleSigner(signing_cert=A(cert),signing_key=K(key),cert_registry=store(*chain),prefer_pss=pss)
    meta=signers.PdfSignatureMetadata(field_name=field,md_algorithm=md,subfilter=fields.SigSeedSubFilter.PADES)
    with open(src,'rb') as f:
        w=IncrementalPdfFileWriter(f)
        out=signers.sign_pdf(w,meta,signer=s,timestamper=ts,bytes_reserved=12000)
    open(dst,'wb').write(out.getvalue())

sign('pv-a-signer.pdf','s1.pdf',alex,alex_k,[eid_ca,root],'Sig1','sha384')
sign('s1.pdf','s2.pdf',sam,sam_k,[its_ca,root],'Sig2','sha256',ts=tsr)
sign('s2.pdf','pv-signe-3.pdf',jo,jo_k,[its_ca,root],'Sig3','sha256',pss=True)
# horodatage de document (PAdES B-LTA) par-dessus
with open('pv-signe-3.pdf','rb') as f:
    w=IncrementalPdfFileWriter(f)
    out=signers.PdfTimeStamper(tsr).timestamp_pdf(w,'sha256')
open('pv-signe-3-docts.pdf','wb').write(out.getvalue())
# variante altérée : un octet changé dans le contenu signé (dans le titre du PV)
b=bytearray(open('pv-signe-3.pdf','rb').read()); i=b.find(b'Pro'); b[i]=ord('X'); open('pv-altere.pdf','wb').write(bytes(b))
# variante : PDF modifié APRES la dernière signature (mise à jour incrémentale quelconque)
b=open('pv-signe-3.pdf','rb').read()+b'\n99 0 obj\n<</Type/Annot/Subtype/Text/Contents(ajout)>>\nendobj\n%%EOF\n'; open('pv-ajout.pdf','wb').write(b)
# variante : seulement 2 signatures sur 3
os.replace('s2.pdf','pv-signe-2.pdf'); os.remove('s1.pdf'); os.remove('pv-signe-3.pdf')
for f in ['pv-signe-2.pdf','pv-signe-3-docts.pdf','pv-altere.pdf','pv-ajout.pdf']: print(f, os.path.getsize(f))
