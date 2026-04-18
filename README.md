# WHOOP → AOS Proxy (Cloudflare Worker)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/REPLACE-YOUR-GITHUB-USERNAME/whoop-proxy)

> **New here?** Open [`QUICK-START.md`](./QUICK-START.md) — a 7-minute, click-by-click deploy guide.
> This README is the full reference.

Small serverless proxy that lets the Athlete Management System (single-file HTML)
read each athlete's WHOOP data securely, via OAuth 2.0. Holds the `client_secret`,
encrypts refresh tokens at rest, normalizes the WHOOP v2 response shape to match
the HTML's existing `pdvGetWhoopSeries` row schema so the swap is drop-in.

**Why a backend at all?** Browser apps cannot safely hold an OAuth client secret,
and WHOOP's API does not allow cross-origin requests from browsers. The Worker
solves both: the secret stays on Cloudflare's edge; the browser calls the Worker,
the Worker calls WHOOP.

**Why Cloudflare Workers?** For under ~25 athletes you will stay inside the free
tier (100k requests/day, 1k writes/day to KV). No server to maintain.

---

## One-time setup

You'll do this once. Plan ~45 minutes end to end.

### 1. Register a WHOOP developer app

1. Go to https://developer.whoop.com and sign in with your WHOOP account.
2. Create a new app. Fill in:
   - **Name**: `Athlete OS – [Your Org]`
   - **Contact**: your email
   - **Scopes**: check `read:recovery`, `read:sleep`, `read:workout`,
     `read:cycles`, `read:body_measurement`, `read:profile`, and **`offline`**
     (offline is required — it's what lets us refresh tokens without the athlete
     re-logging-in daily).
   - **Redirect URIs**: leave blank for now — you'll fill this in after you
     know your Worker's URL (step 4).
3. Save. Copy the **Client ID** and **Client Secret** somewhere safe — you'll
   paste them into the Worker in step 5.

### 2. Install the Cloudflare CLI

```bash
npm i -g wrangler
wrangler login   # opens your browser
```

You'll need a Cloudflare account (free tier is fine). If you don't have one,
sign up at https://dash.cloudflare.com/sign-up.

### 3. Create the KV namespace for token storage

From inside this `whoop-proxy/` folder:

```bash
npm install
wrangler kv namespace create WHOOP_KV
wrangler kv namespace create WHOOP_KV --preview
```

Each command prints a line like:

```
[[kv_namespaces]]
binding = "WHOOP_KV"
id = "a1b2c3..."
```

Open `wrangler.toml` and paste the `id` into `id = "..."` and the preview id
into `preview_id = "..."`.

### 4. Generate the encryption key and app secret

```bash
openssl rand -hex 32   # → ENC_KEY (exactly 64 hex chars)
openssl rand -hex 24   # → APP_SECRET
```

Save both somewhere durable. **If you lose `ENC_KEY`, every stored refresh
token becomes unreadable** and every athlete will have to reconnect.

### 5. Set the secrets on Cloudflare

```bash
wrangler secret put WHOOP_CLIENT_ID       # paste client id from step 1
wrangler secret put WHOOP_CLIENT_SECRET   # paste client secret from step 1
wrangler secret put APP_SECRET            # paste the APP_SECRET from step 4
wrangler secret put ENC_KEY               # paste the ENC_KEY from step 4
```

### 6. Deploy

```bash
wrangler deploy
```

Output will tell you your Worker URL, e.g.
`https://whoop-proxy.les-spellman.workers.dev`.

### 7. Finish the WHOOP app config

1. Edit `wrangler.toml`:
   - `SELF_ORIGIN` → your Worker URL (no trailing slash).
   - `REDIRECT_AFTER_AUTH` → the URL of `athlete_management_live.html` on whatever
     host you're serving it from. For local dev this can be
     `http://localhost:8000/athlete_management_live.html`.
   - `ALLOWED_ORIGIN` → the **origin** (scheme + host + port) of that URL.
2. Run `wrangler deploy` again to push the updated vars.
3. Back in the WHOOP developer portal, add the **Redirect URI**:
   ```
   https://whoop-proxy.your-subdomain.workers.dev/auth/callback
   ```
   Use your actual Worker URL. Save.

### 8. Wire the HTML to the Worker

In `athlete_management_live.html`, set at the top of the `AOS_PDV` block (it's
been added for you — just fill in the values):

```js
WHOOP_PROXY_ORIGIN: 'https://whoop-proxy.your-subdomain.workers.dev',
WHOOP_APP_SECRET:   'the-APP_SECRET-from-step-4',
```

Open the athlete's Profile → Response Triad card. You'll now see a **Connect
WHOOP** button next to the `Whoop · updated …` timestamp. Click it, authorize
your own athlete account, and the mock data for that athlete will be replaced
by real data on next load.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# fill in .dev.vars
wrangler dev        # runs on http://localhost:8787
```

In `.dev.vars` you can point `SELF_ORIGIN` to a localhost tunnel
(`cloudflared tunnel --url http://localhost:8787`) and add its URL to the
redirect URIs list on WHOOP while testing.

---

## Endpoints

All `/api/*` endpoints require header `X-App-Secret: <your APP_SECRET>` (or
`?k=<secret>` querystring) and `?athleteId=<id>` — the id you use for that
athlete inside your HTML app.

| Method | Path               | Returns |
| ------ | ------------------ | ------- |
| GET    | `/auth/start`      | 302 → WHOOP consent screen |
| GET    | `/auth/callback`   | 302 → back to your HTML with `#whoop=connected` |
| GET    | `/api/status`      | `{ connected, whoopUserId, tokenUpdatedAt }` |
| GET    | `/api/recovery`    | Recovery rows (recovery%, HRV rMSSD ms, RHR, SpO2, skin temp) |
| GET    | `/api/sleep`       | Sleep rows (hours, efficiency, performance, consistency, stages) |
| GET    | `/api/cycle`       | Cycle + strain rows |
| GET    | `/api/workout`     | Workouts |
| GET    | `/api/profile`     | Basic profile + body measurements |
| GET    | `/api/series`      | **Merged by-day rows, drop-in for `pdvGetWhoopSeries`** |
| POST   | `/webhooks/whoop`  | Webhook receiver (cache invalidation) |

All data endpoints support `?days=N` (default 30, max 180).

---

## How the data maps to sports-science use

| WHOOP field                 | Sports-science interpretation                         |
| --------------------------- | ----------------------------------------------------- |
| `recovery_score` (0–100)    | Day-level readiness snapshot. Noisy as a single day.  |
| `hrv_rmssd_milli` (ms)      | Vagal tone proxy. **Use 7-day rolling mean vs 60-day baseline** (Plews et al., 2013 / Kiviniemi) — single-day values are unreliable. |
| `resting_heart_rate`        | Secondary autonomic signal. Rises with illness/strain.|
| `sleep_efficiency` (%)      | Time asleep / time in bed. >85% is generally healthy. |
| `sleep_performance` (%)     | Hours slept / hours needed (WHOOP's model).           |
| `sleep_consistency` (%)     | Proxy for Sleep Regularity Index (Phillips et al., 2017). |
| `strain` (0–21)             | Cardiovascular load, Borg-derived. Feed ACWR calc.    |
| `spo2_percentage`           | Illness / altitude flag.                              |
| `skin_temp_celsius`         | Deviation from baseline — illness flag.               |

The Worker returns `hrvRmssd` already in **milliseconds** (WHOOP's v2 field is
`hrv_rmssd_milli`). If you were doing rolling-baseline math on the mock data
(which used 48–87 ms rMSSD range), the real data lives in the same units.

---

## Security notes

- The `client_secret` never leaves Cloudflare. The browser never sees it.
- Refresh tokens are AES-GCM encrypted in KV using `ENC_KEY`. KV is itself
  not-public, but defence in depth.
- `APP_SECRET` + `ALLOWED_ORIGIN` together gate the `/api/*` endpoints so
  a random internet visitor can't use your Worker to scrape WHOOP.
- Scopes requested are **read-only**. This proxy cannot mutate WHOOP data.

---

## Costs at your scale (<25 athletes)

- Workers: free tier = 100k requests/day. You'll use maybe 200/day.
- KV: free tier = 1k writes/day, 100k reads/day. Plenty.
- WHOOP API: rate-limited per user, not per app. The 15-min server cache plus
  webhook-driven invalidation keeps actual upstream calls to ~1 per athlete
  per day.

Expected monthly cost: **$0**.
