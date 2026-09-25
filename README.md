# SpeakPower

SpeakPower is the marketing site for a Kampala-based strategic communication and brand intelligence practice founded by Otieno Thomas.

The site positions SpeakPower around five connected capabilities:

1. Communication Strategy
2. Public Speaking & Leadership Communication
3. Brand Intelligence & Narrative
4. AI Communication Systems
5. Digital Systems & Applications

The core idea is simple: diagnose what is not landing, rebuild the message around evidence and context, then stay close to delivery and digital execution when the strategy needs a system to run on.

## Technical approach

- Static HTML, CSS and vanilla JavaScript
- No build step
- No framework dependency
- Hosted through GitHub Pages
- Progressive enhancement and accessible interaction patterns
- Shared visual tokens in `styles.css`
- Commercial positioning/conversion layer in `commercial.css`

This is intentionally lightweight. A marketing site does not need a heavy application framework unless the business requirements justify it.

## Pages

| Page | Purpose |
|---|---|
| `index.html` | Positioning, audience, five capabilities, POLSSE, selected work and primary CTA |
| `services.html` | Detailed commercial service architecture and POLSSE framework |
| `work.html` | Evidence-led case studies for Tonninyira and CuePointe |
| `about.html` | Founder story, principles and company direction |
| `contact.html` | Lead qualification and contact options |
| `404.html` | Not-found page |

## Lead handling

The contact form currently prepares an email addressed to `thomasotieno583@gmail.com`. It does not claim that a lead has been stored because there is no server-side form endpoint in the repository.

For production lead capture, connect the form to a server-side service such as:

- Formspree or Basin for the quickest deployment
- A Cloudflare Worker + mail/API service for more control
- Supabase for stored leads, CRM-style fields and future automation

Do not put API keys, SMTP passwords or personal access tokens in `script.js` or any browser-served asset.

The form already captures:

- Name
- Organization
- Email
- Area of help
- Context/problem description

## Content and proof policy

The Work page deliberately avoids invented client metrics. As verified outcomes become available, expand each case study using:

**Problem → Strategy → Build → Outcome**

Publish numbers only when they are documented and attributable.

## SEO / AI discovery

The site includes:

- Page titles and meta descriptions
- Canonical URLs
- Open Graph and X/Twitter metadata
- `robots.txt`
- `sitemap.xml`
- `llms.txt`
- Structured data on key pages

The current canonical host remains the GitHub Pages URL until a custom SpeakPower domain is connected.

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

The site expects these assets in `assets/`:

- `logo.png`
- `favicon.png`
- `otieno-thomas.jpg`
- `og-image.png`

Keep image filenames lowercase and predictable because GitHub Pages URLs are case-sensitive.

## Deployment

GitHub Pages can serve the `main` branch from the repository root.

The current production branch is expected to remain stable. Feature work should happen on a branch and move to `main` through review.

For this commercial upgrade, the working branch is:

`professional-commercial-upgrade`

## Next commercial phase

The next major upgrade should be real server-side lead capture and a lightweight analytics/CRM flow:

**Visit → Diagnose → Enquire → Capture → Qualify → Discovery call → Proposal**

That turns SpeakPower from a brochure into a business acquisition system without requiring a frontend rewrite.
