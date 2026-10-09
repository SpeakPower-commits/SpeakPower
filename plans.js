/* ==========================================================================
   SpeakPower — plans.html
   Choose Starter or Pro: signed out, sign up first and come straight back;
   signed in, open Flutterwave's checkout for exactly the plan's price (the
   Worker decides it). Back from payment, settle and say so. A member sees
   their own plan marked, with Renew in place of Choose.

   Security: text goes through textContent, never innerHTML.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  function $(id) { return document.getElementById(id); }
  var buttons = Array.prototype.slice.call(document.querySelectorAll(".plan-buy"));
  if (!buttons.length) return;

  var NAMES = { starter: "Starter", pro: "Pro" };

  function notice(result) {
    var n = $("plNotice");
    n.textContent = result ? result.text : "";
    n.hidden = !result;
  }
  function showError(message) {
    $("plError").textContent = message || "";
    $("plError").hidden = !message;
  }

  // Not connected yet (no Worker or sign-in on this deployment): every
  // button becomes a conversation instead of a dead end.
  if (!SP || !A || !SP.connected || !A.signInAvailable()) {
    buttons.forEach(function (b) {
      var a = document.createElement("a");
      a.className = b.className;
      a.href = "https://wa.me/256743482588?text=" + encodeURIComponent("Hi Otieno, I would like the " + NAMES[b.getAttribute("data-plan")] + " plan.");
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Ask for " + NAMES[b.getAttribute("data-plan")];
      b.parentNode.replaceChild(a, b);
    });
    return;
  }

  function draw(acct) {
    var m = acct && acct.membership;
    var status = $("plStatus");
    status.textContent = acct ? A.statusText(acct) : "";
    status.hidden = !acct;
    $("plFreeBtn").hidden = !!(acct && !(Number(acct.trialsRemaining) > 0));
    buttons.forEach(function (b) {
      var key = b.getAttribute("data-plan");
      var card = b.closest(".plan-card");
      var mine = m && m.plan === key;
      card.classList.toggle("plan-card--current", !!mine);
      b.textContent = mine ? "Renew " + NAMES[key] + " for 30 days"
        : m && m.plan ? "Switch to " + NAMES[key]
        : "Choose " + NAMES[key];
      b.hidden = !!(acct && !acct.canBuyPlans);
    });
    if (acct && !acct.canBuyPlans) {
      showError("Online payment opens shortly. Until then, message me on WhatsApp (+256 743 482 588) and I will switch your plan on.");
    }
  }

  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      if (!A.session()) {
        window.location.assign("account.html?next=plans.html");
        return;
      }
      if (document.body.getAttribute("aria-busy") === "true") return;
      document.body.setAttribute("aria-busy", "true");
      var label = b.textContent;
      b.textContent = "Opening secure checkout…";
      showError("");
      A.startPlan(b.getAttribute("data-plan"), "plans.html").then(null, function (e) {
        document.body.removeAttribute("aria-busy");
        b.textContent = label;
        showError(e.message);
        if (e.status === 401) draw(null);
      });
    });
  });

  draw(A.account());
  if (!A.session()) return;
  A.settleReturn().then(function (result) {
    if (result) notice(result);
    return A.refresh();
  }).then(draw, function (e) {
    if (e.status === 401) draw(null);
  });
})();
