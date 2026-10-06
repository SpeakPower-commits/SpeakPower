// SpeakPower Studio API — end-to-end tests against an in-memory D1 stand-in.
// Run: node --experimental-sqlite worker/test/run-tests.mjs   (Node 22.5+)
//
// Exercises the real worker.js fetch handler. Only D1, the email binding and
// outbound fetch (Turnstile, PageSpeed) are replaced with local fakes.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../worker.js";

const here = dirname(fileURLToPath(import.meta.url));

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

const net = { pagespeed: "ok", griot: "ok" };
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
    if (net.pagespeed === "fail") return new Response("nope", { status: 500 });
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
  return realFetch(input, init);
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
  CHECKOUT_URL: "https://checkout.example.com/pay",
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

await test("failed PageSpeed run is refunded", async () => {
  net.pagespeed = "fail";
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "seo-audit", inputs: { url: "https://example.com" } } });
  net.pagespeed = "ok";
  eq(r.status, 502); eq(r.data.error, "generation_failed");
  ok(/not used/.test(r.data.message), "message says run not used");
  eq(db.one("SELECT trials_remaining AS t FROM users WHERE email = 'alice@example.com'").t, 2);
  eq(db.one("SELECT status FROM runs WHERE product = 'seo-audit' ORDER BY id DESC").status, "refunded");
});

await test("SEO audit rejects non-public URLs before spending", async () => {
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "seo-audit", inputs: { url: "javascript:alert(1)" } } });
  eq(r.status, 400); eq(r.data.error, "invalid_url");
});

await test("SEO audit succeeds with scores and findings", async () => {
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "seo-audit", inputs: { url: "https://example.com" } } });
  eq(r.status, 200);
  eq(r.data.sections[0][0], "Seo"); eq(r.data.sections[0][1], "82 / 100");
  ok(r.data.sections.some((s) => /meta description/.test(s[1])), "finding listed");
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

await test("fourth run returns 402 with checkout hand-off", async () => {
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "brand-story", inputs: BRIEF } });
  eq(r.status, 402); eq(r.data.error, "trials_exhausted");
  eq(r.data.checkoutUrl, env.CHECKOUT_URL); eq(r.data.price, "UGX 100,000");
  eq(db.one("SELECT COUNT(*) AS n FROM events WHERE name = 'trials_exhausted'").n, 1);
});

await test("paid credits are spent after free runs", async () => {
  db.db.prepare("UPDATE users SET credits = 1, plan = 'paid' WHERE email_canonical = ?").run("alice@example.com");
  const r = await call("POST", "/studio/generate", { token: alice.token, body: { product: "speaker-ready", inputs: {
    speaker: "A", topic: "Clean energy", audience: "Teachers", time: "20 minutes", goal: "Switch to solar",
    idea1: "Cost", idea2: "Reliability", idea3: "Maintenance", story: "Gulu school"
  } } });
  eq(r.status, 200); eq(r.data.paidWith, "credit"); eq(r.data.account.credits, 0);
  eq((await call("POST", "/studio/generate", { token: alice.token, body: { product: "brand-story", inputs: BRIEF } })).status, 402);
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

await test("griot: fourth message returns 402 with checkout, GRIOT not called", async () => {
  const s = await call("POST", "/auth/start", { body: { email: "g-three@example.com", turnstileToken: "pass" } });
  eq(s.status, 200);
  const v = await call("POST", "/auth/verify", { body: { email: "g-three@example.com", code: lastCodeFor("g-three@example.com") } });
  griotCalls.length = 0;
  const r = await chat(v.data.token, "one more");
  eq(r.status, 402, "status"); eq(r.data.error, "trials_exhausted");
  eq(r.data.checkoutUrl, "https://checkout.example.com/pay");
  eq(griotCalls.length, 0, "exhausted account never reaches GRIOT");
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
    ok(/not used/.test(r.data.message), "tells the customer they were not charged");
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

await test("griot: paid credits are spent once free messages run out", async () => {
  const s = await signUp("g-paid@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, credits = 2 WHERE email_canonical = ?")
    .run("g-paid@example.com");
  const r = await chat(s.token, "paid question");
  eq(r.status, 200); eq(r.data.paidWith, "credit");
  eq(r.data.account.credits, 1); eq(r.data.account.trialsRemaining, 0);
});

await test("griot: the checkout link rides on every account response, not only the 402", async () => {
  // The last free message succeeds (200), so the page must learn where to pay
  // from that response — and from /me after a reload — or the pay wall shows
  // with no way to pay at the moment of highest intent.
  const s = await signUp("g-checkout@example.com");
  eq(s.account.checkoutUrl, "https://checkout.example.com/pay", "on sign-in");
  const me = await call("GET", "/me", { token: s.token });
  eq(me.data.account.checkoutUrl, "https://checkout.example.com/pay", "on /me");
  db.db.prepare("UPDATE users SET trials_remaining = 1 WHERE email_canonical = ?").run("g-checkout@example.com");
  const last = await chat(s.token, "my last free one");
  eq(last.status, 200);
  eq(last.data.account.trialsRemaining, 0);
  eq(last.data.account.checkoutUrl, "https://checkout.example.com/pay", "on the final successful message");
});

await test("griot: parallel sends can never overspend the last message", async () => {
  const s = await signUp("g-race@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 1, credits = 0 WHERE email_canonical = ?")
    .run("g-race@example.com");
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => chat(s.token, "race " + i)));
  eq(results.filter((r) => r.status === 200).length, 1, "exactly one succeeds");
  eq(results.filter((r) => r.status === 402).length, 4, "the rest are told to top up");
  eq(userRow("g-race@example.com").trials_remaining, 0, "never negative");
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

/* ------------------------------------------------- GRIOT automatic top-up */

// Flutterwave's servers call the webhook directly: no Origin, a verif-hash.
async function webhook(payload, hash = "flw-hash-secret") {
  const headers = { "Content-Type": "application/json" };
  if (hash !== null) headers["verif-hash"] = hash;
  const res = await worker.fetch(new Request("https://api.test/webhooks/flutterwave", {
    method: "POST", headers, body: JSON.stringify(payload)
  }), env, { waitUntil() {} });
  return { status: res.status, text: await res.text() };
}
function order(txRef) { return db.db.prepare("SELECT * FROM griot_orders WHERE tx_ref = ?").get(txRef); }
let flwId = 9000000;
// Flutterwave records a payment against an order, the way a real charge would.
function pay(txRef, over) {
  const id = String(++flwId);
  flw.transactions[id] = Object.assign({ id: Number(id), tx_ref: txRef, status: "successful", amount: 50000, currency: "UGX" }, over || {});
  return id;
}
const charge = (id, txRef) => ({ event: "charge.completed", data: { id: Number(id), tx_ref: txRef, status: "successful" } });
async function checkout(token) { return call("POST", "/griot/checkout", { token, body: {} }); }

await test("topup: not switched on → 503, account offers no pack", async () => {
  const s = await signUp("t-off@example.com");
  eq(s.account.pack, null, "no pack advertised");
  const r = await checkout(s.token);
  eq(r.status, 503); eq(r.data.error, "checkout_unconfigured");
  eq(flw.checkouts.length, 0, "Flutterwave never called");
});

env.GRIOT_PACK_MESSAGES = "20";
env.GRIOT_PACK_PRICE = "50000";
env.FLW_SECRET_KEY = "FLWSECK_TEST-secret";
env.FLW_SECRET_HASH = "flw-hash-secret";

await test("topup: account advertises the pack once configured", async () => {
  const s = await signUp("t-pack@example.com");
  eq(JSON.stringify(s.account.pack), JSON.stringify({ messages: 20, amount: 50000, currency: "UGX" }));
});

await test("topup: signed-out checkout refused", async () => {
  const r = await checkout(null);
  eq(r.status, 401);
});

await test("topup: checkout records the order first, then opens Flutterwave for the right amount", async () => {
  const s = await signUp("t-buy@example.com");
  flw.checkouts.length = 0;
  const r = await checkout(s.token);
  eq(r.status, 200, "status");
  ok(r.data.link.startsWith("https://checkout.flutterwave.com/"), "hosted link returned");
  const o = order(r.data.txRef);
  eq(o.user_id, userRow("t-buy@example.com").id, "order belongs to this account");
  eq(o.status, "pending"); eq(o.messages, 20); eq(o.amount, 50000); eq(o.currency, "UGX");
  const sent = flw.checkouts[0];
  eq(sent.auth, "Bearer FLWSECK_TEST-secret", "secret key used server-side");
  eq(sent.body.tx_ref, r.data.txRef); eq(sent.body.amount, 50000); eq(sent.body.currency, "UGX");
  eq(sent.body.customer.email, "t-buy@example.com");
  eq(sent.body.redirect_url, "https://speakpower-commits.github.io/SpeakPower/griot-app.html");
  ok(/^griot-[0-9a-f-]{36}$/.test(r.data.txRef), "unguessable, prefixed tx_ref");
});

await test("topup: Flutterwave refusing to open checkout charges nothing and marks the order failed", async () => {
  const s = await signUp("t-flwdown@example.com");
  net.flwCheckout = "fail";
  const r = await checkout(s.token);
  net.flwCheckout = "ok";
  eq(r.status, 502); eq(r.data.error, "checkout_failed");
  const row = db.db.prepare("SELECT status FROM griot_orders WHERE user_id = ?").get(userRow("t-flwdown@example.com").id);
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
  eq(userRow("t-forge@example.com").credits, 0, "no credit");
  eq(order(c.data.txRef).status, "pending");
});

await test("topup: end to end — 3 free, pay wall, pay, webhook credits 20, GRIOT carries on", async () => {
  const s = await signUp("t-e2e@example.com");
  for (let i = 0; i < 3; i++) eq((await chat(s.token, "free " + i)).status, 200);
  eq((await chat(s.token, "fourth")).status, 402, "pay wall");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  const w = await webhook(charge(id, c.data.txRef));
  eq(w.status, 200);
  const u = userRow("t-e2e@example.com");
  eq(u.credits, 20, "credited the pack"); eq(u.plan, "paid");
  eq(order(c.data.txRef).status, "paid"); eq(order(c.data.txRef).flw_tx_id, id);
  const r = await chat(s.token, "now I'm paying");
  eq(r.status, 200); eq(r.data.paidWith, "credit"); eq(r.data.account.credits, 19);
});

await test("topup: webhook replays and the return page credit exactly once", async () => {
  const s = await signUp("t-once@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  await webhook(charge(id, c.data.txRef));
  await webhook(charge(id, c.data.txRef));
  await webhook(charge(id, c.data.txRef));
  const conf = await call("POST", "/griot/payment/confirm", { token: s.token, body: { txRef: c.data.txRef, transactionId: id } });
  eq(conf.status, 200); eq(conf.data.status, "already_credited");
  eq(userRow("t-once@example.com").credits, 20, "20, not 80");
});

await test("topup: the return page alone credits — no webhook needed", async () => {
  const s = await signUp("t-return@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  const conf = await call("POST", "/griot/payment/confirm", { token: s.token, body: { txRef: c.data.txRef, transactionId: id } });
  eq(conf.data.status, "credited"); eq(conf.data.account.credits, 20, "balance in the response");
  await webhook(charge(id, c.data.txRef)); // arriving late changes nothing
  eq(userRow("t-return@example.com").credits, 20);
});

for (const [label, over] of [
  ["underpaid", { amount: 100 }],
  ["paid in the wrong currency", { currency: "USD" }],
  ["a failed charge", { status: "failed" }],
  ["a pending charge", { status: "pending" }]
]) {
  await test("topup: " + label + " is never credited", async () => {
    const email = "t-" + label.replace(/\W+/g, "-") + "@example.com";
    const s = await signUp(email);
    const c = await checkout(s.token);
    const id = pay(c.data.txRef, over);
    await webhook(charge(id, c.data.txRef));
    const conf = await call("POST", "/griot/payment/confirm", { token: s.token, body: { txRef: c.data.txRef, transactionId: id } });
    eq(conf.data.status, "not_paid");
    eq(userRow(email).credits, 0, "no credit");
    eq(order(c.data.txRef).status, "pending", "left pending, so a genuine retry can still settle it");
  });
}

await test("topup: one real cheap payment cannot be replayed against a different order", async () => {
  const s = await signUp("t-reuse@example.com");
  const first = await checkout(s.token);
  const id = pay(first.data.txRef);
  await webhook(charge(id, first.data.txRef));
  eq(userRow("t-reuse@example.com").credits, 20);
  // Claim the same Flutterwave transaction against a fresh order.
  const second = await checkout(s.token);
  await webhook(charge(id, second.data.txRef));
  const conf = await call("POST", "/griot/payment/confirm", { token: s.token, body: { txRef: second.data.txRef, transactionId: id } });
  eq(conf.data.status, "not_paid", "transaction belongs to the first order");
  eq(userRow("t-reuse@example.com").credits, 20, "still 20");
});

await test("topup: nobody can settle another account's order", async () => {
  const owner = await signUp("t-owner@example.com");
  const thief = await signUp("t-thief@example.com");
  const c = await checkout(owner.token);
  const id = pay(c.data.txRef);
  const r = await call("POST", "/griot/payment/confirm", { token: thief.token, body: { txRef: c.data.txRef, transactionId: id } });
  eq(r.status, 404, "looks like a missing order");
  eq(userRow("t-thief@example.com").credits, 0);
  eq(order(c.data.txRef).status, "pending", "owner's order untouched");
});

await test("topup: payments that are not GRIOT orders are acknowledged and ignored", async () => {
  const before = flw.verifies;
  eq((await webhook(charge(pay("static-link-123"), "static-link-123"))).status, 200);
  eq((await webhook(charge(pay("griot-not-a-real-order"), "griot-not-a-real-order"))).status, 200);
  eq(flw.verifies, before, "nothing verified, nothing credited");
});

await test("topup: Flutterwave's API being down leaves the order pending; a retry then credits", async () => {
  const s = await signUp("t-retry@example.com");
  const c = await checkout(s.token);
  const id = pay(c.data.txRef);
  net.flwVerify = "down";
  await webhook(charge(id, c.data.txRef));
  net.flwVerify = "ok";
  eq(userRow("t-retry@example.com").credits, 0, "not credited on an unverifiable payment");
  eq(order(c.data.txRef).status, "pending");
  await webhook(charge(id, c.data.txRef)); // Flutterwave retries
  eq(userRow("t-retry@example.com").credits, 20, "credited on retry");
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");
if (failures.length) process.exit(1);
