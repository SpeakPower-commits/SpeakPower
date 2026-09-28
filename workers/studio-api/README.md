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

