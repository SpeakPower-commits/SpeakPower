/* ==========================================================================
   SpeakPower Studio — builder page
   The page collects the brief and renders the result. Generation happens in
   the Cloudflare Worker (worker/worker.js), which also enforces the free-run
   allowance — keeping the generators server-side is what makes the limit real.

   Flow: fill the brief → Generate → (first time) email code sign-up →
   Worker spends one run and returns the pack → render / download.

   Every string written with innerHTML goes through esc(). Depends on
   window.SP from script.js.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP || null;
  var $ = function (id) { return document.getElementById(id); };

  var PRODUCTS = {
    "brand-story": {
      title: "Brand Story Builder",
      price: "UGX 100,000",
      lead: "Turn what you do into a story people can understand, remember and repeat.",
      fields: [
        ["brand", "Brand / organisation name", "", "text"],
        ["offer", "What you offer", "Product, service, programme or expertise.", "textarea"],
        ["audience", "Who is it for?", "The people or organisations you most need to reach.", "text"],
        ["problem", "Problem you solve", "What is difficult, costly, confusing or frustrating for the audience?", "textarea"],
        ["result", "Result you create", "What becomes better after someone chooses you?", "textarea"],
        ["proof", "Proof", "Experience, results, partners, location, credentials, products, etc.", "textarea"],
        ["difference", "What makes you different?", "Your method, perspective, story, access or advantage.", "textarea"],
        ["ambition", "Where are you going?", "The future you are trying to create.", "textarea"]
      ]
    },
    "seo-audit": {
      title: "Website SEO & Visibility Audit",
      price: "UGX 75,000",
      lead: "Enter a public website URL and let Google Lighthouse check search fundamentals, performance, accessibility and best practices.",
      fields: [
        ["url", "Website URL", "https://example.com", "url"]
      ],
      busyLabel: "Auditing… this can take up to a minute",
      privacy: "only the public URL you enter is sent, to Google PageSpeed via SpeakPower. SpeakPower records only which product you ran."
    },
    "market-plan": {
      title: "Market Development Planner",
      price: "UGX 125,000",
      lead: "Build a practical 30/60/90-day market-development starting point from your own business knowledge.",
      fields: [
        ["business", "Business / organisation", "", "text"],
        ["offer", "Main offer", "What are you trying to grow?", "textarea"],
        ["audience", "Target market", "Who should buy, use or support the offer?", "text"],
        ["geography", "Market / geography", "Kampala, Uganda, East Africa, a sector, etc.", "text"],
        ["problem", "Customer problem", "What real problem does the market have?", "textarea"],
        ["advantage", "Your advantage", "Why can you credibly compete?", "textarea"],
        ["competitors", "Alternatives / competitors", "Who else solves the problem or gets the customer's attention?", "textarea"],
        ["channels", "Current channels", "Website, SEO, LinkedIn, Facebook, referrals, events, partners, etc.", "textarea"],
        ["goal", "90-day goal", "What measurable result do you want?", "textarea"]
      ]
    },
    "content-seo": {
      title: "SEO Content Starter",
      price: "UGX 75,000",
      lead: "Turn your expertise and customer questions into an SEO-informed content starter plan.",
      fields: [
        ["business", "Business / brand", "", "text"],
        ["offer", "What you sell", "", "textarea"],
        ["audience", "Audience", "", "text"],
        ["location", "Location / market", "Example: Kampala, Uganda", "text"],
        ["topic1", "Customer topic 1", "A question customers ask.", "text"],
        ["topic2", "Customer topic 2", "A second question or pain point.", "text"],
        ["topic3", "Customer topic 3", "A third question or pain point.", "text"],
        ["proof", "Proof", "One credible thing you can demonstrate regularly.", "textarea"]
      ]
    },
    "data-story": {
      title: "Data Story Builder",
      price: "UGX 100,000",
      lead: "Upload a non-sensitive CSV and get a first-pass profile, patterns, gaps and plain-language story.",
      fields: [
        ["csv", "CSV dataset", "Choose a non-sensitive .csv file", "file"]
      ],
      privacy: "your CSV is read in your browser and never uploaded. Only column-level summary statistics (column names, averages, ranges and the most common repeated categories) are sent to build the report. Unique values such as names, emails or IDs are never sent."
    },
    "speaker-ready": {
      title: "Speaker Ready Pack",
      price: "UGX 75,000",
      lead: "Go from topic to a rehearsable talk structure without starting from a blank page.",
      fields: [
        ["speaker", "Speaker name", "", "text"],
        ["topic", "Topic", "What are you speaking about?", "text"],
        ["audience", "Audience", "Who will be in the room?", "text"],
        ["time", "Speaking time", "10 minutes, 30 minutes, 1 hour...", "text"],
        ["goal", "Audience outcome", "What should people understand, feel or do?", "textarea"],
        ["idea1", "Key idea 1", "", "textarea"],
        ["idea2", "Key idea 2", "", "textarea"],
        ["idea3", "Key idea 3", "", "textarea"],
        ["story", "Story / proof", "A case, experience or example.", "textarea"]
      ]
    }
  };

  var requested = new URLSearchParams(window.location.search).get("product");
  var key = PRODUCTS[requested] ? requested : "brand-story";
  var product = PRODUCTS[key];

  var form = $("builderForm");
  var outputHost = $("outputHost");
  var downloadBtn = $("downloadBtn");
  var generateBtn = $("generateBtn");
  var lastSections = [];

  $("builderTitle").textContent = product.title;
  $("builderLead").textContent = product.lead;
  $("builderPrice").textContent = product.price;
  if (product.privacy) {
    var note = $("privacyNote");
    note.textContent = "";
    var strong = document.createElement("strong");
    strong.textContent = "Privacy: ";
    note.appendChild(strong);
    note.appendChild(document.createTextNode(product.privacy));
  }

  /* ------------------------------------------------------------------------
     Brief form
     ---------------------------------------------------------------------- */

  function renderForm() {
    form.innerHTML = "";
    product.fields.forEach(function (f) {
      var wrap = document.createElement("div");
      wrap.className = "builder-field";
      var label = document.createElement("label");
      label.htmlFor = "field-" + f[0];
      label.textContent = f[1];
      wrap.appendChild(label);

      var input;
      if (f[3] === "textarea") {
        input = document.createElement("textarea");
        input.rows = 4;
        input.maxLength = 1500;
      } else {
        input = document.createElement("input");
        input.type = f[3] === "file" ? "file" : f[3] === "url" ? "url" : "text";
        if (f[3] === "file") input.accept = ".csv,text/csv";
        else input.maxLength = f[3] === "url" ? 2048 : 300;
      }
      input.id = "field-" + f[0];
      input.name = f[0];
      input.required = true;
      if (f[3] !== "file") input.placeholder = f[2] || "";
      wrap.appendChild(input);
      form.appendChild(wrap);
    });
  }

  function textValues() {
    var v = {};
    product.fields.forEach(function (f) {
      var el = form.elements[f[0]];
      v[f[0]] = String((el && el.value) || "").trim();
    });
    return v;
  }

  // What gets sent to the Worker. For the Data Story the CSV is profiled
  // here and only the summary leaves the browser.
  function collectInputs() {
    if (key !== "data-story") return Promise.resolve(textValues());
    var file = form.elements.csv && form.elements.csv.files[0];
    if (!file) return Promise.reject(new Error("Choose a CSV file first."));
    if (file.size > 20 * 1024 * 1024) return Promise.reject(new Error("That CSV is over 20 MB. Use a smaller extract."));
    return file.text().then(function (text) {
      return { summary: summarise(parseCSV(text)) };
    });
  }

  /* ------------------------------------------------------------------------
     CSV profiling (local only)
     ---------------------------------------------------------------------- */

  function parseCSV(text) {
    var rows = [], row = [], cell = "", quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i], next = text[i + 1];
      if (quoted) {
        if (ch === '"' && next === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else {
        if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else if (ch !== "\r") cell += ch;
      }
    }
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  function numValue(x) {
    var s = String(x == null ? "" : x).trim().replace(/,/g, "");
    if (!s) return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function summarise(rows) {
    if (rows.length < 2) throw new Error("The CSV needs a header row and at least one data row.");
    var headers = rows[0].map(function (x, i) { return String(x || "").trim() || ("Column " + (i + 1)); });
    var data = rows.slice(1);
    var numeric = [], categorical = [], missing = [];

    headers.forEach(function (h, idx) {
      var vals = data.map(function (r) { return r[idx] == null ? "" : r[idx]; });
      var nonempty = vals.filter(function (v) { return String(v).trim() !== ""; });
      var nums = nonempty.map(numValue).filter(function (v) { return v !== null; });
      var miss = vals.length - nonempty.length;
      if (miss > 0) missing.push({ name: h, ratio: vals.length ? miss / vals.length : 0 });

      if (nonempty.length && nums.length >= Math.max(3, nonempty.length * 0.7)) {
        var sum = 0, min = Infinity, max = -Infinity;
        nums.forEach(function (n) { sum += n; if (n < min) min = n; if (n > max) max = n; });
        numeric.push({ name: h, mean: sum / nums.length, min: min, max: max });
      } else {
        var counts = {};
        nonempty.forEach(function (v) { var k = String(v).trim(); counts[k] = (counts[k] || 0) + 1; });
        var distinct = Object.keys(counts).length;
        // Only genuine categories leave the browser: values that repeat, in a
        // column that is not mostly unique. Names, emails, IDs and free text
        // are reported as a distinct count, never as values.
        var isCategory = distinct <= Math.max(20, nonempty.length * 0.5);
        var top = !isCategory ? [] : Object.keys(counts)
          .filter(function (k) { return counts[k] > 1; })
          .sort(function (a, b) { return counts[b] - counts[a]; })
          .slice(0, 5);
        categorical.push({ name: h, distinct: distinct, top: top.map(function (k) { return [k, counts[k]]; }) });
      }
    });

    return {
      rows: data.length,
      columns: headers.length,
      numeric: numeric.slice(0, 200),
      categorical: categorical.slice(0, 200),
      missing: missing.slice(0, 200)
    };
  }

  /* ------------------------------------------------------------------------
     Account state
     ---------------------------------------------------------------------- */

  var SESSION_KEY = "sp_studio_session";
  var session = loadSession();
  var account = session ? session.account : null;
  var pendingEmail = "";

  function loadSession() {
    if (!SP) return null;
    var raw = SP.storageGet(SESSION_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (!s || !s.token || !s.expiresAt || s.expiresAt * 1000 < Date.now()) return null;
      return s;
    } catch (e) { return null; }
  }

  function saveSession(s) {
    session = s;
    if (SP) SP.storageSet(SESSION_KEY, s ? JSON.stringify(s) : null);
  }

  function setAccount(a) {
    if (!a) return;
    account = a;
    if (session) { session.account = a; saveSession(session); }
    renderAccount();
  }

  function runsLabel(a) {
    if (a.trialsRemaining > 0) return a.trialsRemaining + " of " + a.freeTrials + " free runs left";
    if (a.credits > 0) return a.credits + (a.credits === 1 ? " paid run left" : " paid runs left");
    return "Free runs used";
  }

  function renderAccount() {
    var signedIn = !!(session && account);
    $("accountBar").hidden = !signedIn;
    $("signInPrompt").hidden = signedIn || !(SP && SP.connected);
    if (signedIn) {
      $("accountEmail").textContent = account.email;
      $("accountRuns").textContent = runsLabel(account);
      $("runsChip").textContent = runsLabel(account);
    } else {
      $("runsChip").textContent = "3 free runs on sign-up";
    }
  }

  function signOut() {
    saveSession(null);
    account = null;
    renderAccount();
  }

  /* ------------------------------------------------------------------------
     Status helpers
     ---------------------------------------------------------------------- */

  function setMsg(id, message, state) {
    var el = $(id);
    if (!el) return;
    el.textContent = message || "";
    if (state && message) el.setAttribute("data-state", state);
    else el.removeAttribute("data-state");
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.setAttribute("data-label", button.textContent);
      button.textContent = label;
      button.disabled = true;
    } else {
      button.textContent = button.getAttribute("data-label") || button.textContent;
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
     Sign-up / sign-in (email code)
     ---------------------------------------------------------------------- */

  var turnstileWidget = null;
  var turnstileToken = "";
  var signupTracked = false;

  function ensureTurnstile() {
    var siteKey = SP && SP.config.turnstileSiteKey;
    if (!siteKey || turnstileWidget !== null) return;
    turnstileWidget = "loading";
    window.spTurnstileReady = function () {
      turnstileWidget = window.turnstile.render("#turnstileHost", {
        sitekey: siteKey,
        callback: function (token) { turnstileToken = token; },
        "expired-callback": function () { turnstileToken = ""; },
        "error-callback": function () { turnstileToken = ""; }
      });
    };
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=spTurnstileReady&render=explicit";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  function resetTurnstile() {
    turnstileToken = "";
    if (window.turnstile && turnstileWidget && turnstileWidget !== "loading") {
      try { window.turnstile.reset(turnstileWidget); } catch (e) { /* widget gone */ }
    }
  }

  function showStep(step) {
    $("signupStep").hidden = step !== "signup";
    $("verifyStep").hidden = step !== "verify";
  }

  function openSignup(message) {
    $("upgradePanel").hidden = true;
    $("signupPanel").hidden = false;
    showStep("signup");
    setMsg("signupStatus", message || "", message ? "error" : null);
    ensureTurnstile();
    if (!signupTracked && SP) { SP.track("signup_started", { product: key }); signupTracked = true; }
    $("signupPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    $("su-email").focus({ preventScroll: true });
  }

  $("signupForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var form1 = event.currentTarget;
    if (!form1.reportValidity()) return;
    if (SP.config.turnstileSiteKey && !turnstileToken) {
      setMsg("signupStatus", "Please complete the security check first.", "error");
      return;
    }
    var email = $("su-email").value.trim();
    var btn = $("signupBtn");
    setBusy(btn, true, "Sending…");
    setMsg("signupStatus", "");

    SP.api("/auth/start", {
      body: { email: email, name: $("su-name").value.trim(), turnstileToken: turnstileToken }
    }).then(function (data) {
      pendingEmail = email;
      $("verifyEmail").textContent = email;
      showStep("verify");
      setMsg("verifyStatus", "");
      var code = $("vf-code");
      code.value = data.devCode || ""; // development mode only
      code.focus();
    }, function (err) {
      setMsg("signupStatus", err.message, "error");
    }).then(function () {
      setBusy(btn, false);
      resetTurnstile();
    });
  });

  $("verifyForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var code = $("vf-code").value.replace(/\D/g, "");
    if (code.length !== 6) {
      setMsg("verifyStatus", "Enter the 6-digit code from the email.", "error");
      return;
    }
    var btn = $("verifyBtn");
    setBusy(btn, true, "Verifying…");

    SP.api("/auth/verify", {
      body: { email: pendingEmail, code: code, anonId: SP.anonId, page: window.location.pathname }
    }).then(function (data) {
      saveSession({ token: data.token, expiresAt: data.expiresAt, account: data.account });
      setAccount(data.account);
      $("signupPanel").hidden = true;
      $("vf-code").value = "";
      // They already wrote the brief: generate straight away if it is complete.
      if (form.checkValidity()) run();
      else {
        var first = form.querySelector(":invalid");
        if (first) first.focus();
      }
    }, function (err) {
      setMsg("verifyStatus", err.message, "error");
    }).then(function () {
      setBusy(btn, false);
    });
  });

  $("restartBtn").addEventListener("click", function () {
    showStep("signup");
    setMsg("signupStatus", "");
    $("su-email").focus();
  });

  $("signInBtn").addEventListener("click", function () { openSignup(); });
  $("signOutBtn").addEventListener("click", signOut);

  /* ------------------------------------------------------------------------
     Generation
     ---------------------------------------------------------------------- */

  function showUpgrade(data) {
    var panel = $("upgradePanel");
    var used = account ? account.freeTrials : 3;
    $("upgradeTitle").textContent = "You have used your " + used + " free runs.";
    $("upgradePrice").textContent = (data.productTitle || product.title) + " — " + (data.price || product.price) + " per run";

    var link = $("checkoutLink");
    var url = data.checkoutUrl || (SP && SP.config.checkoutUrl) || "";
    if (url) {
      link.href = url;
      link.textContent = "Continue with a paid run";
    } else {
      link.href = "contact.html";
      link.textContent = "Arrange a paid run";
    }
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });

    // Hook for the Flutterwave integration: listen for this event to open an
    // inline checkout instead of following the link.
    try {
      window.dispatchEvent(new CustomEvent("sp:trials-exhausted", {
        detail: { product: key, title: product.title, price: product.price, email: account ? account.email : "" }
      }));
    } catch (e) { /* very old browser: the link still works */ }
  }

  $("checkoutLink").addEventListener("click", function () {
    if (SP) SP.track("checkout_click", { product: key });
  });

  function run() {
    setMsg("generateStatus", "");
    $("upgradePanel").hidden = true;
    setBusy(generateBtn, true, product.busyLabel || "Generating…");

    collectInputs().then(function (inputs) {
      return SP.api("/studio/generate", {
        token: session.token,
        body: { product: key, inputs: inputs, anonId: SP.anonId, page: window.location.pathname }
      });
    }).then(function (data) {
      setAccount(data.account);
      render(data.sections || []);
      outputHost.scrollIntoView({ behavior: "smooth", block: "start" });
    }, function (err) {
      if (err.status === 401) {
        signOut();
        openSignup("Your session has ended. Sign in again to continue — your brief is still here.");
        return;
      }
      if (err.status === 402) {
        if (err.data && err.data.account) setAccount(err.data.account);
        showUpgrade(err.data || {});
        return;
      }
      setMsg("generateStatus", err.message || "The product could not generate a result.", "error");
    }).then(function () {
      setBusy(generateBtn, false);
    });
  }

  generateBtn.addEventListener("click", function () {
    if (!SP || !SP.connected) {
      $("offlineNotice").hidden = false;
      return;
    }
    if (!form.reportValidity()) return;
    if (!session) { openSignup(); return; }
    run();
  });

  /* ------------------------------------------------------------------------
     Output
     ---------------------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m];
    }).replace(/\n/g, "<br>");
  }

  function render(sections) {
    lastSections = sections;
    outputHost.innerHTML = sections.map(function (item) {
      return "<article class=\"output-block\"><h3>" + esc(item[0]) + "</h3><div>" + esc(item.slice(1).join("\n\n")) + "</div></article>";
    }).join("");
    $("outputTitle").textContent = product.title + " — generated";
    downloadBtn.disabled = !sections.length;
  }

  function download() {
    if (!lastSections.length) return;
    var body = lastSections.map(function (item) {
      return "<section><h2>" + esc(item[0]) + "</h2><p>" + esc(item.slice(1).join("\n\n")) + "</p></section>";
    }).join("");
    var html = "<!doctype html><html><head><meta charset='utf-8'><title>" + esc(product.title) + " — SpeakPower</title><style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;line-height:1.6;color:#182236}h1{font-size:28px}h2{margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:6px}section{page-break-inside:avoid}footer{margin-top:48px;font-size:13px;color:#777}</style></head><body><h1>" + esc(product.title) + "</h1>" + body + "<footer>Generated by SpeakPower Studio.</footer></body></html>";
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = product.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-speakpower.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    if (SP) SP.track("studio_download", { product: key });
  }

  downloadBtn.addEventListener("click", download);

  /* ------------------------------------------------------------------------
     Start-up
     ---------------------------------------------------------------------- */

  renderForm();
  renderAccount();

  if (!SP || !SP.connected) {
    $("offlineNotice").hidden = false;
    generateBtn.disabled = true;
  } else {
    SP.track("studio_view", { product: key });
    if (session) {
      // Refresh the run balance; a revoked or expired session signs out quietly.
      SP.api("/me", { token: session.token }).then(function (data) {
        setAccount(data.account);
      }, function (err) {
        if (err.status === 401) signOut();
      });
    }
  }
})();
