/*
 * SpeakPower keeps your work -- on every page.
 *
 *   1. The activity chip. Work that runs while you look elsewhere (a video
 *      edit, an answer being written, a pack being made) is listed in this
 *      browser and shown as a gold chip in the header of every page, with a
 *      link back to it. Other tabs see it change as it happens.
 *
 *   2. Drafts. Text typed into a product form ([data-draft="key"] on a field
 *      or a form) is kept as you type and put back when you return. It is
 *      cleared once the field is empty, e.g. after sending.
 *
 *   3. Moving around never stops the work. While this tab is doing work that
 *      only runs here (SPWork.guard(label)), a SpeakPower link opens its page
 *      inside this same tab, over the working page, with a bar on top showing
 *      the work and a way back to it. Back walks through the pages visited,
 *      then returns. Other sites open in a new tab; closing or reloading asks
 *      first.
 *
 * API (window.SPWork):
 *   set(id, { label, href, status, percent, detail })  status: running | paused | done | failed
 *   remove(id) · list() · onChange(fn)
 *   guard(label) -> release()
 *   watchDraft(element, key) · keepDraft(key, text) · clearDraft(key)
 *
 * Everything stays in this browser (localStorage); nothing is sent anywhere.
 */
(function () {
  "use strict";

  var WORK_KEY = "sp_work_v1";
  var DRAFT_PREFIX = "sp_draft:";
  var DRAFT_DAYS = 30;
  // A running item whose tab hasn't touched it for this long was closed: show it as paused.
  var STALE_MS = 20000;
  var KEEP_MS = { done: 24 * 3600e3, failed: 24 * 3600e3, paused: 30 * 24 * 3600e3, running: 30 * 24 * 3600e3 };

  var tabId = Math.random().toString(36).slice(2, 10);
  var listeners = [];

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  // --- The work list ------------------------------------------------------------------

  function items() {
    var all = read(WORK_KEY);
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  }

  /** Every item, newest first, with stale "running" ones shown as paused. */
  function list() {
    var now = Date.now();
    var all = items();
    return Object.keys(all).map(function (id) {
      var item = Object.assign({ id: id }, all[id]);
      if (item.status === "running" && item.tab !== tabId && now - (item.updatedAt || 0) > STALE_MS) {
        item.status = "paused";
      }
      return item;
    }).filter(function (item) {
      return now - (item.updatedAt || 0) < (KEEP_MS[item.status] || KEEP_MS.done);
    }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  var lastWrite = {};
  function set(id, patch) {
    if (!id) return;
    var all = items();
    var before = all[id] || {};
    var next = Object.assign({}, before, patch || {}, { updatedAt: Date.now() });
    if (next.status === "running") next.tab = tabId;
    if (typeof next.percent === "number") next.percent = Math.max(0, Math.min(100, Math.round(next.percent)));
    // Progress ticks are frequent: write at most twice a second unless something else changed.
    var progressOnly = before.status === next.status && before.label === next.label && before.detail === next.detail;
    if (progressOnly && before.percent !== undefined && Date.now() - (lastWrite[id] || 0) < 500 && next.percent !== 100) {
      return;
    }
    lastWrite[id] = Date.now();
    all[id] = next;
    write(WORK_KEY, all);
    changed();
  }

  function remove(id) {
    var all = items();
    if (!(id in all)) return;
    delete all[id];
    write(WORK_KEY, all);
    changed();
  }

  // Keep this tab's running items fresh during long, quiet steps.
  setInterval(function () {
    var all = items();
    var touched = false;
    Object.keys(all).forEach(function (id) {
      if (all[id].status === "running" && all[id].tab === tabId) { all[id].updatedAt = Date.now(); touched = true; }
    });
    if (touched) write(WORK_KEY, all);
  }, 5000);

  function onChange(fn) { listeners.push(fn); }
  function changed() {
    render();
    listeners.forEach(function (fn) { try { fn(list()); } catch (e) { /* a listener's own problem */ } });
  }
  window.addEventListener("storage", function (event) {
    if (event.key === WORK_KEY || event.key === null) changed();
  });

  // --- The chip -----------------------------------------------------------------------

  var STYLE = [
    ".spw-chip{display:inline-flex;align-items:center;gap:.45rem;margin-left:auto;margin-right:.6rem;padding:.38rem .8rem;border-radius:999px;",
    "border:1px solid #c9a227;background:rgba(201,162,39,.14);color:#f1d47a;font:600 .82rem/1.2 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;max-width:46vw}",
    ".spw-chip span{overflow:hidden;text-overflow:ellipsis}",
    ".spw-chip:hover,.spw-chip:focus-visible{background:rgba(201,162,39,.26);outline:none}",
    ".spw-dot{width:.55rem;height:.55rem;border-radius:50%;background:#f1d47a;flex:none}",
    ".spw-chip[data-state=running] .spw-dot{animation:spw-pulse 1.2s ease-in-out infinite}",
    ".spw-chip[data-state=done] .spw-dot{background:#5fcf8f}",
    ".spw-chip[data-state=failed] .spw-dot{background:#ff8a7a}",
    "@keyframes spw-pulse{50%{opacity:.25}}",
    "@media (prefers-reduced-motion:reduce){.spw-chip .spw-dot{animation:none!important}}",
    ".gx-topbar-meta .spw-chip{margin:0;color:#7a5a1c;background:#f6eedc}",
    // The header's own width belongs to the menu, so the chip floats just below it.
    ".site-header .spw-chip{position:fixed;top:calc(var(--header-h,72px) + 10px);right:12px;margin:0;z-index:99;max-width:calc(100vw - 24px);",
    "background:#16233f;box-shadow:0 10px 24px -12px rgba(0,0,0,.7)}.site-header .spw-chip:hover{background:#1e2d4f}",
    ".spw-panel{position:fixed;z-index:1000;top:calc(var(--header-h,72px) + 3.4rem);right:1rem;width:min(22rem,calc(100vw - 2rem));max-height:70vh;overflow:auto;",
    "background:#fff;color:#1f2937;border:1px solid #e2ded6;border-radius:12px;box-shadow:0 18px 40px -18px rgba(0,0,0,.45);padding:.5rem;font:400 .9rem/1.4 Inter,system-ui,sans-serif}",
    ".spw-panel h2{font:600 .8rem/1.2 Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:.4rem .5rem .5rem}",
    ".spw-row{display:flex;align-items:flex-start;gap:.5rem;padding:.55rem .5rem;border-radius:8px}",
    ".spw-row:hover{background:#f7f6f3}",
    ".spw-row a{flex:1;color:inherit;text-decoration:none;min-width:0}",
    ".spw-row strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".spw-row small{color:#6b7280}",
    ".spw-bar{height:4px;border-radius:2px;background:#eee;margin-top:.35rem;overflow:hidden}",
    ".spw-bar i{display:block;height:100%;background:#c9a227}",
    ".spw-x{border:0;background:none;color:#6b7280;cursor:pointer;font-size:1.1rem;line-height:1;padding:.1rem .3rem}",
    ".spw-view{position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;background:#0a1020}",
    ".spw-bar-top{display:flex;align-items:center;gap:.6rem;min-height:44px;padding:.35rem .6rem .35rem 1rem;background:#16233f;color:#f1d47a;",
    "border-bottom:2px solid #c9a227;font:600 .9rem/1.3 Inter,system-ui,sans-serif}",
    ".spw-bar-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".spw-view[data-state=running] .spw-dot{animation:spw-pulse 1.2s ease-in-out infinite}",
    ".spw-view[data-state=done] .spw-dot{background:#5fcf8f}",
    ".spw-bar-back{flex:none;border:0;border-radius:999px;padding:.45rem .95rem;background:#c9a227;color:#0a1020;font:700 .85rem/1 Inter,system-ui,sans-serif;cursor:pointer}",
    ".spw-bar-back:hover,.spw-bar-back:focus-visible{background:#f1d47a;outline:none}",
    ".spw-frame{flex:1;width:100%;border:0;background:#fff}",
    "html.spw-viewing,html.spw-viewing body{overflow:hidden}",
    ".spw-toast{position:fixed;z-index:1001;left:50%;bottom:1.2rem;transform:translateX(-50%);max-width:calc(100vw - 2rem);",
    "background:#16233f;color:#fff;padding:.7rem 1rem;border-radius:10px;font:500 .9rem/1.35 Inter,system-ui,sans-serif;box-shadow:0 12px 30px -12px rgba(0,0,0,.6)}"
  ].join("");

  var chip = null;
  var panel = null;

  function statusText(item) {
    if (item.status === "running") return (item.detail || "Working") + (typeof item.percent === "number" ? " · " + item.percent + "%" : "");
    if (item.status === "paused") return item.detail || "Paused: open it to carry on";
    if (item.status === "failed") return item.detail || "Stopped: open it to see why";
    return item.detail || "Ready";
  }

  function chipText(all) {
    var running = all.filter(function (item) { return item.status === "running"; });
    if (all.length === 1) {
      var only = all[0];
      if (only.status === "running") return only.label + (typeof only.percent === "number" ? " " + only.percent + "%" : "…");
      if (only.status === "done") return only.label + " ✓";
      if (only.status === "paused") return only.label + " · paused";
      return only.label + " · stopped";
    }
    if (running.length) return running.length + " working · " + (all.length - running.length) + " more";
    return all.length + " things ready";
  }

  var styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function ensureChip() {
    if (chip) return chip;
    ensureStyle();
    chip = document.createElement("button");
    chip.type = "button";
    chip.className = "spw-chip";
    chip.hidden = true;
    chip.setAttribute("aria-haspopup", "true");
    chip.setAttribute("aria-expanded", "false");
    chip.innerHTML = '<i class="spw-dot" aria-hidden="true"></i><span></span>';
    chip.addEventListener("click", togglePanel);
    var griotBar = document.querySelector(".gx-topbar-meta");
    var header = document.querySelector(".site-header .wrap");
    if (griotBar) griotBar.insertBefore(chip, griotBar.firstChild);
    else if (header) header.insertBefore(chip, header.querySelector(".nav-toggle"));
    else {
      chip.style.cssText = "position:fixed;right:1rem;bottom:1rem;z-index:999;background:#16233f";
      document.body.appendChild(chip);
    }
    return chip;
  }

  function render() {
    if (!document.body || framed) return;
    var all = list();
    if (!all.length && !chip) return;
    ensureChip();
    chip.hidden = !all.length;
    if (!all.length) { closePanel(); return; }
    var state = all.some(function (item) { return item.status === "running"; }) ? "running"
      : all.some(function (item) { return item.status === "failed"; }) ? "failed"
      : all.every(function (item) { return item.status === "done"; }) ? "done" : "paused";
    chip.dataset.state = state;
    chip.querySelector("span").textContent = chipText(all);
    chip.title = "Your work: " + all.map(function (item) { return item.label + " (" + statusText(item) + ")"; }).join("; ");
    if (panel) fillPanel(all);
  }

  function fillPanel(all) {
    panel.innerHTML = "";
    var heading = document.createElement("h2");
    heading.textContent = "Your work";
    panel.appendChild(heading);
    all.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "spw-row";
      var link = document.createElement("a");
      link.href = item.href || "#";
      var name = document.createElement("strong");
      name.textContent = item.label;
      var detail = document.createElement("small");
      detail.textContent = statusText(item);
      link.appendChild(name);
      link.appendChild(detail);
      if (item.status === "running" && typeof item.percent === "number") {
        var bar = document.createElement("div");
        bar.className = "spw-bar";
        var fill = document.createElement("i");
        fill.style.width = item.percent + "%";
        bar.appendChild(fill);
        link.appendChild(bar);
      }
      row.appendChild(link);
      if (item.status !== "running") {
        var dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "spw-x";
        dismiss.setAttribute("aria-label", "Remove " + item.label + " from this list");
        dismiss.textContent = "×";
        dismiss.addEventListener("click", function () { remove(item.id); });
        row.appendChild(dismiss);
      }
      panel.appendChild(row);
    });
  }

  function togglePanel() {
    if (panel) { closePanel(); return; }
    panel = document.createElement("div");
    panel.className = "spw-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Your work");
    document.body.appendChild(panel);
    chip.setAttribute("aria-expanded", "true");
    fillPanel(list());
    setTimeout(function () { document.addEventListener("click", outside, true); }, 0);
  }
  function outside(event) {
    if (panel && !panel.contains(event.target) && event.target !== chip && !chip.contains(event.target)) closePanel();
  }
  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    if (chip) chip.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
  }
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") closePanel(); });

  // --- Leaving safely, and moving around in the same tab ----------------------------

  var guards = [];          // what is running in this tab: { label }
  var framed = null;        // inside the in-app view: the parent's SPWorkView
  try { if (window.top !== window && window.parent.SPWorkView) framed = window.parent.SPWorkView; } catch (e) { framed = null; }

  function toast(message) {
    var note = document.createElement("div");
    note.className = "spw-toast";
    note.setAttribute("role", "status");
    note.textContent = message;
    ensureStyle();
    document.body.appendChild(note);
    setTimeout(function () { note.remove(); }, 4500);
  }

  /** Mark work running in this tab. label: what the in-app view's bar says ("GRIOT is answering…"). */
  function guard(label) {
    var entry = { label: label || "" };
    guards.push(entry);
    updateBar();
    var released = false;
    return function release() {
      if (released) return;
      released = true;
      guards = guards.filter(function (item) { return item !== entry; });
      updateBar();
    };
  }

  window.addEventListener("beforeunload", function (event) {
    if (!guards.length) return;
    event.preventDefault();
    event.returnValue = "";
  });

  function linkFrom(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    var link = event.target.closest && event.target.closest("a[href]");
    if (!link || link.hasAttribute("download")) return null;
    if (link.target && link.target !== "_self") return null;
    var url;
    try { url = new URL(link.href, location.href); } catch (e) { return null; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  }
  var samePage = function (url, base) { return url.pathname === base.pathname && url.search === base.search; };

  /*
   * The in-app view. While work runs in this tab, a SpeakPower link opens its
   * page inside this same tab, over the working page, which stays loaded and
   * keeps going underneath. A bar on top shows the work and leads back to it.
   * Each page visited is a step in this tab's history, so Back walks back
   * through them and then closes the view.
   */
  var view = null;          // { root, frame, bar, text, back, opener }

  function workLine() {
    var mine = list().filter(function (item) { return item.tab === tabId; });
    var running = mine.filter(function (item) { return item.status === "running"; })[0];
    if (running) return { text: running.label + (typeof running.percent === "number" ? " · " + running.percent + "%" : "…"), state: "running" };
    var labelled = guards.filter(function (entry) { return entry.label; }).pop();
    if (labelled) return { text: labelled.label, state: "running" };
    if (guards.length) return { text: "Your work is still going", state: "running" };
    var done = mine.filter(function (item) { return item.status === "done"; })[0];
    if (done) return { text: (done.detail || done.label + " is ready") + " ✓", state: "done" };
    return { text: "Your work is finished", state: "done" };
  }

  function updateBar() {
    if (!view) return;
    var line = workLine();
    view.text.textContent = line.text;
    view.root.dataset.state = line.state;
    view.back.textContent = line.state === "done" ? "See it" : "Back to your work";
  }

  function openView(url, restoring) {
    ensureStyle();
    if (!view) {
      var root = document.createElement("div");
      root.className = "spw-view";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "SpeakPower page, opened in this tab");
      var bar = document.createElement("div");
      bar.className = "spw-bar-top";
      var dot = document.createElement("i");
      dot.className = "spw-dot";
      dot.setAttribute("aria-hidden", "true");
      var text = document.createElement("span");
      text.className = "spw-bar-text";
      text.setAttribute("aria-live", "polite");
      var back = document.createElement("button");
      back.type = "button";
      back.className = "spw-bar-back";
      back.addEventListener("click", closeView);
      bar.appendChild(dot);
      bar.appendChild(text);
      bar.appendChild(back);
      var frame = document.createElement("iframe");
      frame.className = "spw-frame";
      frame.title = "SpeakPower";
      root.appendChild(bar);
      root.appendChild(frame);
      document.body.appendChild(root);
      document.documentElement.classList.add("spw-viewing");
      view = { root: root, frame: frame, bar: bar, text: text, back: back, opener: document.activeElement, depth: 0 };
      updateBar();
    }
    if (restoring) view.depth = restoring;
    else {
      view.depth += 1;
      history.pushState({ spwView: view.depth, url: url }, "", location.href);
    }
    show(url);
  }

  function show(url) {
    var frame = view.frame;
    var current = null;
    try { current = frame.contentWindow && frame.contentWindow.location.href; } catch (e) { current = null; }
    if (current === url) return;
    // Replace inside the frame: the steps live in this tab's history (pushState) instead.
    if (current && current !== "about:blank") frame.contentWindow.location.replace(url);
    else frame.src = url;
    frame.focus();
  }

  function closeView() {
    if (!view) return;
    var depth = history.state && history.state.spwView;
    if (depth) history.go(-depth); // popstate below removes the view
    else removeView();
  }

  function removeView() {
    if (!view) return;
    var opener = view.opener;
    view.root.remove();
    view = null;
    document.documentElement.classList.remove("spw-viewing");
    if (opener && opener.focus) opener.focus();
  }

  window.addEventListener("popstate", function (event) {
    var state = event.state;
    if (state && state.spwView && state.url) {
      if (!view) { openView(state.url, state.spwView); return; } // Forward after closing: open it again
      view.depth = state.spwView;
      show(state.url);
    } else if (view) {
      removeView();
    }
  });

  onChange(updateBar);

  // Exposed to the pages shown inside the view.
  window.SPWorkView = {
    navigate: function (url) { openView(url); },
    close: closeView,
    page: function () { return { pathname: location.pathname, search: location.search }; },
  };

  document.addEventListener("click", function (event) {
    var url = linkFrom(event);
    if (!url) return;
    var external = url.origin !== location.origin;

    // Inside the view: every SpeakPower link stays in the view; the working page closes it.
    if (framed) {
      if (external || samePage(url, location)) return; // other sites, and links within this page, behave as usual
      event.preventDefault();
      var home = framed.page();
      if (url.pathname === home.pathname && url.search === home.search) framed.close();
      else framed.navigate(url.href);
      return;
    }

    if (!guards.length) return;
    if (external) {
      // Other sites (the blog, checkout, sign-in) can't be shown inside a page: a new tab keeps the work going.
      event.preventDefault();
      window.open(url.href, "_blank", "noopener");
      toast("Opened in a new tab so your work here keeps going.");
      return;
    }
    if (samePage(url, location)) return; // a link within this page
    event.preventDefault();
    openView(url.href);
  });

  // --- Drafts -------------------------------------------------------------------------

  function draftFields(element) {
    if (element.tagName === "FORM") {
      return Array.prototype.filter.call(element.elements, function (field) {
        return field.name && !/^(password|file|hidden|submit|button|reset)$/.test(field.type || "");
      });
    }
    return [element];
  }

  function draftValue(element) {
    var value = {};
    var any = false;
    draftFields(element).forEach(function (field) {
      var key = field.name || "value";
      if (field.type === "checkbox" || field.type === "radio") {
        if (field.checked) { value[key] = field.type === "radio" ? field.value : true; }
        return;
      }
      if (field.value && field.value.trim()) { value[key] = field.value; any = true; }
    });
    return any ? value : null;
  }

  // A sent message still waiting for its answer: kept even though the box is now empty.
  var pinned = {};

  function saveDraft(element, key) {
    if (pinned[key]) return;
    var value = draftValue(element);
    write(DRAFT_PREFIX + key, value ? { v: value, at: Date.now() } : null);
  }

  function restoreDraft(element, key) {
    var saved = read(DRAFT_PREFIX + key);
    if (!saved || !saved.v) return false;
    if (Date.now() - (saved.at || 0) > DRAFT_DAYS * 864e5) { write(DRAFT_PREFIX + key, null); return false; }
    if (draftValue(element)) return false; // the page already has text: keep it
    var restored = false;
    draftFields(element).forEach(function (field) {
      var key2 = field.name || "value";
      if (!(key2 in saved.v)) return;
      if (field.type === "checkbox") field.checked = Boolean(saved.v[key2]);
      else if (field.type === "radio") field.checked = field.value === saved.v[key2];
      else field.value = saved.v[key2];
      restored = true;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return restored;
  }

  var watched = [];
  function watchDraft(element, key) {
    if (!element || !key || element.__spDraft) return;
    element.__spDraft = key;
    watched.push({ element: element, key: key });
    if (restoreDraft(element, key)) {
      element.setAttribute("data-draft-restored", "");
      var hint = element.getAttribute("data-draft-note");
      if (hint !== "off") toast("Your unsent text is back, just as you left it.");
    }
    var timer = null;
    var save = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { saveDraft(element, key); }, 300);
    };
    element.addEventListener("input", save);
    element.addEventListener("change", save);
  }

  function clearDraft(key) {
    delete pinned[key];
    write(DRAFT_PREFIX + key, null);
  }

  /** Keep text that was sent but not yet answered; clearDraft(key) once it is. */
  function keepDraft(key, text) {
    pinned[key] = true;
    write(DRAFT_PREFIX + key, { v: { value: text }, at: Date.now() });
  }

  // Save on the way out too: this catches text cleared by the page after sending.
  function saveAll() { watched.forEach(function (entry) { if (document.contains(entry.element)) saveDraft(entry.element, entry.key); }); }
  window.addEventListener("pagehide", saveAll);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") saveAll(); });

  function scanDrafts(root) {
    var found = (root.querySelectorAll ? root.querySelectorAll("[data-draft]") : []);
    Array.prototype.forEach.call(found, function (element) { watchDraft(element, element.getAttribute("data-draft")); });
    if (root.hasAttribute && root.hasAttribute("data-draft")) watchDraft(root, root.getAttribute("data-draft"));
  }

  // Forms some pages build after loading are picked up as they appear.
  if (window.MutationObserver) {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        Array.prototype.forEach.call(mutation.addedNodes, function (node) { if (node.nodeType === 1) scanDrafts(node); });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Remove drafts nobody came back for.
  try {
    for (var index = localStorage.length - 1; index >= 0; index -= 1) {
      var name = localStorage.key(index);
      if (name && name.indexOf(DRAFT_PREFIX) === 0) {
        var saved = read(name);
        if (!saved || Date.now() - (saved.at || 0) > DRAFT_DAYS * 864e5) localStorage.removeItem(name);
      }
    }
  } catch (e) { /* storage blocked */ }

  window.SPWork = {
    set: set,
    remove: remove,
    list: list,
    onChange: onChange,
    guard: guard,
    toast: toast,
    clearDraft: clearDraft,
    keepDraft: keepDraft,
    watchDraft: watchDraft,
    tabId: tabId
  };

  function start() {
    scanDrafts(document);
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
