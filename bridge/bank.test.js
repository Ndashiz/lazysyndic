// Run: node --test  (from bridge/)  — no dependencies. Données FICTIVES (Alex/Sam/Lou).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signedAmount, mapBankTx, assignRefs, dedupe, syncFrom, pickBalance, mapAccount, effectiveAcct,
  carryOver, trimSeen, findAspsp, consentUntil, syncDue, okRedirect, dispDate, addDays,
} from './bank.js';

const tx = (o) => ({
  booking_date: '2026-10-02', status: 'BOOK', credit_debit_indicator: 'CRDT',
  transaction_amount: { currency: 'EUR', amount: '150.00' }, ...o,
});

test('montant signé : DBIT sortie, CRDT entrée, sans sens on garde le signe', () => {
  assert.equal(signedAmount(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '0.60' } })), -0.6);
  assert.equal(signedAmount(tx({ credit_debit_indicator: 'CRDT' })), 150);
  assert.equal(signedAmount(tx({ credit_debit_indicator: undefined, transaction_amount: { amount: '-12.5' } })), -12.5);
  assert.ok(Number.isNaN(signedAmount(tx({ transaction_amount: { amount: 'x' } }))));
});

test('mapBankTx : la contrepartie devient le tiers, la communication la note', () => {
  const inflow = mapBankTx(tx({ debtor: { name: 'Lou Petit' }, remittance_information: ['Provision', ' octobre '], entry_reference: 'E1' }));
  assert.deepEqual({ ...inflow, _fp: undefined }, { tx_date: '2026-10-02', amount: 150, tiers: 'Lou Petit', note: 'Provision octobre', ref: 'E1', _fp: undefined });
  const outflow = mapBankTx(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '84.12' }, creditor: { name: 'ENGIE' }, debtor: { name: 'ACP Démo' }, remittance_information: ['Facture 123'] }));
  assert.equal(outflow.tiers, 'ENGIE');
  assert.equal(outflow.amount, -84.12);
  // sans contrepartie (frais) : la communication, puis le libellé du code banque
  const fee = mapBankTx(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '0.60' }, bank_transaction_code: { description: 'Fee' }, remittance_information: [] }));
  assert.equal(fee.tiers, 'Fee');
  assert.equal(fee.note, '');
  const sub = mapBankTx(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '6' }, remittance_information: ['Account subscription'], bank_transaction_code: { description: 'Fee' } }));
  assert.equal(sub.tiers, 'Account subscription');
  assert.equal(sub.note, 'Fee');
});

test('mapBankTx écarte le non comptabilisé, le nul et le sans date ; date de valeur en repli', () => {
  assert.equal(mapBankTx(tx({ status: 'PDNG' })), null);
  assert.equal(mapBankTx(tx({ status: 'RJCT' })), null);
  assert.equal(mapBankTx(tx({ transaction_amount: { amount: '0.00' } })), null);
  assert.equal(mapBankTx(tx({ booking_date: null, value_date: null })), null);
  assert.equal(mapBankTx(tx({ booking_date: null, value_date: '2026-10-03T00:00:00Z' })).tx_date, '2026-10-03');
  assert.ok(mapBankTx(tx({ status: undefined })), 'statut absent = comptabilisé (on a demandé BOOK)');
});

test('assignRefs : référence de la banque, sinon empreinte stable ; deux identiques gardent chacun la leur', () => {
  const [a] = assignRefs([mapBankTx(tx({ entry_reference: 'E9', transaction_id: 'T9' }))]);
  assert.equal(a.bank_ref, 'E9');
  assert.equal(assignRefs([mapBankTx(tx({ transaction_id: 'T9' }))])[0].bank_ref, 'T9');
  const fee = () => mapBankTx(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '0.60' }, remittance_information: ['SEPA transfer fee'] }));
  const r1 = assignRefs([fee(), fee()]), r2 = assignRefs([fee(), fee()]);
  assert.match(r1[0].bank_ref, /^h:[0-9a-f]{20}$/);
  assert.equal(r1[1].bank_ref, `${r1[0].bank_ref}#2`);
  assert.deepEqual(r1.map((r) => r.bank_ref), r2.map((r) => r.bank_ref), 'même contenu → mêmes références d’une synchro à l’autre');
  assert.ok(!('_fp' in r1[0]) && !('ref' in r1[0]));
});

test('dedupe : références connues, puis lignes sans référence au même montant à 3 jours près', () => {
  const rows = [
    { tx_date: '2026-10-01', amount: 150, bank_ref: 'A' },     // déjà synchronisée
    { tx_date: '2026-10-01', amount: 150, bank_ref: 'B' },     // Alex — dans le relevé PDF (daté du 30/09)
    { tx_date: '2026-10-01', amount: 150, bank_ref: 'C' },     // Sam, même montant, même jour : absente du PDF
    { tx_date: '2026-10-09', amount: -84.12, bank_ref: 'D' },  // ENGIE, PDF à 4 jours : trop loin
  ];
  const r = dedupe(rows, {
    knownRefs: new Set(['A']),
    loose: [{ tx_date: '2026-09-30', amount: '150.00' }, { tx_date: '2026-10-05', amount: -84.12 }],
  });
  assert.deepEqual(r.fresh.map((x) => x.bank_ref), ['C', 'D']);
  assert.equal(r.known, 1);
  assert.equal(r.matched, 1);
});

test('dedupe : à montant égal, le libellé départage — Sam et Lou versent 150 € le même jour', () => {
  const rows = [
    { tx_date: '2026-10-01', amount: 150, tiers: 'Sam Bernard', note: 'Provision octobre', bank_ref: 'S' },
    { tx_date: '2026-10-01', amount: 150, tiers: 'Lou Petit', note: 'Provision octobre', bank_ref: 'L' },
  ];
  // le relevé déposé n'a que Lou ; même s'il est examiné en second, c'est lui qui est reconnu
  const r = dedupe(rows, { loose: [{ tx_date: '2026-09-30', amount: 150, tiers: 'Transfer from Lou Petit', note: '' }] });
  assert.deepEqual(r.fresh.map((x) => x.bank_ref), ['S']);
  // sans aucun mot commun, on retombe sur le montant et la date
  const r2 = dedupe(rows, { loose: [{ tx_date: '2026-09-30', amount: 150, tiers: 'Virement', note: '' }] });
  assert.equal(r2.matched, 1);
  assert.equal(r2.fresh.length, 1);
});

test('dedupe : chaque mouvement prend la ligne existante la plus proche, qui n’en absorbe qu’un', () => {
  const r = dedupe([{ tx_date: '2026-10-03', amount: 10, bank_ref: 'X' }, { tx_date: '2026-10-06', amount: 10, bank_ref: 'Y' }],
    { loose: [{ tx_date: '2026-10-01', amount: 10 }, { tx_date: '2026-10-04', amount: 10 }] });
  // X prend la ligne du 04 (1 jour) plutôt que celle du 01 (2 jours) ; Y n'a plus que le 01, à 5 jours
  assert.deepEqual(r.fresh.map((x) => x.bank_ref), ['Y']);
  assert.equal(r.matched, 1);
});

test('syncFrom : dernière synchro − 5 j, sinon dernière ligne du compte − 5 j, sinon 89 jours', () => {
  assert.equal(syncFrom({ syncedTo: '2026-10-20', latestLedgerDate: '2026-09-30', today: '2026-10-26' }), '2026-10-15');
  assert.equal(syncFrom({ syncedTo: null, latestLedgerDate: '2026-09-30', today: '2026-10-26' }), '2026-09-25');
  assert.equal(syncFrom({ syncedTo: null, latestLedgerDate: null, today: '2026-10-26' }), addDays('2026-10-26', -89));
});

test('pickBalance : solde comptable du jour d’abord, montant signé, date de référence', () => {
  const b = (type, amount, reference_date) => ({ balance_type: type, balance_amount: { currency: 'EUR', amount }, reference_date });
  assert.deepEqual(pickBalance([b('XPCD', '10.00'), b('CLBD', '663.44', '2026-10-25'), b('ITBD', '670.00', '2026-10-26')]), { amount: 670, type: 'ITBD', date: '2026-10-26' });
  assert.deepEqual(pickBalance([b('CLBD', '-12.30', '2026-10-25')]), { amount: -12.3, type: 'CLBD', date: '2026-10-25' });
  assert.deepEqual(pickBalance([b('OTHR', '5')]), { amount: 5, type: 'OTHR', date: '' });
  assert.equal(pickBalance([]), null);
});

test('mapAccount : le compte se reconnaît à l’IBAN appris, sinon aux IBAN des fiches', () => {
  const settings = { iban_map: { FR7617748019000000000000002: 'res' }, iban_pay: 'FR76 1774 8019 0000 0000 0000 001' };
  const pay = mapAccount({ uid: 'u1', identification_hash: 'h1', account_id: { iban: 'FR7617748019000000000000001' }, name: 'ACP Démo', currency: 'EUR' }, settings);
  assert.deepEqual(pay, { uid: 'u1', hash: 'h1', iban: 'FR7617748019000000000000001', name: 'ACP Démo', product: '', currency: 'EUR', acct: 'pay', synced_to: null, balance: null });
  assert.equal(mapAccount({ uid: 'u2', account_id: { iban: 'fr76 1774 8019 0000 0000 0000 002' } }, settings).acct, 'res');
  assert.equal(mapAccount({ uid: 'u3', all_account_ids: [{ scheme_name: 'IBAN', identification: 'BE00 0000 0000 0000' }] }, settings).iban, 'BE00000000000000');
  assert.equal(mapAccount({ uid: 'u4', account_id: { iban: 'BE11' } }, settings).acct, null);
});

test('effectiveAcct : le choix de l’app l’emporte, « skip » ignore le compte', () => {
  const a = { uid: 'u1', hash: 'h1', acct: 'pay' };
  assert.equal(effectiveAcct(a, {}), 'pay');
  assert.equal(effectiveAcct(a, { h1: 'res' }), 'res');
  assert.equal(effectiveAcct(a, { h1: 'skip' }), null);
  assert.equal(effectiveAcct({ uid: 'u2', hash: '', acct: null }, { u2: 'pay' }), 'pay');
  assert.equal(effectiveAcct({ uid: 'u2', hash: '', acct: null }, {}), null);
});

test('carryOver : une reconnexion reprend où la synchro s’était arrêtée (empreinte ou IBAN)', () => {
  const prev = [{ accounts: [{ hash: 'h1', iban: 'FR1', synced_to: '2026-10-20' }, { hash: 'zz', iban: 'FR2', synced_to: '2026-10-19' }] }];
  const out = carryOver([{ hash: 'h1', iban: 'FR1', synced_to: null }, { hash: 'h2', iban: 'FR2', synced_to: null }, { hash: 'h3', iban: 'FR3', synced_to: null }], prev);
  assert.deepEqual(out.map((a) => a.synced_to), ['2026-10-20', '2026-10-19', null]);
});

test('trimSeen garde 60 jours ; findAspsp exact puis seul à contenir le nom', () => {
  assert.deepEqual(trimSeen({ a: '2026-08-01', b: '2026-10-01' }, '2026-10-26'), { b: '2026-10-01' });
  const list = [{ name: 'Swan' }, { name: 'Swan Business' }, { name: 'Qonto' }, { name: 'Revolut' }];
  assert.equal(findAspsp(list, 'swan').name, 'Swan');
  assert.equal(findAspsp(list, 'qon').name, 'Qonto');
  assert.equal(findAspsp([{ name: 'Swan A' }, { name: 'Swan B' }], 'swan'), null, 'ambigu : pas de choix au hasard');
  assert.equal(findAspsp(list, ''), null);
});

test('consentUntil : maximum de la banque, plafonné à 180 jours, moins une heure', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  assert.equal(consentUntil({ maximum_consent_validity: 90 * 86400 }, now), '2027-01-24T09:00:00.000Z');
  assert.equal(consentUntil({ maximum_consent_validity: 730 * 86400 }, now), '2027-04-24T09:00:00.000Z');
  assert.equal(consentUntil({}, now), '2027-01-24T09:00:00.000Z', 'sans indication : 90 jours');
});

test('syncDue : demandée depuis l’app, ou plus vieille que l’intervalle', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(syncDue({ last_sync_at: '2026-10-26T06:00:00Z' }, now, 8), false);
  assert.equal(syncDue({ last_sync_at: '2026-10-26T03:00:00Z' }, now, 8), true);
  assert.equal(syncDue({ last_sync_at: '2026-10-26T11:00:00Z', sync_requested_at: '2026-10-26T11:30:00Z' }, now, 8), true);
  assert.equal(syncDue({}, now, 8), true);
});

test('okRedirect : https, ou http local ; liste blanche si fournie', () => {
  assert.ok(okRedirect('https://ndashiz.be/lazysyndic/banque.html'));
  assert.ok(okRedirect('http://localhost:8099/banque.html'));
  assert.ok(!okRedirect('http://ndashiz.be/lazysyndic/banque.html'));
  assert.ok(!okRedirect('javascript:alert(1)'));
  assert.ok(!okRedirect('https://evil.example/', ['https://ndashiz.be/lazysyndic/banque.html']));
  assert.equal(dispDate('2026-10-05'), '05/10/26');
});
