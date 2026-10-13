/* ==========================================================================
   SpeakPower — GRIOT app, in the GRIOT OS frame
   Sign in once (account.js), use the free tries, then carry on with a plan.
   GRIOT has no per-use price.

   The browser holds only a SpeakPower session token, a thread id and the
   chosen project. It never sees GRIOT's address or key: every message goes
   to the Worker, which takes a plan use or a free try and calls GRIOT
   server-to-server under this account's own tenant.

   The workspace (once the Worker reports GRIOT has it): choose up to three
   specialist lenses, watch GRIOT's nine steps while it thinks, and browse
   Conversations, Memory, Decisions and Documents. Once GRIOT keeps client
   projects, the picker in the sidebar files each conversation, memory and
   decision under one of the person's own projects. Each list is this
   account's own.

   Security: all text written into the DOM goes through textContent, never
   innerHTML, so nothing GRIOT or a user types can be interpreted as markup.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  var THREAD_KEY = "sp_griot_thread";
  var PROJECT_KEY = "sp_griot_project";

  function $(id) { return document.getElementById(id); }

  var app = $("gxApp");
  if (!app || !$("gaLog")) return;

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function icon(name) {
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("class", "gx-i");
    s.setAttribute("aria-hidden", "true");
    var u = document.createElementNS(SVG_NS, "use");
    u.setAttribute("href", "#gx-" + name);
    s.appendChild(u);
    return s;
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function wide() { return !window.matchMedia || window.matchMedia("(min-width: 861px)").matches; }

  /* ---------------------------------------------------------------- gates */

  // What takes the bottom of the Ask view: the composer, sign-in, the plan
  // wall, or "being connected". The app itself always shows.
  var gates = { chat: $("gaChat"), signIn: $("gaSignIn"), topup: $("gaTopup"), offline: $("gaOffline") };
  var STATE = { chat: "in", signIn: "out", topup: "wall", offline: "offline" };
  function show(name) {
    Object.keys(gates).forEach(function (key) { gates[key].hidden = key !== name; });
    app.setAttribute("data-state", STATE[name]);
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

  /* ------------------------------------------------------- account, thread */

  var account = null;

  function emailKey() { return String((account && account.email) || "").toLowerCase(); }

  // The thread is per account and per project, so signing in as someone else
  // on a shared computer never continues the previous person's conversation,
  // and each project keeps its own. General keeps the key it always had.
  function threadKey() {
    var base = THREAD_KEY + ":" + emailKey();
    return currentProject !== "global" ? base + ":" + currentProject : base;
  }
  function getThread() { return SP.storageGet(threadKey()) || null; }
  function setThread(id) {
    SP.storageSet(threadKey(), id || null);
    renderThreadLabel();
  }
  function renderThreadLabel() {
    var id = account ? getThread() : null;
    $("gaThreadLabel").textContent = !account ? "" : id ? "conversation " + String(id).slice(0, 8) : "new conversation";
  }

  function renderAccount(next) {
    if (next) account = next;
    if (!account) return;
    $("gaStatusLine").textContent = "GRIOT online";
    $("gaBalance").textContent = A.statusText(account);
    $("gaWho").textContent = account.email || "";
    A.renderUsage($("gaUsage"), account, "griot");
    var name = typeof account.greetName === "string" ? account.greetName.trim() : "";
    $("gaHi").textContent = name ? "Hi " + name : "Account";
    $("gaInitial").textContent = (name || account.email || "?").charAt(0).toUpperCase();
    $("gaAcct").hidden = false;
    $("gaDrawerAcct").hidden = false;
  }

  // No free try left, and no plan with GRIOT left this month.
  function cannotPay() {
    if (!account || Number(account.trialsRemaining) > 0) return false;
    var m = account.membership;
    return !(m && m.plan && m.usage && m.usage.griot < 100);
  }

  function openTopup(info) {
    info = info || {};
    var host = gates.topup;
    A.renderPlanWall(host, {
      message: info.message,
      plans: info.plans,
      account: account,
      returnTo: "griot-app.html",
      onSignedOut: function () { signedOut("Your session ended. Please sign in again."); }
    });
    var keep = el("p", "builder-note", "GRIOT still remembers everything you told it. Carry on from exactly where you stopped.");
    host.insertBefore(keep, host.children[2] || null); // after the lead line
    show("topup");
    $("gaSendBtn").disabled = true;
  }

  /* ------------------------------------------------------------------ log */

  var log = $("gaLog");
  // "This conversation: Word · PDF" sits at the end of the conversation,
  // after the latest answer; it is moved there whenever the log changes.
  var convDownload = $("gaConvDownload");
  function scrollLog() { log.scrollTop = log.scrollHeight; }
  function appendToLog(node) {
    log.insertBefore(node, convDownload.parentNode === log ? convDownload : null);
  }

  // Matches "FACT:", "**FACT:**", "**FACT**:" and "- FACT:". A bullet needs a
  // space after it, so the "**" of bold is never mistaken for one.
  var LABEL = /^(\s*(?:[-*]\s+)?)(?:\*\*)?(FACT|INFERENCE|HYPOTHESIS|RECOMMENDATION|UNKNOWN)(?:\*\*)?\s*:(?:\*\*)?/i;
  var HEADING = /^\s*#{1,4}\s+(.+)$/;
  var BULLET = /^(\s*)[-*]\s+(.*)$/;

  // **bold** as <strong>, only when the markers pair up; the rest as text.
  function inline(host, text) {
    var parts = String(text).split("**");
    if (parts.length < 3 || parts.length % 2 === 0) { host.appendChild(document.createTextNode(text)); return; }
    parts.forEach(function (part, i) {
      if (!part) return;
      host.appendChild(i % 2 ? el("strong", null, part) : document.createTextNode(part));
    });
  }

  // GRIOT's answer, line by line: headings, bullets and bold kept, and its
  // evidence labels as coloured tags. Labels are its whole point, so they
  // should read at a glance — but this is done by building nodes, never by
  // injecting markup.
  function renderAnswer(host, text) {
    var needBreak = false;
    String(text).split("\n").forEach(function (line) {
      var h = line.match(HEADING);
      if (h) {
        host.appendChild(el("span", "gx-answer-h", h[1].replace(/\*\*/g, "")));
        needBreak = false;
        return;
      }
      if (needBreak) host.appendChild(document.createElement("br"));
      needBreak = true;
      var m = line.match(LABEL);
      if (m) {
        host.appendChild(document.createTextNode(m[1].replace(/[-*]\s+$/, "• ")));
        host.appendChild(el("strong", "griot-label griot-label--" + m[2].toLowerCase(), m[2].toUpperCase()));
        inline(host, line.slice(m[0].length).replace(/^\s+/, ""));
        return;
      }
      var b = line.match(BULLET);
      if (b) {
        host.appendChild(document.createTextNode(b[1] + "• "));
        inline(host, b[2]);
        return;
      }
      inline(host, line);
    });
  }

  // What each message in the log says, for downloads. Keyed by its element,
  // so clearing the log forgets it too.
  var logged = new WeakMap();
  var face = $("gaFace");

  function bubble(role, who) {
    var item = el("div", "griot-msg griot-msg--" + role);
    if (role === "griot" && face) item.appendChild(face.content.firstElementChild.cloneNode(true));
    item.appendChild(el("span", "griot-who", who || (role === "user" ? "You" : "GRIOT")));
    return item;
  }

  function addMessage(role, text, meta, who) {
    var intro = $("gaEmpty");
    if (intro) intro.remove();
    var item = bubble(role, who);
    var body = el("div", "griot-body");
    if (role === "griot") renderAnswer(body, text);
    else body.textContent = text;
    item.appendChild(body);
    if (meta) item.appendChild(el("p", "griot-meta", meta));
    appendToLog(item);
    if (text) {
      logged.set(item, { role: role, text: String(text), meta: meta || "" });
      if (role === "griot" && window.SPExport) {
        var actions = el("div", "gx-actions");
        var dl = el("div", "ga-msg-download");
        dl.appendChild(SPExport.buttons(function () { return answerDoc(item); }));
        actions.appendChild(dl);
        item.appendChild(actions);
      }
      refreshConversationDownload();
    }
    scrollLog();
    return item;
  }

  // GRIOT speaking first: a welcome, not part of the conversation, never
  // downloaded. Gone as soon as the conversation starts.
  function intro(text, extra) {
    var old = $("gaEmpty");
    if (old) old.remove();
    var item = bubble("griot");
    item.id = "gaEmpty";
    item.classList.add("gx-intro");
    item.appendChild(el("div", "griot-body", text));
    if (extra) item.appendChild(extra);
    appendToLog(item);
    return item;
  }

  function clearLog() {
    log.textContent = "";
    refreshConversationDownload();
  }

  /* ------------------------------------------------------------ downloads */

  function messagesInLog() {
    var out = [];
    Array.prototype.forEach.call(log.children, function (n) {
      var m = logged.get(n);
      if (m) out.push(m);
    });
    return out;
  }

  function shorten(text, n) {
    var t = String(text).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
  }

  // One answer and the question it answered.
  function answerDoc(item) {
    var answer = logged.get(item);
    var question = null;
    for (var n = item.previousElementSibling; n; n = n.previousElementSibling) {
      var m = logged.get(n);
      if (m && m.role === "user") { question = m; break; }
    }
    var sections = [];
    if (question) sections.push({ heading: "Your question", lines: [question.text] });
    sections.push({ heading: "GRIOT's answer", lines: [answer.text] });
    if (answer.meta) sections.push({ heading: "", lines: [answer.meta] });
    return {
      title: question ? "GRIOT · " + shorten(question.text, 70) : "GRIOT's answer",
      subtitle: "An answer from GRIOT, SpeakPower's strategic advisor",
      footer: "SpeakPower · GRIOT",
      sections: sections
    };
  }

  // The whole conversation on the page, in order.
  function conversationDoc() {
    var msgs = messagesInLog();
    var first = msgs.filter(function (m) { return m.role === "user"; })[0];
    return {
      title: first ? "GRIOT · " + shorten(first.text, 70) : "A conversation with GRIOT",
      subtitle: "A conversation with GRIOT, SpeakPower's strategic advisor",
      footer: "SpeakPower · GRIOT",
      sections: msgs.map(function (m) {
        return { heading: m.role === "user" ? "You" : "GRIOT", lines: m.meta ? [m.text, m.meta] : [m.text] };
      })
    };
  }

  function refreshConversationDownload() {
    var host = convDownload;
    if (!host || !window.SPExport) return;
    var any = messagesInLog().some(function (m) { return m.role === "griot"; });
    if (any && !host.firstChild) host.appendChild(SPExport.buttons(conversationDoc, "Download this conversation"));
    if (any && host.parentNode !== log) log.appendChild(host);
    host.hidden = !any;
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
  var ws = { ready: false, lenses: [], steps: [], modes: [] };
  var chosen = [];

  // Challenge, Diagnose or Plan: how GRIOT answers. One at a time, and it
  // stays on for follow-up questions until switched off.
  var MODE_HINTS = {
    challenge: "Challenge: GRIOT pressure-tests your idea: its weakest assumptions, the toughest objection, and a verdict.",
    diagnose: "Diagnose: GRIOT finds the root cause before suggesting any fix.",
    plan: "Plan: GRIOT lays out phases with owners, dates and measures, and the first step for this week."
  };
  var chosenMode = null;

  function renderModeChips() {
    var available = ws.ready ? ws.modes : [];
    $("gaModes").hidden = !available.length;
    if (available.indexOf(chosenMode) === -1) chosenMode = null;
    Array.prototype.forEach.call(document.querySelectorAll(".ga-mode"), function (b) {
      var mode = b.getAttribute("data-mode");
      b.hidden = available.indexOf(mode) === -1;
      b.setAttribute("aria-pressed", String(mode === chosenMode));
    });
    $("gaModeHint").textContent = chosenMode ? MODE_HINTS[chosenMode] + " Tap it again for GRIOT's usual answer."
      : available.length ? "Ctrl + Enter sends. Pick Challenge, Diagnose or Plan to change how GRIOT answers, or leave them off for its usual answer."
      : "Ctrl + Enter sends.";
  }

  Array.prototype.forEach.call(document.querySelectorAll(".ga-mode"), function (b) {
    b.addEventListener("click", function () {
      var mode = b.getAttribute("data-mode");
      chosenMode = chosenMode === mode ? null : mode;
      renderModeChips();
    });
  });

  function loadWorkspace() {
    return A.call("/griot/workspace").then(function (data) {
      ws = { ready: !!data.ready, lenses: data.lenses || [], steps: data.steps || [], modes: data.modes || [] };
      $("gaTabs").hidden = !ws.ready;
      $("gaLensBtn").hidden = !ws.ready || !ws.lenses.length;
      $("gaNewBtn").hidden = !ws.ready;
      $("gaAttach").hidden = !ws.ready;
      renderModeChips();
      if (!ws.ready) return;
      renderLensChips();
      renderIntroAction();
      return loadProjects();
    }, function () { /* the plain conversation still works */ });
  }

  function lensName(key) {
    var l = ws.lenses.filter(function (x) { return x.key === key; })[0];
    return l ? l.name : key;
  }

  function renderLensChips() {
    var host = $("gaLensChips");
    host.textContent = "";
    var auto = el("button", "ga-lens ga-lens--auto");
    auto.type = "button";
    auto.appendChild(el("span", null, "Auto"));
    auto.appendChild(el("small", null, "GRIOT picks the specialists your question needs"));
    auto.setAttribute("aria-pressed", String(!chosen.length));
    auto.addEventListener("click", function () { chosen = []; renderLensChips(); });
    host.appendChild(auto);
    ws.lenses.forEach(function (lens) {
      var on = chosen.indexOf(lens.key) !== -1;
      var b = el("button", "ga-lens" + (!on && chosen.length >= 3 ? " is-maxed" : ""));
      b.type = "button";
      b.appendChild(el("span", null, lens.name));
      if (LENS_ROLES[lens.key]) b.appendChild(el("small", null, LENS_ROLES[lens.key]));
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", function () {
        var i = chosen.indexOf(lens.key);
        if (i !== -1) chosen.splice(i, 1);
        else if (chosen.length < 3) chosen.push(lens.key);
        renderLensChips();
      });
      host.appendChild(b);
    });
    var names = chosen.map(lensName);
    $("gaLensLabel").textContent = names.length ? "Lenses: " + names.join(", ") : "Lenses: Auto";
    $("gaLensHint").textContent = chosen.length
      ? "Looking through " + (names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0]) + "." +
        (chosen.length === 3 ? " That is the most for one question." : " Pick up to three.")
      : "Auto lets GRIOT pick the specialists your question needs, or choose up to three yourself.";
  }

  var PROVERBS = Array.isArray(window.GRIOT_PROVERBS) ? window.GRIOT_PROVERBS : [];

  // While GRIOT works: the G talks, the Signature radiates, and the nine
  // steps light up in turn, each with a proverb (griot-proverbs.js). Under
  // reduced motion it all stays still.
  function thinking() {
    var item = addMessage("griot", "", null, "GRIOT · thinking");
    item.classList.add("griot-msg--pending");
    var body = item.querySelector(".griot-body");
    body.textContent = "";
    var steps = ws.ready && ws.steps.length ? ws.steps : PROVERBS.map(function (p) { return p.step; });
    var box = el("div", "ga-think");
    box.appendChild(el("p", "ga-steps-lead", steps.length ? "Working through GRIOT's " + steps.length + " steps" : "Working through it…"));
    var list = el("ol", "ga-steps");
    steps.forEach(function (step) { list.appendChild(el("li", null, step.charAt(0) + step.slice(1).toLowerCase())); });
    box.appendChild(list);
    var proverb = el("figure", "ga-proverb");
    var said = el("blockquote");
    var means = el("figcaption");
    proverb.appendChild(said);
    proverb.appendChild(means);
    box.appendChild(proverb);
    body.appendChild(box);
    proverb.hidden = !PROVERBS.length;
    app.setAttribute("data-griot", "thinking");

    var i = 0;
    var items = list.children;
    function step() {
      for (var k = 0; k < items.length; k++) items[k].className = k < i ? "is-done" : k === i ? "is-current" : "";
      var p = PROVERBS[i % (PROVERBS.length || 1)];
      if (!p) return;
      said.textContent = p.said;
      said.setAttribute("lang", p.lang || "en");
      means.textContent = p.means + " · " + p.language;
      proverb.classList.remove("is-in");
      void proverb.offsetWidth; // restart the fade
      proverb.classList.add("is-in");
    }
    step();
    scrollLog();
    var timer = reduceMotion ? null : window.setInterval(function () {
      if (i < items.length - 1) { i++; step(); }
    }, 2600);
    return {
      item: item,
      stop: function () {
        if (timer) window.clearInterval(timer);
        app.removeAttribute("data-griot");
      }
    };
  }

  /* ------------------------------------------------------------- projects */

  // Once GRIOT keeps client projects, the person's own: names they choose,
  // with General (GRIOT's "global") always first. Documents and the profile
  // stay account-wide, so GRIOT knows the person in every project.
  var NEW = "__new";
  var RENAME = "__rename";
  var DELETE = "__delete";
  var projects = { ready: false, list: [], limit: 20 };
  var currentProject = "global";

  function projectKey() { return PROJECT_KEY + ":" + emailKey(); }
  function projectName(slug) {
    if (!slug || slug === "global") return "General";
    var p = projects.list.filter(function (x) { return x.slug === slug; })[0];
    return p ? p.name : "General";
  }

  function loadProjects() {
    return A.call("/griot/my-projects").then(function (data) {
      projects = { ready: !!data.ready, list: data.projects || [], limit: data.limit || 20 };
      var saved = SP.storageGet(projectKey());
      var was = currentProject;
      currentProject = projects.ready && saved && projects.list.some(function (p) { return p.slug === saved; }) ? saved : "global";
      renderProjects();
      // A saved project changes which conversation this is; redraw only if
      // nothing has been asked on the page yet.
      if (currentProject !== was && !sending && !messagesInLog().length) startConversationView();
      else renderViewTitle();
    }, function () { projects.ready = false; renderProjects(); });
  }

  function renderProjects() {
    $("gaProjectBlock").hidden = !projects.ready;
    var select = $("gaProject");
    select.textContent = "";
    var general = el("option", null, "General");
    general.value = "global";
    select.appendChild(general);
    projects.list.forEach(function (p) {
      var o = el("option", null, p.name);
      o.value = p.slug;
      select.appendChild(o);
    });
    var manage = el("optgroup");
    manage.label = "Projects";
    if (projects.list.length < projects.limit) {
      var add = el("option", null, "+ New project…");
      add.value = NEW;
      manage.appendChild(add);
    }
    if (currentProject !== "global") {
      var ren = el("option", null, "Rename “" + projectName(currentProject) + "”…");
      ren.value = RENAME;
      manage.appendChild(ren);
      var del = el("option", null, "Delete “" + projectName(currentProject) + "”…");
      del.value = DELETE;
      manage.appendChild(del);
    }
    if (manage.children.length) select.appendChild(manage);
    select.value = currentProject;
    $("gaProjectTools").hidden = currentProject === "global";
  }

  function closeProjectUi() {
    $("gaProjectForm").hidden = true;
    $("gaProjectConfirm").hidden = true;
    showError($("gaProjectError"), "");
  }

  var projectFormMode = "create";
  function openProjectForm(mode) {
    closeProjectUi();
    projectFormMode = mode;
    var input = $("gaProjectName");
    input.value = mode === "rename" ? projectName(currentProject) : "";
    $("gaProjectSave").textContent = mode === "rename" ? "Rename" : "Create project";
    $("gaProjectFormLabel").textContent = mode === "rename" ? "New name for this project" : "Project name";
    $("gaProjectNote").textContent = mode === "rename" ? "Only the name changes; everything in it stays."
      : "Its conversations, memory and decisions stay separate from your other projects. Up to " + projects.limit + " projects.";
    $("gaProjectForm").hidden = false;
    input.focus();
  }

  function openProjectConfirm() {
    closeProjectUi();
    $("gaProjectConfirmText").textContent = "Delete “" + projectName(currentProject) +
      "”? Its conversations, memories and decisions are deleted with it. This cannot be undone.";
    $("gaProjectConfirm").hidden = false;
    $("gaProjectDeleteNo").focus();
  }

  function switchProject(slug) {
    currentProject = slug || "global";
    SP.storageSet(projectKey(), currentProject === "global" ? null : currentProject);
    renderProjects();
    closeProjectUi();
    startConversationView();
    var open = currentTab();
    if (open !== "ask") openTab(open);
  }

  $("gaProject").addEventListener("change", function () {
    var v = this.value;
    if (v === NEW || v === RENAME || v === DELETE || sending) this.value = currentProject;
    if (sending) return;
    if (v === NEW) { openProjectForm("create"); return; }
    if (v === RENAME) { openProjectForm("rename"); return; }
    if (v === DELETE) { openProjectConfirm(); return; }
    switchProject(v);
  });
  $("gaProjectRename").addEventListener("click", function () { openProjectForm("rename"); });
  $("gaProjectDelete").addEventListener("click", openProjectConfirm);
  $("gaProjectCancel").addEventListener("click", closeProjectUi);
  $("gaProjectDeleteNo").addEventListener("click", closeProjectUi);

  $("gaProjectForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var name = $("gaProjectName").value.replace(/\s+/g, " ").trim();
    if (!name) { showError($("gaProjectError"), "Give the project a name."); $("gaProjectName").focus(); return; }
    showError($("gaProjectError"), "");
    var save = $("gaProjectSave");
    save.disabled = true;
    var renaming = projectFormMode === "rename";
    var req = renaming ? A.call("/griot/my-projects/rename", { slug: currentProject, name: name })
      : A.call("/griot/my-projects", { name: name });
    req.then(function (r) {
      var p = r.project;
      if (renaming) {
        projects.list.forEach(function (x) { if (x.slug === p.slug) x.name = p.name; });
        renderProjects();
        closeProjectUi();
        renderViewTitle();
        notice({ text: "Renamed to “" + p.name + "”." });
        return;
      }
      projects.list.push(p);
      switchProject(p.slug);
    }, function (e) {
      if (e.status === 401) { signedOut(e.message); return; }
      showError($("gaProjectError"), e.message);
    }).then(function () { save.disabled = false; });
  });

  $("gaProjectDeleteYes").addEventListener("click", function () {
    var slug = currentProject;
    var name = projectName(slug);
    var yes = $("gaProjectDeleteYes");
    yes.disabled = true;
    A.call("/griot/my-projects/delete", { slug: slug }).then(function () {
      SP.storageSet(threadKey(), null);
      projects.list = projects.list.filter(function (x) { return x.slug !== slug; });
      switchProject("global");
      notice({ text: "“" + name + "” is deleted, with its conversations, memories and decisions." });
    }, function (e) {
      if (e.status === 401) { signedOut(e.message); return; }
      $("gaProjectConfirm").hidden = true;
      showError($("gaProjectError"), e.message);
    }).then(function () { yes.disabled = false; });
  });

  // ?project=… for a list, once GRIOT keeps projects.
  function withProject(path) {
    if (!projects.ready) return path;
    return path + (path.indexOf("?") === -1 ? "?" : "&") + "project=" + encodeURIComponent(currentProject);
  }

  /* ----------------------------------------------------------------- views */

  var TABS = ["ask", "conversations", "memory", "decisions", "documents"];
  function currentTab() {
    for (var i = 0; i < TABS.length; i++) if (!$("gaPanel-" + TABS[i]).hidden) return TABS[i];
    return "ask";
  }

  function renderViewTitle() {
    var t = currentTab();
    var inProject = projects.ready ? " in " + projectName(currentProject) : "";
    var copy = {
      ask: ["What are we solving?", projects.ready && currentProject !== "global"
        ? projectName(currentProject) + ". Give GRIOT the situation; it will route the right specialists."
        : "Give GRIOT the situation. It will route the right specialists."],
      conversations: ["Conversations", "Your conversations" + inProject + ". Pick one up where you left it."],
      memory: ["What GRIOT remembers", "GRIOT reads these before every answer" + inProject + ". It adds what it learns; you can add facts, or delete anything."],
      decisions: ["Decisions", "Every question you bring" + inProject + " is logged with GRIOT's recommendation, so you can see what was decided and why."],
      documents: ["Documents", "Files GRIOT has read, shared across your projects. Switch one off to leave it out of answers."]
    }[t];
    $("gaViewTitle").textContent = copy[0];
    $("gaViewSub").textContent = copy[1];
    $("gaThreadLabel").hidden = t !== "ask";
  }

  function openTab(name, focus) {
    TABS.forEach(function (t) {
      var on = t === name;
      var tab = $("gaTab-" + t);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $("gaPanel-" + t).hidden = !on;
      if (on && focus) tab.focus();
    });
    renderViewTitle();
    setDrawer(false);
    if (name === "conversations") loadConversations();
    if (name === "memory") loadMemory();
    if (name === "decisions") loadDecisions();
    if (name === "documents") loadDocuments();
  }
  TABS.forEach(function (t, i) {
    $("gaTab-" + t).addEventListener("click", function () { openTab(t); });
    $("gaTab-" + t).addEventListener("keydown", function (e) {
      var d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
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
  function loading(emptyId, listId) {
    $(listId).textContent = "";
    $(emptyId).textContent = "Loading…";
    $(emptyId).hidden = false;
  }

  function loadConversations() {
    loading("gaConvEmpty", "gaConvList");
    A.call(withProject("/griot/threads")).then(function (data) {
      var threads = data.threads || [];
      listState("gaConvEmpty", "gaConvList", threads, "No conversations" + (projects.ready ? " in " + projectName(currentProject) : "") +
        " yet. Ask GRIOT something and it appears here.");
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

  function openThread(id) {
    A.call("/griot/thread?id=" + encodeURIComponent(id)).then(function (data) {
      openTab("ask");
      clearLog();
      (data.messages || []).forEach(function (m) { addMessage(m.role === "user" ? "user" : "griot", m.content); });
      setThread(id);
      if (wide()) $("ga-message").focus({ preventScroll: true });
    }, function (e) { showError($("gaChatError"), e.message); openTab("ask"); });
  }

  function loadMemory() {
    loading("gaMemEmpty", "gaMemList");
    A.call(withProject("/griot/memories")).then(function (data) {
      // What you told GRIOT at sign-up comes first: it is in every answer.
      var memories = (data.memories || []).map(function (m, i) { return [m.kind === "profile" ? 0 : 1, i, m]; })
        .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (x) { return x[2]; });
      listState("gaMemEmpty", "gaMemList", memories, "Nothing yet. GRIOT remembers what matters from your conversations, or add a fact above.");
      memories.forEach(function (m) {
        var fromProfile = m.kind === "profile";
        var li = el("li", "ga-item" + (fromProfile ? " ga-item--profile" : ""));
        var head = el("div", "ga-item-head");
        var title = el("strong");
        var conf = String(m.confidence || "").toUpperCase();
        if (/^(FACT|INFERENCE|HYPOTHESIS|RECOMMENDATION|UNKNOWN)$/.test(conf)) {
          title.appendChild(el("span", "griot-label griot-label--" + conf.toLowerCase(), conf));
        }
        title.appendChild(document.createTextNode(m.title));
        head.appendChild(title);
        if (fromProfile) head.appendChild(el("span", "ga-from-profile", "From your profile"));
        li.appendChild(head);
        li.appendChild(el("p", "ga-item-text", m.content));
        var foot = el("div", "ga-item-foot");
        foot.appendChild(el("span", "ga-item-meta", when(m.at)));
        if (fromProfile) {
          // Changed or removed with the profile itself, so the two never disagree.
          var edit = el("a", "ga-link", "Change it in your profile");
          edit.href = "welcome.html?edit=1&next=griot-app.html";
          foot.appendChild(edit);
        } else {
          var del = el("button", "ga-link ga-forget", "Forget this");
          del.type = "button";
          del.addEventListener("click", function () {
            if (!window.confirm("GRIOT will forget “" + m.title + "”. This cannot be undone.")) return;
            A.call("/griot/memories/delete", { id: m.id }).then(loadMemory, function (e) { listError("gaMemEmpty", e); });
          });
          foot.appendChild(del);
        }
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
    var body = { title: title, content: content };
    if (projects.ready) body.project = currentProject;
    A.call("/griot/memory", body).then(function () {
      $("ga-mem-title").value = "";
      $("ga-mem-content").value = "";
      loadMemory();
    }, function (e) { showError(err, e.message); }).then(function () { $("gaMemAdd").disabled = false; });
  });

  function loadDecisions() {
    loading("gaDecEmpty", "gaDecList");
    A.call(withProject("/griot/decisions")).then(function (data) {
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

  /* ------------------------------------------------------------ documents */

  var DOC_MAX = 10 * 1024 * 1024;
  var docState = { used: 0, limit: 1 };

  function docMeta(d) {
    var parts = [d.kind];
    if (d.pages) parts.push(d.pages + (d.pages === 1 ? " page" : " pages"));
    parts.push(d.facts + (d.facts === 1 ? " key fact" : " key facts"));
    parts.push("added " + new Date(d.at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
    return parts.join(" · ");
  }

  function drawDocDetail(host, d) {
    host.textContent = "";
    host.appendChild(el("p", "ga-doc-brief", d.brief));
    var list = el("ul", "ga-doc-facts");
    d.facts.forEach(function (f) {
      var li = el("li", null, f.text);
      if (f.page) li.appendChild(el("span", "ga-doc-page", "p. " + f.page));
      list.appendChild(li);
    });
    host.appendChild(list);
    if (d.truncated) host.appendChild(el("p", "builder-note", "This is a long document: GRIOT read the first part of it."));
  }

  // `said`: what just happened (a document read), shown ahead of any note
  // about the allowance, so a refresh never hides it.
  function loadDocuments(said) {
    said = typeof said === "string" ? said : "";
    $("gaDocEmpty").textContent = "Loading…";
    $("gaDocEmpty").hidden = false;
    A.call("/griot/documents").then(function (data) {
      var docs = data.documents || [];
      docState = { used: data.used || 0, limit: data.limit || 1 };
      var full = docState.used >= docState.limit;
      $("gaDocAllowance").textContent = docState.used + " of " + docState.limit + (docState.limit === 1 ? " document" : " documents") + " kept.";
      $("gaDocAdd").disabled = full || !data.canRead;
      $("ga-doc-file").disabled = full || !data.canRead;
      $("gaDocPlans").hidden = !full || docState.limit >= 50;
      var note = !data.canRead ? "Reading documents is being switched on."
        : full ? "That is as many as your " + (docState.limit === 1 ? "free account" : "plan") + " keeps. Remove one to add another" +
          (docState.limit < 50 ? ", or see the plans for more room." : ".")
        : !data.griotUses && docs.length ? "GRIOT will start drawing on these in its answers shortly." : "";
      showError($("gaDocStatus"), [said, note].filter(Boolean).join(" "));
      listState("gaDocEmpty", "gaDocList", docs, "No documents yet. Add one above and GRIOT will draw on it when it bears on your question.");
      docs.forEach(function (d) { $("gaDocList").appendChild(docItem(d)); });
    }, function (e) { listError("gaDocEmpty", e); });
  }

  function docItem(d) {
    var li = el("li", "ga-item ga-doc" + (d.enabled ? "" : " ga-doc--off"));
    var head = el("div", "ga-item-head");
    head.appendChild(el("strong", null, d.name));
    li.appendChild(head);
    li.appendChild(el("p", "ga-item-meta", docMeta(d)));
    var foot = el("div", "ga-item-foot");
    var sw = el("label", "ga-doc-switch");
    var box = el("input");
    box.type = "checkbox";
    box.checked = d.enabled;
    sw.appendChild(box);
    sw.appendChild(el("span", null, "GRIOT uses this"));
    box.addEventListener("change", function () {
      box.disabled = true;
      A.call("/griot/documents/toggle", { id: d.id, enabled: box.checked }).then(function (r) {
        d.enabled = r.document.enabled;
        li.classList.toggle("ga-doc--off", !d.enabled);
      }, function (e) { box.checked = !box.checked; showError($("gaDocStatus"), e.message); })
        .then(function () { box.disabled = false; });
    });
    foot.appendChild(sw);
    var detail = el("div", "ga-doc-detail");
    detail.hidden = true;
    var showBtn = el("button", "ga-link", "Show what GRIOT took from it");
    showBtn.type = "button";
    showBtn.setAttribute("aria-expanded", "false");
    showBtn.addEventListener("click", function () {
      var open = detail.hidden;
      detail.hidden = !open;
      showBtn.setAttribute("aria-expanded", String(open));
      showBtn.textContent = open ? "Hide" : "Show what GRIOT took from it";
      if (open && !detail.childNodes.length) {
        detail.appendChild(el("p", "output-empty", "Loading…"));
        A.call("/griot/document?id=" + encodeURIComponent(d.id)).then(function (r) { drawDocDetail(detail, r.document); },
          function (e) { detail.textContent = e.message; });
      }
    });
    foot.appendChild(showBtn);
    var del = el("button", "ga-link ga-forget", "Delete");
    del.type = "button";
    del.addEventListener("click", function () {
      if (!window.confirm("Delete “" + d.name + "”? GRIOT stops using it, and everything taken from it is removed.")) return;
      A.call("/griot/documents/delete", { id: d.id }).then(function () { loadDocuments("“" + d.name + "” is deleted."); },
        function (e) { showError($("gaDocStatus"), e.message); });
    });
    foot.appendChild(del);
    li.appendChild(foot);
    li.appendChild(detail);
    return li;
  }

  // While a document is being read: the same patient wait as GRIOT's steps.
  function readingState(name) {
    var host = $("gaDocReading");
    host.textContent = "";
    host.appendChild(el("p", null, "GRIOT is reading “" + name + "”. This takes up to a minute; you can keep this tab open and wait."));
    host.hidden = false;
    return function () { host.hidden = true; host.textContent = ""; };
  }

  $("gaDocForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var err = $("gaDocError");
    showError(err, "");
    showError($("gaDocStatus"), "");
    var input = $("ga-doc-file");
    var file = input.files && input.files[0];
    if (!file) { showError(err, "Choose a file first."); input.focus(); return; }
    if (file.size > DOC_MAX) { showError(err, "A document can be up to 10 MB. Try a smaller copy or a PDF."); return; }
    $("gaDocAdd").disabled = true;
    input.disabled = true;
    var done = readingState(file.name);
    A.upload("/griot/documents?name=" + encodeURIComponent(file.name), file).then(function (r) {
      input.value = "";
      loadDocuments("GRIOT read “" + r.document.name + "” and kept " + r.document.facts.length +
        (r.document.facts.length === 1 ? " key fact." : " key facts."));
    }, function (e) {
      if (e.status === 401) { signedOut(e.message); return; }
      if (A.handleProfileRequired(e, "griot-app.html")) return;
      showError(err, e.message);
      $("gaDocAdd").disabled = false;
      input.disabled = false;
      if (e.code === "documents_full") loadDocuments();
    }).then(done);
  });

  // The + beside the modes: add a document without leaving the question.
  // Same upload, limits and messages as Documents; the document is switched
  // on, so the next question can use it.
  $("gaAttach").addEventListener("click", function () { $("gaAttachFile").click(); });
  $("gaAttachFile").addEventListener("change", function () {
    var input = $("gaAttachFile");
    var file = input.files && input.files[0];
    if (!file) return;
    var status = $("gaAttachStatus");
    function say(text, cls) {
      status.textContent = "";
      status.className = "ga-attach-status" + (cls ? " ga-attach-status--" + cls : "");
      status.appendChild(document.createTextNode(text));
      status.hidden = !text;
    }
    input.value = "";
    if (file.size > DOC_MAX) { say("“" + file.name + "” is over 10 MB. Try a smaller copy or a PDF.", "error"); return; }
    $("gaAttach").disabled = true;
    say("Reading “" + file.name + "”… This takes up to a minute.", "busy");
    A.upload("/griot/documents?name=" + encodeURIComponent(file.name), file).then(function (r) {
      var n = r.document.facts.length;
      say("“" + r.document.name + "” is ready: " + n + (n === 1 ? " key fact" : " key facts") +
        ". GRIOT can use it from your next question.", "ready");
      loadDocuments();
    }, function (e) {
      if (e.status === 401) { signedOut(e.message); return; }
      if (A.handleProfileRequired(e, "griot-app.html")) return;
      say(e.message, "error");
      if (e.code === "documents_full") {
        var plans = el("a", "ga-link", "See the plans");
        plans.href = "plans.html";
        status.appendChild(document.createTextNode(" "));
        status.appendChild(plans);
      }
    }).then(function () { $("gaAttach").disabled = false; });
  });

  /* ------------------------------------------------- the Ask view, start */

  var introAction = null;
  function renderIntroAction() {
    var item = $("gaEmpty");
    if (!item || !introAction || item.querySelector(".gx-open-thread")) return;
    if (!ws.ready) return;
    item.appendChild(introAction);
  }

  // The Ask view for the current project: a welcome from GRIOT, with the way
  // back into the last conversation when there is one.
  function startConversationView() {
    clearLog();
    renderViewTitle();
    renderThreadLabel();
    var thread = getThread();
    var name = typeof (account && account.greetName) === "string" ? account.greetName.trim() : "";
    var where = projects.ready ? " in " + projectName(currentProject) : "";
    introAction = null;
    if (thread) {
      introAction = el("button", "gx-open-thread", "Show the conversation");
      introAction.type = "button";
      introAction.addEventListener("click", function () { openThread(thread); });
      intro("Welcome back" + (name ? ", " + name : "") + ". We are continuing your conversation" + where +
        ". GRIOT remembers what you have already told it.");
      renderIntroAction();
      return;
    }
    if (projects.ready && currentProject !== "global") {
      intro("This is " + projectName(currentProject) + ". Its conversations, memory and decisions stay separate from your other projects. What are we solving here?");
      return;
    }
    intro("Start with the decision in front of you: pricing, positioning, a hire, a donor narrative. Give GRIOT the context once; it keeps it.");
  }

  $("gaNewBtn").addEventListener("click", function () {
    if (sending) return;
    setThread(null);
    openTab("ask");
    startConversationView();
    $("gaEmpty").querySelector(".griot-body").textContent = "A new conversation" +
      (projects.ready ? " in " + projectName(currentProject) : "") + ". GRIOT still remembers what it knows about you.";
    if (wide()) $("ga-message").focus({ preventScroll: true });
  });

  function describe(reply) {
    var parts = [];
    parts.push(reply.paidWith === "trial" ? "Free try" : "Included in your plan");
    if (reply.mode) parts.push("Mode: " + reply.mode.charAt(0).toUpperCase() + reply.mode.slice(1));
    if (reply.agents && reply.agents.length) {
      var lensNames = reply.agents.map(function (a) { return String(a).replace(/Agent$/, ""); });
      parts.push((lensNames.length > 1 ? "Lenses: " : "Lens: ") + lensNames.join(", "));
    }
    if (reply.memoryUsed) parts.push("drew on " + reply.memoryUsed + " thing" + (reply.memoryUsed === 1 ? "" : "s") + " it remembers");
    if (reply.memoryWritten) parts.push("now remembers: “" + reply.memoryWritten + "”");
    if (reply.documentsUsed && reply.documentsUsed.length) parts.push("drew on your documents: " + reply.documentsUsed.join(", "));
    return parts.join(" · ");
  }

  function startChat(next) {
    renderAccount(next);
    show("chat");
    $("gaSendBtn").disabled = false;
    startConversationView();
    if (cannotPay()) openTopup();
    else if (wide()) $("ga-message").focus({ preventScroll: true });
  }

  function signedOut(message) {
    account = null;
    show("signIn");
    $("gaTabs").hidden = true;
    $("gaNewBtn").hidden = true;
    $("gaAcct").hidden = true;
    $("gaDrawerAcct").hidden = true;
    $("gaProjectBlock").hidden = true;
    $("gaUsage").hidden = true;
    $("gaStatusLine").textContent = "Not signed in";
    $("gaBalance").textContent = "Your first 3 questions are free";
    projects = { ready: false, list: [], limit: 20 };
    currentProject = "global";
    openTab("ask");
    clearLog();
    renderThreadLabel();
    intro("I'm GRIOT, SpeakPower's strategy advisor. I diagnose before I recommend, label every claim so you can see what is fact and what is advice, and remember what we decide together. Sign in with Google and your first 3 questions are free.");
    A.mountSignIn(gates.signIn, {
      title: "Sign in to ask GRIOT",
      lead: (message ? message + " " : "") +
        "Your first 3 tries are free, shared with every Studio service. No password, no card, no API key.",
      onSignedIn: function (acct) {
        notice(null);
        // A new account first answers the two short welcome steps.
        if (A.requireAccount("griot-app.html")) return;
        startChat(acct);
        loadWorkspace();
      }
    });
  }

  function signOut() {
    closePops();
    setDrawer(false);
    A.signOut();
    signedOut("");
  }
  $("gaSignout").addEventListener("click", signOut);
  $("gaSignoutDrawer").addEventListener("click", signOut);

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
    closePops();
    var btn = $("gaSendBtn");
    btn.disabled = true;
    $("gaSendLabel").textContent = "GRIOT is thinking…";
    $("gaProject").disabled = true;
    var mine = addMessage("user", message, null, chosenMode ? "You · " + chosenMode.charAt(0).toUpperCase() + chosenMode.slice(1) : "You");
    box.value = "";
    var pending = thinking();

    var payload = { message: message, threadId: getThread(), anonId: SP.anonId, page: location.pathname };
    if (ws.ready && chosen.length) payload.lenses = chosen.slice();
    if (chosenMode) payload.mode = chosenMode;
    if (projects.ready) payload.project = currentProject;
    A.call("/griot/chat", payload).then(function (reply) {
      pending.stop();
      pending.item.remove();
      var answer = addMessage("griot", reply.answer, describe(reply));
      answer.classList.add("griot-msg--new");
      if (reply.memoryWritten && ws.ready) {
        var see = el("button", "ga-link ga-see-memory");
        see.type = "button";
        see.appendChild(icon("brain"));
        see.appendChild(document.createTextNode("See what GRIOT remembers"));
        see.addEventListener("click", function () { openTab("memory"); });
        (answer.querySelector(".gx-actions") || answer).appendChild(see);
        scrollLog();
      }
      setThread(reply.threadId);
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
      if (A.handleProfileRequired(e, "griot-app.html")) return;
      if (e.status === 402) {
        if (e.data && e.data.account) { A.setAccount(e.data.account); renderAccount(e.data.account); }
        openTopup(e.data);
        return;
      }
      if (e.code === "unknown_project") loadProjects();
      // Any other failure was refunded by the Worker.
      showError(err, e.message);
    }).then(function () {
      sending = false;
      $("gaSendLabel").textContent = "Ask GRIOT";
      $("gaProject").disabled = false;
      if (!cannotPay()) btn.disabled = false;
    });
  }

  /* ------------------------------------------------- popovers and drawer */

  var pops = [["gaLensBtn", "gaLenses"], ["gaAcctBtn", "gaAcctMenu"], ["gaLegendBtn", "gaLegend"]];
  function closePops(except) {
    pops.forEach(function (p) {
      if (p[1] === except) return;
      $(p[1]).hidden = true;
      $(p[0]).setAttribute("aria-expanded", "false");
    });
  }
  pops.forEach(function (p) {
    $(p[0]).addEventListener("click", function (e) {
      e.stopPropagation();
      var open = $(p[1]).hidden;
      closePops(p[1]);
      $(p[1]).hidden = !open;
      $(p[0]).setAttribute("aria-expanded", String(open));
    });
    $(p[1]).addEventListener("click", function (e) { e.stopPropagation(); });
  });
  document.addEventListener("click", function () { closePops(); });

  function setDrawer(open) {
    app.classList.toggle("is-drawer-open", open);
    $("gaMenuBtn").setAttribute("aria-expanded", String(open));
    if (open) $("gaMenuClose").focus();
  }
  $("gaMenuBtn").addEventListener("click", function () { setDrawer(true); });
  $("gaMenuClose").addEventListener("click", function () { setDrawer(false); $("gaMenuBtn").focus(); });
  $("gaScrim").addEventListener("click", function () { setDrawer(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var drawerOpen = app.classList.contains("is-drawer-open");
    closePops();
    closeProjectUi();
    if (drawerOpen) { setDrawer(false); $("gaMenuBtn").focus(); }
  });

  /* ---------------------------------------------------------------- start */

  function offline() {
    show("offline");
    $("gaStatusLine").textContent = "Coming soon";
    $("gaBalance").textContent = "GRIOT is being connected";
    clearLog();
    intro("I'm GRIOT, SpeakPower's strategy advisor. I diagnose before I recommend, label every claim, and remember what we decide together. Sign-up opens here shortly.");
  }

  renderModeChips();

  if (!SP || !A || !SP.connected || !A.signInAvailable()) { offline(); return; }

  // Signed out: GRIOT shows at once, with the sign-in in the composer's place.
  if (!A.session()) { signedOut(""); return; }

  // A new account first answers the two short welcome steps.
  if (A.requireAccount("griot-app.html")) return;

  // Show the conversation at once, then settle any returning payment and
  // confirm the session — in that order, so a stale balance never wins.
  startChat(A.account());
  loadWorkspace();
  A.settleReturn().then(function (result) {
    if (result) notice(result);
    return A.refresh();
  }).then(function (acct) {
    // The confirmed account may say a sign-up step is still to do.
    if (A.requireAccount("griot-app.html")) return;
    renderAccount(acct);
    if (cannotPay()) openTopup();
    else if (app.getAttribute("data-state") === "wall") { show("chat"); $("gaSendBtn").disabled = false; }
    else if (!sending) $("gaSendBtn").disabled = false;
  }, function (e) {
    if (e.status === 401) signedOut("");
    // Otherwise an offline blip: keep them in; sending will retry.
  });
})();
