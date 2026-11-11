# SpeakPower: how work on this site is held to standard

AI makes it easy to build pages, write copy and make visuals. The risk is a site that looks as if AI made all of it: generic copy, predictable layouts, visuals with nothing of their own. A first-time visitor reads that as less credible, and SpeakPower sells credibility. Everything below exists to stop that. It applies to every page, product screen, email, report and download.

## The swap test

Before any headline, button, paragraph or meta description ships: put a competitor's name in place of SpeakPower's. If the sentence still works, rewrite it. Every claim carries a number, a name, a place or an example, or it goes.

## Copy

- **Write for a named reader:** founders, NGO directors, comms leads and boards in Kampala and East Africa. Use their world: UGX, MTN MoMo and Airtel Money, donors, boards, Ugandan mobile data.
- **Say what happens, not how it should feel.** "Speak for three minutes, get a score out of 100", not "Unlock your speaking potential".
- **Plain verbs, short sentences, one idea each.** Otieno speaks in the first person where the work is his; product screens say plainly what they do.
- **Banned, and checked automatically** (`worker/test/run-tests.mjs`, "craft" tests): the AI-tell list there, and the jargon list SpeakPower's own Clarity Audit flags on clients (`JARGON` in `audit.js`). Our pages pass our own audit.
  - The one exception is quoting someone else's words, such as CuePointe's tagline. Add it to the test's allowlist, with the reason.
- **Avoid these patterns even when the words pass:**
  - "Whether you're X or Y…"
  - "It's not just X, it's Y"
  - adjectives in threes
  - a rhetorical question as an opener
  - a dash in every sentence
  - exclamation marks
- **No invented proof.** Numbers, clients, testimonials and logos appear only when documented and attributable (README, Principles).
- **No placeholder text ever ships.**

## Layout

- **Lead with the real thing:** the product's own output (a real score, report, transcript or pack) rather than an abstract illustration.
- **Above the fold, a first-time visitor learns four things:** who it is for, what they get, what it costs (or that the first 3 tries are free), and the one thing to do next.
- **Vary the shapes.** Sections earn their shape: band, split, list, table, photograph. No page is a stack of identical icon-card grids. One primary action per screen.
- **Midnight & Gold only.**
  - Use the tokens in `styles.css`, set in Fraunces and Work Sans. No new font families.
  - Barkcloth brown at most once per screen. Signal colours only inside scores.

## Visuals

- **Real photographs** of Otieno, his work and his clients, with consent. No stock photos, and no AI-generated people or scenes. The craft tests refuse stock and AI image hosts.
- **Illustration** comes only from the brand system: GRIOT's marks, the bogolan band, and the Lucide line icons already in `styles.css`.
- **Every image has a reason**, and alt text that says what is in it.

## Before anything ships

1. **Tests:** `node --experimental-sqlite worker/test/run-tests.mjs` passes, craft tests included, and so does the workerd suite.
2. **Look at it.** Take screenshots at 390 px and 1280 px and actually look at them. Ask: would this look the same on any AI-built site? If yes, change it.
3. **Check the basics:**
   - AA contrast on every text pair;
   - no sideways scroll at 390 px;
   - light enough for Ugandan mobile data: no heavy hero image, and images lazy-loaded.

## Working rules for this repository

- **Branches.** `claude/studio-griot-live` deploys the site (GitHub Pages) and the Worker (Workers Builds) on every push.
  - New work goes on its own branch, as a draft PR into it.
  - Never push to `main`, and never force-push.
- **Secrets** never go in chat, the repository or screenshots. They live only in Cloudflare → `speakpower` → Settings → Variables and Secrets, as type Secret.
- **Text and data:**
  - Every piece of dynamic text is set with `textContent`, never `innerHTML`.
  - GRIOT's tenant id is set server-side only. `/griot/projects` stays a 404.
- **Database and deletion:**
  - D1 changes are additive and written into `worker/schema.sql`. The live database changes only with the owner's approval.
  - Nothing is deleted without the owner's word.
