# SpeakPower API — GRIOT seats on Cloudflare

This Worker sells GRIOT seats with nobody in the loop:

**sign in with Google → 3 free messages → top up by card or mobile money → credited automatically → carry on.**

It also carries the Studio endpoints from the commercial upgrade (email sign-in, server-side builders, leads, funnel events). Those are dormant until the site is wired to them; nothing below depends on them.

Everything here is set up in a browser. No local tools needed.

```
Browser (GitHub Pages)  ──session token──▶  this Worker  ──X-API-Key + X-Tenant-Id──▶  GRIOT (Vercel)
                                              │  D1: accounts, free messages,
                                              │      credits, orders
                                              └──▶ Flutterwave (checkout + verification)
```

The browser never sees GRIOT's address or key, and never chooses its own tenant. The Worker sets `X-Tenant-Id` to the account's own row id, every time.

---

## Launch checklist — in this order

The order matters in exactly one place: **GRIOT must have tenancy before the Worker talks to it.** Without it, GRIOT ignores `X-Tenant-Id` and every client's memories land in one shared pool with yours. The Worker checks for this (`/health` must report `"tenancy": true`) and refuses client traffic, charging nothing, until it does — but deploy in order anyway.

### 1. GRIOT — tenancy first

1. In Neon, **create a branch or backup** of the production database. The tenancy migration runs on the first authenticated request and adds a column to four tables.
2. Merge **claude-central-agent PR #22** ("Scope every row to a tenant…"). Vercel redeploys.
3. Open `https://<your-griot>.vercel.app/health`. It must show `"tenancy": true`. Do not continue until it does.
4. Note your `GRIOT_API_KEY` from Vercel's environment variables — the Worker needs the same value.

**Cost control (recommended):** on Vercel, set `GRIOT_MAX_OUTPUT_TOKENS`. It defaults to 16,000, which puts the worst-case cost of one message at about $0.46 on `claude-opus-5`. At 4,000 the worst case drops to about $0.16. Answers get shorter; check quality on a few real questions before deciding.

### 2. Database (Cloudflare D1)

Dashboard → **Storage & Databases → D1 → Create** → name it `speakpower`. Open its **Console**, paste the whole of `schema.sql`, run it. Every statement is idempotent, so re-running after an update is safe.

### 3. The Worker

Dashboard → **Workers & Pages → Create → Worker** → name it `speakpower-api` → **Edit code** → replace everything with `worker.js` → **Deploy**.

Then **Settings → Bindings → Add → D1 database**: variable name `DB`, database `speakpower`.

Note the Worker's URL, e.g. `https://speakpower-api.<you>.workers.dev`.

### 4. Google sign-in

Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**
- Authorised JavaScript origins: `https://speakpower-commits.github.io`
- No redirect URIs needed.

If asked to configure the consent screen first: External, app name "SpeakPower", your support email, scopes `email` and `profile` only.

Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). It is public, not a secret.

> Use a fresh Google Cloud project for this, not `gen-lang-client-0053145428` — that project's service-account key was shared in a chat and should be revoked.

### 5. Flutterwave

1. **Settings → API keys**: copy the **Secret key**. Start with the **test** key (`FLWSECK_TEST-…`) and switch to live once a test payment has gone through end to end.
2. **Settings → Webhooks**:
   - URL: `https://<your-worker>/webhooks/flutterwave`
   - **Secret hash**: make up a long random string. Flutterwave sends it back on every notification; the Worker rejects anything without it.
   - Enable the charge/payment events.

### 6. Worker variables and secrets

Worker → **Settings → Variables and Secrets**:

| Name | Type | Value |
|---|---|---|
| `SESSION_SECRET` | **Secret** | 32+ random characters. Changing it signs everyone out. |
| `GRIOT_API_KEY` | **Secret** | Same value as on Vercel. |
| `FLW_SECRET_KEY` | **Secret** | From step 5. |
| `FLW_SECRET_HASH` | **Secret** | The secret hash you chose in step 5. |
| `GRIOT_API_BASE` | Text | `https://<your-griot>.vercel.app` |
| `GOOGLE_CLIENT_ID` | Text | From step 4. |
| `GRIOT_PACK_MESSAGES` | Text | Messages per top-up, e.g. `20` |
| `GRIOT_PACK_PRICE` | Text | Price in whole shillings, e.g. `50000` |
| `GRIOT_PACK_CURRENCY` | Text | `UGX` |
| `SITE_URL` | Text | `https://speakpower-commits.github.io/SpeakPower` |
| `ALLOWED_ORIGINS` | Text | `https://speakpower-commits.github.io` |
| `FREE_TRIALS` | Text | `3` |
| `ENVIRONMENT` | Text | `production` |

Automatic top-up switches on only when `GRIOT_PACK_MESSAGES`, `GRIOT_PACK_PRICE`, `FLW_SECRET_KEY` and `FLW_SECRET_HASH` are all set. Until then the pay wall offers a "talk to me" link instead — it never shows a button that takes money it cannot credit.

Check: `https://<your-worker>/health` returns `{"ok":true}`.

### 7. Connect the site

Send the Worker URL and the Google Client ID; they go into `site-config.js` as `apiBase` and `googleClientId`, on the preview branch first. Neither is secret.

### 8. Test on the preview, then go live

On `…/SpeakPower/griot-app.html`, with your own Google account:

1. Sign in → **3 free messages left**.
2. Send three messages. Each answer should mark its claims FACT / INFERENCE / HYPOTHESIS.
3. The pay wall appears, with the pack and price on the button.
4. Pay with a Flutterwave **test** card. You return to the app with "Payment received — 20 messages added".
5. Send one more — the balance drops by one.

Then switch `FLW_SECRET_KEY` to the live key, and merge the preview into `main`.

---

## How the money is kept honest

- **Free messages are granted once, on account creation.** Signing in again, by Google or by email, through any Gmail alias (`a.b+x@gmail.com` is `ab@gmail.com`), never resets them.
- **Every message reserves one run atomically** — free first, then paid — before GRIOT is called. Two tabs sending at once can never spend the same message twice.
- **A failed message is refunded**: GRIOT down, slow (120 s ceiling), rate-limited or returning garbage, the run goes back and the customer is told nothing was used.
- **Credit happens in one place**, reached from the webhook and from the customer's return to the page, in either order, any number of times — and credits exactly once.
- **No payment notification is believed on its own.** Each is re-verified with Flutterwave's API: status `successful`, the right order reference, the right currency, at least the right amount. The messages granted come from our own order row, never from the payload.
- **The webhook's secret hash is compared in constant time.**

## Email-code sign-in (optional, off by default)

The Worker also supports sign-in by a 6-digit emailed code. It stays off (`emailCodes: false` in `site-config.js`) because Cloudflare only sends email to arbitrary addresses on the **Workers Paid plan**, from **a domain you own on Cloudflare DNS**. Once both exist: onboard the domain in **Email Service → Email Sending**, add the `SEND_EMAIL` binding, set `MAIL_FROM` and `TURNSTILE_SECRET`, create a Turnstile widget, and flip `emailCodes` to `true`.

## Known limitation

If someone closes the tab while GRIOT is still answering, Cloudflare cancels the Worker's wait and the message is not refunded. GRIOT still finishes and keeps the exchange in that client's thread, so the next message carries on from it.

## Measuring the funnel (D1 console)

```sql
-- Sign-ups, first messages, pay walls and payments, last 30 days
SELECT name, COUNT(*) AS n FROM events
WHERE created_at > unixepoch() - 30*86400
  AND name IN ('signup_verified', 'griot_message', 'griot_exhausted', 'griot_checkout', 'griot_paid')
GROUP BY name;

-- Revenue by day
SELECT date(paid_at, 'unixepoch') AS day, COUNT(*) AS orders, SUM(amount) AS ugx
FROM griot_orders WHERE status = 'paid' GROUP BY day ORDER BY day DESC;
```

## Testing

```
node --experimental-sqlite worker/test/run-tests.mjs
```

Runs the real `worker.js` against an in-memory D1, with Google, GRIOT and Flutterwave faked at the network edge only. Google sign-in is tested with real RS256 signatures, so forged keys, `alg: none` and edited tokens are refused by actual cryptography rather than a stub.
