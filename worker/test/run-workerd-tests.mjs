// SpeakPower Studio API — the same worker.js, run on Cloudflare's own runtime.
//
//   cd worker && npm install && npm install --no-save miniflare@4 wrangler@4 && node test/run-workerd-tests.mjs
//
// run-tests.mjs covers the business rules quickly in plain Node, against a
// stand-in database and without an HTML parser. This suite closes both gaps:
// workerd (the engine Cloudflare runs Workers on), real D1, and the real
// HTMLRewriter. Only the outside world is faked — the sites being audited,
// Google and Flutterwave — through Miniflare's outbound handler, so nothing
// here touches the network.

import { Miniflare, supportedCompatibilityDate } from "miniflare";
import { execFileSync } from "node:child_process";
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
  // Sends the whole head, then stops sending (a host that stalls half-way).
  "https://stalls.test/": () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(CLEAN.slice(0, CLEAN.indexOf("</head>") + 7))); }
  }), { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  "https://moved.test/": () => new Response(null, { status: 301, headers: { Location: "https://clean.test/" } }),
  "https://sneaky.test/": () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } })
};
// A small business site for the whole-site audit, crawled by its links.
const acme = (title, head, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`;
const ACME_NAV = '<a href="/about">About</a> <a href="/services">Services</a> <a href="/contact">Contact</a> <a href="/privacy">Privacy</a>';
const ACME_DESC = (what) => '<meta name="description" content="Acme Solar ' + what + ' for schools and clinics across northern Uganda, with local technicians and five-year support.">';
Object.assign(PAGES, {
  "https://acme.test/": () => html(acme("Acme Solar: Solar Kits for Ugandan Schools and Clinics",
    ACME_DESC("installs solar kits") + '<link rel="canonical" href="https://acme.test/">' +
    '<meta property="og:title" content="Acme Solar"><meta property="og:description" content="Solar for schools."><meta property="og:image" content="https://acme.test/og.png">' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Solar","sameAs":["https://www.linkedin.com/company/acme-solar"]}</script>',
    "<h1>Solar for <em>schools</em></h1><p>" + words(260) + "</p>" + ACME_NAV +
    ' <a href="/login">Log in</a> <a href="/admin/">Admin</a> <a href="/dashboard">Dashboard</a> <a href="/brochure.pdf">Brochure</a>' +
    ' <a href="https://partner.example/">Partner</a> <a href="tel:+256700000000">Call</a> <a href="mailto:hi@acme.test">Email</a>' +
    ' <img src="http://cdn.acme.test/logo.png" alt="Acme logo">'), { "Strict-Transport-Security": "max-age=31536000", "X-Content-Type-Options": "nosniff" }),
  "https://acme.test/about": () => html(acme("Acme Solar | Our work", "", "<p>" + words(30) + "</p>" + ACME_NAV)),
  "https://acme.test/services": () => html(acme("Acme Solar | Our work", ACME_DESC("lists its services"),
    "<h1>Services</h1><p>" + words(200) + "</p>" + ACME_NAV + ' <a href="/team">Our team</a>')),
  "https://acme.test/contact": () => html(acme("Contact Acme Solar about solar kits in Uganda", ACME_DESC("takes enquiries"),
    "<h1>Contact</h1><p>" + words(170) + "</p>" + ACME_NAV + ' <a href="tel:+256700000000">Call</a>')),
  "https://acme.test/privacy": () => html(acme("Privacy at Acme Solar: how we handle your data", ACME_DESC("explains privacy"),
    "<h1>Privacy</h1><p>" + words(180) + "</p>" + ACME_NAV)),
  "https://acme.test/team": () => html(acme("The Acme Solar team of engineers and technicians", ACME_DESC("introduces its team"),
    "<h1>Team</h1><p>" + words(170) + "</p>" + ACME_NAV)),
  "https://acme.test/login": () => html(acme("Sign in", '<meta name="robots" content="noindex">',
    '<form method="post"><input name="email"><input type="password" name="password"></form>')),
  "https://acme.test/admin/": () => new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/html" } }),
  "https://acme.test/dashboard": () => html(acme("Dashboard", "", "<h1>Orders</h1><p>Order 1001: 4 panels.</p>")),
  "https://acme.test/og.png": () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }),
  "https://acme.test/robots.txt": () => new Response("User-agent: *\nAllow: /\nSitemap: https://acme.test/sitemap.xml\n", { headers: { "Content-Type": "text/plain" } }),
  "https://acme.test/sitemap.xml": () => new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    ["/", "/about", "/services"].map((p) => "<url><loc>https://acme.test" + p + "</loc></url>").join("") + "</urlset>", { headers: { "Content-Type": "application/xml" } }),
  "http://acme.test/": () => new Response(null, { status: 301, headers: { Location: "https://acme.test/" } }),
  "https://www.acme.test/": () => new Response(null, { status: 301, headers: { Location: "https://acme.test/" } })
});

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
const coachCalls = [];
const pageFetches = [];
// Every request to an audited site, pages and site files alike.
const siteLog = [];
const griotMemories = [];
const griotProjects = [];

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
  // GRIOT, as far as the sign-up briefing reaches it: health, memory writes
  // and deletions, each kept per tenant.
  if (url.startsWith("https://griot.test/")) {
    const u = new URL(url);
    const tenant = request.headers.get("X-Tenant-Id");
    if (u.pathname === "/health") return Response.json({ status: "ok", tenancy: true, tenant_header: "X-Tenant-Id", workspace: true, projects: true });
    if (request.headers.get("X-API-Key") !== "griot-workerd-key") return Response.json({ detail: "bad key" }, { status: 401 });
    if (u.pathname === "/memory" && request.method === "POST") {
      const row = Object.assign({ id: crypto.randomUUID(), tenant_id: tenant }, await request.json());
      griotMemories.push(row);
      return Response.json(row);
    }
    // A client's own projects (claude-central-agent #29), per tenant.
    if (u.pathname === "/tenant/projects" && request.method === "GET") {
      return Response.json(griotProjects.filter((x) => x.tenant === tenant).map(({ slug, name }) => ({ slug, name })));
    }
    if (u.pathname === "/tenant/projects" && request.method === "POST") {
      const row = { tenant, slug: "p-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), name: (await request.json()).name };
      griotProjects.push(row);
      return Response.json({ slug: row.slug, name: row.name }, { status: 201 });
    }
    const delProject = u.pathname.match(/^\/tenant\/projects\/(.+)$/);
    if (delProject && request.method === "DELETE") {
      const i = griotProjects.findIndex((x) => x.tenant === tenant && x.slug === delProject[1]);
      if (i < 0) return Response.json({ detail: "No such project" }, { status: 404 });
      griotProjects.splice(i, 1);
      return Response.json({ deleted: delProject[1] });
    }
    const del = u.pathname.match(/^\/memories\/(.+)$/);
    if (del && request.method === "DELETE") {
      const i = griotMemories.findIndex((m) => m.id === del[1] && m.tenant_id === tenant);
      if (i < 0) return Response.json({ detail: "No such memory" }, { status: 404 });
      griotMemories.splice(i, 1);
      return Response.json({ deleted: del[1] });
    }
  }
  const audited = (() => { try { const h = new URL(url).hostname; return /\.test$/.test(h) && h !== "griot.test"; } catch (e) { return false; } })();
  if (audited) siteLog.push(url);
  if (PAGES[url]) {
    pageFetches.push({ url, redirect: request.redirect });
    return PAGES[url]();
  }
  // The Rehearsal Room's coach: the Anthropic SDK, bundled, calling out.
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    const body = await request.json();
    coachCalls.push({ key: request.headers.get("x-api-key"), beta: request.headers.get("anthropic-beta"), body });
    if (/senior strategist/.test(JSON.stringify(body.system || ""))) {
      return Response.json({
        id: "msg_strategy", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify({
          summary: "Sound pages; the dashboard is open to anyone and the brochure link is broken.",
          first_impression: "Solar kits for schools, with a phone number.",
          clarity: ["Audience", "Offer", "Proof", "Action", "Voice"].map((d) => ({ dimension: d, score: 3, note: d + " is clear." })),
          priorities: [1, 2, 3, 4, 5].map((n) => ({ action: "Do " + n, why: "Finding " + n, impact: "high", effort: "low", where: "/" })),
          plan: { days30: ["Lock /dashboard"], days60: ["Fix the brochure link"], days90: ["Add case studies"] } }) }],
        usage: { input_tokens: 4000, output_tokens: 900 }
      });
    }
    if (/You read one document/.test(JSON.stringify(body.system || ""))) {
      return Response.json({
        id: "msg_doc", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify({ brief: "A two-page plan.", facts: [
          { text: "Enrolment rose 18% in 2025.", page: 2 }, { text: "The plan runs to 2027.", page: 1 }] }) }],
        usage: { input_tokens: 800, output_tokens: 200 }
      });
    }
    const lenses = ["Politics", "Organizations", "Law", "Security", "Socioeconomics"].map((lens) => ({ lens, score: 4, note: "Clear." }));
    return Response.json({
      id: "msg_wd", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ lenses, landed: "The figure.", lost: "The ask.",
        fixes: ["Lead with the ask.", "Cut the history.", "End on the figure."], opening_line: "Forty schools.",
        sixty_second_version: "Forty schools now teach after dark." }) }],
      usage: { input_tokens: 900, output_tokens: 600 }
    });
  }
  // Anything else on an audited site (robots.txt, a sitemap, a page that is
  // not there) answers like a real server would.
  if (audited) return new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  return new Response("unexpected outbound fetch: " + url, { status: 599 });
}

/* -------------------------------------------------------------- harness */

const ORIGIN = "https://speakpower-commits.github.io";
// worker.js imports the Anthropic SDK, so it runs here exactly as Workers
// Builds deploys it: bundled by wrangler first.
const bundleDir = join(here, "..", ".wrangler", "test-bundle");
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", bundleDir], { cwd: join(here, ".."), stdio: "pipe" });

// A stand-in Workers AI binding with Whisper's output shape: 120 words over
// 50 seconds, one long pause.
const FAKE_AI = `export default function () {
  return {
  async toMarkdown(doc) {
    const raw = new TextDecoder().decode(new Uint8Array(await doc.blob.arrayBuffer())).replace(/^%PDF-1\\.4\\n/, "");
    return { name: doc.name, format: "markdown", tokens: 0,
      data: raw.split("\\f").map((p, i) => "### Page " + (i + 1) + "\\n" + p).join("\\n\\n") };
  },
  async run(model, input) {
    if (!input || typeof input.audio !== "string") throw new Error("no audio");
    const words = []; let t = 0.4;
    for (let i = 0; i < 120; i++) { if (i === 60) t += 3; words.push({ word: " " + (i === 5 ? "um" : "word"), start: t, end: t + 0.35 }); t += 0.4; }
    return { text: words.map((w) => w.word).join("") + ".", segments: [{ start: words[0].start, end: words[119].end, words }] };
  } };
}`;

const mf = new Miniflare({
  workers: [{
  name: "speakpower",
  modules: true,
  scriptPath: join(bundleDir, "worker.js"),
  compatibilityDate,
  d1Databases: { DB: "speakpower-test" },
  wrappedBindings: { AI: "fake-ai" },
  bindings: {
    ANTHROPIC_API_KEY: "sk-ant-workerd-test",
    SESSION_SECRET: "workerd-secret-0123456789abcdef-0123456789",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ALLOWED_ORIGINS: ORIGIN,
    ENVIRONMENT: "production",
    FREE_TRIALS: "3",
    FLW_SECRET_KEY: "FLWSECK_TEST-secret",
    FLW_SECRET_HASH: "flw-hash-secret",
    GRIOT_API_BASE: "https://griot.test",
    GRIOT_API_KEY: "griot-workerd-key"
  },
  outboundService: outbound
  }, {
    // A wrapped binding takes the compatibility date of the Worker using it.
    name: "fake-ai",
    modules: true,
    script: FAKE_AI
  }]
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

const STEP1 = { step: 1, name: "Test", expertise: "Testing", position: "Tester", company: "Test Co" };
const STEP2 = { step: 2, problem: "A problem", goal: "A goal", briefGriot: false };
// Signs in and, unless told otherwise, finishes both sign-up steps the way
// the welcome page does, so the older tests exercise the services as before.
async function signIn(email, { profile = true } = {}) {
  const r = await call("POST", "/auth/google", { body: { credential: await googleToken(email) } });
  eq(r.status, 200, "sign-in status");
  if (profile) {
    eq((await call("POST", "/profile", { token: r.data.token, body: STEP1 })).status, 200, "step 1");
    eq((await call("POST", "/profile", { token: r.data.token, body: STEP2 })).status, 200, "step 2");
  }
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
  eq(wall.status, 402); eq(wall.data.price, 150000); eq(wall.data.shortfall, 150000);
  await db.prepare("UPDATE users SET balance = 155000 WHERE email_canonical = 'd1.spender@example.com'").run();
  const paid = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://clean.test" } } });
  eq(paid.status, 200); eq(paid.data.amount, 150000); eq(paid.data.account.balance, 5000);
  eq((await user("d1.spender@example.com")).balance, 5000);
});

await test("real D1: a failed paid audit is refunded to the shilling, and the run marked refunded", async () => {
  const s = await signIn("d1.refund@example.com");
  await db.prepare("UPDATE users SET trials_remaining = 0, balance = 200000 WHERE email_canonical = 'd1.refund@example.com'").run();
  const r = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://sneaky.test" } } });
  eq(r.status, 502); ok(/not charged/.test(r.data.message), r.data.message);
  eq((await user("d1.refund@example.com")).balance, 200000);
  const run = await db.prepare("SELECT amount, status FROM runs WHERE user_id = ?").bind((await user("d1.refund@example.com")).id).first();
  eq(run.amount, 150000); eq(run.status, "refunded");
});

await test("real D1: parallel paid uses never overdraw", async () => {
  const s = await signIn("d1.race@example.com");
  await db.prepare("UPDATE users SET trials_remaining = 0, balance = 310000 WHERE email_canonical = 'd1.race@example.com'").run();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
    call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://clean.test" } } })));
  eq(results.filter((r) => r.status === 200).length, 2, "310,000 covers two 150,000 audits");
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

await test("real D1: a plan payment opens 30 days once; rehearsals then draw on it, never on the balance", async () => {
  const email = "d1.member@example.com";
  const s = await signIn(email);
  await db.prepare("UPDATE users SET trials_remaining = 0, balance = 900000 WHERE email_canonical = ?").bind(email).run();
  const audio = Buffer.from("x".repeat(3000)).toString("base64");
  const wall = await call("POST", "/rehearse", { token: s.token, body: { moment: "intro-60", audio, seconds: 40 } });
  eq(wall.status, 402); eq(wall.data.error, "plan_required"); ok(!("price" in wall.data), "no per-rehearsal price");
  const c = await call("POST", "/plans/checkout", { token: s.token, body: { plan: "starter", amount: 1 } });
  eq(c.status, 200); eq(c.data.amount, 60000, "the plan's price, not the browser's");
  flw.transactions["777101"] = { id: 777101, tx_ref: c.data.txRef, status: "successful", amount: 60000, currency: "UGX" };
  flw.delayMs = 40;
  const hook = () => mf.dispatchFetch("https://api.test/webhooks/flutterwave", {
    method: "POST", headers: { "Content-Type": "application/json", "verif-hash": "flw-hash-secret" },
    body: JSON.stringify({ event: "charge.completed", data: { id: 777101, tx_ref: c.data.txRef } })
  });
  await Promise.all([hook(), hook(), hook(),
    call("POST", "/wallet/confirm", { token: s.token, body: { txRef: c.data.txRef, transactionId: "777101" } })]);
  flw.delayMs = 0;
  const u = await user(email);
  const rows = (await db.prepare("SELECT plan, starts_at, ends_at FROM subscriptions WHERE user_id = ?").bind(u.id).all()).results;
  eq(rows.length, 1, "one period, not four"); eq(rows[0].ends_at - rows[0].starts_at, 30 * 86400);
  eq(u.balance, 900000, "a plan payment never lands on the balance");
  const r = await call("POST", "/rehearse", { token: s.token, body: { moment: "intro-60", audio, seconds: 40 } });
  eq(r.status, 200); eq(r.data.paidWith, "plan");
  eq(r.data.account.membership.plan, "starter"); eq(r.data.account.membership.usage.rehearsal, 5);
  eq((await user(email)).balance, 900000);
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
  ok(/once the whole site has been read/.test(section(r, "Google Lighthouse scores")), "Lighthouse comes after the crawl");
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

await test("seo: a page that stalls half-way is reported on what arrived (15 s, real time)", async () => {
  const r = await audit("https://stalls.test");
  eq(r.status, 200, r.data.message);
  ok(/inspected; the rest of the page was too slow to arrive/.test(section(r, "Audited page")), section(r, "Audited page"));
  // The head was read by the real HTML parser before the stall.
  ok(/^Page title: 54 characters/m.test(section(r, "Already correct")), "facts from the part that arrived");
});

await test("audit: a whole site is crawled by its links with the real parser, every finding in its place", async () => {
  siteLog.length = 0;
  const start = await call("POST", "/studio/generate", { token: auditor.token, body: { product: "seo-audit", inputs: { url: "https://acme.test" } } });
  eq(start.status, 200, JSON.stringify(start.data).slice(0, 300));
  const id = start.data.audit.id;
  let a = start.data.audit;
  for (let i = 0; a.state !== "done" && i < 20; i++) {
    const step = await call("POST", "/studio/audit/run", { token: auditor.token, body: { id, stage: "crawl" } });
    eq(step.status, 200, "crawl step");
    a = step.data.audit;
  }
  eq((await call("POST", "/studio/audit/run", { token: auditor.token, body: { id, stage: "strategy" } })).status, 200);
  const got = await call("GET", "/studio/audit?id=" + id, { token: auditor.token });
  const r = got.data.report;
  const check = (label) => r.checks.find((c) => c.label === label) || {};
  eq(r.pages.map((p) => p.path).sort().join(","), "/,/about,/contact,/privacy,/services,/team", "found by links, /team from /services");
  eq(r.pages.find((p) => p.path === "/").h1Text, "Solar for schools", "the first H1's words, nested tags and all");
  eq(check("Unique titles").level, "warn"); ok(/\/about, \/services/.test(check("Unique titles").pages[0]), "the shared title names both pages");
  eq(check("Main headings (H1)").level, "fail"); eq(JSON.stringify(check("Main headings (H1)").pages), JSON.stringify(["/about"]));
  eq(check("Thin pages").level, "warn"); eq(JSON.stringify(check("Thin pages").pages), JSON.stringify(["/about"]));
  eq(check("Meta descriptions").level, "warn"); eq(JSON.stringify(check("Meta descriptions").pages), JSON.stringify(["/about"]));
  eq(check("Broken internal links").level, "fail"); eq(check("Broken internal links").pages[0], "/brochure.pdf (HTTP 404), linked from /");
  eq(check("Private areas").level, "fail"); eq(JSON.stringify(check("Private areas").pages), JSON.stringify(["/dashboard"]));
  const login = r.privateAreas.find((x) => x.path === "/login");
  eq(login.verdict, "protected"); eq(login.detail, "A sign-in form, kept out of search.");
  eq(r.privateAreas.find((x) => x.path === "/admin/").verdict, "protected");
  eq(check("Mixed content").level, "fail"); eq(JSON.stringify(check("Mixed content").pages), JSON.stringify(["/"]));
  for (const label of ["Who is behind the site", "Linked profiles (sameAs)", "Share image", "Ways to reach you", "Privacy policy", "HSTS",
    "http to https", "www and non-www", "Missing pages", "XML sitemap", "robots.txt", "Mobile layout", "Secure connection (https)"]) {
    eq(check(label).level, "pass", label + ": " + check(label).detail);
  }
  ok(/phone, email/.test(check("Ways to reach you").detail));
  ok(r.overall > 0 && r.overall < 100, "scored: " + r.overall);
  eq(r.strategy.priorities.length, 5, "the strategic read is in");
  const allowed = /^\/($|about$|services$|contact$|privacy$|team$|login$|admin\/$|dashboard$|brochure\.pdf$|og\.png$|robots\.txt$|llms\.txt$|sitemap\.xml$|speakpower-audit-[0-9a-f]{8}-not-a-page$)/;
  const paths = siteLog.map((u) => new URL(u).pathname);
  ok(paths.every((p) => allowed.test(p)), "nothing guessed: " + paths.filter((p) => !allowed.test(p)).join(", "));
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

await test("real D1: the sign-up profile gates spending, briefs GRIOT under the account's tenant, and deletes cleanly", async () => {
  const email = "d1.profile@example.com";
  const s = await signIn(email, { profile: false });
  eq(JSON.stringify(s.account.profile), '{"step1":false,"step2":false}');
  const gated = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://clean.test" } } });
  eq(gated.status, 409); eq(gated.data.step, 1);
  eq((await user(email)).trials_remaining, 3, "nothing spent");
  eq((await call("POST", "/profile", { token: s.token, body: Object.assign({}, STEP1, { sector: "ngo" }) })).status, 200);
  const two = await call("POST", "/profile", { token: s.token, body: Object.assign({}, STEP2, { focus: ["data"], briefGriot: true }) });
  eq(two.status, 200); eq(two.data.profile.griot.state, "sent");
  const id = (await user(email)).id;
  const mine = griotMemories.filter((m) => m.tenant_id === id);
  eq(mine.map((m) => m.title).join("|"), "Profile|Challenge|Goal|Focus");
  ok(mine.every((m) => m.kind === "profile" && m.project === "global"), "filed as the client's profile");
  const row = await db.prepare("SELECT griot_memory_ids, griot_lock_until, version FROM profiles WHERE user_id = ?").bind(id).first();
  eq(JSON.parse(row.griot_memory_ids).length, 4); eq(row.griot_lock_until, null); eq(row.version, 2);
  const again = await call("POST", "/profile", { token: s.token, body: Object.assign({}, STEP1, { position: "Director" }) });
  eq(again.status, 200); eq(griotMemories.filter((m) => m.tenant_id === id).length, 4, "replaced on real D1");
  const d = await call("POST", "/profile/delete", { token: s.token, body: {} });
  eq(d.status, 200); eq(d.data.griotCleared, true);
  eq(await db.prepare("SELECT 1 FROM profiles WHERE user_id = ?").bind(id).first(), null);
  eq(griotMemories.filter((m) => m.tenant_id === id).length, 0);
});

await test("projects: the bundled Worker keeps a client's projects under their own tenant, on workerd", async () => {
  const a = await signIn("projects.a@example.com");
  const b = await signIn("projects.b@example.com");
  const made = await call("POST", "/griot/my-projects", { token: a.token, body: { name: "Coffee  export\tpitch" } });
  eq(made.status, 200, JSON.stringify(made.data)); ok(/^p-[0-9a-f]{8}$/.test(made.data.project.slug)); eq(made.data.project.name, "Coffee export pitch");
  const listA = await call("GET", "/griot/my-projects", { token: a.token });
  eq(listA.data.ready, true); eq(listA.data.projects.length, 1);
  eq((await call("GET", "/griot/my-projects", { token: b.token })).data.projects.length, 0, "B sees none of A's");
  eq(griotProjects[0].tenant, (await user("projects.a@example.com")).id, "the tenant is the account's own id");
  eq((await call("POST", "/griot/my-projects/delete", { token: b.token, body: { slug: made.data.project.slug } })).status, 404);
  eq((await call("POST", "/griot/my-projects/delete", { token: a.token, body: { slug: made.data.project.slug } })).status, 200);
  eq((await call("GET", "/griot/projects", { token: a.token })).status, 404, "the operator's ventures stay unreachable");
});

await test("real D1: a document is read once, kept as facts with pages, limited by plan, and deleted", async () => {
  const s = await signIn("d1.docs@example.com");
  const pdf = new TextEncoder().encode("%PDF-1.4\nOur plan for 2025 to 2027, for the board, in two pages of detail.\fEnrolment rose 18% in 2025 across our schools.");
  const up = (name) => mf.dispatchFetch("https://api.test/griot/documents?name=" + encodeURIComponent(name), {
    method: "POST", headers: { Origin: ORIGIN, Authorization: "Bearer " + s.token, "Content-Type": "application/pdf" }, body: pdf
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const r = await up("Plan.pdf");
  eq(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  eq(r.data.document.pages, 2); eq(r.data.document.facts[0].page, 2);
  eq((await up("Second.pdf")).status, 402, "a free account holds one");
  const id = (await user("d1.docs@example.com")).id;
  const row = await db.prepare("SELECT kind, bytes, enabled FROM documents WHERE user_id = ?").bind(id).first();
  eq(row.kind, "pdf"); eq(row.bytes, pdf.length); eq(row.enabled, 1);
  eq((await call("POST", "/griot/documents/toggle", { token: s.token, body: { id: r.data.document.id, enabled: false } })).data.document.enabled, false);
  eq((await call("POST", "/griot/documents/delete", { token: s.token, body: { id: r.data.document.id } })).status, 200);
  eq(await db.prepare("SELECT 1 FROM documents WHERE user_id = ?").bind(id).first(), null);
});

await test("rehearse: the bundled Worker transcribes, scores and coaches on workerd, with real D1", async () => {
  const s = await signIn("rehearser@example.com");
  const audio = Buffer.from("x".repeat(3000)).toString("base64");
  coachCalls.length = 0;
  const r = await call("POST", "/rehearse", { token: s.token, body: { moment: "donor-presentation", audio, seconds: 52 } });
  eq(r.status, 200, "status " + JSON.stringify(r.data).slice(0, 200));
  eq(r.data.kind, "speak", "coached");
  eq(r.data.metrics.words, 120); eq(r.data.metrics.longPauses, 1); eq(r.data.metrics.fillers, 1);
  eq(r.data.coaching.lenses.length, 5);
  eq(coachCalls.length, 1, "one call through the Anthropic SDK");
  eq(coachCalls[0].key, "sk-ant-workerd-test"); eq(coachCalls[0].body.model, "claude-opus-5-5");
  eq(coachCalls[0].body.fallbacks, "default");
  const row = await db.prepare("SELECT moment, kind, score FROM rehearsals WHERE moment = 'donor-presentation'").first();
  eq(row.moment, "donor-presentation"); eq(row.score, r.data.score);
  const h = await call("GET", "/rehearsals", { token: s.token });
  eq(h.data.rehearsals.length, 1);
});

await mf.dispose();
console.log("\n" + passed + " passed, " + failures.length + " failed\n");
if (failures.length) process.exit(1);
