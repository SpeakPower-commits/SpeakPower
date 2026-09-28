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

const net = { pagespeed: "ok" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
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

console.log("\n" + passed + " passed, " + failures.length + " failed\n");
if (failures.length) process.exit(1);
