/* ==========================================================================
   SpeakPower — GRIOT app
   Sign in once (account.js), use the free tries, then carry on with a plan.
   GRIOT has no per-use price.

   The browser holds only a SpeakPower session token and a thread id. It never
   sees GRIOT's address or key: every message goes to the Worker, which takes
   a plan use or a free try and calls GRIOT server-to-server under this
   account's own tenant.

   The workspace (once the Worker reports GRIOT has it): choose up to three
   specialist lenses, watch GRIOT's nine steps while it thinks, and browse
   Conversations, Memory and Decisions. Each list is this account's own.

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

  /* ------------------------------------------------------------ workspace */

  // What each specialist is for, in plain words. GRIOT names them; the
  // Worker passes its list through, so a lens this page does not know still
  // shows, just without its line.
  var LENS_ROLES = {
    story: "Narrative, messaging and the story you tell",
    market: "Customers, competitors, pricing and demand",
    data: "Numbers, KPIs and what the data says",
    dev: "Software, systems and technical delivery",
    research: "Evidence, sources and what is known",
    growth: "Acquisition, retention and channels",
    operations: "Process, people and getting it done",
    brand: "Identity, positioning and reputation",
    strategy: "Priorities, trade-offs and the next decision"
  };
  var ws = { ready: false, lenses: [], steps: [] };
  var chosen = [];
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function loadWorkspace() {
    return A.call("/griot/workspace").then(function (data) {
      ws = { ready: !!data.ready, lenses: data.lenses || [], steps: data.steps || [] };
      $("gaTabs").hidden = !ws.ready;
      $("gaLenses").hidden = !ws.ready || !ws.lenses.length;
      $("gaNewBtn").hidden = !ws.ready;
      if (ws.ready) renderLensChips();
    }, function () { /* the plain conversation still works */ });
  }

  function renderLensChips() {
    var host = $("gaLensChips");
    host.textContent = "";
    var auto = el("button", "chip ga-lens", "Auto");
    auto.type = "button";
    auto.setAttribute("aria-pressed", String(!chosen.length));
    auto.addEventListener("click", function () { chosen = []; renderLensChips(); });
    host.appendChild(auto);
    ws.lenses.forEach(function (lens) {
      var b = el("button", "chip ga-lens", lens.name);
      b.type = "button";
      b.title = LENS_ROLES[lens.key] || lens.name;
      b.setAttribute("aria-pressed", String(chosen.indexOf(lens.key) !== -1));
      b.addEventListener("click", function () {
        var i = chosen.indexOf(lens.key);
        if (i !== -1) chosen.splice(i, 1);
        else if (chosen.length < 3) chosen.push(lens.key);
        renderLensChips();
      });
      host.appendChild(b);
    });
    var names = chosen.map(function (k) {
      var l = ws.lenses.filter(function (x) { return x.key === k; })[0];
      return l ? l.name : k;
    });
    $("gaLensHint").textContent = chosen.length
      ? "Looking through " + (names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0]) + "." +
        (chosen.length === 3 ? " That is the most for one question." : "")
      : "Auto lets GRIOT pick the specialists your question needs. Hover a lens to see what it covers.";
  }

  // While GRIOT works, its nine steps light up in turn: the method made
  // visible. Under reduced motion they show as a still list.
  function thinking() {
    var item = addMessage("griot", "");
    item.classList.add("griot-msg--pending");
    var body = item.querySelector(".griot-body");
    body.textContent = "";
    if (!ws.ready || !ws.steps.length) { body.textContent = "Working through it…"; return { item: item, stop: function () {} }; }
    body.appendChild(el("p", "ga-steps-lead", "Working through GRIOT's " + ws.steps.length + " steps"));
    var list = el("ol", "ga-steps");
    ws.steps.forEach(function (step) { list.appendChild(el("li", null, step.charAt(0) + step.slice(1).toLowerCase())); });
    body.appendChild(list);
    var i = 0;
    var items = list.children;
    function mark() {
      for (var k = 0; k < items.length; k++) {
        items[k].className = k < i ? "is-done" : k === i ? "is-current" : "";
      }
    }
    mark();
    var timer = reduceMotion ? null : window.setInterval(function () {
      if (i < items.length - 1) { i++; mark(); }
    }, 1600);
    return { item: item, stop: function () { if (timer) window.clearInterval(timer); } };
  }

  /* ----------------------------------------------------------------- tabs */

  var TABS = ["ask", "conversations", "memory", "decisions"];
  function openTab(name, focus) {
    TABS.forEach(function (t) {
      var on = t === name;
      var tab = $("gaTab-" + t);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $("gaPanel-" + t).hidden = !on;
      if (on && focus) tab.focus();
    });
    if (name === "conversations") loadConversations();
    if (name === "memory") loadMemory();
    if (name === "decisions") loadDecisions();
  }
  TABS.forEach(function (t, i) {
    $("gaTab-" + t).addEventListener("click", function () { openTab(t); });
    $("gaTab-" + t).addEventListener("keydown", function (e) {
      var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      openTab(TABS[(i + d + TABS.length) % TABS.length], true);
    });
  });

  function listState(emptyId, listId, items, emptyText) {
    $(listId).textContent = "";
    $(emptyId).textContent = emptyText;
    $(emptyId).hidden = !!items.length;
  }
  function listError(emptyId, e) {
    $(emptyId).textContent = (e && e.message) || "That could not be loaded. Please try again.";
    $(emptyId).hidden = false;
    if (e && e.status === 401) signedOut(e.message);
  }

  function loadConversations() {
    $("gaConvEmpty").textContent = "Loading…";
    $("gaConvEmpty").hidden = false;
    A.call("/griot/threads").then(function (data) {
      var threads = data.threads || [];
      listState("gaConvEmpty", "gaConvList", threads, "No conversations yet. Ask GRIOT something and it appears here.");
      threads.forEach(function (t) {
        var li = el("li", "ga-item");
        var b = el("button", "ga-item-open");
        b.type = "button";
        b.appendChild(el("strong", null, t.firstQuestion || "Conversation"));
        b.appendChild(el("span", "ga-item-meta", Math.ceil((t.messages || 0) / 2) + " question" + (t.messages > 2 ? "s" : "") + " · " + when(t.lastAt)));
        b.addEventListener("click", function () { openThread(t.id); });
        li.appendChild(b);
        $("gaConvList").appendChild(li);
      });
    }, function (e) { listError("gaConvEmpty", e); });
  }

  function clearLog(text) {
    $("gaLog").textContent = "";
    var empty = el("p", "output-empty", text);
    empty.id = "gaEmpty";
    $("gaLog").appendChild(empty);
  }

  function openThread(id) {
    A.call("/griot/thread?id=" + encodeURIComponent(id)).then(function (data) {
      openTab("ask");
      clearLog("");
      (data.messages || []).forEach(function (m) { addMessage(m.role === "user" ? "user" : "griot", m.content); });
      setThread(account, id);
      $("ga-message").focus({ preventScroll: true });
    }, function (e) { showError($("gaChatError"), e.message); openTab("ask"); });
  }

  function loadMemory() {
    $("gaMemEmpty").textContent = "Loading…";
    $("gaMemEmpty").hidden = false;
    A.call("/griot/memories").then(function (data) {
      var memories = data.memories || [];
      listState("gaMemEmpty", "gaMemList", memories, "Nothing yet. GRIOT remembers what matters from your conversations, or add a fact above.");
      memories.forEach(function (m) {
        var li = el("li", "ga-item");
        var head = el("div", "ga-item-head");
        head.appendChild(el("strong", null, m.title));
        var conf = String(m.confidence || "").toUpperCase();
        if (conf) head.appendChild(el("span", "griot-label griot-label--" + conf.toLowerCase(), conf));
        li.appendChild(head);
        li.appendChild(el("p", "ga-item-text", m.content));
        var foot = el("div", "ga-item-foot");
        foot.appendChild(el("span", "ga-item-meta", when(m.at)));
        var del = el("button", "ga-link ga-forget", "Forget this");
        del.type = "button";
        del.addEventListener("click", function () {
          if (!window.confirm("GRIOT will forget “" + m.title + "”. This cannot be undone.")) return;
          A.call("/griot/memories/delete", { id: m.id }).then(loadMemory, function (e) { listError("gaMemEmpty", e); });
        });
        foot.appendChild(del);
        li.appendChild(foot);
        $("gaMemList").appendChild(li);
      });
    }, function (e) { listError("gaMemEmpty", e); });
  }

  $("gaMemForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var err = $("gaMemError");
    var title = $("ga-mem-title").value.trim();
    var content = $("ga-mem-content").value.trim();
    if (!title || !content) { showError(err, "Give the fact a few words and the detail."); return; }
    showError(err, "");
    $("gaMemAdd").disabled = true;
    A.call("/griot/memory", { title: title, content: content }).then(function () {
      $("ga-mem-title").value = "";
      $("ga-mem-content").value = "";
      loadMemory();
    }, function (e) { showError(err, e.message); }).then(function () { $("gaMemAdd").disabled = false; });
  });

  function loadDecisions() {
    $("gaDecEmpty").textContent = "Loading…";
    $("gaDecEmpty").hidden = false;
    A.call("/griot/decisions").then(function (data) {
      var decisions = data.decisions || [];
      listState("gaDecEmpty", "gaDecList", decisions, "No decisions yet. Each question you bring is logged here with GRIOT's recommendation.");
      decisions.forEach(function (d) {
        var li = el("li", "ga-item");
        var head = el("div", "ga-item-head");
        head.appendChild(el("strong", null, d.question));
        head.appendChild(el("span", "ga-item-meta", when(d.at)));
        li.appendChild(head);
        var rec = el("div", "ga-item-text");
        renderAnswer(rec, d.recommendation.length >= 600 ? d.recommendation + "…" : d.recommendation);
        li.appendChild(rec);
        if (d.threadId) {
          var open = el("button", "ga-link", "Open the conversation");
          open.type = "button";
          open.addEventListener("click", function () { openThread(d.threadId); });
          li.appendChild(open);
        }
        $("gaDecList").appendChild(li);
      });
    }, function (e) { listError("gaDecEmpty", e); });
  }

  $("gaNewBtn").addEventListener("click", function () {
    setThread(account, null);
    clearLog("A new conversation. GRIOT still remembers what it knows about you.");
    $("ga-message").focus({ preventScroll: true });
  });

  function describe(reply) {
    var parts = [];
    parts.push(reply.paidWith === "trial" ? "Free try" : "Included in your plan");
    if (reply.agents && reply.agents.length) {
      var lensNames = reply.agents.map(function (a) { return String(a).replace(/Agent$/, ""); });
      parts.push((lensNames.length > 1 ? "Lenses: " : "Lens: ") + lensNames.join(", "));
    }
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
      onSignedIn: function (acct) { notice(null); startChat(acct); loadWorkspace(); }
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
    var pending = thinking();

    var payload = { message: message, threadId: getThread(account), anonId: SP.anonId, page: location.pathname };
    if (ws.ready && chosen.length) payload.lenses = chosen.slice();
    A.call("/griot/chat", payload).then(function (reply) {
      pending.stop();
      pending.item.remove();
      var answer = addMessage("griot", reply.answer, describe(reply));
      if (reply.memoryWritten && ws.ready) {
        var see = el("button", "ga-link ga-see-memory", "See what GRIOT remembers");
        see.type = "button";
        see.addEventListener("click", function () { openTab("memory"); });
        answer.appendChild(see);
      }
      setThread(account, reply.threadId);
      A.setAccount(reply.account);
      renderAccount(reply.account);
      if (cannotPay()) openTopup();
    }, function (e) {
      pending.stop();
      pending.item.remove();
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
  loadWorkspace();
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
