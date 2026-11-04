/* ==========================================================================
   SpeakPower — history.html
   A member's history, by product: every use (All), GRIOT conversations,
   rehearsals, Ngoma edits, Studio packs, SEO audits and payments. Newest
   first, filtered by date, paged with "Load more", and downloadable as CSV.
   Packs and audits can be deleted here; everything opens where it was made.

   Security: every value goes in through textContent, never innerHTML; links
   come from the Worker and are checked to be one of our own pages.
   ========================================================================== */

(function () {
  "use strict";

  var A = window.SPAccount;
  var SP = window.SP;
  function $(id) { return document.getElementById(id); }

  var PAID = { trial: "Free try", plan: "Plan", balance: "Balance", admin: "Admin", "": "" };
  var NAMES = {
    griot: "GRIOT", rehearsal: "Rehearsal Room", video: "Ngoma", payment: "Payment", "seo-audit": "SEO audit",
    "brand-story": "Brand Story", "market-plan": "Market Plan", "content-seo": "SEO Content Starter",
    "data-story": "Data Story", "speaker-ready": "Speaker Ready Pack"
  };
  var NOTES = {
    video: "Ngoma edits your video on your own computer, so the videos themselves open only on the computer that made them. These are the details of each edit.",
    griot: "Your conversations with GRIOT. Open one to read it and carry on.",
    packs: "Every Studio pack you have made, kept until you delete it. Open one to read it or download it again as Word or PDF.",
    audits: "Finished audit reports are kept until you delete them.",
    all: "Every use of every product, newest first."
  };

  var state = { type: "all", items: [], next: null, loading: false };
  var tbody = $("hiTable").querySelector("tbody");

  function notice(text) {
    $("hiNotice").textContent = text || "";
    $("hiNotice").hidden = !text;
  }

  function day(value, endOfDay) {
    if (!value) return 0;
    var d = new Date(value + "T00:00:00");
    if (isNaN(d)) return 0;
    if (endOfDay) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  function when(at) {
    var d = new Date(at * 1000);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + " · " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function money(n, currency) {
    return (currency || "UGX") + " " + Number(n || 0).toLocaleString("en-US");
  }

  // Only our own pages: anything else is shown without a link.
  function safeLink(link) {
    return typeof link === "string" && /^(studio-product|griot-app|rehearse|video)\.html([?#][\w=&%.:-]*)?$/.test(link) ? link : null;
  }

  function paidText(item) {
    if (item.type === "payments") return money(item.amount, item.currency);
    var text = PAID[item.paidWith || ""] || item.paidWith || "";
    if (item.paidWith === "balance" && item.amount) text += " · " + money(item.amount);
    if (item.status === "refunded") text += (text ? " · " : "") + "not charged";
    return text;
  }

  function row(item) {
    var tr = document.createElement("tr");
    var cells = [when(item.at), item.title || NAMES[item.product] || item.product, item.summary || "", paidText(item)];
    cells.forEach(function (text, index) {
      var td = document.createElement("td");
      if (index === 1 && state.type === "all") {
        var tag = document.createElement("span");
        tag.className = "history-tag";
        tag.textContent = NAMES[item.product] || item.product;
        td.appendChild(tag);
        td.appendChild(document.createTextNode(" " + text));
      } else {
        td.textContent = text;
      }
      tr.appendChild(td);
    });
    var actions = document.createElement("td");
    actions.className = "history-actions";
    var link = safeLink(item.link);
    if (link) {
      var open = document.createElement("a");
      open.href = link;
      open.className = "history-open";
      open.textContent = "Open";
      actions.appendChild(open);
    }
    if (item.deletable && item.id) {
      var del = document.createElement("button");
      del.type = "button";
      del.className = "history-delete";
      del.textContent = "Delete";
      del.addEventListener("click", function () { remove(item, tr, del); });
      actions.appendChild(del);
    }
    tr.appendChild(actions);
    return tr;
  }

  function remove(item, tr, button) {
    var what = item.type === "packs" ? "this " + (item.title || "pack") : "this audit report";
    if (!window.confirm("Delete " + what + " from your history? It cannot be brought back.")) return;
    button.disabled = true;
    var path = item.type === "packs" ? "/packs/delete" : "/studio/audits/delete";
    A.call(path, { id: item.id }).then(function () {
      state.items = state.items.filter(function (x) { return x !== item; });
      tr.remove();
      showEmpty();
    }, function (e) {
      button.disabled = false;
      notice(e.message || "That could not be deleted. Try again.");
    });
  }

  function showEmpty() {
    var none = !state.items.length && !state.loading;
    $("hiEmpty").hidden = !none;
    $("hiTable").hidden = !state.items.length;
  }

  function load(append) {
    if (state.loading) return;
    state.loading = true;
    $("hiLoading").hidden = false;
    $("hiMore").hidden = true;
    var q = "type=" + state.type + "&limit=30";
    var from = day($("hiFrom").value);
    var to = day($("hiTo").value, true);
    if (from) q += "&from=" + from;
    if (to) q += "&to=" + to;
    if (append && state.next) q += "&before=" + encodeURIComponent(state.next);
    var type = state.type;
    A.call("/history?" + q).then(function (data) {
      if (type !== state.type) return; // the tab changed meanwhile
      if (!append) { state.items = []; tbody.textContent = ""; }
      (data.items || []).forEach(function (item) {
        state.items.push(item);
        tbody.appendChild(row(item));
      });
      state.next = data.next || null;
      $("hiMore").hidden = !state.next;
      var note = data.note || NOTES[type] || "";
      $("hiTabNote").textContent = note;
      $("hiTabNote").hidden = !note;
    }, function (e) {
      if (e.status === 401) { window.location.replace("account.html?next=history.html"); return; }
      notice(e.message || "Your history could not be loaded. Try again shortly.");
    }).then(function () {
      state.loading = false;
      $("hiLoading").hidden = true;
      showEmpty();
    });
  }

  // Tabs.
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".history-tabs [data-type]"));
  function choose(type) {
    state.type = type;
    state.next = null;
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.getAttribute("data-type") === type)); });
    try { history.replaceState(null, "", "history.html" + (type === "all" ? "" : "#" + type)); } catch (e) { /* fine */ }
    state.items = [];
    tbody.textContent = "";
    load(false);
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () { choose(t.getAttribute("data-type")); });
  });

  $("hiFilter").addEventListener("submit", function (event) {
    event.preventDefault();
    choose(state.type);
  });
  $("hiClear").addEventListener("click", function () {
    $("hiFrom").value = "";
    $("hiTo").value = "";
    choose(state.type);
  });
  $("hiMore").addEventListener("click", function () { load(true); });

  // CSV of what is shown.
  $("hiCsv").addEventListener("click", function () {
    var cell = function (v) {
      var s = String(v == null ? "" : v);
      if (/^[=+\-@]/.test(s)) s = "'" + s; // never a formula in a spreadsheet
      return '"' + s.replace(/"/g, '""') + '"';
    };
    var lines = [["Date", "Product", "What", "Details", "Paid with", "Amount (UGX)", "Status"].map(cell).join(",")];
    state.items.forEach(function (item) {
      lines.push([new Date(item.at * 1000).toISOString(), NAMES[item.product] || item.product, item.title || "", item.summary || "",
        PAID[item.paidWith || ""] || item.paidWith || "", item.amount || "", item.status || ""].map(cell).join(","));
    });
    var blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "speakpower-history-" + state.type + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  // Start: signed-in members only.
  if (!SP || !A || !SP.connected) {
    $("hiLoading").textContent = "Your history opens here once accounts are connected.";
    return;
  }
  if (!A.session()) {
    window.location.replace("account.html?next=history.html");
    return;
  }
  var first = (location.hash || "").slice(1);
  choose(tabs.some(function (t) { return t.getAttribute("data-type") === first; }) ? first : "all");
})();
