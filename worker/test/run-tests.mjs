// SpeakPower Studio API — end-to-end tests against an in-memory D1 stand-in.
// Run: node --experimental-sqlite worker/test/run-tests.mjs   (Node 22.5+)
//
// Exercises the real worker.js fetch handler. Only D1, the email binding and
// outbound fetch (Turnstile, PageSpeed, Google certificates, GRIOT,
// Flutterwave) are replaced with local fakes.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../worker.js";

const here = dirname(fileURLToPath(import.meta.url));

// Node has no HTMLRewriter. This stand-in passes the page through without
// parsing it, so this suite covers the SEO audit's billing, address guard,
// failure refunds and Google layer. What the parser finds in a page is
// verified separately, under Cloudflare's real runtime: run-workerd-tests.mjs.
if (typeof globalThis.HTMLRewriter === "undefined") {
  globalThis.HTMLRewriter = class { on() { return this; } transform(res) { return res; } };
}

/* ---------------------------------------------------------------- D1 fake */

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params), success: true }; }
  async run() {
    const st = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) return { results: st.all(...this.params), success: true };
    const info = st.run(...this.params);
    return { success: true, meta: { changes: info.changes } };
  }
}

class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  q(sql, ...p) { return this.db.prepare(sql).all(...p); }
  one(sql, ...p) { return this.db.prepare(sql).get(...p); }
}

/* ------------------------------------------------------- outbound fakes */

const net = { pagespeed: "ok", griot: "ok", pagespeedCalls: [], pageFetches: [] };
// The public half of a real RSA key the tests sign Google ID tokens with, so
// the Worker's signature check runs for real rather than against a stub.
const googleJwks = { keys: [] };
// A stand-in Flutterwave: checkouts it was asked for, and the transactions it
// will vouch for when the Worker re-verifies a payment.
const flw = { checkouts: [], transactions: {}, verifies: 0 };
// Every request that reaches the fake GRIOT, so tests can assert exactly what
// crossed the boundary: which tenant, which key, and that no project leaked.
const griotCalls = [];
let griotOldChats = 0;
let griotHealthChecks = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === "https://api.flutterwave.com/v3/payments") {
    const body = JSON.parse(init.body);
    flw.checkouts.push({ body, auth: new Headers(init.headers).get("Authorization") });
    if (net.flwCheckout === "fail") return new Response(JSON.stringify({ status: "error", message: "nope" }), { status: 400 });
    return new Response(JSON.stringify({
      status: "success", message: "Hosted Link",
      data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/" + body.tx_ref }
    }));
  }
  const verifyMatch = url.match(/^https:\/\/api\.flutterwave\.com\/v3\/transactions\/([^/]+)\/verify$/);
  if (verifyMatch) {
    flw.verifies++;
    // Hold every verification open so concurrent settles genuinely overlap.
    if (net.flwVerifyDelay) await new Promise((r) => setTimeout(r, net.flwVerifyDelay));
    if (net.flwVerify === "down") return new Response("upstream down", { status: 503 });
    const tx = flw.transactions[decodeURIComponent(verifyMatch[1])];
    if (!tx) return new Response(JSON.stringify({ status: "error", message: "No transaction was found" }), { status: 404 });
    return new Response(JSON.stringify({ status: "success", data: tx }));
  }
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    net.googleCertFetches = (net.googleCertFetches || 0) + 1;
    return new Response(JSON.stringify(googleJwks), {
      headers: { "Cache-Control": "public, max-age=19000, must-revalidate" }
    });
  }
  // A GRIOT from before tenancy: answers /health without the flag, and would
  // happily accept a chat — which is exactly why the Worker must never send one.
  if (url.startsWith("https://griot-old.test/")) {
    if (url.includes("/health")) return new Response(JSON.stringify({ status: "ok", agent: "GRIOT OS" }));
    griotOldChats++;
    return new Response(JSON.stringify({ thread_id: "t", answer: "pooled with everyone" }));
  }
  if (url.startsWith("https://griot.test/health")) {
    griotHealthChecks++;
    return new Response(JSON.stringify({ status: "ok", tenancy: true, tenant_header: "X-Tenant-Id" }));
  }
  if (url.startsWith("https://griot.test/")) {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    griotCalls.push({ url, tenant: headers.get("X-Tenant-Id"), key: headers.get("X-API-Key"), body });
    if (net.griot === "hang") {
      // Honour the abort signal the way a real fetch does, so the Worker's
      // timeout is what ends the wait.
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (net.griot === "fail") return new Response("Traceback: internal detail", { status: 500 });
    if (net.griot === "auth") return new Response("bad key sk-live-SECRET", { status: 401 });
    if (net.griot === "busy") return new Response("slow down", { status: 429 });
    if (net.griot === "malformed") return new Response(JSON.stringify({ nope: true }));
    return new Response(JSON.stringify({
      decision_id: "d-" + griotCalls.length,
      thread_id: body.thread_id || "t-" + headers.get("X-Tenant-Id"),
      project: null,
      mode: body.mode,
      agents: ["Market", "Brand"],
      memory_used: 2,
      history_turns: 0,
      memory_written: "Prefers evidence over adjectives",
      answer: "FACT: you said X. INFERENCE: therefore Y."
    }));
  }
  if (url.startsWith("https://challenges.cloudflare.com/turnstile/")) {
    const token = init.body.get("response");
    return new Response(JSON.stringify({ success: token === "pass" }));
  }
  if (url.startsWith("https://www.googleapis.com/pagespeedonline/")) {
    net.pagespeedCalls.push(url);
    if (net.pagespeed === "fail") return new Response("nope", { status: 500 });
    if (net.pagespeed === "quota") return new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded" } }), { status: 429 });
    if (net.pagespeed === "badkey") {
      return new Response(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.",
        details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 });
    }
    return new Response(JSON.stringify({
      lighthouseResult: {
        categories: { seo: { score: 0.82 }, performance: { score: 0.5 }, accessibility: { score: 0.9 }, "best-practices": { score: 1 } },
        audits: {
          "meta-description": { title: "Document does not have a meta description", score: 0, scoreDisplayMode: "binary" },
          "image-alt": { title: "Image elements have [alt] attributes", score: 1, scoreDisplayMode: "binary" }
        }
      }
    }));
  }
  // The sites customers ask to have audited.
  const page = PAGES[url.replace(/\/$/, "")];
  if (page !== undefined) {
    net.pageFetches.push({ url, redirect: init && init.redirect });
    if (page === "unreachable") throw new TypeError("fetch failed");
    if (typeof page === "function") return page();
    return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  throw new Error("Unexpected outbound fetch in tests: " + url); // never the real network
};

const PAGES = {
  "https://example.com": "<!doctype html><html lang=en><title>Example</title><h1>Hi</h1></html>",
  "https://down.test": "unreachable",
  "https://missing.test": () => new Response("not here", { status: 404, headers: { "Content-Type": "text/html" } }),
  "https://pdf.test": () => new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }),
  "https://moved.test": () => new Response(null, { status: 301, headers: { Location: "https://example.com/" } }),
  "https://sneaky.test": () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } }),
  "https://loop.test": () => new Response(null, { status: 302, headers: { Location: "https://loop.test/" } })
};

/* ------------------------------------------------------------- harness */

const ORIGIN = "https://speakpower-commits.github.io";
const db = new FakeD1();
db.db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));

const mailbox = [];
const env = {
  DB: db,
  SEND_EMAIL: { async send(m) { mailbox.push(m); } },
  SESSION_SECRET: "test-secret-0123456789abcdef-0123456789abcdef",
  TURNSTILE_SECRET: "turnstile-secret",
  ALLOWED_ORIGINS: ORIGIN,
  MAIL_FROM: "studio@example.com",
  LEAD_NOTIFY_TO: "owner@example.com",
  FREE_TRIALS: "3",
  ENVIRONMENT: "production"
};

let ipCounter = 0;
async function call(method, path, { body, token, origin = ORIGIN, ip, raw } = {}) {
  const pending = [];
  const headers = { "CF-Connecting-IP": ip || "10.0.0." + (++ipCounter % 250) };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request("https://api.test" + path, {
    method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body))
  });
  const res = await worker.fetch(req, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
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

function lastCodeFor(email) {
  const m = mailbox.filter((x) => x.to === email).pop();
  ok(m, "no email sent to " + email);
  return m.subject.match(/(\d{6})$/)[1];
}

async function signUp(email, name = "Test") {
  const start = await call("POST", "/auth/start", { body: { email, name, turnstileToken: "pass" } });
  eq(start.status, 200, "auth/start status");
  const verify = await call("POST", "/auth/verify", { body: { email, code: lastCodeFor(email), anonId: "anon-1" } });
  eq(verify.status, 200, "auth/verify status");
  return verify.data;
}

const BRIEF = {
  brand: "Acme", offer: "Solar kits", audience: "rural schools", problem: "Unreliable power",
  result: "Reliable lessons after dark", proof: "40 installs", difference: "Local installers", ambition: "Every school lit"
};
const SPEAKER = {
  speaker: "A", topic: "Clean energy", audience: "Teachers", time: "20 minutes", goal: "Switch to solar",
  idea1: "Cost", idea2: "Reliability", idea3: "Maintenance", story: "Gulu school"
};

// Stands in for a completed top-up when a test is about spending, not paying.
function setBalance(email, balance) {
  db.db.prepare("UPDATE users SET balance = ?, plan = 'paid' WHERE email_canonical = ?").run(balance, email.toLowerCase());
}
function userId(email) { return userRow(email).id; }

/* ---------------------------------------------------------------- tests */

console.log("\nSpeakPower Studio API\n");

await test("health responds", async () => {
  const r = await call("GET", "/health");
  eq(r.status, 200); eq(r.data.ok, true);
});

await test("CORS: allowed origin echoed, other origins refused", async () => {
  const pre = await call("OPTIONS", "/studio/generate");
  eq(pre.status, 204, "preflight");
  eq(pre.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const bad = await call("GET", "/health", { origin: "https://evil.example" });
  eq(bad.status, 403, "foreign origin");
});

await test("sign-up rejects bad email and failed bot check", async () => {
  eq((await call("POST", "/auth/start", { body: { email: "nope", turnstileToken: "pass" } })).status, 400);
  const r = await call("POST", "/auth/start", { body: { email: "bot@example.com", turnstileToken: "fail" } });
  eq(r.status, 400); eq(r.data.error, "bot_check_failed");
});

let alice;
await test("sign-up → code → verify gives 3 free runs", async () => {
  alice = await signUp("alice@example.com", "Alice");
  ok(alice.token, "token");
  eq(alice.account.trialsRemaining, 3);
  eq(alice.account.freeTrials, 3);
});

await test("immediate resend is throttled", async () => {
  await call("POST", "/auth/start", { body: { email: "bob@example.com", turnstileToken: "pass" } });
  const again = await call("POST", "/auth/start", { body: { email: "bob@example.com", turnstileToken: "pass" } });
  eq(again.status, 429); eq(again.data.error, "slow_down");
});

await test("wrong code rejected; attempts capped at 5", async () => {
  await call("POST", "/auth/start", { body: { email: "carol@example.com", turnstileToken: "pass" } });
  const code = lastCodeFor("carol@example.com");
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    const r = await call("POST", "/auth/verify", { body: { email: "carol@example.com", code: wrong } });
    eq(r.status, 400, "wrong attempt " + (i + 1));
  }
  const late = await call("POST", "/auth/verify", { body: { email: "carol@example.com", code } });
  eq(late.status, 400, "correct code after lockout"); eq(late.data.error, "code_expired");
});

await test("/me requires a valid token; tampered token refused", async () => {
  eq((await call("GET", "/me")).status, 401);
  const tampered = alice.token.slice(0, -2) + (alice.token.endsWith("A") ? "BB" : "AA");
  eq((await call("GET", "/me", { token: tampered })).status, 401);
  const me = await call("GET", "/me", { token: alice.token });
  eq(me.status, 200); eq(me.data.account.email, "alice@example.com");
});

await test("missing field is rejected without spending a run", async () => {
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "brand-story", inputs: { brand: "Acme" } } });
  eq(r.status, 400); eq(r.data.error, "missing_field"); eq(r.data.field, "offer");
  eq(db.one("SELECT trials_remaining AS t FROM users WHERE email = 'alice@example.com'").t, 3);
});

await test("generate brand story spends one free run", async () => {
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "brand-story", inputs: BRIEF } });
  eq(r.status, 200); eq(r.data.sections.length, 9); eq(r.data.paidWith, "trial");
  eq(r.data.account.trialsRemaining, 2);
  ok(r.data.sections[0][1].startsWith("Acme exists to help rural schools"), "core story text");
});

await test("signing in again via a Gmail-style alias never resets trials", async () => {
  const first = await signUp("dee.dee@gmail.com");
  await call("POST", "/studio/generate", { token: first.token, body: { product: "brand-story", inputs: BRIEF } });
  const alias = await signUp("DeeDee+again@gmail.com");
  eq(alias.account.trialsRemaining, 2, "trials after alias sign-in");
  const googlemail = await signUp("Dee.Dee+promo@GoogleMail.com");
  eq(googlemail.account.trialsRemaining, 2, "trials after googlemail alias");
  eq(db.one("SELECT COUNT(*) AS n FROM users WHERE email_canonical = 'deedee@gmail.com'").n, 1, "one account");
});

await test("an audit of a page that cannot be reached is refunded", async () => {
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "seo-audit", inputs: { url: "https://down.test" } } });
  eq(r.status, 502); eq(r.data.error, "generation_failed");
  ok(/could not be reached/.test(r.data.message), "says why");
  ok(/not charged/.test(r.data.message), "message says nothing was charged");
  eq(db.one("SELECT trials_remaining AS t FROM users WHERE email = 'alice@example.com'").t, 2);
  eq(db.one("SELECT status FROM runs WHERE product = 'seo-audit' ORDER BY id DESC").status, "refunded");
});

await test("SEO audit refuses anything but a public website, before spending or fetching", async () => {
  const fetchesBefore = net.pageFetches.length;
  for (const bad of [
    "", "javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "data:text/html,hi",
    "http://localhost", "http://localhost.:80", "https://LOCALHOST./admin", "http://printer.local", "http://db.internal",
    "http://router.home.arpa", "http://metadata.google.internal", "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1", "http://2130706433", "http://0x7f.1", "http://10.0.0.5", "http://192.168.1.1",
    "http://172.16.0.1", "http://8.8.8.8", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fd00::1]",
    "https://example.com:8443", "https://user:pass@example.com", "intranet", "https://" + "a".repeat(2100) + ".com"
  ]) {
    const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "seo-audit", inputs: { url: bad } } });
    eq(r.status, 400, "status for " + JSON.stringify(bad.slice(0, 60)));
    eq(r.data.error, "invalid_url"); eq(r.data.field, "url");
  }
  eq(net.pageFetches.length, fetchesBefore, "nothing was fetched");
  eq(userRow("alice@example.com").trials_remaining, 2, "nothing was spent");
});

await test("SEO audit without a Google key: delivered, no doomed Google call, and it says so", async () => {
  net.pagespeedCalls.length = 0;
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "seo-audit", inputs: { url: "example.com" } } });
  eq(r.status, 200);
  eq(net.pagespeedCalls.length, 0, "no keyless call into Google's exhausted shared quota");
  eq(net.pageFetches[net.pageFetches.length - 1].url, "https://example.com/", "a bare domain is audited over https");
  const g = r.data.sections.find((x) => x[0] === "Google Lighthouse scores");
  ok(g && /not switched on/.test(g[1]), "explains the missing scores");
  ok(r.data.sections.some((x) => x[0] === "Summary"), "SpeakPower checks delivered");
  eq(r.data.account.trialsRemaining, 1);
});

await test("data story works from summary statistics only", async () => {
  const r = await call("POST", "/studio/generate", {
    token: alice.token,
    body: {
      product: "data-story",
      inputs: { summary: {
        rows: 120, columns: 3,
        numeric: [{ name: "revenue", mean: 1500.5, min: 10, max: 9000 }],
        categorical: [
          { name: "region", distinct: 2, top: [["Kampala", 70], ["Gulu", 50]] },
          { name: "customer_email", distinct: 120, top: [] }
        ],
        missing: [{ name: "revenue", ratio: 0.1 }]
      } }
    }
  });
  eq(r.status, 200); eq(r.data.account.trialsRemaining, 0);
  const story = r.data.sections.find((s) => s[0] === "Plain-language data story");
  ok(story && /120 observations/.test(story[1]), "story");
  ok(/include region\./.test(story[1]), "only real categories used as segments");
  const cats = r.data.sections.find((s) => s[0] === "Category patterns")[1];
  ok(/customer_email: 120 distinct values/.test(cats), "unique column reported as a count");
});

await test("three free tries were shared across three services; the fourth use asks for payment", async () => {
  // Alice used brand-story, seo-audit and data-story once each (the failed
  // audit was given back), so any fourth use — of any service — is paid.
  const used = db.q("SELECT product FROM runs WHERE user_id = ? AND status = 'ok' ORDER BY id", userId("alice@example.com"))
    .map((r) => r.product).join(",");
  eq(used, "brand-story,seo-audit,data-story", "one free try on each of three services");
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "brand-story", inputs: BRIEF } });
  eq(r.status, 402); eq(r.data.error, "payment_required");
  eq(r.data.service, "brand-story"); eq(r.data.title, "Brand Story Builder");
  eq(r.data.price, 100000, "price"); eq(r.data.balance, 0, "balance"); eq(r.data.shortfall, 100000, "shortfall");
  ok(/UGX 100,000/.test(r.data.message), "message names the price in shillings");
  eq(r.data.account.trialsRemaining, 0);
  eq(db.one("SELECT COUNT(*) AS n FROM events WHERE name = 'payment_required'").n, 1);
  eq(db.one("SELECT COUNT(*) AS n FROM runs WHERE user_id = ?", userId("alice@example.com")).n, 4, "no run recorded for the refusal");
});

await test("the balance pays once free tries are gone: the exact price, then a shortfall", async () => {
  setBalance("alice@example.com", 80000);
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "speaker-ready", inputs: SPEAKER } });
  eq(r.status, 200); eq(r.data.paidWith, "balance"); eq(r.data.amount, 75000);
  eq(r.data.account.balance, 5000, "80,000 − 75,000");
  const short = await call("POST", "/studio/generate", { token: alice.token, body: { product: "brand-story", inputs: BRIEF } });
  eq(short.status, 402); eq(short.data.balance, 5000); eq(short.data.shortfall, 95000);
  eq(userRow("alice@example.com").balance, 5000, "a refusal takes nothing");
});

await test("parallel requests can never spend the same run", async () => {
  const eve = await signUp("eve@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 1 WHERE email_canonical = ?").run("eve@example.com");
  const results = await Promise.all([1, 2, 3, 4].map(() =>
    call("POST", "/studio/generate", { token: eve.token, body: { product: "brand-story", inputs: BRIEF } })));
  eq(results.filter((r) => r.status === 200).length, 1, "successes");
  eq(results.filter((r) => r.status === 402).length, 3, "402s");
  eq(db.one("SELECT trials_remaining AS t FROM users WHERE email_canonical = 'eve@example.com'").t, 0);
});

await test("parallel paid requests can never overdraw the balance", async () => {
  const s = await signUp("eve.paid@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 250000 WHERE email_canonical = ?").run("eve.paid@example.com");
  // 250,000 covers two Brand Stories (100,000 each) and not a third.
  const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
    call("POST", "/studio/generate", { token: s.token, body: { product: "brand-story", inputs: BRIEF } })));
  eq(results.filter((r) => r.status === 200).length, 2, "successes");
  eq(results.filter((r) => r.status === 402).length, 3, "402s");
  eq(userRow("eve.paid@example.com").balance, 50000, "exactly two prices taken");
});

await test("bumping session_version signs a user out everywhere", async () => {
  const fay = await signUp("fay@example.com");
  db.db.prepare("UPDATE users SET session_version = session_version + 1 WHERE email_canonical = ?").run("fay@example.com");
  eq((await call("GET", "/me", { token: fay.token })).status, 401);
});

await test("lead: validation, honeypot and stored enquiry with alert", async () => {
  eq((await call("POST", "/lead", { body: { name: "X" } })).status, 400);
  const before = db.one("SELECT COUNT(*) AS n FROM leads").n;
  const bot = await call("POST", "/lead", { body: { name: "Bot", email: "b@x.com", service: "SEO", message: "hi", website: "spam.example" } });
  eq(bot.status, 200); eq(db.one("SELECT COUNT(*) AS n FROM leads").n, before, "honeypot not stored");
  const sentBefore = mailbox.length;
  const r = await call("POST", "/lead", { body: {
    name: "Grace", organization: "UBF", email: "grace@example.org", service: "Market development & SEO", message: "Need a plan", anonId: "anon-9"
  } });
  eq(r.status, 200);
  eq(db.one("SELECT name FROM leads ORDER BY id DESC").name, "Grace");
  eq(mailbox.length, sentBefore + 1, "notification sent");
  eq(mailbox[mailbox.length - 1].to, env.LEAD_NOTIFY_TO);
});

await test("events: allow-listed client events stored; server-only names ignored", async () => {
  const count = () => db.one("SELECT COUNT(*) AS n FROM events").n;
  const before = count();
  eq((await call("POST", "/event", { body: JSON.stringify({ name: "audit_run", page: "/SpeakPower/audit.html", anonId: "anon-1" }), raw: true })).status, 204);
  eq(count(), before + 1, "audit_run stored");
  await call("POST", "/event", { body: JSON.stringify({ name: "studio_generate", anonId: "anon-1" }), raw: true });
  await call("POST", "/event", { body: JSON.stringify({ name: "drop table", anonId: "anon-1" }), raw: true });
  eq(count(), before + 1, "forged/unknown events ignored");
});

await test("oversized and malformed bodies are refused", async () => {
  eq((await call("POST", "/auth/start", { body: "{not json", raw: true })).status, 400);
  eq((await call("POST", "/event", { body: "x".repeat(5000), raw: true })).status, 413);
});

await test("unconfigured production service fails closed", async () => {
  const saved = env.TURNSTILE_SECRET;
  delete env.TURNSTILE_SECRET;
  const r = await call("POST", "/auth/start", { body: { email: "zed@example.com", turnstileToken: "pass" } });
  env.TURNSTILE_SECRET = saved;
  eq(r.status, 500); eq(r.data.error, "config_error");
});

await test("scheduled housekeeping runs", async () => {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
});

/* --------------------------------------------------------------- GRIOT */

function userRow(email) {
  return db.db.prepare("SELECT * FROM users WHERE email_canonical = ?").get(email.toLowerCase());
}
function griotRuns(email) {
  return db.db.prepare("SELECT * FROM runs WHERE user_id = ? AND product = 'griot' ORDER BY id")
    .all(userRow(email).id);
}
function chat(token, message, extra) {
  return call("POST", "/griot/chat", { token, body: Object.assign({ message }, extra || {}) });
}

await test("griot: unconfigured deployment refuses before spending", async () => {
  const s = await signUp("g-unset@example.com");
  griotCalls.length = 0;
  const r = await chat(s.token, "hello");
  eq(r.status, 503, "status"); eq(r.data.error, "griot_unconfigured");
  eq(userRow("g-unset@example.com").trials_remaining, 3, "no trial spent");
  eq(griotCalls.length, 0, "GRIOT never called");
});

// Everything below runs against a configured deployment.
env.GRIOT_API_BASE = "https://griot.test/";
env.GRIOT_API_KEY = "griot-server-key";

await test("griot: a GRIOT without tenancy is never sent a client message, and nothing is charged", async () => {
  const s = await signUp("g-oldgriot@example.com");
  env.GRIOT_API_BASE = "https://griot-old.test";
  const r = await chat(s.token, "this must not reach a shared memory pool");
  env.GRIOT_API_BASE = "https://griot.test/";
  eq(r.status, 503, "status"); eq(r.data.error, "griot_not_ready");
  eq(griotOldChats, 0, "old GRIOT never received the message");
  eq(userRow("g-oldgriot@example.com").trials_remaining, 3, "no trial spent");
});

await test("griot: the tenancy check is cached, not repeated on every message", async () => {
  const s = await signUp("g-healthcache@example.com");
  await chat(s.token, "one");
  const after = griotHealthChecks;
  await chat(s.token, "two");
  await chat(s.token, "three");
  eq(griotHealthChecks, after, "no extra /health calls");
});

await test("griot: signed-out caller is refused", async () => {
  const r = await chat(null, "hello");
  eq(r.status, 401); eq(r.data.error, "signed_out");
});

await test("griot: empty message rejected without spending", async () => {
  const s = await signUp("g-empty@example.com");
  const r = await chat(s.token, "   ");
  eq(r.status, 400); eq(r.data.error, "message_required");
  eq(userRow("g-empty@example.com").trials_remaining, 3);
});

await test("griot: sign up, then exactly three free messages", async () => {
  const s = await signUp("g-three@example.com");
  griotCalls.length = 0;
  for (const left of [2, 1, 0]) {
    const r = await chat(s.token, "Where should Q4 go?");
    eq(r.status, 200, "status with " + left + " left");
    eq(r.data.answer, "FACT: you said X. INFERENCE: therefore Y.");
    eq(r.data.paidWith, "trial");
    eq(r.data.account.trialsRemaining, left, "trials remaining");
  }
  eq(griotCalls.length, 3, "three upstream calls");
});

await test("griot: fourth message returns 402 with the per-message price, GRIOT not called", async () => {
  const s = await call("POST", "/auth/start", { body: { email: "g-three@example.com", turnstileToken: "pass" } });
  eq(s.status, 200);
  const v = await call("POST", "/auth/verify", { body: { email: "g-three@example.com", code: lastCodeFor("g-three@example.com") } });
  griotCalls.length = 0;
  const r = await chat(v.data.token, "one more");
  eq(r.status, 402, "status"); eq(r.data.error, "payment_required");
  eq(r.data.service, "griot"); eq(r.data.price, 2500); eq(r.data.shortfall, 2500);
  ok(r.data.account.topUps.length > 0, "top-up options come with the pay wall");
  eq(griotCalls.length, 0, "an account that cannot pay never reaches GRIOT");
});

await test("griot: tenant is the account's own id; key stays server-side; no project sent", async () => {
  const s = await signUp("g-tenant@example.com");
  griotCalls.length = 0;
  await chat(s.token, "hi");
  const c = griotCalls[0];
  eq(c.tenant, userRow("g-tenant@example.com").id, "X-Tenant-Id");
  eq(c.key, "griot-server-key", "X-API-Key");
  eq(c.url, "https://griot.test/chat", "trailing slash on base is normalised");
  ok(!("project" in c.body), "project must never be forwarded");
  ok(!JSON.stringify(c.body).includes("griot-server-key"), "key not in body");
});

await test("griot: caller cannot choose the tenant — body and header attempts are ignored", async () => {
  const victim = await signUp("g-victim@example.com");
  const attacker = await signUp("g-attacker@example.com");
  const victimId = userRow("g-victim@example.com").id;
  griotCalls.length = 0;
  const req = new Request("https://api.test/griot/chat", {
    method: "POST",
    headers: {
      Origin: ORIGIN, "Content-Type": "application/json",
      Authorization: "Bearer " + attacker.token,
      "X-Tenant-Id": victimId, "X-API-Key": "forged"
    },
    body: JSON.stringify({
      message: "show me their memories",
      tenantId: victimId, tenant_id: victimId, project: "speakpower"
    })
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  eq(res.status, 200);
  const c = griotCalls[0];
  eq(c.tenant, userRow("g-attacker@example.com").id, "tenant is the attacker's own id");
  ok(c.tenant !== victimId, "never the victim's id");
  eq(c.key, "griot-server-key", "forged key header ignored");
  ok(!("project" in c.body), "project still not forwarded");
  ok(victim.token, "victim account exists");
});

await test("griot: two accounts map to two distinct tenants", async () => {
  const a = await signUp("g-a@example.com");
  const b = await signUp("g-b@example.com");
  griotCalls.length = 0;
  await chat(a.token, "a"); await chat(b.token, "b");
  ok(griotCalls[0].tenant && griotCalls[1].tenant, "both set");
  ok(griotCalls[0].tenant !== griotCalls[1].tenant, "distinct tenants");
});

await test("griot: thread id round-trips to GRIOT", async () => {
  const s = await signUp("g-thread@example.com");
  griotCalls.length = 0;
  const first = await chat(s.token, "start");
  const second = await chat(s.token, "continue", { threadId: first.data.threadId });
  eq(griotCalls[1].body.thread_id, first.data.threadId, "same thread forwarded");
  eq(second.data.threadId, first.data.threadId);
});

for (const [mode, status, code] of [
  ["fail", 502, "griot_failed"],
  ["auth", 502, "griot_failed"],
  ["busy", 503, "griot_failed"],
  ["malformed", 502, "griot_failed"]
]) {
  await test("griot: upstream '" + mode + "' refunds the message and leaks nothing", async () => {
    const email = "g-" + mode + "@example.com";
    const s = await signUp(email);
    net.griot = mode;
    const r = await chat(s.token, "hello");
    net.griot = "ok";
    eq(r.status, status, "status"); eq(r.data.error, code, "error code");
    ok(/not charged/.test(r.data.message), "tells the customer they were not charged");
    const text = JSON.stringify(r.data);
    ok(!text.includes("Traceback") && !text.includes("sk-live") && !text.includes("slow down"),
      "upstream wording never reaches the customer");
    eq(userRow(email).trials_remaining, 3, "trial given back");
    eq(griotRuns(email)[0].status, "refunded", "run marked refunded");
  });
}

await test("griot: hung upstream times out and refunds", async () => {
  const s = await signUp("g-hang@example.com");
  env.GRIOT_TIMEOUT_MS = "5000";
  net.griot = "hang";
  const t0 = Date.now();
  const r = await chat(s.token, "hello");
  net.griot = "ok"; delete env.GRIOT_TIMEOUT_MS;
  eq(r.status, 504, "status");
  ok(Date.now() - t0 < 9000, "bounded by the timeout");
  eq(userRow("g-hang@example.com").trials_remaining, 3, "trial given back");
});

await test("griot: the balance pays per message once free messages run out", async () => {
  const s = await signUp("g-paid@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 5000 WHERE email_canonical = ?")
    .run("g-paid@example.com");
  const r = await chat(s.token, "paid question");
  eq(r.status, 200); eq(r.data.paidWith, "balance"); eq(r.data.amount, 2500);
  eq(r.data.account.balance, 2500); eq(r.data.account.trialsRemaining, 0);
});

await test("griot: a paid message that fails gives back exactly its price", async () => {
  const s = await signUp("g-paidfail@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 7000 WHERE email_canonical = ?")
    .run("g-paidfail@example.com");
  net.griot = "fail";
  const r = await chat(s.token, "hello");
  net.griot = "ok";
  eq(r.status, 502); ok(/not charged/.test(r.data.message));
  eq(userRow("g-paidfail@example.com").balance, 7000, "every shilling back");
  eq(userRow("g-paidfail@example.com").trials_remaining, 0, "and no free try invented");
  const run = griotRuns("g-paidfail@example.com")[0];
  eq(run.paid_with, "balance"); eq(run.amount, 2500); eq(run.status, "refunded");
});

await test("griot: top-up options ride on every account response, not only the 402", async () => {
  // The last free message succeeds (200), so the page must learn how to top
  // up from that response — and from /me after a reload — or the pay wall
  // shows with no way to pay at the moment of highest intent.
  const s = await signUp("g-checkout@example.com");
  const offer = (a) => JSON.stringify({ topUps: a.topUps, canTopUp: a.canTopUp, currency: a.currency });
  const expected = JSON.stringify({ topUps: [50000, 100000, 250000], canTopUp: false, currency: "UGX" });
  eq(offer(s.account), expected, "on sign-in");
  const me = await call("GET", "/me", { token: s.token });
  eq(offer(me.data.account), expected, "on /me");
  db.db.prepare("UPDATE users SET trials_remaining = 1 WHERE email_canonical = ?").run("g-checkout@example.com");
  const last = await chat(s.token, "my last free one");
  eq(last.status, 200);
  eq(last.data.account.trialsRemaining, 0);
  eq(offer(last.data.account), expected, "on the final successful message");
});

await test("griot: parallel sends can never overspend the last message", async () => {
  const s = await signUp("g-race@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 1, balance = 0 WHERE email_canonical = ?")
    .run("g-race@example.com");
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => chat(s.token, "race " + i)));
  eq(results.filter((r) => r.status === 200).length, 1, "exactly one succeeds");
  eq(results.filter((r) => r.status === 402).length, 4, "the rest are told to top up");
  eq(userRow("g-race@example.com").trials_remaining, 0, "never negative");
});

await test("griot: parallel paid sends take at most what the balance holds", async () => {
  const s = await signUp("g-race-paid@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 6000 WHERE email_canonical = ?")
    .run("g-race-paid@example.com");
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => chat(s.token, "race " + i)));
  eq(results.filter((r) => r.status === 200).length, 2, "6,000 covers two 2,500 messages");
  eq(userRow("g-race-paid@example.com").balance, 1000, "never below zero");
});

/* ------------------------------------------------------- Google sign-in */

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const googleKeys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
const forgerKeys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
const realJwk = await crypto.subtle.exportKey("jwk", googleKeys.publicKey);
googleJwks.keys.push(Object.assign(realJwk, { kid: "google-kid-1", alg: "RS256", use: "sig" }));

const CLIENT_ID = "1234-speakpower.apps.googleusercontent.com";
const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function googleToken(over, { key = googleKeys.privateKey, header } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({
    iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-" + Math.random(),
    email: "griot.user@gmail.com", email_verified: true, name: "Grace Akello",
    iat: now, exp: now + 3600
  }, over || {});
  const head = b64u(header || { alg: "RS256", kid: "google-kid-1", typ: "JWT" });
  const body = b64u(claims);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body)));
  return head + "." + body + "." + Buffer.from(sig).toString("base64url");
}
const google = (credential) => call("POST", "/auth/google", { body: { credential, anonId: "anon-g" } });

await test("google: unconfigured deployment refuses", async () => {
  const r = await google(await googleToken());
  eq(r.status, 500); eq(r.data.error, "config_error");
});

env.GOOGLE_CLIENT_ID = CLIENT_ID;

await test("google: valid token signs up with exactly the free messages, verified", async () => {
  const r = await google(await googleToken({ email: "new.person@gmail.com" }));
  eq(r.status, 200, "status");
  ok(r.data.token, "session issued");
  eq(r.data.account.trialsRemaining, 3, "free messages");
  const row = userRow("newperson@gmail.com");
  eq(row.verified, 1, "verified without any email being sent");
  eq(row.name, "Grace Akello", "name taken from Google");
});

await test("google: the session it issues works for GRIOT end to end", async () => {
  const r = await google(await googleToken({ email: "end2end@example.org" }));
  griotCalls.length = 0;
  const c = await chat(r.data.token, "First question");
  eq(c.status, 200); eq(c.data.account.trialsRemaining, 2);
  eq(griotCalls[0].tenant, userRow("end2end@example.org").id, "tenant is this account");
});

for (const [label, over, opts] of [
  ["audience minted for another site", { aud: "someone-else.apps.googleusercontent.com" }],
  ["wrong issuer", { iss: "https://evil.example" }],
  ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ["issued in the future", { iat: Math.floor(Date.now() / 1000) + 3600 }],
  ["email not verified by Google", { email_verified: false }],
  ["signed by a key that is not Google's", {}, { key: forgerKeys.privateKey }],
  ["alg: none", {}, { header: { alg: "none", kid: "google-kid-1" } }],
  ["HS256 key-confusion attempt", {}, { header: { alg: "HS256", kid: "google-kid-1" } }],
  ["unknown key id", {}, { header: { alg: "RS256", kid: "not-a-google-kid" } }]
]) {
  await test("google: rejects " + label, async () => {
    const before = db.db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    const r = await google(await googleToken(over, opts || {}));
    eq(r.status, 401, "status"); eq(r.data.error, "google_rejected");
    eq(db.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, before, "no account created");
  });
}

await test("google: a token edited after signing is rejected", async () => {
  const good = await googleToken({ email: "honest@gmail.com" });
  const [h, , s] = good.split(".");
  const forged = h + "." + b64u({
    iss: "https://accounts.google.com", aud: CLIENT_ID, email: "victim@gmail.com",
    email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600
  }) + "." + s;
  const r = await google(forged);
  eq(r.status, 401); ok(!userRow("victim@gmail.com"), "victim account never touched");
});

await test("google: malformed credentials are refused, not crashed on", async () => {
  for (const junk of ["", "abc", "a.b", "a.b.c.d", "!!!.###.$$$"]) {
    const r = await google(junk);
    ok(r.status === 400 || r.status === 401, "status for " + JSON.stringify(junk) + " was " + r.status);
  }
});

await test("google: signing in never resets used messages — not even via a Gmail alias", async () => {
  const first = await google(await googleToken({ email: "repeat.user@gmail.com" }));
  await chat(first.data.token, "one"); await chat(first.data.token, "two");
  eq(userRow("repeatuser@gmail.com").trials_remaining, 1, "two spent");
  const again = await google(await googleToken({ email: "Repeat.User+griot@gmail.com" }));
  eq(again.status, 200);
  eq(again.data.account.trialsRemaining, 1, "same account, still 1 left");
});

await test("google: an email-code account and a Google sign-in are the same account", async () => {
  const viaEmail = await signUp("both.ways@gmail.com");
  await chat(viaEmail.token, "via email");
  const viaGoogle = await google(await googleToken({ email: "bothways@gmail.com" }));
  eq(viaGoogle.data.account.trialsRemaining, 2, "shared balance");
  griotCalls.length = 0;
  await chat(viaGoogle.data.token, "via google");
  // Gmail ignores dots, so the canonical row is stored without them.
  eq(griotCalls[0].tenant, userRow("bothways@gmail.com").id, "same tenant, so same GRIOT memory");
});

await test("google: certificates are cached, refetched only for an unseen key", async () => {
  const before = net.googleCertFetches;
  await google(await googleToken({ email: "cache-a@gmail.com" }));
  await google(await googleToken({ email: "cache-b@gmail.com" }));
  eq(net.googleCertFetches, before, "no refetch for a known key");
  await google(await googleToken({}, { header: { alg: "RS256", kid: "rotated-kid" } }));
  eq(net.googleCertFetches, before + 1, "one refetch for an unseen key");
});

/* --------------------------------------------- one price list, everywhere */

const STUDIO_HTML = readFileSync(join(here, "..", "..", "studio.html"), "utf8");
// The price printed on a product's card in studio.html.
function cardPrice(key) {
  const card = STUDIO_HTML.match(new RegExp('<article[^>]*id="product-' + key + '"[^>]*>([\\s\\S]*?)</article>'));
  ok(card, "studio.html has a card for " + key);
  const price = card[1].match(/<div class="studio-price">([\s\S]*?)<\/div>/);
  ok(price, "the " + key + " card shows a price");
  return price[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
const ugx = (n) => "UGX " + n.toLocaleString("en-US");

let PRICES;
await test("prices: the Worker charges exactly what studio.html shows, for every service", async () => {
  const s = await signUp("p-list@example.com");
  const r = await call("GET", "/account", { token: s.token });
  eq(r.status, 200);
  PRICES = r.data.prices;
  const keys = Object.keys(PRICES).sort().join(",");
  eq(keys, "brand-story,content-seo,data-story,griot,market-plan,seo-audit,speaker-ready", "every service priced");
  for (const [key, amount] of Object.entries(PRICES)) {
    ok(Number.isInteger(amount) && amount > 0, key + " has a whole-shilling price");
    ok(cardPrice(key).startsWith(ugx(amount)),
      key + ": studio.html shows " + JSON.stringify(cardPrice(key)) + " but the Worker charges " + ugx(amount));
  }
  // Every catalog card is priced by the Worker — no card can sell something
  // the Worker would refuse, or give away something it would charge for.
  const cards = [...STUDIO_HTML.matchAll(/id="product-([a-z-]+)"/g)].map((m) => m[1]).sort().join(",");
  eq(cards, keys, "catalog cards and price list name the same services");
});

await test("prices: the builder page, the GRIOT app and the GRIOT pages quote the same prices", async () => {
  const site = (f) => readFileSync(join(here, "..", "..", f), "utf8");
  const builder = site("studio-product.js");
  for (const [key, amount] of Object.entries(PRICES)) {
    if (key === "griot") continue;
    const m = builder.match(new RegExp('"' + key + '": \\{\\s*title: "[^"]+",\\s*price: (\\d+)'));
    ok(m, "studio-product.js prices " + key);
    eq(Number(m[1]), amount, "studio-product.js price for " + key);
  }
  eq(Number(site("griot-app.js").match(/var PRICE = (\d+);/)[1]), PRICES.griot, "griot-app.js message price");
  for (const page of ["griot-app.html", "studio-griot.html"]) {
    const quoted = [...site(page).matchAll(/UGX ([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
    ok(quoted.length > 0, page + " states the price");
    ok(quoted.every((n) => n === PRICES.griot), page + " quotes " + quoted.join(", "));
  }
});

// Valid inputs for every service, so each one can be run for real.
const INPUTS = {
  "brand-story": BRIEF,
  "seo-audit": { url: "https://example.com" },
  "market-plan": {
    business: "Acme", offer: "Solar kits", audience: "Rural schools", geography: "Northern Uganda",
    problem: "Unreliable power", advantage: "Local installers", competitors: "Generators", channels: "Radio", goal: "40 schools"
  },
  "content-seo": {
    business: "Acme", offer: "Solar kits", audience: "Head teachers", location: "Gulu",
    topic1: "Cost of solar", topic2: "Battery life", topic3: "Grants", proof: "40 installs"
  },
  "data-story": { summary: { rows: 10, columns: 1, numeric: [{ name: "kwh", mean: 4, min: 1, max: 9 }], categorical: [], missing: [] } },
  "speaker-ready": SPEAKER
};
async function use(token, service, inputs) {
  return service === "griot"
    ? chat(token, "a paid question")
    : call("POST", "/studio/generate", { token, body: { product: service, inputs: inputs || INPUTS[service] } });
}

await test("prices: each paid use deducts exactly that service's price — no more, no less", async () => {
  const s = await signUp("p-each@example.com");
  const total = Object.values(PRICES).reduce((a, b) => a + b, 0);
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = ? WHERE email_canonical = ?").run(total, "p-each@example.com");
  let expected = total;
  for (const [service, price] of Object.entries(PRICES)) {
    const r = await use(s.token, service);
    eq(r.status, 200, service + " status");
    eq(r.data.paidWith, "balance", service + " paid from the balance");
    eq(r.data.amount, price, service + " amount");
    expected -= price;
    eq(r.data.account.balance, expected, service + " balance in the response");
    eq(userRow("p-each@example.com").balance, expected, service + " balance stored");
  }
  eq(expected, 0, "the exact total of every price, spent to the shilling");
});

await test("prices: a failed paid use gives back exactly that service's price", async () => {
  const s = await signUp("p-refund@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 300000 WHERE email_canonical = ?").run("p-refund@example.com");
  const failedAudit = await use(s.token, "seo-audit", { url: "https://down.test" });
  net.griot = "fail";
  const msg = await use(s.token, "griot");
  net.griot = "ok";
  eq(failedAudit.status, 502); eq(msg.status, 502);
  eq(userRow("p-refund@example.com").balance, 300000, "both refunded in full");
  const runs = db.q("SELECT product, amount, status FROM runs WHERE user_id = ? ORDER BY id", userId("p-refund@example.com"));
  eq(JSON.stringify(runs), JSON.stringify([
    { product: "seo-audit", amount: 75000, status: "refunded" },
    { product: "griot", amount: 2500, status: "refunded" }
  ]));
});

await test("prices: three free tries in any mix of services, then the balance", async () => {
  const s = await signUp("p-mix@example.com");
  const free = [];
  for (const service of ["griot", "market-plan", "seo-audit"]) {
    const r = await use(s.token, service);
    eq(r.status, 200, service);
    eq(r.data.paidWith, "trial", service + " is free"); eq(r.data.amount, 0);
    free.push(r.data.account.trialsRemaining);
  }
  eq(free.join(","), "2,1,0", "one shared allowance, counting down");
  const fourth = await use(s.token, "griot");
  eq(fourth.status, 402, "fourth use, even of the cheapest service");
  eq(fourth.data.price, 2500); eq(fourth.data.shortfall, 2500);
});

/* ------------------------------------- SEO audit: the Google layer, keyed */

async function audit(token, url = "https://example.com") {
  return call("POST", "/studio/generate", { token, body: { product: "seo-audit", inputs: { url } } });
}
const lighthouseSection = (r) => r.data.sections.find((x) => /^Google Lighthouse/.test(x[0]));

await test("seo: with a key, Lighthouse scores and findings are added, key sent server-side only", async () => {
  const s = await signUp("seo-key@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeedCalls.length = 0;
  const r = await audit(s.token);
  eq(r.status, 200);
  const call0 = new URL(net.pagespeedCalls[0]);
  eq(call0.searchParams.get("key"), "psi-test-key"); eq(call0.searchParams.get("strategy"), "mobile");
  eq(call0.searchParams.get("url"), "https://example.com/");
  eq(call0.searchParams.getAll("category").join(","), "seo,performance,accessibility,best-practices");
  const g = lighthouseSection(r);
  eq(g[0], "Google Lighthouse scores (mobile)");
  ok(/^Seo: 82 \/ 100$/m.test(g[1]) && /^Performance: 50 \/ 100$/m.test(g[1]), "scores");
  const f = r.data.sections.find((x) => x[0] === "Lighthouse findings");
  ok(f && /meta description/.test(f[1]), "failed audits listed");
  ok(!/Image elements have/.test(f[1]), "passed audits left out");
  ok(!JSON.stringify(r.data).includes("psi-test-key"), "key never reaches the customer");
});

for (const [mode, expect] of [
  ["badkey", /on our side/],
  ["quota", /quota is used up/],
  ["fail", /could not load the page/]
]) {
  await test("seo: Google " + mode + " still delivers the full SpeakPower report, and is charged", async () => {
    const email = "seo-" + mode + "@example.com";
    const s = await signUp(email);
    net.pagespeed = mode;
    const r = await audit(s.token);
    net.pagespeed = "ok";
    eq(r.status, 200, "delivered");
    ok(expect.test(lighthouseSection(r)[1]), "explains: " + lighthouseSection(r)[1]);
    ok(!/Lighthouse findings/.test(JSON.stringify(r.data.sections)), "no invented scores");
    eq(r.data.paidWith, "trial", "a delivered report is a used try");
    if (mode === "badkey") ok(!/your (site|page)/i.test(lighthouseSection(r)[1]), "our fault is never blamed on their page");
  });
}

for (const [url, expect] of [
  ["https://missing.test", /HTTP 404/],
  ["https://pdf.test", /not a web page \(application\/pdf\)/],
  ["https://sneaky.test", /redirects somewhere that cannot be audited/],
  ["https://loop.test", /redirects too many times/]
]) {
  await test("seo: " + url.slice(8) + " is refunded with a reason the customer can act on", async () => {
    const email = "seo-" + url.slice(8, -5) + "@example.com";
    const s = await signUp(email);
    const r = await audit(s.token, url);
    eq(r.status, 502); eq(r.data.error, "generation_failed");
    ok(expect.test(r.data.message), r.data.message);
    ok(/not charged/.test(r.data.message));
    eq(userRow(email).trials_remaining, 3, "try given back");
  });
}

await test("seo: redirects are followed by hand, and every hop is checked", async () => {
  const s = await signUp("seo-moved@example.com");
  net.pageFetches.length = 0;
  const r = await audit(s.token, "https://moved.test");
  eq(r.status, 200);
  eq(net.pageFetches.map((x) => x.url + " " + x.redirect).join(" | "),
    "https://moved.test/ manual | https://example.com/ manual", "never redirect: follow");
  ok(/Redirected from https:\/\/moved\.test\//.test(r.data.sections[0][1]), "the report says it was redirected");
  delete env.PAGESPEED_KEY;
});

/* ---------------------------------------------- top-ups (Flutterwave) */

// Flutterwave's servers call the webhook directly: no Origin, a verif-hash.
async function webhook(payload, hash = "flw-hash-secret") {
  const headers = { "Content-Type": "application/json" };
  if (hash !== null) headers["verif-hash"] = hash;
  const res = await worker.fetch(new Request("https://api.test/webhooks/flutterwave", {
    method: "POST", headers, body: JSON.stringify(payload)
  }), env, { waitUntil() {} });
  return { status: res.status, text: await res.text() };
}
function payment(txRef) { return db.db.prepare("SELECT * FROM payments WHERE tx_ref = ?").get(txRef); }
let flwId = 9000000;
// Flutterwave records a charge against a top-up, the way a real payment would.
function pay(txRef, over) {
  const id = String(++flwId);
  flw.transactions[id] = Object.assign({ id: Number(id), tx_ref: txRef, status: "successful", amount: 50000, currency: "UGX" }, over || {});
  return id;
}
const charge = (id, txRef) => ({ event: "charge.completed", data: { id: Number(id), tx_ref: txRef, status: "successful" } });
function checkout(token, amount = 50000, returnTo) {
  return call("POST", "/wallet/checkout", { token, body: { amount, returnTo } });
}
function confirm(token, txRef, transactionId) {
  return call("POST", "/wallet/confirm", { token, body: { txRef, transactionId } });
}
// Checkout, pay and settle through the webhook: a completed top-up.
async function topUp(token, amount) {
  const c = await checkout(token, amount);
  eq(c.status, 200, "checkout for " + amount);
  const id = pay(c.data.txRef, { amount });
  eq((await webhook(charge(id, c.data.txRef))).status, 200);
  return { txRef: c.data.txRef, id };
}

await test("topup: not switched on → 503, and the account says so", async () => {
  const s = await signUp("t-off@example.com");
  eq(s.account.canTopUp, false, "no top-up offered");
  const r = await checkout(s.token);
  eq(r.status, 503); eq(r.data.error, "checkout_unconfigured");
  eq(flw.checkouts.length, 0, "Flutterwave never called");
});

env.FLW_SECRET_KEY = "FLWSECK_TEST-secret";
env.FLW_SECRET_HASH = "flw-hash-secret";

await test("topup: account offers top-ups once configured; amounts are settable and sanitised", async () => {
  const s = await signUp("t-pack@example.com");
  eq(s.account.canTopUp, true);
  eq(JSON.stringify(s.account.topUps), "[50000,100000,250000]", "defaults");
  env.TOPUP_AMOUNTS = " 20000, 75000 ,lots, 999, 9000000";
  const me = await call("GET", "/me", { token: s.token });
  delete env.TOPUP_AMOUNTS;
  eq(JSON.stringify(me.data.account.topUps), "[20000,75000]", "junk, too-small and too-large dropped");
});

await test("topup: signed-out checkout refused", async () => {
  eq((await checkout(null)).status, 401);
});

await test("topup: amounts outside the limits, or not whole shillings, are refused before anything is recorded", async () => {
  const s = await signUp("t-amount@example.com");
  const before = db.one("SELECT COUNT(*) AS n FROM payments").n;
  flw.checkouts.length = 0;
  for (const bad of [0, -50000, 999, 5000001, 1500.5, "lots", null, [50000], { amount: 50000 }]) {
    const r = await checkout(s.token, bad);
    eq(r.status, 400, "status for " + JSON.stringify(bad)); eq(r.data.error, "invalid_amount");
  }
  eq(db.one("SELECT COUNT(*) AS n FROM payments").n, before, "no payment rows");
  eq(flw.checkouts.length, 0, "Flutterwave never asked");
});

await test("topup: checkout records the payment first, then opens Flutterwave for that amount", async () => {
  const s = await signUp("t-buy@example.com");
  flw.checkouts.length = 0;
  const r = await checkout(s.token, 75000);
  eq(r.status, 200, "status");
  ok(r.data.link.startsWith("https://checkout.flutterwave.com/"), "hosted link returned");
  eq(r.data.amount, 75000);
  const p = payment(r.data.txRef);
  eq(p.user_id, userId("t-buy@example.com"), "payment belongs to this account");
  eq(p.status, "pending"); eq(p.amount, 75000); eq(p.currency, "UGX"); eq(p.provider, "flutterwave");
  const sent = flw.checkouts[0];
  eq(sent.auth, "Bearer FLWSECK_TEST-secret", "secret key used server-side");
  eq(sent.body.tx_ref, r.data.txRef); eq(sent.body.amount, 75000); eq(sent.body.currency, "UGX");
  eq(sent.body.customer.email, "t-buy@example.com");
  eq(sent.body.redirect_url, "https://speakpower-commits.github.io/SpeakPower/account.html", "default return page");
  ok(/^sp-[0-9a-f-]{36}$/.test(r.data.txRef), "unguessable, prefixed tx_ref");
});

await test("topup: the return page is always one of ours, whatever the browser asks for", async () => {
  const s = await signUp("t-return-page@example.com");
  const base = "https://speakpower-commits.github.io/SpeakPower/";
  for (const [asked, expected] of [
    ["griot-app.html", "griot-app.html"],
    ["studio-product.html?product=market-plan", "studio-product.html?product=market-plan"],
    ["https://evil.example/steal", "account.html"],
    ["//evil.example/steal", "account.html"],
    ["account.html#@evil.example", "account.html"],
    ["../../evil.html", "account.html"],
    ["studio-product.html?product=x&next=https://evil.example", "account.html"],
    ["javascript:alert(1)", "account.html"]
  ]) {
    flw.checkouts.length = 0;
    eq((await checkout(s.token, 50000, asked)).status, 200);
    eq(flw.checkouts[0].body.redirect_url, base + expected, "returnTo " + JSON.stringify(asked));
  }
});

await test("topup: Flutterwave refusing to open checkout charges nothing and marks the payment failed", async () => {
  const s = await signUp("t-flwdown@example.com");
  net.flwCheckout = "fail";
  const r = await checkout(s.token);
  net.flwCheckout = "ok";
  eq(r.status, 502); eq(r.data.error, "checkout_failed");
  const row = db.db.prepare("SELECT status FROM payments WHERE user_id = ?").get(userId("t-flwdown@example.com"));
  eq(row.status, "failed");
});

await test("topup: a forged webhook is refused — wrong hash or none at all", async () => {
  const s = await signUp("t-forge@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  for (const bad of ["wrong-hash", "", null]) {
    const r = await webhook(charge(id, c.data.txRef), bad);
    eq(r.status, 401, "status for hash " + JSON.stringify(bad));
  }
  eq(userRow("t-forge@example.com").balance, 0, "nothing credited");
  eq(payment(c.data.txRef).status, "pending");
});

await test("topup: end to end — 3 free, pay wall, top up, webhook credits, GRIOT carries on paid", async () => {
  const s = await signUp("t-e2e@example.com");
  for (let i = 0; i < 3; i++) eq((await chat(s.token, "free " + i)).status, 200);
  eq((await chat(s.token, "fourth")).status, 402, "pay wall");
  const c = await checkout(s.token, 50000);
  const id = pay(c.data.txRef);
  eq((await webhook(charge(id, c.data.txRef))).status, 200);
  const u = userRow("t-e2e@example.com");
  eq(u.balance, 50000, "credited what was paid"); eq(u.plan, "paid");
  eq(payment(c.data.txRef).status, "paid"); eq(payment(c.data.txRef).provider_ref, id);
  const r = await chat(s.token, "now I'm paying");
  eq(r.status, 200); eq(r.data.paidWith, "balance"); eq(r.data.account.balance, 47500);
});

await test("topup: a GRIOT-sized top-up cannot buy a Market Plan", async () => {
  // The defect this model exists to prevent: a counter of uses let a
  // UGX 50,000 GRIOT pack unlock UGX 125,000 Market Plans.
  const s = await signUp("t-mismatch@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0 WHERE email_canonical = ?").run("t-mismatch@example.com");
  await topUp(s.token, 50000);
  const plan = await use(s.token, "market-plan");
  eq(plan.status, 402, "refused");
  eq(plan.data.price, 125000); eq(plan.data.balance, 50000); eq(plan.data.shortfall, 75000);
  eq((await use(s.token, "griot")).data.account.balance, 47500, "the same money still buys GRIOT");
  await topUp(s.token, 100000);
  const paid = await use(s.token, "market-plan");
  eq(paid.status, 200, "affordable once the balance covers it");
  eq(paid.data.account.balance, 22500, "147,500 − 125,000");
});

await test("topup: webhook replays and the return page credit exactly once", async () => {
  const s = await signUp("t-once@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  await webhook(charge(id, c.data.txRef));
  await webhook(charge(id, c.data.txRef));
  await webhook(charge(id, c.data.txRef));
  const conf = await confirm(s.token, c.data.txRef, id);
  eq(conf.status, 200); eq(conf.data.status, "already_credited");
  eq(userRow("t-once@example.com").balance, 50000, "50,000, not 200,000");
});

await test("topup: the webhook and the return page arriving together still credit once", async () => {
  const s = await signUp("t-together@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  const results = await Promise.all([
    webhook(charge(id, c.data.txRef)), confirm(s.token, c.data.txRef, id),
    webhook(charge(id, c.data.txRef)), confirm(s.token, c.data.txRef, id)
  ]);
  const credited = results.filter((r) => r.data && r.data.status === "credited").length;
  ok(credited <= 1, "at most one response reports the credit");
  eq(userRow("t-together@example.com").balance, 50000, "credited once");
});

await test("topup: a burst of simultaneous notifications for one payment credits once", async () => {
  // All of these read the payment while it is still pending, so only the
  // guarded UPDATE — not the early "already paid" check — can stop a double credit.
  const s = await signUp("t-burst@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  net.flwVerifyDelay = 40;
  const results = await Promise.all(Array.from({ length: 8 }, () => webhook(charge(id, c.data.txRef))));
  net.flwVerifyDelay = 0;
  ok(flw.verifies >= 8, "all eight reached verification");
  ok(results.every((r) => r.status === 200), "every notification acknowledged");
  eq(userRow("t-burst@example.com").balance, 50000, "50,000 once, not 400,000");
  eq(payment(c.data.txRef).status, "paid");
});

await test("topup: the return page alone credits — no webhook needed", async () => {
  const s = await signUp("t-return@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  const conf = await confirm(s.token, c.data.txRef, id);
  eq(conf.data.status, "credited"); eq(conf.data.amount, 50000);
  eq(conf.data.account.balance, 50000, "balance in the response");
  await webhook(charge(id, c.data.txRef)); // arriving late changes nothing
  eq(userRow("t-return@example.com").balance, 50000);
});

await test("topup: a top-up adds to the balance; it never replaces it", async () => {
  const s = await signUp("t-adds@example.com");
  setBalance("t-adds@example.com", 12500);
  await topUp(s.token, 100000);
  eq(userRow("t-adds@example.com").balance, 112500);
});

for (const [label, over] of [
  ["underpaid", { amount: 100 }],
  ["paid in the wrong currency", { currency: "USD" }],
  ["a failed charge", { status: "failed" }],
  ["a pending charge", { status: "pending" }],
  ["a verification that answers for a different transaction", { id: 1 }]
]) {
  await test("topup: " + label + " is never credited", async () => {
    const email = "t-" + label.replace(/\W+/g, "-") + "@example.com";
    const s = await signUp(email);
    const c = await checkout(s.token);
    const id = pay(c.data.txRef, over);
    await webhook(charge(id, c.data.txRef));
    const conf = await confirm(s.token, c.data.txRef, id);
    eq(conf.data.status, "not_paid");
    eq(userRow(email).balance, 0, "nothing credited");
    eq(payment(c.data.txRef).status, "pending", "left pending, so a genuine retry can still settle it");
  });
}

await test("topup: one real cheap payment cannot be replayed against a bigger top-up", async () => {
  const s = await signUp("t-reuse@example.com");
  const cheap = await checkout(s.token, 1000);
  const id = pay(cheap.data.txRef, { amount: 1000 });
  await webhook(charge(id, cheap.data.txRef));
  eq(userRow("t-reuse@example.com").balance, 1000);
  // Claim the same Flutterwave transaction against a fresh, larger top-up.
  const big = await checkout(s.token, 250000);
  await webhook(charge(id, big.data.txRef));
  const conf = await confirm(s.token, big.data.txRef, id);
  eq(conf.data.status, "not_paid", "the transaction belongs to the first top-up");
  eq(userRow("t-reuse@example.com").balance, 1000, "still 1,000");
  eq(payment(big.data.txRef).status, "pending");
});

await test("topup: one real payment cannot be claimed twice, even against a top-up of the same amount", async () => {
  const s = await signUp("t-twice@example.com");
  const first = await topUp(s.token, 50000);
  eq(userRow("t-twice@example.com").balance, 50000);
  const second = await checkout(s.token, 50000);
  eq((await webhook(charge(first.id, second.data.txRef))).status, 200);
  const conf = await confirm(s.token, second.data.txRef, first.id);
  eq(conf.status, 200); eq(conf.data.status, "not_paid", "the transaction belongs to the first top-up");
  eq(userRow("t-twice@example.com").balance, 50000, "still 50,000");
  eq(payment(second.data.txRef).status, "pending");
});

await test("topup: nobody can settle another account's payment", async () => {
  const owner = await signUp("t-owner@example.com");
  const thief = await signUp("t-thief@example.com");
  const c = await checkout(owner.token);
  const id = pay(c.data.txRef);
  const r = await confirm(thief.token, c.data.txRef, id);
  eq(r.status, 404, "looks like a missing payment");
  eq(userRow("t-thief@example.com").balance, 0);
  eq(userRow("t-owner@example.com").balance, 0, "and the owner is not credited by the thief's call either");
  eq(payment(c.data.txRef).status, "pending", "owner's payment untouched");
});

await test("topup: payments that are not our top-ups are acknowledged and ignored", async () => {
  const before = flw.verifies;
  for (const ref of ["static-link-123", "sp-not-a-real-payment", "griot-from-the-old-model"]) {
    eq((await webhook(charge(pay(ref), ref))).status, 200, ref);
  }
  eq(flw.verifies, before, "nothing verified, nothing credited");
});

await test("topup: Flutterwave's API being down leaves the payment pending; a retry then credits", async () => {
  const s = await signUp("t-retry@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  net.flwVerify = "down";
  await webhook(charge(id, c.data.txRef));
  net.flwVerify = "ok";
  eq(userRow("t-retry@example.com").balance, 0, "not credited on an unverifiable payment");
  eq(payment(c.data.txRef).status, "pending");
  await webhook(charge(id, c.data.txRef)); // Flutterwave retries
  eq(userRow("t-retry@example.com").balance, 50000, "credited on retry");
});

/* ------------------------------------------------------- the account page */

await test("account: signed-out callers get nothing", async () => {
  eq((await call("GET", "/account")).status, 401);
});

await test("account: balance, prices, every use and every top-up — and nobody else's", async () => {
  const s = await signUp("a-history@example.com");
  await use(s.token, "griot");                   // free
  await use(s.token, "brand-story");             // free
  await use(s.token, "seo-audit", { url: "https://down.test" }); // free, failed, given back
  await use(s.token, "seo-audit");               // free
  net.flwCheckout = "fail";
  await checkout(s.token, 100000);               // never opened
  net.flwCheckout = "ok";
  await topUp(s.token, 100000);
  await use(s.token, "speaker-ready");           // 75,000 from the balance
  await checkout(s.token, 50000);                // opened, not paid yet
  const other = await signUp("a-someone-else@example.com");
  await use(other.token, "market-plan");

  const r = await call("GET", "/account", { token: s.token });
  eq(r.status, 200);
  eq(r.data.account.email, "a-history@example.com");
  eq(r.data.account.trialsRemaining, 0); eq(r.data.account.balance, 25000);
  eq(r.data.prices["market-plan"], 125000);
  const uses = r.data.uses.map((u) => [u.service, u.paidWith, u.amount, u.status].join(" "));
  eq(JSON.stringify(uses), JSON.stringify([
    "speaker-ready balance 75000 ok",
    "seo-audit trial 0 ok",
    "seo-audit trial 0 refunded",
    "brand-story trial 0 ok",
    "griot trial 0 ok"
  ]), "newest first, refunds shown");
  ok(r.data.uses.every((u) => Number.isInteger(u.at)), "every use is dated");
  const pays = r.data.payments.map((p) => [p.amount, p.currency, p.provider, p.status].join(" "));
  eq(JSON.stringify(pays), JSON.stringify(["50000 UGX flutterwave pending", "100000 UGX flutterwave paid"]),
    "failed checkouts hidden; pending and paid shown");
  ok(!JSON.stringify(r.data).includes("market-plan trial"), "another account's use never appears");
  ok(!JSON.stringify(r.data).includes("tx_ref") && !JSON.stringify(r.data).includes("sp-"), "no payment references exposed");
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");
if (failures.length) process.exit(1);
