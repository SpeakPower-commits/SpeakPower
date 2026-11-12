/* ==========================================================================
   SpeakPower — the Transcriber (Rehearsal Room)
   Choose a recording, send it, get it back word for word, by speaker.

   The file goes to the Worker in 8 MB pieces, one at a time, each retried on
   a dropped signal; a piece already received is never sent twice, so an
   upload carries on after a reload when the same file is chosen again. The
   Worker transcribes in the background (the tab can close once the file is
   sent) and deletes the recording when the words are in.

   The transcript: speakers renamed once and changed everywhere, paragraphs
   moved to another speaker or corrected by hand (saved, version-checked),
   search, play-along while the file is open here, minutes written by Claude,
   and downloads (Word, PDF, text, SRT captions).

   Security: every string written into the DOM goes through textContent or
   createTextNode, never innerHTML.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  function $(id) { return document.getElementById(id); }
  if (!$("trStage")) return;

  var account = null;
  var job = null;          // the recording being sent or transcribed
  var file = null;         // the File chosen in this tab (for sending and playing along)
  var seconds = null;      // its length, when the browser can read it
  var sending = null;      // { cancelled } while a file is being sent
  var view = null;         // the open transcript: { t, paras: [li], names: {} }
  var pending = { speakers: false, edits: [] };
  var saveTimer = null;
  var leaveGuard = null;

  // Google Analytics (analytics.js): counts what was used, never a name or a word said.
  function track(name, params) { if (window.SPAnalytics) window.SPAnalytics.track(name, params); }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(text, className, onClick) {
    var b = el("button", className || "btn btn-ghost", text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function panel(id, on) { $(id).hidden = !on; }
  function showError(message) {
    $("trError").textContent = message || "";
    $("trError").hidden = !message;
  }
  function sleep(ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
  function clock(s) {
    s = Math.max(0, Math.round(s || 0));
    if (s < 60) return s + " s";
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return h ? h + " h" + (m ? " " + m + " min" : "") : m + " min";
  }
  function stamp(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = ("0" + (sec % 60)).slice(-2);
    return h ? h + ":" + ("0" + m).slice(-2) + ":" + s : m + ":" + s;
  }
  function size(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
    if (bytes >= 1e6) return Math.round(bytes / 1e6) + " MB";
    return Math.max(1, Math.round(bytes / 1e3)) + " KB";
  }
  function day(sec) {
    try { return new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return ""; }
  }
  function work(id, info) { if (window.SPWork) window.SPWork.set("transcribe:" + id, info); }
  function holdPage() { if (!leaveGuard && window.SPWork) leaveGuard = window.SPWork.guard("Your recording is being sent…"); }
  function freePage() { if (leaveGuard) { leaveGuard(); leaveGuard = null; } }
  function toast(text) { if (window.SPWork && window.SPWork.toast) window.SPWork.toast(text); }

  function showStep(name) {
    ["trPick", "trUpload", "trWorking"].forEach(function (id) { $(id).hidden = id !== name; });
  }

  /* ------------------------------------------------------------ account */

  function renderAccount(next) {
    if (next) account = next;
    if (!account) return;
    $("trStatus").textContent = A.statusText(account);
    A.renderUsage($("trUsage"), account, "transcribe");
  }

  function signedOut() {
    ["trStage", "trTopup", "trView", "trListWrap"].forEach(function (id) { panel(id, false); });
    panel("trStart", true);
  }

  function openTopup(info) {
    info = info || {};
    var host = $("trTopup");
    A.renderPlanWall(host, { message: info.message, plans: info.plans, account: account, returnTo: "transcribe.html", onSignedOut: signedOut });
    if (Number(info.availableSeconds) >= 60 && file) {
      var part = el("div", "tr-partial");
      part.appendChild(el("p", null, "Or transcribe the part your time covers now, and the rest after your plan renews."));
      part.appendChild(button("Transcribe the first " + clock(info.availableSeconds), "btn btn-primary", function () {
        panel("trTopup", false);
        start(true);
      }));
      host.insertBefore(part, host.children[2] || null);
    }
    panel("trTopup", true);
    if (host.scrollIntoView) host.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------------ choosing a file */

  function readLength(f) {
    return new Promise(function (resolve) {
      var media = document.createElement(/^video\//.test(f.type) ? "video" : "audio");
      var url = URL.createObjectURL(f);
      var done = function (value) {
        clearTimeout(timer);
        media.removeAttribute("src");
        URL.revokeObjectURL(url);
        resolve(value);
      };
      var timer = setTimeout(function () { done(null); }, 10000);
      media.preload = "metadata";
      media.onloadedmetadata = function () { var d = media.duration; done(isFinite(d) && d > 0 ? d : null); };
      media.onerror = function () { done(null); };
      media.src = url;
    });
  }

  function choose(f) {
    showError("");
    panel("trTopup", false);
    if (!f) return;
    if (f.size > 5 * 1024 * 1024 * 1024) { showError("That file is over 5 GB. Save it as audio only (MP3 or M4A) and choose it again."); return; }
    file = f;
    seconds = null;
    $("trFileName").textContent = f.name;
    $("trFileMeta").textContent = size(f.size) + " · reading its length…";
    panel("trFileInfo", true);
    panel("trOptions", true);
    $("trGo").disabled = true;
    readLength(f).then(function (d) {
      if (file !== f) return;
      seconds = d;
      if (d && d > 10 * 3600) {
        $("trFileMeta").textContent = size(f.size) + " · " + clock(d);
        showError("That recording is over 10 hours. Split it and send each part.");
        return;
      }
      $("trFileMeta").textContent = size(f.size) + " · " + (d ? clock(d) : "length not readable here: the time it covers is worked out after it is sent");
      $("trGo").disabled = false;
    });
  }

  $("trFile").addEventListener("change", function () { choose(this.files && this.files[0]); });
  var drop = $("trDrop");
  ["dragenter", "dragover"].forEach(function (t) {
    drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.add("is-over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    drop.addEventListener(t, function () { drop.classList.remove("is-over"); });
  });
  drop.addEventListener("drop", function (ev) {
    ev.preventDefault();
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) choose(f);
  });

  function options() {
    var style = document.querySelector("input[name=trStyle]:checked");
    return {
      language: $("trLanguage").value,
      speakers: Number($("trSpeakers").value) || 0,
      verbatim: !style || style.value === "verbatim",
      terms: $("trTerms").value
    };
  }

  /* ---------------------------------------------------------- sending */

  function start(partial) {
    if (!file) return;
    showError("");
    $("trGo").disabled = true;
    var o = options();
    A.call("/transcribe/start", {
      name: file.name, bytes: file.size, seconds: seconds, mime: file.type, partial: partial === true,
      language: o.language, speakers: o.speakers, verbatim: o.verbatim, terms: o.terms,
      anonId: SP.anonId, page: "transcribe.html"
    }).then(function (res) {
      job = res.transcript;
      track("transcribe_start", { minutes: Math.round(job.seconds / 60), paid_with: res.paidWith, partial: !!res.partial });
      if (res.partial) toast("The first " + clock(job.seconds) + " will be transcribed.");
      send(job, file);
    }, function (e) {
      $("trGo").disabled = false;
      if (A.handleProfileRequired(e, "transcribe.html")) return;
      if (e.status === 401) { signedOut(); return; }
      if (e.status === 402) { openTopup(e.data); return; }
      if (e.code === "transcribe_closed" || e.code === "transcribe_unconfigured") { showUnavailable(account, e.code); return; }
      showError(e.message);
    });
  }
  $("trGo").addEventListener("click", function () { start(false); });

  // Sends every piece the Worker does not have yet, one at a time.
  function send(j, f) {
    var me = sending = { cancelled: false };
    showStep("trUpload");
    $("trUpName").textContent = f.name;
    holdPage();
    var parts = j.parts, partBytes = j.partBytes;
    var have = {};
    (j.received || []).forEach(function (n) { have[n] = true; });
    function progress() {
      var done = Object.keys(have).length;
      var pct = Math.round(done * 100 / parts);
      $("trBarFill").style.width = pct + "%";
      $("trBar").setAttribute("aria-valuenow", String(pct));
      $("trProgress").textContent = size(Math.min(f.size, done * partBytes)) + " of " + size(f.size) + " sent";
      work(j.id, { label: "Sending " + f.name, href: "transcribe.html#t=" + j.id, status: "running", percent: pct });
    }
    progress();
    function piece(n, tries) {
      if (me.cancelled) return Promise.reject(new Error("cancelled"));
      var blob = f.slice((n - 1) * partBytes, Math.min(f.size, n * partBytes));
      return A.upload("/transcribe/part?id=" + encodeURIComponent(j.id) + "&n=" + n, blob).then(function () {
        have[n] = true;
        progress();
      }, function (e) {
        if (me.cancelled || e.status === 401 || (e.status >= 400 && e.status < 500 && e.status !== 429)) throw e;
        // A dropped signal or a busy server: wait, then try the same piece again.
        $("trProgress").textContent = "The connection dropped. Trying again…";
        return sleep(Math.min(30000, 2000 * Math.pow(2, Math.min(tries, 4)))).then(function () { return piece(n, tries + 1); });
      });
    }
    var chain = Promise.resolve();
    for (var n = 1; n <= parts; n++) {
      (function (k) { chain = chain.then(function () { return have[k] ? null : piece(k, 0); }); })(n);
    }
    return chain.then(function () { return finishSending(j, f, me, 0); }).then(function (t) {
      freePage();
      if (me.cancelled) return;
      sending = null;
      job = t;
      working(t);
    }, function (e) {
      freePage();
      sending = null;
      if (me.cancelled) return;
      showStep("trPick");
      $("trGo").disabled = false;
      work(j.id, { label: "Sending " + f.name, href: "transcribe.html#t=" + j.id, status: "failed" });
      if (e.status === 401) { signedOut(); return; }
      showError(e.message || "The file could not be sent. Choose it again to carry on.");
      loadList();
    });
  }

  function finishSending(j, f, me, round) {
    return A.call("/transcribe/uploaded", { id: j.id }).then(function (res) { return res.transcript; }, function (e) {
      if (e.code === "parts_missing" && round < 3 && e.data && Array.isArray(e.data.missing)) {
        // A piece went missing on the way: send it again, then ask once more.
        return e.data.missing.reduce(function (p, n) {
          return p.then(function () {
            var blob = f.slice((n - 1) * j.partBytes, Math.min(f.size, n * j.partBytes));
            return A.upload("/transcribe/part?id=" + encodeURIComponent(j.id) + "&n=" + n, blob);
          });
        }, Promise.resolve()).then(function () { return finishSending(j, f, me, round + 1); });
      }
      if ((e.code === "network" || e.status >= 500) && round < 5 && !me.cancelled) {
        return sleep(3000).then(function () { return finishSending(j, f, me, round + 1); });
      }
      throw e;
    });
  }

  $("trCancel").addEventListener("click", function () {
    if (!sending || !job) return;
    sending.cancelled = true;
    var id = job.id;
    A.call("/transcribe/cancel", { id: id }).then(function () {
      work(id, { label: "Cancelled", status: "failed" });
      if (window.SPWork) window.SPWork.remove("transcribe:" + id);
      return A.refresh();
    }).then(renderAccount, function () {}).then(function () {
      freePage();
      showStep("trPick");
      $("trGo").disabled = !file;
      loadList();
    });
  });

  /* -------------------------------------------------------- transcribing */

  function working(t) {
    showStep("trWorking");
    $("trWorkingText").textContent = "Transcribing " + (t.name || "the recording") + ". An hour usually takes a few minutes. You can close this page: the transcript waits under Your transcripts.";
    work(t.id, { label: "Transcribing " + (t.name || "a recording"), href: "transcribe.html#t=" + t.id, status: "running" });
    var started = Date.now();
    (function ask() {
      A.call("/transcribe/status?id=" + encodeURIComponent(t.id)).then(function (res) {
        var s = res.transcript;
        if (s.status === "done") {
          work(t.id, { label: "Transcript ready: " + (s.name || "recording"), href: "transcribe.html#t=" + t.id, status: "done" });
          showStep("trPick");
          resetPick();
          A.refresh().then(renderAccount, function () {});
          loadList();
          open(t.id, true);
          return;
        }
        if (s.status === "failed" || s.status === "cancelled") {
          work(t.id, { label: "Not transcribed: " + (s.name || "recording"), href: "transcribe.html", status: "failed" });
          showStep("trPick");
          $("trGo").disabled = !file;
          showError(s.message);
          A.refresh().then(renderAccount, function () {});
          loadList();
          return;
        }
        setTimeout(ask, Date.now() - started > 120000 ? 10000 : 4000);
      }, function (e) {
        if (e.status === 401) { signedOut(); return; }
        setTimeout(ask, 10000);
      });
    })();
  }

  function resetPick() {
    file = null;
    seconds = null;
    $("trFile").value = "";
    panel("trFileInfo", false);
    panel("trOptions", false);
    $("trGo").disabled = true;
  }

  /* ---------------------------------------------------------- transcript */

  function nameOf(id) { return (view && view.names[id]) || "Speaker " + id; }

  // A paragraph's words: the unsure ones underlined, search matches marked.
  function paint(node, text, unsure, query) {
    node.textContent = "";
    var marks = [];
    (unsure || []).forEach(function (u) { marks.push([u[0], u[0] + u[1], "u"]); });
    if (query) {
      var low = text.toLowerCase(), at = 0, i;
      while ((i = low.indexOf(query, at)) !== -1) { marks.push([i, i + query.length, "m"]); at = i + query.length; }
    }
    if (!marks.length) { node.textContent = text; return 0; }
    var cuts = [0, text.length];
    marks.forEach(function (m) { cuts.push(Math.max(0, Math.min(text.length, m[0])), Math.max(0, Math.min(text.length, m[1]))); });
    cuts = cuts.filter(function (c, i, all) { return all.indexOf(c) === i; }).sort(function (a, b) { return a - b; });
    var hits = 0;
    for (var k = 0; k < cuts.length - 1; k++) {
      var a = cuts[k], b = cuts[k + 1], part = text.slice(a, b);
      var u = false, m = false;
      marks.forEach(function (x) { if (x[0] <= a && x[1] >= b) { if (x[2] === "u") u = true; else m = true; } });
      if (!u && !m) { node.appendChild(document.createTextNode(part)); continue; }
      var span = el(m ? "mark" : "span", u ? "tr-unsure" : null, part);
      if (u) span.title = "The engine was unsure of this word: check it";
      node.appendChild(span);
      if (m && marks.some(function (x) { return x[2] === "m" && x[0] === a; })) hits++;
    }
    return hits;
  }

  function open(id, fresh) {
    showError("");
    A.call("/transcript?id=" + encodeURIComponent(id)).then(function (res) {
      var t = res.transcript;
      if (t.status !== "done") {
        if (t.status === "queued" || t.status === "transcribing") { job = t; working(t); return; }
        if (t.status === "uploading") { showError("This recording was not fully sent. Choose the same file again under Your transcripts to finish sending it."); return; }
        showError(t.message || "This recording could not be transcribed.");
        return;
      }
      render(t);
      if (fresh) track("transcribe_complete", { minutes: Math.round(t.seconds / 60), speakers: (t.speakers || []).length });
      if (history.replaceState) history.replaceState(null, "", "#t=" + t.id);
      var host = $("trView");
      if (host.scrollIntoView) host.scrollIntoView({ behavior: "smooth", block: "start" });
    }, function (e) {
      if (e.status === 401) { signedOut(); return; }
      showError(e.status === 404 ? "That transcript is no longer in your account." : e.message);
    });
  }

  function render(t) {
    view = { t: t, paras: [], names: {}, playing: -1 };
    pending = { speakers: false, edits: [] };
    (t.speakers || []).forEach(function (s) { view.names[s.id] = s.name; });
    $("trTitle").textContent = t.name || "Recording";
    $("trMeta").textContent = [clock(t.seconds), (t.words || 0).toLocaleString("en-US") + " words",
      (t.speakers || []).length + ((t.speakers || []).length === 1 ? " speaker" : " speakers"), day(t.finishedAt || t.createdAt)]
      .filter(Boolean).join(" · ");
    $("trSaved").textContent = "";
    renderActions(t);
    renderSpeakers();
    renderMinutes(t);
    renderParas();
    renderPlayer();
    $("trSearch").value = "";
    $("trHits").textContent = "";
    panel("trView", true);
  }

  function renderActions(t) {
    var host = $("trActions");
    host.textContent = "";
    var minutesBtn = button(t.minutes ? "Write the minutes again" : "Write the minutes", "btn btn-primary", function () { writeMinutes(minutesBtn); });
    if (t.minutesState === "writing") { minutesBtn.disabled = true; minutesBtn.textContent = "Writing the minutes…"; followMinutes(minutesBtn); }
    if (t.minutes && !t.minutesLeft) minutesBtn.hidden = true;
    host.appendChild(minutesBtn);
    var dl = el("span", "sp-download");
    dl.appendChild(el("span", "sp-download-label", "Download:"));
    [["Word", "docx"], ["PDF", "pdf"], ["Text", "txt"], ["Captions (SRT)", "srt"]].forEach(function (x) {
      var b = el("button", "sp-download-btn sp-download-btn--" + x[1], x[0]);
      b.type = "button";
      b.addEventListener("click", function () { download(x[1]); });
      dl.appendChild(b);
    });
    host.appendChild(dl);
    host.appendChild(button("Copy all", "rr-link", function () {
      var text = plainText();
      (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(function () { toast("The transcript is on your clipboard."); }, function () { toast("Copying is blocked here: use Text instead."); });
      track("transcribe_export", { format: "copy" });
    }));
    host.appendChild(button("Delete", "rr-link tr-delete", function () { remove(t.id, t.name); }));
  }

  function renderSpeakers() {
    var host = $("trSpeakerList");
    host.textContent = "";
    var total = view.t.speakers.reduce(function (a, s) { return a + (s.seconds || 0); }, 0) || 1;
    view.t.speakers.forEach(function (s) {
      var li = el("li", "tr-speaker");
      var badge = el("span", "tr-badge", s.id);
      badge.setAttribute("aria-hidden", "true");
      li.appendChild(badge);
      var label = el("label", "tr-speaker-name");
      label.appendChild(el("span", "visually-hidden", "Name for speaker " + s.id));
      var input = el("input");
      input.type = "text";
      input.maxLength = 60;
      input.value = s.name;
      input.addEventListener("input", function () {
        view.names[s.id] = input.value.trim() || "Speaker " + s.id;
        s.name = view.names[s.id];
        pending.speakers = true;
        refreshNames();
        queueSave(900);
      });
      label.appendChild(input);
      li.appendChild(label);
      var share = Math.round((s.seconds || 0) * 100 / total);
      li.appendChild(el("span", "tr-talk", clock(s.seconds) + " · " + share + "%"));
      var bar = el("span", "tr-talk-bar");
      bar.setAttribute("aria-hidden", "true");
      var fill = el("i");
      fill.style.width = share + "%";
      bar.appendChild(fill);
      li.appendChild(bar);
      host.appendChild(li);
    });
  }

  function refreshNames() {
    view.paras.forEach(function (li) {
      var sel = li.querySelector("select");
      Array.prototype.forEach.call(sel.options, function (o) { if (o.value !== "+") o.textContent = nameOf(o.value); });
    });
  }

  function speakerSelect(p, i) {
    var sel = el("select", "tr-who");
    sel.setAttribute("aria-label", "Speaker of this paragraph");
    view.t.speakers.forEach(function (s) {
      var o = el("option", null, nameOf(s.id));
      o.value = s.id;
      if (s.id === p.speaker) o.selected = true;
      sel.appendChild(o);
    });
    if (view.t.speakers.length < 26) {
      var add = el("option", null, "Someone else…");
      add.value = "+";
      sel.appendChild(add);
    }
    sel.addEventListener("change", function () {
      var to = sel.value;
      if (to === "+") {
        var used = view.t.speakers.map(function (s) { return s.id; });
        to = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter(function (c) { return used.indexOf(c) === -1; })[0];
        view.t.speakers.push({ id: to, name: "Speaker " + to, seconds: 0 });
        view.names[to] = "Speaker " + to;
      }
      p.speaker = to;
      pending.edits.push({ i: i, speaker: to });
      queueSave(0);
    });
    return sel;
  }

  function renderParas() {
    var host = $("trParas");
    host.textContent = "";
    view.paras = [];
    view.t.paragraphs.forEach(function (p, i) {
      var li = el("li", "tr-para");
      li.setAttribute("data-i", String(i));
      var head = el("div", "tr-para-head");
      var time = button(stamp(p.start / 1000), "tr-time", function () { play(i); });
      time.setAttribute("aria-label", "Play from " + stamp(p.start / 1000));
      head.appendChild(time);
      head.appendChild(speakerSelect(p, i));
      var edit = button("Edit", "rr-link tr-edit", function () { editPara(li, p, i); });
      head.appendChild(edit);
      li.appendChild(head);
      var text = el("p", "tr-text");
      paint(text, p.text, p.unsure, "");
      li.appendChild(text);
      host.appendChild(li);
      view.paras.push(li);
    });
    if (!view.t.paragraphs.length) host.appendChild(el("li", "tr-empty", "No speech was found in this recording."));
  }

  function editPara(li, p, i) {
    var text = li.querySelector(".tr-text");
    if (li.querySelector("textarea")) return;
    var area = el("textarea", "tr-edit-box");
    area.value = p.text;
    area.rows = Math.min(14, Math.max(3, Math.ceil(p.text.length / 80)));
    area.setAttribute("aria-label", "Correct this paragraph");
    var bar = el("div", "tr-edit-actions");
    bar.appendChild(button("Save", "btn btn-primary", function () {
      var value = area.value.replace(/\s+/g, " ").trim();
      if (value && value !== p.text) {
        p.text = value;
        p.unsure = [];
        pending.edits.push({ i: i, text: value });
        queueSave(0);
      }
      close();
    }));
    bar.appendChild(button("Cancel", "btn btn-ghost", close));
    function close() {
      area.remove();
      bar.remove();
      text.hidden = false;
      paint(text, p.text, p.unsure, currentQuery());
    }
    text.hidden = true;
    li.appendChild(area);
    li.appendChild(bar);
    area.focus();
  }

  function queueSave(ms) {
    clearTimeout(saveTimer);
    $("trSaved").textContent = "Saving…";
    saveTimer = setTimeout(save, ms);
  }

  function save() {
    if (!view) return;
    var t = view.t;
    var body = { id: t.id, version: t.version };
    if (pending.speakers) body.speakers = t.speakers.map(function (s) { return { id: s.id, name: view.names[s.id] }; });
    if (pending.edits.length) body.edits = pending.edits.slice();
    var sent = pending;
    pending = { speakers: false, edits: [] };
    A.call("/transcribe/save", body).then(function (res) {
      t.version = res.version;
      if (Array.isArray(res.speakers)) {
        t.speakers = res.speakers;
        res.speakers.forEach(function (s) { view.names[s.id] = s.name; });
        if (sent.edits.some(function (e) { return e.speaker; })) renderSpeakers();
      }
      $("trSaved").textContent = pending.speakers || pending.edits.length ? "Saving…" : "Saved";
    }, function (e) {
      if (e.status === 401) { signedOut(); return; }
      if (e.code === "version_conflict") {
        $("trSaved").textContent = "";
        var note = el("span", null, "This transcript was changed in another tab. ");
        note.appendChild(button("Load the latest", "rr-link", function () { open(t.id); }));
        $("trSaved").appendChild(note);
        return;
      }
      // Not saved: keep the changes and try again shortly.
      pending.speakers = pending.speakers || sent.speakers;
      pending.edits = sent.edits.concat(pending.edits);
      $("trSaved").textContent = "Not saved yet: " + e.message;
      queueSave(8000);
    });
  }

  /* ---------------------------------------------------------- search */

  function currentQuery() { return $("trSearch").value.trim().toLowerCase(); }
  var searchTimer = null;
  $("trSearch").addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 200);
  });
  $("trSearch").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" || !view) return;
    ev.preventDefault();
    var marks = $("trParas").querySelectorAll("mark");
    if (!marks.length) return;
    view.hit = ((view.hit == null ? -1 : view.hit) + 1) % marks.length;
    marks[view.hit].scrollIntoView({ behavior: "smooth", block: "center" });
  });
  function search() {
    if (!view) return;
    var q = currentQuery();
    var hits = 0;
    view.hit = null;
    view.t.paragraphs.forEach(function (p, i) {
      var text = view.paras[i].querySelector(".tr-text");
      if (q || text.querySelector("mark")) hits += paint(text, p.text, p.unsure, q);
    });
    $("trHits").textContent = q ? (hits ? hits + (hits === 1 ? " match" : " matches") + " · Enter for the next" : "No match") : "";
  }

  /* ------------------------------------------------------------ playing along */

  var audio = null;
  function renderPlayer() {
    var host = $("trPlayer");
    host.textContent = "";
    if (audio) { audio.pause(); if (audio.src) URL.revokeObjectURL(audio.src); audio = null; }
    if (file && view && file.size === view.t.bytes) {
      audio = el("audio", "tr-audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = URL.createObjectURL(file);
      audio.setAttribute("aria-label", "The recording, played from this device");
      audio.addEventListener("timeupdate", follow);
      host.appendChild(audio);
      return;
    }
    var label = el("label", "tr-replay");
    label.appendChild(el("span", null, "To play along, choose the same file again. It stays on this device."));
    var input = el("input", "visually-hidden");
    input.type = "file";
    input.accept = "audio/*,video/*";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      if (view && f.size !== view.t.bytes) { toast("That is a different file from the one transcribed."); return; }
      file = f;
      renderPlayer();
    });
    label.appendChild(input);
    label.appendChild(el("span", "btn btn-ghost tr-replay-btn", "Choose the file"));
    host.appendChild(label);
  }

  function play(i) {
    var p = view && view.t.paragraphs[i];
    if (!p) return;
    if (!audio) {
      var pick = $("trPlayer").querySelector("input");
      if (pick) pick.focus();
      toast("Choose the same file again to play from " + stamp(p.start / 1000) + ".");
      return;
    }
    audio.currentTime = p.start / 1000;
    audio.play().catch(function () {});
  }

  function follow() {
    if (!audio || !view) return;
    var ms = audio.currentTime * 1000, list = view.t.paragraphs, lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (list[mid].start <= ms) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at === view.playing) return;
    if (view.playing >= 0 && view.paras[view.playing]) view.paras[view.playing].classList.remove("is-playing");
    view.playing = at;
    if (at >= 0) view.paras[at].classList.add("is-playing");
  }

  /* ------------------------------------------------------------ minutes */

  function writeMinutes(btn) {
    btn.disabled = true;
    btn.textContent = "Writing the minutes…";
    A.call("/transcribe/minutes", { id: view.t.id, anonId: SP.anonId, page: "transcribe.html" }).then(function () {
      track("transcribe_minutes", {});
      followMinutes(btn);
    }, function (e) {
      btn.disabled = false;
      btn.textContent = "Write the minutes";
      if (e.status === 401) { signedOut(); return; }
      toast(e.message);
    });
  }

  function followMinutes(btn) {
    var id = view.t.id;
    (function ask() {
      A.call("/transcribe/status?id=" + encodeURIComponent(id)).then(function (res) {
        if (!view || view.t.id !== id) return;
        var state = res.transcript.minutesState;
        if (state === "writing") { setTimeout(ask, 4000); return; }
        if (state === "failed") { toast("The minutes could not be written this time. Try again."); }
        A.call("/transcript?id=" + encodeURIComponent(id)).then(function (r) {
          if (!view || view.t.id !== id) return;
          view.t.minutes = r.transcript.minutes;
          view.t.minutesLeft = r.transcript.minutesLeft;
          view.t.minutesState = r.transcript.minutesState;
          renderMinutes(view.t);
          renderActions(view.t);
          if (state === "done" && $("trMinutes").scrollIntoView) $("trMinutes").scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }, function () { setTimeout(ask, 8000); });
    })();
  }

  function list(host, items) {
    var ul = el("ul");
    items.forEach(function (x) { ul.appendChild(el("li", null, x)); });
    host.appendChild(ul);
  }

  function renderMinutes(t) {
    var host = $("trMinutes");
    host.textContent = "";
    var m = t.minutes;
    host.hidden = !m;
    if (!m) return;
    var head = el("div", "tr-minutes-head");
    head.appendChild(el("h3", null, "Minutes"));
    head.appendChild(window.SPExport ? window.SPExport.buttons(minutesDoc, "Download the minutes") : el("span"));
    host.appendChild(head);
    host.appendChild(el("p", "tr-note", "Written by Claude from this transcript only. Read them before you send them."));
    host.appendChild(el("p", "tr-summary", m.summary));
    if (m.keyPoints.length) { host.appendChild(el("h4", null, "Key points")); list(host, m.keyPoints); }
    host.appendChild(el("h4", null, "Decisions"));
    if (m.decisions.length) list(host, m.decisions); else host.appendChild(el("p", null, "No decision was recorded."));
    host.appendChild(el("h4", null, "Action items"));
    if (m.actions.length) {
      var table = el("table", "tr-actions-table");
      var thead = el("thead"), hr = el("tr");
      ["Who", "What", "By when"].forEach(function (h) { var th = el("th", null, h); th.scope = "col"; hr.appendChild(th); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el("tbody");
      m.actions.forEach(function (a) {
        var tr = el("tr");
        tr.appendChild(el("td", null, a.owner));
        tr.appendChild(el("td", null, a.task));
        tr.appendChild(el("td", null, a.due));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      host.appendChild(table);
    } else host.appendChild(el("p", null, "No one took on a task in this recording."));
    if (m.chapters.length) {
      host.appendChild(el("h4", null, "Chapters"));
      var ol = el("ol", "tr-chapters");
      m.chapters.forEach(function (c) {
        var li = el("li");
        li.appendChild(button(stamp(c.start), "tr-time", function () { jump(c.start); }));
        li.appendChild(el("span", null, c.title));
        ol.appendChild(li);
      });
      host.appendChild(ol);
    }
  }

  function jump(sec) {
    var list = view.t.paragraphs, at = 0;
    for (var i = 0; i < list.length; i++) { if (list[i].start <= sec * 1000) at = i; else break; }
    var li = view.paras[at];
    if (li && li.scrollIntoView) li.scrollIntoView({ behavior: "smooth", block: "center" });
    if (audio) play(at);
  }

  /* ------------------------------------------------------------ downloads */

  function line(p) { return "[" + stamp(p.start / 1000) + "] " + nameOf(p.speaker) + ": " + p.text; }
  function plainText() {
    var t = view.t;
    return t.name + "\n" + $("trMeta").textContent + "\n\n" + t.paragraphs.map(line).join("\n\n") + "\n";
  }
  function srtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
    return ("0" + h).slice(-2) + ":" + ("0" + m).slice(-2) + ":" + ("0" + s).slice(-2) + "," + ("00" + (ms % 1000)).slice(-3);
  }
  function srt() {
    var out = [], n = 0;
    view.t.paragraphs.forEach(function (p) {
      var cues = (p.cues && p.cues.length ? p.cues : [[0, p.start]]);
      cues.forEach(function (c, k) {
        var next = cues[k + 1];
        var text = p.text.slice(c[0], next ? next[0] : p.text.length).trim();
        if (!text) return;
        var end = next ? next[1] : p.end;
        if (end <= c[1]) end = c[1] + 1000;
        out.push(String(++n), srtTime(c[1]) + " --> " + srtTime(end), (k === 0 ? nameOf(p.speaker) + ": " : "") + text, "");
      });
    });
    return out.join("\r\n");
  }
  function save_(text, ext, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = el("a");
    a.href = url;
    a.download = (view.t.name || "transcript").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) + "." + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function transcriptDoc() {
    var t = view.t;
    var speakers = t.speakers.map(function (s) { return "- " + nameOf(s.id) + ": " + clock(s.seconds); });
    return {
      title: t.name || "Transcript",
      subtitle: "Transcript · " + $("trMeta").textContent,
      sections: [
        { heading: "Speakers", lines: speakers },
        { heading: "Transcript", lines: t.paragraphs.map(function (p) { return "**[" + stamp(p.start / 1000) + "] " + nameOf(p.speaker) + ":** " + p.text; }) }
      ]
    };
  }
  function minutesDoc() {
    var t = view.t, m = t.minutes;
    var sections = [{ heading: "Summary", lines: [m.summary] }];
    if (m.keyPoints.length) sections.push({ heading: "Key points", lines: m.keyPoints.map(function (x) { return "- " + x; }) });
    sections.push({ heading: "Decisions", lines: m.decisions.length ? m.decisions.map(function (x) { return "- " + x; }) : ["No decision was recorded."] });
    sections.push(m.actions.length
      ? { heading: "Action items", table: { head: ["Who", "What", "By when"], rows: m.actions.map(function (a) { return [a.owner, a.task, a.due]; }) } }
      : { heading: "Action items", lines: ["No one took on a task in this recording."] });
    if (m.chapters.length) sections.push({ heading: "Chapters", lines: m.chapters.map(function (c) { return "- " + stamp(c.start) + " " + c.title; }) });
    return { title: "Minutes: " + (t.name || "Recording"), subtitle: $("trMeta").textContent + " · written from the transcript", sections: sections };
  }
  function download(kind) {
    if (!view) return;
    track("transcribe_export", { format: kind });
    if (kind === "docx") return window.SPExport.word(transcriptDoc());
    if (kind === "pdf") return window.SPExport.pdf(transcriptDoc());
    if (kind === "txt") return save_(plainText(), "txt", "text/plain;charset=utf-8");
    if (kind === "srt") return save_(srt(), "srt", "application/x-subrip;charset=utf-8");
  }

  /* ---------------------------------------------------------- your transcripts */

  function remove(id, name) {
    if (!window.confirm("Delete the transcript of " + (name || "this recording") + "? The words, names and minutes cannot be brought back.")) return;
    A.call("/transcripts/delete", { id: id }).then(function () {
      if (view && view.t.id === id) {
        view = null;
        panel("trView", false);
        if (history.replaceState) history.replaceState(null, "", location.pathname);
      }
      if (window.SPWork) window.SPWork.remove("transcribe:" + id);
      toast("Deleted.");
      loadList();
    }, function (e) { toast(e.message); });
  }

  // Finishing an upload from another visit: the same file, chosen again.
  function resume(t) {
    var input = el("input");
    input.type = "file";
    input.accept = "audio/*,video/*";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      if (f.size !== t.bytes) { toast("That is not the same file: it is a different size."); return; }
      file = f;
      A.call("/transcribe/status?id=" + encodeURIComponent(t.id)).then(function (res) {
        job = res.transcript;
        if (job.status !== "uploading") { open(job.id); return; }
        send(job, f);
      }, function (e) { toast(e.message); });
    });
    input.click();
  }

  var STATES = { uploading: "not fully sent", queued: "waiting for the engine", transcribing: "transcribing", failed: "not transcribed, not charged", cancelled: "cancelled, not charged" };

  function loadList() {
    A.call("/transcripts").then(function (res) {
      var host = $("trList");
      host.textContent = "";
      var items = res.transcripts || [];
      panel("trListWrap", items.length > 0);
      items.forEach(function (t) {
        var li = el("li", "tr-item");
        var main = el("div", "tr-item-main");
        main.appendChild(el("p", "tr-item-name", t.name || "Recording"));
        main.appendChild(el("p", "tr-item-meta", [day(t.createdAt), clock(t.seconds), STATES[t.status] || (t.words ? t.words.toLocaleString("en-US") + " words" : "")]
          .filter(Boolean).join(" · ")));
        li.appendChild(main);
        var acts = el("div", "tr-item-actions");
        if (t.status === "done") acts.appendChild(button("Open", "btn btn-ghost", function () { open(t.id); }));
        if (t.status === "uploading" && !(sending && job && job.id === t.id)) acts.appendChild(button("Finish sending", "btn btn-ghost", function () { resume(t); }));
        if (t.status !== "queued" && t.status !== "transcribing") acts.appendChild(button("Delete", "rr-link tr-delete", function () { remove(t.id, t.name); }));
        li.appendChild(acts);
        host.appendChild(li);
      });
    }, function (e) { if (e.status === 401) signedOut(); });
  }

  /* -------------------------------------------------------------- start */

  // Not open to this account yet, or not switched on: the upload box stays in
  // its place, shut, with the reason above it. Never a detour to another room.
  function showUnavailable(acct, code) {
    panel("trStage", true);
    showStep("trPick");
    var note = $("trNotice");
    note.textContent = "";
    // An API from before the Transcriber does not mention it at all.
    var installed = !!acct && Object.prototype.hasOwnProperty.call(acct, "transcribe") && code !== "transcribe_unconfigured";
    if (!installed && acct && acct.admin) {
      note.appendChild(el("strong", null, "Not switched on yet. "));
      note.appendChild(document.createTextNode("This page is live, but Cloudflare has not installed the part that receives and transcribes " +
        "recordings: it needs R2 storage on the account. In Cloudflare, open R2 Object Storage and enable it (it asks for a card; " +
        "this use stays inside R2's free allowance). Uploads open here as soon as it is installed."));
    } else if (!installed) {
      note.textContent = "Transcribing switches on here shortly. This is where your audio or video goes.";
    } else {
      note.textContent = "Transcribing is being tested on SpeakPower's own recordings first. It opens here to members soon, and plans will carry it.";
    }
    note.hidden = false;
    $("trFile").disabled = true;
    $("trDrop").classList.add("is-off");
    panel("trFileInfo", false);
    panel("trOptions", false);
    $("trGo").disabled = true;
  }

  $("trStartBtn").addEventListener("click", function () { A.requireAccount("transcribe.html"); });

  if (!SP || !A || !SP.connected || !A.signInAvailable()) { panel("trOffline", true); return; }
  if (!A.session()) { panel("trStart", true); return; }
  if (A.requireAccount("transcribe.html")) return;

  renderAccount(A.account());
  var settled = null;
  A.settleReturn().then(function (result) {
    settled = result;
    return A.refresh();
  }).then(function (acct) {
    if (A.requireAccount("transcribe.html")) return;
    renderAccount(acct);
    if (!acct || acct.transcribe !== true) { showUnavailable(acct); return; }
    panel("trStage", true);
    showStep("trPick");
    if (settled && !settled.ok) showError(settled.text);
    if (settled && settled.ok) $("trStatus").textContent += " · " + settled.text;
    loadList();
    // A transcript opened from Your history, or the activity chip.
    var m = /^#t=([0-9a-f-]{36})$/.exec(location.hash || "");
    if (m) open(m[1]);
  }, function (e) {
    if (e.status === 401) signedOut();
  });
})();
