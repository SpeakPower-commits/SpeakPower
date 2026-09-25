/* ==========================================================================
   SpeakPower — Message Clarity Audit
   A client-side diagnostic. No server, no upload, no storage: the text a
   visitor pastes never leaves their browser, which is both a privacy property
   worth stating on the page and the reason this can live on static hosting.

   Every metric here is a published, reproducible measure rather than a verdict
   pulled out of the air. The thresholds are stated on the page so anyone can
   disagree with them in the open.

   References
     Flesch, R. (1948). A new readability yardstick. J. Applied Psychology 32(3).
     Kincaid, J.P. et al. (1975). Derivation of new readability formulas.
       Naval Technical Training Command, Research Branch Report 8-75.

   All DOM writes go through textContent. Nothing a visitor types is ever
   interpreted as markup.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     Lexicons
     Deliberately short and specific. A bloated buzzword list produces false
     positives on words that are load-bearing in a real sentence.
     ---------------------------------------------------------------------- */

  var HEDGES = [
    "maybe", "perhaps", "possibly", "arguably", "somewhat", "fairly", "rather",
    "quite", "generally", "typically", "usually", "often", "sometimes",
    "relatively", "virtually", "essentially", "basically", "actually", "really",
    "very", "slightly", "apparently", "seemingly", "presumably", "roughly",
    "approximately", "hopefully", "potentially", "arguably", "probably"
  ];

  var HEDGE_PHRASES = [
    "we believe", "we think", "we feel", "aims to", "seeks to", "strives to",
    "hopes to", "tries to", "works to", "is designed to", "can help",
    "may help", "might help", "could help", "in order to", "a variety of",
    "a number of", "some of the", "one of the leading"
  ];

  var JARGON = [
    "leverage", "leveraging", "synergy", "synergies", "holistic", "robust",
    "seamless", "seamlessly", "innovative", "innovation", "cutting-edge",
    "best-in-class", "world-class", "empower", "empowering", "unlock",
    "transformative", "disruptive", "disrupt", "paradigm", "ecosystem",
    "bandwidth", "actionable", "scalable", "turnkey", "bespoke", "curated",
    "impactful", "next-generation", "state-of-the-art", "value-add",
    "mission-critical", "game-changing", "revolutionary", "dynamic"
  ];

  // Nominalisations: verbs frozen into nouns. High density reads as abstract.
  var NOMINAL = /\w{4,}(tion|sion|ment|ness|ity|ance|ence|ancy|ency|ism)s?$/i;

  var PASSIVE = /\b(?:is|are|was|were|be|been|being|get|gets|got)\s+(?:\w+ly\s+)?(\w+(?:ed|en|wn|ne))\b/gi;

  // Common abbreviations that would otherwise split a sentence in two.
  var ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Inc|Ltd|Co|No|Fig|Vol|approx)\./gi;

  /* ------------------------------------------------------------------------
     Tokenising
     ---------------------------------------------------------------------- */

  function sentences(text) {
    // Mask abbreviation periods, split, then restore.
    var masked = text.replace(ABBREV, function (m) {
      return m.replace(/\./g, "");
    });

    // No lookbehind: Safari only gained support in 16.4, and a SyntaxError in
    // a regex literal is thrown at parse time, which would kill the whole file.
    return masked
      .replace(/([.!?])[\s ]+/g, "$1")
      .split(/|\n{2,}/)
      .map(function (s) { return s.replace(//g, ".").trim(); })
      .filter(function (s) { return /[a-z0-9]/i.test(s); });
  }

  function words(text) {
    var m = text.match(/[A-Za-z][A-Za-z'’-]*/g);
    return m || [];
  }

  // Standard English syllable heuristic. Not perfect on proper nouns, which is
  // why the page reports word and sentence counts alongside the score.
  function syllables(word) {
    var w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 0;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
    w = w.replace(/^y/, "");
    var groups = w.match(/[aeiouy]{1,2}/g);
    return groups ? groups.length : 1;
  }

  /* ------------------------------------------------------------------------
     Scoring
     Each component returns 0..1. Weights are declared once, here and on the
     page, so the composite is auditable rather than magic.
     ---------------------------------------------------------------------- */

  var WEIGHTS = {
    readability: 0.30,
    rhythm: 0.20,
    passive: 0.15,
    hedging: 0.15,
    jargon: 0.10,
    evidence: 0.10
  };

  // Full marks inside the band, tapering linearly outside it.
  function band(value, low, high, tolerance) {
    if (value >= low && value <= high) return 1;
    var distance = value < low ? low - value : value - high;
    return Math.max(0, 1 - distance / tolerance);
  }

  function ceiling(value, limit, tolerance) {
    if (value <= limit) return 1;
    return Math.max(0, 1 - (value - limit) / tolerance);
  }

  function analyse(text) {
    var sents = sentences(text);
    var allWords = words(text);
    var nWords = allWords.length;
    var nSents = sents.length;

    if (nWords < 30 || nSents < 2) return null;

    var totalSyllables = allWords.reduce(function (sum, w) {
      return sum + syllables(w);
    }, 0);

    var wordsPerSentence = nWords / nSents;
    var syllablesPerWord = totalSyllables / nWords;

    // Flesch Reading Ease and Flesch–Kincaid Grade Level.
    var flesch = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    var grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;

    // Sentence-length spread. A flat rhythm reads as a drone regardless of
    // how readable each individual sentence is.
    var lengths = sents.map(function (s) { return words(s).length; });
    var mean = lengths.reduce(function (a, b) { return a + b; }, 0) / lengths.length;
    var variance = lengths.reduce(function (sum, l) {
      return sum + Math.pow(l - mean, 2);
    }, 0) / lengths.length;
    var stdev = Math.sqrt(variance);

    var lower = text.toLowerCase();

    function countWords(list) {
      var n = 0;
      allWords.forEach(function (w) {
        if (list.indexOf(w.toLowerCase()) !== -1) n++;
      });
      return n;
    }

    function countPhrases(list) {
      var n = 0;
      list.forEach(function (phrase) {
        var idx = lower.indexOf(phrase);
        while (idx !== -1) { n++; idx = lower.indexOf(phrase, idx + phrase.length); }
      });
      return n;
    }

    var passiveHits = (text.match(PASSIVE) || []).length;
    var hedgeHits = countWords(HEDGES) + countPhrases(HEDGE_PHRASES);
    var jargonHits = countWords(JARGON);
    var nominalHits = allWords.filter(function (w) { return NOMINAL.test(w); }).length;

    // Numbers, percentages and currency — the presence of evidence, not proof
    // that the evidence is good.
    var figures = (text.match(/\b\d+(?:[.,]\d+)?%?\b|\$\s?\d|\d+\s?(?:x|×)\b/g) || []).length;

    var per100 = function (n) { return (n / nWords) * 100; };

    var metrics = {
      words: nWords,
      sentences: nSents,
      wordsPerSentence: wordsPerSentence,
      syllablesPerWord: syllablesPerWord,
      flesch: flesch,
      grade: grade,
      lengths: lengths,
      meanLength: mean,
      stdev: stdev,
      passiveRate: (passiveHits / nSents) * 100,
      hedgeRate: per100(hedgeHits),
      jargonRate: per100(jargonHits),
      nominalRate: per100(nominalHits),
      evidenceRate: per100(figures),
      counts: {
        passive: passiveHits,
        hedge: hedgeHits,
        jargon: jargonHits,
        nominal: nominalHits,
        figures: figures
      }
    };

    var parts = {
      // Flesch 50–70 is the band professional prose reads well in: plain
      // enough to scan, not so plain it sounds like a children's book.
      readability: band(metrics.flesch, 50, 70, 25),
      // Mean 14–20 words with a standard deviation above 5 — varied rhythm.
      rhythm: 0.6 * band(metrics.meanLength, 14, 20, 10)
            + 0.4 * Math.min(1, metrics.stdev / 6),
      passive: ceiling(metrics.passiveRate, 10, 25),
      hedging: ceiling(metrics.hedgeRate, 1.5, 3),
      jargon: ceiling(metrics.jargonRate, 1.0, 2.5),
      evidence: Math.min(1, metrics.evidenceRate / 1.0),
      // Reported and colour-coded, but deliberately not weighted into the
      // composite: nominalisation overlaps heavily with readability, and
      // double-counting it would punish the same sentence twice.
      nominal: ceiling(metrics.nominalRate, 8, 8)
    };

    var score = 0;
    Object.keys(WEIGHTS).forEach(function (k) {
      score += parts[k] * WEIGHTS[k];
    });

    metrics.parts = parts;
    metrics.score = Math.round(score * 100);
    return metrics;
  }

  /* ------------------------------------------------------------------------
     Findings — the part a visitor actually acts on
     ---------------------------------------------------------------------- */

  function findings(m) {
    var out = [];

    if (m.flesch < 50) {
      out.push({
        measure: "readability",
        level: "critical",
        title: "Hard to read",
        body: "Flesch Reading Ease is " + m.flesch.toFixed(0) + ". Below 50 means a "
            + "reader has to work. Usually it is long sentences carrying several "
            + "ideas at once — split them."
      });
    } else if (m.flesch > 70) {
      out.push({
        measure: "readability",
        level: "warning",
        title: "Very plain",
        body: "Flesch Reading Ease is " + m.flesch.toFixed(0) + ". That reads easily, "
            + "but for a senior audience it can land as under-powered. Some density "
            + "signals expertise."
      });
    }

    if (m.meanLength > 20) {
      out.push({
        measure: "rhythm",
        level: "warning",
        title: "Sentences are long",
        body: "Averaging " + m.meanLength.toFixed(1) + " words. Above 20, retention "
            + "drops sharply when the text is read aloud — which is what happens to "
            + "a pitch."
      });
    }

    if (m.stdev < 5) {
      out.push({
        measure: "rhythm",
        level: "warning",
        title: "Flat rhythm",
        body: "Sentence lengths vary by only " + m.stdev.toFixed(1) + " words. Uniform "
            + "length reads as a drone. A short sentence after a long one is the "
            + "cheapest emphasis there is."
      });
    }

    if (m.passiveRate > 10) {
      out.push({
        measure: "passive",
        level: m.passiveRate > 25 ? "critical" : "warning",
        title: "Passive voice",
        body: m.counts.passive + " passive construction" + (m.counts.passive === 1 ? "" : "s")
            + " across " + m.sentences + " sentences. Passive voice hides who acts. "
            + "In a pitch, the actor is usually you."
      });
    }

    if (m.hedgeRate > 1.5) {
      out.push({
        measure: "hedging",
        level: "critical",
        title: "Hedging",
        body: m.counts.hedge + " hedge word" + (m.counts.hedge === 1 ? "" : "s")
            + " (" + m.hedgeRate.toFixed(1) + " per 100). Words like "
            + "“aims to” and “generally” let you avoid a claim. "
            + "Investors and donors read that as no claim."
      });
    }

    if (m.jargonRate > 1.0) {
      out.push({
        measure: "jargon",
        level: "warning",
        title: "Category jargon",
        body: m.counts.jargon + " term" + (m.counts.jargon === 1 ? "" : "s")
            + " from the generic business lexicon. These are the words every "
            + "competitor also uses, so they carry no differentiation."
      });
    }

    if (m.nominalRate > 8) {
      out.push({
        measure: "nominal",
        level: "warning",
        title: "Abstract nouns",
        body: m.counts.nominal + " nominalisations (" + m.nominalRate.toFixed(1)
            + " per 100 words). “Implementation of a solution” is a verb in "
            + "hiding. Say who does what."
      });
    }

    if (m.evidenceRate < 1) {
      out.push({
        measure: "evidence",
        level: m.evidenceRate === 0 ? "critical" : "warning",
        title: "No evidence",
        body: m.counts.figures === 0
          ? "Not a single number in the text. A claim with no figure attached cannot be checked, which means it cannot be believed or improved."
          : "Only " + m.counts.figures + " figure" + (m.counts.figures === 1 ? "" : "s")
            + " in " + m.words + " words. Specific numbers are what separate a "
            + "position from an opinion."
      });
    }

    if (!out.length) {
      out.push({
        measure: null,
        level: "good",
        title: "Nothing structural to fix",
        body: "This passes every threshold in the rubric. The remaining questions are "
            + "about strategy rather than mechanics: is this the right thesis, and is "
            + "it aimed at the right audience?"
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------------
     Rendering
     ---------------------------------------------------------------------- */

  var HIST_BINS = [
    { label: "1–5", min: 1, max: 5, ideal: false },
    { label: "6–10", min: 6, max: 10, ideal: false },
    { label: "11–15", min: 11, max: 15, ideal: true },
    { label: "16–20", min: 16, max: 20, ideal: true },
    { label: "21–25", min: 21, max: 25, ideal: false },
    { label: "26–30", min: 26, max: 30, ideal: false },
    { label: "31+", min: 31, max: Infinity, ideal: false }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function verdict(score) {
    if (score >= 80) return { word: "Strong", level: "good" };
    if (score >= 60) return { word: "Workable", level: "warning" };
    if (score >= 40) return { word: "Leaking", level: "warning" };
    return { word: "Not landing", level: "critical" };
  }

  function statusOf(part) {
    if (part >= 0.8) return "good";
    if (part >= 0.5) return "warning";
    return "critical";
  }

  var STATUS_WORD = { good: "Good", warning: "Watch", critical: "Fix" };

  function renderScore(m) {
    var v = verdict(m.score);
    var host = document.getElementById("scoreHost");
    host.textContent = "";

    var wrap = el("div", "score-block");
    var num = el("p", "score-number", String(m.score));
    num.setAttribute("data-level", v.level);
    wrap.appendChild(num);

    var meta = el("div", "score-meta");
    meta.appendChild(el("p", "score-verdict", v.word));
    meta.appendChild(el("p", "score-note",
      m.words + " words · " + m.sentences + " sentences · scored out of 100"));
    wrap.appendChild(meta);

    host.appendChild(wrap);
  }

  function renderTiles(m) {
    var host = document.getElementById("tileHost");
    host.textContent = "";

    var tiles = [
      {
        label: "Flesch Reading Ease",
        value: m.flesch.toFixed(0),
        target: "target 50–70",
        level: statusOf(m.parts.readability)
      },
      {
        label: "Grade level",
        value: m.grade.toFixed(1),
        target: "Flesch–Kincaid",
        level: m.grade > 14 ? "warning" : "good"
      },
      {
        label: "Words per sentence",
        value: m.meanLength.toFixed(1),
        target: "target 14–20",
        level: statusOf(m.parts.rhythm)
      },
      {
        label: "Figures per 100 words",
        value: m.evidenceRate.toFixed(1),
        target: "target 1.0+",
        level: statusOf(m.parts.evidence)
      }
    ];

    tiles.forEach(function (t) {
      var card = el("div", "tile");
      card.setAttribute("data-level", t.level);
      card.appendChild(el("p", "tile-label", t.label));
      card.appendChild(el("p", "tile-value", t.value));
      card.appendChild(el("p", "tile-target", t.target));
      host.appendChild(card);
    });
  }

  function renderHistogram(m) {
    var host = document.getElementById("histHost");
    host.textContent = "";

    var counts = HIST_BINS.map(function (b) {
      return m.lengths.filter(function (l) { return l >= b.min && l <= b.max; }).length;
    });
    var peak = Math.max.apply(null, counts) || 1;

    HIST_BINS.forEach(function (b, i) {
      var col = el("div", "hist-col");

      var value = el("span", "hist-value", String(counts[i]));
      col.appendChild(value);

      var barWrap = el("div", "hist-bar-wrap");
      var bar = el("div", "hist-bar");
      bar.style.height = (counts[i] / peak * 100) + "%";
      bar.setAttribute("data-ideal", String(b.ideal));
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label",
        counts[i] + " sentence" + (counts[i] === 1 ? "" : "s") + " of " + b.label + " words");
      barWrap.appendChild(bar);
      col.appendChild(barWrap);

      col.appendChild(el("span", "hist-label", b.label));
      host.appendChild(col);
    });
  }

  function renderBars(m) {
    var host = document.getElementById("barHost");
    host.textContent = "";

    var rows = [
      { label: "Passive voice", value: m.passiveRate, unit: "% of sentences", limit: 10, part: m.parts.passive },
      { label: "Hedging", value: m.hedgeRate, unit: " per 100 words", limit: 1.5, part: m.parts.hedging },
      { label: "Category jargon", value: m.jargonRate, unit: " per 100 words", limit: 1.0, part: m.parts.jargon },
      { label: "Abstract nouns", value: m.nominalRate, unit: " per 100 words", limit: 8, part: m.parts.nominal }
    ];

    // The four measures use different units (% of sentences vs per-100-words),
    // so a raw scale makes them incomparable and saturates the worst offenders
    // at full width, where length stops carrying information. Plotting each as
    // a ratio to its own threshold puts them on one axis: 1x is the limit, the
    // scale runs to 3x, and anything past that is explicitly flagged off-scale
    // rather than silently clamped to look like "exactly at maximum".
    var SCALE = 3;

    rows.forEach(function (r) {
      var level = statusOf(r.part);
      var ratio = r.limit > 0 ? r.value / r.limit : 0;
      var over = ratio > SCALE;

      var row = el("div", "bar-row");
      row.appendChild(el("p", "bar-label", r.label));

      var trackWrap = el("div", "bar-track");

      var fill = el("div", "bar-fill");
      fill.style.width = (Math.min(ratio, SCALE) / SCALE * 100) + "%";
      fill.setAttribute("data-level", level);
      if (over) fill.setAttribute("data-over", "true");
      trackWrap.appendChild(fill);

      var mark = el("span", "bar-threshold");
      mark.setAttribute("title",
        "Threshold: " + r.limit + r.unit + " — measured " + r.value.toFixed(1));
      trackWrap.appendChild(mark);
      row.appendChild(trackWrap);

      var readout = el("p", "bar-value");
      readout.appendChild(el("span", "bar-num",
        r.value.toFixed(1) + (over ? " (" + ratio.toFixed(1) + "×)" : "")));
      readout.appendChild(el("span", "bar-status " + level, STATUS_WORD[level]));
      row.appendChild(readout);

      host.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------------
     Routing

     Every measure belongs to the service that repairs it, so a finding is not
     just a complaint — it names the next step. Ordering is by points lost from
     the composite rather than by severity label:

         cost(k) = weight(k) × (1 − part(k)) × 100

     which means the top row is the one worth fixing first, and the figure is
     derived from the same rubric the score is, not asserted.

     Nominalisation is reported but carries no weight (it overlaps readability,
     and double-counting would punish the same sentence twice), so its cost is
     zero and it sorts last. That is deliberate, not a bug.
     ---------------------------------------------------------------------- */

  var ROUTES = {
    readability: { service: "Communication strategy",      href: "services.html#svc-strategy" },
    rhythm:      { service: "Public speaking through data",   href: "services.html#svc-speaking" },
    passive:     { service: "Brand intelligence & narrative", href: "services.html#svc-narrative" },
    hedging:     { service: "Brand intelligence & narrative", href: "services.html#svc-narrative" },
    jargon:      { service: "Communication strategy",      href: "services.html#svc-strategy" },
    evidence:    { service: "Communication strategy",      href: "services.html#svc-strategy" },
    nominal:     { service: "Communication strategy",      href: "services.html#svc-strategy" }
  };

  function costOf(m, measure) {
    if (!measure || !WEIGHTS[measure]) return 0;
    return WEIGHTS[measure] * (1 - m.parts[measure]) * 100;
  }

  function renderFindings(m) {
    var host = document.getElementById("findingHost");
    host.textContent = "";

    var rows = findings(m).map(function (f) {
      return { f: f, cost: costOf(m, f.measure) };
    }).sort(function (a, b) { return b.cost - a.cost; });

    // Two findings can come from one measure (long sentences and a flat rhythm
    // are both "rhythm"). They share a single cost, so only the first one to
    // appear shows the figure — otherwise the page would imply the points are
    // lost twice.
    var costShown = {};

    rows.forEach(function (row) {
      var f = row.f;
      var item = el("div", "finding");
      item.setAttribute("data-level", f.level);

      item.appendChild(el("p", "finding-title", f.title));
      item.appendChild(el("p", "finding-body", f.body));

      var route = ROUTES[f.measure];
      if (route) {
        var foot = el("p", "finding-route");

        if (row.cost >= 0.1 && !costShown[f.measure]) {
          costShown[f.measure] = true;
          foot.appendChild(el("span", "finding-cost",
            "Costs " + row.cost.toFixed(1) + " pts"));
        }

        var link = el("a", "finding-fix", route.service + " →");
        link.href = route.href;
        foot.appendChild(link);

        item.appendChild(foot);
      }

      host.appendChild(item);
    });
  }

  function renderTable(m) {
    var host = document.getElementById("tableHost");
    host.textContent = "";

    var rows = [
      ["Words", m.words],
      ["Sentences", m.sentences],
      ["Words per sentence (mean)", m.meanLength.toFixed(2)],
      ["Sentence length (std. dev.)", m.stdev.toFixed(2)],
      ["Syllables per word", m.syllablesPerWord.toFixed(3)],
      ["Flesch Reading Ease", m.flesch.toFixed(1)],
      ["Flesch–Kincaid grade", m.grade.toFixed(1)],
      ["Passive constructions", m.counts.passive],
      ["Passive rate (% of sentences)", m.passiveRate.toFixed(1)],
      ["Hedge words", m.counts.hedge],
      ["Hedge rate (per 100 words)", m.hedgeRate.toFixed(2)],
      ["Jargon terms", m.counts.jargon],
      ["Jargon rate (per 100 words)", m.jargonRate.toFixed(2)],
      ["Nominalisations", m.counts.nominal],
      ["Nominalisation rate (per 100)", m.nominalRate.toFixed(2)],
      ["Figures cited", m.counts.figures],
      ["Figures per 100 words", m.evidenceRate.toFixed(2)],
      ["Composite score", m.score + " / 100"]
    ];

    var table = el("table", "data-table");
    var caption = el("caption", null, "Every measure behind the score");
    table.appendChild(caption);

    var thead = el("thead");
    var hrow = el("tr");
    hrow.appendChild(el("th", null, "Measure"));
    hrow.appendChild(el("th", null, "Value"));
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("th", null, String(r[0])));
      tr.appendChild(el("td", null, String(r[1])));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  /* ------------------------------------------------------------------------
     Reading files

     All of it client-side. The privacy promise on the page is load-bearing:
     nothing here may put a visitor's document on the network. That rules out
     any "just post it to a conversion API" shortcut, and is why .docx is
     unzipped by hand below rather than with a server round-trip.
     ---------------------------------------------------------------------- */

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error(
        "This browser cannot unzip a .docx. Paste the text instead."));
    }
    var stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (b) {
      return new Uint8Array(b);
    });
  }

  // A .docx is a ZIP archive. Walk its central directory to word/document.xml
  // rather than pulling in a ZIP library to read one file out of one format.
  function docxText(file) {
    return file.arrayBuffer().then(function (ab) {
      var buf = new Uint8Array(ab);
      var dv = new DataView(ab);

      // End of central directory: scan back from the tail for its signature.
      var eocd = -1;
      var floor = Math.max(0, buf.length - 66000);
      for (var i = buf.length - 22; i >= floor; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error("That file is not a readable .docx.");

      var count = dv.getUint16(eocd + 10, true);
      var off = dv.getUint32(eocd + 16, true);
      var dec = new TextDecoder();
      var entry = null;

      for (var n = 0; n < count && off + 46 <= buf.length; n++) {
        var nameLen = dv.getUint16(off + 28, true);
        var extraLen = dv.getUint16(off + 30, true);
        var cmtLen = dv.getUint16(off + 32, true);
        var name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
        if (name === "word/document.xml") {
          entry = {
            method: dv.getUint16(off + 10, true),
            compSize: dv.getUint32(off + 20, true),
            localOff: dv.getUint32(off + 42, true)
          };
          break;
        }
        off += 46 + nameLen + extraLen + cmtLen;
      }
      if (!entry) throw new Error("No document body found inside that .docx.");

      // The local header repeats the name and extra fields at its own lengths,
      // which are not always the same as the central directory's.
      var lo = entry.localOff;
      var start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      var raw = buf.subarray(start, start + entry.compSize);

      if (entry.method === 0) return Promise.resolve(raw);   // stored
      if (entry.method === 8) return inflateRaw(raw);        // deflate
      throw new Error("That .docx uses a compression method this reader does not support.");
    }).then(function (xmlBytes) {
      return docxXmlToText(new TextDecoder("utf-8").decode(xmlBytes));
    });
  }

  function docxXmlToText(xml) {
    return xml
      .replace(/<w:tab[^>]*>/g, " ")
      .replace(/<w:br[^>]*>/g, "\n")
      .replace(/<\/w:p>/g, "\n\n")
      .replace(/<[^>]+>/g, "")
      // &amp; is unescaped last, or "&amp;lt;" would decode twice.
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // pdf.js is the one external dependency on the site, and it is fetched only
  // when somebody actually drops a PDF. Nothing is sent to the CDN but the
  // request for the library itself.
  var pdfLib = null;
  function loadPdfLib() {
    if (pdfLib) return pdfLib;
    var base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    pdfLib = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = base + "pdf.min.js";
      s.onload = function () {
        if (!window.pdfjsLib) {
          reject(new Error("The PDF reader did not load. Paste the text instead."));
          return;
        }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = function () {
        reject(new Error("Could not load the PDF reader. Paste the text instead."));
      };
      document.head.appendChild(s);
    });
    return pdfLib;
  }

  function pdfText(file) {
    return loadPdfLib().then(function (lib) {
      return file.arrayBuffer().then(function (ab) {
        return lib.getDocument({
          data: new Uint8Array(ab),
          isEvalSupported: false,
          disableFontFace: true
        }).promise;
      });
    }).then(function (doc) {
      var pages = Math.min(doc.numPages, 40);
      var chain = Promise.resolve([]);
      for (var p = 1; p <= pages; p++) {
        chain = chain.then(function (acc) {
          return doc.getPage(acc.length + 1)
            .then(function (pg) { return pg.getTextContent(); })
            .then(function (tc) {
              acc.push(tc.items.map(function (it) { return it.str; }).join(" "));
              return acc;
            });
        });
      }
      return chain.then(function (acc) {
        var text = acc.join("\n\n").replace(/[ \t]{2,}/g, " ").trim();
        // A scanned page has no text layer. Say so, rather than scoring an
        // empty string and reporting a number that means nothing.
        if (words(text).length < 30) {
          throw new Error("That PDF has no selectable text — it looks like a scan "
            + "or an image export. Send the original file, or paste the text.");
        }
        return text;
      });
    });
  }

  function extractText(file) {
    var name = (file.name || "").toLowerCase();

    if (/\.(txt|md|markdown|csv)$/.test(name) || /^text\//.test(file.type)) {
      return file.text();
    }
    if (name.slice(-5) === ".docx") return docxText(file);
    if (name.slice(-4) === ".pdf") return pdfText(file);
    if (name.slice(-4) === ".doc") {
      return Promise.reject(new Error(
        "Old .doc files are not readable in a browser. Save as .docx or PDF first."));
    }
    return Promise.reject(new Error(
      "I can read .pdf, .docx, .txt and .md. Paste the text for anything else."));
  }

  /* ------------------------------------------------------------------------
     Wiring
     ---------------------------------------------------------------------- */

  var form = document.getElementById("auditForm");
  if (!form) return;

  var input = document.getElementById("auditInput");
  var results = document.getElementById("auditResults");
  var error = document.getElementById("auditError");
  var counter = document.getElementById("auditCount");

  function updateCount() {
    var n = words(input.value).length;
    counter.textContent = n + (n === 1 ? " word" : " words");
    counter.setAttribute("data-ready", String(n >= 30));
  }

  input.addEventListener("input", updateCount);
  updateCount();

  function setStatus(message, state) {
    error.textContent = message;
    if (state) {
      error.setAttribute("data-state", state);
    } else {
      error.removeAttribute("data-state");
    }
  }

  function runAudit(text) {
    var result = analyse(text);

    if (!result) {
      setStatus("I need at least 30 words across two or more sentences — "
        + "below that the readability formulas are not reliable.", "error");
      results.hidden = true;
      return;
    }

    setStatus("");

    renderScore(result);
    renderTiles(result);
    renderHistogram(result);
    renderBars(result);
    renderFindings(result);
    renderTable(result);

    results.hidden = false;
    results.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto" : "smooth",
      block: "start"
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    runAudit(input.value);
  });

  /* --- File intake -------------------------------------------------------
     The file is read into the textarea first, so the visitor can see exactly
     what was extracted and edit it before or after scoring. A parser that
     silently feeds an invisible string into a score is not auditable. */

  var drop = document.getElementById("auditDrop");
  var fileInput = document.getElementById("auditFile");

  if (drop && fileInput) {
    var handleFile = function (file) {
      if (!file) return;

      setStatus("Reading " + file.name + "…", "busy");

      extractText(file).then(function (text) {
        // 60k characters is far beyond anything worth auditing as one message,
        // and keeps a 300-page PDF from locking up the main thread.
        input.value = text.slice(0, 60000);
        updateCount();
        runAudit(input.value);
        if (!results.hidden) {
          setStatus("Read " + file.name + " in your browser. Nothing was uploaded.",
            "success");
        }
      }).catch(function (err) {
        setStatus(err && err.message ? err.message : "I could not read that file.",
          "error");
      });
    };

    fileInput.addEventListener("change", function () {
      handleFile(fileInput.files && fileInput.files[0]);
      // Cleared so choosing the same file twice still fires a change event.
      fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        drop.classList.add("is-over");
      });
    });
    ["dragleave", "dragend", "drop"].forEach(function (evt) {
      drop.addEventListener(evt, function () { drop.classList.remove("is-over"); });
    });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  // Sample text, so the tool is explorable without pasting anything private.
  var sampleBtn = document.getElementById("auditSample");
  if (sampleBtn) {
    sampleBtn.addEventListener("click", function () {
      input.value = "Our innovative, best-in-class platform is designed to empower "
        + "organisations to unlock transformative value through a holistic and "
        + "scalable ecosystem of solutions. We believe that by leveraging "
        + "cutting-edge technology and a robust methodology, meaningful improvements "
        + "in operational efficiency and stakeholder engagement can generally be "
        + "achieved. Our mission is to seamlessly deliver actionable insights that "
        + "drive impactful outcomes for our partners. The implementation of our "
        + "solution aims to facilitate the optimisation of communication processes "
        + "across the entire organisation.";
      updateCount();
      input.focus();
    });
  }

  // Table view is off by default but always available — a chart nobody can
  // read the numbers off is not evidence.
  var tableToggle = document.getElementById("tableToggle");
  if (tableToggle) {
    tableToggle.addEventListener("click", function () {
      var host = document.getElementById("tableHost");
      var open = host.hidden;
      host.hidden = !open;
      tableToggle.setAttribute("aria-expanded", String(open));
      tableToggle.textContent = open ? "Hide the numbers" : "View as a table";
    });
  }
})();
