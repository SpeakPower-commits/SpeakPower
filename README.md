# SpeakPower

Marketing site for SpeakPower — communication strategy, audits, public speaking
coaching, narrative architecture, and the digital systems a strategy runs on.

Static HTML, CSS and vanilla JavaScript. No build step, no framework, no
package manager. Every file can be edited in the GitHub web editor and takes
effect on the next commit.

---

## Deploying

The site is served by **GitHub Pages** from this repository.

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.

Live at `https://speakpower-commits.github.io/SpeakPower-/` a minute or so after
each push to `main`.

`.nojekyll` is present, which tells Pages to serve the files as-is rather than
running them through Jekyll.

---

## One asset still needed

`assets/event-wide.jpg` is referenced by the homepage hero and the About page
but is **not in the repository**. Upload it to `assets/` with exactly that
filename.

Until it exists, the page does not break — `script.js` detects the failed load
and swaps in a branded placeholder panel carrying the image's alt text, so
visitors never see a broken-image icon. Replace it when you have the photo.

Recommended: roughly 1600 × 1200 px, JPEG, under 400 KB.

---

## File map

| File | Purpose |
|---|---|
| `index.html` | Homepage — hero, services, POLSSE framework, masterclass, closing |
| `services.html` | Six services in detail, plus delivery formats |
| `about.html` | Otieno Thomas, and the four commitments |
| `contact.html` | Contact channels and the enquiry form |
| `404.html` | Not-found page. Self-contained — styles are inlined on purpose |
| `styles.css` | Shared: tokens, reset, header, nav, buttons, forms, footer |
| `home.css` / `services.css` / `about.css` / `contact.css` | Per-page layout |
| `script.js` | Nav, POLSSE accordion, image fallback, forms, scroll reveal |
| `robots.txt`, `sitemap.xml` | Search engine crawling and indexing |
| `llms.txt` | Plain-language summary for AI answer engines |
| `site.webmanifest` | Icon and install metadata |
| `assets/favicon.svg` | Site icon |
| `assets/og-image.png` | 1200 × 630 social share card |
| `tools/og-image.html` | Source used to generate the share card |

Each page loads `styles.css` first, then its own stylesheet. Put anything shared
in `styles.css`; put anything that appears on one page only in that page's file.

---

## How the forms work

**There is no server behind this site.** Both forms — the contact form and the
masterclass signup — open the visitor's own email client with the message
pre-filled, addressed to `thomasotieno583@gmail.com`.

The status message shown after submitting says exactly that. It never claims a
submission was received, because nothing here can receive one. The contact form
also carries a permanent note explaining where the message goes.

**If you want real server-side capture** (a database, an autoresponder, a
mailing list), the options in rough order of effort:

1. A form service — Formspree, Basin, or similar. Change the `<form>` to post to
   their endpoint and delete the matching handler in `script.js`.
2. A Cloudflare Worker in front of a mail API or a Supabase table. More control,
   keeps the credential server-side where it belongs.

Do **not** put an API key or personal access token in `script.js` to do this.
Anything in that file is readable by anyone who opens developer tools.

---

## Changing the domain

Every absolute URL uses one origin: `https://speakpower-commits.github.io/SpeakPower-`

To move to a custom domain:

1. Search and replace that string across `index.html`, `services.html`,
   `about.html`, `contact.html`, `sitemap.xml`, `robots.txt` and `llms.txt`.
2. In `404.html`, change the two `/SpeakPower-/` link prefixes to `/`.
3. Add a file named `CNAME` at the repository root containing just the domain,
   e.g. `speakpower.co.ug`.
4. Point the domain's DNS at GitHub Pages, then set it under **Settings → Pages
   → Custom domain**.

---

## Regenerating the share card

`assets/og-image.png` is what appears when a link to the site is shared. To
update it after a copy change:

1. Edit `tools/og-image.html` — it is a standalone 1200 × 630 page.
2. Open it in a browser and screenshot it at exactly 1200 × 630.
3. Save over `assets/og-image.png`.

Keep the headline in that file matching the homepage `<h1>`.

---

## Design tokens

Colours, type scale and spacing are CSS custom properties at the top of
`styles.css`. Change them there and every page follows.

| Token | Value | Used for |
|---|---|---|
| `--ink` | `#17140f` | Text, dark bands, footer |
| `--paper` | `#fbf8f2` | Page background |
| `--clay` | `#b4531f` | Primary accent, buttons, links |
| `--gold` | `#d9a441` | Highlights on dark backgrounds |
| `--forest` | `#1e5c49` | Quiet secondary marks |

Type is **Fraunces** for headings and **Work Sans** for body, both from Google
Fonts. If you ever need the site to load without external requests, the fallback
stacks in `--font-display` and `--font-sans` already degrade cleanly.

---

## Accessibility and progressive enhancement

- Every page has a skip link, labelled landmarks, and visible focus rings.
- The mobile nav and POLSSE accordion expose `aria-expanded` and `aria-controls`.
- With JavaScript disabled, all POLSSE panels render open and all content is
  visible — nothing is hidden behind a script that never ran.
- `prefers-reduced-motion` disables the scroll reveal and all transitions.
- All text written to the page by `script.js` goes through `textContent`, never
  `innerHTML`, so user input can never be interpreted as markup.
