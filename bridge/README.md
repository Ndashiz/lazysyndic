# LazySyndic → Jarvis bridge

A tiny **server-side** service that exposes LazySyndic's data to Jarvis as alerts,
implementing the pull contract in Jarvis's `docs/08-lazysyndic-bridge.md`.

- **Why it exists**: LazySyndic is a static front + Supabase (no server). The bridge
  is the missing server piece that reads Supabase with the `service_role` key
  (server-side only, never in the browser) and serves `GET /api/jarvis/alerts`.
- **Zero dependencies**: plain Node 22 (`http`, `fetch`, `crypto`). Nothing to `npm install`.
- **Runs on the same VPS as Jarvis**, listening on **localhost** — Jarvis calls it
  in-VPS, so the endpoint is never publicly exposed.

## What it computes

| Jarvis alert `kind` | Source | Logic |
|---|---|---|
| `overdue_payment` | `ls_owners` + `ls_transactions` | Ported from `app.js` `ownerLedger()`: `due = due_pay + due_res`, `verse = Σ` positive tx attributed to the owner (explicit `owner` col, else `detectOwner` heuristic). Late when `solde = verse − due < 0`. |
| `notice` | `ls_reminders` | Open reminders (`done = false`). |
| `document` | `ls_timeline` | Manual entries newer than `DOCUMENT_WINDOW_DAYS` (heuristic — tune or disable). |

> The impayés logic mirrors the dashboard exactly today. If LazySyndic's attribution
> heuristic (`detectOwner`) changes in `app.js`, mirror it in `alerts.js` (kept 1:1).

## Endpoints

- `GET /health` → `{ "status": "ok" }`
- `GET /api/jarvis/alerts` → `{ "alerts": [...] }` — requires `Authorization: Bearer $BRIDGE_TOKEN`.

## Local run / test

```bash
cd bridge
cp .env.example .env      # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_TOKEN
node --test               # unit tests (no deps)
node server.js            # starts on 127.0.0.1:3011
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:3011/api/jarvis/alerts
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
