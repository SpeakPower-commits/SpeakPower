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

## Assets still needed

Upload each to `assets/` with exactly these filenames. Nothing here breaks the
page if it is missing — every slot degrades to a labelled placeholder — but each
one that lands makes the site more convincing.

| File | Used by | Notes |
|---|---|---|
| `assets/logo.png` | Header on every page | The SpeakPower logo. **A transparent PNG is strongly preferred** — see below |
| `assets/otieno-thomas.jpg` | Homepage hero, About page | Your portrait. Roughly 1080 × 1350, under 400 KB |
| `assets/favicon.png` | Browser tab icon, all pages | The logo, square, 512 × 512. See the note below |
| `assets/client-1.png` | Homepage client wall | First client logo. Transparent PNG, ~400px wide |
| `assets/speaking-1.jpg` | Work page gallery | You mid-delivery, **audience in frame**. 1600 × 1000, under 400 KB |
| `assets/workshop-1.jpg` | Work page gallery | A workshop or audit session in progress |
| `assets/clip-1.mp4`, `clip-2.mp4` | Work page gallery | MP4 / H.264, 45–90 seconds, under 8 MB each |
| `assets/clip-1.jpg`, `clip-2.jpg` | Video poster frames | The still shown before play. Same 16:10 crop |
| `assets/cuepointe-1.png` … `-3.png` | Work page slider | Product screenshots, roughly 1600 × 1000 |
| `assets/tonninyira-1.png` … `-3.png` | Work page slider | Product screenshots, roughly 1600 × 1000 |

Already in the repository, so nothing to do:

| File | Used by |
|---|---|
| `assets/tonninyira-logo.webp` | Homepage ventures band, Work page case head |
| `assets/cuepointe-logo.webp` | Homepage ventures band, Work page case head |
| `assets/og-image.png` | Social share card |

Both venture logos were exported at 320 × 320 from the Canva originals. WebP
because it is roughly a third of the size of the equivalent PNG at this
quality, and every browser released since 2020 reads it.

### Adding a second client, photo, video or testimonial

Each of these grids is `auto-fill` or `auto-fit` and nothing counts the tiles,
so adding another is a copy-paste — no CSS change, no layout maths.

- **A client** — in `index.html`, find `<div class="client-wall">`. Replace the
  `<div class="client slot">` with the real markup shown in the comment directly
  above it, and paste another `.client` block for each additional logo.
- **A photo or video** — in `work.html`, find `<div class="gallery">`. Each
  `<figure class="media-tile">` carries a comment showing exactly what to swap
  the placeholder for. Keep `preload="none"` on every `<video>`: without it,
  every visitor downloads the clip whether they press play or not.
- **A testimonial** — in `work.html`, find `<div class="quotes">`. The first
  card is a **template**, not a quote. Replace the bracketed text with a real
  sentence from a real person, then delete the `quote--template` class and the
  `<span class="quote-flag">`. Never publish it as it stands, and never invent
  the words — a fabricated testimonial is the one reputational mistake on a
  consultancy site that cannot be undone.

### The venture links

Both venture buttons currently point at a **GitHub repository**, which is source
code rather than a running product. A founder or NGO director who clicks through
lands on a file tree. When you have the public web address for each, replace the
`href` values in `index.html` and `work.html` and change the label from
"View the build" to "Visit".

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
| `audit.html` / `audit.css` / `audit.js` | Message Clarity Audit — the free diagnostic tool |
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

## The Message Clarity Audit

`audit.html` is a working diagnostic, not a lead-capture form dressed up as one.
It scores an uploaded or pasted text on six published measures, shows the
formulas, and routes each finding to the service that repairs it.

**It runs entirely in the browser.** No server, no upload, no storage — which is
why it can live on static hosting, and why the page can honestly promise that
nothing a visitor submits ever leaves their machine. Do not "improve" this by
posting the text anywhere; the privacy claim on the page is load-bearing.

### File intake

`.txt` and `.md` are read with `Blob.text()`. `.docx` is a ZIP archive, so
`audit.js` walks its central directory to `word/document.xml` and inflates it
with `DecompressionStream("deflate-raw")` — no library, and nothing leaves the
machine. `.pdf` uses pdf.js, fetched from cdnjs **only when someone actually
drops a PDF**; the file itself is still parsed locally.

A scanned PDF has no text layer. That case is detected and reported as an error
rather than scored, because a confident number computed from an empty string is
worse than no number.

### Routing

Each finding carries the measure it came from, and each measure maps to a
service in the `ROUTES` table in `audit.js`. Rows are ordered by points lost
from the composite:

    cost(k) = weight(k) × (1 − part(k)) × 100

so the top row is the one worth fixing first, derived from the same rubric as
the score rather than asserted. Two findings can share a measure — long
sentences and a flat rhythm are both `rhythm` — and they share one cost, so the
figure is printed once. The links point at `services.html#svc-*`; **if you
rename those anchors, update `ROUTES` to match** or the buttons go nowhere.

The scoring rubric lives in one place, `WEIGHTS` at the top of the scoring
section in `audit.js`, and is mirrored in the weights table on the page. **Change
one and change the other**, or the site is publishing a method it does not use.

Chart colours are validated, not chosen by eye. The palette
`#3d6bb3, #2a8f63, #c9911a, #c94a2e` passes all six checks on a light surface.
The amber returns a contrast warning at 2.71:1, which is why every bar carries a
visible number and a status word, and why the data table exists. If you change a
colour, re-run the validator rather than trusting your eye.

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
