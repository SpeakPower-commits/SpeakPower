/* ==========================================================================
   SpeakPower Studio — the guided builders
   Anyone can open a builder and read what it asks. Generating needs an
   account: the first 3 tries are free on any service, then each use takes
   its price from the balance. The Worker generates the pack and decides
   every number; this page collects answers and renders what comes back.

   Security: generated text is escaped before it is rendered.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  var params = new URLSearchParams(window.location.search);
  var key = params.get("product") || "brand-story";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("builderForm");
  var outputHost = $("outputHost");
  var downloadBtn = $("downloadBtn");
  var generateBtn = $("generateBtn");
  var errorHost = $("builderError");
  var gate = $("builderGate");

  // Prices are in UGX and must match the Worker's price list and studio.html
  // (the Worker's test suite fails if any of the three disagree).
  var PRODUCTS = {
    "brand-story": {
      title: "Brand Story Builder",
      price: 100000,
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
      price: 75000,
      lead: "Enter a public website address. SpeakPower checks what search engines and sharing apps see on the page — title, description, headings, structured data, social preview, mobile readiness and more — and adds Google Lighthouse scores where available.",
      fields: [
        ["url", "Website address", "example.com", "url"]
      ],
      busy: "Auditing…",
      privacy: "SpeakPower fetches the public page you name, the way a search engine would. Nothing about the page is stored; your account keeps only that you ran an audit."
    },

    "market-plan": {
      title: "Market Development Planner",
      price: 125000,
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
      price: 75000,
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
      price: 100000,
      lead: "Choose a CSV and get a first-pass profile, patterns, gaps and a plain-language story.",
      fields: [
        ["csv", "CSV dataset", "Choose a non-sensitive .csv file", "file"]
      ],
      busy: "Analysing…",
      privacy: "Your CSV never leaves this browser. Only column summaries — counts, averages and the most common repeated values — are sent to build the story."
    },

    "speaker-ready": {
      title: "Speaker Ready Pack",
      price: 75000,
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

  if (!PRODUCTS[key]) key = "brand-story";

  // Try → sign up → this builder. Without an account, a visitor goes to the
  // one sign-up page and comes straight back here once signed in.
  if (A && A.requireAccount("studio-product.html?product=" + key)) return;

  var product = PRODUCTS[key];
  var DRAFT_KEY = "sp_draft:" + key;

  function ugx(n) { return "UGX " + Number(n).toLocaleString("en-US"); }

  $("builderTitle").textContent = product.title;
  $("builderLead").textContent = product.lead;
  $("builderPrice").textContent = ugx(product.price);
  if (product.privacy) $("builderPrivacy").textContent = product.privacy;

  /* ----------------------------------------------------------------- form */

  function renderForm() {
    form.textContent = "";
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
      } else {
        input = document.createElement("input");
        if (f[3] === "file") {
          input.type = "file";
          input.accept = ".csv,text/csv";
        } else {
          // A plain text box, not type="url": people type "example.com", and
          // the Worker accepts that. The browser's url check would refuse it.
          input.type = "text";
          if (f[3] === "url") { input.inputMode = "url"; input.autocomplete = "url"; input.spellcheck = false; }
        }
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
      if (el && el.type !== "file") v[f[0]] = String(el.value || "").trim();
    });
    return v;
  }

  // Answers survive the trip to Flutterwave and back (sessionStorage: this
  // tab only, gone when it closes). A chosen file cannot be kept, by design.
  function saveDraft() {
    try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(textValues())); } catch (e) { /* optional */ }
  }
  function restoreDraft() {
    var raw = null;
    try { raw = window.sessionStorage.getItem(DRAFT_KEY); window.sessionStorage.removeItem(DRAFT_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    try {
      var v = JSON.parse(raw);
      Object.keys(v || {}).forEach(function (name) {
        var el = form.elements[name];
        if (el && el.type !== "file" && typeof v[name] === "string") el.value = v[name];
      });
    } catch (e) { /* a broken draft is just no draft */ }
  }

  /* ----------------------------------------------- data story: in-browser */

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

  var MAX_CSV_BYTES = 20 * 1024 * 1024;
  var MAX_COLUMNS = 100;

  // Column statistics only. A value is sent as a "most common value" only if
  // it repeats and the column is not mostly unique — so names, emails, phone
  // numbers and free text never leave the browser, only their counts.
  function summarise(file) {
    if (!file) return Promise.reject(new Error("Choose a CSV file first."));
    if (file.size > MAX_CSV_BYTES) return Promise.reject(new Error("That file is larger than 20 MB. Use a smaller extract."));
    return file.text().then(function (text) {
      var rows = parseCSV(text.replace(/^﻿/, ""));
      if (rows.length < 2) throw new Error("The CSV needs a header row and at least one data row.");
      var headers = rows[0].slice(0, MAX_COLUMNS).map(function (x, i) {
        return (String(x || "").trim() || "Column " + (i + 1)).slice(0, 80);
      });
      var data = rows.slice(1);
      var summary = { rows: data.length, columns: rows[0].length, numeric: [], categorical: [], missing: [] };

      headers.forEach(function (name, idx) {
        var vals = data.map(function (r) { return r[idx] == null ? "" : String(r[idx]).trim(); });
        var present = vals.filter(function (v) { return v !== ""; });
        var miss = vals.length - present.length;
        if (miss) summary.missing.push({ name: name, ratio: miss / vals.length });
        var nums = present.map(numValue).filter(function (v) { return v !== null; });

        if (present.length && nums.length >= Math.max(3, present.length * 0.7)) {
          var min = Infinity, max = -Infinity, sum = 0;
          nums.forEach(function (n) { sum += n; if (n < min) min = n; if (n > max) max = n; });
          summary.numeric.push({ name: name, mean: sum / nums.length, min: min, max: max });
          return;
        }
        var counts = {};
        var distinct = 0;
        present.forEach(function (v) {
          if (!counts[v]) { counts[v] = 0; distinct++; }
          counts[v]++;
        });
        var mostlyUnique = distinct > Math.max(20, present.length * 0.5);
        var top = mostlyUnique ? [] : Object.keys(counts)
          .filter(function (v) { return counts[v] >= 2; })
          .sort(function (a, b) { return counts[b] - counts[a]; })
          .slice(0, 5)
          .map(function (v) { return [v.slice(0, 60), counts[v]]; });
        summary.categorical.push({ name: name, distinct: distinct, top: top });
      });
      return summary;
    });
  }

  function inputs() {
    if (key === "data-story") {
      var el = form.elements.csv;
      return summarise(el && el.files ? el.files[0] : null).then(function (summary) { return { summary: summary }; });
    }
    return Promise.resolve(textValues());
  }

  /* --------------------------------------------------------------- output */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m];
    }).replace(/\n/g, "<br>");
  }

  var lastSections = [];

  function render(sections) {
    outputHost.innerHTML = sections.map(function (item) {
      return "<article class=\"output-block\"><h3>" + esc(item[0]) + "</h3><div>" + esc(item.slice(1).join("\n\n")) + "</div></article>";
    }).join("");
    $("outputTitle").textContent = product.title + " — generated";
    downloadBtn.disabled = false;
    lastSections = sections;
  }

  function showOutputMessage(text) {
    var p = document.createElement("p");
    p.className = "output-empty";
    p.textContent = text;
    outputHost.textContent = "";
    outputHost.appendChild(p);
  }

  function paidLine(data) {
    var acct = data.account || {};
    var text = data.paidWith === "trial"
      ? "Free try — " + A.triesText(acct.trialsRemaining) + " left."
      : data.paidWith === "plan"
        ? "Included in your plan — this month's Studio pack."
        : ugx(data.amount) + " from your balance — " + ugx(acct.balance) + " left.";
    $("outputPaid").textContent = text;
    $("outputPaid").hidden = false;
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
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ----------------------------------------------------------- validation */

  /**
   * Leave one of nine required fields blank and the page used to do nothing
   * at all: the only feedback was the browser's native tooltip, which mobile
   * browsers routinely suppress. Name the field, in the page, and take the
   * customer to it.
   */
  function showFormError(text) {
    errorHost.textContent = text || "";
    errorHost.hidden = !text;
  }

  function clearFormError() {
    showFormError("");
    var flagged = form.querySelectorAll(".builder-field--invalid");
    for (var i = 0; i < flagged.length; i++) flagged[i].classList.remove("builder-field--invalid");
  }

  function flagField(name, label, message) {
    var el = form.elements[name];
    var wrap = el && el.closest ? el.closest(".builder-field") : null;
    if (wrap) wrap.classList.add("builder-field--invalid");
    showFormError(message || "“" + label + "” still needs an answer before the pack can be generated.");
    if (el) {
      el.focus({ preventScroll: true });
      (wrap || el).scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function validate() {
    clearFormError();
    for (var i = 0; i < product.fields.length; i++) {
      var f = product.fields[i];
      var el = form.elements[f[0]];
      if (el && typeof el.checkValidity === "function" && !el.checkValidity()) {
        flagField(f[0], f[1], el.value
          ? "Check “" + f[1] + "” — " + (el.validationMessage || "that answer is not valid yet.")
          : null);
        return false;
      }
    }
    return true;
  }

  ["input", "change"].forEach(function (evt) {
    form.addEventListener(evt, function (e) {
      var wrap = e.target && e.target.closest ? e.target.closest(".builder-field") : null;
      if (wrap && wrap.classList.contains("builder-field--invalid") && e.target.checkValidity()) clearFormError();
    });
  });

  /* --------------------------------------------------- account and status */

  function notice(result) {
    var n = $("builderNotice");
    n.textContent = result ? result.text : "";
    n.hidden = !result;
  }

  function drawStatus() {
    var acct = A && A.account();
    $("builderMode").textContent = acct ? A.statusText(acct, { balance: true })
      : (SP && SP.connected ? "3 free tries with an account" : "Automated output");
  }

  function hideGate() { gate.hidden = true; gate.textContent = ""; }

  function showSignIn(message) {
    gate.hidden = false;
    A.mountSignIn(gate, {
      title: "Sign in to generate",
      lead: (message ? message + " " : "") +
        "Your answers stay on this page. Your first 3 tries are free, on any service — no card needed.",
      onSignedIn: function () { hideGate(); drawStatus(); run(); }
    });
    gate.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showPayWall(data) {
    gate.hidden = false;
    A.renderPayWall(gate, {
      title: product.title,
      price: data.price,
      shortfall: data.shortfall,
      account: data.account,
      returnTo: "studio-product.html?product=" + key,
      onSignedOut: function () { showSignIn("Your session ended."); }
    });
    // Keep the answers through the payment page and back.
    var buttons = gate.querySelectorAll(".topup-options .btn");
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", saveDraft);
    gate.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ------------------------------------------------------------- generate */

  var running = false;

  function setBusy(on) {
    running = on;
    generateBtn.disabled = on;
    generateBtn.textContent = on ? (product.busy || "Generating…") : "Generate my pack";
  }

  function run() {
    if (running) return;
    clearFormError();
    notice(null);
    setBusy(true);
    inputs().then(function (body) {
      return A.call("/studio/generate", { product: key, inputs: body, anonId: SP.anonId, page: location.pathname });
    }).then(function (data) {
      hideGate();
      A.setAccount(data.account);
      render(data.sections);
      paidLine(data);
      drawStatus();
      outputHost.scrollIntoView({ behavior: "smooth", block: "start" });
    }, function (e) {
      if (e.status === 401) { showSignIn("Your session ended."); return; }
      if (e.status === 402) {
        if (e.data && e.data.account) A.setAccount(e.data.account);
        drawStatus();
        showPayWall(e.data || {});
        return;
      }
      // The Worker names the field when an answer is the problem.
      if (e.data && e.data.field) {
        var f = product.fields.filter(function (x) { return x[0] === e.data.field; })[0];
        flagField(e.data.field, f ? f[1] : e.data.field, e.message);
        return;
      }
      if (!e.status) { showFormError(e.message); return; } // a problem with the file, before anything was sent
      showOutputMessage(e.message);
    }).then(function () { setBusy(false); });
  }

  generateBtn.addEventListener("click", function () {
    if (running || !validate()) return;
    if (!SP || !SP.connected || !A || !A.signInAvailable()) {
      showFormError("Online generation opens here shortly — accounts are being connected. Your answers are not sent anywhere until then.");
      return;
    }
    if (!A.session()) { showSignIn(); return; }
    run();
  });

  downloadBtn.addEventListener("click", download);

  /* ---------------------------------------------------------------- start */

  renderForm();
  restoreDraft();
  drawStatus();
  if (A) {
    A.onChange(drawStatus);
    // Settle a returning payment first, then refresh: run together, a /me
    // answered before the credit could overwrite the new balance.
    A.settleReturn().then(function (result) {
      if (result) notice(result.ok ? { text: result.text + " Press “Generate my pack” to continue." } : result);
      if (A.session()) return A.refresh();
    }).then(drawStatus, drawStatus);
  }
})();
