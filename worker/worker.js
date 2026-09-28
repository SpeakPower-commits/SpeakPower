/* ==========================================================================
   SpeakPower Studio API — Cloudflare Worker
   Single file, no build step, no dependencies. Paste it into the Cloudflare
   dashboard editor (Workers & Pages → your worker → Edit code) or deploy it
   with Workers Builds from this repo. Setup steps live in worker/README.md.

   What it does
   - Email sign-up with a 6-digit code (Turnstile-protected).
   - 3 free Studio runs per new account, then paid credits.
   - Runs the Studio products server-side, so the trial limit is real: the
     browser only renders what this Worker returns.
   - Stores contact-form leads and emails a notification.
   - Records first-party funnel events for measurement.

   Bindings (Settings → Bindings / Variables and Secrets)
     DB               D1 database            (required)
     SEND_EMAIL       Email Service binding  (required in production)
     SESSION_SECRET   secret, 32+ random chars (required)
     TURNSTILE_SECRET secret                 (required in production)
     PAGESPEED_KEY    secret                 (recommended)
     ALLOWED_ORIGINS  var, comma-separated   e.g. https://speakpower-commits.github.io
     MAIL_FROM        var, sender address on a domain onboarded to Cloudflare
     LEAD_NOTIFY_TO   var, inbox that receives contact-form leads
     CHECKOUT_URL     var, where exhausted-trial users go to pay (Flutterwave)
     FREE_TRIALS      var, default "3"
     ENVIRONMENT      var, "production" or "development"
   ========================================================================== */

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const OTP_TTL = 60 * 10;               // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(request, env, Object.assign({ error: err.code, message: err.message }, err.extra), err.status);
      }
      console.error("Unhandled error", err && err.stack ? err.stack : err);
      return json(request, env, { error: "server_error", message: "Something went wrong. Please try again." }, 500);
    }
  },

  // Housekeeping. Add a Cron Trigger (e.g. "0 3 * * *") under Settings → Triggers.
  async scheduled(event, env, ctx) {
    const now = nowSec();
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare("DELETE FROM rate_log WHERE created_at < ?").bind(now - 86400),
      env.DB.prepare("DELETE FROM otp_codes WHERE expires_at < ?").bind(now - 3600)
    ]));
  }
};

/* --------------------------------------------------------------------------
   Routing
   ------------------------------------------------------------------------ */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  // A browser request from any site other than SpeakPower is refused outright.
  if (request.headers.get("Origin") && !allowedOrigin(request, env)) {
    return json(request, env, { error: "origin_not_allowed" }, 403);
  }

  if (request.method === "GET") {
    if (path === "/health") return json(request, env, { ok: true });
    if (path === "/me") return me(request, env);
  }

  if (request.method === "POST") {
    if (path === "/auth/start") return authStart(request, env);
    if (path === "/auth/verify") return authVerify(request, env);
    if (path === "/studio/generate") return generate(request, env);
    if (path === "/lead") return lead(request, env, ctx);
    if (path === "/event") return trackEvent(request, env);
  }

  return json(request, env, { error: "not_found" }, 404);
}

/* --------------------------------------------------------------------------
   Auth: email + one-time code
   ------------------------------------------------------------------------ */

async function authStart(request, env) {
  const body = await readJson(request);
  const email = str(body.email, 254);
  const name = str(body.name, 120);

  if (!EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  }

  const canon = canonicalEmail(email);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipKey = (await sha256Hex("ip:" + ip + ":" + secret(env, "SESSION_SECRET"))).slice(0, 24);

  if (!(await rateLimit(env, "start-ip:" + ipKey, 10, 3600)) ||
      !(await rateLimit(env, "start-email:" + canon, 5, 3600))) {
    throw new HttpError(429, "rate_limited", "Too many sign-in attempts. Please wait a while and try again.");
  }

  if (!(await verifyTurnstile(body.turnstileToken, ip, env))) {
    throw new HttpError(400, "bot_check_failed", "The security check did not pass. Please try again.");
  }

  const now = nowSec();
  const pending = await env.DB
    .prepare("SELECT created_at FROM otp_codes WHERE email_canonical = ?")
    .bind(canon).first();
  if (pending && now - pending.created_at < 60) {
    throw new HttpError(429, "slow_down", "A code was just sent. Wait a minute before asking for another.");
  }

  // Free trials are granted on INSERT only: signing in again never resets them.
  await env.DB.prepare(
    "INSERT INTO users (id, email, email_canonical, name, trials_remaining, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(email_canonical) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), users.name)"
  ).bind(crypto.randomUUID(), email, canon, name, freeTrials(env), now).run();

  const code = sixDigitCode();
  await env.DB.prepare(
    "INSERT INTO otp_codes (email_canonical, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) " +
    "ON CONFLICT(email_canonical) DO UPDATE SET code_hash = excluded.code_hash, " +
    "expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at"
  ).bind(canon, await otpHash(canon, code, env), now + OTP_TTL, now).run();

  const sent = await sendEmail(env, {
    to: email,
    subject: "Your SpeakPower Studio code: " + code,
    text: [
      "Hello" + (name ? " " + name : "") + ",",
      "",
      "Your SpeakPower Studio sign-in code is: " + code,
      "",
      "It expires in 10 minutes. If you did not ask for this code, you can ignore this email.",
      "",
      "— SpeakPower"
    ].join("\n")
  });

  const res = { ok: true, expiresIn: OTP_TTL };
  // Local testing only: with no email binding in development, hand the code back.
  if (!sent && isDev(env)) res.devCode = code;
  return json(request, env, res);
}

async function authVerify(request, env) {
  const body = await readJson(request);
  const email = str(body.email, 254);
  const code = str(body.code, 12).replace(/\D/g, "");

  if (!EMAIL_RE.test(email) || code.length !== 6) {
    throw new HttpError(400, "invalid_code", "Enter the 6-digit code from the email.");
  }

  const canon = canonicalEmail(email);
  const now = nowSec();

  // Spend an attempt atomically before comparing, so parallel guesses cannot
  // exceed the limit.
  const attempt = await env.DB.prepare(
    "UPDATE otp_codes SET attempts = attempts + 1 WHERE email_canonical = ? AND attempts < ? " +
    "RETURNING code_hash, expires_at"
  ).bind(canon, OTP_MAX_ATTEMPTS).first();

  if (!attempt) {
    throw new HttpError(400, "code_expired", "That code is no longer valid. Request a new one.");
  }
  if (attempt.expires_at < now) {
    throw new HttpError(400, "code_expired", "That code has expired. Request a new one.");
  }
  if (!safeEqual(await otpHash(canon, code, env), attempt.code_hash)) {
    throw new HttpError(400, "invalid_code", "That code is not right. Check the email and try again.");
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM otp_codes WHERE email_canonical = ?").bind(canon),
    env.DB.prepare(
      "UPDATE users SET verified = 1, verified_at = COALESCE(verified_at, ?), last_seen_at = ? WHERE email_canonical = ?"
    ).bind(now, now, canon)
  ]);

  const user = await env.DB.prepare("SELECT * FROM users WHERE email_canonical = ?").bind(canon).first();
  if (!user) throw new HttpError(400, "code_expired", "That code is no longer valid. Request a new one.");

  await logEvent(env, "signup_verified", { userId: user.id, anonId: body.anonId, page: body.page });

  const expiresAt = now + SESSION_TTL;
  const token = await signToken({ uid: user.id, sv: user.session_version, exp: expiresAt }, env);
  return json(request, env, { token, expiresAt, account: publicAccount(user, env) });
}

async function me(request, env) {
  const user = await authenticate(request, env);
  await env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(nowSec(), user.id).run();
  return json(request, env, { account: publicAccount(user, env) });
}

async function authenticate(request, env, required = true) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const payload = match ? await verifyToken(match[1].trim(), env) : null;
  const user = payload
    ? await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.uid).first()
    : null;

  if (!user || !user.verified || user.session_version !== payload.sv) {
    if (required) throw new HttpError(401, "signed_out", "Your session has ended. Please sign in again.");
    return null;
  }
  return user;
}

function publicAccount(user, env) {
  return {
    email: user.email,
    name: user.name || "",
    trialsRemaining: user.trials_remaining,
    credits: user.credits,
    plan: user.plan,
    freeTrials: freeTrials(env)
  };
}

/* --------------------------------------------------------------------------
   Studio: metered generation
   ------------------------------------------------------------------------ */

async function generate(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request, 65536);
  const key = str(body.product, 40);
  const product = PRODUCTS[key];

  if (!product) throw new HttpError(400, "unknown_product", "That Studio product does not exist.");

  // Validate before spending anything.
  const inputs = product.validate(body.inputs && typeof body.inputs === "object" ? body.inputs : {});
  const now = nowSec();

  // Reserve one run: free trials first, then paid credits. Each UPDATE is a
  // single atomic statement, so two parallel requests can never spend the
  // same trial.
  let paidWith = "trial";
  let balance = await env.DB.prepare(
    "UPDATE users SET trials_remaining = trials_remaining - 1, last_seen_at = ? " +
    "WHERE id = ? AND trials_remaining > 0 RETURNING trials_remaining, credits"
  ).bind(now, user.id).first();

  if (!balance) {
    paidWith = "credit";
    balance = await env.DB.prepare(
      "UPDATE users SET credits = credits - 1, last_seen_at = ? " +
      "WHERE id = ? AND credits > 0 RETURNING trials_remaining, credits"
    ).bind(now, user.id).first();
  }

  if (!balance) {
    await logEvent(env, "trials_exhausted", { userId: user.id, anonId: body.anonId, product: key, page: body.page });
    return json(request, env, {
      error: "trials_exhausted",
      message: "You have used your free runs. Continue with a paid run to generate this pack.",
      product: key,
      productTitle: product.title,
      price: product.price,
      checkoutUrl: env.CHECKOUT_URL || null,
      account: publicAccount(user, env)
    }, 402);
  }

  const run = await env.DB.prepare(
    "INSERT INTO runs (user_id, product, paid_with, status, created_at) VALUES (?, ?, ?, 'ok', ?) RETURNING id"
  ).bind(user.id, key, paidWith, now).first();

  let sections;
  try {
    sections = await product.run(inputs, env);
  } catch (err) {
    // A failed generation never costs the customer: give the run back.
    const column = paidWith === "trial" ? "trials_remaining" : "credits";
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET " + column + " = " + column + " + 1 WHERE id = ?").bind(user.id),
      env.DB.prepare("UPDATE runs SET status = 'refunded' WHERE id = ?").bind(run.id)
    ]);
    if (!(err instanceof HttpError)) console.error("Product run failed", key, err);
    const reason = err instanceof HttpError ? err.message : "The product could not generate a result.";
    throw new HttpError(err instanceof HttpError ? err.status : 502, "generation_failed",
      reason + " Your run was not used.");
  }

  await logEvent(env, "studio_generate", { userId: user.id, anonId: body.anonId, product: key, page: body.page });

  const account = publicAccount(user, env);
  account.trialsRemaining = balance.trials_remaining;
  account.credits = balance.credits;
  return json(request, env, { product: key, title: product.title, sections, paidWith, account });
}

/* --------------------------------------------------------------------------
   Studio products
   Every generator returns [[heading, text], ...]. The browser escapes it
   before rendering, so nothing here is ever interpreted as markup.
   ------------------------------------------------------------------------ */

function textProduct(title, price, fields, build) {
  return {
    title,
    price,
    validate(raw) {
      const v = {};
      for (const [name, label, max] of fields) {
        v[name] = str(raw[name], max);
        if (!v[name]) throw new HttpError(400, "missing_field", "Complete this field first: " + label + ".", { field: name });
      }
      return v;
    },
    async run(v) { return build(v); }
  };
}

const PRODUCTS = {
  "brand-story": textProduct("Brand Story Builder", "UGX 100,000", [
    ["brand", "Brand / organisation name", 120],
    ["offer", "What you offer", 1500],
    ["audience", "Who is it for?", 300],
    ["problem", "Problem you solve", 1500],
    ["result", "Result you create", 1500],
    ["proof", "Proof", 1500],
    ["difference", "What makes you different?", 1500],
    ["ambition", "Where are you going?", 1500]
  ], (v) => [
    ["Core story", v.brand + " exists to help " + v.audience + " move from " + lower(v.problem) + " to " + lower(v.result) + " through " + lower(v.offer) + "."],
    ["Positioning statement", v.brand + " helps " + v.audience + " achieve " + lower(v.result) + " by combining " + lower(v.offer) + " with " + lower(v.difference) + "."],
    ["30-second pitch", "We help " + v.audience + " who are dealing with " + lower(v.problem) + ". Through " + lower(v.offer) + ", we help them " + lower(v.result) + ". What makes us different is " + lower(v.difference) + ". Our experience includes " + lower(v.proof) + "."],
    ["2-minute story", v.brand + " was built around a simple observation: " + v.problem + ". We therefore focus on " + v.offer + " for " + v.audience + ". The goal is practical: " + v.result + ". We bring " + v.proof + ", and our distinctive approach is " + v.difference + ". We are building toward " + v.ambition + "."],
    ["Messaging pillar 1", "The problem: " + v.problem],
    ["Messaging pillar 2", "The value: " + v.result],
    ["Messaging pillar 3", "The difference: " + v.difference],
    ["Tagline directions", "Built for " + v.audience + ". | From " + v.problem + " to " + v.result + ". | " + titleCase(v.difference) + "."],
    ["Call to action", "Ready to " + lower(v.result) + "? Start with " + v.brand + "."]
  ]),

  "market-plan": textProduct("Market Development Planner", "UGX 125,000", [
    ["business", "Business / organisation", 120],
    ["offer", "Main offer", 1500],
    ["audience", "Target market", 300],
    ["geography", "Market / geography", 200],
    ["problem", "Customer problem", 1500],
    ["advantage", "Your advantage", 1500],
    ["competitors", "Alternatives / competitors", 1500],
    ["channels", "Current channels", 1500],
    ["goal", "90-day goal", 1000]
  ], (v) => [
    ["Market opportunity", v.business + " is positioned around " + v.offer + " for " + v.audience + " in " + v.geography + "."],
    ["Core market problem", v.problem],
    ["Positioning angle", "Lead with the specific outcome: " + v.goal + ". Support it with the advantage of " + v.advantage + "."],
    ["Competitive lens", "Map " + v.competitors + " against four questions: who they serve, what they promise, how they prove it and where their visibility is strongest."],
    ["Visibility priorities", "1. Strengthen the website story.\n2. Build search-focused content around real customer questions.\n3. Make the offer easy to understand on social and professional channels.\n4. Use partnerships and speaking opportunities to reach trusted audiences."],
    ["30 days", "Clarify the offer, audience and proof. Clean up core website and profile messaging. Establish 3 content themes tied to " + v.problem + "."],
    ["60 days", "Publish consistently, test calls to action, document customer questions and identify the channels producing qualified attention."],
    ["90 days", "Double down on the strongest channel, refine the offer using evidence and build a repeatable acquisition routine around the goal: " + v.goal + "."],
    ["Working KPI set", "Visibility: qualified visits. Engagement: enquiries / conversations. Conversion: offers accepted or next-step actions. Learning: recurring objections and customer questions."]
  ]),

  "content-seo": textProduct("SEO Content Starter", "UGX 75,000", [
    ["business", "Business / brand", 120],
    ["offer", "What you sell", 1500],
    ["audience", "Audience", 300],
    ["location", "Location / market", 200],
    ["topic1", "Customer topic 1", 300],
    ["topic2", "Customer topic 2", 300],
    ["topic3", "Customer topic 3", 300],
    ["proof", "Proof", 1500]
  ], (v) => [
    ["Search themes", v.offer + " " + v.location + "\n" + v.topic1 + "\n" + v.topic2 + "\n" + v.topic3],
    ["Content opportunity 1", "Answer: " + v.topic1],
    ["Content opportunity 2", "Explain: " + v.topic2],
    ["Content opportunity 3", "Compare: " + v.topic3],
    ["Content opportunity 4", "How-to guide for " + v.audience + " interested in " + v.offer],
    ["Content opportunity 5", "Local / practical guide for " + v.location + " around " + v.offer],
    ["Content opportunity 6", "Common mistakes " + v.audience + " make before choosing " + v.offer],
    ["Content opportunity 7", "What good " + v.offer + " looks like, using proof: " + v.proof],
    ["Content opportunity 8", "FAQ: " + v.topic1],
    ["Content opportunity 9", "FAQ: " + v.topic2],
    ["Content opportunity 10", "FAQ: " + v.topic3],
    ["CTA bank", "Learn more. | Compare your options. | Request a quote. | Book a consultation. | Start with a quick assessment."],
    ["Publishing rhythm", "Week 1: question answer. Week 2: educational guide. Week 3: proof. Week 4: offer + CTA."]
  ]),

  "speaker-ready": textProduct("Speaker Ready Pack", "UGX 75,000", [
    ["speaker", "Speaker name", 120],
    ["topic", "Topic", 300],
    ["audience", "Audience", 300],
    ["time", "Speaking time", 60],
    ["goal", "Audience outcome", 1000],
    ["idea1", "Key idea 1", 1500],
    ["idea2", "Key idea 2", 1500],
    ["idea3", "Key idea 3", 1500],
    ["story", "Story / proof", 2000]
  ], (v) => [
    ["Talk title", titleCase(v.topic) + ": What Your Audience Needs to Know"],
    ["Opening hook", "Most people think " + lower(v.topic) + " is mainly about information. The bigger question is what changes for " + v.audience + " when the idea becomes practical."],
    ["Audience promise", "By the end of this " + v.time + " session, the audience should " + lower(v.goal) + "."],
    ["Part 1 — The problem", v.idea1],
    ["Part 2 — The shift", v.idea2],
    ["Part 3 — The action", v.idea3],
    ["Story / proof", v.story],
    ["Transition 1", "Now that we have seen the problem, let's look at what needs to change."],
    ["Transition 2", "The important point is not only understanding this; it is deciding what to do with it."],
    ["Closing", "The challenge is simple: " + lower(v.goal) + ". Start with one action and make it visible."],
    ["Likely Q&A", "What is the biggest obstacle to applying this?\nWhat would you change first?\nCan you give a practical example?\nWhat happens when people disagree?"]
  ]),

  "seo-audit": {
    title: "Website SEO & Visibility Audit",
    price: "UGX 75,000",
    validate(raw) {
      const value = str(raw.url, 2048);
      let parsed;
      try { parsed = new URL(value); } catch (e) { parsed = null; }
      if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
          parsed.hostname.indexOf(".") === -1) {
        throw new HttpError(400, "invalid_url", "Enter a full public website address, e.g. https://example.com.", { field: "url" });
      }
      return { url: parsed.toString() };
    },
    async run(v, env) {
      let endpoint = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=" + encodeURIComponent(v.url) +
        "&category=seo&category=performance&category=accessibility&category=best-practices";
      if (env.PAGESPEED_KEY) endpoint += "&key=" + encodeURIComponent(env.PAGESPEED_KEY);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      let data;
      try {
        const res = await fetch(endpoint, { signal: controller.signal });
        if (!res.ok) throw new HttpError(502, "pagespeed_failed", "Google PageSpeed could not analyse that URL right now.");
        data = await res.json();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(504, "pagespeed_timeout", "Google PageSpeed took too long to respond.");
      } finally {
        clearTimeout(timer);
      }

      const lh = data.lighthouseResult || {};
      const scores = lh.categories || {};
      const sections = [];
      ["seo", "performance", "accessibility", "best-practices"].forEach((k) => {
        if (scores[k] && typeof scores[k].score === "number") {
          sections.push([titleCase(k.replace("-", " ")), Math.round(scores[k].score * 100) + " / 100"]);
        }
      });

      const audits = lh.audits || {};
      const failures = Object.keys(audits).map((id) => {
        const a = audits[id];
        if (!a || !a.title || a.scoreDisplayMode === "informative" || a.score === null) return null;
        return { title: a.title, score: a.score, display: a.displayValue || "" };
      }).filter(Boolean).filter((a) => a.score < 1).sort((a, b) => a.score - b.score).slice(0, 10);

      sections.push(["Top findings", failures.length
        ? failures.map((a) => a.title + (a.display ? " — " + a.display : "")).join("\n")
        : "No failed Lighthouse audits were returned."]);
      sections.push(["What to fix first", "1. Address the highest-impact failed SEO checks.\n2. Improve pages with weak search intent alignment and unclear headings.\n3. Improve performance and accessibility issues that affect user experience.\n4. Re-run the audit after changes."]);
      sections.push(["Important note", "This is an automated technical audit based on the public URL. Search Console data, rankings, backlinks and conversion performance require access to the website's own data and are outside this automated check."]);
      return sections;
    }
  },

  // The CSV itself never leaves the visitor's browser. The page computes
  // column-level summary statistics locally and sends only those; this
  // Worker turns them into the report.
  "data-story": {
    title: "Data Story Builder",
    price: "UGX 100,000",
    validate(raw) {
      const s = raw.summary && typeof raw.summary === "object" ? raw.summary : null;
      const rows = s ? num(s.rows) : null;
      const columns = s ? num(s.columns) : null;
      if (!s || !rows || rows < 1 || !columns || columns < 1) {
        throw new HttpError(400, "invalid_dataset", "The CSV needs a header row and at least one data row.", { field: "csv" });
      }
      const list = (a) => (Array.isArray(a) ? a.slice(0, 200) : []);
      return {
        rows: Math.floor(rows),
        columns: Math.floor(columns),
        numeric: list(s.numeric).map((x) => ({
          name: str(x && x.name, 120), mean: num(x && x.mean), min: num(x && x.min), max: num(x && x.max)
        })).filter((x) => x.name && x.mean !== null && x.min !== null && x.max !== null),
        categorical: list(s.categorical).map((x) => ({
          name: str(x && x.name, 120),
          distinct: num(x && x.distinct),
          top: (Array.isArray(x && x.top) ? x.top.slice(0, 5) : [])
            .map((t) => [str(t && t[0], 80), num(t && t[1])])
            .filter((t) => t[0] && t[1] !== null)
        })).filter((x) => x.name),
        missing: list(s.missing).map((x) => ({
          name: str(x && x.name, 120), ratio: num(x && x.ratio)
        })).filter((x) => x.name && x.ratio !== null && x.ratio > 0)
      };
    },
    async run(d) {
      const sections = [["Dataset profile", d.rows + " data rows across " + d.columns + " columns."]];
      const missTop = d.missing.slice().sort((a, b) => b.ratio - a.ratio).slice(0, 5);
      sections.push(["Missing values", missTop.length
        ? missTop.map((x) => x.name + ": " + Math.round(x.ratio * 100) + "% missing").join("\n")
        : "No missing values found in the inspected columns."]);

      if (d.numeric.length) {
        sections.push(["Numeric summary", d.numeric.map((x) =>
          x.name + ": mean " + x.mean.toFixed(2) + " | min " + x.min.toFixed(2) + " | max " + x.max.toFixed(2)).join("\n")]);
        const widest = d.numeric.slice().sort((a, b) => (b.max - b.min) - (a.max - a.min))[0];
        sections.push(["Largest numeric range", widest.name + " spans from " + widest.min.toFixed(2) + " to " + widest.max.toFixed(2) + "."]);
      }
      if (d.categorical.length) {
        sections.push(["Category patterns", d.categorical.map((x) => x.top.length
          ? x.name + ": " + x.top.map((t) => t[0] + " (" + t[1] + ")").join(", ")
          : x.name + ": " + (x.distinct !== null ? x.distinct + " distinct values" : "mostly unique values") +
            " (identifiers or free text — values not summarised)").join("\n")]);
      }

      const segments = d.categorical.filter((x) => x.top.length);
      const story = ["The dataset contains " + d.rows + " observations and " + d.columns + " variables."];
      if (d.numeric.length) story.push("The strongest first-pass quantitative story is around " + d.numeric.slice(0, 4).map((x) => x.name).join(", ") + ".");
      if (segments.length) story.push("The most useful segmentation fields appear to include " + segments.slice(0, 4).map((x) => x.name).join(", ") + ".");
      if (missTop.length) story.push("Data quality needs attention in " + missTop[0].name + " first because " + Math.round(missTop[0].ratio * 100) + "% of values are missing.");
      story.push("This is a descriptive first pass, not a causal conclusion. The next analysis should test the questions that matter to the decision behind the dataset.");
      sections.push(["Plain-language data story", story.join(" ")]);
      sections.push(["Next questions", "What changed most?\nWhich groups differ?\nWhich variables move together?\nWhat decision is this dataset supposed to support?"]);
      return sections;
    }
  }
};

/* --------------------------------------------------------------------------
   Leads (contact form)
   ------------------------------------------------------------------------ */

async function lead(request, env, ctx) {
  const body = await readJson(request, 16384);

  // Honeypot: the form has a hidden "website" field people never see. Bots
  // fill it; pretend success so they move on.
  if (str(body.website, 200)) return json(request, env, { ok: true });

  const name = str(body.name, 120);
  const organization = str(body.organization, 160);
  const email = str(body.email, 254);
  const service = str(body.service, 120);
  const message = str(body.message, 5000);
  const page = str(body.page, 200);

  if (!name || !EMAIL_RE.test(email) || !service || !message) {
    throw new HttpError(400, "missing_field", "Please complete the required fields before continuing.");
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipKey = (await sha256Hex("ip:" + ip + ":" + secret(env, "SESSION_SECRET"))).slice(0, 24);
  if (!(await rateLimit(env, "lead-ip:" + ipKey, 5, 3600))) {
    throw new HttpError(429, "rate_limited", "Too many messages from this connection. Please try again later.");
  }

  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO leads (name, organization, email, service, message, page, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(name, organization || null, email, service, message, page || null, now).run();

  await logEvent(env, "contact_submit", { anonId: body.anonId, page });

  if (env.LEAD_NOTIFY_TO) {
    ctx.waitUntil(sendEmail(env, {
      to: env.LEAD_NOTIFY_TO,
      subject: "New SpeakPower enquiry — " + name + (organization ? " (" + organization + ")" : ""),
      text: [
        "Name: " + name,
        "Organization: " + (organization || "Not provided"),
        "Email: " + email,
        "Area of help: " + service,
        "",
        "Context:",
        message,
        "",
        "Received: " + new Date(now * 1000).toISOString()
      ].join("\n")
    }).catch((err) => console.error("Lead notification failed", err)));
  }

  return json(request, env, { ok: true });
}

/* --------------------------------------------------------------------------
   Funnel events
   ------------------------------------------------------------------------ */

// Events the browser may report. Sign-up, generation and exhausted-trial
// events are recorded server-side by the handlers above, so they cannot be
// faked or double-counted from the page.
const CLIENT_EVENTS = new Set([
  "audit_run", "studio_view", "signup_started", "studio_download", "checkout_click"
]);

async function trackEvent(request, env) {
  const body = await readJson(request, 4096);
  const name = str(body.name, 40);
  if (!CLIENT_EVENTS.has(name)) return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipKey = (await sha256Hex("ip:" + ip + ":" + secret(env, "SESSION_SECRET"))).slice(0, 24);
  if (await rateLimit(env, "event-ip:" + ipKey, 300, 3600)) {
    await logEvent(env, name, { anonId: body.anonId, page: body.page, product: body.product });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function logEvent(env, name, opts) {
  const o = opts || {};
  const anon = str(o.anonId, 64).replace(/[^a-zA-Z0-9-]/g, "") || null;
  try {
    await env.DB.prepare(
      "INSERT INTO events (name, page, product, anon_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(name, str(o.page, 200) || null, str(o.product, 40) || null, anon, o.userId || null, nowSec()).run();
  } catch (err) {
    // Measurement must never break the product.
    console.error("Event log failed", name, err);
  }
}

/* --------------------------------------------------------------------------
   Infrastructure helpers
   ------------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.indexOf(origin) !== -1 ? origin : null;
}

function corsHeaders(request, env) {
  const headers = { "Vary": "Origin" };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(request, env, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }, corsHeaders(request, env))
  });
}

async function readJson(request, maxBytes) {
  const limit = maxBytes || 32768;
  if (Number(request.headers.get("Content-Length") || 0) > limit) {
    throw new HttpError(413, "payload_too_large", "That request is too large.");
  }
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "payload_too_large", "That request is too large.");
  let value;
  try { value = JSON.parse(text || "{}"); } catch (e) { value = null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "bad_request", "The request could not be read.");
  }
  return value;
}

async function rateLimit(env, key, limit, windowSec) {
  const now = nowSec();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_log WHERE key = ? AND created_at > ?")
    .bind(key, now - windowSec).first();
  if (row && row.n >= limit) return false;
  await env.DB.prepare("INSERT INTO rate_log (key, created_at) VALUES (?, ?)").bind(key, now).run();
  return true;
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) {
    if (isDev(env)) return true;
    throw new HttpError(500, "config_error", "Sign-up is not configured yet.");
  }
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", String(token).slice(0, 2048));
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  if (!res.ok) return false;
  const data = await res.json();
  return !!(data && data.success === true);
}

// All outbound email goes through this one function. It uses the Cloudflare
// Email Service Workers binding; if that API changes, this is the only place
// to update. Returns true when an email was handed to the binding.
async function sendEmail(env, message) {
  if (!env.SEND_EMAIL || !env.MAIL_FROM) {
    if (isDev(env)) {
      console.log("[dev] email not sent (no binding):", message.to, "—", message.subject);
      return false;
    }
    throw new HttpError(500, "config_error", "Email is not configured yet.");
  }
  await env.SEND_EMAIL.send({
    to: message.to,
    from: env.MAIL_FROM,
    subject: message.subject,
    text: message.text
  });
  return true;
}

function secret(env, name) {
  const value = env[name];
  if (!value || String(value).length < 32) {
    throw new HttpError(500, "config_error", "The service is not configured yet.");
  }
  return String(value);
}

async function signToken(payload, env) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret(env, "SESSION_SECRET"));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return body + "." + b64url(sig);
}

async function verifyToken(token, env) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await hmacKey(secret(env, "SESSION_SECRET"));
    // crypto.subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    if (!payload || typeof payload.uid !== "string" || typeof payload.exp !== "number" || payload.exp < nowSec()) return null;
    return payload;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
}

function hmacKey(secretValue) {
  return crypto.subtle.importKey("raw", enc.encode(secretValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function otpHash(canon, code, env) {
  return sha256Hex("otp:" + canon + ":" + code + ":" + secret(env, "SESSION_SECRET"));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
}

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value) {
  let s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// One inbox, one set of free trials: lower-case everything, drop "+tags",
// and for Gmail drop dots too (Gmail ignores them).
function canonicalEmail(email) {
  const e = String(email).trim().toLowerCase();
  const at = e.lastIndexOf("@");
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local + "@" + domain;
}

function freeTrials(env) {
  const n = parseInt(env.FREE_TRIALS || "3", 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function isDev(env) {
  return env.ENVIRONMENT === "development";
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function str(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function num(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function lower(s) {
  s = String(s || "").trim();
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function titleCase(s) {
  return String(s || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
