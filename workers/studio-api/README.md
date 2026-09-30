# SpeakPower Studio API — Clerk + Cloudflare

This Worker replaces the previous Supabase access layer.

## Architecture

- GitHub Pages: SpeakPower website and current Studio product UI.
- Clerk: email sign-in, session management and user identity.
- Cloudflare Worker: authenticated API, trial enforcement and Flutterwave server integration.
- Cloudflare D1: Studio users, runs and payment orders.

## 1. Create Clerk app

In Clerk:

1. Create a free application.
2. Enable email sign-in/sign-up.
3. Add the SpeakPower production URL as an allowed origin/redirect:
   `https://speakpower-commits.github.io`
4. Copy the Publishable Key.
5. Copy the Clerk Frontend API URL.
6. Put those two browser-safe values into:
   `assets/clerk-config.js`

The browser only receives the Publishable Key. Never put `CLERK_SECRET_KEY` in the website.

## 2. Create Cloudflare D1

From `workers/studio-api/`:

```bash
npm install
npx wrangler login
npx wrangler d1 create speakpower-studio --location eeur --update-config
```

Cloudflare will return a database ID. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` if Wrangler did not update it automatically.

Then apply the migration:

```bash
npx wrangler d1 migrations apply speakpower-studio --remote
```

## 3. Add Worker secrets

Never put these in `wrangler.jsonc`:

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put FLW_SECRET_KEY
npx wrangler secret put FLW_SECRET_HASH
```

The Worker reads the Clerk Publishable Key from its non-secret configuration and the three values above as encrypted Worker secrets.

## 4. Deploy

```bash
npx wrangler deploy
```

Copy the deployed Worker URL into:

`assets/studio-api-config.js`

Example:

```js
window.SPEAKPOWER_STUDIO_API = {
  baseUrl: "https://speakpower-studio-api.YOUR-SUBDOMAIN.workers.dev"
};
```

## 5. Flutterwave webhook

In Flutterwave, set the webhook endpoint to:

`https://YOUR-WORKER.workers.dev/webhooks/flutterwave`

Set the same webhook secret hash in the Worker secret:

`FLW_SECRET_HASH`

The Worker accepts the webhook only when the secret hash matches, then re-verifies the transaction server-side before marking an order as paid.

## 6. Studio trial model

Each authenticated Clerk user gets three lifetime free Studio runs across all six Studio products.

The Worker records every run in D1.

After the three free runs:

- the selected product shows the payment wall;
- Flutterwave creates a pending order;
- a successful verified payment creates a paid order;
- the next reservation consumes that paid order for one Studio generation.

The current product engine still runs in the browser. The access decision, trial counter and paid entitlement are server-side.

## 7. Important free-tier note

Cloudflare's free D1 limits are daily limits. Since September 1, 2026, Cloudflare rejects new D1 queries after the free daily row-read or row-write limit is exceeded until the quota resets.

The Worker therefore uses small indexed queries and single-purpose records rather than scanning the whole database.

## 8. Production hardening

The next security stage should move the actual paid product execution into the Worker/another server-side function. That would prevent someone who understands browser code from generating a paid deliverable without a valid reservation.

## 9. Website SEO & Visibility Audit (the `/pagespeed` route)

### What this fixes

The SEO audit product never worked. `studio-product.js` called Google's
PageSpeed Insights API straight from the browser with **no API key**. Keyless
calls are charged to Google's shared anonymous project
(`project_number:583797351490`), whose daily quota is permanently exhausted by
every other keyless caller on the internet. Every single request came back:

```
HTTP 429  Quota exceeded for quota metric 'Queries' and limit 'Queries per day'
```

so every customer saw "Google PageSpeed could not analyse that URL right now."

The key cannot be fixed by putting it in the website: GitHub Pages serves
`studio-product.js` as readable text, so the key would be scraped and the quota
(or the bill) would become someone else's. The call therefore moved into this
Worker, which is the only place on the stack that can hold a secret.

### The audit now has two independent layers

1. **Google Lighthouse scores** — needs `PAGESPEED_API_KEY`.
2. **SpeakPower's own technical checks** — needs no key and no quota. The
   Worker fetches the page itself and parses it with `HTMLRewriter`: title and
   meta-description length, H1 count and heading order, canonical
   self-reference, **JSON-LD validity**, Open Graph completeness, image alt
   coverage, viewport, indexability, prose depth, internal linking.

**Layer 2 is the product.** Layer 1 is a bonus that can fail without the
customer receiving nothing. A Lighthouse score is free to anyone at
`pagespeed.web.dev`; the checks in layer 2 are the part worth paying for, and
the JSON-LD validity check has already caught a real broken block on
SpeakPower's own `work.html`.

If the key is missing, invalid, or the quota is spent, the report still
delivers in full and says why the scores are absent.

### Get the API key

1. Go to <https://console.cloud.google.com/> and create a project (or reuse one).
2. **APIs & Services → Library**, search **PageSpeed Insights API**, press
   **Enable**. Skipping this step is the most common cause of a 403.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Press **Edit API key** and restrict it:
   - *API restrictions* → **Restrict key** → tick **PageSpeed Insights API** only.
   - Leave *Application restrictions* as **None**. The call comes from a
     Cloudflare data centre, so an HTTP-referrer or IP restriction would block it.
5. Copy the key.

The free tier is ample for Studio volume. Confirm the current figures under
**APIs & Services → Quotas**.

### Add it to the Worker

```bash
npx wrangler secret put PAGESPEED_API_KEY
```

Then apply the new cache table:

```bash
npx wrangler d1 migrations apply speakpower-studio --remote
npx wrangler deploy
```

### Browser-only deployment

If you are not working from a machine with a terminal, use **Cloudflare
dashboard → Workers & Pages → the Worker → Settings**:

- **Variables and Secrets → Add → Secret** for `PAGESPEED_API_KEY`.
- **Build → Connect to Git** against this repository, with the root directory
  set to `workers/studio-api`. Cloudflare then builds and deploys on every push
  and no local CLI is needed.
- The D1 migration can be run from **Storage & Databases → D1 → speakpower-studio
  → Console** by pasting the contents of `migrations/0002_pagespeed_cache.sql`.

### Caching

Results are cached in D1 for 24 hours, keyed by the normalised URL. A repeat
audit of the same address inside that window costs no Google quota and returns
in milliseconds instead of ~30 seconds. Expired rows are ignored by the read
query and overwritten by the next audit, so no cleanup job is needed.

### Safety

The Worker fetches a URL the customer supplies, so `normaliseTarget()` rejects
anything that is not a public http/https address: `localhost`, RFC1918 ranges,
`169.254.169.254` (cloud metadata), `.internal`, `.local`, and non-http
schemes. The HTML read is capped at 512 KB and the fetch at 12 seconds, so one
hostile or enormous page cannot exhaust the Worker.

### A note on section 8 above

Section 8 says the next security stage is moving paid product execution
server-side. The SEO audit is now the first product to make that move: its
output is produced entirely in the Worker behind `requireUser`, so it cannot be
generated by reading the browser code. The other five engines still run in the
browser.
