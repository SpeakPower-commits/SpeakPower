/* ==========================================================================
   SpeakPower — the Rehearsal Room
   Pick the moment, record up to three minutes, get a Speak Score.

   The browser records with MediaRecorder (Opus at 32 kbps where it can, so
   three minutes is about 1 MB), turns the recording into base64 itself and
   sends it to the Worker, which transcribes, measures and coaches. The audio
   is never stored anywhere. If Whisper cannot read a phone's format, the
   page converts the same recording once to a plain WAV and tries again; the
   failed attempt was given back, so it never counts.

   After the free tries, rehearsals come with a plan: never priced per use.

   Security: every string written into the DOM goes through textContent or
   createTextNode, never innerHTML. Charts are built as SVG nodes.
   ========================================================================== */

(function () {
  "use strict";

  var SP = window.SP;
  var A = window.SPAccount;
  var MAX_SECONDS = 180;
  var SVGNS = "http://www.w3.org/2000/svg";
  var PAGE_URL = "https://speakpower-commits.github.io/SpeakPower/rehearse.html";

  function $(id) { return document.getElementById(id); }
  if (!$("rrStage")) return;

  var stage = $("rrStage");
  var steps = { pick: $("rrPick"), recording: $("rrRecording"), scoring: $("rrScoring") };
  var account = null;
  var moment = null;
  var momentTitle = "";

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function showStep(name) {
    Object.keys(steps).forEach(function (k) { steps[k].hidden = k !== name; });
  }
  function showError(message) {
    var e = $("rrError");
    e.textContent = message || "";
    e.hidden = !message;
  }
  function panel(id, on) { $(id).hidden = !on; }

  /* ------------------------------------------------------------ account */

  function renderAccount(next) {
    if (next) account = next;
    if (!account) return;
    $("rrStatus").textContent = A.statusText(account);
    A.renderUsage($("rrUsage"), account, "rehearsal");
  }

  // Nothing left to rehearse with: say so before anyone records for three
  // minutes. (The Worker decides; a 402 still lands here.)
  function cannotPay() {
    if (!account || Number(account.trialsRemaining) > 0) return false;
    var m = account.membership;
    return !(m && m.plan && m.usage && m.usage.rehearsal < 100);
  }

  function openTopup(info) {
    info = info || {};
    A.renderPlanWall($("rrTopup"), {
      message: info.message,
      plans: info.plans,
      account: account,
      returnTo: "rehearse.html",
      onSignedOut: signedOut
    });
    panel("rrTopup", true);
    $("rrRecordBtn").disabled = true;
  }

  function signedOut() {
    panel("rrStage", false);
    panel("rrTopup", false);
    panel("rrStart", true);
  }

  /* ------------------------------------------------------------- moment */

  Array.prototype.forEach.call(document.querySelectorAll(".rr-moment"), function (b, i, all) {
    b.addEventListener("click", function () { choose(b); });
    // Arrow keys move along the group, as a radio group should.
    b.addEventListener("keydown", function (ev) {
      var d = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      ev.preventDefault();
      var next = all[(i + d + all.length) % all.length];
      next.focus();
      choose(next);
    });
  });

  function choose(b) {
    Array.prototype.forEach.call(document.querySelectorAll(".rr-moment"), function (x) {
      x.setAttribute("aria-checked", String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    });
    moment = b.getAttribute("data-moment");
    momentTitle = b.textContent;
    $("rrRecordBtn").disabled = cannotPay();
  }

  /* ---------------------------------------------------------- recording */

  var rec = null; // { recorder, stream, chunks, started, timer, ctx, analyser, raf, cancelled }

  function pickMime() {
    var options = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
    for (var i = 0; i < options.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(options[i])) return options[i];
    }
    return "";
  }

  function startRecording() {
    showError("");
    if (!moment) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      showError("This browser cannot record audio. Try Chrome on Android, Safari on iPhone, or a laptop browser.");
      return;
    }
    $("rrRecordBtn").disabled = true;
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      var mime = pickMime();
      var opts = { audioBitsPerSecond: 32000 };
      if (mime) opts.mimeType = mime;
      var recorder;
      try { recorder = new MediaRecorder(stream, opts); }
      catch (e) { recorder = new MediaRecorder(stream); }
      rec = { recorder: recorder, stream: stream, chunks: [], started: Date.now(), cancelled: false };
      recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
      recorder.onstop = finishRecording;
      recorder.start(1000);
      $("rrMomentName").textContent = momentTitle;
      $("rrTimer").textContent = "0:00";
      showStep("recording");
      $("rrStopBtn").focus();
      rec.timer = setInterval(tick, 250);
      drawLevels(stream);
    }, function (e) {
      $("rrRecordBtn").disabled = false;
      showError(e && e.name === "NotAllowedError"
        ? "Allow the microphone for this site, then press Start recording again."
        : "No microphone was found. Plug one in or try another device.");
    });
  }

  function elapsed() { return rec ? (Date.now() - rec.started) / 1000 : 0; }
  function clock(s) { s = Math.floor(s); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }

  function tick() {
    var s = elapsed();
    $("rrTimer").textContent = clock(Math.min(s, MAX_SECONDS));
    if (s >= MAX_SECONDS) stopRecording();
  }

  // A live level display, so it is obvious the microphone is hearing you.
  function drawLevels(stream) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var canvas = $("rrWave");
    if (!AC || !canvas.getContext) return;
    try {
      rec.ctx = new AC();
      var src = rec.ctx.createMediaStreamSource(stream);
      rec.analyser = rec.ctx.createAnalyser();
      rec.analyser.fftSize = 256;
      src.connect(rec.analyser);
    } catch (e) { return; }
    var g = canvas.getContext("2d");
    var data = new Uint8Array(rec.analyser.fftSize);
    var bars = [];
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function frame() {
      if (!rec || !rec.analyser) return;
      rec.analyser.getByteTimeDomainData(data);
      var peak = 0;
      for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
      bars.push(Math.min(1, peak * 1.8));
      var n = Math.floor(canvas.width / 10);
      if (bars.length > n) bars.shift();
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#f1d47a";
      bars.forEach(function (v, k) {
        var h = Math.max(4, v * (canvas.height - 8));
        g.fillRect(k * 10 + 2, (canvas.height - h) / 2, 5, h);
      });
      rec.raf = still ? setTimeout(frame, 400) : requestAnimationFrame(frame);
    }
    frame();
  }

  function cleanup() {
    if (!rec) return;
    clearInterval(rec.timer);
    if (rec.raf) { cancelAnimationFrame(rec.raf); clearTimeout(rec.raf); }
    rec.stream.getTracks().forEach(function (t) { t.stop(); });
    if (rec.ctx && rec.ctx.close) rec.ctx.close().catch(function () {});
    rec.analyser = null;
  }

  function stopRecording() {
    if (!rec || rec.recorder.state === "inactive") return;
    rec.seconds = Math.min(elapsed(), MAX_SECONDS);
    rec.recorder.stop();
  }

  function cancelRecording() {
    if (!rec) return;
    rec.cancelled = true;
    if (rec.recorder.state !== "inactive") rec.recorder.stop();
  }

  function finishRecording() {
    var r = rec;
    cleanup();
    rec = null;
    if (r.cancelled) { showStep("pick"); $("rrRecordBtn").disabled = cannotPay(); return; }
    var seconds = r.seconds || 0;
    if (seconds < 3) {
      showStep("pick");
      $("rrRecordBtn").disabled = false;
      showError("That was very short. Speak for at least a few seconds, then press Stop and score.");
      return;
    }
    var blob = new Blob(r.chunks, { type: r.recorder.mimeType || "audio/webm" });
    upload(blob, seconds, false);
  }

  /* ------------------------------------------------------------- upload */

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(",")[1] || ""); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function upload(blob, seconds, isRetry) {
    showStep("scoring");
    $("rrScoringText").textContent = isRetry ? "Trying once more in a simpler format…" : "Listening to your rehearsal…";
    var slow = setTimeout(function () { $("rrScoringText").textContent = "Writing your coaching. This takes a few seconds…"; }, 6000);
    toBase64(blob).then(function (audio) {
      return A.call("/rehearse", {
        moment: moment, audio: audio, seconds: Math.round(seconds * 10) / 10,
        anonId: SP.anonId, page: location.pathname
      });
    }).then(function (result) {
      clearTimeout(slow);
      A.setAccount(result.account);
      renderAccount(result.account);
      showStep("pick");
      $("rrRecordBtn").disabled = cannotPay();
      renderReport(result);
      loadHistory();
      if (cannotPay()) openTopup();
    }, function (e) {
      clearTimeout(slow);
      if (e.code === "audio_unreadable" && !isRetry) {
        // Refunded by the Worker. Re-encode the same recording and try once more.
        return toWav(blob).then(function (wav) { upload(wav, seconds, true); }, function () { failed(e); });
      }
      failed(e);
    });
  }

  function failed(e) {
    showStep("pick");
    $("rrRecordBtn").disabled = false;
    if (e.status === 401) { signedOut(); return; }
    if (e.status === 402) {
      if (e.data && e.data.account) { A.setAccount(e.data.account); renderAccount(e.data.account); }
      openTopup(e.data);
      return;
    }
    // Any other failure was given back by the Worker.
    showError(e.message || "That did not work, and it did not count; please try again.");
  }

  // 16 kHz mono G.711 mu-law WAV: what every speech decoder reads, at 16 KB a
  // second, so even three minutes stays within the upload limit.
  function toWav(blob) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC || !OAC) return Promise.reject(new Error("no audio context"));
    return blob.arrayBuffer().then(function (buf) {
      var ctx = new AC();
      return new Promise(function (resolve, reject) { ctx.decodeAudioData(buf, resolve, reject); })
        .then(function (decoded) {
          if (ctx.close) ctx.close().catch(function () {});
          var rate = 16000;
          var off = new OAC(1, Math.ceil(decoded.duration * rate), rate);
          var src = off.createBufferSource();
          src.buffer = decoded;
          src.connect(off.destination);
          src.start();
          return off.startRendering();
        });
    }).then(function (rendered) {
      var pcm = rendered.getChannelData(0);
      var out = new DataView(new ArrayBuffer(44 + pcm.length));
      var w = function (o, s) { for (var i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
      w(0, "RIFF"); out.setUint32(4, 36 + pcm.length, true); w(8, "WAVE");
      w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 7, true); out.setUint16(22, 1, true);
      out.setUint32(24, 16000, true); out.setUint32(28, 16000, true); out.setUint16(32, 1, true); out.setUint16(34, 8, true);
      w(36, "data"); out.setUint32(40, pcm.length, true);
      for (var i = 0; i < pcm.length; i++) out.setUint8(44 + i, muLaw(pcm[i]));
      return new Blob([out.buffer], { type: "audio/wav" });
    });
  }
  function muLaw(x) {
    var s = Math.max(-1, Math.min(1, x)) * 32767;
    var sign = s < 0 ? 0x80 : 0;
    var v = Math.min(32635, Math.abs(s)) + 132;
    var exp = 7;
    for (var mask = 0x4000; (v & mask) === 0 && exp > 0; mask >>= 1) exp--;
    return ~(sign | (exp << 4) | ((v >> (exp + 3)) & 0x0f)) & 0xff;
  }

  /* ------------------------------------------------------------- report */

  var GOOD = "#3fb68b", WARN = "#e0a33a", BAD = "#e05a4f";

  function verdict(score) {
    if (score >= 80) return { text: "Ready for the room", sig: GOOD };
    if (score >= 60) return { text: "Getting there", sig: WARN };
    return { text: "Keep practising", sig: BAD };
  }

  function ring(score) {
    var box = el("div", "rr-ring");
    box.setAttribute("role", "img");
    var C = 2 * Math.PI * 52;
    var s = svg("svg", { viewBox: "0 0 120 120", "aria-hidden": "true" });
    s.appendChild(svg("circle", { cx: 60, cy: 60, r: 52, fill: "none", stroke: "#f1e6c4", "stroke-width": 10 }));
    s.appendChild(svg("circle", {
      cx: 60, cy: 60, r: 52, fill: "none", stroke: "#a8850f", "stroke-width": 10, "stroke-linecap": "round",
      "stroke-dasharray": (C * Math.max(0, Math.min(100, score)) / 100).toFixed(1) + " " + C.toFixed(1)
    }));
    box.appendChild(s);
    return box;
  }

  // One delivery measure: a track over its scale, the target band one step
  // lighter, and the value as a marker with a surface ring. The status is
  // always written out beside it, never left to colour.
  function meter(label, value, unit, scale, band, status) {
    var wrap = el("div", "rr-meter");
    var head = el("div", "rr-meter-head");
    head.appendChild(el("b", null, label));
    head.appendChild(el("span", null, value + " " + unit));
    wrap.appendChild(head);
    // Positions are percentages of the track, so the marker stays round at any width.
    var pct = function (v) { return (Math.max(scale[0], Math.min(scale[1], v)) - scale[0]) / (scale[1] - scale[0]) * 100; };
    var track = el("div", "rr-track");
    track.setAttribute("aria-hidden", "true");
    var zone = el("i", "rr-band");
    zone.style.left = pct(band[0]) + "%";
    zone.style.width = Math.max(1.5, pct(band[1]) - pct(band[0])) + "%";
    var dot = el("i", "rr-dot");
    dot.style.left = pct(value) + "%";
    dot.style.setProperty("--sig", status.sig);
    track.appendChild(zone);
    track.appendChild(dot);
    wrap.appendChild(track);
    var foot = el("div", "rr-meter-foot");
    var st = el("span", "rr-state", status.text);
    st.style.setProperty("--sig", status.sig);
    foot.appendChild(st);
    foot.appendChild(el("span", null, "Target " + band[0] + (band[0] === 0 ? " to " : "–") + band[1] + " " + unit));
    wrap.appendChild(foot);
    return wrap;
  }

  function band3(v, good, warn) {
    if (v <= good) return { text: "On target", sig: GOOD };
    if (v <= warn) return { text: "Watch this", sig: WARN };
    return { text: "Work on this", sig: BAD };
  }
  function paceStatus(w) {
    if (w >= 130 && w <= 160) return { text: "On target", sig: GOOD };
    if (w >= 110 && w <= 180) return { text: w < 130 ? "A little slow" : "A little fast", sig: WARN };
    return { text: w < 110 ? "Too slow" : "Too fast", sig: BAD };
  }

  function lensBar(score) {
    var s = svg("svg", { viewBox: "0 0 118 10", "aria-hidden": "true" });
    for (var i = 0; i < 5; i++) {
      s.appendChild(svg("rect", { x: i * 24, y: 0, width: 22, height: 10, rx: 3, fill: i < score ? "#a8850f" : "#ece5d3" }));
    }
    return s;
  }

  function section(title, kicker) {
    var s = el("section");
    if (kicker) s.appendChild(el("p", "rr-kicker", kicker));
    s.appendChild(el("h3", null, title));
    return s;
  }

  function renderReport(r) {
    var host = $("rrReport");
    host.textContent = "";
    var coached = r.kind === "speak" && r.coaching;
    var label = coached ? "Speak Score" : "Delivery score";

    var top = el("div", "rr-top");
    var rg = ring(r.score);
    var v = el("div", "rr-ring-value");
    v.appendChild(el("b", null, String(r.score)));
    v.appendChild(el("span", null, label));
    rg.appendChild(v);
    rg.setAttribute("aria-label", label + " " + r.score + " out of 100");
    top.appendChild(rg);

    var vd = el("div", "rr-verdict");
    vd.appendChild(el("p", "rr-kicker", r.momentTitle + " · " + clock(r.metrics.seconds)));
    var h = el("h2", null, "Your " + label + ": " + r.score);
    h.id = "rrReportTitle";
    vd.appendChild(h);
    var vt = verdict(r.score);
    var badge = el("span", "rr-badge", vt.text);
    badge.style.setProperty("--sig", vt.sig);
    vd.appendChild(badge);
    if (r.previousScore != null) {
      var d = r.score - r.previousScore;
      vd.appendChild(el("p", "rr-delta", d === 0 ? "Same as your last " + r.momentTitle.toLowerCase() + "."
        : (d > 0 ? "Up " + d : "Down " + (-d)) + " since your last " + r.momentTitle.toLowerCase() + " (" + r.previousScore + ")."));
    }
    if (!coached) {
      vd.appendChild(el("p", "rr-note", r.counted === false
        ? "Scores only this time: written coaching was not available, so this rehearsal did not count. The score covers delivery alone."
        : "Scores only: the score covers delivery alone."));
    }
    top.appendChild(vd);
    host.appendChild(top);

    var m = r.metrics;
    var del = section("Delivery", "Measured from your recording");
    var meters = el("div", "rr-meters");
    meters.appendChild(meter("Pace", m.wpm, "words a minute", [60, 220], [130, 160], paceStatus(m.wpm)));
    meters.appendChild(meter("Fillers", m.fillersPerMin, "a minute", [0, 12], [0, 3], band3(m.fillersPerMin, 3, 6)));
    meters.appendChild(meter("Long pauses", m.pausesPerMin, "a minute", [0, 6], [0, 1], band3(m.pausesPerMin, 1, 2)));
    del.appendChild(meters);
    del.appendChild(el("p", "rr-note", m.words + " words in " + clock(m.seconds) + "; your longest sentence ran " + m.longestSentence + " words."));
    host.appendChild(del);

    if (coached) {
      var c = r.coaching;
      var lens = section("Message, through the POLSΘ lenses", "40% of your Speak Score");
      var list = el("ul", "rr-lenses");
      c.lenses.forEach(function (l) {
        var li = el("li", "rr-lens");
        li.appendChild(el("b", null, l.lens));
        var bar = el("span", "rr-lens-score");
        bar.appendChild(lensBar(l.score));
        bar.appendChild(el("span", "rr-of", l.score + " / 5"));
        li.appendChild(bar);
        li.appendChild(el("small", null, l.note));
        li.setAttribute("aria-label", l.lens + ": " + l.score + " out of 5. " + l.note);
        list.appendChild(li);
      });
      lens.appendChild(list);
      host.appendChild(lens);

      var cols = el("div", "rr-cols");
      var a = section("What landed, and what got lost");
      [["Landed", c.landed], ["Lost", c.lost]].forEach(function (pair) {
        var line = el("p", "rr-landed");
        line.appendChild(el("b", null, pair[0] + ": "));
        line.appendChild(document.createTextNode(pair[1]));
        a.appendChild(line);
      });
      cols.appendChild(a);
      var f = section("Three fixes, most important first");
      var ol = el("ol", "rr-fixes");
      c.fixes.forEach(function (x) { ol.appendChild(el("li", null, x)); });
      f.appendChild(ol);
      cols.appendChild(f);
      host.appendChild(cols);

      var open = section("A stronger opening line");
      open.appendChild(el("blockquote", "rr-quote", c.openingLine));
      host.appendChild(open);
      var sixty = section("Your 60-second version");
      sixty.appendChild(el("p", "rr-sixty", c.sixtySecondVersion));
      host.appendChild(sixty);
    }

    var t = el("details", "rr-transcript");
    t.appendChild(el("summary", null, "What we heard (your transcript)"));
    t.appendChild(el("p", null, r.transcript));
    host.appendChild(t);

    var actions = el("div", "builder-actions");
    var again = el("button", "btn btn-primary", "Rehearse again");
    again.type = "button";
    again.addEventListener("click", function () {
      showStep("pick");
      stage.scrollIntoView({ behavior: "smooth", block: "start" });
      $("rrRecordBtn").focus();
    });
    actions.appendChild(again);
    var share = el("a", "btn btn-ghost", "Share my score on WhatsApp");
    share.href = "https://wa.me/?text=" + encodeURIComponent(
      "My " + label + " for a " + r.momentTitle.toLowerCase() + ": " + r.score + "/100. Rehearse yours free: " + PAGE_URL);
    share.target = "_blank";
    share.rel = "noopener";
    actions.appendChild(share);
    var coach = el("a", "btn btn-ghost", "Book coaching with Otieno");
    coach.href = "contact.html?service=public";
    actions.appendChild(coach);
    host.appendChild(actions);

    host.hidden = false;
    host.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------------------ history */

  function loadHistory() {
    A.call("/rehearsals").then(function (data) { renderHistory(data.rehearsals || []); }, function () {});
  }

  function day(at) {
    try { return new Date(at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); }
    catch (e) { return ""; }
  }

  // The last ten scores, oldest on the left: one series, so no legend; a 2px
  // line, 8px markers with a surface ring, the latest value labelled, and a
  // hover/focus readout on every point. The table below carries every value.
  function renderHistory(list) {
    var box = $("rrHistory");
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    var rows = $("rrHistoryRows");
    rows.textContent = "";
    list.forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("td", null, day(r.at)));
      tr.appendChild(el("td", null, r.momentTitle));
      tr.appendChild(el("td", null, String(r.score)));
      rows.appendChild(tr);
    });

    lastHistory = list;
    var pts = list.slice().reverse();
    var host = $("rrProgress");
    host.textContent = "";
    // Drawn at the panel's real width, so text and markers keep their true size.
    var W = Math.max(260, Math.round(host.clientWidth) || 320), H = 160, L = 30, R = 18, T = 18, B = 18;
    var x = function (i) { return pts.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (pts.length - 1); };
    var y = function (v) { return T + (100 - v) * (H - T - B) / 100; };
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img",
      "aria-label": "Your last " + pts.length + " scores, from " + pts[0].score + " to " + pts[pts.length - 1].score });
    [0, 50, 100].forEach(function (g) {
      s.appendChild(svg("line", { x1: L, x2: W - R, y1: y(g), y2: y(g), stroke: "#e3ddcf", "stroke-width": 1 }));
      var t = svg("text", { x: L - 8, y: y(g) + 4, "text-anchor": "end", "font-size": 10, fill: "#5d6880" });
      t.textContent = String(g);
      s.appendChild(t);
    });
    if (pts.length > 1) {
      s.appendChild(svg("polyline", {
        points: pts.map(function (p, i) { return x(i) + "," + y(p.score); }).join(" "),
        fill: "none", stroke: "#9c7a12", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"
      }));
    }
    var tip = el("div", "rr-tip-box");
    tip.hidden = true;
    pts.forEach(function (p, i) {
      var hit = svg("circle", { class: "hit", cx: x(i), cy: y(p.score), r: 13, tabindex: 0,
        "aria-label": p.score + ", " + p.momentTitle + ", " + day(p.at) });
      var mk = svg("circle", { class: "mk", cx: x(i), cy: y(p.score), r: 4.5, fill: "#9c7a12", stroke: "#ffffff", "stroke-width": 2 });
      var show = function () {
        tip.textContent = "";
        tip.appendChild(el("b", null, String(p.score)));
        tip.appendChild(document.createTextNode(p.momentTitle + " · " + day(p.at)));
        tip.style.left = (x(i) / W * 100) + "%";
        tip.style.top = (y(p.score) / H * 100) + "%";
        tip.hidden = false;
      };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", function () { tip.hidden = true; });
      hit.addEventListener("blur", function () { tip.hidden = true; });
      s.appendChild(hit);
      s.appendChild(mk);
    });
    var last = pts[pts.length - 1];
    var lab = svg("text", { x: x(pts.length - 1), y: y(last.score) - 10, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: "#131c2e" });
    lab.textContent = String(last.score);
    s.appendChild(lab);
    host.appendChild(s);
    host.appendChild(tip);
  }

  var lastHistory = [], resizeQueued = false;
  window.addEventListener("resize", function () {
    if (resizeQueued || !lastHistory.length) return;
    resizeQueued = true;
    window.requestAnimationFrame(function () { resizeQueued = false; renderHistory(lastHistory); });
  });

  $("rrDeleteBtn").addEventListener("click", function () {
    if (!window.confirm("Delete every saved rehearsal score and its coaching? This cannot be undone.")) return;
    A.call("/rehearsals/delete", {}).then(function () {
      renderHistory([]);
      $("rrReport").hidden = true;
    }, function (e) { showError(e.message); });
  });

  /* -------------------------------------------------------------- start */

  $("rrRecordBtn").addEventListener("click", startRecording);
  $("rrStopBtn").addEventListener("click", stopRecording);
  $("rrCancelBtn").addEventListener("click", cancelRecording);
  $("rrStartBtn").addEventListener("click", function () { A.requireAccount("rehearse.html"); });

  if (!SP || !A || !SP.connected || !A.signInAvailable()) { panel("rrOffline", true); return; }

  // This page explains itself to everyone (and to search engines); the
  // recorder is for signed-in visitors. Signing up comes straight back here.
  if (!A.session()) { panel("rrStart", true); return; }

  panel("rrStage", true);
  showStep("pick");
  renderAccount(A.account());
  var settled = null;
  A.settleReturn().then(function (result) {
    settled = result;
    if (result && !result.ok) showError(result.text);
    return A.refresh();
  }).then(function (acct) {
    renderAccount(acct);
    if (settled && settled.ok) $("rrStatus").textContent += " · " + settled.text;
    if (cannotPay()) openTopup();
    else panel("rrTopup", false);
    loadHistory();
  }, function (e) {
    if (e.status === 401) signedOut();
  });
})();
