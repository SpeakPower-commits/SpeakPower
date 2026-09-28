# SpeakPower Studio API (Cloudflare Worker)

This is the server side of SpeakPower Studio, the contact form and funnel measurement. It all runs on Cloudflare, and you can set it up from the Cloudflare dashboard in a browser. No local tools are needed.

| Piece | Cloudflare product | Purpose |
|---|---|---|
| `worker.js` | Workers | API: sign-up, free runs, Studio generation, leads, events |
| `schema.sql` | D1 | Accounts, sign-in codes, runs, leads, events, rate limits |
| Sign-in and lead emails | Email Service (`send_email` binding) | 6-digit codes, new-lead alerts |
| Bot protection | Turnstile | Guards sign-up against trial farming |
| Page views | Web Analytics | Cookieless traffic numbers |

## How the 3 free runs work

1. A visitor fills in a Studio brief and clicks **Generate**.
2. First time only: they enter an email, pass Turnstile and receive a 6-digit code. Verifying it creates the account with **3 free runs**. Signing in again later never resets the count.
3. Each **Generate** call makes the Worker atomically take one run: a free run first, then a paid credit. The Worker then generates the pack server-side. If generation fails, the run is refunded.
4. When the free runs and credits are both at 0, the API returns **402** and the page shows the **upgrade panel**.

Farming extra accounts is limited in four ways:
- email addresses are canonicalised: lower-case, `+tags` removed, dots removed for Gmail;
- Turnstile runs on every code request;
- code requests are rate-limited by IP and by email;
- a code allows only 5 attempts.

### Flutterwave hand-off (your integration)

- Set `CHECKOUT_URL` (Worker variable) or `checkoutUrl` (`site-config.js`). The upgrade button links to it.
- Or listen in the page for `window.addEventListener("sp:trials-exhausted", e => …)`. `e.detail` carries `{ product, title, price, email }`, so you can open an inline Flutterwave checkout.
- After a verified payment, your webhook adds paid runs:
  ```sql
  UPDATE users SET credits = credits + 1, plan = 'paid' WHERE email_canonical = ?;
  ```
  Use the same canonical form as `canonicalEmail()` in `worker.js`: lower-case, strip `+tag`, and strip dots for Gmail. The Worker spends credits automatically once the free runs are gone.

## One-time setup (about 20 minutes, all in the dashboard)

### 1. Create the database
1. Go to **Storage & Databases → D1 → Create database** and name it `speakpower`.
2. Open the database, then **Console**. Paste all of `schema.sql` and click **Execute**.

### 2. Create the Worker
1. Go to **Workers & Pages → Create → Create Worker** and name it `speakpower-api`. Deploy the starter.
2. Click **Edit code**. Replace everything with the contents of `worker.js`, then **Deploy**.
   - Alternatively: **Create → Import a repository**, pick this repo and set the root directory to `worker`. Cloudflare then redeploys on every push using `wrangler.toml`. Put the D1 database ID into `wrangler.toml` first.

### 3. Bindings, variables and secrets
In the Worker, open **Settings → Bindings** and add:
- **D1 database**: variable name `DB`, database `speakpower`.
- **Send Email** (Email Service): variable name `SEND_EMAIL`. This needs a domain onboarded to Cloudflare with Email Service enabled for sending. A Gmail address cannot be the sender.

Then open **Settings → Variables and Secrets** and add:

| Name | Type | Value |
|---|---|---|
| `SESSION_SECRET` | Secret | 32+ random characters. Changing it signs everyone out. |
| `TURNSTILE_SECRET` | Secret | From step 4 |
| `PAGESPEED_KEY` | Secret | Google Cloud → APIs → PageSpeed Insights API key (recommended; the keyless quota is small) |
| `ALLOWED_ORIGINS` | Text | `https://speakpower-commits.github.io` (add a custom domain later, comma-separated) |
| `MAIL_FROM` | Text | e.g. `studio@yourdomain.com` (on the onboarded domain) |
| `LEAD_NOTIFY_TO` | Text | The inbox that should receive contact-form leads |
| `CHECKOUT_URL` | Text | Your Flutterwave payment link (optional until ready) |
| `FREE_TRIALS` | Text | `3` |
| `ENVIRONMENT` | Text | `production` |

### 4. Turnstile
1. Go to **Turnstile → Add widget**. Add the hostname `speakpower-commits.github.io` and choose the **Managed** mode.
2. Put the **secret key** in the Worker as `TURNSTILE_SECRET`.
3. Put the **site key** in `site-config.js` as `turnstileSiteKey`.

### 5. Web Analytics
Go to **Analytics & Logs → Web Analytics → Add a site**. Choose the manual JS snippet and copy only the **token** into `site-config.js` as `webAnalyticsToken`.

### 6. Housekeeping cron
Go to **Worker → Settings → Triggers → Cron Triggers** and add `17 3 * * *`. This prunes old rate-limit rows and expired codes daily.

### 7. Connect the site
Set `apiBase` in `/site-config.js` to the Worker URL, e.g. `https://speakpower-api.<subdomain>.workers.dev`. Commit it. Until `apiBase` is set:
- the contact form falls back to email;
- Studio shows a "launching shortly" notice and does not generate.

Check it works:
- `https://<worker-url>/health` should return `{"ok":true}`.
- Then sign up on the live Studio page with your own email.

## Email Service note

All outbound email goes through one function, `sendEmail()` in `worker.js`. It calls `env.SEND_EMAIL.send({ to, from, subject, text })`. If Cloudflare changes the Email Service binding API, that function is the only place to update.

## Privacy position (what the site promises, and why it is true)

- **Audit:** the text never leaves the browser. Only an anonymous `audit_run` count is sent.
- **Studio text products:** answers are sent to generate the pack and are **not stored**. The `runs` table records only user, product and time.
- **Data Story:** the CSV is parsed in the browser. Only column-level summary statistics are sent, meaning averages, ranges, missing rates and the most common *repeated* categories. Columns that are mostly unique (names, emails, IDs, free text) are sent as a distinct count only, never as values.
- **Events:** event name, page, product, a random per-browser id and (when signed in) the user id. No names, emails or content.

## Measuring the funnel (D1 console)

```sql
-- Funnel, last 30 days
SELECT name, COUNT(*) AS events, COUNT(DISTINCT COALESCE(user_id, anon_id)) AS people
FROM events
WHERE created_at > unixepoch() - 30*86400
GROUP BY name
ORDER BY CASE name
  WHEN 'audit_run' THEN 1 WHEN 'studio_view' THEN 2 WHEN 'signup_started' THEN 3
  WHEN 'signup_verified' THEN 4 WHEN 'studio_generate' THEN 5 WHEN 'studio_download' THEN 6
  WHEN 'trials_exhausted' THEN 7 WHEN 'checkout_click' THEN 8 WHEN 'contact_submit' THEN 9 END;

-- Trial usage distribution (how many people used 0, 1, 2, 3 runs)
SELECT (3 - trials_remaining) AS runs_used, COUNT(*) AS users
FROM users WHERE verified = 1 GROUP BY runs_used ORDER BY runs_used;

-- Most-run products
SELECT product, COUNT(*) AS runs FROM runs WHERE status = 'ok' GROUP BY product ORDER BY runs DESC;

-- New leads
SELECT created_at, name, organization, email, service FROM leads WHERE status = 'new' ORDER BY created_at DESC;
```

## Testing

`test/run-tests.mjs` runs the Worker against an in-memory SQLite stand-in for D1. It needs Node 22.5 or later:

```
node --experimental-sqlite worker/test/run-tests.mjs
```

It covers:
- sign-up and verification;
- 3 runs, then a 402;
- the atomic run reservation under parallel requests;
- refunds on failure;
- token tampering;
- lead capture and the honeypot;
- CORS.
