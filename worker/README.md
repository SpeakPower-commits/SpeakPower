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
| Starter | UGX 60,000 | 120 GRIOT questions, 20 rehearsals, 10 video edits; keeps 10 documents for GRIOT |
| Pro | UGX 150,000 | 300 GRIOT questions, 60 rehearsals, 40 video edits, 1 Studio pack, 15% off other packs; keeps 50 documents |

A free account keeps 1 document. Documents are a number held, not a monthly allowance: deleting one frees its place.

- **Spending order,** each step one atomic `UPDATE`: the plan's allowance → a free try → (Studio packs only) the balance.
- **Pages show a share of the month, never a count.** The Worker sends percentages; 100% only when nothing is left.
- **Renewing the same plan early** adds 30 days after the current end, so no day is lost. **Switching plan** starts the new one at once and ends the old one that day.
- **Each period keeps the limits it was bought with**, so changing `PLANS` never alters what someone already paid for.
- **Mobile money cannot auto-debit,** so nothing renews on its own. Pages show "renew" from three days before the end.

Studio packs keep a one-off price, paid from a balance in Uganda shillings (`PRICES` in `worker.js`):

| Studio pack | Price |
|---|---|
| Brand Story Builder | UGX 100,000 |
| Website SEO & Visibility Audit | UGX 150,000 |
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
| `GA4_API_SECRET` | **Secret** | Optional: Google Analytics → Data streams → SpeakPower → Measurement Protocol API secrets. Lets the Worker report settled purchases ([Google Analytics](#google-analytics)). |
| `YOUTUBE_API_KEY` | **Secret** | Optional: turns on [YouTube research](#youtube-research). |
| `YOUTUBE_ADMINS` | Text | Optional: more email(s) allowed to use YouTube research, comma-separated. Admin accounts always may. |

Already in `wrangler.toml`: `ENVIRONMENT`, `ALLOWED_ORIGINS`, `FREE_TRIALS`, `ADMIN_EMAILS`, `SITE_URL`, `GRIOT_API_BASE`, `TOPUP_AMOUNTS`, `GOOGLE_CLIENT_ID` and `GA4_MEASUREMENT_ID` (all public).

### Admin accounts

`ADMIN_EMAILS` in `wrangler.toml` (comma-separated) names the owner's own accounts. Signed in as one of them, every service works with **no free tries, plan, balance or document limit**: GRIOT, the Rehearsal Room, every Studio pack, documents, and YouTube research with the whole day's quota. The pages say "Admin access" and never show a pay wall.

- **Who it opens.** Only a verified sign-in to that address: Google has confirmed it, or a code sent to it was entered. Matching is on the canonical address, so for Gmail `t.o@gmail.com` and `to+demo@gmail.com` are the same inbox and the same admin.
- **What still applies.** Each use is recorded in `runs` as `paid_with = 'admin'`, amount 0, so the account page and the funnel still show what was used. The per-hour abuse limits stay (for example 30 rehearsals an hour), and so does the 20-project ceiling every account has: they protect the GRIOT, Anthropic and Workers AI bills if a session token ever leaked. YouTube's own 10,000 units a day cannot be lifted from here.
- **Changing it.** Edit `ADMIN_EMAILS` in `wrangler.toml` and push. A deploy writes this value over the dashboard's, so change it here, not there. Removing an address ends its access on the next request; nothing is stored against the account.

Top-up switches on only when `FLW_SECRET_KEY` and `FLW_SECRET_HASH` are both set. Until then the pay wall offers a "talk to me" link instead — it never shows a button that takes money it cannot credit.

Check: `https://<your-worker>/health` returns `{"ok":true}`.

### 8. Connect the site

**Done, 7 October 2026:** `apiBase` points at the `speakpower` Worker and `googleClientId` is set, on the preview branch first. Neither is secret. If either is ever emptied, the site behaves as a brochure: no "Sign in" in the header, and the Studio, GRIOT and account pages say they are being connected.

### 9. Test on the preview, then go live

With your own Google account:

1. Header → **Sign in** → two short welcome steps (who you are; your challenge) → **Brief GRIOT** → the Ready screen lists exactly what GRIOT was told. Your account then shows **3 free tries**, the plans and your profile.
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

## The website audit

The audit reads **the whole site**, up to 25 pages, the way a search engine or an AI assistant would, and checks that private areas stay private. It then adds Google Lighthouse with real-visitor speed, and a strategic read written by Claude. Price: UGX 150,000.

**Stages.** The free Workers plan allows 10 ms of processing and 50 outbound requests per call, so one call cannot do all of this. The audit lives in D1 (`audits`) and moves on in short stages that the page calls one after another:

| Stage | Route | What it does |
|---|---|---|
| start | `POST /studio/generate` | Charges, then reads the home page (15 s to answer, asked twice; 15 s to read). Also reads `robots.txt`, the sitemap, `llms.txt`, the `http://` and www twins, one made-up address (a real 404?) and the share image. Plans the crawl. **Refunded if the home page cannot be read**; nothing later is charged. |
| crawl | `POST /studio/audit/run {id, stage:"crawl"}`, repeated | 4 pages a call (the client's extra pages first, then the home page's links, then the sitemap; same site only; `robots.txt` respected), then up to 25 links that lead off the pages read, then the private areas. |
| lighthouse | `POST /studio/audit/run {id, stage:"lighthouse"}` | After the crawl, so Google never competes with it for the site. Up to 100 s, and one more try if it times out. Asks only for the fields the report uses, including the Chrome UX Report's real-visitor LCP, INP and CLS. |
| strategy | `POST /studio/audit/run {id, stage:"strategy"}` | Runs alongside Lighthouse. Claude (`claude-opus-5-5`, structured output) reads the facts (never the account's details) and writes the summary, the first impression, message clarity (Audience · Offer · Proof · Action · Voice), five priorities and a 30-60-90 plan. One more try if it fails. |
| report | `GET /studio/audit?id=`, `GET /studio/audits` | The assembled report, its 8 category scores and the overall score; the client's last 5 audits. |

Every stage is safe to call twice:
- crawl writes carry a version check;
- Lighthouse and the strategic read are claimed before they run;
- only the audit's owner can read it or move it on.

Reports are kept 90 days, then the daily run deletes them.

**Private areas.** Only addresses the site itself links to, or the client lists, whose path looks private (`login`, `account`, `admin`, `dashboard`, `cart`, `checkout`…). Each is visited once, without signing in, and classed:
- **protected:** 401 or 403, a redirect to a sign-in page, `noindex`, or disallowed by robots;
- **exposed:** opens to anyone and open to search engines.

**No path is ever guessed**, and the `robots.txt` disallow list is reported, not fetched.

**Scores.** Each check passes (1), needs review (0.5) or fails (0), and has a weight. A category's score is the weighted share of its checks that pass, and a Lighthouse score counts as its own value. The overall score is the weighted mean of the 8 categories: Crawl & index, Page basics, Content, Structured data & AI visibility, Social sharing, Speed, Mobile & accessibility, Security & trust.

**Safety.** The Worker fetches addresses a customer types, so it only fetches public websites by domain name, on the normal ports, and re-checks every redirect before following it.

**What it cannot see:** rankings, search traffic, backlinks and conversions, which need the site's own Search Console and analytics data. The report says so.

## Email-code sign-in (optional, off by default)

The Worker also supports sign-in by a 6-digit emailed code. It stays off (`emailCodes: false` in `site-config.js`) because Cloudflare only sends email to arbitrary addresses on the **Workers Paid plan**, from **a domain you own on Cloudflare DNS**. Once both exist: onboard the domain in **Email Service → Email Sending**, add the `SEND_EMAIL` binding, set `MAIL_FROM` and `TURNSTILE_SECRET`, create a Turnstile widget, and flip `emailCodes` to `true`.

## The GRIOT workspace

- **What clients see** on `griot-app.html`, the full-screen GRIOT OS app (`griot-app.css`): up to three chosen **lenses** (GRIOT's specialists), GRIOT's **nine steps** lighting up while it works, their own **projects**, and the **Conversations**, **Memory**, **Decisions** and **Documents** views.
- **Routes:** `GET /griot/workspace`, `/griot/threads`, `/griot/thread?id=`, `/griot/memories`, `/griot/decisions`; `POST /griot/memory`, `/griot/memories/delete`.
  - Every route runs behind the session, sets `X-Tenant-Id` to the account's own id, and charges nothing.
  - GRIOT's `/projects` (your own ventures) is never reachable.
- **Bounded turns:** every client question goes to GRIOT with `effort: "medium"` and an 8,000-token backstop (`GRIOT_CLIENT_EFFORT`, `GRIOT_CLIENT_MAX_TOKENS`). Effort shortens reasoning; the backstop only stops a runaway answer, and GRIOT says when one was cut short.
- **Switching on:** this needs claude-central-agent PR #24 deployed, which reports `"workspace": true` on `/health`. Until then, the tabs and lens picker stay hidden and plain questions work as before.
- **Client projects:** a client keeps their own projects, and each conversation, memory and decision is filed under one of them (or General, GRIOT's `global`).
  - **Routes:** `GET /griot/my-projects` (`{ready, projects, limit}`); `POST /griot/my-projects` `{name}` creates one; `POST /griot/my-projects/rename` `{slug, name}`; `POST /griot/my-projects/delete` `{slug}` deletes it with everything filed under it.
  - **Names** are one line, up to 60 characters. **Slugs** are made by GRIOT (`p-` and 8 hex characters), so a client's project can never be, or name, one of your ventures.
  - **At most 20 per account**, checked here and by GRIOT.
  - **Projects reach GRIOT** on `POST /griot/chat` and `POST /griot/memory` as `project`, and on the lists as `?project=` (threads, memories, decisions). The Worker checks the slug's shape; GRIOT checks it is this tenant's own, and a refused question is given back. General is never sent as a project. One of your ventures (`speakpower`, `tonninyira`…) is refused outright.
  - **Shared across projects:** documents and the sign-up profile, so GRIOT knows the client in every project.
  - **Switching on:** this needs claude-central-agent PR #29 deployed, which reports `"projects": true` on `/health`. Until then `/griot/my-projects` answers `ready: false`, the picker stays hidden, and everything works in General. GRIOT's `/projects` (your ventures) stays unreachable: `/griot/projects` is a 404.
- **Challenge · Diagnose · Plan:** `POST /griot/chat` takes an optional `mode` (`challenge`, `diagnose` or `plan`; anything else is refused before a use is spent). It reaches GRIOT as `answer_mode`, a fixed instruction GRIOT holds itself, so no browser text becomes prompt text; the question is sent unchanged. Sent only when GRIOT's `/health` reports `"modes": true` (claude-central-agent PR #26); until then `/griot/workspace` lists no modes and the buttons stay hidden. One question is still one use.

## Know the customer: the sign-up profile

- **Two short steps after sign-in** (`welcome.html`): 1. who you are (name, position, organisation, expertise; sector, place and WhatsApp optional); 2. your challenge (the problem, the goal and its deadline, why now, focus areas).
- **Enforced before anything is spent:** step 1 before any service, step 2 before GRIOT too. A page that skips them gets `409 profile_required` naming the step, and nothing is charged. A visitor heading for the Studio or the Rehearsal Room may skip step 2.
- **Routes:** `GET /profile`, `POST /profile` (`step: 1` or `2`), `POST /profile/delete`. `/me` and `/account` carry `profile: {step1, step2}`.
- **The name to greet by:** step 1 asks "What should we call you?" (optional, up to 40 characters, `profiles.call_me`; pre-filled with the first word of the name). `/account` returns it as `greetName`, falling back to the first word of the name, and the site shows "Hi Thomas, welcome back" on Home, Account, GRIOT and Rehearse. GRIOT's Profile memory adds "(goes by Thomas)". The column is in `schema.sql` and was added to the live D1 with `ALTER TABLE profiles ADD COLUMN call_me TEXT`.
- **Briefing GRIOT needs a yes** ("Brief GRIOT"; "Save without telling GRIOT" keeps it here). With it, the Worker writes up to five memories of kind `profile` in the client's own GRIOT space: Profile, Challenge, Goal, Why now, Focus. GRIOT keeps `profile` memories in every turn (claude-central-agent PR #24). **Email and WhatsApp number never go to GRIOT**; the number is kept only with the say-so to use it.
- **Edits replace, deletion removes.** The ids of what GRIOT was told are kept (`profiles.griot_memory_ids`). An edit deletes them and writes fresh ones; "Delete my profile" wipes every personal field at once, then removes GRIOT's copies.
- **When GRIOT can't take it** (unreachable, or #24 not yet deployed) the profile still saves and the briefing waits as `pending`: it is sent before the client's next question, and the daily cron retries it, including copies a deleted profile left in GRIOT. One sync runs at a time per account (a one-minute lease); a save during a sync leaves it pending, so GRIOT never keeps an older version marked as current.
- **The `profiles` table** is in `schema.sql`, already applied to the live D1.
- **Yours to check before launch:** this collects personal data, so confirm registration with Uganda's Personal Data Protection Office under the Data Protection and Privacy Act 2019.

## Documents for GRIOT

- **What a client sees:** GRIOT → **Documents**. Add a PDF, Word, Excel, CSV or text file (or a JPG/PNG/WebP image), up to 10 MB. GRIOT reads it once and keeps a short summary and 8–20 key facts, with their pages. Each document can be switched off or deleted.
- **Reading:** Workers AI `toMarkdown` turns the file into text; PDFs come with "### Page N" headings, so facts keep their page. Text and CSV files are decoded in the Worker. Claude (`claude-opus-5-5`, effort `low`, structured output) then writes the summary and facts. The document is treated as data, never instructions.
- **The file is never stored.** Only the summary and facts are kept, in D1 (`documents`). Nothing is used to train AI.
- **What's checked before anything is read:**
  - the type, from the file's own first bytes (a renamed executable is refused);
  - the size: up to 10 MB;
  - sign-up step 1;
  - the plan's number of documents: 1 free, 10 on Starter, 50 on Pro. A second, exact check when the document is saved stops two uploads at once from overfilling it.
- **Using them:** for each GRIOT question the Worker picks up to 10 facts from the client's own switched-on documents that share the most meaningful words with the question. A word-overlap score, light on CPU. It also includes a document's summary when the question names it. They go to GRIOT as `context`, and GRIOT cites them, e.g. "[Annual report 2025, p. 4]". The answer says which documents it drew on.
- **Needs GRIOT's document support** (`/health` reports `"documents": true`, from claude-central-agent PR #25). Until then, documents are read and kept, but no `context` is sent and no answer claims to use them.
- **Routes:** `GET /griot/documents`, `GET /griot/document?id=`, `POST /griot/documents?name=` (the file as the body), `POST /griot/documents/toggle`, `POST /griot/documents/delete`. Every route is scoped to the signed-in account.
- **The `documents` table** is in `schema.sql`, already created on the live D1.
- **Cost:** converting a document is free; images use Workers AI's vision models. Claude's reading costs about US$0.05–0.15 a document.

## The Rehearsal Room

- **Speech to text** is Workers AI (`@cf/openai/whisper-large-v3-turbo`), through the `AI` binding in `wrangler.toml`: nothing to set up in the dashboard. It costs about $0.0005 an audio minute; the free 10,000 neurons a day cover roughly 214 minutes (about 70 three-minute rehearsals).
- **Delivery is measured in the Worker**, exactly, from Whisper's word timings: pace, fillers a minute, long pauses (over 2.5 s) a minute, the longest sentence. The Speak Score is `100 × (0.25 pace + 0.20 fillers + 0.15 flow + 0.40 message)`.
- **Written coaching** (the message part: POLSΘ ratings, three fixes, an opening line, a 60-second version) comes from Claude (`claude-opus-5-5`) through the official Anthropic SDK, the Worker's one dependency (`package.json`; Workers Builds installs it). It needs the `ANTHROPIC_API_KEY` secret. Without it a rehearsal is scores only; if the coach cannot answer, the scores still show and that rehearsal does not count. About $0.03 a rehearsal.
- **The audio is never stored**, nor the transcript: the browser sends it, Whisper reads it, and it is gone. D1 keeps the scores and the coaching (`rehearsals`) so customers see their progress; "Delete my rehearsals" removes them.
- **CPU:** the browser sends the recording already in base64 (Opus at 32 kbps: three minutes is about 1 MB), so the Worker only parses it, about 1 ms on the free plan's 10 ms allowance.
- **The `rehearsals` table** is in `schema.sql`; on an existing database run its `CREATE TABLE IF NOT EXISTS rehearsals …` block once in the D1 console. The same goes for `subscriptions`, plus `ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'topup';`.

## The AI Video Editor

`video.html` edits a raw video **on the customer's own computer**: cutting pauses and "um"s, choosing clips with a free in-browser AI, captions, titles, graphics, the brand kit and the MP4 export never touch the Worker. The Worker does one thing for it: turns the sound into words, with the Rehearsal Room's Whisper and its filler-keeping prompt.

- **One edit is one use**, like a rehearsal: a free try, then the plan's video edits (`PLANS[*].video`: Starter 10, Pro 40). `POST /video/start {seconds}` reserves it (videos up to two hours) and returns a job.
- **The sound arrives in two-minute pieces**, `POST /video/transcribe {job, index, audio, language}`: 16 kHz mu-law WAV in base64, about 2.6 MB each, so every request stays small and CPU-light. A job allows twice the pieces its length needs, for retries, and closes after six hours. Another account's job is a 404.
- **Nothing heard, nothing spent:** if no piece could be heard, the page calls `POST /video/refund {job}` and the use is given back (once).
- **The sound and the words are never stored.** `video_jobs` keeps only counts, and is cleared a day after each job ends.
- **Cost:** Workers AI, about $0.0005 an audio minute; the free 10,000 neurons a day cover roughly 3.5 hours.
- **Switching on**, once, in the D1 console:

  ```sql
  ALTER TABLE subscriptions ADD COLUMN video_limit INTEGER NOT NULL DEFAULT 10;
  ALTER TABLE subscriptions ADD COLUMN video_used INTEGER NOT NULL DEFAULT 0 CHECK (video_used >= 0);
  ```

  then the `CREATE TABLE IF NOT EXISTS video_jobs …` block from `schema.sql`. Until then `/video/start` fails without spending anything, and the editor still works for members on its in-browser speech model.

## YouTube research

`youtube.html` (not in the menu, not indexed): research a topic, compare channels, or check specific videos, with YouTube's exact counts and each video measured against **its own channel's recent uploads**. It is open only to [admin accounts](#admin-accounts) and the accounts named in `YOUTUBE_ADMINS`; anyone else signed in is told it is not open to them.

### Switch it on (once, about 10 minutes, all in a browser)

1. **The key.** Google Cloud Console → **APIs & Services → Library → YouTube Data API v3 → Enable**. If you already have a key, edit it there; otherwise **Credentials → Create credentials → API key**. Then **API restrictions → YouTube Data API v3 only**; **Application restrictions → None** (the call comes from a Cloudflare datacentre, so a website or IP restriction would block it).
2. **The secret.** Worker → **Settings → Variables and Secrets → Add** → type **Secret**, name `YOUTUBE_API_KEY`, paste the key. Never into a chat, a file or a screenshot.
3. **The tables.** D1 → `speakpower` → **Console** → paste the block of `schema.sql` that starts `-- YouTube research` → run. Every statement is idempotent.
4. **Check.** Sign in on the site with an admin account, open `youtube.html`: it shows today's quota. Research a topic.

Admin accounts may use it already. To let anyone else in: Worker → **Settings → Variables and Secrets → Add** → type **Text**, name `YOUTUBE_ADMINS`, their sign-in emails, comma-separated (`keep_vars = true` keeps it through every deploy).

In any order: until the key and the tables are in place the page says exactly which one is missing, and nothing else in the Worker changes. In particular, the nightly cleanup runs YouTube's deletions in a batch of their own, so missing tables can never stop the existing cleanup.

### What it measures

| Number | What it is | Whose |
|---|---|---|
| Views, likes, comments, published, length | As YouTube reports them when fetched (time shown) | YouTube's |
| **× channel median** | Views ÷ the median views of the channel's up to 30 newest uploads (leaving out the video itself and anything under 3 days old) | SpeakPower's |
| **z** | `(ln(1+views) − median) ÷ (1.4826 × MAD)` on the same uploads: how unusual the video is *for that channel*. No baseline is claimed from fewer than 5 uploads. | SpeakPower's |
| **Engagement** | `(likes + comments) ÷ views`, shrunk toward the set's pooled rate with the weight of 2,000 views. Unknown (not low) when likes are hidden. | SpeakPower's |
| **Growth** | Views a day between two fresh checks at least an hour apart. Check a video again after 6 hours to get it. | SpeakPower's |
| **Signal /60** | Performance against the channel (25) + timing (20) + engagement against the set (15). The other 40 of the research skill's 100 (relevance 30, adaptability 10) are an editor's call. Estimates are capped below what a measurement can earn. | SpeakPower's |

A young video is compared with older uploads that had longer to gather views, so a high score on a new video **understates** it. **Confidence** is High with 15+ uploads compared and likes and comments visible, Medium with a baseline, Low without one.

"Copy for a report" gives sections A and B in the YouTube Research Pocket skill's table format, with the evidence filled in. "Download CSV" gives every number, with formula-like cells neutralised for spreadsheets.

### The quota, and growing past it

YouTube allows **10,000 units a day** per Google project by default, resetting at midnight Pacific time. What things cost:

| Call | Units | Used for |
|---|---|---|
| `search.list` | **100** | Finding videos for a topic (two per topic: current and evergreen) |
| `videos.list` | 1 per 50 videos | Exact counts |
| `channels.list` | 1 per 50 channels, or 1 per @handle | Channel size; resolving handles |
| `playlistItems.list` | 1 per channel | A channel's newest uploads: its baseline |

A first topic research costs about **200–300 units**; the same research within 6 hours costs **0**. Comparing a channel costs about 3; checking 50 videos about 2 plus 2 per new channel.

- **The ledger** (`yt_quota`) charges every call *before* it is made, with one `UPDATE … WHERE units + cost <= budget` per check, for the account and for the day. Concurrent requests therefore cannot overspend. If YouTube itself says the quota is gone, the day is marked spent and nothing more is sent until it turns.
- **Budgets:** `YOUTUBE_DAILY_UNITS` (default 9,000, leaving headroom) and `YOUTUBE_USER_DAILY_UNITS` (default 3,000 per account; an admin account may use the whole day's), both optional text variables.
- **Caching:** videos and searches are reused for 6 hours, a channel's uploads for 12 and channel details for 24.
- **At product scale** (customers running research themselves), request more quota: Google Cloud → YouTube Data API v3 → **Quotas → request an increase**. That form leads to a YouTube API Services compliance audit. Already true here: data refreshed or deleted within 30 days, derived numbers labelled as such, and attribution on the page. **Still needed before applying:** a public privacy policy page (the site has none yet) that says the app uses YouTube API Services and links to the [Google Privacy Policy](https://policies.google.com/privacy), and a link to the [YouTube Terms of Service](https://www.youtube.com/t/terms) where customers use the tool. Opening it to customers is a pricing decision (a plan allowance like GRIOT's, or a Studio pack): the engine needs no change, only who passes `youtubeUser`.

### Data kept

Only what the analysis needs, and **at most 30 days** (YouTube API Services policy): `yt_videos`, `yt_channels`, `yt_uploads`, `yt_searches` and `yt_snapshots`. The daily cron deletes anything older, plus quota days older than 60. Nothing about who searched for what is stored beyond the quota ledger's unit counts.

### API

All need a session token from an admin account or one in `YOUTUBE_ADMINS`.

| Route | Body | Returns |
|---|---|---|
| `GET /youtube/quota` | — | Today's units: yours and everyone's, with budgets |
| `POST /youtube/analyze` | `query`, optional `days` (1–365, default 30), `evergreenDays` (90–3650, default 180), `region` (`UG`), `language` (`en`), `duration` (`any`, `short`, `medium`, `long`), `top` (1–10, default 5), `pool` (5–50, default 25) | `trending`, `evergreen`, `channels`, `coverage`, `spent`, `quota`, `method` |
| `POST /youtube/videos` | `videos`: up to 200 addresses or ids (`watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`) | `videos`, `channels`, `notFound`, `invalid` |
| `POST /youtube/channels` | `channels`: up to 25 @handles, channel addresses or `UC…` ids | `channels`, `notFound` |

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

## Google Analytics

The site reports to Google Analytics 4: property stream **SpeakPower**, stream ID `16127863463`, Measurement ID **`G-QMCCT15QTM`**. The Measurement ID is public; it is in `site-config.js` (`gaMeasurementId`) and `wrangler.toml` (`GA4_MEASUREMENT_ID`). Emptying `gaMeasurementId` switches the whole thing off: no banner, no Google tag.

**Consent (Consent Mode v2, advanced).** `analytics.js` sets every storage type to *denied* before anything reaches Google, then shows a banner with **Accept** and **Decline**. Accept grants `analytics_storage` only; ad storage, ad user data and ad personalisation stay denied, and Google signals and ad personalisation are off in the tag. Declined or undecided visitors send cookieless pings only, which Google uses to model totals once traffic is large enough. The choice is kept in the browser (`localStorage` `sp_consent`); **Cookie settings** in every footer and in GRIOT's sidebar reopens it, and withdrawing consent deletes the `_ga` cookies.

**What never leaves.** Page addresses are scrubbed: the query string and hash are dropped except `?product=` and `?service=`, so `tx_ref`, `transaction_id`, `audit`, `next` and sign-in returns never reach Google; another site's referrer is cut to its origin. No user id, name, email, GRIOT question, answer or form text is sent, and any event value that looks like an email or a phone number is dropped.

**Purchases are reported by the Worker.** At checkout a page that has consent sends GA's anonymous `client_id` and `session_id`; the Worker stores them on the payment row (`ga_client_id`, `ga_session_id`). When the payment settles — webhook or return page, exactly once — the Worker sends one `purchase` to the Measurement Protocol (`transaction_id` = the payment's `tx_ref`, UGX, the plan or top-up as the item). No ids, no report. It needs the **`GA4_API_SECRET`** Secret, and a failure or a slow Google never touches the payment (3 s limit, logged without the secret).

| Event | When | Parameters |
|---|---|---|
| `page_view` | every page (automatic) | the scrubbed address |
| `sign_up` · `login` | Google or email sign-in; `sign_up` the first time the account is verified | `method` |
| `profile_complete` | welcome step 1 and step 2 | `step`, `briefed_griot`, `focus_count` |
| `paywall_view` | the plan wall or the top-up wall appears | `wall`, `item_name` or `allowance_used` |
| `begin_checkout` | just before Flutterwave opens | `currency`, `value`, `items` |
| `purchase` | a plan or top-up settles (sent by the Worker) | `transaction_id`, `currency`, `value`, `items` |
| `griot_question` | GRIOT answered | `mode`, `lens_count`, `project_type`, `paid_with` |
| `griot_project_create` · `griot_document_add` | a client made a project; GRIOT read a document | `from` (documents) |
| `rehearsal_complete` | a rehearsal was scored | `moment`, `coaching`, `paid_with` |
| `studio_pack` | a Studio pack was generated, or a website audit started | `product`, `paid_with` |
| `clarity_audit` | the free Clarity Audit ran | — |
| `generate_lead` | the contact or masterclass form opened the email | `form`, `service` |
| `contact_click` | a WhatsApp, phone or email link | `channel`, `link_location` |
| `discuss_click` · `venture_click` | a "Discuss …" button; Tonninyira or CuePointe | `service` or `venture`, `link_location` |
| `select_content` | a link into a Studio pack, GRIOT, the Rehearsal Room, the Clarity Audit or Plans | `content_type`, `content_id` |

**Yours, in Google Analytics (Admin), once:**

1. **Measurement Protocol API secret:** Data streams → SpeakPower → Measurement Protocol API secrets → Create. Copy it straight into Cloudflare → `speakpower` → Settings → Variables and Secrets → type **Secret**, name `GA4_API_SECRET` → Deploy. Never into a chat, a file or a screenshot. Until it is set, everything works except the server-side `purchase`.
2. **Key events:** Events → mark `sign_up`, `purchase` and `generate_lead` as key events (they appear once each has happened once).
3. **Currency:** Property details → currency **Ugandan Shilling (UGX)**.
4. **Data retention:** Data collection and modification → Data retention → **14 months**.
5. **Google signals:** leave **off** (Data collection). The tag also refuses them.
6. **Custom dimensions** (Custom definitions → Create, event-scoped), so the parameters show in reports: `product`, `mode`, `moment`, `service`, `channel`, `wall`, `paid_with`, `form`, `venture`, `project_type`, `link_location`.
7. **Search Console:** Product links → Search Console links → link the site's property, so search queries sit beside behaviour.
8. **Check it works:** Admin → DebugView, or Reports → Realtime, while you accept the banner and click around.

**Database:** `payments` gained `ga_client_id` and `ga_session_id` (14 Oct 2026). Until both exist, checkout still works: the Worker records the payment without the ids, and simply reports no purchase. On an older database run, once:

```sql
ALTER TABLE payments ADD COLUMN ga_client_id TEXT;
ALTER TABLE payments ADD COLUMN ga_session_id TEXT;
```

**Law:** Uganda's Data Protection and Privacy Act 2019 asks for consent before personal data is collected; the banner asks first, explains in plain words and makes declining as easy as accepting.

## Testing

```
cd worker && npm install && cd .. && node --experimental-sqlite worker/test/run-tests.mjs
```

The business rules, fast, in plain Node (217 tests): the real `worker.js` against an in-memory D1, with Google, GRIOT, Flutterwave and audited sites faked at the network edge only. Google sign-in is tested with real RS256 signatures, so forged keys, `alg: none` and edited tokens are refused by actual cryptography rather than a stub. It also fails if any page quotes a different price from the Worker.

```
cd worker && npm install && npm install --no-save miniflare@4 wrangler@4 && node test/run-workerd-tests.mjs
```

The Worker bundled exactly as Workers Builds deploys it (`wrangler deploy --dry-run`), on **workerd**, the engine Cloudflare runs Workers on (23 tests): real D1, the real HTML parser for the SEO audit, WebCrypto sign-in, the exactly-once top-up under truly concurrent notifications, the sign-up profile briefing GRIOT, and a document read and kept as facts. It also audits this site's own pages.
