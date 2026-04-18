# WHOOP Live Sync — 7-Minute Setup

Follow this once. After this, data flows live into AOS forever. Each athlete
connects by tapping one button. No monthly fee. Free Cloudflare tier covers
<25 athletes indefinitely.

**What you need before you start:**

- A WHOOP account (any paid tier)
- A GitHub account (free — sign up at github.com if you don't have one)
- A Cloudflare account (free — sign up at dash.cloudflare.com if you don't have one)
- 7 minutes

---

## Stopwatch starts here

### ⏱ Min 0:00 — Register the WHOOP developer app (3 min)

1. Open **https://developer.whoop.com** → **Sign in** with your WHOOP account.
2. Click **Create App**.
3. Fill in:
   - **Name:** `Athlete OS`
   - **Contact:** your email
   - **Redirect URIs:** leave blank — you'll add this in Min 6:00
   - **Scopes — check all of these:**
     - `read:recovery`
     - `read:sleep`
     - `read:workout`
     - `read:cycles`
     - `read:body_measurement`
     - `read:profile`
     - `offline` *(required — this is what makes tokens refresh silently so athletes don't reconnect daily)*
4. **Save**.
5. Copy the **Client ID** and **Client Secret** into a scratch note. You'll paste them in Min 4:30.

---

### ⏱ Min 3:00 — Push this folder to GitHub (1 min)

Fastest path (no CLI needed):

1. Go to **https://github.com/new**.
2. **Repository name:** `whoop-proxy`. Public is fine. Do **not** initialize with a README. Click **Create repository**.
3. On the empty-repo page, click **uploading an existing file**.
4. Drag every file from `whoop-proxy/` (this folder) onto the dropzone — including `src/`, `package.json`, `wrangler.toml`, `tsconfig.json`, `.gitignore`, `README.md`, `QUICK-START.md`, `.dev.vars.example`.
5. Scroll down, click **Commit changes**.

> You now have a URL like `https://github.com/your-username/whoop-proxy`. Copy it.

---

### ⏱ Min 4:00 — One-click deploy to Cloudflare (30 sec)

1. Go to:
   ```
   https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-USERNAME/whoop-proxy
   ```
   *(Replace `YOUR-USERNAME` with your GitHub username.)*
2. Sign in to Cloudflare if prompted.
3. Authorize GitHub when asked.
4. Click **Deploy**. Cloudflare will fork the repo to your GitHub, create the Worker, and auto-provision the KV namespace.

When it's done you'll see a Worker URL like:

```
https://whoop-proxy.your-subdomain.workers.dev
```

**Copy that URL.** You'll use it three times below.

---

### ⏱ Min 4:30 — Set the 4 secrets (1 min)

Still in the Cloudflare dashboard, on your new Worker's page:

1. Click **Settings** → **Variables and Secrets**.
2. Add these four **Secrets** (not Variables — pick "Secret" type):

   | Name | Value |
   | --- | --- |
   | `WHOOP_CLIENT_ID` | Client ID from WHOOP (Min 2:30) |
   | `WHOOP_CLIENT_SECRET` | Client Secret from WHOOP (Min 2:30) |
   | `APP_SECRET` | See below ↓ |
   | `ENC_KEY` | See below ↓ |

3. For `APP_SECRET` and `ENC_KEY`, open **https://www.random.org/bytes/**, request **48 bytes** as **Hexadecimal**, click **Get Bytes**.
   - Use the first **48 characters** as `APP_SECRET`.
   - Request 48 more bytes and use the first **64 characters** as `ENC_KEY` (must be exactly 64 hex chars).
   - **Save both in a password manager.** Losing `ENC_KEY` means every athlete has to reconnect.

4. Click **Save** for each secret.

---

### ⏱ Min 5:30 — Set the 3 public vars (30 sec)

Same page, add these as **Variables** (plain text, not secrets):

| Name | Value |
| --- | --- |
| `SELF_ORIGIN` | Your Worker URL from Min 4:00 (no trailing slash) |
| `REDIRECT_AFTER_AUTH` | Full URL to your AOS HTML file (e.g. `https://your-site.com/athlete_management_live.html`, or for local dev `http://localhost:8000/athlete_management_live.html`) |
| `ALLOWED_ORIGIN` | Just the origin of the above — scheme + host + port (e.g. `https://your-site.com` or `http://localhost:8000`) |

Click **Save and deploy** at the top of the page.

---

### ⏱ Min 6:00 — Add the redirect URI back in WHOOP (30 sec)

1. Back at **https://developer.whoop.com**, open your app.
2. Under **Redirect URIs**, paste:
   ```
   https://whoop-proxy.your-subdomain.workers.dev/auth/callback
   ```
   *(Use YOUR Worker URL — the one from Min 4:00 — with `/auth/callback` on the end.)*
3. **Save**.

---

### ⏱ Min 6:30 — Point AOS at the Worker (30 sec)

1. Open the Athlete Management System in your browser.
2. Click the **WHOOP** tab in the top navigation.
3. In the **Proxy Configuration** panel at the top, paste:
   - **Proxy URL:** your Worker URL from Min 4:00
   - **App Secret:** the `APP_SECRET` you generated in Min 4:30
4. Click **Save & Test**. You should see a green **Connected** indicator.

---

### ⏱ Min 7:00 — Connect your first athlete (30 sec, repeat per athlete)

1. On the WHOOP page in AOS, find the athlete's card.
2. Click **Connect WHOOP**.
3. A new tab opens → WHOOP login → **Authorize**.
4. You're redirected back to AOS. The card flips from mock → live data.

**That's it. You're live.**

For every additional athlete, it's just step 7 again — 30 seconds each. They can do it themselves on their phone if you send them a link.

---

## What happens now, automatically

- **Every morning** (and whenever WHOOP finishes scoring an activity): WHOOP POSTs a webhook to your Worker. The Worker invalidates cache. Next time AOS reads that athlete, it gets the fresh data.
- **Token refresh**: silently, every ~60 min. The `offline` scope handles this. Athletes do not reconnect.
- **Cost**: $0/mo at your scale. Workers free tier = 100k req/day. You'll use ~500/day for 25 athletes.

---

## If you get stuck

| Symptom | Fix |
| --- | --- |
| Deploy to Cloudflare button fails at KV step | Open Cloudflare dashboard → Workers & Pages → KV → **Create namespace** called `WHOOP_KV`. Then in your Worker's **Settings → Bindings**, bind it. Redeploy. |
| "CORS error" in browser console when clicking Save & Test | `ALLOWED_ORIGIN` in Worker vars doesn't match where AOS is served from. Fix it in Cloudflare dashboard and Save & Deploy. |
| `/auth/callback` shows a WHOOP error page | Redirect URI in the WHOOP developer portal doesn't exactly match `<worker-url>/auth/callback`. Copy-paste, no typos, no trailing slash. |
| Athlete clicks Connect and nothing happens | `WHOOP_PROXY_ORIGIN` in AOS isn't set, or `APP_SECRET` doesn't match what's in Cloudflare. Re-check in the Proxy Configuration panel. |
| Status shows "Connected" but data doesn't appear | WHOOP may not have scored today's sleep/recovery yet — they score overnight. Check an athlete whose recovery is already green in the WHOOP app. |

---

## Why this is the fastest live path

Everything here is unavoidable except the Cloudflare piece:

- WHOOP developer app registration — required by WHOOP, not us. **~3 min.**
- Per-athlete OAuth — required by WHOOP (athlete consent). **~30 sec each.**
- A server to hold the OAuth secret — required by OAuth 2.0 spec. Browsers can't.

Paid aggregators (Terra, Junction, Rook) do not eliminate any of this. They
replace the Cloudflare Worker with their hosted service, and charge
$3,000–$6,000/year for it. For <25 athletes that's hard to justify.
