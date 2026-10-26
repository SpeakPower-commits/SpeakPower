// SpeakPower Studio API — end-to-end tests against an in-memory D1 stand-in.
// Run: node --experimental-sqlite worker/test/run-tests.mjs   (Node 22.5+)
//
// Exercises the real worker.js fetch handler. Only D1, the email binding and
// outbound fetch (Turnstile, PageSpeed, Google certificates, GRIOT,
// Flutterwave) are replaced with local fakes.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
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

const net = { pagespeed: "ok", griot: "ok", strategy: "ok", pagespeedCalls: [], pageFetches: [], events: [], siteLog: [] };
// Every request the stand-in Claude received for an audit's strategic read.
const strategyCalls = [];
const STRATEGY_READ = {
  summary: "A clear site with a sound technical floor; private areas and AI visibility need attention first.",
  first_impression: "A visitor sees solar kits for schools and clinics, and a way to call.",
  clarity: ["Audience", "Offer", "Proof", "Action", "Voice"].map((d, i) => ({ dimension: d, score: 3 + (i % 2), note: d + " is mostly clear." })),
  priorities: [1, 2, 3, 4, 5].map((n) => ({ action: "Fix item " + n, why: "Because of finding " + n + ".", impact: "high", effort: "low", where: "/" })),
  plan: { days30: ["Lock the dashboard"], days60: ["Add a sitemap"], days90: ["Publish case studies"] }
};

// Waits like a slow server, but gives up the moment the request is aborted,
// exactly as fetch does.
function stall(ms, init) {
  return new Promise((resolve, reject) => {
    const signal = init && init.signal;
    const abort = () => { clearTimeout(t); reject(new DOMException("The operation was aborted.", "AbortError")); };
    const t = ms === Infinity ? null : setTimeout(resolve, ms);
    if (signal && signal.aborted) return abort();
    if (signal) signal.addEventListener("abort", abort, { once: true });
  });
}
const SLOW_HTML = "<!doctype html><html lang=en><title>Slow but there</title><h1>Hi</h1></html>";
const htmlResponse = (body) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
// The public half of a real RSA key the tests sign Google ID tokens with, so
// the Worker's signature check runs for real rather than against a stub.
const googleJwks = { keys: [] };
// A stand-in Flutterwave: checkouts it was asked for, and the transactions it
// will vouch for when the Worker re-verifies a payment.
const flw = { checkouts: [], transactions: {}, verifies: 0 };
// A stand-in for Google Analytics' Measurement Protocol: every hit it got.
const ga4 = { hits: [] };
// Every request that reaches the fake GRIOT, so tests can assert exactly what
// crossed the boundary: which tenant, which key, and that no project leaked.
const griotCalls = [];
// Every request that reaches the stand-in coach, and what Whisper was asked.
const coachCalls = [];
const markdownCalls = [];
const whisperCalls = [];
const DOC_READING = {
  brief: "The 2025 annual report of Kampala Schools Trust: enrolment, costs and next year's campaign.",
  facts: [
    { text: "Enrolment rose 18% in 2025 across the Trust's 40 schools.", page: 2 },
    { text: "Teacher salaries are 61% of the Trust's running costs.", page: 3 },
    { text: "Teacher salaries are 61% of the Trust's running costs.", page: 3 },
    { text: "The Trust plans a donor campaign in March 2026.", page: 9 },
    { text: "  ", page: 1 }
  ]
};
const COACHING = {
  lenses: [
    { lens: "Politics", score: 4, note: "You name the board's priority." },
    { lens: "Organizations", score: 3, note: "Two messages compete." },
    { lens: "Law", score: 5, note: "Claims are modest and sourced." },
    { lens: "Security", score: 4, note: "Holds up if quoted." },
    { lens: "Socioeconomics", score: 4, note: "Fits a cost-conscious room." }
  ],
  landed: "The 40 schools figure.",
  lost: "The ask arrived last.",
  fixes: ["Lead with the ask.", "Cut the history.", "End on the 40 schools."],
  opening_line: "Forty schools now teach after dark, and we can reach a hundred more.",
  sixty_second_version: "Forty schools now teach after dark..."
};
let griotOldChats = 0;
let griotHealthChecks = 0;
// GRIOT's client workspace, per tenant, as the real one keeps it.
const griotStore = { memories: [], messages: [], decisions: [], projects: [] };
const griotWsCalls = [];
const GRIOT_AGENTS = { story: "StoryAgent", market: "MarketAgent", data: "DataAgent", dev: "DevAgent", research: "ResearchAgent",
  growth: "GrowthAgent", operations: "OperationsAgent", brand: "BrandAgent", strategy: "StrategyAgent" };
const GRIOT_STEPS = ["UNDERSTAND", "CONTEXT", "EVIDENCE", "DIAGNOSE", "OPTIONS", "RECOMMEND", "EXECUTE", "MEASURE", "LEARN"];
async function griotWorkspaceFake(url, init) {
  const u = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const tenant = headers.get("X-Tenant-Id");
  const out = (data, status = 200) => new Response(JSON.stringify(data), { status });
  griotWsCalls.push({ method, path: u.pathname + u.search, tenant, key: headers.get("X-API-Key") });
  if (headers.get("X-API-Key") !== "griot-server-key") return out({ detail: "bad key" }, 401);
  if (net.griotMemory === "down" && (u.pathname === "/memory" || u.pathname.startsWith("/memories/"))) {
    return out({ detail: "Traceback: internal" }, 500);
  }
  if (u.pathname === "/agents") return out(GRIOT_AGENTS);
  if (u.pathname === "/protocol") return out({ steps: GRIOT_STEPS });
  if (u.pathname === "/projects") return out({ speakpower: { name: "SpeakPower" } });
  const ownProject = (slug) => griotStore.projects.some((x) => x.tenant === tenant && x.slug === slug);
  const projectOk = (slug) => !slug || slug === "global" || slug === "speakpower" || ownProject(slug);
  const wantProject = u.searchParams.get("project");
  if (u.pathname === "/memories" && method === "GET") {
    return out(griotStore.memories.filter((m) => m.tenant_id === tenant &&
      (!wantProject || m.project === wantProject || m.project === "global")));
  }
  if (u.pathname === "/memory" && method === "POST") {
    if (net.griotMemoryDelay) await new Promise((r) => setTimeout(r, net.griotMemoryDelay));
    if (!projectOk(JSON.parse(init.body).project)) return out({ detail: "Unknown project" }, 400);
    const row = Object.assign({ id: crypto.randomUUID(), tenant_id: tenant, created_at: new Date().toISOString() }, JSON.parse(init.body));
    griotStore.memories.push(row);
    return out(row);
  }
  const md = u.pathname.match(/^\/memories\/(.+)$/);
  if (md && method === "DELETE") {
    const i = griotStore.memories.findIndex((m) => m.id === md[1] && m.tenant_id === tenant);
    if (i < 0) return out({ detail: "No such memory" }, 404);
    griotStore.memories.splice(i, 1);
    return out({ deleted: md[1] });
  }
  if (u.pathname === "/threads") {
    const mine = griotStore.messages.filter((m) => m.tenant === tenant && (!wantProject || (m.project || "global") === wantProject));
    const ids = [...new Set(mine.map((m) => m.thread))];
    return out(ids.map((id) => {
      const ms = mine.filter((m) => m.thread === id);
      return { thread_id: id, first_question: ms[0].content, last_at: ms[ms.length - 1].at, messages: ms.length, project: ms[0].project || "global" };
    }));
  }
  const mt = u.pathname.match(/^\/threads\/(.+)$/);
  if (mt) {
    const ms = griotStore.messages.filter((m) => m.tenant === tenant && m.thread === mt[1]);
    if (!ms.length) return out({ detail: "No such thread" }, 404);
    return out({ thread_id: mt[1], messages: ms.map((m) => ({ role: m.role, content: m.content, created_at: m.at })) });
  }
  if (u.pathname === "/decisions") {
    return out(griotStore.decisions.filter((d) => d.tenant_id === tenant && (!wantProject || d.project === wantProject)));
  }
  // A client's own projects, as GRIOT keeps them (claude-central-agent #29).
  if (u.pathname === "/tenant/projects" && method === "GET") {
    return out(griotStore.projects.filter((x) => x.tenant === tenant).map((x) => ({ slug: x.slug, name: x.name, created_at: x.at })));
  }
  if (u.pathname === "/tenant/projects" && method === "POST") {
    if (griotStore.projects.filter((x) => x.tenant === tenant).length >= (net.griotProjectCap || 20)) return out({ detail: "Project limit reached" }, 409);
    const row = { tenant, slug: "p-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), name: JSON.parse(init.body).name, at: new Date().toISOString() };
    griotStore.projects.push(row);
    return out({ slug: row.slug, name: row.name, created_at: row.at }, 201);
  }
  const mp = u.pathname.match(/^\/tenant\/projects\/(.+)$/);
  if (mp) {
    const row = griotStore.projects.find((x) => x.tenant === tenant && x.slug === mp[1]);
    if (!row) return out({ detail: "No such project" }, 404);
    if (method === "PATCH") { row.name = JSON.parse(init.body).name; return out({ slug: row.slug, name: row.name, created_at: row.at }); }
    if (method === "DELETE") {
      griotStore.projects.splice(griotStore.projects.indexOf(row), 1);
      griotStore.messages = griotStore.messages.filter((m) => !(m.tenant === tenant && m.project === row.slug));
      griotStore.decisions = griotStore.decisions.filter((d) => !(d.tenant_id === tenant && d.project === row.slug));
      griotStore.memories = griotStore.memories.filter((m) => !(m.tenant_id === tenant && m.project === row.slug));
      return out({ deleted: row.slug });
    }
  }
  return out({ detail: "not here" }, 404);
}
// A stand-in YouTube Data API v3: three channels, their uploads, and the
// calls the Worker made (method and parameters, never the key).
const YT_NOW = Math.floor(Date.now() / 1000);
const ytIso = (daysAgo) => new Date((YT_NOW - daysAgo * 86400) * 1000).toISOString();
const ytVid = (prefix, n) => prefix + String(n).padStart(11 - prefix.length, "0");
const ytChan = (c) => "UC" + c.repeat(22);
const ytFake = { calls: [], error: null, videos: {}, channels: {}, playlists: {} };
const YT_COST_OF = { search: 100, videos: 1, channels: 1, playlistItems: 1 };
function ytAddVideo(id, channelId, channelTitle, daysAgo, views, extra = {}) {
  const stats = { viewCount: String(views), likeCount: String(Math.round(views * 0.04)), commentCount: String(Math.round(views * 0.004)) };
  if (extra.hideLikes) delete stats.likeCount;
  if (extra.noComments) delete stats.commentCount;
  ytFake.videos[id] = {
    id,
    snippet: { publishedAt: ytIso(daysAgo), channelId, channelTitle, title: extra.title || "Talk " + id },
    statistics: stats,
    contentDetails: { duration: extra.duration || "PT8M30S" }
  };
}
function ytAddChannel(c, title, handle, subs, uploads, extra = {}) {
  const id = ytChan(c);
  ytFake.channels[id] = {
    id,
    snippet: { title, customUrl: handle, country: "UG" },
    statistics: extra.hidden ? { hiddenSubscriberCount: true, videoCount: String(uploads.length), viewCount: "1000" }
      : { subscriberCount: String(subs), hiddenSubscriberCount: false, videoCount: String(uploads.length), viewCount: "50000000" },
    contentDetails: { relatedPlaylists: { uploads: "UU" + c.repeat(22) } }
  };
  ytFake.playlists["UU" + c.repeat(22)] = uploads; // newest first
}
(function ytFixtures() {
  // A small channel whose newest talk broke out: ~12× its usual 10,000 views.
  const a = [ytVid("A", 1)];
  ytAddVideo(ytVid("A", 1), ytChan("a"), "Speak Academy", 5, 120000, { title: "The 3-second pause that wins rooms" });
  for (let i = 0; i < 30; i++) {
    const id = ytVid("A", 100 + i);
    ytAddVideo(id, ytChan("a"), "Speak Academy", 10 + i * 7, 8000 + (i % 5) * 1000);
    a.push(id);
  }
  ytAddVideo(ytVid("A", 900), ytChan("a"), "Speak Academy", 400, 300000, { title: "Stage fright, explained" });
  ytAddChannel("a", "Speak Academy", "@speakacademy", 20000, a);
  // A big channel whose newest talk is ordinary for it, despite 600,000 views.
  const b = [ytVid("B", 1)];
  ytAddVideo(ytVid("B", 1), ytChan("b"), "Big Talks", 6, 600000);
  for (let i = 0; i < 30; i++) {
    const id = ytVid("B", 100 + i);
    ytAddVideo(id, ytChan("b"), "Big Talks", 9 + i * 4, 450000 + (i % 5) * 25000);
    b.push(id);
  }
  ytAddVideo(ytVid("B", 900), ytChan("b"), "Big Talks", 800, 900000, { title: "How to open any speech" });
  ytAddChannel("b", "Big Talks", "@bigtalks", 2000000, b);
  // A new channel: too few uploads for a baseline, likes hidden, comments off.
  const c = [ytVid("C", 1), ytVid("C", 2), ytVid("C", 3)];
  ytAddVideo(ytVid("C", 1), ytChan("c"), "New Voice", 3.5, 50000, { hideLikes: true, noComments: true, duration: "PT58S" });
  ytAddVideo(ytVid("C", 2), ytChan("c"), "New Voice", 20, 900);
  ytAddVideo(ytVid("C", 3), ytChan("c"), "New Voice", 40, 1200);
  ytAddChannel("c", "New Voice", "@newvoice", 0, c, { hidden: true });
})();
function youtubeFake(url) {
  const u = new URL(url);
  const method = u.pathname.split("/").pop();
  const params = Object.fromEntries(u.searchParams);
  const key = params.key;
  delete params.key;
  ytFake.calls.push({ method, params });
  const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fail = (status, reason) => out({ error: { code: status, errors: [{ reason }] } }, status);
  if (key !== "yt-test-key") return fail(400, "keyInvalid");
  if (ytFake.error === "quota") return fail(403, "quotaExceeded");
  if (method === "videos") {
    return out({ items: params.id.split(",").map((id) => ytFake.videos[id]).filter(Boolean) });
  }
  if (method === "channels") {
    if (params.forHandle) {
      const ch = Object.values(ytFake.channels).find((c) => c.snippet.customUrl.toLowerCase() === params.forHandle.toLowerCase());
      return out({ items: ch ? [ch] : [] });
    }
    return out({ items: (params.id || "").split(",").map((id) => ytFake.channels[id]).filter(Boolean) });
  }
  if (method === "playlistItems") {
    const ids = ytFake.playlists[params.playlistId];
    if (!ids) return fail(404, "playlistNotFound");
    return out({ items: ids.slice(0, Number(params.maxResults)).map((videoId) => ({ contentDetails: { videoId } })) });
  }
  if (method === "search") {
    const after = params.publishedAfter ? Date.parse(params.publishedAfter) : -Infinity;
    const before = params.publishedBefore ? Date.parse(params.publishedBefore) : Infinity;
    const items = Object.values(ytFake.videos)
      .filter((v) => { const t = Date.parse(v.snippet.publishedAt); return t >= after && t <= before; })
      .sort((x, y) => Number(y.statistics.viewCount) - Number(x.statistics.viewCount))
      .slice(0, Number(params.maxResults))
      .map((v) => ({ id: { videoId: v.id } }));
    return out({ items });
  }
  return fail(404, "notFound");
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url = typeof input === "string" ? input : input.url;
  // A GRIOT with the workspace but not client projects yet: otherwise the
  // same GRIOT as griot.test.
  if (url.startsWith("https://griot-noproj.test/health")) {
    return new Response(JSON.stringify({ status: "ok", tenancy: true, tenant_header: "X-Tenant-Id", workspace: true, documents: true, modes: true }));
  }
  if (url.startsWith("https://griot-noproj.test/")) url = url.replace("https://griot-noproj.test/", "https://griot.test/");
  if (url.startsWith("https://www.google-analytics.com/mp/collect")) {
    const u = new URL(url);
    ga4.hits.push({ id: u.searchParams.get("measurement_id"), secret: u.searchParams.get("api_secret"),
      contentType: new Headers(init.headers).get("Content-Type"), body: JSON.parse(init.body) });
    if (net.ga4 === "hang") await stall(Infinity, init);
    if (net.ga4 === "fail") return new Response("nope", { status: 500 });
    if (net.ga4 === "throw") throw new TypeError("fetch failed");
    return new Response(null, { status: 204 });
  }
  if (url.startsWith("https://www.googleapis.com/youtube/v3/")) return youtubeFake(url);
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
    return new Response(JSON.stringify({ status: "ok", tenancy: true, tenant_header: "X-Tenant-Id", workspace: true, documents: true, modes: true, projects: true }));
  }
  // A tenant-aware GRIOT from before the client workspace.
  if (url.startsWith("https://griot-plain.test/health")) {
    return new Response(JSON.stringify({ status: "ok", tenancy: true, tenant_header: "X-Tenant-Id" }));
  }
  if (url.startsWith("https://griot-plain.test/")) {
    griotCalls.push({ url, tenant: new Headers(init.headers).get("X-Tenant-Id"), body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ thread_id: "t-plain", agents: [], memory_used: 0, answer: "FACT: plain." }));
  }
  if (url.startsWith("https://griot.test/") && !url.startsWith("https://griot.test/chat")) {
    return griotWorkspaceFake(url, init);
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
    const tenant = headers.get("X-Tenant-Id");
    if (body.project && body.project !== "global" &&
        !griotStore.projects.some((x) => x.tenant === tenant && x.slug === body.project)) {
      return new Response(JSON.stringify({ detail: "Unknown project" }), { status: 400 });
    }
    const thread = body.thread_id || crypto.randomUUID();
    const at = new Date().toISOString();
    const project = body.project || null;
    griotStore.messages.push({ tenant, thread, role: "user", content: body.message, at, project },
      { tenant, thread, role: "assistant", content: "FACT: you said X. INFERENCE: therefore Y.", at, project });
    griotStore.decisions.push({ id: crypto.randomUUID(), tenant_id: tenant, thread_id: thread, project: project || "global",
      request: body.message, recommendation: "FACT: you said X.", created_at: at });
    return new Response(JSON.stringify({
      decision_id: "d-" + griotCalls.length,
      thread_id: thread,
      project: null,
      mode: body.mode,
      agents: body.lenses ? body.lenses.map((k) => GRIOT_AGENTS[k]) : ["Market", "Brand"],
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
    net.events.push("lighthouse");
    if (net.pagespeed === "slow") await stall(Infinity, init); // until the Worker gives up
    if (net.pagespeed === "nofields" && new URL(url).searchParams.has("fields")) {
      return new Response(JSON.stringify({ error: { code: 400, message: "Invalid field selection lighthouseResult/categories/*/score",
        errors: [{ reason: "invalidParameter", location: "fields", locationType: "parameter" }] } }), { status: 400 });
    }
    if (net.pagespeed === "fail") return new Response("nope", { status: 500 });
    const field = net.pagespeed === "field" ? {
      loadingExperience: {
        overall_category: "AVERAGE",
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: "FAST" },
          INTERACTION_TO_NEXT_PAINT: { percentile: 260, category: "AVERAGE" },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" }
        }
      }
    } : {};
    if (net.pagespeed === "quota") return new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded" } }), { status: 429 });
    if (net.pagespeed === "badkey") {
      return new Response(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.",
        details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 });
    }
    return new Response(JSON.stringify(Object.assign(field, {
      lighthouseResult: {
        categories: { seo: { score: 0.82 }, performance: { score: 0.5 }, accessibility: { score: 0.9 }, "best-practices": { score: 1 } },
        audits: {
          "meta-description": { title: "Document does not have a meta description", score: 0, scoreDisplayMode: "binary" },
          "image-alt": { title: "Image elements have [alt] attributes", score: 1, scoreDisplayMode: "binary" }
        }
      }
    })));
  }
  // A stand-in Claude Messages API for the Rehearsal Room's coach.
  if (url === "https://api.anthropic.com/v1/messages" || url.startsWith("https://api.anthropic.com/v1/messages?")) {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    coachCalls.push({ key: headers.get("x-api-key"), beta: headers.get("anthropic-beta"), body });
    if (/senior strategist/.test(JSON.stringify(body.system || ""))) {
      strategyCalls.push({ key: headers.get("x-api-key"), body });
      if (net.strategy === "fail") return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        id: "msg_strategy", type: "message", role: "assistant", model: body.model,
        stop_reason: net.strategy === "refusal" ? "refusal" : "end_turn", stop_sequence: null,
        content: [{ type: "text", text: net.strategy === "refusal" ? "" : JSON.stringify(STRATEGY_READ) }],
        usage: { input_tokens: 5000, output_tokens: 1200 }
      }), { headers: { "content-type": "application/json" } });
    }
    if (/You read one document/.test(JSON.stringify(body.system || ""))) {
      const answer = (stop, text) => new Response(JSON.stringify({
        id: "msg_doc", type: "message", role: "assistant", model: body.model, stop_reason: stop, stop_sequence: null,
        content: [{ type: "text", text }], usage: { input_tokens: 4000, output_tokens: 600 }
      }), { headers: { "content-type": "application/json" } });
      if (net.reader === "refusal") return answer("refusal", "");
      if (net.reader === "garbled") return answer("end_turn", "not json");
      return answer("end_turn", JSON.stringify(net.readerReply || DOC_READING));
    }
    if (net.coach === "fail") return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
    const reply = (stop, text) => new Response(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: body.model, stop_reason: stop, stop_sequence: null,
      stop_details: stop === "refusal" ? { type: "refusal", category: "cyber", explanation: "" } : null,
      content: [{ type: "text", text }], usage: { input_tokens: 900, output_tokens: 700 }
    }), { headers: { "content-type": "application/json" } });
    if (net.coach === "refusal") return reply("refusal", "");
    if (net.coach === "cutoff") return reply("max_tokens", "{\"lenses\": [");
    if (net.coach === "garbled") return reply("end_turn", "not json at all");
    if (net.coach === "incomplete") return reply("end_turn", JSON.stringify(Object.assign({}, COACHING, { lenses: COACHING.lenses.slice(0, 3) })));
    return reply("end_turn", JSON.stringify(COACHING));
  }
  // The sites customers ask to have audited.
  const auditedHost = (() => { try { return /(\.test|(^|\.)example\.com)$/.test(new URL(url).hostname); } catch (e) { return false; } })();
  if (auditedHost) net.siteLog.push(url);
  const page = PAGES[url.replace(/\/$/, "")];
  if (page !== undefined) {
    net.pageFetches.push({ url, redirect: init && init.redirect });
    net.events.push("page");
    if (page === "unreachable") throw new TypeError("fetch failed");
    if (typeof page === "function") return page(init);
    return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  // Any other address on an audited site: robots.txt, the sitemap, a page
  // that is not there. Answered like a real server, with a 404.
  if (auditedHost) return new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  throw new Error("Unexpected outbound fetch in tests: " + url); // never the real network
};

const PAGES = {
  "https://example.com": "<!doctype html><html lang=en><title>Example</title><h1>Hi</h1></html>",
  "https://down.test": "unreachable",
  "https://missing.test": () => new Response("not here", { status: 404, headers: { "Content-Type": "text/html" } }),
  "https://pdf.test": () => new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }),
  "https://moved.test": () => new Response(null, { status: 301, headers: { Location: "https://example.com/" } }),
  "https://sneaky.test": () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } }),
  "https://loop.test": () => new Response(null, { status: 302, headers: { Location: "https://loop.test/" } }),
  // A small host that takes 13 seconds to start answering (the old limit was 12).
  "https://slow.test": async (init) => { await stall(13000, init); net.events.push("page answered"); return htmlResponse(SLOW_HTML); },
  // Hangs the first time it is asked, answers the second.
  "https://flaky.test": async (init) => {
    if (net.pageFetches.filter((x) => x.url === "https://flaky.test/").length === 1) await stall(Infinity, init);
    return htmlResponse(SLOW_HTML);
  },
  // Never answers at all.
  "https://hung.test": (init) => stall(Infinity, init),
  // Sends the head of the page, then stops sending.
  "https://stalls.test": () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("<!doctype html><html lang=en><head><title>Half a page</title>")); }
  }), { headers: { "Content-Type": "text/html" } }),
  // Answers at once, then sends nothing.
  "https://silent.test": () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/html" } }),

  // A small business site for the whole-site audit. (Node's HTML stand-in
  // does not parse pages, so links are found here through the sitemap and the
  // client's extra pages; the workerd suite crawls by links with the real parser.)
  "https://shop.test": () => htmlResponse(SLOW_HTML),
  "https://shop.test/robots.txt": () => new Response("User-agent: *\nDisallow: /internal/\nSitemap: https://shop.test/sitemap.xml\n\nUser-agent: GPTBot\nDisallow: /\n",
    { headers: { "Content-Type": "text/plain" } }),
  "https://shop.test/sitemap.xml": () => new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    ["/", "/about", "/services", "/internal/secret", "/blog/post-1", "/account", "/files/price.pdf"]
      .map((p) => "<url><loc>https://shop.test" + p + "</loc></url>").join("") + "</urlset>", { headers: { "Content-Type": "application/xml" } }),
  "https://shop.test/llms.txt": () => new Response("# Shop\nSolar kits.", { headers: { "Content-Type": "text/plain" } }),
  "http://shop.test": () => new Response(null, { status: 301, headers: { Location: "https://shop.test/" } }),
  "https://www.shop.test": () => new Response(null, { status: 301, headers: { Location: "https://shop.test/" } }),
  "https://shop.test/about": () => htmlResponse(SLOW_HTML),
  "https://shop.test/services": () => htmlResponse(SLOW_HTML),
  "https://shop.test/blog/post-1": () => htmlResponse(SLOW_HTML),
  "https://shop.test/landing": () => htmlResponse(SLOW_HTML),
  "https://shop.test/internal/secret": () => htmlResponse(SLOW_HTML),
  "https://shop.test/account": () => new Response(null, { status: 302, headers: { Location: "https://shop.test/login?next=/account" } }),
  "https://shop.test/admin": () => new Response("no", { status: 403, headers: { "Content-Type": "text/html" } }),
  "https://shop.test/dashboard": () => htmlResponse(SLOW_HTML),
  "https://shop.test/members": () => new Response(SLOW_HTML, { headers: { "Content-Type": "text/html", "X-Robots-Tag": "noindex" } })
};
// A site whose pages are slow, so two calls overlap.
PAGES["https://lag.test"] = () => htmlResponse(SLOW_HTML);
PAGES["https://lag.test/sitemap.xml"] = () => new Response("<urlset>" + Array.from({ length: 8 }, (_, i) => "<url><loc>https://lag.test/q" + (i + 1) + "</loc></url>").join("") + "</urlset>",
  { headers: { "Content-Type": "application/xml" } });
for (let i = 1; i <= 8; i++) PAGES["https://lag.test/q" + i] = async (init) => { await stall(150, init); return htmlResponse(SLOW_HTML); };
// A site where, while a crawl step reads a page, another call moves the
// audit on first (its version changes underneath the step).
PAGES["https://bump.test"] = () => htmlResponse(SLOW_HTML);
PAGES["https://bump.test/sitemap.xml"] = () => new Response("<urlset><url><loc>https://bump.test/p1</loc></url></urlset>", { headers: { "Content-Type": "application/xml" } });
PAGES["https://bump.test/p1"] = () => {
  db.db.prepare("UPDATE audits SET version = version + 1, state = 'links', queue = '[]' WHERE target = 'https://bump.test/'").run();
  return htmlResponse(SLOW_HTML);
};
// A site with more pages than one audit reads.
PAGES["https://big.test"] = () => htmlResponse(SLOW_HTML);
PAGES["https://big.test/sitemap.xml"] = () => new Response("<urlset>" + Array.from({ length: 40 }, (_, i) => "<url><loc>https://big.test/p" + (i + 1) + "</loc></url>").join("") + "</urlset>",
  { headers: { "Content-Type": "application/xml" } });
for (let i = 1; i <= 40; i++) PAGES["https://big.test/p" + i] = () => htmlResponse(SLOW_HTML);

/* ------------------------------------------------------------- harness */

const ORIGIN = "https://speakpower-commits.github.io";
const db = new FakeD1();
db.db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
// Every account in the older tests has finished both sign-up steps, without
// briefing GRIOT, so they exercise exactly what they did before profiles
// existed. The profile tests delete this row to start from a bare account.
const PROFILE_TRIGGER = `CREATE TRIGGER test_profile_for_every_account AFTER INSERT ON users BEGIN
  INSERT INTO profiles (user_id, name, expertise, position, company, problem, goal, step1_at, step2_at, created_at, updated_at)
  VALUES (NEW.id, 'Test', 'Testing', 'Tester', 'Test Co', 'A problem', 'A goal', NEW.created_at, NEW.created_at, NEW.created_at, NEW.created_at);
END`;
db.db.exec(PROFILE_TRIGGER);

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
  ENVIRONMENT: "production",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
  // A stand-in Workers AI: Whisper's output shape, with word timings.
  AI: {
    // Workers AI's document converter: a "PDF" here is "%PDF-1.4" followed by
    // pages separated by form feeds, returned with its "### Page N" headings.
    async toMarkdown(doc, opts) {
      markdownCalls.push({ name: doc.name, type: doc.blob.type, opts });
      if (net.toMarkdown === "fail") throw new Error("conversion failed");
      if (net.toMarkdown === "error") return { name: doc.name, format: "error", error: "unsupported" };
      const raw = new TextDecoder().decode(new Uint8Array(await doc.blob.arrayBuffer())).replace(/^%PDF-1\.4\n/, "");
      const data = raw.split("\f").map((p, i) => "### Page " + (i + 1) + "\n" + p).join("\n\n");
      return { name: doc.name, mimeType: doc.blob.type, format: "markdown", tokens: 0, data };
    },
    async run(model, input) {
      whisperCalls.push({ model, input });
      if (net.whisper === "fail") throw new Error("AiError: could not decode audio");
      if (net.whisper === "silent") return { text: " ", segments: [] };
      if (net.whisper === "nowords") return heardWithoutWordTimes();
      return HEARD;
    }
  }
};

// 150 words at 0.4 s each, with one 3-second pause after word 75: 63 s of
// speech. Two "um"s and one "you know" are in the text.
const HEARD = (() => {
  const words = [];
  let t = 0.5;
  for (let i = 0; i < 150; i++) {
    if (i === 75) t += 3;
    const w = i === 10 || i === 40 ? "um" : i === 100 ? "you" : i === 101 ? "know" : "word";
    words.push({ word: " " + w, start: t, end: t + 0.35 });
    t += 0.4;
  }
  const sentences = [];
  for (let i = 0; i < 150; i += 25) sentences.push(words.slice(i, i + 25).map((w) => w.word.trim()).join(" ") + ".");
  return {
    text: sentences.join(" "),
    word_count: 150,
    segments: [{ start: words[0].start, end: words[74].end, text: "", words: words.slice(0, 75) },
               { start: words[75].start, end: words[149].end, text: "", words: words.slice(75) }]
  };
})();
function heardWithoutWordTimes() {
  return { text: HEARD.text, segments: HEARD.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
}
const AUDIO = "QUJD".repeat(1000); // 4,000 base64 characters of stand-in audio

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
  ok(r.data.sections.some((x) => x[0] === "Summary"), "SpeakPower checks delivered");
  eq(r.data.account.trialsRemaining, 1);
  eq(r.data.audit.state, "links", "a site with no other pages goes straight to the link check");
  for (const stage of ["crawl", "crawl", "lighthouse"]) await call("POST", "/studio/audit/run", { token: alice.token, body: { id: r.data.audit.id, stage } });
  const got = await call("GET", "/studio/audit?id=" + r.data.audit.id, { token: alice.token });
  ok(/not switched on/.test(got.data.report.lighthouse.reason), "explains the missing scores");
  eq(got.data.audit.lighthouse, "unavailable", "no 'try again' for something that cannot work");
  eq(net.pagespeedCalls.length, 0, "still no keyless call");
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

// A plan period written directly: what a settled plan payment leaves behind,
// for tests about spending rather than paying.
let planRef = 0;
const LIMITS = { starter: [120, 20, 0, 0], pro: [300, 60, 1, 15] };
function givePlan(email, plan = "starter", over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const [g, r, p, d] = LIMITS[plan];
  const row = Object.assign({
    starts_at: now - 60, ends_at: now + 30 * 86400, griot_limit: g, rehearsal_limit: r, pack_limit: p,
    pack_discount: d, griot_used: 0, rehearsal_used: 0, packs_used: 0
  }, over);
  db.db.prepare(
    "INSERT INTO subscriptions (user_id, plan, starts_at, ends_at, griot_limit, rehearsal_limit, pack_limit, " +
    "pack_discount, griot_used, rehearsal_used, packs_used, tx_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(userId(email), plan, row.starts_at, row.ends_at, row.griot_limit, row.rehearsal_limit, row.pack_limit,
    row.pack_discount, row.griot_used, row.rehearsal_used, row.packs_used, "test-plan-" + (++planRef), now);
}
function periodOf(email) {
  return db.db.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC").get(userId(email));
}
function noTrials(email) {
  db.db.prepare("UPDATE users SET trials_remaining = 0 WHERE email_canonical = ?").run(email.toLowerCase());
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

await test("griot: fourth message offers the plans — never a per-message price — and GRIOT is not called", async () => {
  const s = await call("POST", "/auth/start", { body: { email: "g-three@example.com", turnstileToken: "pass" } });
  eq(s.status, 200);
  const v = await call("POST", "/auth/verify", { body: { email: "g-three@example.com", code: lastCodeFor("g-three@example.com") } });
  griotCalls.length = 0;
  const r = await chat(v.data.token, "one more");
  eq(r.status, 402, "status"); eq(r.data.error, "plan_required");
  eq(r.data.service, "griot");
  ok(!("price" in r.data) && !("shortfall" in r.data), "no per-message price");
  ok(!/UGX|per message/i.test(r.data.message), "the wall names no unit price: " + r.data.message);
  eq(r.data.plans.map((x) => x.key + ":" + x.price).join(","), "starter:60000,pro:150000", "the plans on offer");
  eq(griotCalls.length, 0, "an account without a plan never reaches GRIOT");
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
      tenantId: victimId, tenant_id: victimId, project: "global"
    })
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  eq(res.status, 200);
  const c = griotCalls[0];
  eq(c.tenant, userRow("g-attacker@example.com").id, "tenant is the attacker's own id");
  ok(c.tenant !== victimId, "never the victim's id");
  eq(c.key, "griot-server-key", "forged key header ignored");
  ok(!("project" in c.body), "General is never forwarded as a project");
  ok(victim.token, "victim account exists");
  // One of the operator's ventures is refused outright, before anything is spent.
  const venture = await chat(attacker.token, "file it under a venture", { project: "speakpower" });
  eq(venture.status, 400); eq(venture.data.error, "unknown_project");
  eq(griotCalls.length, 1, "never reaches GRIOT");
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

await test("griot: a plan carries on after the free tries; the account shows a share of the month, never a count", async () => {
  const s = await signUp("g-paid@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 5000 WHERE email_canonical = ?")
    .run("g-paid@example.com");
  givePlan("g-paid@example.com", "starter");
  const r = await chat(s.token, "plan question");
  eq(r.status, 200); eq(r.data.paidWith, "plan"); ok(!("amount" in r.data), "no amount on a GRIOT answer");
  eq(r.data.account.balance, 5000, "the balance is never touched by GRIOT");
  const m = r.data.account.membership;
  eq(m.plan, "starter"); eq(m.name, "Starter"); eq(m.usage.griot, 1, "1 of 120 shows as 1%");
  ok(!/_used|_limit/.test(JSON.stringify(m)), "no raw counts in the membership");
  eq(periodOf("g-paid@example.com").griot_used, 1);
});

await test("griot: a plan message that fails gives back the use", async () => {
  const s = await signUp("g-paidfail@example.com");
  noTrials("g-paidfail@example.com");
  givePlan("g-paidfail@example.com", "starter", { griot_used: 7 });
  net.griot = "fail";
  const r = await chat(s.token, "hello");
  net.griot = "ok";
  eq(r.status, 502); ok(/not charged/.test(r.data.message));
  eq(periodOf("g-paidfail@example.com").griot_used, 7, "the use is back");
  eq(userRow("g-paidfail@example.com").trials_remaining, 0, "and no free try invented");
  const run = griotRuns("g-paidfail@example.com")[0];
  eq(run.paid_with, "plan"); eq(run.amount, 0); eq(run.status, "refunded");
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
  eq(last.data.account.plans.map((x) => x.key).join(","), "starter,pro", "and the plans ride along too");
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

await test("griot: parallel sends never pass the plan's fair-use limit; the wall then names the renewal and Pro", async () => {
  const email = "g-race-paid@example.com";
  const s = await signUp(email);
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 900000 WHERE email_canonical = ?").run(email);
  givePlan(email, "starter", { griot_limit: 2 });
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => chat(s.token, "race " + i)));
  eq(results.filter((r) => r.status === 200).length, 2, "exactly the two the plan allows");
  eq(periodOf(email).griot_used, 2, "never past the limit");
  eq(userRow(email).balance, 900000, "a balance never pays for GRIOT");
  const wall = results.find((r) => r.status === 402).data;
  eq(wall.error, "plan_required");
  ok(/renews on \d{1,2} [A-Z][a-z]{2}/.test(wall.message) && /Pro/.test(wall.message), wall.message);
  eq(wall.account.membership.usage.griot, 100);
});

/* ----------------------------------------------------- GRIOT workspace */

function ws(token, method, path, body) {
  return call(method, path, { token, body });
}

await test("griot workspace: lenses and the 9 steps come from GRIOT, cached; its /projects is never asked for", async () => {
  const s = await signUp("w-catalogue@example.com");
  griotWsCalls.length = 0;
  const a = await ws(s.token, "GET", "/griot/workspace");
  const b = await ws(s.token, "GET", "/griot/workspace");
  eq(a.status, 200); eq(a.data.ready, true);
  eq(a.data.lenses.length, 9); eq(a.data.lenses[0].key, "story"); eq(a.data.lenses[0].name, "Story");
  eq(a.data.steps.join(","), GRIOT_STEPS.join(","));
  eq(JSON.stringify(b.data), JSON.stringify(a.data));
  eq(griotWsCalls.filter((c) => c.path === "/agents").length <= 1, true, "catalogue cached");
  ok(!griotWsCalls.some((c) => c.path.startsWith("/projects")), "the operator's ventures are never requested");
  eq((await ws(null, "GET", "/griot/workspace")).status, 401, "signed out");
});

await test("griot workspace: memories are listed, added and deleted within one account only", async () => {
  const a = await signUp("w-mem-a@example.com");
  const b = await signUp("w-mem-b@example.com");
  const venture = await ws(a.token, "POST", "/griot/memory", { title: "Sneaky", content: "x", project: "speakpower" });
  eq(venture.status, 400, "the operator's ventures are never a client's to choose"); eq(venture.data.error, "unknown_project");
  ok(!griotStore.memories.some((m) => m.title === "Sneaky"), "and nothing reaches GRIOT");
  const added = await ws(a.token, "POST", "/griot/memory", { title: "Our runway", content: "Nine months of cash.", confidence: "hypothesis" });
  eq(added.status, 200); eq(added.data.memory.title, "Our runway"); eq(added.data.memory.confidence, "fact", "what a client tells GRIOT is a fact");
  const stored = griotStore.memories.find((m) => m.id === added.data.memory.id);
  eq(stored.project, "global", "without a project, General"); eq(stored.tenant_id, userId("w-mem-a@example.com"));
  ok(!("tenant_id" in added.data.memory) && !("project" in added.data.memory), "no tenant or project echoed back");
  const listA = (await ws(a.token, "GET", "/griot/memories")).data.memories.map((m) => m.title);
  const listB = (await ws(b.token, "GET", "/griot/memories")).data.memories.map((m) => m.title);
  ok(listA.includes("Our runway") && !listB.includes("Our runway"), JSON.stringify({ listA, listB }));
  const steal = await ws(b.token, "POST", "/griot/memories/delete", { id: added.data.memory.id });
  eq(steal.status, 404, "another account's memory looks missing");
  ok(griotStore.memories.some((m) => m.id === added.data.memory.id), "and is still there");
  eq((await ws(a.token, "POST", "/griot/memories/delete", { id: added.data.memory.id })).status, 200);
  ok(!griotStore.memories.some((m) => m.id === added.data.memory.id), "deleted by its owner");
  eq((await ws(a.token, "POST", "/griot/memories/delete", { id: "../projects" })).status, 400, "ids are checked");
  eq((await ws(a.token, "POST", "/griot/memory", { title: "", content: "x" })).status, 400);
});

await test("griot workspace: conversations and decisions belong to the account that had them", async () => {
  const a = await signUp("w-conv-a@example.com");
  const b = await signUp("w-conv-b@example.com");
  const first = await chat(a.token, "Where should Q1 go?");
  await chat(a.token, "And Q2?", { threadId: first.data.threadId });
  await chat(b.token, "B's private question");
  const threads = (await ws(a.token, "GET", "/griot/threads")).data.threads;
  eq(threads.length, 1, "only A's conversation"); eq(threads[0].firstQuestion, "Where should Q1 go?"); eq(threads[0].messages, 4);
  const t = await call("GET", "/griot/thread?id=" + first.data.threadId, { token: a.token });
  eq(t.status, 200); eq(t.data.messages.length, 4); eq(t.data.messages[0].role, "user");
  eq((await call("GET", "/griot/thread?id=" + first.data.threadId, { token: b.token })).status, 404, "B cannot open A's thread");
  eq((await call("GET", "/griot/thread?id=not-a-uuid", { token: a.token })).status, 400);
  const decisions = (await ws(a.token, "GET", "/griot/decisions")).data.decisions;
  eq(decisions.map((d) => d.question).join("|"), "Where should Q1 go?|And Q2?");
  ok(!(await ws(b.token, "GET", "/griot/decisions")).data.decisions.some((d) => /Q1/.test(d.question)), "B never sees A's decisions");
});

await test("griot workspace: the browser cannot choose the tenant on any workspace route", async () => {
  const victim = await signUp("w-victim@example.com");
  const attacker = await signUp("w-attacker@example.com");
  const victimId = userId("w-victim@example.com");
  griotWsCalls.length = 0;
  for (const [method, path, body] of [["GET", "/griot/memories"], ["GET", "/griot/threads"], ["GET", "/griot/decisions"],
    ["POST", "/griot/memory", { title: "t", content: "c", tenantId: victimId }]]) {
    const res = await worker.fetch(new Request("https://api.test" + path, {
      method, headers: { Origin: ORIGIN, "Content-Type": "application/json", Authorization: "Bearer " + attacker.token, "X-Tenant-Id": victimId },
      body: body ? JSON.stringify(body) : undefined
    }), env, { waitUntil() {} });
    eq(res.status, 200, path);
  }
  ok(griotWsCalls.length >= 4 && griotWsCalls.every((c) => c.tenant === userId("w-attacker@example.com")), "always the signed-in account's own id");
  ok(victim.token, "victim exists");
});

await test("griot chat: chosen lenses are checked before anything is spent, and every client turn is bounded", async () => {
  const email = "w-lens@example.com";
  const s = await signUp(email);
  griotCalls.length = 0;
  const r = await chat(s.token, "Price our new plan", { lenses: ["data", "market"] });
  eq(r.status, 200); eq(r.data.agents.join(","), "DataAgent,MarketAgent");
  const sent = griotCalls[0].body;
  eq(JSON.stringify(sent.lenses), '["data","market"]');
  eq(sent.effort, "medium"); eq(sent.max_output_tokens, 8000);
  const plain = await chat(s.token, "No lenses this time");
  eq(griotCalls[1].body.effort, "medium"); ok(!("lenses" in griotCalls[1].body), "routing left to GRIOT");
  const before = userRow(email).trials_remaining;
  for (const bad of [["projects"], ["data", "market", "story", "brand"], ["../agents"]]) {
    const x = await chat(s.token, "bad lens", { lenses: bad });
    eq(x.status, 400, JSON.stringify(bad)); eq(x.data.error, "unknown_lens");
  }
  eq(userRow(email).trials_remaining, before, "a refused question costs nothing");
  eq(griotCalls.length, 2, "and never reaches GRIOT");
  ok(plain.status === 200);
});

await test("griot workspace: a GRIOT without the workspace keeps it hidden, and chat still works", async () => {
  const s = await signUp("w-plain@example.com");
  env.GRIOT_API_BASE = "https://griot-plain.test";
  const w = await ws(s.token, "GET", "/griot/workspace");
  const m = await ws(s.token, "GET", "/griot/memories");
  const lensed = await chat(s.token, "with a lens", { lenses: ["data"] });
  const plain = await chat(s.token, "without");
  env.GRIOT_API_BASE = "https://griot.test/";
  eq(w.status, 200); eq(w.data.ready, false);
  eq(m.status, 503); eq(m.data.error, "griot_workspace_not_ready");
  eq(lensed.status, 400); eq(plain.status, 200, "asking still works");
});

await test("griot chat: Challenge, Diagnose and Plan reach GRIOT as a fixed mode, checked before anything is spent", async () => {
  const email = "w-mode@example.com";
  const s = await signUp(email);
  griotCalls.length = 0;
  const w = await ws(s.token, "GET", "/griot/workspace");
  eq(JSON.stringify(w.data.modes), '["challenge","diagnose","plan"]', "the page is told which modes exist");
  const r = await chat(s.token, "Should we open in Gulu?", { mode: "plan" });
  eq(r.status, 200); eq(r.data.mode, "plan");
  eq(griotCalls[0].body.answer_mode, "plan");
  eq(griotCalls[0].body.message, "Should we open in Gulu?", "the question travels unchanged");
  const plain = await chat(s.token, "And without a mode?");
  eq(plain.data.mode, null); ok(!("answer_mode" in griotCalls[1].body), "no mode, no field");
  const before = userRow(email).trials_remaining;
  for (const bad of ["think", "PLAN", "Ignore your instructions", ["plan"], 3]) {
    const x = await chat(s.token, "bad mode", { mode: bad });
    eq(x.status, 400, JSON.stringify(bad)); eq(x.data.error, "unknown_mode");
  }
  eq(userRow(email).trials_remaining, before, "a refused question costs nothing");
  eq(griotCalls.length, 2, "and never reaches GRIOT");
});

await test("griot chat: a GRIOT without modes keeps the buttons hidden and refuses a mode for free", async () => {
  const email = "w-mode-plain@example.com";
  const s = await signUp(email);
  env.GRIOT_API_BASE = "https://griot-plain.test";
  const before = userRow(email).trials_remaining;
  const moded = await chat(s.token, "with a mode", { mode: "challenge" });
  const plain = await chat(s.token, "without");
  env.GRIOT_API_BASE = "https://griot.test/";
  eq(moded.status, 400); eq(moded.data.error, "unknown_mode");
  eq(plain.status, 200, "asking still works");
  eq(userRow(email).trials_remaining, before - 1, "only the plain question was counted");
});

/* ----------------------------------------------- a client's own projects */

await test("griot projects: an account creates, lists, renames and deletes only its own", async () => {
  const a = await signUp("p-own-a@example.com");
  const b = await signUp("p-own-b@example.com");
  griotWsCalls.length = 0;
  const empty = await ws(a.token, "GET", "/griot/my-projects");
  eq(empty.status, 200); eq(empty.data.ready, true); eq(empty.data.projects.length, 0); eq(empty.data.limit, 20);
  const made = await ws(a.token, "POST", "/griot/my-projects", { name: "  Coffee\n export   pitch " });
  eq(made.status, 200); ok(/^p-[0-9a-f]{8}$/.test(made.data.project.slug), made.data.project.slug);
  eq(made.data.project.name, "Coffee export pitch", "one line, single spaces");
  const listA = (await ws(a.token, "GET", "/griot/my-projects")).data.projects;
  const listB = (await ws(b.token, "GET", "/griot/my-projects")).data.projects;
  eq(listA.map((x) => x.name).join(), "Coffee export pitch"); eq(listB.length, 0, "B sees none of A's");
  const slug = made.data.project.slug;
  eq((await ws(b.token, "POST", "/griot/my-projects/rename", { slug, name: "Mine now" })).status, 404, "B cannot rename A's");
  eq((await ws(b.token, "POST", "/griot/my-projects/delete", { slug })).status, 404, "B cannot delete A's");
  const renamed = await ws(a.token, "POST", "/griot/my-projects/rename", { slug, name: "Buyer pitch" });
  eq(renamed.status, 200); eq(renamed.data.project.name, "Buyer pitch");
  eq((await ws(a.token, "POST", "/griot/my-projects/delete", { slug })).status, 200);
  eq((await ws(a.token, "GET", "/griot/my-projects")).data.projects.length, 0);
  ok(griotWsCalls.every((c) => c.tenant === userId("p-own-a@example.com") || c.tenant === userId("p-own-b@example.com") || c.tenant === "catalogue"),
    "always the signed-in account's own tenant");
  ok(!griotWsCalls.some((c) => c.path.startsWith("/projects")), "the operator's ventures are never requested");
  for (const bad of ["global", "speakpower", "../projects", "p-XYZ", ""]) {
    const r = await ws(a.token, "POST", "/griot/my-projects/delete", { slug: bad });
    eq(r.status, 400, JSON.stringify(bad));
  }
  eq((await ws(a.token, "POST", "/griot/my-projects", { name: "   " })).status, 400, "a name is required");
  eq((await ws(null, "GET", "/griot/my-projects")).status, 401, "signed out");
});

await test("griot projects: GRIOT's /projects (the operator's ventures) stays unreachable", async () => {
  const s = await signUp("p-ventures@example.com");
  for (const method of ["GET", "POST"]) {
    eq((await ws(s.token, method, "/griot/projects", method === "POST" ? { name: "x" } : undefined)).status, 404, method);
  }
});

await test("griot projects: at most 20 per account, checked here and by GRIOT", async () => {
  const s = await signUp("p-many@example.com");
  net.griotProjectCap = 100; // the Worker's own check, on its own
  let over;
  try {
    for (let i = 0; i < 20; i++) eq((await ws(s.token, "POST", "/griot/my-projects", { name: "Project " + i })).status, 200, String(i));
    over = await ws(s.token, "POST", "/griot/my-projects", { name: "One too many" });
  } finally { delete net.griotProjectCap; }
  eq(over.status, 409); eq(over.data.error, "project_limit"); ok(/up to 20 projects/.test(over.data.message), over.data.message);
  eq((await ws(s.token, "GET", "/griot/my-projects")).data.projects.length, 20, "the 21st was never created");
  // GRIOT's own limit reads the same, should the two ever disagree.
  const t = await signUp("p-cap@example.com");
  net.griotProjectCap = 1;
  try {
    eq((await ws(t.token, "POST", "/griot/my-projects", { name: "First" })).status, 200);
    const capped = await ws(t.token, "POST", "/griot/my-projects", { name: "Second" });
    eq(capped.status, 409); eq(capped.data.error, "project_limit");
  } finally { delete net.griotProjectCap; }
});

await test("griot projects: a question is filed under the account's own project, and the lists follow it", async () => {
  const email = "p-chat@example.com";
  const s = await signUp(email);
  const other = await signUp("p-chat-other@example.com");
  const slug = (await ws(s.token, "POST", "/griot/my-projects", { name: "Donor pitch" })).data.project.slug;
  griotCalls.length = 0;
  const inProject = await chat(s.token, "Filed under the pitch", { project: slug });
  eq(inProject.status, 200); eq(inProject.data.project, slug);
  eq(griotCalls[0].body.project, slug, "sent to GRIOT");
  const general = await chat(s.token, "Filed in General", { project: "global" });
  eq(general.data.project, "global"); ok(!("project" in griotCalls[1].body), "General is never sent as a project");
  await chat(s.token, "No project at all");
  ok(!("project" in griotCalls[2].body));

  const threads = (await ws(s.token, "GET", "/griot/threads?project=" + slug)).data.threads;
  eq(threads.map((t) => t.firstQuestion).join("|"), "Filed under the pitch"); eq(threads[0].project, slug);
  const generalThreads = (await ws(s.token, "GET", "/griot/threads?project=global")).data.threads;
  eq(generalThreads.length, 2); ok(generalThreads.every((t) => t.project === "global"));
  eq((await ws(s.token, "GET", "/griot/threads")).data.threads.length, 3, "no filter, everything");
  eq((await ws(s.token, "GET", "/griot/decisions?project=" + slug)).data.decisions.map((d) => d.question).join(), "Filed under the pitch");
  eq((await ws(s.token, "GET", "/griot/threads?project=speakpower")).status, 400, "a venture is not a filter");

  const fact = await ws(s.token, "POST", "/griot/memory", { title: "Deadline", content: "31 March", project: slug });
  eq(fact.status, 200);
  eq(griotStore.memories.find((m) => m.id === fact.data.memory.id).project, slug);
  const mem = (await ws(s.token, "GET", "/griot/memories?project=" + slug)).data.memories.map((m) => m.title);
  ok(mem.includes("Deadline"), JSON.stringify(mem));

  // Another account holding the slug: GRIOT refuses, and the use comes back.
  const before = userRow("p-chat-other@example.com").trials_remaining;
  const stolen = await chat(other.token, "Using A's project", { project: slug });
  eq(stolen.status, 400); ok(/project could not be found/.test(stolen.data.message), stolen.data.message);
  ok(/not charged/.test(stolen.data.message), stolen.data.message);
  eq(userRow("p-chat-other@example.com").trials_remaining, before, "given back");
  eq((await ws(other.token, "POST", "/griot/memory", { title: "x", content: "y", project: slug })).status, 400);

  // A bad shape never reaches GRIOT and costs nothing.
  const calls = griotCalls.length;
  const was = userRow(email).trials_remaining;
  for (const bad of ["speakpower", "tonninyira", "P-1234ABCD", "p-123", ["p-12345678"], "../x"]) {
    const r = await chat(s.token, "bad project", { project: bad });
    eq(r.status, 400, JSON.stringify(bad)); eq(r.data.error, "unknown_project");
  }
  eq(griotCalls.length, calls, "never reaches GRIOT"); eq(userRow(email).trials_remaining, was, "and costs nothing");
});

await test("griot projects: before GRIOT keeps projects, the picker stays hidden and General works", async () => {
  const email = "p-noproj@example.com";
  const s = await signUp(email);
  env.GRIOT_API_BASE = "https://griot-noproj.test";
  try {
    const list = await ws(s.token, "GET", "/griot/my-projects");
    eq(list.status, 200); eq(list.data.ready, false); eq(list.data.projects.length, 0);
    eq((await ws(s.token, "POST", "/griot/my-projects", { name: "x" })).status, 503);
    const before = userRow(email).trials_remaining;
    const r = await chat(s.token, "in a project", { project: "p-12345678" });
    eq(r.status, 400); eq(r.data.error, "unknown_project");
    eq(userRow(email).trials_remaining, before, "refused for free");
    eq((await chat(s.token, "in General")).status, 200, "asking still works");
    const all = await ws(s.token, "GET", "/griot/threads?project=global");
    eq(all.status, 200); ok(!griotWsCalls.some((c) => c.path.includes("project=") && c.tenant === userId(email)), "lists are not filtered yet");
  } finally { env.GRIOT_API_BASE = "https://griot.test/"; }
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
await test("prices: Studio packs cost exactly what studio.html shows; GRIOT and rehearsals come with a plan", async () => {
  const s = await signUp("p-list@example.com");
  const r = await call("GET", "/account", { token: s.token });
  eq(r.status, 200);
  PRICES = r.data.prices;
  const keys = Object.keys(PRICES).sort().join(",");
  eq(keys, "brand-story,content-seo,data-story,market-plan,seo-audit,speaker-ready", "every pack priced, nothing else");
  for (const [key, amount] of Object.entries(PRICES)) {
    ok(Number.isInteger(amount) && amount > 0, key + " has a whole-shilling price");
    ok(cardPrice(key).startsWith(ugx(amount)),
      key + ": studio.html shows " + JSON.stringify(cardPrice(key)) + " but the Worker charges " + ugx(amount));
  }
  for (const key of ["griot", "rehearsal"]) {
    ok(/^Included in every plan/.test(cardPrice(key)), key + " card: " + JSON.stringify(cardPrice(key)));
  }
  ok(/^Free\b/.test(cardPrice("clarity-audit")), "the Clarity Audit card says it is free");
  // Every catalog card is either a priced pack, a plan service, or the free
  // audit — no card can sell something the Worker would refuse.
  const cards = [...STUDIO_HTML.matchAll(/id="product-([a-z-]+)"/g)].map((m) => m[1]).sort().join(",");
  eq(cards, Object.keys(PRICES).concat(["clarity-audit", "griot", "rehearsal"]).sort().join(","), "catalog cards");
});

await test("plans: plans.html, studio.html and the Worker agree on every plan price", async () => {
  const r = await call("GET", "/plans");
  eq(r.status, 200, "public, no sign-in");
  eq(r.data.plans.map((x) => x.key + ":" + x.price + ":" + x.days).join(","), "starter:60000:30,pro:150000:30");
  const html = readFileSync(join(here, "..", "..", "plans.html"), "utf8");
  for (const plan of r.data.plans) {
    const card = html.match(new RegExp('<article[^>]*id="plan-' + plan.key + '"[^>]*>([\\s\\S]*?)</article>'));
    ok(card, "plans.html has a card for " + plan.key);
    const price = card[1].match(/<div class="plan-price">([\s\S]*?)<\/div>/);
    ok(price && price[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().startsWith(ugx(plan.price)),
      plan.key + " price on plans.html");
  }
  ok(cardPrice("griot").includes(ugx(r.data.plans[0].price)), "Studio names the lowest plan price");
});

await test("prices: no page quotes a per-message or per-rehearsal price", async () => {
  const root = join(here, "..", "..");
  const files = readdirSync(root).filter((f) => /\.(html|js|txt|md|xml)$/.test(f));
  ok(files.length > 15, "scanned the site's files");
  const bad = [
    /UGX\s*[\d,]+\s*(?:a|per|each)\s*(?:message|question|rehearsal)/i,
    /per message/i,
    /\b2,500\b/,
    /UGX 5,000/
  ];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    for (const re of bad) ok(!re.test(text), f + " still matches " + re + ": " + (text.match(re) || [""])[0]);
  }
  ok(!/var PRICE\b/.test(readFileSync(join(root, "griot-app.js"), "utf8")), "griot-app.js has no message price");
});

await test("prices: the builder page quotes the same pack prices", async () => {
  const builder = readFileSync(join(here, "..", "..", "studio-product.js"), "utf8");
  for (const [key, amount] of Object.entries(PRICES)) {
    const m = builder.match(new RegExp('"' + key + '": \\{\\s*title: "[^"]+",\\s*price: (\\d+)'));
    ok(m, "studio-product.js prices " + key);
    eq(Number(m[1]), amount, "studio-product.js price for " + key);
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
  if (service === "rehearsal") return rehearse(token);
  return service === "griot"
    ? chat(token, "a paid question")
    : call("POST", "/studio/generate", { token, body: { product: service, inputs: inputs || INPUTS[service] } });
}
function rehearse(token, over) {
  return call("POST", "/rehearse", { token, body: Object.assign({ moment: "investor-pitch", audio: AUDIO, seconds: 64 }, over) });
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

await test("prices: a failed use gives back exactly what it took — the shillings, or the plan's use", async () => {
  const s = await signUp("p-refund@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 300000 WHERE email_canonical = ?").run("p-refund@example.com");
  givePlan("p-refund@example.com", "starter");
  const failedAudit = await use(s.token, "seo-audit", { url: "https://down.test" });
  net.griot = "fail";
  const msg = await use(s.token, "griot");
  net.griot = "ok";
  eq(failedAudit.status, 502); eq(msg.status, 502);
  eq(userRow("p-refund@example.com").balance, 300000, "the pack refunded in full");
  eq(periodOf("p-refund@example.com").griot_used, 0, "the GRIOT use given back");
  const runs = db.q("SELECT product, paid_with, amount, status FROM runs WHERE user_id = ? ORDER BY id", userId("p-refund@example.com"));
  eq(JSON.stringify(runs), JSON.stringify([
    { product: "seo-audit", paid_with: "balance", amount: 150000, status: "refunded" },
    { product: "griot", paid_with: "plan", amount: 0, status: "refunded" }
  ]));
});

await test("plans: Pro includes one Studio pack, then 15% off from the balance", async () => {
  const email = "p-pro@example.com";
  const s = await signUp(email);
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 200000 WHERE email_canonical = ?").run(email);
  givePlan(email, "pro");
  const first = await use(s.token, "market-plan");
  eq(first.status, 200); eq(first.data.paidWith, "plan"); eq(first.data.amount, 0, "the included pack");
  eq(first.data.account.membership.packsLeft, 0);
  const second = await use(s.token, "market-plan");
  eq(second.data.paidWith, "balance"); eq(second.data.amount, 106250, "125,000 less 15%");
  const third = await use(s.token, "brand-story");
  eq(third.data.amount, 85000); eq(third.data.account.balance, 8750);
  const wall = await use(s.token, "brand-story");
  eq(wall.status, 402); eq(wall.data.error, "payment_required");
  eq(wall.data.price, 85000, "the wall quotes the member's price"); eq(wall.data.shortfall, 76250);
});

await test("plans: a period that has ended, or not yet begun, covers nothing", async () => {
  const email = "p-dates@example.com";
  const s = await signUp(email);
  noTrials(email);
  const now = Math.floor(Date.now() / 1000);
  givePlan(email, "starter", { starts_at: now - 31 * 86400, ends_at: now - 86400 });
  givePlan(email, "starter", { starts_at: now + 86400, ends_at: now + 31 * 86400 });
  const r = await chat(s.token, "anyone there?");
  eq(r.status, 402); eq(r.data.error, "plan_required");
  const m = r.data.account.membership;
  eq(m.plan, null, "nothing in force today"); ok(m.next && m.next.plan === "starter", "the paid renewal is shown as next");
});

await test("plans: the account says renew soon in the last three days, unless the renewal is paid", async () => {
  const email = "p-soon@example.com";
  const s = await signUp(email);
  const now = Math.floor(Date.now() / 1000);
  givePlan(email, "starter", { starts_at: now - 28 * 86400, ends_at: now + 2 * 86400 });
  const a = (await call("GET", "/me", { token: s.token })).data.account.membership;
  eq(a.renewSoon, true, "two days left");
  givePlan(email, "starter", { starts_at: now + 2 * 86400, ends_at: now + 32 * 86400 });
  const b = (await call("GET", "/me", { token: s.token })).data.account.membership;
  eq(b.renewSoon, false, "already renewed"); eq(b.paidUntil, now + 32 * 86400);
});

await test("prices: three free tries in any mix of services, then the balance", async () => {
  const s = await signUp("p-mix@example.com");
  const free = [];
  for (const service of ["griot", "market-plan", "seo-audit"]) {
    const r = await use(s.token, service);
    eq(r.status, 200, service);
    eq(r.data.paidWith, "trial", service + " is free"); eq(r.data.amount || 0, 0);
    free.push(r.data.account.trialsRemaining);
  }
  eq(free.join(","), "2,1,0", "one shared allowance, counting down");
  const fourth = await use(s.token, "griot");
  eq(fourth.status, 402, "GRIOT now needs a plan"); eq(fourth.data.error, "plan_required");
  const pack = await use(s.token, "market-plan");
  eq(pack.status, 402, "a pack now needs the balance"); eq(pack.data.error, "payment_required");
  eq(pack.data.price, 125000); eq(pack.data.shortfall, 125000);
});

/* ------------------------------------- SEO audit: the Google layer, keyed */

async function audit(token, url = "https://example.com") {
  return call("POST", "/studio/generate", { token, body: { product: "seo-audit", inputs: { url } } });
}

// A whole audit, stage by stage, as the page runs it: start, crawl until
// done, then Lighthouse and the strategic read side by side, then the report.
async function runAudit(token, url = "https://example.com", opts = {}) {
  const start = await call("POST", "/studio/generate", { token, body: { product: "seo-audit", inputs: { url, extra: opts.extra } } });
  if (start.status !== 200) return { start };
  const id = start.data.audit.id;
  const steps = [];
  let progress = start.data.audit;
  for (let guard = 0; progress.state !== "done" && guard < 30; guard++) {
    const r = await call("POST", "/studio/audit/run", { token, body: { id, stage: "crawl" } });
    eq(r.status, 200, "crawl step");
    steps.push(r.data.audit);
    progress = r.data.audit;
  }
  const [lighthouse, strategy] = opts.skipFinal ? [null, null] : await Promise.all(["lighthouse", "strategy"]
    .map((stage) => call("POST", "/studio/audit/run", { token, body: { id, stage } })));
  const got = await call("GET", "/studio/audit?id=" + encodeURIComponent(id), { token });
  return { start, id, steps, lighthouse, strategy, report: got.data.report, progress: got.data.audit, got };
}
const lighthouseOf = (a) => a.report.lighthouse;
const checkOf = (a, label) => a.report.checks.find((c) => c.label === label);

await test("seo: with a key, Lighthouse runs as its own stage; scores and findings added, key sent server-side only", async () => {
  const s = await signUp("seo-key@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeedCalls.length = 0;
  const a = await runAudit(s.token);
  eq(a.start.status, 200);
  ok(/once the whole site has been read/.test(a.start.data.sections.find((x) => /^Google Lighthouse/.test(x[0]))[1]), "the start says Lighthouse comes later");
  eq(net.pagespeedCalls.length, 1, "one Google call, in the Lighthouse stage");
  const call0 = new URL(net.pagespeedCalls[0]);
  eq(call0.searchParams.get("key"), "psi-test-key"); eq(call0.searchParams.get("strategy"), "mobile");
  eq(call0.searchParams.get("url"), "https://example.com/");
  eq(call0.searchParams.getAll("category").join(","), "seo,performance,accessibility,best-practices");
  const lh = lighthouseOf(a);
  ok(lh.ok, "scores in"); eq(JSON.stringify(lh.scores), JSON.stringify([["Seo", 82], ["Performance", 50], ["Accessibility", 90], ["Best Practices", 100]]));
  ok(lh.failures.some((f) => /meta description/.test(f.title)), "failed audits listed");
  ok(!lh.failures.some((f) => /Image elements have/.test(f.title)), "passed audits left out");
  eq(checkOf(a, "Google Lighthouse performance (mobile)").level, "warn", "50 / 100 needs work");
  eq(a.progress.lighthouse, "done");
  ok(!JSON.stringify(a.got.data).includes("psi-test-key") && !JSON.stringify(a.start.data).includes("psi-test-key"), "key never reaches the customer");
  delete env.PAGESPEED_KEY;
});

for (const [mode, expect] of [
  ["badkey", /on our side/],
  ["quota", /quota is used up/],
  ["fail", /could not load the page/]
]) {
  await test("seo: Google " + mode + " still delivers the full SpeakPower report, and is charged", async () => {
    const email = "seo-" + mode + "@example.com";
    const s = await signUp(email);
    env.PAGESPEED_KEY = "psi-test-key";
    net.pagespeed = mode;
    const a = await runAudit(s.token);
    net.pagespeed = "ok";
    eq(a.start.status, 200, "delivered");
    const lh = lighthouseOf(a);
    ok(!lh.ok && expect.test(lh.reason), "explains: " + lh.reason);
    ok(!a.report.checks.some((c) => /Lighthouse/.test(c.label)), "no invented scores");
    ok(a.report.categories.every((c) => c.score === null || (c.score >= 0 && c.score <= 100)), "the report still scores");
    eq(a.start.data.paidWith, "trial", "a delivered report is a used try");
    if (mode === "badkey") ok(!/your (site|page)/i.test(lh.reason), "our fault is never blamed on their page");
    delete env.PAGESPEED_KEY;
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

/* ------------------------- SEO audit: slow sites, and Google loading them */

// Runs fn with every timer 50 times faster, so a 15-second limit takes 0.3 s.
// The Worker and the stand-in sites both read the global setTimeout, so their
// waits shrink together and keep their real proportions.
async function fastClock(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...rest) => real(cb, ms === Infinity ? ms : (ms || 0) / 50, ...rest);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}
const auditedLine = (r) => r.data.sections[0][1];

await test("seo: the page is read first and Lighthouse runs after it, never side by side", async () => {
  const s = await signUp("seo-order@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.events.length = 0;
  const r = await fastClock(() => audit(s.token, "https://slow.test"));
  eq(r.status, 200, "a site slower than the old 12-second limit is audited");
  eq(net.events.join(" > "), "page > page answered", "the start reads the page; Google is not called yet");
  const early = await call("POST", "/studio/audit/run", { token: s.token, body: { id: r.data.audit.id, stage: "lighthouse" } });
  eq(early.status, 409, "Lighthouse waits for the crawl"); eq(early.data.error, "not_ready");
  for (let i = 0; i < 3; i++) await call("POST", "/studio/audit/run", { token: s.token, body: { id: r.data.audit.id, stage: "crawl" } });
  await call("POST", "/studio/audit/run", { token: s.token, body: { id: r.data.audit.id, stage: "lighthouse" } });
  eq(net.events.join(" > "), "page > page answered > lighthouse", "Google never loads the site while we are reading it");
  const got = await call("GET", "/studio/audit?id=" + r.data.audit.id, { token: s.token });
  ok(got.data.report.lighthouse.ok, "scores still added");
  eq(r.data.paidWith, "trial");
  delete env.PAGESPEED_KEY;
});

await test("seo: a page that cannot be read never spends Google's quota", async () => {
  const s = await signUp("seo-noquota@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeedCalls.length = 0;
  const r = await audit(s.token, "https://down.test");
  eq(r.status, 502);
  eq(net.pagespeedCalls.length, 0, "no Lighthouse call for a page we could not read");
  delete env.PAGESPEED_KEY;
});

await test("seo: a site that hangs once is asked again and audited", async () => {
  const s = await signUp("seo-flaky@example.com");
  net.pageFetches.length = 0;
  const r = await fastClock(() => audit(s.token, "https://flaky.test"));
  eq(r.status, 200, "delivered on the second try");
  eq(net.pageFetches.filter((x) => x.url === "https://flaky.test/").length, 2, "asked exactly twice");
});

await test("seo: a site that never answers fails clearly, after two tries, and is refunded", async () => {
  const email = "seo-hung@example.com";
  const s = await signUp(email);
  net.pageFetches.length = 0;
  const r = await fastClock(() => audit(s.token, "https://hung.test"));
  eq(r.status, 502); eq(r.data.error, "generation_failed");
  ok(/did not start answering within 15 seconds \(asked twice\)/.test(r.data.message), r.data.message);
  eq(net.pageFetches.length, 2, "one retry, no more");
  eq(userRow(email).trials_remaining, 3, "try given back");
});

await test("seo: a refused answer is final, not retried", async () => {
  const s = await signUp("seo-404once@example.com");
  net.pageFetches.length = 0;
  const r = await audit(s.token, "https://missing.test");
  eq(r.status, 502);
  eq(net.pageFetches.length, 1, "a 404 is an answer: asked once");
  const down = await audit(s.token, "https://down.test");
  eq(down.status, 502);
  ok(/could not be reached \(tried twice\)/.test(down.data.message), down.data.message);
});

await test("seo: a page that stalls half-way is reported on what arrived", async () => {
  const s = await signUp("seo-stalls@example.com");
  const r = await fastClock(() => audit(s.token, "https://stalls.test"));
  eq(r.status, 200, "delivered");
  ok(/inspected; the rest of the page was too slow to arrive/.test(auditedLine(r)), auditedLine(r));
  eq(r.data.paidWith, "trial", "a delivered report is a used try");
});

await test("seo: a page that answers but sends nothing fails clearly and is refunded", async () => {
  const email = "seo-silent@example.com";
  const s = await signUp(email);
  const r = await fastClock(() => audit(s.token, "https://silent.test"));
  eq(r.status, 502);
  ok(/sent nothing within 15 seconds/.test(r.data.message), r.data.message);
  eq(userRow(email).trials_remaining, 3, "try given back");
});

await test("seo: Lighthouse past its limit still delivers the report, and is charged", async () => {
  const s = await signUp("seo-slowgoogle@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeed = "slow";
  net.pagespeedCalls.length = 0;
  const a = await fastClock(() => runAudit(s.token));
  eq(a.start.status, 200);
  ok(/took too long on this page and was stopped/.test(lighthouseOf(a).reason), lighthouseOf(a).reason);
  eq(a.progress.lighthouse, "retry", "one more try is offered");
  ok(a.progress.done, "the report is complete without it");
  // The second try works; a third is never made.
  net.pagespeed = "ok";
  const again = await call("POST", "/studio/audit/run", { token: s.token, body: { id: a.id, stage: "lighthouse" } });
  eq(again.data.audit.lighthouse, "done");
  await call("POST", "/studio/audit/run", { token: s.token, body: { id: a.id, stage: "lighthouse" } });
  eq(net.pagespeedCalls.length, 2, "two tries at most, and none after a success");
  eq(a.start.data.paidWith, "trial");
  delete env.PAGESPEED_KEY;
});

await test("seo: Google is asked only for what the report reads", async () => {
  const s = await signUp("seo-fields@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeedCalls.length = 0;
  const a = await runAudit(s.token);
  eq(a.start.status, 200);
  eq(net.pagespeedCalls.length, 1);
  eq(new URL(net.pagespeedCalls[0]).searchParams.get("fields"),
    "lighthouseResult/categories/*/score,lighthouseResult/audits/*/title,lighthouseResult/audits/*/score," +
    "lighthouseResult/audits/*/scoreDisplayMode,lighthouseResult/audits/*/displayValue," +
    "loadingExperience/metrics,loadingExperience/overall_category,originLoadingExperience/metrics,originLoadingExperience/overall_category");
  delete env.PAGESPEED_KEY;
});

await test("seo: if Google refuses the field selection, it is asked once more without it", async () => {
  const s = await signUp("seo-nofields@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeed = "nofields";
  net.pagespeedCalls.length = 0;
  const a = await runAudit(s.token);
  net.pagespeed = "ok";
  eq(a.start.status, 200);
  eq(net.pagespeedCalls.map((u) => new URL(u).searchParams.has("fields")).join(","), "true,false", "trimmed, then full");
  ok(lighthouseOf(a).ok, "scores still in the report");
  delete env.PAGESPEED_KEY;
});

await test("seo: real visitors' speed (Chrome UX Report) is read from Google's reply", async () => {
  const s = await signUp("seo-field@example.com");
  env.PAGESPEED_KEY = "psi-test-key";
  net.pagespeed = "field";
  const a = await runAudit(s.token);
  net.pagespeed = "ok";
  const field = lighthouseOf(a).field;
  eq(field.scope, "page"); eq(field.overall, "needs work");
  eq(JSON.stringify(field.metrics.map((m) => [m.name, m.value, m.rating])), JSON.stringify([
    ["Largest Contentful Paint", "2.1 s", "good"], ["Interaction to Next Paint", "260 ms", "needs work"], ["Cumulative Layout Shift", "0.05", "good"]]));
  const c = checkOf(a, "Real visitors' speed");
  eq(c.level, "warn"); ok(/Largest Contentful Paint 2\.1 s \(good\)/.test(c.detail), c.detail);
  delete env.PAGESPEED_KEY;
});

/* ---------------------------------- SEO audit: the whole site, in stages */

const SHOP_SITE_FILES = ["/robots.txt", "/llms.txt", "/sitemap.xml"];

await test("audit: the whole site is read in short stages; extras first, robots respected, nothing guessed", async () => {
  const s = await signUp("audit-shop@example.com");
  net.pageFetches.length = 0;
  net.siteLog.length = 0;
  const a = await runAudit(s.token, "https://shop.test", { extra: "https://shop.test/landing\n/admin\nhttps://shop.test/dashboard\nhttps://shop.test/members" });
  eq(a.start.status, 200);
  eq(a.start.data.audit.state, "pages");
  eq(a.start.data.audit.pagesPlanned, 5, "home + landing, about, services, blog post");
  // Each crawl call reads at most 4 pages; the client's page goes first.
  const order = net.pageFetches.map((x) => new URL(x.url).pathname);
  const firstCrawl = order.indexOf("/landing");
  ok(firstCrawl !== -1 && order.slice(firstCrawl, firstCrawl + 4).join(",") === "/landing,/about,/services,/blog/post-1", "extras first, then the sitemap: " + order.join(","));
  eq(a.steps.map((x) => x.state).join(","), "links,private,done", "four pages in one step, then links, then private areas");
  ok(!net.siteLog.some((u) => /internal\/secret/.test(u)), "a page robots.txt disallows is never read");
  // Only what the site links, lists, or the client named — plus its own files and one made-up address.
  const allowed = /^\/($|robots\.txt$|llms\.txt$|sitemap\.xml$|landing$|about$|services$|blog\/post-1$|account$|admin$|dashboard$|members$|speakpower-audit-[0-9a-f]{8}-not-a-page$)/;
  const paths = net.siteLog.map((u) => new URL(u).pathname);
  ok(paths.every((p) => allowed.test(p)), "no guessed path: " + paths.filter((p) => !allowed.test(p)).join(", "));
  const r = a.report;
  eq(r.pagesRead, 5); eq(r.host, "shop.test");
  eq(r.sitemap.found, true); eq(r.sitemap.count, 7);
  eq(JSON.stringify(r.robots.disallow), JSON.stringify(["/internal/"]));
  eq(JSON.stringify(r.robots.aiBlocked), JSON.stringify(["GPTBot"]));
  const verdicts = Object.fromEntries(r.privateAreas.map((x) => [x.path, x.verdict]).sort((a, b) => a[0].localeCompare(b[0])));
  eq(JSON.stringify(verdicts), JSON.stringify({ "/account": "protected", "/admin": "protected", "/dashboard": "exposed", "/members": "open-hidden" }));
  eq(checkOf(a, "Private areas").level, "fail"); eq(JSON.stringify(checkOf(a, "Private areas").pages), JSON.stringify(["/dashboard"]));
  eq(checkOf(a, "Private areas to review").level, "warn");
  eq(checkOf(a, "AI crawlers").level, "warn"); ok(/GPTBot/.test(checkOf(a, "AI crawlers").detail));
  eq(checkOf(a, "http to https").level, "pass");
  eq(checkOf(a, "www and non-www").level, "pass");
  eq(checkOf(a, "Missing pages").level, "pass", "the made-up address answered 404");
  eq(checkOf(a, "llms.txt").level, "pass");
  eq(checkOf(a, "XML sitemap").level, "pass");
  ok(a.progress.done);
});

await test("audit: scores are the weighted mean of the checks, as the report explains", async () => {
  const s = await signUp("audit-score@example.com");
  const a = await runAudit(s.token, "https://shop.test");
  const r = a.report;
  eq(r.categories.length, 8);
  const W = { crawl: 3, basics: 2.5, content: 1.5, ai: 1.5, social: 1, speed: 2, access: 1.5, trust: 2 };
  const scored = r.categories.filter((c) => c.score !== null);
  const expected = Math.round(scored.reduce((t, c) => t + W[c.key] * c.score, 0) / scored.reduce((t, c) => t + W[c.key], 0));
  eq(r.overall, expected);
  ok(["Strong", "Solid, with gaps", "Needs work", "At risk"].indexOf(r.grade) !== -1, r.grade);
  ok(/weighted/.test(r.scoring) && /Search Console/.test(r.scope), "method and scope are stated");
  ok(r.checks.every((c, i, all) => i === 0 || ({ fail: 0, warn: 1, pass: 2 })[all[i - 1].level] <= ({ fail: 0, warn: 1, pass: 2 })[c.level]), "fixes first");
});

await test("audit: one audit reads at most 25 pages, and says how many it found", async () => {
  const s = await signUp("audit-big@example.com");
  const a = await runAudit(s.token, "https://big.test", { skipFinal: true });
  eq(a.report.pagesRead, 25);
  eq(a.report.pagesFound, 41);
  eq(new Set(a.report.pages.map((p) => p.path)).size, 25, "no page read twice");
});

await test("audit: two crawl calls at once never read a page into the report twice", async () => {
  const s = await signUp("audit-race@example.com");
  const start = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://lag.test" } } });
  const id = start.data.audit.id;
  // Both calls load the audit before either has read its (slow) pages.
  const both = await Promise.all([1, 2].map(() => call("POST", "/studio/audit/run", { token: s.token, body: { id, stage: "crawl" } })));
  eq(both.map((r) => r.status).join(","), "200,200");
  const got = await call("GET", "/studio/audit?id=" + id, { token: s.token });
  const paths = got.data.report.pages.map((p) => p.path);
  eq(paths.length, 5, "one step's pages, kept once"); eq(new Set(paths).size, 5);
  eq(both[0].data.audit.pagesRead, 5); eq(both[1].data.audit.pagesRead, 5, "the slower call reports where the audit really is");
});

await test("audit: a step that finds the audit moved on underneath it never writes its stale copy", async () => {
  const s = await signUp("audit-stale@example.com");
  const start = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://bump.test" } } });
  const step = await call("POST", "/studio/audit/run", { token: s.token, body: { id: start.data.audit.id, stage: "crawl" } });
  eq(step.status, 200);
  eq(step.data.audit.state, "links", "it reports where the audit really is");
  eq(step.data.audit.pagesRead, 1, "the stale step's page is not written over the newer state");
});

await test("audit: extra pages must be on the same site, at most ten, and nothing is charged for a refusal", async () => {
  const email = "audit-extra@example.com";
  const s = await signUp(email);
  const other = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://shop.test", extra: "https://elsewhere.test/page" } } });
  eq(other.status, 400); eq(other.data.field, "extra"); ok(/must be on shop\.test/.test(other.data.message), other.data.message);
  const many = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://shop.test",
    extra: Array.from({ length: 11 }, (_, i) => "/p" + i).join("\n") } } });
  eq(many.status, 400); eq(many.data.field, "extra");
  const bad = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://shop.test", extra: "http://169.254.169.254/x" } } });
  eq(bad.status, 400);
  eq(userRow(email).trials_remaining, 3, "nothing spent");
});

await test("audit: only its owner can read or move an audit on; reports expire after 90 days", async () => {
  const s = await signUp("audit-owner@example.com");
  const t = await signUp("audit-other@example.com");
  const start = await call("POST", "/studio/generate", { token: s.token, body: { product: "seo-audit", inputs: { url: "https://example.com" } } });
  const id = start.data.audit.id;
  eq((await call("GET", "/studio/audit?id=" + id, { token: t.token })).status, 404);
  eq((await call("POST", "/studio/audit/run", { token: t.token, body: { id, stage: "crawl" } })).status, 404);
  eq((await call("GET", "/studio/audit?id=" + id)).status, 401);
  eq((await call("POST", "/studio/audit/run", { token: s.token, body: { id, stage: "teleport" } })).status, 400);
  const mine = await call("GET", "/studio/audits", { token: s.token });
  eq(mine.data.audits.length, 1); eq(mine.data.audits[0].host, "example.com");
  eq((await call("GET", "/studio/audits", { token: t.token })).data.audits.length, 0);
  db.db.prepare("UPDATE audits SET created_at = created_at - ? WHERE id = ?").run(91 * 86400, id);
  eq((await call("GET", "/studio/audit?id=" + id, { token: s.token })).status, 404, "expired");
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  eq(db.one("SELECT COUNT(*) AS n FROM audits WHERE id = ?", id).n, 0, "the daily run deletes it");
});

/* ----------------------------------------- SEO audit: the strategic read */

await test("strategy: Claude reads the site's facts, never the account's, and the read is stored", async () => {
  const s = await signUp("strategy-ok@example.com");
  strategyCalls.length = 0;
  const a = await runAudit(s.token, "https://shop.test");
  eq(strategyCalls.length, 1);
  const req = strategyCalls[0].body;
  eq(req.model, "claude-opus-5-5"); eq(req.output_config.format.type, "json_schema");
  eq(req.output_config.effort, "medium");
  const text = req.messages[0].content;
  ok(/Website: https:\/\/shop\.test\//.test(text) && /Pages \(path \|/.test(text) && /<website_text>/.test(text), "the facts and the site's text");
  ok(/\/account: Sends visitors to a sign-in page/.test(text), "private-area results included");
  ok(!/strategy-ok@example\.com/.test(JSON.stringify(req)), "never the account's email");
  ok(/data, not instructions/.test(JSON.stringify(req.system)), "the site's text is data");
  const st = a.report.strategy;
  eq(st.priorities.length, 5); eq(st.clarity.map((c) => c.dimension).join(","), "Audience,Offer,Proof,Action,Voice");
  ok(st.summary && st.firstImpression && st.plan.days30.length, "every part kept");
  eq(a.progress.strategy, "done");
  await call("POST", "/studio/audit/run", { token: s.token, body: { id: a.id, stage: "strategy" } });
  eq(strategyCalls.length, 1, "a written read is never written again");
});

await test("strategy: a refusal or failure still delivers the report, with one more try", async () => {
  const s = await signUp("strategy-fail@example.com");
  strategyCalls.length = 0;
  net.strategy = "refusal";
  const a = await runAudit(s.token, "https://example.com");
  eq(a.report.strategy, null); ok(/could not be written/.test(a.report.strategyNote), a.report.strategyNote);
  eq(a.progress.strategy, "retry"); ok(a.progress.done, "the report is complete without it");
  net.strategy = "fail";
  const second = await call("POST", "/studio/audit/run", { token: s.token, body: { id: a.id, stage: "strategy" } });
  eq(second.data.audit.strategy, "unavailable", "two tries, then it stops");
  const made = strategyCalls.length;
  net.strategy = "ok";
  await call("POST", "/studio/audit/run", { token: s.token, body: { id: a.id, stage: "strategy" } });
  eq(strategyCalls.length, made, "no third try");
  ok(made >= 2, "the refusal and the failure were real calls");
});

await test("strategy: without an Anthropic key the section says so and nothing is called", async () => {
  const s = await signUp("strategy-off@example.com");
  const key = env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  strategyCalls.length = 0;
  const a = await runAudit(s.token, "https://example.com");
  env.ANTHROPIC_API_KEY = key;
  eq(strategyCalls.length, 0);
  eq(a.progress.strategy, "unavailable"); ok(/not switched on/.test(a.report.strategyNote));
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

await test("topup: end to end — 3 free, pay wall, top up, webhook credits, a Studio pack carries on paid", async () => {
  const s = await signUp("t-e2e@example.com");
  for (let i = 0; i < 3; i++) eq((await use(s.token, "speaker-ready")).status, 200);
  eq((await use(s.token, "speaker-ready")).status, 402, "pay wall");
  const c = await checkout(s.token, 100000);
  const id = pay(c.data.txRef, { amount: 100000 });
  eq((await webhook(charge(id, c.data.txRef))).status, 200);
  const u = userRow("t-e2e@example.com");
  eq(u.balance, 100000, "credited what was paid"); eq(u.plan, "paid");
  eq(payment(c.data.txRef).status, "paid"); eq(payment(c.data.txRef).provider_ref, id);
  eq(payment(c.data.txRef).purpose, "topup");
  const r = await use(s.token, "speaker-ready");
  eq(r.status, 200); eq(r.data.paidWith, "balance"); eq(r.data.account.balance, 25000);
  eq((await chat(s.token, "and GRIOT?")).data.error, "plan_required", "a balance never buys GRIOT");
});

await test("topup: a small top-up cannot buy a Market Plan", async () => {
  const s = await signUp("t-mismatch@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0 WHERE email_canonical = ?").run("t-mismatch@example.com");
  await topUp(s.token, 50000);
  const plan = await use(s.token, "market-plan");
  eq(plan.status, 402, "refused");
  eq(plan.data.price, 125000); eq(plan.data.balance, 50000); eq(plan.data.shortfall, 75000);
  await topUp(s.token, 100000);
  const paid = await use(s.token, "market-plan");
  eq(paid.status, 200, "affordable once the balance covers it");
  eq(paid.data.account.balance, 25000, "150,000 − 125,000");
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

/* ------------------------------------------------------- plan payments */

function planCheckout(token, plan, extra) {
  return call("POST", "/plans/checkout", { token, body: Object.assign({ plan }, extra || {}) });
}
function periods(email) {
  return db.q("SELECT plan, starts_at, ends_at, griot_limit, rehearsal_limit, pack_limit, pack_discount FROM subscriptions " +
    "WHERE user_id = ? AND ends_at > starts_at ORDER BY starts_at, id", userId(email));
}
const DAY = 86400;

await test("plans: checkout charges exactly the plan's price, whatever the browser sends", async () => {
  const s = await signUp("pl-buy@example.com");
  flw.checkouts.length = 0;
  const r = await planCheckout(s.token, "starter", { amount: 1, price: 1, returnTo: "plans.html" });
  eq(r.status, 200); eq(r.data.amount, 60000); eq(r.data.plan, "starter");
  const p = payment(r.data.txRef);
  eq(p.amount, 60000); eq(p.purpose, "plan:starter"); eq(p.status, "pending");
  eq(flw.checkouts[0].body.amount, 60000);
  ok(/Starter plan, 30 days/.test(flw.checkouts[0].body.customizations.description));
  eq(flw.checkouts[0].body.redirect_url, "https://speakpower-commits.github.io/SpeakPower/plans.html", "plans.html is a return page");
  for (const bad of ["gold", "", "__proto__", "constructor", null, ["pro"]]) {
    const x = await planCheckout(s.token, bad);
    eq(x.status, 400, "plan " + JSON.stringify(bad)); eq(x.data.error, "unknown_plan");
  }
  eq((await planCheckout(null, "pro")).status, 401, "signed out");
});

await test("plans: paying opens 30 days exactly once — webhook replays and the return page together", async () => {
  const email = "pl-once@example.com";
  const s = await signUp(email);
  const c = await planCheckout(s.token, "starter");
  const id = pay(c.data.txRef, { amount: 60000 });
  await Promise.all([webhook(charge(id, c.data.txRef)), webhook(charge(id, c.data.txRef)),
    confirm(s.token, c.data.txRef, id)]);
  const again = await confirm(s.token, c.data.txRef, id);
  eq(again.data.status, "already_credited"); eq(again.data.purpose, "plan:starter");
  const rows = periods(email);
  eq(rows.length, 1, "one period");
  eq(rows[0].ends_at - rows[0].starts_at, 30 * DAY);
  eq(JSON.stringify([rows[0].griot_limit, rows[0].rehearsal_limit, rows[0].pack_limit, rows[0].pack_discount]), "[120,20,0,0]");
  eq(userRow(email).balance, 0, "a plan payment never lands on the balance");
  eq(again.data.account.membership.plan, "starter");
  noTrials(email);
  eq((await chat(s.token, "member question")).data.paidWith, "plan");
});

await test("plans: an underpaid or wrong-currency plan payment opens nothing", async () => {
  const email = "pl-short@example.com";
  const s = await signUp(email);
  const c = await planCheckout(s.token, "pro");
  const cheap = pay(c.data.txRef, { amount: 60000 });
  await webhook(charge(cheap, c.data.txRef));
  const usd = pay(c.data.txRef, { amount: 150000, currency: "USD" });
  await webhook(charge(usd, c.data.txRef));
  eq(periods(email).length, 0); eq(payment(c.data.txRef).status, "pending");
});

await test("plans: renewing early adds 30 days after the current end — no day is lost", async () => {
  const email = "pl-renew@example.com";
  const s = await signUp(email);
  const now = Math.floor(Date.now() / 1000);
  givePlan(email, "starter", { starts_at: now - 25 * DAY, ends_at: now + 5 * DAY });
  const c = await planCheckout(s.token, "starter");
  await webhook(charge(pay(c.data.txRef, { amount: 60000 }), c.data.txRef));
  const rows = periods(email);
  eq(rows.length, 2);
  eq(rows[1].starts_at, now + 5 * DAY, "starts when the current one ends");
  eq(rows[1].ends_at, now + 35 * DAY);
});

await test("plans: switching to Pro starts it now and ends Starter today", async () => {
  const email = "pl-switch@example.com";
  const s = await signUp(email);
  const now = Math.floor(Date.now() / 1000);
  givePlan(email, "starter", { starts_at: now - 10 * DAY, ends_at: now + 20 * DAY, griot_used: 120 });
  givePlan(email, "starter", { starts_at: now + 20 * DAY, ends_at: now + 50 * DAY });
  noTrials(email);
  eq((await chat(s.token, "out of Starter")).status, 402);
  const c = await planCheckout(s.token, "pro");
  await webhook(charge(pay(c.data.txRef, { amount: 150000 }), c.data.txRef));
  const rows = periods(email);
  eq(rows.map((r) => r.plan).join(","), "starter,pro", "the queued Starter is gone, the old one ends today");
  ok(rows[1].starts_at <= Math.floor(Date.now() / 1000) && rows[1].starts_at >= now, "Pro starts now");
  const r = await chat(s.token, "now on Pro");
  eq(r.status, 200); eq(r.data.account.membership.plan, "pro");
});

/* ------------------------------------------------- Google Analytics */

const GA = { clientId: "1234567890.1712345678", sessionId: "1712345678" };

await test("analytics: email sign-in says whether it is the account's first", async () => {
  const email = "ga-email@example.com";
  const first = await signUp(email);
  eq(first.isNew, true, "first sign-in");
  const again = await signUp(email);
  eq(again.isNew, false, "second sign-in, same second or not");
});

await test("analytics: Google sign-in says whether it is the account's first", async () => {
  const first = await google(await googleToken({ email: "ga.google@gmail.com", sub: "ga-sub" }));
  eq(first.status, 200); eq(first.data.isNew, true, "first sign-in");
  const again = await google(await googleToken({ email: "ga.google@gmail.com", sub: "ga-sub" }));
  eq(again.data.isNew, false, "returning");
  const viaEmail = await signUp("ga.google@gmail.com");
  eq(viaEmail.isNew, false, "the same account by email code is not new either");
});

await test("analytics: no purchase is reported until both the ID and the Secret are set", async () => {
  ga4.hits.length = 0;
  const s = await signUp("ga-off@example.com");
  const c = await planCheckout(s.token, "starter", { ga: GA });
  eq(payment(c.data.txRef).ga_client_id, GA.clientId, "ids kept for later");
  await webhook(charge(pay(c.data.txRef, { amount: 60000 }), c.data.txRef));
  eq(payment(c.data.txRef).status, "paid");
  env.GA4_MEASUREMENT_ID = "G-QMCCT15QTM";
  const c2 = await planCheckout(s.token, "starter", { ga: GA });
  await webhook(charge(pay(c2.data.txRef, { amount: 60000 }), c2.data.txRef));
  eq(payment(c2.data.txRef).status, "paid");
  eq(ga4.hits.length, 0, "nothing sent without the API secret");
  delete env.GA4_MEASUREMENT_ID;
  env.GA4_API_SECRET = "mp-secret";
  const c3 = await planCheckout(s.token, "starter", { ga: GA });
  await webhook(charge(pay(c3.data.txRef, { amount: 60000 }), c3.data.txRef));
  eq(ga4.hits.length, 0, "nothing sent without the Measurement ID");
  env.GA4_MEASUREMENT_ID = "not-a-ga4-id";
  const c4 = await planCheckout(s.token, "starter", { ga: GA });
  await webhook(charge(pay(c4.data.txRef, { amount: 60000 }), c4.data.txRef));
  eq(ga4.hits.length, 0, "nothing sent to a malformed Measurement ID");
  delete env.GA4_MEASUREMENT_ID; delete env.GA4_API_SECRET;
});

env.GA4_MEASUREMENT_ID = "G-QMCCT15QTM";
env.GA4_API_SECRET = "mp-secret";

await test("analytics: a plan purchase is reported once, with the visitor's ids and nothing personal", async () => {
  ga4.hits.length = 0;
  const email = "ga-plan@example.com";
  const s = await signUp(email);
  const c = await planCheckout(s.token, "pro", { ga: GA });
  eq(c.status, 200);
  const id = pay(c.data.txRef, { amount: 150000 });
  await Promise.all([webhook(charge(id, c.data.txRef)), webhook(charge(id, c.data.txRef)), confirm(s.token, c.data.txRef, id)]);
  await confirm(s.token, c.data.txRef, id);
  eq(ga4.hits.length, 1, "exactly one purchase hit");
  const hit = ga4.hits[0];
  eq(hit.id, "G-QMCCT15QTM"); eq(hit.secret, "mp-secret"); eq(hit.contentType, "application/json");
  eq(hit.body.client_id, GA.clientId);
  eq(hit.body.non_personalized_ads, true);
  ok(!("user_id" in hit.body), "no user id");
  eq(hit.body.events.length, 1);
  const ev = hit.body.events[0];
  eq(ev.name, "purchase");
  eq(ev.params.transaction_id, c.data.txRef); eq(ev.params.currency, "UGX"); eq(ev.params.value, 150000);
  eq(ev.params.session_id, GA.sessionId);
  eq(ev.params.items.length, 1);
  eq(ev.params.items[0].item_id, "plan_pro"); eq(ev.params.items[0].item_category, "plan");
  eq(ev.params.items[0].price, 150000); eq(ev.params.items[0].quantity, 1);
  ok(/Pro plan, 30 days/.test(ev.params.items[0].item_name));
  const sent = JSON.stringify(hit.body);
  ok(!sent.includes(email) && !sent.includes(userId(email)) && !sent.includes("Test"), "no email, account id or name");
});

await test("analytics: a top-up is reported as a top-up, without a session id when none was given", async () => {
  ga4.hits.length = 0;
  const s = await signUp("ga-topup@example.com");
  const c = await call("POST", "/wallet/checkout", { token: s.token, body: { amount: 100000, ga: { clientId: GA.clientId } } });
  eq(c.status, 200);
  await webhook(charge(pay(c.data.txRef, { amount: 100000 }), c.data.txRef));
  eq(ga4.hits.length, 1);
  const ev = ga4.hits[0].body.events[0];
  eq(ev.params.items[0].item_id, "topup"); eq(ev.params.value, 100000);
  ok(!("session_id" in ev.params), "no session id invented");
});

await test("analytics: a visitor who declined analytics (no ids) is never reported", async () => {
  ga4.hits.length = 0;
  const s = await signUp("ga-declined@example.com");
  const c = await planCheckout(s.token, "starter");
  await webhook(charge(pay(c.data.txRef, { amount: 60000 }), c.data.txRef));
  eq(payment(c.data.txRef).status, "paid");
  eq(payment(c.data.txRef).ga_client_id, null);
  eq(ga4.hits.length, 0);
});

await test("analytics: ids that are not GA's own shape are dropped at checkout", async () => {
  const s = await signUp("ga-junk@example.com");
  for (const [ga, client, session] of [
    [{ clientId: "user@example.com", sessionId: "1" }, null, null],
    [{ clientId: "123.456<script>", sessionId: "1" }, null, null],
    [{ clientId: 1234.5678 }, null, null],
    [{ clientId: "1".repeat(21) + ".1" }, null, null],
    [{ sessionId: "1712345678" }, null, null],
    [{ clientId: GA.clientId, sessionId: "abc" }, GA.clientId, null],
    [{ clientId: GA.clientId, sessionId: 1712345678 }, GA.clientId, null],
    ["1234567890.1712345678", null, null],
    [[GA.clientId], null, null]
  ]) {
    const c = await planCheckout(s.token, "starter", { ga });
    eq(c.status, 200, "checkout still opens for " + JSON.stringify(ga));
    const p = payment(c.data.txRef);
    eq(p.ga_client_id, client, "client id from " + JSON.stringify(ga));
    eq(p.ga_session_id, session, "session id from " + JSON.stringify(ga));
  }
});

await test("analytics: a database without the GA columns still takes payments, and reports nothing", async () => {
  // The live database as it was before 14 Oct: schema.sql without the two
  // GA columns. The Worker must record the payment anyway.
  const old = new FakeD1();
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  const withoutGa = schema.replace(/,\s*(--[^\n]*\n\s*)*ga_client_id\s+TEXT,\s*ga_session_id\s+TEXT/, "");
  ok(withoutGa !== schema, "the old schema was rebuilt");
  old.db.exec(withoutGa);
  old.db.exec(PROFILE_TRIGGER);
  ok(!old.q("SELECT name FROM pragma_table_info('payments')").some((c) => c.name.startsWith("ga_")), "no GA columns");
  ga4.hits.length = 0;
  const live = env.DB;
  env.DB = old;
  try {
    const email = "ga-oldschema@example.com";
    const s = await signUp(email);
    const c = await planCheckout(s.token, "starter", { ga: GA });
    eq(c.status, 200, "checkout opens");
    const row = old.one("SELECT status, purpose FROM payments WHERE tx_ref = ?", c.data.txRef);
    eq(row && row.status, "pending", "payment recorded");
    const r = await confirm(s.token, c.data.txRef, pay(c.data.txRef, { amount: 60000 }));
    eq(r.data.status, "credited");
    eq(old.q("SELECT id FROM subscriptions").length, 1, "the plan opened");
    eq(ga4.hits.length, 0, "no ids stored, so no report");
  } finally {
    env.DB = live;
  }
});

for (const mode of ["fail", "throw", "hang"]) {
  await test("analytics: Google " + (mode === "hang" ? "hanging" : "failing (" + mode + ")") + " never touches the payment", async () => {
    ga4.hits.length = 0;
    net.ga4 = mode;
    const email = "ga-" + mode + "@example.com";
    const s = await signUp(email);
    const c = await planCheckout(s.token, "starter", { ga: GA });
    const id = pay(c.data.txRef, { amount: 60000 });
    const started = Date.now();
    const r = await confirm(s.token, c.data.txRef, id);
    delete net.ga4;
    eq(r.status, 200); eq(r.data.status, "credited");
    eq(payment(c.data.txRef).status, "paid");
    eq(periods(email).length, 1, "the plan opened");
    eq(ga4.hits.length, 1, "tried once");
    ok(Date.now() - started < 4500, "gave up within a few seconds");
  });
}

delete env.GA4_MEASUREMENT_ID;
delete env.GA4_API_SECRET;

/* ------------------------------------------------ the Rehearsal Room */

function rehearsalRows(email) {
  return db.q("SELECT moment, score, kind, wpm, fillers_pm, pauses_pm, words, seconds, feedback_json FROM rehearsals WHERE user_id = ? ORDER BY id", userId(email));
}
function runsOf(email) {
  return db.q("SELECT product, paid_with, amount, status FROM runs WHERE user_id = ? ORDER BY id", userId(email));
}

await test("rehearse: measures pace, fillers and pauses exactly from Whisper's word timings", async () => {
  const s = await signUp("r-metrics@example.com");
  whisperCalls.length = 0;
  const r = await rehearse(s.token);
  eq(r.status, 200, "status");
  const m = r.data.metrics;
  eq(m.words, 150, "words"); eq(m.seconds, 63, "speaking time from first to last word");
  eq(m.wpm, 143, "pace"); eq(m.fillers, 3, "two ums and one 'you know'"); eq(m.fillersPerMin, 2.9, "fillers a minute");
  eq(m.longPauses, 1, "one pause over 2.5 s"); eq(m.pausesPerMin, 1, "pauses a minute"); eq(m.longestSentence, 25);
  eq(whisperCalls[0].model, "@cf/openai/whisper-large-v3-turbo", "Whisper large-v3-turbo");
  eq(whisperCalls[0].input.audio, AUDIO, "the browser's base64 is passed through untouched");
  eq(whisperCalls[0].input.language, "en");
  ok(/um/i.test(whisperCalls[0].input.initial_prompt), "a filler-rich prompt keeps fillers in");
  ok(!("vad_filter" in whisperCalls[0].input), "silence is kept, so pauses can be measured");
});

await test("rehearse: segment gaps stand in when Whisper gives no word timings", async () => {
  const s = await signUp("r-segments@example.com");
  net.whisper = "nowords";
  const r = await rehearse(s.token);
  net.whisper = "ok";
  eq(r.status, 200);
  eq(r.data.metrics.wpm, 143); eq(r.data.metrics.longPauses, 1);
});

await test("rehearse: the Speak Score follows the formula, with Claude's POLSSE ratings as the message part", async () => {
  const s = await signUp("r-score@example.com");
  coachCalls.length = 0;
  const r = await rehearse(s.token);
  eq(r.status, 200);
  const sp = 1 - Math.abs(143 - 145) / 60, sf = 1 - 2.9 / 8, sfl = 1 - 1 / 4, sm = 20 / 25;
  eq(r.data.score, Math.round(100 * (0.25 * sp + 0.20 * sf + 0.15 * sfl + 0.40 * sm)), "S");
  eq(r.data.kind, "speak");
  eq(r.data.coaching.lenses.map((l) => l.lens + ":" + l.score).join(","),
    "Politics:4,Organizations:3,Law:5,Security:4,Socioeconomics:4");
  eq(r.data.coaching.fixes.length, 3); ok(r.data.coaching.openingLine.startsWith("Forty schools"));
  ok(r.data.transcript.length > 100, "transcript returned to the customer");
  const req = coachCalls[0];
  eq(req.key, "sk-ant-test-key", "key sent server-side");
  eq(req.body.model, "claude-opus-5-5");
  eq(req.body.fallbacks, "default", "refusals fall back server-side");
  ok(/server-side-fallback-2026-07-01/.test(req.beta), "fallback beta header");
  eq(req.body.output_config.effort, "medium");
  eq(req.body.output_config.format.type, "json_schema");
  ok(/<transcript>[\s\S]*word[\s\S]*<\/transcript>/.test(req.body.messages[0].content), "transcript fenced as data");
  ok(/143 words a minute/.test(req.body.messages[0].content), "measurements included");
  eq(req.body.system[0].cache_control.type, "ephemeral", "stable rubric marked for caching");
  ok(!JSON.stringify(r.data).includes("sk-ant"), "key never reaches the customer");
});

await test("rehearse: comes with a plan after the free tries; the audio is never stored", async () => {
  const s = await signUp("r-paid@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 12000 WHERE email_canonical = ?").run("r-paid@example.com");
  givePlan("r-paid@example.com", "starter");
  const r = await rehearse(s.token);
  eq(r.status, 200); eq(r.data.paidWith, "plan"); eq(r.data.counted, true); ok(!("amount" in r.data));
  eq(r.data.account.balance, 12000, "the balance is never touched");
  eq(periodOf("r-paid@example.com").rehearsal_used, 1); eq(r.data.account.membership.usage.rehearsal, 5);
  const row = rehearsalRows("r-paid@example.com")[0];
  ok(!JSON.stringify(row).includes(AUDIO.slice(0, 40)), "no audio in D1");
  ok(!JSON.stringify(row).includes("word word word"), "no transcript in D1");
  eq(row.kind, "speak"); eq(row.score, r.data.score);
});

await test("rehearse: without an Anthropic key it is scores only, counts as a use, and Claude is never called", async () => {
  const s = await signUp("r-nokey@example.com");
  noTrials("r-nokey@example.com");
  givePlan("r-nokey@example.com", "starter");
  const saved = env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_API_KEY;
  coachCalls.length = 0;
  const r = await rehearse(s.token);
  env.ANTHROPIC_API_KEY = saved;
  eq(r.status, 200); eq(r.data.counted, true); eq(r.data.kind, "delivery"); eq(r.data.coaching, null);
  eq(coachCalls.length, 0, "no call to Claude");
  const sp = 1 - Math.abs(143 - 145) / 60, sf = 1 - 2.9 / 8, sfl = 1 - 1 / 4;
  eq(r.data.score, Math.round(100 * (0.25 * sp + 0.20 * sf + 0.15 * sfl) / 0.60), "delivery score scaled to 100");
  eq(periodOf("r-nokey@example.com").rehearsal_used, 1);
});

for (const mode of ["refusal", "cutoff", "garbled", "incomplete", "fail"]) {
  await test("rehearse: coaching " + mode + " still delivers the scores, and that rehearsal does not count", async () => {
    const email = "r-coach-" + mode + "@example.com";
    const s = await signUp(email);
    noTrials(email);
    givePlan(email, "starter", { rehearsal_used: 4 });
    net.coach = mode;
    const r = await rehearse(s.token);
    net.coach = "ok";
    eq(r.status, 200, "scores delivered"); eq(r.data.kind, "delivery"); eq(r.data.coaching, null);
    eq(r.data.counted, false, "the page can say it did not count");
    eq(periodOf(email).rehearsal_used, 4, "the use is back");
    eq(rehearsalRows(email).length, 1, "the scores are still kept for progress");
    eq(JSON.stringify(runsOf(email)), JSON.stringify([{ product: "rehearsal", paid_with: "plan", amount: 0, status: "refunded" }]));
  });
}

await test("rehearse: a recording Whisper cannot read is refunded in full and nothing is kept", async () => {
  const s = await signUp("r-unreadable@example.com");
  noTrials("r-unreadable@example.com");
  givePlan("r-unreadable@example.com", "starter");
  net.whisper = "fail";
  const r = await rehearse(s.token);
  net.whisper = "silent";
  const quiet = await rehearse(s.token);
  net.whisper = "ok";
  eq(r.status, 422); eq(r.data.error, "audio_unreadable"); ok(/not charged/.test(r.data.message));
  eq(quiet.status, 422); eq(quiet.data.error, "too_little_speech");
  eq(periodOf("r-unreadable@example.com").rehearsal_used, 0, "no use spent");
  eq(rehearsalRows("r-unreadable@example.com").length, 0);
  ok(runsOf("r-unreadable@example.com").every((x) => x.status === "refunded"), "both runs refunded");
});

await test("rehearse: a free try that fails is given back", async () => {
  const s = await signUp("r-freefail@example.com");
  net.whisper = "fail";
  await rehearse(s.token);
  net.whisper = "ok";
  eq(userRow("r-freefail@example.com").trials_remaining, 3);
});

await test("rehearse: bad requests are refused before anything is spent", async () => {
  const s = await signUp("r-bad@example.com");
  whisperCalls.length = 0;
  const cases = [
    [{ moment: "rap-battle" }, "unknown_moment"],
    [{ audio: "short" }, "bad_audio"],
    [{ audio: AUDIO + "A" }, "bad_audio"],
    [{ audio: "!!!!" + AUDIO.slice(4) }, "bad_audio"],
    [{ seconds: 1 }, "too_short"],
    [{ seconds: 240 }, "too_long"]
  ];
  for (const [over, code] of cases) {
    const r = await rehearse(s.token, over);
    eq(r.status, 400, code); eq(r.data.error, code);
  }
  const anon = await call("POST", "/rehearse", { body: { moment: "investor-pitch", audio: AUDIO, seconds: 30 } });
  eq(anon.status, 401, "an account is needed");
  eq(whisperCalls.length, 0, "Whisper never called"); eq(userRow("r-bad@example.com").trials_remaining, 3);
});

await test("rehearse: with no Workers AI binding it says so, and charges nothing", async () => {
  const s = await signUp("r-noai@example.com");
  const ai = env.AI; delete env.AI;
  const r = await rehearse(s.token);
  env.AI = ai;
  eq(r.status, 503); eq(r.data.error, "rehearsal_unconfigured");
  eq(userRow("r-noai@example.com").trials_remaining, 3);
});

await test("rehearse: after the free tries without a plan, the wall offers the plans and names no price", async () => {
  const s = await signUp("r-wall@example.com");
  db.db.prepare("UPDATE users SET trials_remaining = 0, balance = 900000 WHERE email_canonical = ?").run("r-wall@example.com");
  whisperCalls.length = 0;
  const r = await rehearse(s.token);
  eq(r.status, 402); eq(r.data.error, "plan_required"); eq(r.data.service, "rehearsal");
  ok(!("price" in r.data), "no per-rehearsal price"); eq(r.data.plans.length, 2);
  eq(whisperCalls.length, 0, "nothing transcribed"); eq(userRow("r-wall@example.com").balance, 900000);
});

await test("rehearse: progress, history and deletion stay within one account", async () => {
  const a = await signUp("r-hist-a@example.com");
  const b = await signUp("r-hist-b@example.com");
  const first = await rehearse(a.token);
  eq(first.data.previousScore, null);
  const second = await rehearse(a.token);
  eq(second.data.previousScore, first.data.score, "the last score for the same moment");
  await rehearse(a.token, { moment: "intro-60" });
  await rehearse(b.token);
  const h = await call("GET", "/rehearsals", { token: a.token });
  eq(h.status, 200); eq(h.data.rehearsals.length, 3, "only A's three");
  eq(h.data.rehearsals[0].moment, "intro-60", "newest first");
  eq(h.data.rehearsals[0].momentTitle, "60-second introduction");
  const del = await call("POST", "/rehearsals/delete", { token: a.token, body: {} });
  eq(del.status, 200); eq(del.data.deleted, 3);
  eq((await call("GET", "/rehearsals", { token: a.token })).data.rehearsals.length, 0);
  eq((await call("GET", "/rehearsals", { token: b.token })).data.rehearsals.length, 1, "B's rehearsal untouched");
  eq((await call("GET", "/rehearsals")).status, 401);
});

await test("rehearse: Flutterwave can send a customer back to the Rehearsal Room", async () => {
  const s = await signUp("r-return@example.com");
  env.FLW_SECRET_KEY = "FLWSECK_TEST-x"; env.FLW_SECRET_HASH = "hash";
  net.flwCheckout = "ok";
  flw.checkouts.length = 0;
  const r = await call("POST", "/plans/checkout", { token: s.token, body: { plan: "starter", returnTo: "rehearse.html" } });
  eq(r.status, 200);
  ok(/rehearse\.html/.test(flw.checkouts[0].body.redirect_url), "redirects to rehearse.html");
});

/* ------------------------------------------- Know the customer: profiles */

function bare(email) { db.db.prepare("DELETE FROM profiles WHERE user_id = ?").run(userId(email)); }
function profileRow(email) { return db.one("SELECT * FROM profiles WHERE user_id = ?", userId(email)); }
function profileMemories(email) {
  return griotStore.memories.filter((m) => m.tenant_id === userId(email) && m.kind === "profile");
}
const STEP1 = { step: 1, name: "Grace Akello", expertise: "Fundraising", position: "Head of Partnerships",
  company: "Kampala Schools Trust", sector: "ngo", location: "Kampala" };
const STEP2 = { step: 2, problem: "Donors stop reading after page one.", goal: "Raise UGX 400m for 40 schools",
  goalBy: "June 2027", whyNow: "The board meets in March.", focus: ["pitching", "data"], briefGriot: true };
function saveProfile(token, body) { return call("POST", "/profile", { token, body }); }
async function newcomer(email) {
  const s = await signUp(email);
  bare(email);
  return s;
}

await test("profile: a new account finishes step 1 before any service, and a refusal costs nothing", async () => {
  const email = "k-new@example.com";
  const s = await newcomer(email);
  eq(JSON.stringify((await call("GET", "/me", { token: s.token })).data.account.profile), '{"step1":false,"step2":false}');
  griotCalls.length = 0;
  for (const service of ["brand-story", "griot", "rehearsal"]) {
    const r = await use(s.token, service);
    eq(r.status, 409, service); eq(r.data.error, "profile_required"); eq(r.data.step, 1, service);
    ok(/nothing was charged/i.test(r.data.message), r.data.message);
  }
  eq(userRow(email).trials_remaining, 3, "no free try spent");
  eq(runsOf(email).length, 0, "no run recorded");
  eq(griotCalls.length, 0, "GRIOT never asked");
  const g = await call("GET", "/profile", { token: s.token });
  eq(g.status, 200); eq(g.data.profile, null); eq(g.data.googleName, "Test");
  eq(g.data.sectors.length, 12); eq(g.data.focusAreas.map((f) => f.key).join(","), "pitching,marketing,brand,data,speaking,strategy,digital");
  eq((await call("GET", "/profile")).status, 401, "signed out");
});

await test("profile: step 1 opens the Studio and the Rehearsal Room; GRIOT also needs step 2", async () => {
  const email = "k-steps@example.com";
  const s = await newcomer(email);
  const one = await saveProfile(s.token, STEP1);
  eq(one.status, 200); eq(one.data.profile.step1, true); eq(one.data.profile.step2, false);
  eq(one.data.profile.told.length, 0, "GRIOT is told nothing without a yes");
  eq((await use(s.token, "brand-story")).status, 200);
  eq((await use(s.token, "rehearsal")).status, 200);
  const blocked = await chat(s.token, "First question");
  eq(blocked.status, 409); eq(blocked.data.step, 2);
  eq(userRow(email).trials_remaining, 1, "only the two uses were counted");
  eq((await saveProfile(s.token, STEP2)).status, 200);
  const asked = await chat(s.token, "First question");
  eq(asked.status, 200); eq(asked.data.account.profile.step2, true);
});

await test("profile: steps arrive in order, required fields are named, and lists are checked", async () => {
  const s = await newcomer("k-checks@example.com");
  const early = await saveProfile(s.token, STEP2);
  eq(early.status, 409); eq(early.data.step, 1);
  for (const [over, field] of [[{ position: "  " }, "position"], [{ name: "" }, "name"], [{ company: undefined }, "company"],
    [{ sector: "casino" }, "sector"], [{ consentWhatsapp: true, whatsapp: "call me" }, "whatsapp"]]) {
    const r = await saveProfile(s.token, Object.assign({}, STEP1, over));
    eq(r.status, 400, field); eq(r.data.error, "profile_incomplete"); eq(r.data.field, field, field);
  }
  eq((await saveProfile(s.token, Object.assign({}, STEP1, { step: 3 }))).status, 400, "unknown step");
  eq(profileRow("k-checks@example.com"), undefined, "nothing saved by a refused form");
  eq((await saveProfile(s.token, STEP1)).status, 200);
  for (const [over, field] of [[{ problem: "" }, "problem"], [{ goal: " " }, "goal"], [{ focus: ["pitching", "gambling"] }, "focus"]]) {
    const r = await saveProfile(s.token, Object.assign({}, STEP2, over));
    eq(r.status, 400, field); eq(r.data.field, field, field);
  }
  // Text is kept as text: markup is stored and returned verbatim for the page
  // to escape; control characters go.
  const hostile = '<img src=x onerror="alert(1)">';
  const h = await saveProfile(s.token, Object.assign({}, STEP1, { name: hostile + "\u0000\u0007", company: "A".repeat(500) }));
  eq(h.status, 200); eq(h.data.profile.name, hostile); eq(h.data.profile.company.length, 120);
});

await test("profile: the WhatsApp number is kept only with the say-so, and normalised", async () => {
  const s = await newcomer("k-wa@example.com");
  const yes = await saveProfile(s.token, Object.assign({}, STEP1, { consentWhatsapp: true, whatsapp: "0772 123-456" }));
  eq(yes.data.profile.whatsapp, "+256772123456"); eq(yes.data.profile.consentWhatsapp, true);
  const no = await saveProfile(s.token, Object.assign({}, STEP1, { consentWhatsapp: false, whatsapp: "0772 123 456" }));
  eq(no.data.profile.whatsapp, ""); eq(profileRow("k-wa@example.com").whatsapp, null, "dropped, not kept");
});

await test("profile: GRIOT is told who and what under the account's own tenant, never the email or phone", async () => {
  const email = "k-brief@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, Object.assign({}, STEP1, { consentWhatsapp: true, whatsapp: "+256 772 123 456" }));
  griotWsCalls.length = 0;
  const r = await saveProfile(s.token, STEP2);
  eq(r.status, 200); eq(r.data.profile.griot.state, "sent"); ok(r.data.profile.griot.sentAt, "time recorded");
  const mems = profileMemories(email);
  eq(mems.map((m) => m.title).join("|"), "Profile|Challenge|Goal|Why now|Focus");
  eq(JSON.stringify(r.data.profile.told.map((t) => t.title)), JSON.stringify(mems.map((m) => m.title)), "the page shows exactly what GRIOT was told");
  ok(mems.every((m) => m.project === "global" && m.confidence === "fact"), "filed as stated facts in the client's own space");
  eq(mems[0].content, "Grace Akello, Head of Partnerships at Kampala Schools Trust (Non-profit or NGO). Expertise: Fundraising. Based in Kampala.");
  eq(mems[2].content, "Raise UGX 400m for 40 schools. Deadline: June 2027.");
  eq(mems[4].content, "Pitching and fundraising, Data");
  const sent = JSON.stringify(griotStore.memories.filter((m) => m.tenant_id === userId(email)));
  ok(!sent.includes(email) && !sent.includes("772") && !/whatsapp/i.test(sent), "no email or phone number reaches GRIOT");
  ok(griotWsCalls.every((c) => c.tenant === userId(email)), "always this account's tenant");
  eq(JSON.stringify(jsonIds(email).sort()), JSON.stringify(mems.map((m) => m.id).sort()), "ids kept to replace or remove them");
});
function jsonIds(email) { return JSON.parse(profileRow(email).griot_memory_ids); }

await test("profile: an edit replaces GRIOT's copies, and saying no removes them", async () => {
  const email = "k-edit@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, STEP1);
  await saveProfile(s.token, STEP2);
  const before = jsonIds(email);
  await saveProfile(s.token, Object.assign({}, STEP1, { position: "Executive Director" }));
  const after = profileMemories(email);
  eq(after.length, 5, "replaced, not added to");
  ok(after[0].content.startsWith("Grace Akello, Executive Director at"), after[0].content);
  ok(!before.some((id) => griotStore.memories.some((m) => m.id === id)), "the old copies are gone");
  const no = await saveProfile(s.token, Object.assign({}, STEP2, { briefGriot: false }));
  eq(no.data.profile.griot.state, "none"); eq(no.data.profile.told.length, 0);
  eq(profileMemories(email).length, 0, "GRIOT holds nothing once told no"); eq(jsonIds(email).length, 0);
});

await test("profile: delete removes it here and GRIOT's copies; the next service asks again", async () => {
  const email = "k-delete@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, STEP1);
  await saveProfile(s.token, STEP2);
  const d = await call("POST", "/profile/delete", { token: s.token, body: {} });
  eq(d.status, 200); eq(d.data.deleted, true); eq(d.data.griotCleared, true);
  eq(profileRow(email), undefined, "no row left"); eq(profileMemories(email).length, 0, "no copy left in GRIOT");
  eq((await call("GET", "/profile", { token: s.token })).data.profile, null);
  const r = await chat(s.token, "after deleting");
  eq(r.status, 409); eq(r.data.step, 1);
});

await test("profile: when GRIOT cannot take the briefing it waits, then goes before the next question", async () => {
  const email = "k-pending@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, STEP1);
  net.griotMemory = "down";
  const r = await saveProfile(s.token, STEP2);
  net.griotMemory = undefined;
  eq(r.status, 200, "the profile itself is saved"); eq(r.data.profile.griot.state, "pending");
  eq(profileRow(email).griot_lock_until, null, "no lease left behind");
  const before = userRow(email).trials_remaining;
  const c = await chat(s.token, "Where do I start?");
  eq(c.status, 200); eq(userRow(email).trials_remaining, before - 1);
  eq(profileMemories(email).length, 5, "briefed before the question"); eq(profileRow(email).griot_state, "sent");
});

await test("profile: a deletion GRIOT cannot finish keeps no personal data, and the daily run completes it", async () => {
  const email = "k-cron@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, Object.assign({}, STEP1, { callMe: "Gee", consentWhatsapp: true, whatsapp: "0772123456" }));
  await saveProfile(s.token, STEP2);
  net.griotMemory = "down";
  const d = await call("POST", "/profile/delete", { token: s.token, body: {} });
  net.griotMemory = undefined;
  eq(d.status, 200); eq(d.data.griotCleared, false);
  const left = profileRow(email);
  for (const col of ["name", "call_me", "expertise", "position", "company", "location", "whatsapp", "problem", "goal", "goal_by", "why_now"]) {
    eq(left[col], null, col + " wiped at once");
  }
  eq(left.focus, "[]"); eq(left.griot_state, "pending"); eq(jsonIds(email).length, 5, "only the ids to remove remain");
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  eq(profileRow(email), undefined, "row gone"); eq(profileMemories(email).length, 0, "GRIOT's copies gone");
});

await test("profile: a GRIOT without the workspace is never sent what it could not delete", async () => {
  const email = "k-plain@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, STEP1);
  env.GRIOT_API_BASE = "https://griot-plain.test";
  griotCalls.length = 0;
  const r = await saveProfile(s.token, STEP2);
  const c = await chat(s.token, "still works");
  env.GRIOT_API_BASE = "https://griot.test/";
  eq(r.data.profile.griot.state, "pending"); eq(c.status, 200, "asking still works");
  ok(!griotCalls.some((x) => /\/memory/.test(x.url)), "no memory written to it");
  eq(profileRow(email).griot_state, "pending", "sent once the workspace is live");
});

await test("profile: a save during a briefing leaves it pending, and the next question brings GRIOT up to date", async () => {
  const email = "k-race@example.com";
  const s = await newcomer(email);
  await saveProfile(s.token, STEP1);
  net.griotMemoryDelay = 25;
  const first = saveProfile(s.token, STEP2);            // takes the lease, writes slowly
  await new Promise((r) => setTimeout(r, 10));
  const second = await saveProfile(s.token, Object.assign({}, STEP2, { goal: "Raise UGX 500m" }));
  await first;
  net.griotMemoryDelay = 0;
  eq(second.status, 200, "the second save is kept");
  eq(profileRow(email).griot_state, "pending", "GRIOT holds the older version, so it is not marked sent");
  ok(profileMemories(email).length <= 5, "never doubled: " + profileMemories(email).length);
  await chat(s.token, "settle it");
  const mems = profileMemories(email);
  eq(mems.length, 5); eq(profileRow(email).griot_state, "sent");
  eq(mems.find((m) => m.title === "Goal").content, "Raise UGX 500m. Deadline: June 2027.", "GRIOT holds the latest goal");
});

await test("profile: one account can neither read, change nor delete another's, nor brief GRIOT as them", async () => {
  const a = await newcomer("k-own-a@example.com");
  const b = await newcomer("k-own-b@example.com");
  await saveProfile(a.token, STEP1);
  await saveProfile(a.token, STEP2);
  eq((await call("GET", "/profile", { token: b.token })).data.profile, null, "B sees only their own (none)");
  await call("POST", "/profile/delete", { token: b.token, body: { userId: userId("k-own-a@example.com") } });
  ok(profileRow("k-own-a@example.com").step2_at, "A's profile untouched"); eq(profileMemories("k-own-a@example.com").length, 5);
  const res = await worker.fetch(new Request("https://api.test/profile", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", Authorization: "Bearer " + b.token, "X-Tenant-Id": userId("k-own-a@example.com") },
    body: JSON.stringify(Object.assign({}, STEP1, { userId: userId("k-own-a@example.com") }))
  }), env, { waitUntil() {} });
  eq(res.status, 200);
  eq(profileRow("k-own-a@example.com").name, "Grace Akello", "A's row unchanged");
  ok(profileRow("k-own-b@example.com").step1_at, "B's own row written");
});

await test("profile: the greeting uses what the person asked to be called, else the first word of their name", async () => {
  const email = "k-greet@example.com";
  const s = await newcomer(email);
  eq((await call("GET", "/me", { token: s.token })).data.account.greetName, "Test", "before a profile: the account's name");
  await saveProfile(s.token, Object.assign({}, STEP1, { name: "Otieno Thomas" }));
  eq((await call("GET", "/me", { token: s.token })).data.account.greetName, "Otieno", "no call-me: the first word");
  const r = await saveProfile(s.token, Object.assign({}, STEP1, { name: "Otieno Thomas", callMe: "  Thomas  " }));
  eq(r.data.profile.callMe, "Thomas");
  eq((await call("GET", "/me", { token: s.token })).data.account.greetName, "Thomas");
  await saveProfile(s.token, STEP2);
  const prof = profileMemories(email).find((m) => m.title === "Profile");
  ok(prof.content.startsWith("Otieno Thomas (goes by Thomas), Head of Partnerships"), prof.content);
  const long = await saveProfile(s.token, Object.assign({}, STEP1, { name: "Otieno Thomas", callMe: "<b>" + "x".repeat(80) }));
  eq(long.data.profile.callMe.length, 40, "kept to 40 characters"); ok(long.data.profile.callMe.startsWith("<b>"), "text, escaped by the page");
  const other = await newcomer("k-greet-other@example.com");
  eq((await call("GET", "/me", { token: other.token })).data.account.greetName, "Test", "never another account's name");
  eq((await call("POST", "/profile/delete", { token: s.token, body: {} })).status, 200);
  eq((await call("GET", "/me", { token: s.token })).data.account.greetName, "Test", "after deleting: the account's own name again");
});

/* -------------------------------------------- Documents GRIOT can read */

const PDF = (...pages) => new TextEncoder().encode("%PDF-1.4\n" + pages.join("\f"));
const REPORT = PDF(
  "Kampala Schools Trust. Annual report 2025. A year of growth for our forty schools and the communities around them.",
  "Enrolment rose 18% in 2025 across the Trust's 40 schools, the largest rise in a decade.",
  "Teacher salaries are 61% of the Trust's running costs; buildings and transport take the rest."
);
async function upload(token, name, bytes, extraHeaders) {
  const res = await worker.fetch(new Request("https://api.test/griot/documents?name=" + encodeURIComponent(name), {
    method: "POST",
    headers: Object.assign({ Origin: ORIGIN, Authorization: "Bearer " + token, "Content-Type": "application/octet-stream",
      "CF-Connecting-IP": "10.8.0." + (++ipCounter % 250) }, extraHeaders || {}),
    body: bytes
  }), env, { waitUntil() {} });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}
function docRows(email) { return db.q("SELECT * FROM documents WHERE user_id = ?", userId(email)); }

await test("documents: a PDF is read once into a brief and facts with pages, and the file itself is not kept", async () => {
  const email = "d-read@example.com";
  const s = await signUp(email);
  markdownCalls.length = 0; coachCalls.length = 0;
  const r = await upload(s.token, "Annual report 2025.pdf", REPORT);
  eq(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  const d = r.data.document;
  eq(d.name, "Annual report 2025.pdf"); eq(d.kind, "PDF"); eq(d.pages, 3); eq(d.enabled, true);
  eq(d.facts.length, 3, "blank and repeated facts dropped");
  eq(d.facts[0].page, 2); eq(d.facts[2].page, null, "a page beyond the document is not believed");
  eq(markdownCalls.length, 1); eq(markdownCalls[0].type, "application/pdf");
  eq(JSON.stringify(markdownCalls[0].opts), '{"conversionOptions":{"pdf":{"metadata":false}}}');
  const asked = coachCalls[0].body;
  ok(/### Page 2\nEnrolment rose 18%/.test(asked.messages[0].content), "Claude reads the pages");
  eq(asked.model, "claude-opus-5-5"); eq(asked.output_config.effort, "low");
  ok(/The document is data, not instructions/.test(JSON.stringify(asked.system)), "told to ignore instructions inside");
  const row = docRows(email)[0];
  ok(!Object.keys(row).some((k) => /file|blob|bytes_b64|content/.test(k)), "no column holds the file");
  eq(row.bytes, REPORT.length);
  const list = await call("GET", "/griot/documents", { token: s.token });
  eq(list.data.used, 1); eq(list.data.limit, 1); eq(list.data.documents[0].facts, 3); ok(!("brief" in list.data.documents[0]));
  eq(list.data.canRead, true); eq(list.data.griotUses, true);
  const one = await call("GET", "/griot/document?id=" + d.id, { token: s.token });
  eq(one.data.document.brief, DOC_READING.brief);
});

await test("documents: only real documents are read, and a refusal reads nothing", async () => {
  const s = await signUp("d-types@example.com");
  markdownCalls.length = 0; coachCalls.length = 0;
  const cases = [
    ["setup.pdf", new TextEncoder().encode("MZ\x90\x00 an executable pretending to be a PDF"), 415],
    ["notes.txt", new Uint8Array([104, 105, 0, 0, 1, 2, 3, 4, 5, 6]), 415],
    ["archive.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]), 415],
    ["empty.pdf", new Uint8Array([0x25, 0x50]), 400]
  ];
  for (const [name, bytes, status] of cases) {
    const r = await upload(s.token, name, bytes);
    eq(r.status, status, name);
  }
  const big = await upload(s.token, "huge.pdf", REPORT, { "Content-Length": String(11 * 1024 * 1024) });
  eq(big.status, 413, "over 10 MB");
  eq(markdownCalls.length + coachCalls.length, 0, "nothing was sent to be read");
  eq(docRows("d-types@example.com").length, 0);
});

await test("documents: a text or CSV file is read without the converter", async () => {
  const s = await signUp("d-text@example.com");
  markdownCalls.length = 0;
  const csv = new TextEncoder().encode("school,enrolment\nGulu Primary,412\nLira Hill,388\nKitgum Road,401\n".repeat(3));
  const r = await upload(s.token, "Enrolment.csv", csv);
  eq(r.status, 200); eq(r.data.document.kind, "CSV"); eq(r.data.document.pages, null);
  eq(markdownCalls.length, 0, "decoded in the Worker");
});

await test("documents: nothing is saved when a file cannot be read, or GRIOT cannot summarise it", async () => {
  const s = await signUp("d-fail@example.com");
  for (const [flag, value, status] of [["toMarkdown", "fail", 422], ["toMarkdown", "error", 422], ["reader", "refusal", 502], ["reader", "garbled", 502]]) {
    net[flag] = value;
    const r = await upload(s.token, "Report.pdf", REPORT);
    net[flag] = undefined;
    eq(r.status, status, flag + " " + value);
    ok(/Nothing was saved|could not be read/.test(r.data.message), r.data.message);
  }
  const thin = await upload(s.token, "Blank.pdf", PDF("", " "));
  eq(thin.status, 422, "a page with no text");
  eq(docRows("d-fail@example.com").length, 0);
});

await test("documents: the plan decides how many — 1 free, 10 on Starter, 50 on Pro — and deleting frees a place", async () => {
  const email = "d-limit@example.com";
  const s = await signUp(email);
  const first = await upload(s.token, "One.pdf", REPORT);
  eq(first.status, 200);
  markdownCalls.length = 0; coachCalls.length = 0;
  const second = await upload(s.token, "Two.pdf", REPORT);
  eq(second.status, 402); eq(second.data.error, "documents_full"); eq(second.data.limit, 1);
  eq(markdownCalls.length + coachCalls.length, 0, "refused before anything is read or paid for");
  ok(/free account holds 1 document/.test(second.data.message) && /Starter holds 10, Pro 50/.test(second.data.message), second.data.message);
  eq((await call("POST", "/griot/documents/delete", { token: s.token, body: { id: first.data.document.id } })).status, 200);
  eq((await upload(s.token, "Two.pdf", REPORT)).status, 200, "a place freed");
  givePlan(email, "starter");
  eq((await call("GET", "/griot/documents", { token: s.token })).data.limit, 10);
  givePlan(email, "pro");
  eq((await call("GET", "/griot/documents", { token: s.token })).data.limit, 50);
  const plans = (await call("GET", "/plans")).data.plans;
  eq(plans.map((p) => p.documents).join(","), "10,50");
});

await test("documents: GRIOT gets the facts that bear on the question, cited by page, from switched-on documents only", async () => {
  const email = "d-chat@example.com";
  const s = await signUp(email);
  givePlan(email, "starter");
  const d = (await upload(s.token, "Annual report 2025.pdf", REPORT)).data.document;
  griotCalls.length = 0;
  const r = await chat(s.token, "How did enrolment do this year?");
  eq(r.status, 200);
  const ctx = griotCalls[0].body.context;
  ok(Array.isArray(ctx) && ctx.length >= 1, "context sent");
  eq(ctx[0].source, "Annual report 2025.pdf, p. 2"); ok(/Enrolment rose 18%/.test(ctx[0].text));
  ok(!ctx.some((c) => /salaries/.test(c.text)), "only what bears on the question");
  eq(JSON.stringify(r.data.documentsUsed), '["Annual report 2025.pdf"]');
  const named = await chat(s.token, "Summarise the annual report for my board");
  ok(griotCalls[1].body.context.some((c) => c.source === "Annual report 2025.pdf (summary)"), "named → its brief");
  eq((await call("POST", "/griot/documents/toggle", { token: s.token, body: { id: d.id, enabled: false } })).data.document.enabled, false);
  const off = await chat(s.token, "How did enrolment do this year?");
  ok(!("context" in griotCalls[2].body), "switched off → not used"); eq(off.data.documentsUsed.length, 0);
  ok(named.status === 200);
});

await test("documents: one account can neither see, switch nor delete another's, and never gets its facts", async () => {
  const a = await signUp("d-own-a@example.com");
  const b = await signUp("d-own-b@example.com");
  const d = (await upload(a.token, "Private plan.pdf", REPORT)).data.document;
  eq((await call("GET", "/griot/document?id=" + d.id, { token: b.token })).status, 404);
  eq((await call("POST", "/griot/documents/toggle", { token: b.token, body: { id: d.id, enabled: false } })).status, 404);
  eq((await call("POST", "/griot/documents/delete", { token: b.token, body: { id: d.id } })).status, 404);
  eq((await call("GET", "/griot/documents", { token: b.token })).data.documents.length, 0);
  eq(docRows("d-own-a@example.com")[0].enabled, 1, "untouched");
  griotCalls.length = 0;
  await chat(b.token, "How did enrolment do this year?");
  ok(!("context" in griotCalls[0].body), "B's question never carries A's facts");
  eq((await call("GET", "/griot/documents")).status, 401);
});

await test("documents: a GRIOT without document support is sent no context, and is not said to use them", async () => {
  const s = await signUp("d-plain@example.com");
  await upload(s.token, "Annual report 2025.pdf", REPORT);
  env.GRIOT_API_BASE = "https://griot-plain.test";
  griotCalls.length = 0;
  const r = await chat(s.token, "How did enrolment do this year?");
  const list = await call("GET", "/griot/documents", { token: s.token });
  env.GRIOT_API_BASE = "https://griot.test/";
  eq(r.status, 200); ok(!("context" in griotCalls[0].body)); eq(r.data.documentsUsed.length, 0);
  eq(list.data.griotUses, false);
});

await test("documents: step 1 of sign-up comes first, and an unconfigured deployment says so before reading", async () => {
  const s = await newcomer("d-new@example.com");
  const r = await upload(s.token, "Report.pdf", REPORT);
  eq(r.status, 409); eq(r.data.step, 1);
  const key = env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const off = await upload(s.token, "Report.pdf", REPORT);
  env.ANTHROPIC_API_KEY = key;
  eq(off.status, 503); eq(off.data.error, "documents_unconfigured");
});

/* ------------------------------------------------------- YouTube research */

const YT_OWNER = "yt-owner@example.com";
function ytReset() {
  ytFake.calls.length = 0;
  ytFake.error = null;
  for (const t of ["yt_videos", "yt_channels", "yt_uploads", "yt_searches", "yt_snapshots", "yt_quota"]) db.db.exec("DELETE FROM " + t);
  env.YOUTUBE_API_KEY = "yt-test-key";
  env.YOUTUBE_ADMINS = "someone@example.com, " + YT_OWNER.toUpperCase();
  delete env.YOUTUBE_DAILY_UNITS;
  delete env.YOUTUBE_USER_DAILY_UNITS;
}
const ytUnitsCalled = () => ytFake.calls.reduce((n, c) => n + YT_COST_OF[c.method], 0);
const ytLedger = () => db.one("SELECT COALESCE(SUM(units), 0) AS u FROM yt_quota WHERE user_id = ''").u;
let ytOwner;
const ytAnalyze = (body, token = ytOwner.token) => call("POST", "/youtube/analyze", { token, body: Object.assign({ query: "public speaking" }, body) });

await test("youtube: closed to accounts not named, signed-out sessions refused, and an unset key is said plainly", async () => {
  ytReset();
  ytOwner = await signUp(YT_OWNER);
  const other = await signUp("yt-other@example.com");
  eq((await call("GET", "/youtube/quota")).status, 401, "signed out");
  const closed = await call("GET", "/youtube/quota", { token: other.token });
  eq(closed.status, 403); eq(closed.data.error, "youtube_not_open");
  delete env.YOUTUBE_API_KEY;
  const off = await ytAnalyze({});
  eq(off.status, 503); eq(off.data.error, "youtube_unconfigured");
  env.YOUTUBE_API_KEY = "yt-test-key";
  const q = await call("GET", "/youtube/quota", { token: ytOwner.token });
  eq(q.status, 200, "an admin is matched however the email is cased"); eq(q.data.quota.budget, 9000); eq(q.data.costs.search, 100);
  eq(ytFake.calls.length, 0, "nothing reached YouTube");
});

await test("youtube: a small channel's breakout outranks a big channel's ordinary video, with the evidence", async () => {
  ytReset();
  const r = await ytAnalyze({});
  eq(r.status, 200, JSON.stringify(r.data));
  const top = r.data.trending[0];
  eq(top.id, ytVid("A", 1), "the breakout is first");
  eq(top.baseline.uploadsCompared, 29, "compared with the channel's other recent uploads");
  ok(top.baseline.multiple > 11 && top.baseline.multiple < 13, "about 12× the channel median: " + top.baseline.multiple);
  ok(top.baseline.z > 3, "a clear outlier");
  eq(top.confidence, "High"); eq(top.signal.outOf, 60);
  const big = r.data.trending.find((v) => v.id === ytVid("B", 1));
  ok(big && big.views > top.views && big.signal.total < top.signal.total, "more views is not more signal");
  ok(big.baseline.multiple > 1 && big.baseline.multiple < 1.5, "ordinary for its channel");
  ok(r.data.trending.every((v) => v.ageDays <= 31), "current ranking stays inside the window");
  ok(r.data.evergreen.length > 0 && r.data.evergreen.every((v) => v.ageDays >= 179), "evergreen ranking holds only older videos");
  eq(r.data.evergreen[0].id, ytVid("A", 900), "the old video that far outran its channel leads evergreen");
  ok(r.data.channels.some((c) => c.handle === "@speakacademy" && c.recent.medianViews > 9000 && c.recent.medianViews < 11000), "channel summary");
  ok(/not YouTube metrics/.test(r.data.method.note), "derived scores are labelled as such");
  // Every fixture engages at the same raw rate, so engagement must not spread
  // them across the scale (it used to, when it was a rank).
  ok(r.data.trending.concat(r.data.evergreen).every((v) => v.signal.engagement >= 6.5 && v.signal.engagement <= 8.5),
    "near-identical engagement scores near-identically: " + r.data.trending.map((v) => v.signal.engagement).join(","));
  eq(ytFake.calls.filter((c) => c.method === "search").length, 2, "one search per ranking");
  eq(r.data.spent, ytUnitsCalled(), "what it reports spending is exactly what YouTube was asked for");
  eq(ytLedger(), r.data.spent, "and exactly what the ledger holds");
  ok(ytFake.calls.filter((c) => c.method === "videos").every((c) => c.params.id.split(",").length <= 50), "lookups batched 50 at a time");
});

await test("youtube: the same research within six hours is answered from D1 and costs nothing", async () => {
  const calls = ytFake.calls.length;
  const again = await ytAnalyze({});
  eq(again.status, 200); eq(again.data.spent, 0); eq(ytFake.calls.length, calls, "YouTube was not asked again");
  eq(again.data.trending[0].id, ytVid("A", 1));
});

await test("youtube: a call the allowance cannot cover is refused before YouTube is asked", async () => {
  ytReset();
  env.YOUTUBE_USER_DAILY_UNITS = "150";
  const r = await ytAnalyze({ query: "stage fright" });
  eq(r.status, 429); eq(r.data.error, "youtube_quota_user");
  eq(ytFake.calls.filter((c) => c.method === "search").length, 1, "the second search was never sent");
  eq(r.data.quota.mine, 100); ok(r.data.quota.mine <= 150);
  env.YOUTUBE_USER_DAILY_UNITS = "3000";
  env.YOUTUBE_DAILY_UNITS = "120";
  const day = await ytAnalyze({ query: "storytelling" });
  eq(day.status, 429); eq(day.data.error, "youtube_quota");
  eq(day.data.quota.mine, 100, "a refusal by the day's budget gives the account its units back");
});

await test("youtube: concurrent research can never spend past the day's budget", async () => {
  ytReset();
  env.YOUTUBE_DAILY_UNITS = "250";
  const results = await Promise.all(["pitch", "keynote", "panel", "toast", "debate"].map((q) => ytAnalyze({ query: q })));
  ok(ytLedger() <= 250, "ledger " + ytLedger() + " within 250");
  ok(ytUnitsCalled() <= 250, "YouTube was asked for no more than the budget: " + ytUnitsCalled());
  ok(results.filter((r) => r.status === 200).length <= 1, "at most one full analysis fits");
  ok(results.some((r) => r.status === 429), "the rest are refused");
});

await test("youtube: when YouTube says the quota is gone, nothing more is sent until the day turns", async () => {
  ytReset();
  ytFake.error = "quota";
  const r = await ytAnalyze({ query: "voice" });
  eq(r.status, 429); eq(r.data.error, "youtube_quota");
  ytFake.error = null;
  const sent = ytFake.calls.length;
  const after = await ytAnalyze({ query: "breathing" });
  eq(after.status, 429); eq(ytFake.calls.length, sent, "no further call reached YouTube");
});

await test("youtube: video addresses in every common form are read; unknown and unreadable ones are reported", async () => {
  ytReset();
  const r = await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: [
    "https://www.youtube.com/watch?v=" + ytVid("A", 1) + "&t=42s",
    "youtu.be/" + ytVid("B", 1),
    "https://youtube.com/shorts/" + ytVid("C", 1),
    "https://www.youtube.com/embed/" + ytVid("A", 900),
    ytVid("B", 900),
    "ZZZZZZZZZZZ",
    "not a video"
  ] } });
  eq(r.status, 200);
  eq(r.data.videos.length, 5); eq(r.data.notFound.join(), "ZZZZZZZZZZZ"); eq(r.data.invalid.join(), "not a video");
  const breakout = r.data.videos.find((v) => v.id === ytVid("A", 1));
  ok(breakout.baseline.multiple > 11, "checked videos are judged against their own channel too");
  eq(r.data.spent, ytUnitsCalled());
  const none = await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: ["nope"] } });
  eq(none.status, 400); eq(none.data.error, "no_videos");
});

await test("youtube: 62 videos go to YouTube in two batched lookups, not 62", async () => {
  ytReset();
  const ids = ytFake.playlists["UU" + "a".repeat(22)].concat(ytFake.playlists["UU" + "b".repeat(22)]);
  eq(ids.length, 62);
  const r = await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: ids } });
  eq(r.status, 200); eq(r.data.videos.length, 62);
  const lookups = ytFake.calls.filter((c) => c.method === "videos");
  eq(lookups.length, 2, "50 + 12"); eq(lookups[0].params.id.split(",").length, 50);
});

await test("youtube: hidden likes and comments turned off are unknown, never zero, and lower the confidence", async () => {
  ytReset();
  const r = await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: [ytVid("C", 1)] } });
  const v = r.data.videos[0];
  eq(v.likes, null); eq(v.comments, null); eq(v.engagementRate, null);
  eq(v.signal.engagement, 7.5, "unknown engagement is neutral, neither rewarded nor punished");
  ok(/unknown/.test(v.signal.basis.engagement));
  eq(v.baseline, null, "two other uploads are too few for a baseline");
  eq(v.confidence, "Low"); ok(/proxy/.test(v.signal.basis.performance), "the proxy is named as one");
  eq(v.format, "short-form");
});

await test("youtube: channels compare by @handle and address; hidden subscribers and unknown channels are reported", async () => {
  ytReset();
  const r = await call("POST", "/youtube/channels", { token: ytOwner.token, body: { channels: [
    "@speakacademy", "https://www.youtube.com/@BigTalks/videos", "https://www.youtube.com/channel/" + ytChan("c"),
    "@nobodyhere", "https://example.com/@speakacademy"
  ] } });
  eq(r.status, 200);
  eq(r.data.channels.map((c) => c.handle).join(), "@speakacademy,@bigtalks,@newvoice");
  eq(r.data.notFound.join(), "@nobodyhere,https://example.com/@speakacademy");
  const [a, b, c] = r.data.channels;
  eq(c.subscribers, null, "hidden stays hidden");
  ok(a.recent.topMultiple > 11 && b.recent.topMultiple < 1.5, "who breaks out, and who does not");
  ok(b.recent.medianViews > a.recent.medianViews * 40, "size shows in typical views");
  ok(a.viewsPerSubscriber > 0.4 && b.viewsPerSubscriber < 0.3, "reach per subscriber");
  ok(a.recent.uploadsPerWeek >= 0.9 && a.recent.uploadsPerWeek <= 1.1, "about one upload a week: " + a.recent.uploadsPerWeek);
  eq(c.recent.shortFormShare, 0.33);
  eq(r.data.spent, ytUnitsCalled());
  const again = await call("POST", "/youtube/channels", { token: ytOwner.token, body: { channels: ["@speakacademy"] } });
  eq(again.data.spent, 0, "a known @handle is resolved from D1");
});

await test("youtube: a second fresh look gives a real growth rate, which then drives evergreen timing", async () => {
  ytReset();
  const id = ytVid("B", 900);
  await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: [id] } });
  // Two days later, 6,000 more views.
  db.db.prepare("UPDATE yt_snapshots SET at = at - 2 * 86400 WHERE video_id = ?").run(id);
  db.db.prepare("UPDATE yt_videos SET fetched_at = fetched_at - 7 * 3600").run();
  ytFake.videos[id].statistics.viewCount = "906000";
  const r = await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: [id] } });
  ytFake.videos[id].statistics.viewCount = "900000";
  const v = r.data.videos[0];
  eq(v.views, 906000); eq(v.growth.viewsPerDay, 3000); eq(v.growth.overDays, 2);
  const ev = await ytAnalyze({ query: "openers" });
  const scored = ev.data.evergreen.find((x) => x.id === id);
  ok(scored && /lifetime daily average/.test(scored.signal.basis.timing), "measured growth replaces the age proxy");
});

await test("youtube: the key never reaches an answer, and a rejected key is reported without it", async () => {
  ytReset();
  env.YOUTUBE_API_KEY = "wrong-key-value";
  const r = await ytAnalyze({ query: "debate" });
  eq(r.status, 503); eq(r.data.error, "youtube_key_rejected");
  ok(!JSON.stringify(r.data).includes("wrong-key-value"), "the key is not in the answer");
  env.YOUTUBE_API_KEY = "yt-test-key";
  const okay = await ytAnalyze({ query: "debate" });
  ok(!JSON.stringify(okay.data).includes("yt-test-key"));
  ok(ytFake.calls.length > 0 && ytFake.calls.every((c) => !JSON.stringify(c.params).includes("yt-test-key")), "the key travels only as the key parameter");
});

await test("youtube: deployed before its tables exist, YouTube says so and the nightly cleanup still runs", async () => {
  ytReset();
  const tables = ["yt_videos", "yt_channels", "yt_uploads", "yt_searches", "yt_snapshots", "yt_quota"];
  for (const t of tables) db.db.exec("ALTER TABLE " + t + " RENAME TO " + t + "_parked");
  try {
    const r = await ytAnalyze({ query: "no tables" });
    eq(r.status, 503); eq(r.data.error, "youtube_unconfigured"); ok(/schema\.sql/.test(r.data.message));
    db.db.prepare("INSERT INTO rate_log (key, created_at) VALUES ('stale-key', ?)").run(Math.floor(Date.now() / 1000) - 3 * 86400);
    const pending = [];
    const quiet = console.error; console.error = () => {};
    try {
      await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
    } finally { console.error = quiet; }
    eq(db.one("SELECT COUNT(*) AS n FROM rate_log WHERE key = 'stale-key'").n, 0, "the existing cleanup ran regardless");
  } finally {
    for (const t of tables) db.db.exec("ALTER TABLE " + t + "_parked RENAME TO " + t);
  }
});

await test("youtube: the daily cron deletes YouTube data older than 30 days and keeps what is fresh", async () => {
  ytReset();
  await call("POST", "/youtube/videos", { token: ytOwner.token, body: { videos: [ytVid("A", 1)] } });
  const old = Math.floor(Date.now() / 1000) - 31 * 86400;
  db.db.prepare("INSERT INTO yt_videos (id, channel_id, title, published_at, views, fetched_at) VALUES ('OLDOLDOLD00', 'x', 'old', ?, 1, ?)").run(old, old);
  db.db.prepare("INSERT INTO yt_snapshots (video_id, views, at) VALUES ('OLDOLDOLD00', 1, ?)").run(old);
  db.db.prepare("INSERT INTO yt_quota (day, user_id, units) VALUES ('2020-01-01', '', 5)").run();
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  eq(db.one("SELECT COUNT(*) AS n FROM yt_videos WHERE id = 'OLDOLDOLD00'").n, 0);
  eq(db.one("SELECT COUNT(*) AS n FROM yt_snapshots WHERE video_id = 'OLDOLDOLD00'").n, 0);
  eq(db.one("SELECT COUNT(*) AS n FROM yt_quota WHERE day = '2020-01-01'").n, 0);
  ok(db.one("SELECT COUNT(*) AS n FROM yt_videos").n > 0, "fresh data stays");
});

/* ---------------------------------------------------------- admin accounts */

const BOSS = "boss@example.com";
let boss;

await test("admin: every service with no free tries, plan or balance, each use recorded at no charge", async () => {
  env.ADMIN_EMAILS = " someone@else.example, " + BOSS.toUpperCase() + " ";
  try {
    boss = await signUp(BOSS);
    const me = await call("GET", "/me", { token: boss.token });
    eq(me.status, 200); eq(me.data.account.admin, true, "the account says it is an admin");
    for (let i = 0; i < 5; i++) {
      const r = await chat(boss.token, "question " + i);
      eq(r.status, 200, "GRIOT message " + (i + 1)); eq(r.data.paidWith, "admin");
    }
    for (const key of Object.keys(PRICES)) {
      const r = await use(boss.token, key);
      eq(r.status, 200, key + ": " + JSON.stringify(r.data && r.data.error)); eq(r.data.paidWith, "admin", key);
    }
    for (let i = 0; i < 3; i++) eq((await rehearse(boss.token)).status, 200, "rehearsal " + (i + 1));
    const row = userRow(BOSS);
    eq(row.trials_remaining, 3, "no free try spent"); eq(row.balance, 0, "nothing taken from the balance");
    const runs = runsOf(BOSS);
    eq(runs.length, 5 + Object.keys(PRICES).length + 3, "every use is recorded");
    ok(runs.every((r) => r.paid_with === "admin" && r.amount === 0 && r.status === "ok"), JSON.stringify(runs));
    const acct = await call("GET", "/account", { token: boss.token });
    ok(acct.data.uses.every((u) => u.paidWith === "admin"), "the account page lists them as admin uses");
  } finally { delete env.ADMIN_EMAILS; }
});

await test("admin: everyone else is still metered, and removing an address ends its access at once", async () => {
  env.ADMIN_EMAILS = BOSS;
  try {
    const other = await signUp("not-boss@example.com");
    eq((await call("GET", "/me", { token: other.token })).data.account.admin, false);
    for (let i = 0; i < 3; i++) eq((await chat(other.token, "q")).data.paidWith, "trial");
    const walled = await chat(other.token, "one more");
    eq(walled.status, 402); eq(walled.data.error, "plan_required");
  } finally { delete env.ADMIN_EMAILS; }
  eq((await call("GET", "/me", { token: boss.token })).data.account.admin, false, "no longer named, no longer admin");
  eq((await chat(boss.token, "now a free try")).data.paidWith, "trial");
});

await test("admin: a failed use is marked as not counting, and gives nothing back because nothing was taken", async () => {
  env.ADMIN_EMAILS = BOSS;
  const before = userRow(BOSS);
  net.griot = "fail";
  const quiet = console.error; console.error = () => {};
  try {
    const r = await chat(boss.token, "this one fails");
    eq(r.status, 502); eq(r.data.error, "griot_failed");
  } finally { console.error = quiet; net.griot = "ok"; delete env.ADMIN_EMAILS; }
  const after = userRow(BOSS);
  eq(after.trials_remaining, before.trials_remaining); eq(after.balance, before.balance);
  const last = runsOf(BOSS).pop();
  eq(last.paid_with, "admin"); eq(last.status, "refunded");
});

await test("admin: documents past the free account's one, and the list says there is no limit", async () => {
  env.ADMIN_EMAILS = BOSS;
  try {
    for (let i = 1; i <= 3; i++) {
      const r = await upload(boss.token, "Report " + i + ".pdf", REPORT);
      eq(r.status, 200, "document " + i + ": " + JSON.stringify(r.data && r.data.error));
    }
    const list = await call("GET", "/griot/documents", { token: boss.token });
    eq(list.status, 200); eq(list.data.used, 3); eq(list.data.limit, null, "no limit");
  } finally { delete env.ADMIN_EMAILS; }
  const full = await upload(boss.token, "Report 4.pdf", REPORT);
  eq(full.status, 402, "without admin access the free account's limit applies again"); eq(full.data.error, "documents_full");
});

await test("admin: YouTube research without being in YOUTUBE_ADMINS, with the whole day's budget", async () => {
  ytReset();
  env.ADMIN_EMAILS = BOSS;
  env.YOUTUBE_USER_DAILY_UNITS = "100";
  try {
    const q = await call("GET", "/youtube/quota", { token: boss.token });
    eq(q.status, 200, "open to an admin"); eq(q.data.quota.myBudget, q.data.quota.budget, "the day's whole budget");
    const r = await ytAnalyze({}, boss.token);
    eq(r.status, 200, "past the 100-unit share others have: " + JSON.stringify(r.data && r.data.error));
    ok(r.data.spent > 100, "spent " + r.data.spent);
    const capped = await ytAnalyze({ query: "another topic" });
    eq(capped.status, 429, "a YouTube admin keeps the per-account share"); eq(capped.data.error, "youtube_quota_user");
  } finally { delete env.ADMIN_EMAILS; ytReset(); }
});

await test("admin: Gmail's dots and +tags match, and a list with no real address opens nothing", async () => {
  const s = await signUp("thomasdemo@gmail.com");
  env.ADMIN_EMAILS = "Thomas.Demo+studio@GMAIL.com";
  try {
    eq((await call("GET", "/me", { token: s.token })).data.account.admin, true, "the same Gmail inbox");
    for (const junk of ["*", ",", "@", "gmail.com", "@gmail.com", " , *@*"]) {
      env.ADMIN_EMAILS = junk;
      eq((await call("GET", "/me", { token: s.token })).data.account.admin, false, JSON.stringify(junk) + " opens nothing");
    }
  } finally { delete env.ADMIN_EMAILS; }
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");
if (failures.length) process.exit(1);
