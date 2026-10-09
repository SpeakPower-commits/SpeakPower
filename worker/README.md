# SpeakPower API — accounts, the Studio and GRIOT on Cloudflare

One Worker runs every paid service on the site, with nobody in the loop:

**sign in with Google → 3 free tries, on any service → a 30-day plan for GRIOT and the Rehearsal Room, or a one-off Studio pack → paid by card or mobile money → settled automatically.**

Visitors can browse everything without an account. An account is needed to *use* a service: the Rehearsal Room, GRIOT and the six Studio packs. The Clarity Audit stays free and runs in the browser.

Everything here is set up in a browser. No local tools needed.

```
Browser (GitHub Pages)  ──session token──▶  this Worker  ──X-API-Key + X-Tenant-Id──▶  GRIOT (Vercel)
                                              │  D1: accounts, free tries, plans, balance,
                                              │      every use, every payment
                                              ├──▶ Flutterwave (checkout + verification)
                                              └──▶ the site being audited (SEO audit)
```

The browser never sees GRIOT's address or key, never chooses its own tenant, and never decides a price. The Worker sets `X-Tenant-Id` to the account's own row id, every time.

---

## Plans and prices

**GRIOT and the Rehearsal Room are never priced per use.** After the 3 free tries they come with a plan (`PLANS` in `worker.js`), 30 days each:

| Plan | Price | Fair use in 30 days (shown only in plan details) |
|---|---|---|
| Starter | UGX 60,000 | 120 GRIOT questions, 20 rehearsals |
| Pro | UGX 150,000 | 300 GRIOT questions, 60 rehearsals, 1 Studio pack, 15% off other packs |

- **Spending order,** each step one atomic `UPDATE`: the plan's allowance → a free try → (Studio packs only) the balance.
- **Pages show a share of the month, never a count.** The Worker sends percentages; 100% only when nothing is left.
- **Renewing the same plan early** adds 30 days after the current end, so no day is lost. **Switching plan** starts the new one at once and ends the old one that day.
- **Each period keeps the limits it was bought with**, so changing `PLANS` never alters what someone already paid for.
- **Mobile money cannot auto-debit,** so nothing renews on its own. Pages show "renew" from three days before the end.

Studio packs keep a one-off price, paid from a balance in Uganda shillings (`PRICES` in `worker.js`):

| Studio pack | Price |
|---|---|
| Brand Story Builder | UGX 100,000 |
| Website SEO & Visibility Audit | UGX 75,000 |
| Market Development Planner | UGX 125,000 |
| SEO Content Starter | UGX 75,000 |
| Data Story Builder | UGX 100,000 |
| Speaker Ready Pack | UGX 75,000 |

**To change a price**, change it everywhere it appears: `PLANS` or `PRICES` in `worker.js`, the cards in `plans.html` and `studio.html`, and `studio-product.js` for packs. The test suite fails if any of them disagree, and if any page quotes a per-message or per-rehearsal price.

Suggested top-ups (`TOPUP_AMOUNTS`, default `50000,100000,250000`) are only suggestions: the pay wall always leads with *exactly what this use needs*. Any whole amount from UGX 1,000 to UGX 5,000,000 is accepted.

---

## Launch checklist — in this order

The order matters in exactly one place: **GRIOT must have tenancy before the Worker talks to it.** The Worker checks (`/health` must report `"tenancy": true`) and refuses GRIOT traffic, charging nothing, until it does.

### 1. GRIOT — tenancy

1. **claude-central-agent PR #22 is merged.** Open `https://<your-griot>.vercel.app/health`: it must show `"tenancy": true`. If it does not, the production deployment has not picked up the merge yet.
2. Note your `GRIOT_API_KEY` from Vercel's environment variables — the Worker needs the same value.

**Cost control:** a typical GRIOT answer costs about $0.09 on `claude-opus-5-5`; at 16,000 output tokens the worst case is about $0.37. Plans are sized so the full fair use stays inside the price (Starter: 120 × $0.09 ≈ UGX 40,000 of UGX 60,000), which holds only if one answer cannot run long. Release 4 has the Worker ask GRIOT for at most 4,000 tokens for clients (about $0.13 worst case); your own GRIOT use is unaffected.

### 2. Database (Cloudflare D1) — done

**Already created, 6 October 2026:** D1 database `speakpower` (id `431826e5-d366-4fb0-8aa2-fd73651ac700`, Eastern Europe), with `schema.sql` loaded — seven tables: `users`, `runs`, `payments`, `events`, `leads`, `rate_log`, `otp_codes`.

To rebuild it from scratch: Dashboard → **Storage & Databases → D1 → Create** → `speakpower` → **Console** → paste the whole of `schema.sql` → run. Every statement is idempotent.

> The older `speakpower-studio` database (29 September) belongs to an earlier, Clerk-based attempt: no customers (0 users, 0 orders). Once the Worker below is bound to `speakpower`, nothing uses it; it can be deleted.

### 3. The Worker — `speakpower`, deployed from GitHub

The Worker is built from this repository on every push, so there is nothing to paste. The site already points at `https://speakpower.thomasotieno583.workers.dev` (`apiBase` in `site-config.js`).

**Created 7 October 2026** with **Import a repository**, which named it `speakpower` after the repository. The two earlier, unused Workers (`speakpower-studio-api` and the first `speakpower`, both from 29 September) are deleted. To create it again: Dashboard → **Workers & Pages → Create application → Import a repository** → `SpeakPower-commits/SpeakPower`:

| Setting | Value |
|---|---|
| Project / Worker name | `speakpower` — must equal `name` in `wrangler.toml`, or the build fails; it also sets the web address above |
| Production branch | `claude/studio-griot-live` while testing on the preview; `main` once PR #9 is merged (`main` has no `worker` folder until then) |
| Root directory / Path (Advanced) | `worker` |
| Build command | leave empty |
| Deploy command | `npx wrangler deploy` |

**Save and Deploy.** To change any of this later: the Worker → **Settings → Builds**. Cloudflare hides the browser "Edit code" button on Git-connected Workers — that is expected.

`wrangler.toml` in this folder does the rest on every deploy: the D1 binding `DB` → `speakpower`, the public variables (including `GOOGLE_CLIENT_ID`) and the daily clean-up schedule. It keeps any plain-text variable you add in the dashboard (`keep_vars = true`) and never touches secrets.

Check: `…workers.dev/health` returns `{"ok":true}`.

**If pushes never start a build** — no "Workers Builds" check on the commit in GitHub, and the Worker's "last modified" time does not move — the Build settings are not the problem. Cloudflare only hears about a push through its GitHub App, **Cloudflare Workers and Pages**, and that app must have access to this repository. Every app with access leaves a check record on each commit, so its absence on a commit is the tell (`GET /repos/SpeakPower-commits/SpeakPower/commits/<sha>/check-suites` lists them). As of 7 October 2026 the records on every commit came only from GitHub Pages, GitHub Actions, Cursor and Claude, never from Cloudflare. To fix it: open [github.com/settings/installations](https://github.com/settings/installations) as `SpeakPower-commits` → **Cloudflare Workers and Pages** → **Configure** → **Repository access** → add `SpeakPower` → **Save**. If the app is not listed, install it from [github.com/apps/cloudflare-workers-and-pages](https://github.com/apps/cloudflare-workers-and-pages) on the `SpeakPower-commits` account. Then push any commit; a check from "Cloudflare Workers and Pages" should appear on it within a minute. (Access was granted to all repositories on 7 October 2026, after which the first push started the first build.)

### 4. Google sign-in — client created

**Done, 6 October 2026:** OAuth client `182240978118-lgaemhoen0o04o649rqtin1fd8j18dgm.apps.googleusercontent.com`. It is in `wrangler.toml` as `GOOGLE_CLIENT_ID` and in `site-config.js` as `googleClientId` (switched on 7 October 2026, after the first successful Worker build).

- The **client secret is not used** anywhere in this system — sign-in in the browser needs only the ID, and the Worker checks Google's signature with Google's public keys. Delete or disable the secret (Google Auth Platform → Clients → this client), and never put it in this repository or a Worker variable.
- The client's **Authorised JavaScript origins** must include exactly `https://speakpower-commits.github.io` (no path, no trailing slash). Add your own domain there too when the site moves to it.

To create a client from scratch: Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**:

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

### 6. Google Lighthouse scores for the SEO audit (optional)

The audit works without this: SpeakPower's own checks of the live page are the product. A key adds Google's Lighthouse scores on top.

Google Cloud Console (same project as step 4) → **APIs & Services → Library → PageSpeed Insights API → Enable** → **Credentials → Create credentials → API key** → edit it: **API restrictions → PageSpeed Insights API only**; **Application restrictions → None** (the call comes from a Cloudflare datacentre, so a website or IP restriction would block it).

### 7. Worker variables and secrets

Worker → **Settings → Variables and Secrets**. Paste each secret straight from where it was issued — never into a chat, a file or a screenshot.

Only the secrets go here — the public settings are already in `wrangler.toml` and arrive with every deploy.

| Name | Type | Value |
|---|---|---|
| `SESSION_SECRET` | **Secret** | 32+ random characters. Changing it signs everyone out. |
| `GRIOT_API_KEY` | **Secret** | Same value as on Vercel. |
| `FLW_SECRET_KEY` | **Secret** | From step 5 — when you switch on top-ups. |
| `FLW_SECRET_HASH` | **Secret** | The secret hash you chose in step 5. |
| `PAGESPEED_KEY` | **Secret** | Optional, from step 6. |
| `ANTHROPIC_API_KEY` | **Secret** | Optional: written coaching in the Rehearsal Room. Create it at console.anthropic.com. |

Already in `wrangler.toml`: `ENVIRONMENT`, `ALLOWED_ORIGINS`, `FREE_TRIALS`, `SITE_URL`, `GRIOT_API_BASE`, `TOPUP_AMOUNTS`. `GOOGLE_CLIENT_ID` is added there (it is public) once step 4 is done.

Top-up switches on only when `FLW_SECRET_KEY` and `FLW_SECRET_HASH` are both set. Until then the pay wall offers a "talk to me" link instead — it never shows a button that takes money it cannot credit.

Check: `https://<your-worker>/health` returns `{"ok":true}`.

### 8. Connect the site

**Done, 7 October 2026:** `apiBase` points at the `speakpower` Worker and `googleClientId` is set, on the preview branch first. Neither is secret. If either is ever emptied, the site behaves as a brochure: no "Sign in" in the header, and the Studio, GRIOT and account pages say they are being connected.

### 9. Test on the preview, then go live

With your own Google account:

1. Header → **Sign in** → you land on your account: **3 free tries**, and the plans.
2. Use one free try each on the Rehearsal Room, the SEO audit and GRIOT. The header counts down.
3. Ask GRIOT again: the wall offers **Starter** and **Pro**, with no price per message. Choose Starter, pay with a Flutterwave **test** card or test mobile money, and come back to "your Starter plan runs until …".
4. Ask GRIOT and rehearse: the usage bar moves; the header reads "Account · Starter".
5. Open the Market Development Planner and press Generate: the pay wall offers **Top up UGX 125,000 — exactly what this needs**. Pay, come back with your answers still filled in, and generate.
6. Sign out and back in: same plan, same balance, no fresh free tries.

Then switch `FLW_SECRET_KEY` to the live key, and merge the preview into `main`.

---

## How the money is kept honest

- **Free tries are granted once, on account creation**, and shared by every service. Signing in again, by Google or by email, through any Gmail alias (`a.b+x@gmail.com` is `ab@gmail.com`), never resets them.
- **Every use reserves before it runs**, in one atomic statement: the plan's allowance, else a free try, else (Studio packs only) the pack's exact price, and only if the balance covers it. Two tabs at once can never spend the same try or take the balance below zero (the database refuses a negative balance outright).
- **A failed use is given back exactly**: the plan use, the free try, or the shillings taken. A page that cannot be reached, GRIOT down, slow (120 s ceiling), rate-limited or returning garbage — the customer is told they were not charged.
- **Payments are settled in one place**, reached from the webhook and from the customer's return to the page, in either order, any number of times — and settle exactly once: a top-up credits the balance, a plan payment opens its 30 days.
- **No payment notification is believed on its own.** Each is re-verified with Flutterwave's API: status `successful`, this payment's reference, the right currency, at least the right amount. The shillings credited come from our own payment row, never from the notification.
- **The webhook's secret hash is compared in constant time.**
- **A bank later** slots in without a schema change: `payments.provider` is `flutterwave` today.

## The SEO audit

Two layers. **SpeakPower's own checks** fetch the customer's page and read it with Cloudflare's HTML parser: indexability (including an `X-Robots-Tag` header), HTTPS, title and description length, H1 and heading order, canonical, JSON-LD validity, Open Graph and X cards, image alt text, viewport, language, content depth, internal links, favicon. These need no key and no quota. **Google Lighthouse scores** are added when `PAGESPEED_KEY` is set; a broken key, a spent quota or a slow page is reported plainly and never fails the audit.

The Worker fetches an address the customer types, so it only fetches public websites by domain name, on the normal ports, and re-checks every redirect before following it. Only an unreadable page fails an audit — and that is refunded.

There is deliberately no result cache: a customer who fixes their site and pays to run the audit again must get today's page.

**Plan note:** the free Workers plan allows 10 ms of CPU per request. Reading a large page plus Google's Lighthouse response can come close. If the Worker's logs show "exceeded CPU" on audits, the Workers Paid plan ($5 a month) lifts the limit to 30 seconds.

## Email-code sign-in (optional, off by default)

The Worker also supports sign-in by a 6-digit emailed code. It stays off (`emailCodes: false` in `site-config.js`) because Cloudflare only sends email to arbitrary addresses on the **Workers Paid plan**, from **a domain you own on Cloudflare DNS**. Once both exist: onboard the domain in **Email Service → Email Sending**, add the `SEND_EMAIL` binding, set `MAIL_FROM` and `TURNSTILE_SECRET`, create a Turnstile widget, and flip `emailCodes` to `true`.

## The GRIOT workspace

- **What clients see** on `griot-app.html`: up to three chosen **lenses** (GRIOT's specialists), GRIOT's **nine steps** lighting up while it works, and the **Conversations**, **Memory** and **Decisions** tabs.
- **Routes:** `GET /griot/workspace`, `/griot/threads`, `/griot/thread?id=`, `/griot/memories`, `/griot/decisions`; `POST /griot/memory`, `/griot/memories/delete`.
  - Every route runs behind the session, sets `X-Tenant-Id` to the account's own id, and charges nothing.
  - GRIOT's `/projects` (your own ventures) is never reachable.
- **Bounded turns:** every client question goes to GRIOT with `effort: "medium"` and an 8,000-token backstop (`GRIOT_CLIENT_EFFORT`, `GRIOT_CLIENT_MAX_TOKENS`). Effort shortens reasoning; the backstop only stops a runaway answer, and GRIOT says when one was cut short.
- **Switching on:** this needs claude-central-agent PR #24 deployed, which reports `"workspace": true` on `/health`. Until then, the tabs and lens picker stay hidden and plain questions work as before.

## The Rehearsal Room

- **Speech to text** is Workers AI (`@cf/openai/whisper-large-v3-turbo`), through the `AI` binding in `wrangler.toml`: nothing to set up in the dashboard. It costs about $0.0005 an audio minute; the free 10,000 neurons a day cover roughly 214 minutes (about 70 three-minute rehearsals).
- **Delivery is measured in the Worker**, exactly, from Whisper's word timings: pace, fillers a minute, long pauses (over 2.5 s) a minute, the longest sentence. The Speak Score is `100 × (0.25 pace + 0.20 fillers + 0.15 flow + 0.40 message)`.
- **Written coaching** (the message part: POLSΘ ratings, three fixes, an opening line, a 60-second version) comes from Claude (`claude-opus-5-5`) through the official Anthropic SDK, the Worker's one dependency (`package.json`; Workers Builds installs it). It needs the `ANTHROPIC_API_KEY` secret. Without it a rehearsal is scores only; if the coach cannot answer, the scores still show and that rehearsal does not count. About $0.03 a rehearsal.
- **The audio is never stored**, nor the transcript: the browser sends it, Whisper reads it, and it is gone. D1 keeps the scores and the coaching (`rehearsals`) so customers see their progress; "Delete my rehearsals" removes them.
- **CPU:** the browser sends the recording already in base64 (Opus at 32 kbps: three minutes is about 1 MB), so the Worker only parses it, about 1 ms on the free plan's 10 ms allowance.
- **The `rehearsals` table** is in `schema.sql`; on an existing database run its `CREATE TABLE IF NOT EXISTS rehearsals …` block once in the D1 console. The same goes for `subscriptions`, plus `ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'topup';`.

## Known limitation

If someone closes the tab while GRIOT is still answering, Cloudflare cancels the Worker's wait and the message is not refunded. GRIOT still finishes and keeps the exchange in that client's thread, so the next message carries on from it.

## Measuring the funnel (D1 console)

```sql
-- Sign-ins, uses, pay walls, checkouts and payments, last 30 days
SELECT name, COUNT(*) AS n FROM events
WHERE created_at > unixepoch() - 30*86400
  AND name IN ('signup_verified', 'studio_generate', 'griot_message', 'payment_required', 'topup_checkout', 'topup_paid')
GROUP BY name;

-- Which services people use, free and paid
SELECT product, paid_with, COUNT(*) AS uses, SUM(amount) AS ugx
FROM runs WHERE status = 'ok' GROUP BY product, paid_with ORDER BY uses DESC;

-- Top-ups by day
SELECT date(paid_at, 'unixepoch') AS day, COUNT(*) AS payments, SUM(amount) AS ugx
FROM payments WHERE status = 'paid' GROUP BY day ORDER BY day DESC;
```

## Testing

```
cd worker && npm install && cd .. && node --experimental-sqlite worker/test/run-tests.mjs
```

The business rules, fast, in plain Node: the real `worker.js` against an in-memory D1, with Google, GRIOT, Flutterwave and audited sites faked at the network edge only. Google sign-in is tested with real RS256 signatures, so forged keys, `alg: none` and edited tokens are refused by actual cryptography rather than a stub. It also fails if any page quotes a different price from the Worker.

```
cd worker && npm install && npm install --no-save miniflare@4 wrangler@4 && node test/run-workerd-tests.mjs
```

The Worker bundled exactly as Workers Builds deploys it (`wrangler deploy --dry-run`), on **workerd**, the engine Cloudflare runs Workers on: real D1, the real HTML parser for the SEO audit, WebCrypto sign-in, and the exactly-once top-up under truly concurrent notifications. It also audits this site's own pages.
