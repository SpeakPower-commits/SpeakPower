# SpeakPower Studio — Supabase setup

This folder contains the backend foundation for:

- email magic-link sign-in
- three lifetime free Studio generations per authenticated user
- one paid generation per completed Studio purchase
- Flutterwave payment creation, verification and webhook handling

## 1. Create a dedicated Supabase project

Use a separate SpeakPower Supabase project rather than mixing this with the UBF, Tonninyira or Friends-of-Biodiversity databases.

Run the migration:

`supabase db push`

or apply `migrations/20260928_studio_access_billing.sql` from the Supabase dashboard.

## 2. Configure Auth

In Supabase Auth:

- Set the Site URL to the live SpeakPower GitHub Pages URL.
- Add the Studio product URL to the allowed redirect URLs.
- Enable Email authentication.
- Use Magic Link or email OTP.

Supabase supports passwordless email sign-in through Magic Link or OTP. Production email delivery should be configured for your own SMTP provider rather than relying on the restricted default email service.

## 3. Create the browser config

Copy:

`assets/supabase-config.js.example`

to:

`assets/supabase-config.js`

and fill in the project URL and publishable key.

The publishable key may be used in the browser. Never place a Supabase secret/service-role key or Flutterwave secret in GitHub Pages.

## 4. Deploy Edge Functions

Deploy these functions with JWT verification enabled:

- `studio-access`
- `studio-create-payment`
- `studio-payment-status`

Deploy `flutterwave-webhook` with JWT verification disabled because Flutterwave calls it directly. The function itself validates the Flutterwave webhook secret hash.

## 5. Server secrets

Set these Supabase Edge Function secrets:

- `SUPABASE_SERVICE_ROLE_KEY` — temporary compatibility path; prefer the current Supabase secret-key mechanism when configuring the project.
- `SPEAKPOWER_SITE_URL=https://speakpower-commits.github.io/SpeakPower-`
- `FLW_SECRET_KEY=<Flutterwave server secret>`
- `FLW_SECRET_HASH=<Flutterwave webhook secret hash>`

Do not commit any of those secret values.

## 6. Payment lifecycle

1. Authenticated user requests a run.
2. `studio-access` atomically consumes a trial or paid entitlement.
3. Once free trials are exhausted, the browser calls `studio-create-payment`.
4. Flutterwave hosts checkout.
5. Flutterwave calls `flutterwave-webhook`.
6. The webhook re-verifies the transaction server-side before granting a paid entitlement.
7. On return, Studio checks the order status.
8. The next Studio run consumes the paid entitlement.

## Important implementation note

The existing Studio product engines still run in the browser. The access-control foundation is server-backed, but the actual template/audit/data-generation code remains visible to the browser because SpeakPower is currently hosted as a static GitHub Pages site.

This means the three-trial counter and payment records are authoritative, but a technically sophisticated visitor could still bypass a client-only generation gate.

For true paid-product enforcement, the next hardening phase should move the actual product execution behind authenticated Edge Functions so the browser receives output only after the server authorizes the run.

