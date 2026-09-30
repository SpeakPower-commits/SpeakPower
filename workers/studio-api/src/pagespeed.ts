/**
 * Website SEO & Visibility Audit — server side.
 *
 * Two independent layers, deliberately:
 *
 *   1. Google Lighthouse scores, via the PageSpeed Insights API. Needs
 *      PAGESPEED_API_KEY. A keyless call lands in Google's shared anonymous
 *      quota pool (project_number 583797351490), which is permanently
 *      exhausted and returns HTTP 429 — that is why the browser-side version
 *      of this product never once worked.
 *
 *   2. SpeakPower's own technical checks, run by fetching the page here and
 *      parsing it with HTMLRewriter. These need no credential and no quota,
 *      so the product still returns a real deliverable when layer 1 is
 *      unavailable. They also cover things Lighthouse does not report the
 *      way a client needs to see them — JSON-LD validity, social-preview
 *      readiness, canonical self-reference.
 *
 * Only a total failure of BOTH layers is an error. Anything else is a result.
 */

interface PagespeedEnv {
  DB: D1Database;
  PAGESPEED_API_KEY?: string;
}

export type Section = [string, string];

/** Results live in D1 for a day. A repeat audit of the same site costs no quota. */
const CACHE_TTL_SECONDS = 24 * 60 * 60;

/** A page larger than this is not worth the Worker's memory to inspect. */
const MAX_HTML_BYTES = 512 * 1024;

const LIGHTHOUSE_TIMEOUT_MS = 55_000;
const HTML_TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------------ *
 * Target validation
 * ------------------------------------------------------------------ */

/**
 * Hostnames the Worker must never be talked into fetching. The edge cannot
 * route to RFC1918 anyway, but this stops the endpoint being used as an open
 * relay or a probe for cloud metadata services, and it rejects the mistake
 * early with a clear message instead of a timeout.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\./i,
  /^169\.254\./,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i
];

export function normaliseTarget(raw: unknown): { url: string; host: string } {
  let text = String(raw || "").trim();
  if (!text) throw new Error("Enter the website address you want audited.");

  // People paste "example.com". Assume https rather than rejecting them.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("That does not look like a valid website address.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https addresses can be audited.");
  }

  const host = parsed.hostname;
  if (!host || host.indexOf(".") === -1) {
    throw new Error("Enter a full public address, for example https://example.com.");
  }
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error("Only public websites can be audited.");
  }

  // Strip the fragment: it never changes what the server returns, and keeping
  // it would fragment the cache.
  parsed.hash = "";
  return { url: parsed.toString(), host };
}

/* ------------------------------------------------------------------ *
 * Layer 1 — Google Lighthouse
 * ------------------------------------------------------------------ */

interface LighthouseResult {
  ok: boolean;
  /** Present when ok === false: why, in words a customer can read. */
  reason?: string;
  scores: Array<[string, number]>;
  failures: Array<{ title: string; display: string; score: number }>;
}

const LIGHTHOUSE_CATEGORIES = ["seo", "performance", "accessibility", "best-practices"];

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export async function fetchLighthouse(env: PagespeedEnv, target: string): Promise<LighthouseResult> {
  const empty: LighthouseResult = { ok: false, scores: [], failures: [] };

  if (!env.PAGESPEED_API_KEY) {
    return {
      ...empty,
      reason:
        "Google Lighthouse scores are not configured on this deployment, so only the SpeakPower technical checks are included below."
    };
  }

  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", target);
  endpoint.searchParams.set("strategy", "mobile");
  endpoint.searchParams.set("key", env.PAGESPEED_API_KEY);
  for (const category of LIGHTHOUSE_CATEGORIES) {
    endpoint.searchParams.append("category", category);
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIGHTHOUSE_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.toString(), { signal: abort.signal });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as any;
      const message: string = detail?.error?.message || "";
      const reasons: string[] = [
        ...(detail?.error?.details || []).map((d: any) => String(d?.reason || "")),
        ...(detail?.error?.errors || []).map((e: any) => String(e?.reason || ""))
      ].filter(Boolean);

      const CONFIG_REASONS = ["API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED", "SERVICE_DISABLED", "forbidden"];
      const isConfigFault =
        response.status === 401 ||
        response.status === 403 ||
        reasons.some((r) => CONFIG_REASONS.indexOf(r) !== -1) ||
        /api key/i.test(message);

      // A broken key or a disabled API is our fault, not the customer's.
      // Saying "your page could not be scored" here would be a lie that sends
      // them looking for a problem on their own site.
      if (isConfigFault) {
        console.error("PageSpeed configuration fault:", response.status, message, reasons.join(","));
        return {
          ...empty,
          reason:
            "Lighthouse scoring is temporarily unavailable on our side, so the scores are not included in this report. The SpeakPower technical checks below ran normally and are complete."
        };
      }

      if (response.status === 429) {
        return {
          ...empty,
          reason:
            "Google's Lighthouse quota is exhausted for today, so the scores are not included. The SpeakPower technical checks below ran normally."
        };
      }

      if (response.status === 400 || response.status === 422 || response.status === 500) {
        return {
          ...empty,
          reason:
            "Google could not load that page to score it. It may be blocking automated requests, or be too slow to finish. The SpeakPower technical checks below ran normally."
        };
      }

      console.error("PageSpeed unexpected response:", response.status, message);
      return {
        ...empty,
        reason:
          "Google Lighthouse did not return scores for this page. The SpeakPower technical checks below ran normally."
      };
    }

    const data = (await response.json()) as any;
    const lighthouse = data?.lighthouseResult || {};
    const categories = lighthouse.categories || {};
    const audits = lighthouse.audits || {};

    const scores: Array<[string, number]> = [];
    for (const key of LIGHTHOUSE_CATEGORIES) {
      const entry = categories[key];
      if (entry && typeof entry.score === "number") {
        scores.push([titleCase(key.replace(/-/g, " ")), Math.round(entry.score * 100)]);
      }
    }

    const failures = Object.keys(audits)
      .map((id) => audits[id])
      .filter(
        (audit) =>
          audit &&
          audit.title &&
          typeof audit.score === "number" &&
          audit.score < 1 &&
          audit.scoreDisplayMode !== "informative" &&
          audit.scoreDisplayMode !== "notApplicable" &&
          audit.scoreDisplayMode !== "manual"
      )
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((audit) => ({
        title: String(audit.title),
        display: String(audit.displayValue || ""),
        score: Number(audit.score)
      }));

    return { ok: scores.length > 0, scores, failures };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ...empty,
      reason: aborted
        ? "Google Lighthouse took too long on this page and was stopped. The SpeakPower technical checks below ran normally."
        : "Google Lighthouse could not be reached. The SpeakPower technical checks below ran normally."
    };
  }
}

/* ------------------------------------------------------------------ *
 * Layer 2 — SpeakPower's own checks
 * ------------------------------------------------------------------ */

interface PageFacts {
  finalUrl: string;
  status: number;
  https: boolean;
  redirected: boolean;
  bytes: number;
  elapsedMs: number;
  lang: string;
  title: string;
  metaDescription: string;
  robots: string;
  canonical: string;
  viewport: string;
  headings: Record<string, number>;
  firstHeadingOrder: string[];
  og: Record<string, string>;
  twitterCard: string;
  jsonLdBlocks: string[];
  images: number;
  imagesWithAlt: number;
  linksInternal: number;
  linksExternal: number;
  hasFavicon: boolean;
  proseWords: number;
}

/** Selectors that hold visible prose and rarely nest inside each other. */
const PROSE_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, td, th, figcaption, blockquote";

export async function inspectPage(target: string): Promise<PageFacts> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HTML_TIMEOUT_MS);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(target, {
      signal: abort.signal,
      redirect: "follow",
      headers: {
        // Identify honestly. Some hosts block unknown agents outright, and a
        // customer deserves to know that is what happened.
        "User-Agent": "SpeakPowerStudioAudit/1.0 (+https://speakpower-commits.github.io/SpeakPower-/studio.html)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new Error(
      aborted
        ? "That page did not respond within 12 seconds, so it could not be inspected."
        : "That page could not be reached. Check the address and that the site is public."
    );
  }
  clearTimeout(timer);

  const facts: PageFacts = {
    finalUrl: response.url || target,
    status: response.status,
    https: (response.url || target).startsWith("https://"),
    redirected: (response.url || target) !== target,
    bytes: 0,
    elapsedMs: Date.now() - startedAt,
    lang: "",
    title: "",
    metaDescription: "",
    robots: "",
    canonical: "",
    viewport: "",
    headings: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    firstHeadingOrder: [],
    og: {},
    twitterCard: "",
    jsonLdBlocks: [],
    images: 0,
    imagesWithAlt: 0,
    linksInternal: 0,
    linksExternal: 0,
    hasFavicon: false,
    proseWords: 0
  };

  const contentType = response.headers.get("content-type") || "";
  if (response.status >= 400) {
    throw new Error(
      "That address returned HTTP " + response.status + ", so there is no page to audit."
    );
  }
  if (contentType && !/html|xml/i.test(contentType)) {
    throw new Error("That address does not return a web page (" + contentType.split(";")[0] + ").");
  }

  const targetHost = new URL(facts.finalUrl).hostname;
  let titleBuffer = "";
  let jsonLdBuffer = "";
  let proseBuffer = "";

  const rewriter = new HTMLRewriter()
    .on("html", {
      element(el) {
        facts.lang = el.getAttribute("lang") || "";
      }
    })
    .on("title", {
      text(chunk) {
        titleBuffer += chunk.text;
        if (chunk.lastInTextNode && !facts.title) facts.title = titleBuffer.trim();
      }
    })
    .on("meta", {
      element(el) {
        const name = (el.getAttribute("name") || "").toLowerCase();
        const property = (el.getAttribute("property") || "").toLowerCase();
        const content = el.getAttribute("content") || "";

        if (name === "description") facts.metaDescription = content.trim();
        else if (name === "robots") facts.robots = content.trim();
        else if (name === "viewport") facts.viewport = content.trim();
        else if (name === "twitter:card") facts.twitterCard = content.trim();
        else if (property.startsWith("og:")) facts.og[property] = content.trim();
      }
    })
    .on("link", {
      element(el) {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        if (rel.split(/\s+/).indexOf("canonical") !== -1) {
          facts.canonical = (el.getAttribute("href") || "").trim();
        }
        if (/icon/.test(rel)) facts.hasFavicon = true;
      }
    })
    .on("h1, h2, h3, h4, h5, h6", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        facts.headings[tag] = (facts.headings[tag] || 0) + 1;
        if (facts.firstHeadingOrder.length < 40) facts.firstHeadingOrder.push(tag);
      }
    })
    .on("img", {
      element(el) {
        facts.images += 1;
        const alt = el.getAttribute("alt");
        // A present-but-empty alt is a valid decorative marker, so it counts
        // as handled rather than missing.
        if (alt !== null) facts.imagesWithAlt += 1;
      }
    })
    .on("a", {
      element(el) {
        const href = (el.getAttribute("href") || "").trim();
        if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
        try {
          const resolved = new URL(href, facts.finalUrl);
          if (resolved.hostname === targetHost) facts.linksInternal += 1;
          else facts.linksExternal += 1;
        } catch {
          /* an unparseable href is its own small finding, but not worth a row */
        }
      }
    })
    .on('script[type="application/ld+json"]', {
      text(chunk) {
        jsonLdBuffer += chunk.text;
        if (chunk.lastInTextNode) {
          if (jsonLdBuffer.trim() && facts.jsonLdBlocks.length < 25) {
            facts.jsonLdBlocks.push(jsonLdBuffer.trim());
          }
          jsonLdBuffer = "";
        }
      }
    })
    .on(PROSE_SELECTOR, {
      text(chunk) {
        if (proseBuffer.length < 200_000) proseBuffer += chunk.text + " ";
      }
    });

  // Read with a hard byte cap so one enormous page cannot exhaust the Worker.
  const transformed = rewriter.transform(response);
  const reader = transformed.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      facts.bytes += value ? value.byteLength : 0;
      if (facts.bytes > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }

  facts.elapsedMs = Date.now() - startedAt;
  facts.proseWords = proseBuffer.trim() ? proseBuffer.trim().split(/\s+/).length : 0;
  return facts;
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

interface Finding {
  /** "pass" | "warn" | "fail" — drives the order findings are presented in. */
  level: "pass" | "warn" | "fail";
  label: string;
  detail: string;
}

const RANK: Record<Finding["level"], number> = { fail: 0, warn: 1, pass: 2 };

export function buildFindings(facts: PageFacts): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding["level"], label: string, detail: string) =>
    out.push({ level, label, detail });

  /* --- Indexability comes first: nothing else matters if the page is hidden --- */
  if (/noindex/i.test(facts.robots)) {
    add("fail", "Indexability", 'The page carries a "noindex" robots tag. Search engines are being told to leave it out of results entirely.');
  } else {
    add("pass", "Indexability", "No noindex tag. The page is open to search engines.");
  }

  if (!facts.https) {
    add("fail", "HTTPS", "The page is served over plain http. Browsers mark it as not secure and search engines prefer https.");
  } else {
    add("pass", "HTTPS", "Served over https.");
  }

  /* --- Title --- */
  const titleLength = facts.title.length;
  if (!titleLength) {
    add("fail", "Page title", "There is no <title>. This is the single strongest on-page signal and the headline of every search result.");
  } else if (titleLength < 25) {
    add("warn", "Page title", `Only ${titleLength} characters ("${facts.title}"). Around 50–60 uses the full width of a search result.`);
  } else if (titleLength > 65) {
    add("warn", "Page title", `${titleLength} characters, so Google will truncate it. Front-load what matters in the first 60.`);
  } else {
    add("pass", "Page title", `${titleLength} characters — within the range that displays in full.`);
  }

  /* --- Meta description --- */
  const descLength = facts.metaDescription.length;
  if (!descLength) {
    add("fail", "Meta description", "No meta description, so Google will invent a snippet from page text. You lose control of the sentence that decides the click.");
  } else if (descLength < 70) {
    add("warn", "Meta description", `Only ${descLength} characters. 120–160 gives you room to make the case.`);
  } else if (descLength > 170) {
    add("warn", "Meta description", `${descLength} characters — it will be cut off around 160.`);
  } else {
    add("pass", "Meta description", `${descLength} characters — a good working length.`);
  }

  /* --- Headings --- */
  if (facts.headings.h1 === 0) {
    add("fail", "Heading structure", "There is no H1. The page never states its own subject in the one place both readers and crawlers look first.");
  } else if (facts.headings.h1 > 1) {
    add("warn", "Heading structure", `${facts.headings.h1} H1 headings. One per page keeps the subject unambiguous.`);
  } else {
    add("pass", "Heading structure", "Exactly one H1.");
  }

  const skips: string[] = [];
  let previous = 0;
  for (const tag of facts.firstHeadingOrder) {
    const level = Number(tag.slice(1));
    if (previous && level > previous + 1) skips.push(`h${previous} → h${level}`);
    previous = level;
  }
  if (skips.length) {
    add("warn", "Heading order", `Levels are skipped (${skips.slice(0, 3).join(", ")}). Screen readers use this outline to navigate, so gaps make the page harder to move through.`);
  }

  /* --- Canonical --- */
  if (!facts.canonical) {
    add("warn", "Canonical tag", "No canonical link. If this page is reachable at more than one address, search engines have to guess which one to rank.");
  } else {
    let sameDocument = false;
    try {
      const canonical = new URL(facts.canonical, facts.finalUrl);
      const actual = new URL(facts.finalUrl);
      sameDocument = canonical.origin === actual.origin && canonical.pathname === actual.pathname;
    } catch {
      /* falls through to the mismatch branch */
    }
    if (sameDocument) {
      add("pass", "Canonical tag", "Present and pointing at this page.");
    } else {
      add("warn", "Canonical tag", `Points somewhere else (${facts.canonical}). That tells search engines to rank the other page instead of this one — correct if deliberate, damaging if not.`);
    }
  }

  /* --- Structured data, including validity --- */
  if (!facts.jsonLdBlocks.length) {
    add("warn", "Structured data", "No JSON-LD found. Structured data is how search engines and AI answer engines read what your business is, rather than guessing from prose.");
  } else {
    const broken: string[] = [];
    const types: string[] = [];
    facts.jsonLdBlocks.forEach((block, index) => {
      try {
        const parsed = JSON.parse(block);
        const collect = (node: any) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) return node.forEach(collect);
          if (typeof node["@type"] === "string") types.push(node["@type"]);
          Object.keys(node).forEach((k) => collect(node[k]));
        };
        collect(parsed);
      } catch (error) {
        broken.push(
          `block ${index + 1}: ${error instanceof Error ? error.message : "invalid JSON"}`
        );
      }
    });

    const unique = Array.from(new Set(types)).slice(0, 12);
    if (broken.length) {
      add("fail", "Structured data is invalid", `${broken.length} of ${facts.jsonLdBlocks.length} JSON-LD blocks will not parse (${broken.slice(0, 2).join("; ")}). An invalid block is discarded whole — every entity inside it is invisible, and the page looks like it has no structured data at all.`);
    } else {
      add("pass", "Structured data", `${facts.jsonLdBlocks.length} valid JSON-LD block${facts.jsonLdBlocks.length === 1 ? "" : "s"}${unique.length ? " declaring " + unique.join(", ") : ""}.`);
    }
  }

  /* --- Social preview: the WhatsApp and LinkedIn surface --- */
  const ogTitle = facts.og["og:title"];
  const ogDesc = facts.og["og:description"];
  const ogImage = facts.og["og:image"];
  const missingOg = [
    !ogTitle && "og:title",
    !ogDesc && "og:description",
    !ogImage && "og:image"
  ].filter(Boolean) as string[];

  if (missingOg.length === 3) {
    add("fail", "Social sharing preview", "No Open Graph tags at all. Shared on WhatsApp or LinkedIn this page renders as a bare link with no image, headline or description — which is most of why a shared link does or does not get opened.");
  } else if (missingOg.length) {
    add("warn", "Social sharing preview", `Missing ${missingOg.join(", ")}. Without og:image in particular, a shared link has no picture attached.`);
  } else {
    add("pass", "Social sharing preview", "og:title, og:description and og:image are all present.");
  }

  if (!facts.twitterCard && missingOg.length < 3) {
    add("warn", "Twitter/X card", "No twitter:card tag. Most platforms fall back to Open Graph, so this is a small gap rather than a broken preview.");
  }

  /* --- Images --- */
  if (facts.images > 0) {
    const missing = facts.images - facts.imagesWithAlt;
    if (missing > 0) {
      add(missing > facts.images / 2 ? "fail" : "warn", "Image alt text", `${missing} of ${facts.images} images have no alt attribute. Alt text is what a screen reader announces and what image search reads.`);
    } else {
      add("pass", "Image alt text", `All ${facts.images} images carry an alt attribute.`);
    }
  }

  /* --- Mobile --- */
  if (!facts.viewport) {
    add("fail", "Mobile readiness", "No viewport meta tag. Mobile browsers will render the page at desktop width and shrink it, which fails Google's mobile usability checks.");
  } else {
    add("pass", "Mobile readiness", "A viewport meta tag is set.");
  }

  /* --- Language --- */
  if (!facts.lang) {
    add("warn", "Page language", 'The <html> tag has no lang attribute. Screen readers use it to pick a pronunciation, and search engines use it to match the page to a language.');
  }

  /* --- Content depth --- */
  if (facts.proseWords < 150) {
    add("warn", "Content depth", `Roughly ${facts.proseWords} words of prose. Thin pages rarely rank for anything competitive — there is not enough text to establish what the page is about.`);
  } else {
    add("pass", "Content depth", `Roughly ${facts.proseWords} words of prose.`);
  }

  /* --- Linking --- */
  if (facts.linksInternal === 0) {
    add("warn", "Internal linking", "No internal links were found. Internal links are how ranking strength moves between your own pages.");
  } else {
    add("pass", "Internal linking", `${facts.linksInternal} internal link${facts.linksInternal === 1 ? "" : "s"} and ${facts.linksExternal} external.`);
  }

  if (!facts.hasFavicon) {
    add("warn", "Favicon", "No icon link was found. The browser tab and bookmark will show a blank placeholder.");
  }

  return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

const LEVEL_MARK: Record<Finding["level"], string> = {
  fail: "FIX",
  warn: "REVIEW",
  pass: "PASS"
};

export function buildSections(
  target: string,
  facts: PageFacts,
  lighthouse: LighthouseResult
): Section[] {
  const sections: Section[] = [];
  const findings = buildFindings(facts);
  const fails = findings.filter((f) => f.level === "fail");
  const warns = findings.filter((f) => f.level === "warn");
  const passes = findings.filter((f) => f.level === "pass");

  sections.push([
    "Audited page",
    [
      facts.finalUrl,
      facts.redirected ? "Redirected from " + target : null,
      "HTTP " + facts.status + " · " + Math.round(facts.bytes / 1024) + " KB of HTML · responded in " + facts.elapsedMs + " ms"
    ]
      .filter(Boolean)
      .join("\n")
  ]);

  sections.push([
    "Headline",
    `${fails.length} issue${fails.length === 1 ? "" : "s"} to fix, ${warns.length} to review, ${passes.length} check${passes.length === 1 ? "" : "s"} passing.`
  ]);

  if (lighthouse.ok) {
    sections.push([
      "Google Lighthouse scores (mobile)",
      lighthouse.scores.map(([label, score]) => `${label}: ${score} / 100`).join("\n")
    ]);
    if (lighthouse.failures.length) {
      sections.push([
        "Lighthouse findings",
        lighthouse.failures
          .map((f) => f.title + (f.display ? " — " + f.display : ""))
          .join("\n")
      ]);
    }
  } else if (lighthouse.reason) {
    sections.push(["Google Lighthouse scores", lighthouse.reason]);
  }

  if (fails.length) {
    sections.push([
      "Fix these first",
      fails.map((f) => `${f.label}: ${f.detail}`).join("\n\n")
    ]);
  }
  if (warns.length) {
    sections.push([
      "Worth reviewing",
      warns.map((f) => `${f.label}: ${f.detail}`).join("\n\n")
    ]);
  }
  if (passes.length) {
    sections.push([
      "Already correct",
      passes.map((f) => `${LEVEL_MARK[f.level]} — ${f.label}: ${f.detail}`).join("\n")
    ]);
  }

  sections.push([
    "What this audit does not cover",
    "Rankings, search traffic, backlinks and conversion performance need access to the site's own Search Console and analytics data. This report inspects what any visitor or crawler can see from the public page. It is the technical floor, not the whole picture."
  ]);

  return sections;
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

async function readCache(env: PagespeedEnv, target: string): Promise<Section[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT sections FROM studio_pagespeed_cache
       WHERE target_url = ?
         AND expires_at > CURRENT_TIMESTAMP`
    )
      .bind(target)
      .first<{ sections: string }>();
    if (!row || !row.sections) return null;
    const parsed = JSON.parse(row.sections);
    return Array.isArray(parsed) ? (parsed as Section[]) : null;
  } catch {
    // A cache miss and a broken cache should behave identically: just run it.
    return null;
  }
}

async function writeCache(env: PagespeedEnv, target: string, sections: Section[]): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO studio_pagespeed_cache (target_url, sections, created_at, expires_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, datetime('now', '+' || ? || ' seconds'))
       ON CONFLICT(target_url) DO UPDATE SET
         sections   = excluded.sections,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    )
      .bind(target, JSON.stringify(sections), CACHE_TTL_SECONDS)
      .run();
  } catch (error) {
    // Never fail a delivered audit because the cache write failed.
    console.error("pagespeed cache write failed", error);
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function runPagespeedAudit(
  env: PagespeedEnv,
  rawUrl: unknown
): Promise<{ sections: Section[]; cached: boolean }> {
  const { url: target } = normaliseTarget(rawUrl);

  const cached = await readCache(env, target);
  if (cached) return { sections: cached, cached: true };

  // Both layers run together. inspectPage is the one that is allowed to fail
  // the whole request, because without it there is no deliverable at all.
  const [facts, lighthouse] = await Promise.all([
    inspectPage(target),
    fetchLighthouse(env, target)
  ]);

  const sections = buildSections(target, facts, lighthouse);
  await writeCache(env, target, sections);
  return { sections, cached: false };
}
