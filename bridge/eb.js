#!/usr/bin/env node
// Outil Enable Banking du pont — diagnostic et synchro à la main. Lit bridge/.env.
//
//   node eb.js app                 l'application vue par Enable Banking (environnement, actif, retours)
//   node eb.js banks FR [swan]     les banques d'un pays, filtrées par nom (consentement max, types)
//   node eb.js status              les connexions enregistrées dans Supabase (ls_bank_links)
//   node eb.js sync                une synchro tout de suite (comme le bouton de l'app)
//
// Ne montre jamais la clé privée, le JWT, un code d'autorisation ni un identifiant de session.

import { loadDotEnv, enableBankingConfig } from './env.js';
import { createEnableBanking } from './enablebanking.js';
import { createRest } from './supabase.js';
import { createBankSync } from './banksync.js';

loadDotEnv();
const [cmd, ...args] = process.argv.slice(2);
const days = (s) => (Number(s) ? `${Math.round(Number(s) / 86400)} j` : '?');

function need(cond, msg) { if (!cond) { console.error(msg); process.exit(1); } }

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('Usage : node eb.js app | banks <PAYS> [nom] | status | sync');
    return;
  }
  const cfg = enableBankingConfig();
  if (cmd === 'app' || cmd === 'banks' || cmd === 'sync') need(cfg, 'EB_APP_ID et EB_KEY_PATH manquent dans bridge/.env (voir .env.example).');
  const eb = cfg ? createEnableBanking(cfg) : null;

  if (cmd === 'app') {
    const a = await eb.application();
    console.log(`Application : ${a.name}  (${a.environment || '?'})  ${a.active ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`Pays        : ${(a.countries || []).join(', ') || '—'}`);
    console.log(`Services    : ${(a.services || []).join(', ') || '—'}`);
    console.log(`Retours     : ${(a.redirect_urls || []).join('\n              ') || '—'}`);
    if (!a.active) console.log('\n→ Application inactive : Control Panel › « Activate by linking accounts » (mode restreint, usage perso).');
    return;
  }

  if (cmd === 'banks') {
    const country = String(args[0] || '').toUpperCase();
    need(/^[A-Z]{2}$/.test(country), 'Pays attendu, ex. : node eb.js banks FR swan');
    const filter = String(args[1] || '').toLowerCase();
    const list = (await eb.aspsps(country)).filter((b) => !filter || String(b.name).toLowerCase().includes(filter));
    if (!list.length) {
      console.log(filter ? `Aucune banque « ${args[1]} » pour ${country} chez Enable Banking.` : `Aucune banque pour ${country}.`);
      process.exitCode = 2;
      return;
    }
    for (const b of list) {
      console.log(`${b.name}  [${b.country}]  types : ${(b.psu_types || []).join('/') || '?'}  · consentement max ${days(b.maximum_consent_validity)}${b.beta ? '  · bêta' : ''}${b.sandbox ? '  · sandbox' : ''}`);
    }
    console.log(`\n${list.length} banque(s). Le nom exact ci-dessus est celui à saisir dans l'app.`);
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  need(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY manquent dans bridge/.env.');
  const rest = createRest(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (cmd === 'status') {
    const links = await rest.select('ls_bank_links', 'select=id,status,aspsp_name,aspsp_country,psu_type,valid_until,accounts,acct_map,last_sync_at,last_sync,error,created_at&order=created_at.desc&limit=10');
    if (!links.length) { console.log('Aucune connexion bancaire enregistrée.'); return; }
    for (const l of links) {
      console.log(`${l.created_at.slice(0, 16).replace('T', ' ')}  ${l.status.padEnd(16)} ${l.aspsp_name} (${l.aspsp_country}, ${l.psu_type})  jusqu'au ${(l.valid_until || '—').slice(0, 10)}`);
      for (const a of l.accounts || []) {
        const target = (l.acct_map || {})[a.hash] || a.acct || '— à choisir dans l’app';
        console.log(`    …${String(a.iban || '').slice(-4) || '????'}  ${a.name || ''}  → ${target}  · synchro jusqu'au ${a.synced_to || '—'}${a.balance ? ` · solde ${a.balance.amount} (${a.balance.type})` : ''}`);
      }
      if (l.last_sync) console.log(`    dernière synchro ${String(l.last_sync_at || '').slice(0, 16).replace('T', ' ')} : ${JSON.stringify(l.last_sync.added || {})}${l.last_sync.error ? ` · ERREUR ${l.last_sync.error}` : ''}`);
      if (l.error) console.log(`    erreur : ${l.error}`);
    }
    const syncs = await rest.select('ls_bank_syncs', 'select=at,cause,ok,added_pay,added_res,known,matched,error&order=at.desc&limit=10').catch(() => null);
    if (syncs) {
      console.log(`\nDernières synchros (${syncs.length}) :`);
      for (const s of syncs) {
        console.log(`  ${String(s.at).slice(0, 16).replace('T', ' ')}  ${String(s.cause).padEnd(8)} ${s.ok ? 'ok    ' : 'ÉCHEC '} +${s.added_pay} paiement · +${s.added_res} réserve · ${s.known + s.matched} déjà connu(s)${s.error ? ` · ${s.error}` : ''}`);
      }
    }
    return;
  }

  if (cmd === 'sync') {
    console.log('Synchro… (si le pont tourne déjà, préférez le bouton de l’app : il évite deux synchros simultanées)');
    const out = await createBankSync({ rest, eb, syncHours: cfg.syncHours, redirectAllow: cfg.redirectAllow }).tick({ force: true });
    for (const r of out) console.log(JSON.stringify({ status: r.status, added: r.added, known: r.known, matched: r.matched, warnings: r.warnings, error: r.error }));
    if (!out.length) console.log('Aucune connexion active.');
    return;
  }

  console.error(`Commande inconnue : ${cmd}`);
  process.exit(1);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
