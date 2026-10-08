// SpeakPower Studio API — the same worker.js, run on Cloudflare's own runtime.
//
//   cd worker && npm install --no-save miniflare@4 && node test/run-workerd-tests.mjs
//
// run-tests.mjs covers the business rules quickly in plain Node, against a
// stand-in database and without an HTML parser. This suite closes both gaps:
// workerd (the engine Cloudflare runs Workers on), real D1, and the real
// HTMLRewriter. Only the outside world is faked — the sites being audited,
// Google and Flutterwave — through Miniflare's outbound handler, so nothing
// here touches the network.

import { Miniflare, supportedCompatibilityDate } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
// The deployed date from wrangler.toml, or the newest this workerd build
// knows if that is later. Nothing this Worker uses (fetch, D1, HTMLRewriter,
// WebCrypto) changes between the two; the date actually used is printed.
const configuredDate = readFileSync(join(here, "..", "wrangler.toml"), "utf8")
  .match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];
const compatibilityDate = configuredDate <= supportedCompatibilityDate ? configuredDate : supportedCompatibilityDate;

/* ------------------------------------------------------------- fixtures */

const words = (n) => Array.from({ length: n }, (_, i) => ["solar", "school", "power", "light", "lesson"][i % 5]).join(" ");

const CLEAN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Solar Kits for Ugandan Schools &amp; Clinics &mdash; Acme Energy</title>
<meta name="description" content="Acme Energy installs solar kits for schools and clinics across northern Uganda, with local technicians, five-year support and transparent pricing.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://clean.test/">
<link rel="icon" href="/favicon.png">
<meta property="og:title" content="Acme Energy">
<meta property="og:description" content="Solar for schools and clinics.">
<meta property="og:image" content="https://clean.test/og.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","founder":{"@type":"Person","name":"Akello"}}</script>
</head>
<body>
<svg aria-hidden="true"><title>Sun icon</title><circle r="4"/></svg>
<h1>Solar for schools</h1>
<h2>How it works</h2><h3>Installation</h3><h2>Pricing</h2>
<p>${words(220)}</p>
<img src="a.png" alt="Technician fitting a panel"><img src="divider.png" alt="">
<a href="/about">About</a> <a href="https://partner.example/">Partner</a> <a href="#top">Top</a> <a href="mailto:hi@clean.test">Email</a>
</body>
</html>`;

// Every defect the audit is meant to catch, including the one that once
// broke this site's own work.html: a JSON-LD block missing its closing brace.
const BROKEN = `<!doctype html>
<html>
<head>
<title>Home</title>
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="https://elsewhere.test/page">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"X"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Y"</script>
</head>
<body>
<h1>Welcome</h1><h3>Skipped a level</h3><h1>Welcome again</h1>
<p>Short page.</p>
<img src="1.png"><img src="2.png"><img src="3.png"><img src="4.png" alt="Only one">
<a href="https://elsewhere.test/">Out</a>
</body>
</html>`;

const PAGES = {
  "https://clean.test/": () => html(CLEAN),
  "https://broken.test/": () => html(BROKEN),
  "https://hidden.test/": () => html(CLEAN.replace("https://clean.test/", "https://hidden.test/"), { "X-Robots-Tag": "noindex" }),
  "https://doubled.test/": () => html(CLEAN.replace("</head>",
    '<title>Second title</title><meta name="description" content="A second description"></head>')),
  "https://entities.test/": () => html("<html lang=en><head><title>Tom &amp; Jerry&#39;s &mdash; Kampala</title></head><body><h1>x</h1></body></html>"),
  "https://huge.test/": () => html(CLEAN.replace("</body>", "<p>" + "x".repeat(600 * 1024) + "</p></body>")),
  "https://moved.test/": () => new Response(null, { status: 301, headers: { Location: "https://clean.test/" } }),
  "https://sneaky.test/": () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } })
};
// This site's own pages, served exactly as committed, so the audit is
// exercised on real-world markup and the result doubles as a self-check.
const SITE = "https://speakpower-commits.github.io/SpeakPower/";
for (const file of ["index.html", "studio.html", "work.html"]) {
  PAGES[SITE + (file === "index.html" ? "" : file)] = () => html(readFileSync(join(root, file), "utf8"));
}

function html(body, headers = {}) {
  return new Response(body, { headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers) });
}

/* ------------------------------------------------- Google and Flutterwave */

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const keys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
const jwk = Object.assign(await crypto.subtle.exportKey("jwk", keys.publicKey), { kid: "kid-1", alg: "RS256", use: "sig" });
const CLIENT_ID = "1234-speakpower.apps.googleusercontent.com";
const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function googleToken(email) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: "RS256", kid: "kid-1", typ: "JWT" });
  const body = b64u({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: email, email, email_verified: true, name: "Test", iat: now, exp: now + 3600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + Buffer.from(sig).toString("base64url");
}

const flw = { transactions: {}, verifies: 0, delayMs: 0 };
const pageFetches = [];

async function outbound(request) {
  const url = request.url;
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    return Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "public, max-age=19000" } });
  }
  if (url === "https://api.flutterwave.com/v3/payments") {
    const body = await request.json();
    return Response.json({ status: "success", data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/" + body.tx_ref } });
  }
  const verify = url.match(/^https:\/\/api\.flutterwave\.com\/v3\/transactions\/(\d+)\/verify$/);
  if (verify) {
    flw.verifies++;
    if (flw.delayMs) await new Promise((r) => setTimeout(r, flw.delayMs));
    const tx = flw.transactions[verify[1]];
    return tx ? Response.json({ status: "success", data: tx }) : Response.json({ status: "error" }, { status: 404 });
  }
  if (PAGES[url]) {
    pageFetches.push({ url, redirect: request.redirect });
    return PAGES[url]();
  }
  return new Response("unexpected outbound fetch: " + url, { status: 599 });
}

/* -------------------------------------------------------------- harness */

const ORIGIN = "https://speakpower-commits.github.io";
const mf = new Miniflare({
  modules: true,
  scriptPath: join(here, "..", "worker.js"),
  compatibilityDate,
  d1Databases: { DB: "speakpower-test" },
  bindings: {
    SESSION_SECRET: "workerd-secret-0123456789abcdef-0123456789",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ALLOWED_ORIGINS: ORIGIN,
    ENVIRONMENT: "production",
    FREE_TRIALS: "3",
    FLW_SECRET_KEY: "FLWSECK_TEST-secret",
    FLW_SECRET_HASH: "flw-hash-secret"
  },
  outboundService: outbound
});

const db = await mf.getD1Database("DB");
const schema = readFileSync(join(here, "..", "schema.sql"), "utf8").replace(/--[^\n]*/g, "");
await db.batch(schema.split(";").map((q) => q.trim()).filter(Boolean).map((q) => db.prepare(q)));

async function call(method, path, { body, token, headers = {} } = {}) {
  const h = Object.assign({ Origin: ORIGIN }, headers);
  if (token) h.Authorization = "Bearer " + token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await mf.dispatchFetch("https://api.test" + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failures.push(name); console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label || "value") + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function ok(cond, label) { if (!cond) throw new Error(label || "assertion failed"); }

async function signIn(email) {
  const r = await call("POST", "/auth/google", { body: { credential: await googleToken(email) } });
  eq(r.status, 200, "sign-in status");
  return r.data;
}
const user = (email) => db.prepare("SELECT * FROM users WHERE email_canonical = ?").bind(email).first();
const section = (r, name) => (r.data.sections.find((s) => s[0] === name) || [null, ""])[1];

// One paid-up account runs every audit, so the tests are about findings, not tries.
let auditor;
async function audit(url) {
  const r = await call("POST", "/studio/generate", { token: auditor.token, body: { product: "seo-audit", inputs: { url } } });
  return r;
}

/* ----------------------------------------------------------------- tests */

console.log("\nSpeakPower Studio API — on workerd, compatibility date " + compatibilityDate +
  (compatibilityDate === configuredDate ? "" : " (wrangler.toml: " + configuredDate + ", newer than this workerd)") + "\n");

await test("runtime: health, CORS, and a foreign origin refused", async () => {
  eq((await call("GET", "/health")).status, 200);
  eq((await call("GET", "/health", { headers: { Origin: "https://evil.example" } })).status, 403);
});

await test("runtime: Google sign-in verifies RS256 with WebCrypto and grants 3 free tries", async () => {
  const s = await signIn("workerd.user@example.com");
  ok(s.token, "session");
  eq(s.account.trialsRemaining, 3); eq(s.account.balance, 0); eq(s.account.currency, "UGX");
  auditor = await signIn("auditor@example.com");
  await db.prepare("UPDATE users SET balance = 10000000 WHERE email_canonical = 'auditor@example.com'").run();
});

await test("real D1: three free tries across services, a 402 with the shortfall, then exact deduction", async () => {
  const s = await signIn("d1.spender@example.com");
  for (const url of ["https://clean.test", "https://broken.test", "https://moved.test"]) {
    const r = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url } } });
    eq(r.status, 200, url); eq(r.data.paidWith, "trial");
  }
  const wall = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://clean.test" } } });
  eq(wall.status, 402); eq(wall.data.price, 75000); eq(wall.data.shortfall, 75000);
  await db.prepare("UPDATE users SET balance = 80000 WHERE email_canonical = 'd1.spender@example.com'").run();
  const paid = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://clean.test" } } });
  eq(paid.status, 200); eq(paid.data.amount, 75000); eq(paid.data.account.balance, 5000);
  eq((await user("d1.spender@example.com")).balance, 5000);
});

await test("real D1: a failed paid audit is refunded to the shilling, and the run marked refunded", async () => {
  const s = await signIn("d1.refund@example.com");
  await db.prepare("UPDATE users SET trials_remaining = 0, balance = 100000 WHERE email_canonical = 'd1.refund@example.com'").run();
  const r = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://sneaky.test" } } });
  eq(r.status, 502); ok(/not charged/.test(r.data.message), r.data.message);
  eq((await user("d1.refund@example.com")).balance, 100000);
  const run = await db.prepare("SELECT amount, status FROM runs WHERE user_id = ?").bind((await user("d1.refund@example.com")).id).first();
  eq(run.amount, 75000); eq(run.status, "refunded");
});

await test("real D1: parallel paid uses never overdraw", async () => {
  const s = await signIn("d1.race@example.com");
  await db.prepare("UPDATE users SET trials_remaining = 0, balance = 160000 WHERE email_canonical = 'd1.race@example.com'").run();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
    call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://clean.test" } } })));
  eq(results.filter((r) => r.status === 200).length, 2, "160,000 covers two 75,000 audits");
  eq((await user("d1.race@example.com")).balance, 10000);
});

await test("real D1: a burst of payment notifications plus the return page credits exactly once", async () => {
  const s = await signIn("d1.topup@example.com");
  const c = await call("POST", "/wallet/checkout", { token: s.token, body: { amount: 50000 } });
  eq(c.status, 200);
  flw.transactions["777001"] = { id: 777001, tx_ref: c.data.txRef, status: "successful", amount: 50000, currency: "UGX" };
  flw.delayMs = 40; // hold verification open so every settle overlaps
  const hook = () => mf.dispatchFetch("https://api.test/webhooks/flutterwave", {
    method: "POST", headers: { "Content-Type": "application/json", "verif-hash": "flw-hash-secret" },
    body: JSON.stringify({ event: "charge.completed", data: { id: 777001, tx_ref: c.data.txRef } })
  });
  const before = flw.verifies;
  const results = await Promise.all([
    hook(), hook(), hook(), hook(), hook(), hook(),
    call("POST", "/wallet/confirm", { token: s.token, body: { txRef: c.data.txRef, transactionId: "777001" } })
  ]);
  flw.delayMs = 0;
  ok(flw.verifies - before >= 7, "all seven reached verification together");
  ok(results.slice(0, 6).every((r) => r.status === 200), "webhooks acknowledged");
  eq((await user("d1.topup@example.com")).balance, 50000, "credited once, not seven times");
  const p = await db.prepare("SELECT status, provider_ref FROM payments WHERE tx_ref = ?").bind(c.data.txRef).first();
  eq(p.status, "paid"); eq(p.provider_ref, "777001");
});

await test("seo: a clean page — every check passes, SVG titles ignored, entities decoded", async () => {
  const r = await audit("https://clean.test");
  eq(r.status, 200);
  // Twelve checks can pass; language, favicon and X card only ever warn.
  eq(section(r, "Summary"), "0 to fix, 0 to review, 12 already correct.");
  ok(!section(r, "Fix these first") && !section(r, "Worth reviewing"), "nothing to fix or review");
  const right = section(r, "Already correct");
  // "Solar Kits for Ugandan Schools & Clinics — Acme Energy" is 54 characters
  // once &amp; and &mdash; are decoded; counted raw it would be 63.
  ok(/^Page title: 54 characters/m.test(right), "title measured after decoding: " + right.split("\n")[2]);
  ok(/Structured data: 1 valid JSON-LD block declaring Organization, Person\./.test(right), "JSON-LD types");
  ok(/Image alt text: All 2 images carry an alt attribute/.test(right), "alt=\"\" counts as handled");
  ok(/Internal linking: 1 internal link and 1 external/.test(right), "#top and mailto: are not links to count");
  ok(/Content depth: About 2\d\d words/.test(right), "prose counted");
  ok(/not switched on/.test(section(r, "Google Lighthouse scores")), "no key: says so");
});

await test("seo: a broken page — every defect found and ranked, including invalid JSON-LD", async () => {
  const r = await audit("https://broken.test");
  eq(r.status, 200);
  const fix = section(r, "Fix these first");
  const review = section(r, "Worth reviewing");
  for (const label of ["Indexability", "Meta description", "Structured data is invalid", "Social sharing preview", "Image alt text", "Mobile readiness"]) {
    ok(fix.includes(label + ":"), "to fix: " + label);
  }
  ok(/1 of 2 JSON-LD blocks will not parse/.test(fix), "names the broken block");
  ok(/3 of 4 images have no alt/.test(fix), "alt count");
  for (const label of ["Page title", "Main heading (H1)", "Heading order", "Canonical tag", "Page language", "Content depth", "Internal linking", "Favicon"]) {
    ok(review.includes(label + ":"), "to review: " + label);
  }
  ok(/Only 4 characters \("Home"\)/.test(review), "short title quoted");
  ok(/h1 → h3/.test(review), "skipped heading level named");
  ok(/Points to a different address \(https:\/\/elsewhere\.test\/page\)/.test(review), "canonical elsewhere");
  ok(fix.indexOf("Indexability") < fix.indexOf("Mobile readiness"), "indexability first");
});

await test("seo: noindex sent as an X-Robots-Tag header is caught", async () => {
  const fix = section(await audit("https://hidden.test"), "Fix these first");
  ok(/Indexability: .*X-Robots-Tag header/.test(fix), fix);
});

await test("seo: duplicate titles and descriptions are flagged; the first title is the one measured", async () => {
  const r = await audit("https://doubled.test");
  const review = section(r, "Worth reviewing");
  ok(/Duplicate title tags: The page has 2/.test(review), review);
  ok(/Duplicate meta descriptions: The page has 2/.test(review), review);
  ok(/Page title: 54 characters/.test(section(r, "Already correct")), "first title kept");
});

await test("seo: entities in a short title are decoded before it is quoted back", async () => {
  ok(/Only 23 characters \("Tom & Jerry's — Kampala"\)/.test(section(await audit("https://entities.test"), "Worth reviewing")));
});

await test("seo: an oversized page is inspected up to the cap, then reported", async () => {
  const r = await audit("https://huge.test");
  eq(r.status, 200);
  ok(/first 512 KB inspected/.test(section(r, "Audited page")), section(r, "Audited page"));
});

await test("seo: redirects are followed by hand on workerd; a hop to a private address is refused", async () => {
  // Miniflare's outbound bridge rebuilds each request and drops its redirect
  // mode, so the proof is behavioural: had workerd followed redirects itself,
  // the sneaky hop below would have reached the metadata address.
  pageFetches.length = 0;
  const moved = await audit("https://moved.test");
  eq(moved.status, 200);
  eq(pageFetches.map((p) => p.url).join(" | "), "https://moved.test/ | https://clean.test/");
  ok(/Redirected from https:\/\/moved\.test\//.test(section(moved, "Audited page")));
  const sneaky = await audit("https://sneaky.test");
  eq(sneaky.status, 502); ok(/redirects somewhere that cannot be audited/.test(sneaky.data.message));
  ok(!pageFetches.some((p) => p.url.includes("169.254")), "the metadata address was never fetched");
});

await test("seo: this site's own pages, as committed, parse cleanly", async () => {
  console.log("");
  for (const path of ["", "studio.html", "work.html"]) {
    const r = await audit(SITE + path);
    eq(r.status, 200, path || "index");
    const fix = section(r, "Fix these first");
    ok(!/Structured data is invalid/.test(fix), (path || "index.html") + " JSON-LD: " + fix);
    ok(!/Page title: There is no/.test(fix), "title found");
    const names = (text) => text ? text.split("\n\n").map((x) => x.split(":")[0]).join(", ") : "—";
    console.log("      " + (path || "index.html").padEnd(12) + section(r, "Summary") +
      "\n        fix: " + names(fix) + "\n        review: " + names(section(r, "Worth reviewing")));
  }
});

await mf.dispose();
console.log("\n" + passed + " passed, " + failures.length + " failed\n");
if (failures.length) process.exit(1);
