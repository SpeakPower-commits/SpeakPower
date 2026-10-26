/* ==========================================================================
   SpeakPower — YouTube research (youtube.html)
   Three views over the Worker's YouTube engine: a topic's current and
   evergreen rankings, channels compared, and specific videos checked. The
   Worker holds the YouTube key, meters the quota and works out every number;
   this file only asks and displays. Open to the accounts the Worker names
   in YOUTUBE_ADMINS; anyone else is told so.

   Needs script.js (window.SP) and account.js (window.SPAccount) first.
   Security: dynamic text goes through textContent, never innerHTML.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  if (!SP || !A) return;

  var $ = function (id) { return document.getElementById(id); };
  var COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  var WHOLE = new Intl.NumberFormat("en-UG");
  var DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
  var last = { topic: null, channels: null, videos: null };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function count(v, missing) { return v === null || v === undefined ? (missing || "—") : COMPACT.format(v); }
  function pct(v) { return v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%"; }
  function age(days) {
    if (days < 1) return "today";
    if (days < 60) return Math.round(days) + " d ago";
    if (days < 730) return Math.round(days / 30.4) + " mo ago";
    return (days / 365.25).toFixed(1) + " y ago";
  }
  function minutes(s) {
    if (s === null || s === undefined) return "";
    return s < 60 ? s + " s" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function setStatus(id, text, state) {
    var box = $(id);
    box.textContent = text || "";
    if (state) box.setAttribute("data-state", state); else box.removeAttribute("data-state");
  }

  function notice(text) {
    $("ytNotice").textContent = text || "";
    $("ytNotice").hidden = !text;
  }

  /* --------------------------------------------------------------- quota */

  function renderQuota(q, spent) {
    var host = $("ytQuota");
    host.textContent = "";
    if (!q) return;
    var line = el("p", "yt-quota-line");
    line.appendChild(el("strong", null, "Today's quota: "));
    line.appendChild(document.createTextNode(
      WHOLE.format(q.mine) + " of your " + WHOLE.format(q.myBudget) + " units used · " +
      WHOLE.format(q.used) + " of " + WHOLE.format(q.budget) + " for everyone. Resets at " + q.resets + "."));
    host.appendChild(line);
    var bar = el("div", "yt-bar");
    var fill = el("span");
    fill.style.width = Math.min(100, (q.mine / Math.max(q.myBudget, 1)) * 100).toFixed(1) + "%";
    bar.appendChild(fill);
    host.appendChild(bar);
    if (spent !== undefined) {
      host.appendChild(el("p", "builder-note", spent > 0
        ? "That cost " + WHOLE.format(spent) + " units."
        : "Answered from saved data — no quota used."));
    }
  }

  function renderMethod(method) {
    if (!method) return;
    var dl = $("ytMethod");
    dl.textContent = "";
    var labels = { note: "What is whose", baseline: "Against the channel", youngVideos: "Young videos",
      engagement: "Engagement", score: "Signal score", timing: "Timing" };
    Object.keys(labels).forEach(function (k) {
      if (!method[k]) return;
      dl.appendChild(el("dt", null, labels[k]));
      dl.appendChild(el("dd", null, method[k]));
    });
  }

  /* -------------------------------------------------------------- tables */

  function link(text, href) {
    var a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function table(headers) {
    var t = el("table", "account-table yt-table");
    var tr = el("tr");
    headers.forEach(function (h) { var th = el("th", null, h); th.scope = "col"; tr.appendChild(th); });
    var thead = el("thead");
    thead.appendChild(tr);
    t.appendChild(thead);
    t.appendChild(el("tbody"));
    return t;
  }

  function cells(tr, values) {
    values.forEach(function (v) {
      // The title or channel cell wraps; numbers never split across lines.
      var td = el("td", v instanceof Node && v.classList.contains("yt-video") ? "yt-main" : null);
      if (v instanceof Node) td.appendChild(v); else td.textContent = v === null || v === undefined ? "—" : String(v);
      tr.appendChild(td);
    });
  }

  // Why a video ranked, in words a client can read.
  function why(v) {
    var parts = [];
    if (v.baseline && v.baseline.multiple !== null) {
      parts.push(v.baseline.multiple + "× channel median (vs " + v.baseline.uploadsCompared + " uploads, z " + v.baseline.z + ")");
    } else {
      parts.push("no channel baseline yet");
    }
    if (v.growth) parts.push(COMPACT.format(v.growth.viewsPerDay) + " views/day now");
    else if (v.viewsPerDay !== null) parts.push(COMPACT.format(v.viewsPerDay) + " views/day on average");
    if (v.engagementRate !== null) parts.push(pct(v.engagementRate) + " engagement");
    return parts.join("; ");
  }

  function videoTable(host, list, emptyText) {
    host.textContent = "";
    if (!list.length) { host.appendChild(el("p", "output-empty", emptyText)); return; }
    var t = table(["#", "Video", "Published", "Views", "Likes · comments", "× channel", "Signal /60", "Confidence"]);
    var body = t.tBodies[0];
    list.forEach(function (v, i) {
      var tr = el("tr");
      var video = el("div", "yt-video");
      video.appendChild(link(v.title, v.url));
      video.appendChild(el("span", "yt-sub", v.channelTitle + (v.durationSeconds !== null ? " · " + minutes(v.durationSeconds) : "") +
        (v.format === "short-form" ? " · short-form" : "")));
      video.appendChild(el("span", "yt-why", why(v)));
      var signal = el("div");
      signal.appendChild(el("strong", null, v.signal.total));
      signal.appendChild(el("span", "yt-sub", "P " + v.signal.performance + " · T " + v.signal.timing + " · E " + v.signal.engagement));
      var mult = v.baseline && v.baseline.multiple !== null ? v.baseline.multiple + "×" : "—";
      var published = el("div");
      published.appendChild(document.createTextNode(DAY.format(new Date(v.publishedAt))));
      published.appendChild(el("span", "yt-sub", age(v.ageDays)));
      cells(tr, [i + 1, video, published, count(v.views),
        count(v.likes, "hidden") + " · " + count(v.comments, "off"), mult, signal, v.confidence]);
      tr.lastChild.className = "yt-conf yt-conf-" + v.confidence.toLowerCase();
      body.appendChild(tr);
    });
    host.appendChild(t);
  }

  function channelTable(host, list) {
    host.textContent = "";
    if (!list.length) { host.appendChild(el("p", "output-empty", "No channels to show.")); return; }
    var t = table(["Channel", "Subscribers", "Typical views (recent)", "Views per subscriber", "Uploads / week",
      "Engagement", "Best recent", "Short-form"]);
    var body = t.tBodies[0];
    list.forEach(function (c) {
      var tr = el("tr");
      var name = el("div", "yt-video");
      name.appendChild(link(c.title, c.url));
      name.appendChild(el("span", "yt-sub", [c.handle, c.country].filter(Boolean).join(" · ") +
        " · " + c.recent.uploadsCompared + " recent uploads compared"));
      cells(tr, [name, count(c.subscribers, "hidden"), count(c.recent.medianViews),
        c.viewsPerSubscriber === null ? "—" : c.viewsPerSubscriber.toFixed(2),
        c.recent.uploadsPerWeek === null ? "—" : c.recent.uploadsPerWeek,
        pct(c.recent.medianEngagement),
        c.recent.topMultiple === null ? "—" : c.recent.topMultiple + "× typical",
        c.recent.shortFormShare === null ? "—" : Math.round(c.recent.shortFormShare * 100) + "%"]);
      body.appendChild(tr);
    });
    host.appendChild(t);
  }

  /* ------------------------------------------------------- export, copy */

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    // A leading = + - @ would be run as a formula by a spreadsheet.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(name, rows) {
    var text = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    var a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function slug(s) { return String(s || "youtube").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "youtube"; }

  var VIDEO_HEAD = ["ranking", "rank", "title", "url", "channel", "published", "age_days", "duration_s", "format", "views", "likes",
    "comments", "views_per_day", "engagement_rate", "channel_median_views", "x_channel_median", "z", "uploads_compared",
    "growth_views_per_day", "signal_total_60", "performance_25", "timing_20", "engagement_15", "confidence", "checked_at"];
  function videoRow(kind, v, i) {
    var b = v.baseline || {};
    return [kind, i + 1, v.title, v.url, v.channelTitle, v.publishedAt, v.ageDays, v.durationSeconds, v.format, v.views, v.likes,
      v.comments, v.viewsPerDay, v.engagementRate, b.channelMedianViews, b.multiple, b.z, b.uploadsCompared,
      v.growth ? v.growth.viewsPerDay : null, v.signal.total, v.signal.performance, v.signal.timing, v.signal.engagement,
      v.confidence, v.fetchedAt];
  }
  var CHANNEL_HEAD = ["title", "url", "handle", "country", "subscribers", "videos", "total_views", "uploads_compared",
    "median_views_recent", "views_per_subscriber", "uploads_per_week", "median_engagement", "best_recent_x_typical",
    "short_form_share", "median_minutes", "checked_at"];
  function channelRow(c) {
    var r = c.recent;
    return [c.title, c.url, c.handle, c.country, c.subscribers, c.videoCount, c.totalViews, r.uploadsCompared, r.medianViews,
      c.viewsPerSubscriber, r.uploadsPerWeek, r.medianEngagement, r.topMultiple, r.shortFormShare, r.medianMinutes, c.fetchedAt];
  }

  // Markdown tables in the shape of the YouTube Research Pocket report
  // (sections A and B), with the measured evidence filled in.
  function reportText(d) {
    var md = function (s) { return String(s === null || s === undefined ? "" : s).replace(/\|/g, "\\|").replace(/\s+/g, " "); };
    var rows = function (list) {
      if (!list.length) return "_No videos in this window met the filters._\n";
      return "| Rank | Video & creator | Published | Views / visible engagement | Why it stands out | Confidence |\n" +
        "|---|---|---|---|---|---|\n" +
        list.map(function (v, i) {
          return "| " + (i + 1) + " | [" + md(v.title) + "](" + v.url + ") — " + md(v.channelTitle) + " | " +
            DAY.format(new Date(v.publishedAt)) + " (" + age(v.ageDays) + ") | " +
            (v.views === null ? "not publicly visible" : WHOLE.format(v.views)) + " views; " +
            (v.likes === null ? "likes hidden" : WHOLE.format(v.likes) + " likes") + "; " +
            (v.comments === null ? "comments off" : WHOLE.format(v.comments) + " comments") + " | " +
            md(why(v)) + "; signal " + v.signal.total + "/60 | " + v.confidence + " |";
        }).join("\n") + "\n";
    };
    return "**Research checked:** " + DAY.format(new Date(d.checkedAt)) + " via the YouTube Data API (exact counts at that time).  \n" +
      "**Coverage:** \"" + md(d.query) + "\"; current = last " + d.options.days + " days, evergreen = older than " +
      d.options.evergreenDays + " days" + (d.options.region ? "; region " + d.options.region : "") +
      (d.options.language ? "; language " + d.options.language : "") + "; " + d.coverage.candidates +
      " candidates considered.\n\n## A. Top current videos\n\n" + rows(d.trending) +
      "\n## B. Top evergreen performers\n\n" + rows(d.evergreen) +
      "\n_Signal is SpeakPower's derived score (60 of 100: performance against the channel, timing, engagement); " +
      "relevance (30) and adaptability (10) are the editor's call. Not a YouTube metric._\n";
  }

  function copy(text, button) {
    var done = function () { var t = button.textContent; button.textContent = "Copied"; setTimeout(function () { button.textContent = t; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = el("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* the CSV still has everything */ }
      ta.remove();
    }
  }

  /* ------------------------------------------------------------ requests */

  function failure(statusId, err) {
    if (err.status === 401) { start(); return; }
    if (err.data && err.data.quota) renderQuota(err.data.quota);
    setStatus(statusId, err.message || "That did not work. Please try again.", "error");
  }

  function busy(button, on, label) {
    if (on) { button.setAttribute("data-label", button.textContent); button.textContent = label; button.disabled = true; }
    else { button.textContent = button.getAttribute("data-label") || button.textContent; button.disabled = false; }
  }

  function lines(id) {
    return $(id).value.split(/[\r\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  $("topicForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var query = $("ytQuery").value.trim();
    if (query.length < 2) { setStatus("topicStatus", "Type a topic or keywords to research.", "error"); $("ytQuery").focus(); return; }
    var button = $("topicGo");
    busy(button, true, "Researching…");
    setStatus("topicStatus", "Asking YouTube and measuring each channel. This takes a few seconds.", "busy");
    A.call("/youtube/analyze", {
      query: query,
      days: Number($("ytDays").value),
      evergreenDays: Number($("ytEvergreen").value),
      region: $("ytRegion").value.trim(),
      language: $("ytLanguage").value.trim(),
      duration: $("ytDuration").value
    }).then(function (d) {
      last.topic = d;
      setStatus("topicStatus", "");
      $("topicTitle").textContent = "“" + d.query + "”";
      videoTable($("topicTrending"), d.trending, "No videos published in this window matched.");
      videoTable($("topicEvergreen"), d.evergreen, "No older videos matched.");
      channelTable($("topicChannels"), d.channels);
      $("topicResults").hidden = false;
      renderQuota(d.quota, d.spent);
      renderMethod(d.method);
    }, function (err) { failure("topicStatus", err); }).then(function () { busy(button, false); });
  });

  $("channelsForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var list = lines("ytChannelsInput");
    if (!list.length) { setStatus("channelsStatus", "Paste at least one channel.", "error"); return; }
    var button = $("channelsGo");
    busy(button, true, "Comparing…");
    setStatus("channelsStatus", "Reading each channel and its recent uploads.", "busy");
    A.call("/youtube/channels", { channels: list }).then(function (d) {
      last.channels = d;
      setStatus("channelsStatus", d.notFound.length ? "Not found: " + d.notFound.join(", ") : "", d.notFound.length ? "error" : null);
      channelTable($("channelsTable"), d.channels);
      $("channelsResults").hidden = false;
      renderQuota(d.quota, d.spent);
      renderMethod(d.method);
    }, function (err) { failure("channelsStatus", err); }).then(function () { busy(button, false); });
  });

  $("videosForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var list = lines("ytVideosInput");
    if (!list.length) { setStatus("videosStatus", "Paste at least one video address.", "error"); return; }
    var button = $("videosGo");
    busy(button, true, "Checking…");
    setStatus("videosStatus", "Reading each video and its channel.", "busy");
    A.call("/youtube/videos", { videos: list }).then(function (d) {
      last.videos = d;
      var missed = d.notFound.concat(d.invalid);
      setStatus("videosStatus", missed.length ? "Could not read: " + missed.join(", ") : "", missed.length ? "error" : null);
      videoTable($("videosTable"), d.videos, "None of these videos could be read.");
      $("videosResults").hidden = false;
      renderQuota(d.quota, d.spent);
      renderMethod(d.method);
    }, function (err) { failure("videosStatus", err); }).then(function () { busy(button, false); });
  });

  $("topicCsv").addEventListener("click", function () {
    var d = last.topic;
    if (!d) return;
    download("youtube-" + slug(d.query) + ".csv", [VIDEO_HEAD]
      .concat(d.trending.map(function (v, i) { return videoRow("current", v, i); }))
      .concat(d.evergreen.map(function (v, i) { return videoRow("evergreen", v, i); })));
  });
  $("topicCopy").addEventListener("click", function () { if (last.topic) copy(reportText(last.topic), $("topicCopy")); });
  $("channelsCsv").addEventListener("click", function () {
    if (last.channels) download("youtube-channels.csv", [CHANNEL_HEAD].concat(last.channels.channels.map(channelRow)));
  });
  $("videosCsv").addEventListener("click", function () {
    if (last.videos) download("youtube-videos.csv", [VIDEO_HEAD].concat(last.videos.videos.map(function (v, i) { return videoRow("check", v, i); })));
  });

  /* ---------------------------------------------------------------- tabs */

  var tabs = ["tabTopic", "tabChannels", "tabVideos"].map($);
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { select(t); });
    t.addEventListener("keydown", function (e) {
      var next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length] : null;
      if (next) { e.preventDefault(); select(next, true); }
    });
  });

  /* --------------------------------------------------------------- start */

  function start() {
    $("ytApp").hidden = true;
    $("ytSignIn").hidden = true;
    notice("");
    if (!SP.connected) { $("ytOffline").hidden = false; return; }
    if (!A.session()) {
      $("ytSignIn").hidden = false;
      A.mountSignIn($("ytSignIn"), {
        title: "Sign in to use YouTube research",
        lead: "YouTube research is open to named SpeakPower accounts.",
        onSignedIn: start
      });
      return;
    }
    A.call("/youtube/quota").then(function (d) {
      $("ytApp").hidden = false;
      renderQuota(d.quota);
    }, function (err) {
      if (err.status === 401) { start(); return; }
      notice(err.status === 403 ? "YouTube research is not open to this account. Ask SpeakPower to add it."
        : err.message || "YouTube research could not be reached.");
    });
  }

  start();
})();
