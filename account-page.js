/* ==========================================================================
   SpeakPower — the account page
   Balance, free tries, top-up, prices, and everything used and paid.
   All numbers come from the Worker's GET /account. Text goes through
   textContent, never innerHTML.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  function $(id) { return document.getElementById(id); }
  if (!SP || !A || !$("acHome")) return;

  var panels = { offline: $("acOffline"), signIn: $("acSignIn"), home: $("acHome") };

  // Arriving from a "Try" button: ?next= names the service to start once
  // signed in. Only our own service pages are accepted (account.js).
  var next = A.safeNext(new URLSearchParams(window.location.search).get("next"));
  var nextName = next ? A.nextServiceName(next) : "";
  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
  }

  function notice(result) {
    var n = $("acNotice");
    n.textContent = result ? result.text : "";
    n.hidden = !result;
  }

  function when(sec) {
    if (!sec) return "";
    try {
      return new Date(sec * 1000).toLocaleString("en-GB", {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
      });
    } catch (e) { return new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " "); }
  }

  function row(cells) {
    var tr = document.createElement("tr");
    cells.forEach(function (text) {
      var td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    });
    return tr;
  }

  function fillTable(id, emptyId, rows) {
    var table = $(id);
    var body = table.querySelector("tbody");
    body.textContent = "";
    rows.forEach(function (cells) { body.appendChild(row(cells)); });
    table.hidden = !rows.length;
    $(emptyId).hidden = !!rows.length;
  }

  // The membership card: the plan, when it renews, and how much of the month
  // each allowance has used. Without a plan, the plans themselves.
  function drawPlan(acct) {
    var host = $("acPlan");
    var m = acct.membership;
    host.textContent = "";
    if (!m || !m.plan) {
      A.renderPlanWall(host, {
        heading: m && m.next ? "Your " + m.next.name + " plan starts " + A.dayMonth(m.next.startsAt) : "Choose a plan",
        message: Number(acct.trialsRemaining) > 0
          ? "You still have " + A.triesText(acct.trialsRemaining) + ". When they are used, a plan keeps GRIOT and the Rehearsal Room going."
          : "Your free tries are used.",
        account: acct,
        returnTo: "account.html",
        onSignedOut: signedOut
      });
      return;
    }
    var head = document.createElement("div");
    head.className = "account-plan-head";
    var title = document.createElement("h2");
    title.textContent = m.name + " plan";
    var when = document.createElement("p");
    when.className = "builder-note";
    when.textContent = m.next
      ? "Paid until " + A.dayMonth(m.paidUntil) + " (renewal already paid)."
      : "Runs until " + A.dayMonth(m.endsAt) + ". Renew any time; early renewals add 30 days after that date.";
    head.appendChild(title);
    head.appendChild(when);
    host.appendChild(head);
    [["griot", "GRIOT"], ["rehearsal", "Rehearsal Room"]].forEach(function (pair) {
      var box = document.createElement("div");
      box.className = "usage";
      var name = document.createElement("p");
      name.className = "usage-name";
      name.textContent = pair[1];
      host.appendChild(name);
      A.renderUsage(box, acct, pair[0]);
      var renew = box.querySelector(".usage-renew");
      if (renew) renew.parentNode.removeChild(renew); // one renew button below, not two
      host.appendChild(box);
    });
    if (m.plan === "pro") {
      var pack = document.createElement("p");
      pack.className = "builder-note";
      pack.textContent = m.packsLeft > 0
        ? "Your Studio pack for this month is ready to use, and every other pack is 15% off."
        : "This month's included Studio pack is used. Every other pack is 15% off.";
      host.appendChild(pack);
    }
    var row = document.createElement("div");
    row.className = "builder-actions";
    var renewBtn = document.createElement("button");
    renewBtn.type = "button";
    renewBtn.className = m.renewSoon ? "btn btn-primary" : "btn btn-ghost";
    renewBtn.textContent = "Renew " + m.name + " for 30 days";
    renewBtn.addEventListener("click", function () { checkoutPlan(m.plan, renewBtn); });
    row.appendChild(renewBtn);
    if (m.plan !== "pro") {
      var up = document.createElement("button");
      up.type = "button";
      up.className = "btn btn-ghost";
      up.textContent = "Switch to Pro";
      up.addEventListener("click", function () { checkoutPlan("pro", up); });
      row.appendChild(up);
    }
    var compare = document.createElement("a");
    compare.className = "btn btn-ghost";
    compare.href = "plans.html";
    compare.textContent = "Compare plans";
    row.appendChild(compare);
    if (!acct.canBuyPlans) { renewBtn.hidden = true; if (up) up.hidden = true; }
    host.appendChild(row);
    var err = document.createElement("p");
    err.className = "builder-error";
    err.setAttribute("role", "alert");
    err.hidden = true;
    host.appendChild(err);
    function checkoutPlan(plan, btn) {
      if (row.getAttribute("aria-busy") === "true") return;
      row.setAttribute("aria-busy", "true");
      var label = btn.textContent;
      btn.textContent = "Opening secure checkout…";
      err.hidden = true;
      A.startPlan(plan, "account.html").then(null, function (e) {
        row.removeAttribute("aria-busy");
        btn.textContent = label;
        err.textContent = e.message;
        err.hidden = false;
        if (e.status === 401) signedOut();
      });
    }
  }

  function drawAccount(acct) {
    if (!acct) return;
    drawPlan(acct);
    $("acBalance").textContent = A.formatUgx(acct.balance);
    $("acTries").textContent = (Number(acct.trialsRemaining) || 0) + " of " + (acct.freeTrials || 3);
    $("acName").textContent = acct.name || acct.email || "";
    $("acEmail").textContent = acct.name ? acct.email : "";
    A.renderPayWall($("acTopup"), {
      heading: "Top up for Studio packs",
      intro: true,
      account: acct,
      returnTo: "account.html",
      onSignedOut: signedOut
    });
  }

  function drawSummary(data) {
    drawAccount(data.account);
    var prices = data.prices || {};
    var body = $("acPrices").querySelector("tbody");
    body.textContent = "";
    Object.keys(A.SERVICE_NAMES).forEach(function (key) {
      if (prices[key] == null) return;
      body.appendChild(row([A.SERVICE_NAMES[key], A.formatUgx(prices[key])]));
    });
    var m = data.account && data.account.membership;
    if (m && m.packDiscount) {
      $("acPriceNote").textContent = "GRIOT and the Rehearsal Room come with your plan. As a " + m.name +
        " member you pay " + (100 - m.packDiscount) + "% of these prices.";
    }

    fillTable("acUses", "acUsesEmpty", (data.uses || []).map(function (u) {
      var paid = u.paidWith === "trial" ? "Free try"
        : u.paidWith === "plan" ? "Included in your plan"
        : A.formatUgx(u.amount) + " from your balance";
      if (u.status === "refunded") paid += " — did not count";
      return [A.SERVICE_NAMES[u.service] || u.service, paid, when(u.at)];
    }));

    fillTable("acPayments", "acPaymentsEmpty", (data.payments || []).map(function (p) {
      var plan = /^plan:/.test(p.purpose || "") ? p.purpose.slice(5) : "";
      var what = plan ? (plan.charAt(0).toUpperCase() + plan.slice(1)) + " plan, 30 days" : "Studio balance";
      return [A.formatUgx(p.amount), p.status === "paid" ? what : what + " — started, not paid", when(p.paidAt || p.at)];
    }));
  }

  function load() {
    return A.call("/account").then(function (data) {
      A.setAccount(data.account);
      drawSummary(data);
      show("home");
    });
  }

  function heading(signedIn) {
    if (signedIn) return; // the page's own "Your account." stands
    $("acTitle").textContent = "Create your free account.";
    $("acLead").textContent = (nextName ? "Sign up to start " + nextName + ". " : "") +
      "One account for every Studio service and GRIOT, and your first 3 tries are free on any of them. No password, no card.";
  }

  function signedOut(keepNext) {
    if (!keepNext) next = null;
    heading(false);
    show("signIn");
    A.mountSignIn(panels.signIn, {
      title: next ? "Start " + nextName + " free" : "Sign up or sign in",
      lead: "Continue with Google. Your first 3 tries are free, on any service.",
      onSignedIn: function () {
        if (next) { window.location.replace(next); return; }
        start();
      }
    });
  }

  function start() {
    // Show what we have at once, then replace it with the Worker's numbers.
    var cached = A.account();
    if (cached) { drawAccount(cached); show("home"); }
    A.settleReturn().then(function (result) {
      if (result) notice(result);
      return load();
    }).then(null, function (e) {
      if (e.status === 401) { signedOut(true); return; }
      notice({ text: e.message });
    });
  }

  $("acSignout").addEventListener("click", function () {
    A.signOut();
    notice(null);
    signedOut(false);
  });

  if (!SP.connected || !A.signInAvailable()) {
    heading(false);
    if (nextName) {
      $("acOfflineNext").textContent = "You will start " + nextName + " right here, with 3 free tries, as soon as it opens.";
      $("acOfflineNext").hidden = false;
    }
    show("offline");
    return;
  }
  if (!A.session()) {
    signedOut(true);
    if (A.hasReturn()) A.settleReturn().then(notice);
    return;
  }
  // Already signed in and on the way to a service: go straight there.
  if (next) { window.location.replace(next); return; }
  start();
})();
