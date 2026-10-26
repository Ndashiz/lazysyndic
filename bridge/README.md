# LazySyndic → Jarvis bridge

A tiny **server-side** service that exposes LazySyndic's data to Jarvis as alerts,
implementing the pull contract in Jarvis's `docs/08-lazysyndic-bridge.md`.

- **Why it exists**: LazySyndic is a static front + Supabase (no server). The bridge
  is the missing server piece that reads Supabase with the `service_role` key
  (server-side only, never in the browser) and serves `GET /api/jarvis/alerts`.
- **Zero dependencies**: plain Node 22 (`http`, `fetch`, `crypto`). Nothing to `npm install`.
- **Optional bank sync**: with an Enable Banking key, it also brings the bank's movements into
  LazySyndic as a statement to validate — see [Bank sync](#bank-sync-enable-banking).
- **Runs on the same VPS as Jarvis**, listening on **localhost** — Jarvis calls it
  in-VPS, so the endpoint is never publicly exposed.

## What it computes

| Jarvis alert `kind` | Source | Logic |
|---|---|---|
| `overdue_payment` | `ls_owners` + `ls_transactions` | Ported from `app.js` `ownerLedger()`: `due = due_pay + due_res`, `verse = Σ` positive tx attributed to the owner (explicit `owner` col, else `detectOwner` heuristic). The verse is bounded to the exercise of the due (last applied budget in `ls_settings.charges`, else the calendar year); earlier payments net of earlier applied dues become a `report`. Late when `solde = report + verse − due < 0`. |
| `notice` | `ls_reminders` | Open reminders (`done = false`). |
| `document` | `ls_timeline` | Manual entries newer than `DOCUMENT_WINDOW_DAYS` (heuristic — tune or disable). |

> The impayés logic mirrors the dashboard exactly today. If LazySyndic's attribution
> heuristic (`detectOwner`) changes in `app.js`, mirror it in `alerts.js` (kept 1:1).

## Endpoints

All `/api/jarvis/*` routes require `Authorization: Bearer $BRIDGE_TOKEN`.

- `GET /health` → `{ "status": "ok" }`
- `GET /api/jarvis/alerts` → `{ "alerts": [...] }`
- `GET /api/jarvis/copro` → the mapping backlog (`total`, `unmapped`, `paidCategories`…).
- `GET /api/jarvis/dashboard` → **the front page, as the app computes it**: reserve gauge,
  balances, who-pays-what ledger, reminders, expense breakdown. Amounts are integer **cents**
  (Jarvis's `…Cents` convention). Jarvis renders this verbatim — it recomputes nothing — so
  « LazySyndic » in Jarvis and LazySyndic itself show the same building.

  The derivations live in `dashboard.js`, ported from `app.js` (`balance` / `receivables` /
  `ownerLedger` / `donutData` + the reserve banner) and unit-tested in `dashboard.test.js`.
  Drafts and soft-deleted rows move no balance, exactly as in the app: a statement that has
  been uploaded but not yet validated is not money in the accounts.

## Local run / test

```bash
cd bridge
cp .env.example .env      # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_TOKEN
node --test               # unit tests (no deps)
node server.js            # starts on 127.0.0.1:3011
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:3011/api/jarvis/alerts
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:3011/api/jarvis/dashboard
```

## Deploy on the VPS (alongside Jarvis)

```bash
# 1. Code (private repo → same PAT trick as Jarvis, or add a deploy key)
sudo git clone https://github.com/Ndashiz/lazysyndic.git /opt/lazysyndic
sudo chown -R jarvis:jarvis /opt/lazysyndic

# 2. Secrets
sudo -u jarvis cp /opt/lazysyndic/bridge/.env.example /opt/lazysyndic/bridge/.env
sudo -u jarvis nano /opt/lazysyndic/bridge/.env    # SUPABASE_*, BRIDGE_TOKEN (openssl rand -base64 24)
sudo chmod 600 /opt/lazysyndic/bridge/.env

# 3. Service
sudo cp /opt/lazysyndic/bridge/lazysyndic-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lazysyndic-bridge
systemctl status lazysyndic-bridge --no-pager
curl -s -H "Authorization: Bearer <BRIDGE_TOKEN>" http://127.0.0.1:3011/api/jarvis/alerts
```

### Point Jarvis at the bridge

In `/opt/jarvis/backend/.env.production`, set:

```
LAZYSYNDIC_URL=http://127.0.0.1:3011
LAZYSYNDIC_API_TOKEN=<same value as the bridge's BRIDGE_TOKEN>
LAZYSYNDIC_WEBHOOK_SECRET=<any long secret, only needed if push is enabled>
```

then `sudo systemctl restart jarvis-backend`. In Jarvis, the LazySyndic module's
**Rafraîchir** (`POST /api/lazysyndic/refresh`) now pulls real alerts and leaves demo mode.

### Optional push (real-time bell)

To have the bridge notify Jarvis when a new alert appears (instead of only on pull),
set in the bridge `.env`:

```
JARVIS_WEBHOOK_URL=http://127.0.0.1:3007/api/lazysyndic/webhook
JARVIS_WEBHOOK_SECRET=<same as Jarvis LAZYSYNDIC_WEBHOOK_SECRET>
POLL_MS=300000     # check every 5 min; first pass primes (no backlog storm)
```

### Update

```bash
ssh ubuntu@<vps> 'sudo -u jarvis git -C /opt/lazysyndic pull --ff-only && sudo systemctl restart lazysyndic-bridge'
```

## Bank sync (Enable Banking)

Optional. With `EB_APP_ID` + `EB_KEY_PATH` set, the bridge pulls the bank's movements through
[Enable Banking](https://enablebanking.com/docs/api/reference/) and drops them into LazySyndic as a
**statement to validate** — the same draft path as a dropped PDF/CSV, never straight into the
balances. Off by default; nothing else in the bridge changes.

**No new public endpoint.** The browser holds no secret and cannot reach the bridge (localhost
only). Supabase is the mailbox between them — table `ls_bank_links` (baseline §12, syndic-only RLS):

| Step | Who | `status` after |
|---|---|---|
| « Connecter la banque » (Import screen) | app inserts bank name, country, `state`, return URL | `requested` |
| `POST /auth` | bridge writes the bank's authorization link | `auth_ready` |
| bank login, back on `banque.html?code=…&state=…` | app writes the code | `code_received` |
| `POST /sessions` + first sync | bridge writes accounts, consent end, clears the code | `active` |
| every `EB_SYNC_HOURS`, or « Synchroniser maintenant » | bridge syncs | `active` |
| « Déconnecter » → `DELETE /sessions` | app, then bridge | `revoked` |

The private key never leaves the VPS. Without it, a `code` or a `session_id` read from Supabase
opens nothing: every Enable Banking call is signed with an RS256 JWT (`kid` = application id).

**What a sync writes** (`banksync.js`, pure rules in `bank.js`):

- `ls_transactions` rows with `draft = true`, `high = null` (the app runs its own rules, aliases
  and owner detection on them when the syndic opens it — `classifyBankDrafts` → `classifyImported`,
  the code a file import uses), and `bank_ref` = the bank's `entry_reference` / `transaction_id`
  (fallback: a content hash, `#2` for identical twins the same day). A unique index on
  `(account, bank_ref)` stops a double insert.
- one pending `ls_imports` row per account (`stmt.source = 'bank'`) that grows with each sync until
  validated; `stmt.closing` is the bank's balance, so validation reconciles against it.
- a timeline entry when something arrived.

**Duplicates.** Window = last sync (else last ledger line, else 89 days) minus 5 days. Skipped: a
known `bank_ref` (deleted rows included), a ref already seen by an earlier sync (a discarded synced
statement does not come back), and an existing line without `bank_ref` (PDF/CSV/paste) with the same
amount within 3 days — label words decide between twins, so Sam's and Lou's equal payments stay
apart. The app applies the same rule the other way when a file is dropped after a sync.

**Limits to know.** PSD2 lets a bank cap unattended reads at 4 a day per account (`EB_SYNC_HOURS=8`
leaves room for the button). Consent lasts at most 180 days (the bank's
`maximum_consent_validity`); the Import card and a Jarvis notice (`bankAlerts`: renew < 14 days,
failing > 36 h, expired) say when to reconnect.

### Coverage: ask the API, not the website

Enable Banking's public coverage page does not list Swan, yet the API does: on 2026-10-26
`eb.js banks BE swan` and `eb.js banks FR swan` both returned « Swan », business accounts only,
180-day consent, flagged beta. Only an **active** application may list institutions (an inactive
one gets `403 Application is not active`), so before activation the Control Panel's « Activate by
linking accounts » picker is the only check. The copro's two accounts were linked through
« Swan (Belgium) » — use Swan · BE · business in the app.

```bash
sudo -u jarvis node /opt/lazysyndic/bridge/eb.js banks BE swan     # exit 2 = not there
```

### Setup

1. **Enable Banking** — <https://enablebanking.com> → Get started → Control Panel → API
   applications → new application, environment **Production**, redirect URL
   `https://ndashiz.be/lazysyndic/banque.html`, key generated in the browser → it downloads
   `<application-id>.pem`. Then « Activate by linking accounts » with the copro's accounts:
   restricted mode (own accounts, non-commercial use, free).
2. **Supabase** — rerun `supabase/migrations/000_baseline.sql`, then `supabase/check.sql`.
3. **VPS** — the key and two lines of `.env`:

   ```bash
   sudo -u jarvis git -C /opt/lazysyndic pull --ff-only
   sudo -u jarvis nano /opt/lazysyndic/bridge/enablebanking.pem   # paste the .pem content
   sudo chmod 600 /opt/lazysyndic/bridge/enablebanking.pem
   sudo -u jarvis nano /opt/lazysyndic/bridge/.env                # EB_APP_ID=<application id>, EB_KEY_PATH=enablebanking.pem
   sudo systemctl restart lazysyndic-bridge
   sudo -u jarvis node /opt/lazysyndic/bridge/eb.js app            # ACTIVE, redirect URL listed
   journalctl -u lazysyndic-bridge -n 20 --no-pager                # "bank sync enabled …"
   ```

4. **App** — LazySyndic › Import › Synchronisation bancaire: bank name exactly as `eb.js banks`
   prints it, country, account type → « Connecter la banque » → authorize at the bank → back in
   the app. Accounts are matched by IBAN (`iban_map`, else the IBAN of each account card); an
   unknown one waits for a choice in the card.

CLI (`eb.js`, reads `.env`, never prints the key, a JWT, a code or a session id):

```bash
node eb.js app              # the application as Enable Banking sees it
node eb.js banks FR [swan]  # institutions of a country, consent length, account types
node eb.js status           # connections stored in Supabase, accounts, last sync
node eb.js sync             # one sync now (prefer the app's button while the service runs)
```

Tests: `node --test` covers the JWT (signature checked with the public key), the mapping, the
dedup rules and the whole connection lifecycle against an in-memory PostgREST
(`enablebanking.test.js`, `bank.test.js`, `banksync.test.js`).
