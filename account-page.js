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

  function drawAccount(acct) {
    if (!acct) return;
    $("acBalance").textContent = A.formatUgx(acct.balance);
    $("acTries").textContent = (Number(acct.trialsRemaining) || 0) + " of " + (acct.freeTrials || 3);
    $("acName").textContent = acct.name || acct.email || "";
    $("acEmail").textContent = acct.name ? acct.email : "";
    A.renderPayWall($("acTopup"), {
      heading: "Top up your balance",
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
      body.appendChild(row([
        key === "griot" ? "GRIOT" : A.SERVICE_NAMES[key],
        A.formatUgx(prices[key]) + (key === "griot" ? " per message" : "")
      ]));
    });

    fillTable("acUses", "acUsesEmpty", (data.uses || []).map(function (u) {
      var paid = u.paidWith === "trial" ? "Free try" : A.formatUgx(u.amount);
      if (u.status === "refunded") paid += " — failed, not charged";
      return [A.SERVICE_NAMES[u.service] || u.service, paid, when(u.at)];
    }));

    fillTable("acPayments", "acPaymentsEmpty", (data.payments || []).map(function (p) {
      return [A.formatUgx(p.amount), p.status === "paid" ? "Added to balance" : "Started, not paid", when(p.paidAt || p.at)];
    }));
  }

  function load() {
    return A.call("/account").then(function (data) {
      A.setAccount(data.account);
      drawSummary(data);
      show("home");
    });
  }

  function signedOut() {
    show("signIn");
    A.mountSignIn(panels.signIn, {
      title: "Sign in or create your account",
      onSignedIn: function () { start(); }
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
      if (e.status === 401) { signedOut(); return; }
      notice({ text: e.message });
    });
  }

  $("acSignout").addEventListener("click", function () {
    A.signOut();
    notice(null);
    signedOut();
  });

  if (!SP.connected || !A.signInAvailable()) { show("offline"); return; }
  if (!A.session()) {
    signedOut();
    if (A.hasReturn()) A.settleReturn().then(notice);
    return;
  }
  start();
})();
