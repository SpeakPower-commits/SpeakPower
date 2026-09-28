# SpeakPower

SpeakPower is the marketing site and self-service product platform for a Kampala-based brand storytelling and market development practice founded by Otieno Thomas.

The site positions SpeakPower around six connected capabilities:

1. Brand Storytelling & Positioning
2. Market Development & SEO
3. Strategic Writing & Content
4. Visual Communication & Design
5. Data, Analytics & Digital Systems
6. Public Speaking & Thought Leadership

The core idea: tell a better story, find the market, and make the strategy move. SpeakPower diagnoses what is not landing, rebuilds the message around evidence and context, and stays close to delivery and digital execution when the strategy needs a system to run on.

## Technical approach

- The front end is static HTML, CSS and vanilla JavaScript, served by GitHub Pages. There is no build step and no framework.
- The back end is Cloudflare only:
  - a Worker for the API;
  - D1 for data;
  - Email Service for sign-in codes and lead alerts;
  - Turnstile for bot protection;
  - Web Analytics for page views.

  See [`worker/README.md`](worker/README.md).
- Progressive enhancement and accessible interaction patterns throughout.
- Shared visual tokens live in `styles.css`; the commercial and Studio layer lives in `commercial.css`.
- `site-config.js` holds the only deploy-time settings: the Worker URL, the Turnstile site key and the Web Analytics token. All are public values.

## Pages

| Page | Purpose |
|---|---|
| `index.html` | Positioning, ventures, audience, six capabilities, POLSSE, Studio and primary CTA |
| `services.html` | Detailed service architecture and the POLSSE framework |
| `audit.html` | Free Pitch & Document Clarity Audit (runs in the browser) |
| `studio.html` | Studio catalogue: six self-service products, 3 free runs on sign-up |
| `studio-product.html` | Studio builder: brief, sign-up, generation, download (`noindex`) |
| `work.html` | Case studies for Tonninyira and CuePointe (both live) |
| `about.html` | Founder story, principles and company direction |
| `contact.html` | Lead capture |
| `404.html` | Not-found page |

## Studio: 3 free runs, then paid

- New accounts sign up with an emailed 6-digit code, protected by Turnstile, and get **3 free runs** usable on any product.
- Generation runs inside the Cloudflare Worker. The Worker enforces the allowance, so it cannot be bypassed from the browser.
- When the runs are used up, the builder shows an upgrade panel. Payment is handed off to Flutterwave through `CHECKOUT_URL` or the `sp:trials-exhausted` window event. Paid runs are stored as `credits` in D1.
- Until `apiBase` is set in `site-config.js`, Studio shows a "launching shortly" notice instead of generating.

## Lead handling

The contact form posts to the Worker (`POST /lead`). The Worker:
- stores the enquiry in D1;
- emails a notification to `LEAD_NOTIFY_TO`;
- protects the form with a honeypot field and per-IP rate limiting.

If the Worker is not configured or cannot be reached, the form falls back to opening the visitor's email client.

Never put API keys, SMTP passwords or tokens in `script.js`, `site-config.js` or any other browser-served file. Secrets live only in the Worker's encrypted settings.

## Measurement

- **Cloudflare Web Analytics** provides cookieless page views when `webAnalyticsToken` is set.
- **First-party funnel events** are stored in D1:
  - audit run → Studio view → sign-up started → verified → generate → download → trials exhausted → checkout click → contact.
  - Sign-up, generate and trials-exhausted events are recorded server-side.
  - No names, emails or content are stored with events.
  - Starter SQL is in `worker/README.md`.

## Content and proof policy

The Work page deliberately avoids invented client metrics. As verified outcomes become available, expand each case study using:

**Problem → Strategy → Build → Outcome**

Publish numbers only when they are documented and attributable.

## SEO / AI discovery

- Page titles, meta descriptions, canonical URLs, Open Graph and X/Twitter metadata
- `robots.txt`, `sitemap.xml` and `llms.txt`
- Structured data on key pages

The canonical host is `https://speakpower-commits.github.io/SpeakPower/`, matching this repository's name. If a custom domain is connected, update:
- the canonicals;
- `sitemap.xml`, `robots.txt` and `llms.txt`;
- the absolute paths in `404.html`;
- `ALLOWED_ORIGINS` in the Worker.

## Brand system

Primary tokens live in `styles.css`.

- Navy: `#16233f`
- Deep navy: `#0d1729`
- Gold: `#c9a227`
- Paper: `#f7f7f5`

Typography:

- Fraunces for display headings
- Work Sans for body copy

## Assets

Keep image filenames lowercase and predictable because GitHub Pages URLs are case-sensitive.

## Deployment

- **Front end:** GitHub Pages serves the `main` branch from the repository root. Feature work happens on a branch and reaches `main` through review.
- **Back end:** deploy the Worker and create the D1 database, following [`worker/README.md`](worker/README.md). Then set `apiBase` in `site-config.js`.

## Free diagnostic engine

`audit.html` + `audit.js` provide the **Pitch & Document Clarity Audit**. Visitors can paste text or locally open PDF, DOCX, TXT or Markdown files.
- Analysis happens in the browser; documents are not uploaded or stored. Only an anonymous "audit run" count is recorded.
- The engine measures readability, sentence rhythm, passive voice, hedging, category jargon and evidence density.
- Findings route to the relevant Studio product through a shared `ROUTES` map.
