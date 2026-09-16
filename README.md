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

## Two assets still needed

Neither is in the repository yet. Upload both to `assets/` with exactly these
filenames:

| File | Used by | Notes |
|---|---|---|
| `assets/logo.png` | Header on every page | The SpeakPower logo. **A transparent PNG is strongly preferred** — see below |
| `assets/otieno-thomas.jpg` | Homepage hero, About page | Your portrait. Square-ish crop, roughly 1080 × 1080 or larger, under 400 KB |
| `assets/favicon.png` | Browser tab icon, all pages | The logo, square, 512 × 512. See the note below |
| `assets/cuepointe-1.png` … `-3.png` | Work page slider | Product screenshots, roughly 1600 × 1000 |
| `assets/tonninyira-1.png` … `-3.png` | Work page slider | Product screenshots, roughly 1600 × 1000 |

All images live in `assets/` — one flat folder, no sub-folders. Filenames are
lowercase with hyphens and no spaces, because GitHub Pages is case-sensitive
and a space becomes `%20` in the URL.

Neither absence breaks the page. `script.js` watches for a failed load and
degrades gracefully: the logo falls back to a styled text wordmark, and the
portrait falls back to a branded panel carrying the image's alt text. Nobody
ever sees a broken-image icon.

### About the favicon

`assets/favicon.png` is the logo, used as the browser tab icon. Export it
**square at 512 × 512**.

Crop it to the **mark only** — the speech bubble and its rays — and leave out
the "SPEAKPOWER" wordmark and the "Articulate is key" tagline. A favicon is
rendered at 16–32 pixels in a browser tab; at that size the wordmark is a grey
smudge and the tagline is invisible, so keeping them only shrinks the part that
is actually recognisable. The mark alone still reads as your logo.

If you would rather use the full lockup as-is, it will work — just rename it to
`favicon.png`. It will simply be harder to recognise in a crowded tab bar.

### About the logo background

The logo as supplied sits on a light-grey backdrop rather than true
transparency. The header applies `mix-blend-mode: multiply`, which drops that
grey against the light page while leaving the navy and gold intact. It works,
but it is a workaround: on any non-white background the grey will show.

Export the logo as a **transparent PNG** when you can. The blend mode then
becomes a harmless no-op and nothing else needs changing.

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
| `work.html` / `work.css` | CuePointe and Tonninyira case studies |
| `robots.txt`, `sitemap.xml` | Search engine crawling and indexing |
| `llms.txt` | Plain-language summary for AI answer engines |
| `site.webmanifest` | Icon and install metadata |
| `assets/favicon.png` | Site icon — the logo. **You still need to upload this** |
| `assets/og-image.png` | 1200 × 630 social share card |
| `assets/logo.png` | Header logo — **you still need to upload this** |
| `assets/otieno-thomas.jpg` | Portrait — **you still need to upload this** |
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

Both come from the logo: deep navy carries structure and calls to action, gold
is an accent only.

| Token | Value | Used for |
|---|---|---|
| `--navy` | `#16233f` | Buttons, dark bands, footer, primary brand |
| `--navy-deep` | `#0d1729` | Hover and pressed states |
| `--gold` | `#c9a227` | Rules, dots, decorative accents |
| `--gold-bright` | `#e0be4f` | Gold on dark backgrounds |
| `--gold-text` | `#8a6d14` | Gold as *text* on light — 5.2:1, passes AA |
| `--ink` | `#131c2e` | Body text |
| `--paper` | `#f7f7f5` | Page background |
| `--paper-2` | `#eef0f3` | Sunken sections, echoes the logo backdrop |

Gold is never used for text on a light background at full strength — `#c9a227`
on `#f7f7f5` is about 2.5:1 and would fail contrast. That is what `--gold-text`
exists for. Similarly, buttons are navy with white text, never gold with white.

Type is **Fraunces** for headings and **Work Sans** for body, both from Google
Fonts. If you ever need the site to load without external requests, the fallback
stacks in `--font-display` and `--font-sans` already degrade cleanly.

---

## The slider

`styles.css` and `script.js` carry a reusable slider. To add one anywhere:

```html
<div class="slider" data-slider aria-label="What this shows">
  <div class="slider-track">
    <figure class="slide">
      <img src="assets/example-1.png" alt="Describe the image">
      <figcaption>Optional caption</figcaption>
    </figure>
    <!-- more .slide figures -->
  </div>
</div>
```

The arrows and dots are generated by `script.js`, not written in the markup —
controls that do nothing when scripting fails are worse than no controls. The
track is a native CSS scroll-snap container, so it stays swipeable on touch and
scrollable by keyboard even with JavaScript off.

**There is no autoplay, on purpose.** A slide that advances by itself steals
the reading position, and it is the single biggest reason carousels test badly.
Don't add one.

## Accessibility and progressive enhancement

- Every page has a skip link, labelled landmarks, and visible focus rings.
- The mobile nav and POLSSE accordion expose `aria-expanded` and `aria-controls`.
- With JavaScript disabled, all POLSSE panels render open and all content is
  visible — nothing is hidden behind a script that never ran.
- `prefers-reduced-motion` disables the scroll reveal and all transitions.
- All text written to the page by `script.js` goes through `textContent`, never
  `innerHTML`, so user input can never be interpreted as markup.
