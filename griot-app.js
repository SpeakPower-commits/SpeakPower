/* ==========================================================================
   SpeakPower — GRIOT app
   Sign in once (account.js), use the free tries, then carry on with a plan.
   GRIOT has no per-use price.

   The browser holds only a SpeakPower session token and a thread id. It never
   sees GRIOT's address or key: every message goes to the Worker, which takes
   a plan use or a free try and calls GRIOT server-to-server under this
   account's own tenant.

   Security: all text written into the DOM goes through textContent, never
   innerHTML, so nothing GRIOT or a user types can be interpreted as markup.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  var THREAD_KEY = "sp_griot_thread";

  function $(id) { return document.getElementById(id); }

  var panels = {
    offline: $("gaOffline"),
    signIn: $("gaSignIn"),
    chat: $("gaChat"),
    topup: $("gaTopup")
  };
  if (!panels.chat) return;

  function show(name, alsoTopup) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = !(key === name || (alsoTopup && key === "topup"));
    });
  }

  function showError(host, message) {
    host.textContent = message || "";
    host.hidden = !message;
  }

  function notice(result) {
    var n = $("gaNotice");
    n.textContent = result ? result.text : "";
    n.hidden = !result;
  }

  // The thread is per account, so signing in as someone else on a shared
  // computer never continues the previous person's conversation.
  function threadKeyFor(acct) {
    return THREAD_KEY + ":" + String((acct && acct.email) || "").toLowerCase();
  }
  function getThread(acct) { return SP.storageGet(threadKeyFor(acct)) || null; }
  function setThread(acct, id) { SP.storageSet(threadKeyFor(acct), id || null); }

  /* -------------------------------------------------------------- balance */

  var account = null;

  function renderAccount(next) {
    if (next) account = next;
    if (!account) return;
    $("gaBalance").textContent = A.statusText(account);
    $("gaWho").textContent = account.email || "";
    A.renderUsage($("gaUsage"), account, "griot");
  }

  // No free try left, and no plan with GRIOT left this month.
  function cannotPay() {
    if (!account || Number(account.trialsRemaining) > 0) return false;
    var m = account.membership;
    return !(m && m.plan && m.usage && m.usage.griot < 100);
  }

  function openTopup(info) {
    info = info || {};
    A.renderPlanWall(panels.topup, {
      message: info.message,
      plans: info.plans,
      account: account,
      returnTo: "griot-app.html",
      onSignedOut: function () { signedOut("Your session ended. Please sign in again."); }
    });
    var keep = document.createElement("p");
    keep.className = "builder-note";
    keep.textContent = "GRIOT still remembers everything you told it. Carry on from exactly where you stopped.";
    panels.topup.insertBefore(keep, panels.topup.children[2] || null); // after the lead line
    show("chat", true);
    $("gaSendBtn").disabled = true;
  }

  /* ------------------------------------------------------------------ log */

  // Matches "FACT:", "**FACT:**", "**FACT**:" and "- FACT:". A bullet needs a
  // space after it, so the "**" of bold is never mistaken for one.
  var LABEL = /^(\s*(?:[-*]\s+)?)(?:\*\*)?(FACT|INFERENCE|HYPOTHESIS|RECOMMENDATION|UNKNOWN)(?:\*\*)?\s*:(?:\*\*)?/i;

  // Render GRIOT's answer line by line, bolding its evidence labels. Labels
  // are its whole point, so they should read at a glance — but this is done
  // by building nodes, never by injecting markup.
  function renderAnswer(host, text) {
    String(text).split("\n").forEach(function (line, i) {
      if (i) host.appendChild(document.createElement("br"));
      var m = line.match(LABEL);
      if (!m) { host.appendChild(document.createTextNode(line)); return; }
      host.appendChild(document.createTextNode(m[1]));
      var tag = document.createElement("strong");
      tag.className = "griot-label griot-label--" + m[2].toLowerCase();
      tag.textContent = m[2].toUpperCase();
      host.appendChild(tag);
      host.appendChild(document.createTextNode(":" + line.slice(m[0].length)));
    });
  }

  function addMessage(role, text, meta) {
    var empty = $("gaEmpty");
    if (empty) empty.remove();
    var item = document.createElement("div");
    item.className = "griot-msg griot-msg--" + role;
    var who = document.createElement("span");
    who.className = "griot-who";
    who.textContent = role === "user" ? "You" : "GRIOT";
    item.appendChild(who);
    var body = document.createElement("div");
    body.className = "griot-body";
    if (role === "griot") renderAnswer(body, text);
    else body.textContent = text;
    item.appendChild(body);
    if (meta) {
      var m = document.createElement("p");
      m.className = "griot-meta";
      m.textContent = meta;
      item.appendChild(m);
    }
    $("gaLog").appendChild(item);
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return item;
  }

  function describe(reply) {
    var parts = [];
    parts.push(reply.paidWith === "trial" ? "Free try" : "Included in your plan");
    if (reply.agents && reply.agents.length) parts.push("Lens: " + reply.agents.join(", "));
    if (reply.memoryUsed) parts.push("drew on " + reply.memoryUsed + " thing" + (reply.memoryUsed === 1 ? "" : "s") + " it remembers");
    if (reply.memoryWritten) parts.push("now remembers: “" + reply.memoryWritten + "”");
    return parts.join(" · ");
  }

  /* ---------------------------------------------------------------- flows */

  function startChat(next) {
    renderAccount(next);
    show("chat");
    $("gaSendBtn").disabled = false;
    if (getThread(account) && $("gaEmpty")) {
      $("gaEmpty").textContent = "Continuing your conversation. GRIOT remembers what you have already told it.";
    }
    if (cannotPay()) openTopup();
    else $("ga-message").focus({ preventScroll: true });
  }

  function signedOut(message) {
    account = null;
    show("signIn");
    A.mountSignIn(panels.signIn, {
      title: "Start free",
      lead: (message ? message + " " : "") +
        "Your first 3 tries are free — use them here or on any Studio service. No password, no card.",
      onSignedIn: function (acct) { notice(null); startChat(acct); }
    });
  }

  $("gaSignout").addEventListener("click", function () {
    A.signOut();
    signedOut("");
  });

  $("gaComposer").addEventListener("submit", function (event) {
    event.preventDefault();
    send();
  });

  // Ctrl/Cmd + Enter sends; plain Enter keeps writing.
  $("ga-message").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  });

  var sending = false;

  function send() {
    if (sending) return;
    var err = $("gaChatError");
    showError(err, "");
    var box = $("ga-message");
    var message = box.value.trim();
    if (!message) {
      showError(err, "Type a question for GRIOT first.");
      box.focus();
      return;
    }
    if (!A.session()) { signedOut("Please sign in again."); return; }

    sending = true;
    var btn = $("gaSendBtn");
    btn.disabled = true;
    btn.textContent = "GRIOT is thinking…";
    var mine = addMessage("user", message);
    box.value = "";
    var thinking = addMessage("griot", "Working through it…");
    thinking.classList.add("griot-msg--pending");

    A.call("/griot/chat", {
      message: message, threadId: getThread(account), anonId: SP.anonId, page: location.pathname
    }).then(function (reply) {
      thinking.remove();
      addMessage("griot", reply.answer, describe(reply));
      setThread(account, reply.threadId);
      A.setAccount(reply.account);
      renderAccount(reply.account);
      if (cannotPay()) openTopup();
    }, function (e) {
      thinking.remove();
      // The message was not answered: put it back so nothing typed is lost.
      box.value = message;
      mine.remove();
      if (e.status === 401) { signedOut(e.message); return; }
      if (e.status === 402) {
        if (e.data && e.data.account) { A.setAccount(e.data.account); renderAccount(e.data.account); }
        openTopup(e.data);
        return;
      }
      // Any other failure was refunded by the Worker.
      showError(err, e.message);
    }).then(function () {
      sending = false;
      btn.textContent = "Ask GRIOT";
      if (!cannotPay()) btn.disabled = false;
    });
  }

  /* ---------------------------------------------------------------- start */

  if (!SP || !A) { show("offline"); return; }

  // Try → sign up → GRIOT. Without an account, a visitor goes to the one
  // sign-up page and comes straight back here once signed in.
  if (A.requireAccount("griot-app.html")) return;

  if (!SP.connected || !A.signInAvailable()) {
    show("offline");
    return;
  }

  // Show the conversation at once, then settle any returning payment and
  // confirm the session — in that order, so a stale balance never wins.
  startChat(A.account());
  A.settleReturn().then(function (result) {
    if (result) notice(result);
    return A.refresh();
  }).then(function (acct) {
    renderAccount(acct);
    if (cannotPay()) openTopup();
    else { panels.topup.hidden = true; $("gaSendBtn").disabled = false; }
  }, function (e) {
    if (e.status === 401) signedOut("");
    // Otherwise an offline blip: keep them in; sending will retry.
  });
})();
