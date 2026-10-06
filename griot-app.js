/* ==========================================================================
   SpeakPower — GRIOT app
   Sign up with an email code, get the free messages, then top up.

   The browser holds only a SpeakPower session token and a thread id. It never
   sees GRIOT's address or key: every message goes to the Worker, which spends
   one run and calls GRIOT server-to-server under this account's own tenant.

   Security: all text written into the DOM goes through textContent, never
   innerHTML, so nothing GRIOT or a user types can be interpreted as markup.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var SESSION_KEY = "sp_studio_session"; // shared with the Studio: one account
  var THREAD_KEY = "sp_griot_thread";

  function $(id) { return document.getElementById(id); }

  var panels = {
    offline: $("gaOffline"),
    signup: $("gaSignup"),
    verify: $("gaVerify"),
    chat: $("gaChat"),
    topup: $("gaTopup")
  };
  if (!panels.signup) return;

  function show(name, alsoTopup) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = !(key === name || (alsoTopup && key === "topup"));
    });
  }

  /* -------------------------------------------------------------- session */

  function getSession() {
    var raw = SP && SP.storageGet(SESSION_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      return s && s.token ? s : null;
    } catch (e) { return null; }
  }
  function setSession(s) {
    if (SP) SP.storageSet(SESSION_KEY, s ? JSON.stringify(s) : null);
  }
  // The thread is per account, so signing in as someone else on a shared
  // computer never continues the previous person's conversation.
  function threadKeyFor(account) {
    return THREAD_KEY + ":" + String((account && account.email) || "").toLowerCase();
  }
  function getThread(account) { return (SP && SP.storageGet(threadKeyFor(account))) || null; }
  function setThread(account, id) { if (SP) SP.storageSet(threadKeyFor(account), id || null); }

  /* --------------------------------------------------------------- errors */

  function showError(host, message) {
    host.textContent = message;
    host.hidden = !message;
  }

  /* ------------------------------------------------------------ turnstile */

  var turnstileWidget = null;
  var turnstileToken = "";

  function mountTurnstile() {
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
    document.head.appendChild(s);
  }
  function resetTurnstile() {
    turnstileToken = "";
    if (window.turnstile && turnstileWidget && turnstileWidget !== "loading") {
      try { window.turnstile.reset(turnstileWidget); } catch (e) { /* widget gone */ }
    }
  }

  /* --------------------------------------------------------- google sign-in */

  var googleMounted = false;

  function googleEnabled() { return !!(SP && SP.config.googleClientId); }
  function emailEnabled() { return !!(SP && SP.config.emailCodes); }

  function onGoogleCredential(response) {
    var err = $("gaSignupError");
    showError(err, "");
    if (!response || !response.credential) {
      showError(err, "Google sign-in was cancelled. Try again, or use another account.");
      return;
    }
    SP.api("/auth/google", {
      body: { credential: response.credential, anonId: SP.anonId, page: location.pathname }
    }).then(function (data) {
      setSession({ token: data.token, expiresAt: data.expiresAt, account: data.account });
      startChat(data.account);
    }, function (e) {
      showError(err, e.message);
    });
  }

  function mountGoogle() {
    if (googleMounted || !googleEnabled()) return;
    googleMounted = true;
    var host = $("gaGoogleBtn");
    function render() {
      window.google.accounts.id.initialize({
        client_id: SP.config.googleClientId,
        callback: onGoogleCredential,
        ux_mode: "popup",
        cancel_on_tap_outside: true
      });
      // Google's button accepts 200–400px; fit the panel on a phone.
      var width = Math.max(200, Math.min(400, Math.floor(host.getBoundingClientRect().width || 320)));
      window.google.accounts.id.renderButton(host, {
        theme: "outline", size: "large", text: "continue_with", shape: "pill", width: width
      });
    }
    if (window.google && window.google.accounts && window.google.accounts.id) { render(); return; }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = render;
    s.onerror = function () {
      googleMounted = false;
      showError($("gaSignupError"), "Google sign-in could not load. Check your connection and reload the page.");
    };
    document.head.appendChild(s);
  }

  // Show whichever sign-in routes this deployment actually supports, and
  // nothing that would fail after someone has filled it in.
  function mountSignIn() {
    var g = googleEnabled();
    var e = emailEnabled();
    $("gaGoogle").hidden = !g;
    $("gaEmailFields").hidden = !e;
    $("gaOr").hidden = !(g && e);
    if (g) mountGoogle();
    if (e) mountTurnstile();
  }

  /* -------------------------------------------------------------- balance */

  var account = null;

  function renderAccount(next) {
    if (next) account = next;
    if (!account) return;
    var free = Number(account.trialsRemaining) || 0;
    var paid = Number(account.credits) || 0;
    var label;
    if (free > 0) label = free + (free === 1 ? " free message left" : " free messages left");
    else if (paid > 0) label = paid + (paid === 1 ? " paid message left" : " paid messages left");
    else label = "No messages left";
    if (free > 0 && paid > 0) label += " · " + paid + " paid";
    $("gaBalance").textContent = label;
    $("gaWho").textContent = account.email || "";
  }

  function exhausted() {
    return account && !(Number(account.trialsRemaining) > 0) && !(Number(account.credits) > 0);
  }

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat("en-UG", { style: "currency", currency: currency, maximumFractionDigits: 0 }).format(amount);
    } catch (e) { return currency + " " + amount; }
  }

  function notice(text) {
    var n = $("gaNotice");
    n.textContent = text || "";
    n.hidden = !text;
  }

  function openTopup(checkoutUrl) {
    var link = $("gaCheckout");
    var note = $("gaTopupNote");
    var pack = account && account.pack;
    showError($("gaTopupError"), "");
    if (pack) {
      // Automatic: the Worker opens Flutterwave, and the account is credited
      // the moment the customer comes back (or the webhook lands first).
      link.textContent = "Top up — " + pack.messages + " messages for " + money(pack.amount, pack.currency);
      link.href = "#";
      link.removeAttribute("target");
      link.hidden = false;
      note.textContent = "Pay by card or mobile money. You come straight back here with your messages added.";
    } else {
      var url = checkoutUrl || (account && account.checkoutUrl) || (SP && SP.config.checkoutUrl) || "";
      if (url) {
        link.textContent = "Top up";
        link.href = url;
        link.target = "_blank";
        link.hidden = false;
        note.textContent = "Pay through the link using the same email you signed in with.";
      } else {
        // Never a button that goes nowhere.
        link.hidden = true;
        note.textContent = "Online top-up opens shortly. In the meantime, talk to me and I will add messages to your account.";
      }
    }
    show("chat", true);
    $("gaSendBtn").disabled = true;
  }

  $("gaCheckout").addEventListener("click", function (event) {
    if (!(account && account.pack)) return; // a plain payment link: let it open
    event.preventDefault();
    var link = this;
    if (link.getAttribute("aria-busy") === "true") return;
    var session = getSession();
    if (!session) { signedOut("Please sign in again."); return; }
    var label = link.textContent;
    link.setAttribute("aria-busy", "true");
    link.textContent = "Opening secure checkout…";
    showError($("gaTopupError"), "");
    SP.api("/griot/checkout", { token: session.token, body: {} }).then(function (data) {
      window.location.assign(data.link);
    }, function (e) {
      link.removeAttribute("aria-busy");
      link.textContent = label;
      if (e.status === 401) { signedOut(e.message); return; }
      showError($("gaTopupError"), e.message);
    });
  });

  /* -------------------------------------------------- back from checkout */

  // Flutterwave returns the customer to this page with
  // ?status=…&tx_ref=…&transaction_id=…. Read it once, then clear the address
  // bar, so a reload or a shared link never re-submits a payment reference.
  var returned = (function () {
    var q = new URLSearchParams(window.location.search);
    var txRef = q.get("tx_ref");
    if (!txRef) return null;
    return {
      txRef: txRef,
      transactionId: q.get("transaction_id") || "",
      status: (q.get("status") || "").toLowerCase()
    };
  })();
  if (returned && window.history && window.history.replaceState) {
    window.history.replaceState(null, "", window.location.pathname);
  }

  function settleReturn() {
    var r = returned;
    returned = null;
    if (!r) return;
    if (r.status === "cancelled" || !r.transactionId) {
      notice("Payment cancelled — nothing was charged.");
      return;
    }
    var session = getSession();
    if (!session) return;
    notice("Confirming your payment…");
    SP.api("/griot/payment/confirm", {
      token: session.token,
      body: { txRef: r.txRef, transactionId: r.transactionId }
    }).then(function (data) {
      setSession({ token: session.token, expiresAt: session.expiresAt, account: data.account });
      renderAccount(data.account);
      if (data.status === "credited" || data.status === "already_credited") {
        notice("Payment received — " + data.messages + " messages added. Carry on where you left off.");
        if (!exhausted()) {
          show("chat");
          $("gaSendBtn").disabled = false;
          $("ga-message").focus({ preventScroll: true });
        }
      } else {
        notice("We could not confirm that payment yet. If you were charged, your messages are added automatically as soon as it clears.");
      }
    }, function (e) {
      if (e.status === 401) { signedOut(e.message); return; }
      notice(e.message);
    });
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
    if (exhausted()) openTopup();
    else $("ga-message").focus({ preventScroll: true });
    settleReturn();
  }

  function signedOut(message) {
    setSession(null);
    account = null;
    show("signup");
    mountSignIn();
    if (message) showError($("gaSignupError"), message);
  }

  var pendingEmail = "";

  panels.signup.addEventListener("submit", function (event) {
    event.preventDefault();
    var err = $("gaSignupError");
    showError(err, "");
    var email = $("ga-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError(err, "Enter a valid email address.");
      $("ga-email").focus();
      return;
    }
    if (SP.config.turnstileSiteKey && !turnstileToken) {
      showError(err, "Please complete the security check first.");
      return;
    }
    var btn = $("gaSignupBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    SP.api("/auth/start", {
      body: { email: email, name: $("ga-name").value.trim(), turnstileToken: turnstileToken }
    }).then(function () {
      pendingEmail = email;
      $("gaVerifyEmail").textContent = email;
      $("ga-code").value = "";
      show("verify");
      $("ga-code").focus();
    }, function (e) {
      showError(err, e.message);
      resetTurnstile();
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "Send my code";
    });
  });

  panels.verify.addEventListener("submit", function (event) {
    event.preventDefault();
    var err = $("gaVerifyError");
    showError(err, "");
    var code = $("ga-code").value.replace(/\D/g, "");
    if (code.length !== 6) {
      showError(err, "Enter the 6-digit code from the email.");
      $("ga-code").focus();
      return;
    }
    var btn = $("gaVerifyBtn");
    btn.disabled = true;
    SP.api("/auth/verify", {
      body: { email: pendingEmail, code: code, anonId: SP.anonId, page: location.pathname }
    }).then(function (data) {
      setSession({ token: data.token, expiresAt: data.expiresAt, account: data.account });
      startChat(data.account);
    }, function (e) {
      showError(err, e.message);
    }).then(function () { btn.disabled = false; });
  });

  $("gaRestart").addEventListener("click", function () {
    pendingEmail = "";
    resetTurnstile();
    show("signup");
    $("ga-email").focus();
  });

  $("gaSignout").addEventListener("click", function () {
    signedOut("");
    $("ga-email").value = "";
  });

  panels.chat.querySelector("#gaComposer").addEventListener("submit", function (event) {
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
    var session = getSession();
    if (!session) { signedOut("Please sign in again."); return; }

    sending = true;
    var btn = $("gaSendBtn");
    btn.disabled = true;
    btn.textContent = "GRIOT is thinking…";
    var mine = addMessage("user", message);
    box.value = "";
    var thinking = addMessage("griot", "Working through it…");
    thinking.classList.add("griot-msg--pending");

    SP.api("/griot/chat", {
      token: session.token,
      body: { message: message, threadId: getThread(account), anonId: SP.anonId, page: location.pathname }
    }).then(function (reply) {
      thinking.remove();
      addMessage("griot", reply.answer, describe(reply));
      setThread(account, reply.threadId);
      setSession({ token: session.token, expiresAt: session.expiresAt, account: reply.account });
      renderAccount(reply.account);
      if (exhausted()) openTopup();
    }, function (e) {
      thinking.remove();
      if (e.status === 401) { signedOut(e.message); return; }
      if (e.status === 402) {
        renderAccount(e.data && e.data.account);
        // The message was not sent: put it back so nothing typed is lost.
        box.value = message;
        mine.remove();
        openTopup(e.data && e.data.checkoutUrl);
        return;
      }
      // Any other failure was refunded by the Worker; restore the question.
      box.value = message;
      mine.remove();
      showError(err, e.message);
    }).then(function () {
      sending = false;
      btn.textContent = "Ask GRIOT";
      if (!exhausted()) btn.disabled = false;
    });
  }

  /* ---------------------------------------------------------------- start */

  if (!SP || !SP.connected) {
    show("offline");
    return;
  }

  var existing = getSession();
  if (!existing) {
    // Connected, but with no way to sign in: say so rather than show a form
    // that cannot work.
    if (!googleEnabled() && !emailEnabled()) { show("offline"); return; }
    show("signup");
    mountSignIn();
    return;
  }

  // Confirm the stored session is still good before showing the conversation.
  renderAccount(existing.account);
  SP.api("/me", { token: existing.token }).then(function (data) {
    setSession({ token: existing.token, expiresAt: existing.expiresAt, account: data.account });
    startChat(data.account);
  }, function (e) {
    if (e.status === 401) signedOut("");
    else startChat(existing.account); // offline blip: keep them in, send will retry
  });
})();
