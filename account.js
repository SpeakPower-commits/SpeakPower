/* ==========================================================================
   SpeakPower — accounts
   One account for every service: sign in with Google, keep one session,
   show the plan or the free tries, open a plan or a top-up, and settle it
   when the customer returns from Flutterwave. Used by account.html,
   plans.html, studio-product.html, griot-app.html and rehearse.html; needs
   script.js (window.SP) loaded first.

   GRIOT and the Rehearsal Room come with a plan and are never priced per
   use; Studio packs have a one-off price paid from the balance. Every number
   that matters is decided by the Worker; this file only displays it.

   Security: dynamic text goes through textContent, never innerHTML.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  if (!SP) return;

  var SESSION_KEY = "sp_studio_session"; // one session for Studio and GRIOT
  var listeners = [];

  var SERVICE_NAMES = {
    "brand-story": "Brand Story Builder",
    "seo-audit": "Website SEO & Visibility Audit",
    "market-plan": "Market Development Planner",
    "content-seo": "SEO Content Starter",
    "data-story": "Data Story Builder",
    "speaker-ready": "Speaker Ready Pack",
    "griot": "GRIOT",
    "rehearsal": "Rehearsal Room"
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatUgx(n) {
    return "UGX " + Math.round(Number(n) || 0).toLocaleString("en-US");
  }

  function triesText(n) {
    n = Number(n) || 0;
    return n + " free " + (n === 1 ? "try" : "tries");
  }

  // "8 Nov" from Unix seconds: the one date format the pages show.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayMonth(sec) {
    var d = new Date(Number(sec) * 1000);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  }

  // What each plan is for, in words: the fair-use numbers live in the plan's
  // details on plans.html, never in a pay wall.
  var PLAN_LINES = {
    starter: "GRIOT on working days, the Rehearsal Room, and everything GRIOT remembers for you.",
    pro: "Heavier GRIOT use, more rehearsals, one Studio pack a month and 15% off the rest."
  };

  /* -------------------------------------------------------------- session */

  function session() {
    var raw = SP.storageGet(SESSION_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (!s || !s.token) return null;
      if (s.expiresAt && s.expiresAt * 1000 < Date.now()) { SP.storageSet(SESSION_KEY, null); return null; }
      return s;
    } catch (e) { return null; }
  }

  function save(s) {
    SP.storageSet(SESSION_KEY, s ? JSON.stringify(s) : null);
    if (SP.renderAccountLink) SP.renderAccountLink();
    var account = s ? s.account : null;
    listeners.slice().forEach(function (fn) { try { fn(account); } catch (e) { /* one page bug must not stop others */ } });
  }

  function account() {
    var s = session();
    return s ? s.account : null;
  }

  function setAccount(next) {
    var s = session();
    if (!s || !next) return;
    s.account = next;
    save(s);
  }

  function signOut() { save(null); }

  function onChange(fn) { listeners.push(fn); }

  // An authenticated call. A 401 means the session is over everywhere, so the
  // stored copy is dropped and every listener hears about it.
  function call(path, body) {
    var s = session();
    if (!s) {
      var out = new Error("Please sign in first.");
      out.status = 401;
      out.code = "signed_out";
      return Promise.reject(out);
    }
    return SP.api(path, { token: s.token, body: body }).then(null, function (e) {
      if (e.status === 401) signOut();
      throw e;
    });
  }

  function refresh() {
    return call("/me").then(function (data) {
      setAccount(data.account);
      return data.account;
    });
  }

  /* --------------------------------------------------------------- sign-in */

  function googleEnabled() { return !!SP.config.googleClientId; }
  function emailEnabled() { return !!SP.config.emailCodes; }
  function signInAvailable() { return SP.connected && (googleEnabled() || emailEnabled()); }

  var activeSignIn = null; // the panel Google's callback reports to
  var googleState = "idle"; // idle → loading → ready | failed
  var googleQueue = [];

  function loadGoogle(done) {
    if (googleState === "ready") { done(); return; }
    googleQueue.push(done);
    if (googleState === "loading") return;
    googleState = "loading";
    function ready() {
      window.google.accounts.id.initialize({
        client_id: SP.config.googleClientId,
        callback: function (response) { if (activeSignIn) activeSignIn.google(response); },
        ux_mode: "popup",
        cancel_on_tap_outside: true
      });
      googleState = "ready";
      googleQueue.splice(0).forEach(function (fn) { fn(); });
    }
    // Already on the page (another script loaded it): never load it twice.
    if (window.google && window.google.accounts && window.google.accounts.id) { ready(); return; }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = ready;
    s.onerror = function () {
      googleState = "failed";
      googleQueue.splice(0).forEach(function (fn) { fn(new Error("Google sign-in could not load. Check your connection and reload the page.")); });
      googleState = "idle"; // a reload, or the next mount, may try again
    };
    document.head.appendChild(s);
  }

  var turnstileWidget = null;
  function renderTurnstile(host, onToken) {
    var siteKey = SP.config.turnstileSiteKey;
    if (!siteKey) return;
    function render() {
      turnstileWidget = window.turnstile.render(host, {
        sitekey: siteKey,
        callback: onToken,
        "expired-callback": function () { onToken(""); },
        "error-callback": function () { onToken(""); }
      });
    }
    if (window.turnstile) { render(); return; }
    window.spTurnstileReady = render;
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=spTurnstileReady&render=explicit";
    s.async = true;
    document.head.appendChild(s);
  }

  // Builds the sign-in panel into `host`. Calls opts.onSignedIn(account) once
  // the person is in. Shows only the routes this deployment supports — never
  // a form that would fail after someone has filled it in.
  function mountSignIn(host, opts) {
    opts = opts || {};
    host.textContent = "";
    var box = el("div", "signin");
    box.appendChild(el("h2", null, opts.title || "Sign in to SpeakPower"));
    box.appendChild(el("p", "builder-note signin-lead",
      opts.lead || "One account for every Studio service and GRIOT. Your first 3 tries are free, on any service."));
    var error = el("p", "builder-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    function showError(message) { error.textContent = message || ""; error.hidden = !message; }

    if (!signInAvailable()) {
      box.appendChild(el("p", null, "Sign-in opens here shortly. Nothing you enter on this site is sent anywhere until then."));
      host.appendChild(box);
      return;
    }

    function finish(data) {
      save({ token: data.token, expiresAt: data.expiresAt, account: data.account });
      if (activeSignIn === controller) activeSignIn = null;
      if (opts.onSignedIn) opts.onSignedIn(data.account);
    }

    var controller = {
      google: function (response) {
        showError("");
        if (!response || !response.credential) {
          showError("Google sign-in was cancelled. Try again, or choose another account.");
          return;
        }
        SP.api("/auth/google", {
          body: { credential: response.credential, anonId: SP.anonId, page: location.pathname }
        }).then(finish, function (e) { showError(e.message); });
      }
    };
    activeSignIn = controller;

    if (googleEnabled()) {
      var gWrap = el("div", "signin-google");
      var gBtn = el("div", "signin-google-btn");
      gWrap.appendChild(gBtn);
      box.appendChild(gWrap);
      loadGoogle(function (failure) {
        if (failure) { showError(failure.message); return; }
        // Google's button takes 200–400px; fit the panel on a phone.
        var width = Math.max(200, Math.min(400, Math.floor(gWrap.getBoundingClientRect().width || 320)));
        window.google.accounts.id.renderButton(gBtn, {
          theme: "outline", size: "large", text: "continue_with", shape: "pill", width: width
        });
      });
    }

    if (emailEnabled()) {
      if (googleEnabled()) box.appendChild(el("p", "signin-or", "or use your email"));
      var turnstileToken = "";
      var pendingEmail = "";

      var start = el("form", "signin-email");
      start.noValidate = true;
      start.appendChild(field("signin-name", "Your name", "input", { autocomplete: "name", maxLength: 120 }));
      start.appendChild(field("signin-email", "Email", "input", { type: "email", autocomplete: "email", maxLength: 254 }));
      var tsHost = el("div", "signin-turnstile");
      start.appendChild(tsHost);
      var startBtn = el("button", "btn btn-primary", "Send my code");
      startBtn.type = "submit";
      start.appendChild(actions(startBtn));

      var verify = el("form", "signin-code");
      verify.noValidate = true;
      verify.hidden = true;
      var sentTo = el("p", "builder-note");
      verify.appendChild(sentTo);
      verify.appendChild(field("signin-code", "Six-digit code", "input", { inputMode: "numeric", autocomplete: "one-time-code", maxLength: 6 }));
      var verifyBtn = el("button", "btn btn-primary", "Continue");
      verifyBtn.type = "submit";
      var restart = el("button", "btn btn-ghost", "Use a different email");
      restart.type = "button";
      verify.appendChild(actions(verifyBtn, restart));

      box.appendChild(start);
      box.appendChild(verify);
      renderTurnstile(tsHost, function (t) { turnstileToken = t; });

      start.addEventListener("submit", function (event) {
        event.preventDefault();
        showError("");
        var email = start.querySelector("#signin-email").value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError("Enter a valid email address."); return; }
        if (SP.config.turnstileSiteKey && !turnstileToken) { showError("Please complete the security check first."); return; }
        startBtn.disabled = true;
        startBtn.textContent = "Sending…";
        SP.api("/auth/start", {
          body: { email: email, name: start.querySelector("#signin-name").value.trim(), turnstileToken: turnstileToken }
        }).then(function () {
          pendingEmail = email;
          sentTo.textContent = "We sent a six-digit code to " + email + ". It expires in ten minutes.";
          start.hidden = true;
          verify.hidden = false;
          verify.querySelector("#signin-code").focus();
        }, function (e) {
          showError(e.message);
          if (window.turnstile && turnstileWidget) { try { window.turnstile.reset(turnstileWidget); } catch (x) { /* gone */ } }
          turnstileToken = "";
        }).then(function () {
          startBtn.disabled = false;
          startBtn.textContent = "Send my code";
        });
      });

      verify.addEventListener("submit", function (event) {
        event.preventDefault();
        showError("");
        var code = verify.querySelector("#signin-code").value.replace(/\D/g, "");
        if (code.length !== 6) { showError("Enter the 6-digit code from the email."); return; }
        verifyBtn.disabled = true;
        SP.api("/auth/verify", {
          body: { email: pendingEmail, code: code, anonId: SP.anonId, page: location.pathname }
        }).then(finish, function (e) { showError(e.message); }).then(function () { verifyBtn.disabled = false; });
      });

      restart.addEventListener("click", function () {
        verify.hidden = true;
        start.hidden = false;
        showError("");
      });
    }

    box.appendChild(error);
    box.appendChild(el("p", "builder-note signin-fine",
      "Signing in creates your account the first time. We keep your email and name, your balance and what you used — nothing else."));
    host.appendChild(box);
  }

  function field(id, label, tag, props) {
    var wrap = el("div", "builder-field");
    var l = el("label", null, label);
    l.htmlFor = id;
    var input = el(tag);
    input.id = id;
    Object.keys(props || {}).forEach(function (k) { input[k] = props[k]; });
    wrap.appendChild(l);
    wrap.appendChild(input);
    return wrap;
  }

  function actions() {
    var row = el("div", "builder-actions");
    for (var i = 0; i < arguments.length; i++) row.appendChild(arguments[i]);
    return row;
  }

  /* --------------------------------------------------------------- top-up */

  // Amounts worth offering: the presets that cover what is needed, led by the
  // exact shortfall when that is not already one of them.
  function topUpChoices(acct, shortfall) {
    var presets = (acct && acct.topUps) || [];
    var need = Math.max(0, Math.ceil(Number(shortfall) || 0));
    var list = presets.filter(function (a) { return a >= need; });
    if (need >= 1000 && list.indexOf(need) === -1) list.unshift(need);
    if (!list.length) list = presets.slice();
    return list.slice(0, 4).map(function (a) { return { amount: a, exact: a === need && presets.indexOf(a) === -1 }; });
  }

  function startTopUp(amount, returnTo) {
    return call("/wallet/checkout", { amount: amount, returnTo: returnTo, anonId: SP.anonId, page: location.pathname })
      .then(function (data) { window.location.assign(data.link); });
  }

  function startPlan(plan, returnTo) {
    return call("/plans/checkout", { plan: plan, returnTo: returnTo, anonId: SP.anonId, page: location.pathname })
      .then(function (data) { window.location.assign(data.link); });
  }

  // The wall GRIOT and the Rehearsal Room show: the plans, never a price per
  // use. Choosing one opens checkout and comes straight back to this page.
  function renderPlanWall(host, info) {
    info = info || {};
    var acct = info.account || account() || {};
    var m = acct.membership;
    var plans = info.plans || acct.plans || [];
    host.textContent = "";
    host.appendChild(el("h2", null, info.heading || (m && m.plan ? "Your month's allowance is used" : "Keep going with a plan")));
    var lead = info.message || (m && m.plan ? "It renews on " + dayMonth(m.endsAt) + "." : "Your free tries are used.");
    host.appendChild(el("p", null, lead +
      " Every plan runs 30 days and includes GRIOT and the Rehearsal Room. Pay by mobile money or card; renewing is one tap."));

    var error = el("p", "builder-error");
    error.setAttribute("role", "alert");
    error.hidden = true;

    var grid = el("div", "plan-offer");
    plans.forEach(function (plan) {
      if (m && m.plan === plan.key && plan.key === "pro") return; // already on the top plan
      var card = el("div", "plan-offer-card" + (plan.key === "pro" ? " plan-offer-card--pro" : ""));
      card.appendChild(el("h3", null, plan.name));
      var price = el("p", "plan-offer-price", formatUgx(plan.price));
      price.appendChild(el("span", null, " / 30 days"));
      card.appendChild(price);
      card.appendChild(el("p", "plan-offer-line", PLAN_LINES[plan.key] || ""));
      var b = el("button", plan.key === "starter" && !(m && m.plan) ? "btn btn-primary" : "btn btn-ghost",
        m && m.plan && m.plan !== plan.key ? "Switch to " + plan.name : "Choose " + plan.name);
      b.type = "button";
      if (!acct.canBuyPlans) b.hidden = true;
      b.addEventListener("click", function () {
        if (grid.getAttribute("aria-busy") === "true") return;
        grid.setAttribute("aria-busy", "true");
        var label = b.textContent;
        b.textContent = "Opening secure checkout…";
        error.hidden = true;
        startPlan(plan.key, info.returnTo).then(null, function (e) {
          grid.removeAttribute("aria-busy");
          b.textContent = label;
          error.textContent = e.message;
          error.hidden = false;
          if (e.status === 401 && info.onSignedOut) info.onSignedOut();
        });
      });
      card.appendChild(b);
      grid.appendChild(card);
    });
    host.appendChild(grid);
    host.appendChild(error);

    if (!acct.canBuyPlans) {
      host.appendChild(el("p", "builder-note", "Online payment opens shortly. Until then, message me and I will switch your plan on."));
      var talk = el("a", "btn btn-ghost", "Message me on WhatsApp");
      talk.href = "https://wa.me/256743482588?text=" + encodeURIComponent("Hi Otieno, I would like a SpeakPower plan.");
      talk.target = "_blank";
      talk.rel = "noopener";
      host.appendChild(actions(talk));
      return;
    }
    var more = el("a", "plan-offer-more", "Compare the plans");
    more.href = "plans.html";
    var note = el("p", "builder-note", "Switching plan starts the new one today. ");
    note.appendChild(more);
    host.appendChild(note);
  }

  // The pay wall every service shows. GRIOT and the Rehearsal Room offer the
  // plans; a Studio pack says what it costs, what is there, and offers a
  // top-up that comes straight back to this page.
  function renderPayWall(host, info) {
    info = info || {};
    if (info.plans || info.error === "plan_required") return renderPlanWall(host, info);
    var acct = info.account || account() || {};
    host.textContent = "";
    host.appendChild(el("h2", null, info.heading || "Top up to continue"));

    var lines = [];
    if (info.intro) {
      lines.push("Add to your balance once; every Studio pack draws on it.");
    } else {
      if (!(Number(acct.trialsRemaining) > 0)) lines.push("Your free tries are used.");
      if (info.title && info.price) {
        lines.push(info.title + " costs " + formatUgx(info.price) + "; your balance is " + formatUgx(acct.balance) + ".");
      }
    }
    host.appendChild(el("p", null, lines.join(" ")));

    var error = el("p", "builder-error");
    error.setAttribute("role", "alert");
    error.hidden = true;

    if (!acct.canTopUp) {
      host.appendChild(el("p", "builder-note", "Online top-up opens shortly. Until then, talk to me and I will add credit to your account."));
      var talk = el("a", "btn btn-ghost", "Talk to me");
      talk.href = "contact.html#main";
      host.appendChild(actions(talk));
      return;
    }

    var row = el("div", "builder-actions topup-options");
    topUpChoices(acct, info.shortfall).forEach(function (choice) {
      var b = el("button", choice.exact ? "btn btn-primary" : "btn btn-ghost",
        "Top up " + formatUgx(choice.amount) + (choice.exact ? " — exactly what this needs" : ""));
      b.type = "button";
      b.addEventListener("click", function () {
        if (row.getAttribute("aria-busy") === "true") return;
        row.setAttribute("aria-busy", "true");
        var label = b.textContent;
        b.textContent = "Opening secure checkout…";
        error.hidden = true;
        startTopUp(choice.amount, info.returnTo).then(null, function (e) {
          row.removeAttribute("aria-busy");
          b.textContent = label;
          error.textContent = e.message;
          error.hidden = false;
          if (e.status === 401 && info.onSignedOut) info.onSignedOut();
        });
      });
      row.appendChild(b);
    });
    host.appendChild(row);
    host.appendChild(error);
    host.appendChild(el("p", "builder-note",
      "Pay by card or mobile money (MTN, Airtel) through Flutterwave. You come straight back here, and your balance works on every Studio pack."));
  }

  /* ------------------------------------------------- back from Flutterwave */

  // Flutterwave returns with ?status=…&tx_ref=…&transaction_id=…. Read them
  // once and take them out of the address bar, so a reload or a shared link
  // never re-submits a payment reference. Other parameters (?product=) stay.
  var returned = (function () {
    var url = new URL(window.location.href);
    var txRef = url.searchParams.get("tx_ref");
    if (!txRef) return null;
    var r = {
      txRef: txRef,
      transactionId: url.searchParams.get("transaction_id") || "",
      status: (url.searchParams.get("status") || "").toLowerCase()
    };
    ["tx_ref", "transaction_id", "status"].forEach(function (k) { url.searchParams.delete(k); });
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    return r;
  })();

  // Resolves to null when there is nothing to settle, otherwise to
  // { ok: boolean, text: string } for the page to show.
  function settleReturn() {
    var r = returned;
    if (!r) return Promise.resolve(null);
    if (r.status === "cancelled" || !r.transactionId) {
      returned = null;
      return Promise.resolve({ ok: false, text: "Payment cancelled — nothing was charged." });
    }
    if (!session()) {
      return Promise.resolve({ ok: false, text: "Sign in to see your payment. If it went through, it is already on your account." });
    }
    returned = null;
    return call("/wallet/confirm", { txRef: r.txRef, transactionId: r.transactionId }).then(function (data) {
      setAccount(data.account);
      var isPlan = /^plan:/.test(data.purpose || "");
      if (data.status === "credited" || data.status === "already_credited") {
        var m = data.account.membership;
        if (isPlan && m) {
          return { ok: true, plan: true, text: m.plan
            ? "Payment received — your " + m.name + " plan runs until " + dayMonth(m.paidUntil) + "."
            : "Payment received — your plan starts on " + dayMonth(m.next.startsAt) + "." };
        }
        return { ok: true, text: "Payment received — " + formatUgx(data.amount) + " added. Your balance is " + formatUgx(data.account.balance) + "." };
      }
      return { ok: false, text: isPlan
        ? "We could not confirm that payment yet. If you were charged, your plan switches on automatically as soon as it clears."
        : "We could not confirm that payment yet. If you were charged, it is added to your balance automatically as soon as it clears." };
    }, function (e) {
      return { ok: false, text: e.message };
    });
  }

  /* ------------------------------------- Try → sign up → straight back in */

  // The pages a visitor may be sent on to after signing up: our own service
  // pages only, so ?next= can never send anyone off-site.
  function safeNext(value) {
    var v = String(value || "");
    if (v === "griot-app.html" || v === "rehearse.html" || v === "plans.html") return v;
    var m = v.match(/^studio-product\.html\?product=([a-z-]{2,40})$/);
    return m && m[1] !== "griot" && SERVICE_NAMES[m[1]] ? v : null;
  }

  function nextServiceName(next) {
    if (next === "griot-app.html") return "GRIOT";
    if (next === "rehearse.html") return "the Rehearsal Room";
    if (next === "plans.html") return "your plan";
    var m = String(next || "").match(/product=([a-z-]+)$/);
    return m ? SERVICE_NAMES[m[1]] : "";
  }

  // Every service page calls this first. A visitor without an account goes to
  // the one sign-up page and comes straight back here once signed in, so
  // every "Try" button means the same thing: sign up, then start.
  function requireAccount(next) {
    if (session()) return false;
    window.location.replace("account.html?next=" + encodeURIComponent(next));
    return true;
  }

  /* --------------------------------------------------------- status line */

  // The one-line summary pages show: "Starter plan · renews 8 Nov", or
  // "2 free tries left (any service)". The balance appears only where it
  // can be spent: on Studio packs (opts.balance).
  function statusText(acct, opts) {
    if (!acct) return "";
    opts = opts || {};
    var m = acct.membership;
    var free = Number(acct.trialsRemaining) || 0;
    var parts = [];
    if (m && m.plan) {
      parts.push(m.name + " plan · " + (m.next ? "paid until " + dayMonth(m.paidUntil) : "renews " + dayMonth(m.endsAt)));
    } else if (m && m.next) {
      parts.push(m.next.name + " plan starts " + dayMonth(m.next.startsAt));
    }
    if (free > 0) parts.push(triesText(free) + " left (any service)");
    else if (!(m && m.plan)) parts.push("free tries used");
    if (opts.balance) parts.push("balance " + formatUgx(acct.balance));
    return parts.join(" · ");
  }

  // A member's month at a glance: a bar for one allowance, as a share of
  // the month, never a count. Empty (and hidden) without a plan.
  function renderUsage(host, acct, service) {
    if (!host) return;
    host.textContent = "";
    var m = acct && acct.membership;
    var pct = m && m.plan && m.usage ? Math.max(0, Math.min(100, Number(m.usage[service]) || 0)) : null;
    host.hidden = pct === null;
    if (pct === null) return;
    var label = el("p", "usage-label");
    label.appendChild(el("span", null, "This month"));
    label.appendChild(el("span", "usage-value", pct >= 100 ? "All used · renews " + dayMonth(m.endsAt)
      : pct >= 80 ? "Most used · renews " + dayMonth(m.endsAt) : pct + "% used"));
    host.appendChild(label);
    var track = el("div", "usage-track");
    track.setAttribute("role", "img");
    track.setAttribute("aria-label", pct + "% of this month's allowance used");
    var fill = el("i", "usage-fill" + (pct >= 80 ? " usage-fill--high" : ""));
    fill.style.width = pct + "%";
    track.appendChild(fill);
    host.appendChild(track);
    if (m.renewSoon) {
      var renew = el("a", "usage-renew", "Renew for another 30 days");
      renew.href = "plans.html";
      host.appendChild(renew);
    }
  }

  window.SPAccount = {
    SERVICE_NAMES: SERVICE_NAMES,
    session: session,
    account: account,
    setAccount: setAccount,
    signOut: signOut,
    onChange: onChange,
    call: call,
    refresh: refresh,
    signInAvailable: signInAvailable,
    mountSignIn: mountSignIn,
    renderPayWall: renderPayWall,
    renderPlanWall: renderPlanWall,
    renderUsage: renderUsage,
    startPlan: startPlan,
    dayMonth: dayMonth,
    PLAN_LINES: PLAN_LINES,
    topUpChoices: topUpChoices,
    startTopUp: startTopUp,
    settleReturn: settleReturn,
    hasReturn: function () { return !!returned; },
    safeNext: safeNext,
    nextServiceName: nextServiceName,
    requireAccount: requireAccount,
    statusText: statusText,
    formatUgx: formatUgx,
    triesText: triesText
  };
})();
