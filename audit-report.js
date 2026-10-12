/* ==========================================================================
   SpeakPower Studio — the website audit's report

   The Worker reads a whole site in short stages (start, crawl, Lighthouse,
   the strategic read). This file drives those stages from the page, shows
   where the audit is, and draws the finished report in SpeakPower's
   Midnight & Gold: a cover with the score, the strategic read, the findings
   by area, the pages, the private areas, Google's numbers, the method.

   The same report downloads as a branded Word file (built here, through
   SPExport) or as a PDF of exactly what is on screen.

   Security: every value from the Worker is set with textContent, and the
   only style written from data is a bar's width, clamped to 0–100.
   ========================================================================== */

(function () {
  "use strict";

  var A = window.SPAccount;
  var CONTACT = { phone: "+256 743 482 588", tel: "tel:+256743482588", whatsapp: "https://wa.me/256743482588", email: "thomasotieno583@gmail.com" };

  /* ------------------------------------------------------------ helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function longDate(sec) {
    var d = sec ? new Date(sec * 1000) : new Date();
    try { return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
    catch (e) { return d.toISOString().slice(0, 10); }
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var LEVEL = { fail: "Fix", warn: "Review", pass: "Correct" };
  var VERDICT = {
    protected: "Protected", exposed: "Open to anyone", "open-hidden": "Opens, hidden from search",
    "signin-indexable": "Sign-in page in search", redirects: "Redirects", missing: "Not found", error: "Error", unreachable: "No answer"
  };
  var STAGE_TEXT = { pending: "Waiting", running: "Working…", done: "Done", retry: "Not this time", unavailable: "Not available" };

  /* ----------------------------------------------------- driving stages */

  // One stage call, tried again on a dropped connection or a server hiccup.
  function step(id, stage) {
    var tries = 0;
    function attempt() {
      return A.call("/studio/audit/run", { id: id, stage: stage }).then(null, function (e) {
        var transient = !e.status || e.status >= 500;
        if (transient && ++tries < 3) return wait(2000 * tries).then(attempt);
        throw e;
      });
    }
    return attempt();
  }

  function fetchReport(id) { return A.call("/studio/audit?id=" + encodeURIComponent(id)); }

  // Runs whatever is left of an audit, reporting progress, and resolves with
  // { audit, report } once the report is complete.
  function drive(progress, onProgress) {
    var id = progress.id;
    onProgress(progress);
    function crawl(p) {
      if (p.state === "done") return Promise.resolve(p);
      return step(id, "crawl").then(function (d) { onProgress(d.audit); return crawl(d.audit); });
    }
    function finish(p) {
      var jobs = [];
      ["lighthouse", "strategy"].forEach(function (stage) {
        if (p[stage] === "pending") {
          var shown = Object.assign({}, p);
          shown[stage] = "running";
          onProgress(shown);
          p = shown;
          jobs.push(step(id, stage).then(function (d) { onProgress(d.audit); }, function () { /* the report says what is missing */ }));
        }
      });
      return Promise.all(jobs).then(function () { return settle(0); });
    }
    // Another tab may be running a stage: wait for it, then read the report.
    function settle(n) {
      return fetchReport(id).then(function (d) {
        onProgress(d.audit);
        var busy = d.audit.lighthouse === "running" || d.audit.strategy === "running";
        if (busy && n < 40) return wait(5000).then(function () { return settle(n + 1); });
        return d;
      });
    }
    return crawl(progress).then(finish);
  }

  // One more try at Lighthouse or the strategic read, from the report.
  function retry(id, stage) {
    return step(id, stage).then(function () { return fetchReport(id); });
  }

  /* ----------------------------------------------------------- progress */

  function renderProgress(host, p) {
    host.textContent = "";
    var box = el("div", "ar-progress");
    box.appendChild(el("p", "ar-progress-title", "Auditing " + (p.host || "your site")));
    var list = el("ol", "ar-steps");
    var crawled = p.state === "done";
    var rows = [
      ["Home page and site files read", "done"],
      [p.state === "pages" ? "Reading pages · " + p.pagesRead + " of " + p.pagesPlanned : "Pages read · " + p.pagesRead,
        p.state === "pages" ? "running" : "done"],
      ["Checking links" + (p.linksToCheck ? " · " + p.linksToCheck : ""), p.state === "links" ? "running" : p.state === "pages" ? "pending" : "done"],
      ["Checking private areas" + (p.privateToCheck ? " · " + p.privateToCheck : ""), p.state === "private" ? "running" : crawled ? "done" : "pending"],
      ["Google Lighthouse (up to 2 minutes)", crawled ? p.lighthouse : "pending"],
      ["Writing the strategic read", crawled ? p.strategy : "pending"]
    ];
    rows.forEach(function (r) {
      var li = el("li", "ar-step ar-step--" + r[1]);
      li.appendChild(el("span", "ar-step-name", r[0]));
      li.appendChild(el("span", "ar-step-state", STAGE_TEXT[r[1]] || r[1]));
      list.appendChild(li);
    });
    box.appendChild(list);
    box.appendChild(el("p", "ar-progress-note", "This takes one to three minutes. You can leave this page: the report is saved to your account."));
    host.appendChild(box);
  }

  /* ------------------------------------------------------------- report */

  function ring(score) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.setAttribute("class", "ar-ring");
    svg.setAttribute("aria-hidden", "true");
    var r = 52, c = 2 * Math.PI * r;
    [["ar-ring-track", c], ["ar-ring-value", c * (1 - pct(score) / 100)]].forEach(function (x, i) {
      var circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", "60"); circle.setAttribute("cy", "60"); circle.setAttribute("r", String(r));
      circle.setAttribute("class", x[0]);
      if (i === 1) {
        circle.setAttribute("stroke-dasharray", c.toFixed(1));
        circle.setAttribute("stroke-dashoffset", x[1].toFixed(1));
        circle.setAttribute("transform", "rotate(-90 60 60)");
      }
      svg.appendChild(circle);
    });
    return svg;
  }

  function bar(value, max) {
    var b = el("span", "ar-bar");
    var fill = el("i");
    fill.style.width = pct(100 * value / (max || 100)) + "%";
    b.appendChild(fill);
    return b;
  }

  function section(title, cls) {
    var s = el("section", "ar-section" + (cls ? " " + cls : ""));
    s.appendChild(el("h3", "ar-h", title));
    return s;
  }

  function table(head, rows, cls) {
    var wrap = el("div", "ar-table-wrap");
    var t = el("table", "ar-table" + (cls ? " " + cls : ""));
    var tr = t.createTHead().insertRow();
    head.forEach(function (h) { var th = el("th", null, h); th.scope = "col"; tr.appendChild(th); });
    var body = t.createTBody();
    rows.forEach(function (r) {
      var row = body.insertRow();
      r.forEach(function (c) {
        var td = row.insertCell();
        if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? "" : String(c);
      });
    });
    wrap.appendChild(t);
    return wrap;
  }

  function chip(level) { return el("span", "ar-chip ar-chip--" + level, LEVEL[level]); }

  function retryButton(text, stage, opts) {
    var b = el("button", "btn btn-ghost ar-retry", text);
    b.type = "button";
    b.setAttribute("data-no-print", "");
    b.addEventListener("click", function () {
      b.disabled = true;
      b.textContent = "Working… (this can take two minutes)";
      opts.onRetry(stage);
    });
    return b;
  }

  function render(report, host, opts) {
    opts = opts || {};
    var progress = opts.progress || {};
    host.textContent = "";
    var art = el("article", "audit-report");
    art.id = "auditReport";

    /* Cover */
    var cover = el("header", "ar-cover");
    var brand = el("div", "ar-brand");
    var logo = el("img", "ar-logo");
    logo.src = "assets/logo-mark.png"; logo.alt = ""; logo.width = 44; logo.height = 44;
    brand.appendChild(logo);
    brand.appendChild(el("span", null, "SpeakPower Studio"));
    cover.appendChild(brand);
    var head = el("div", "ar-cover-grid");
    var words = el("div", "ar-cover-words");
    words.appendChild(el("p", "ar-kicker", "Website SEO & Visibility Audit"));
    words.appendChild(el("h2", "ar-site", report.host));
    if (report.preparedFor) words.appendChild(el("p", "ar-meta", "Prepared for " + report.preparedFor));
    words.appendChild(el("p", "ar-meta", longDate(report.createdAt) + " · " + plural(report.pagesRead, "page") + " read" +
      (report.pagesFound > report.pagesRead ? " of about " + report.pagesFound + " found" : "")));
    head.appendChild(words);
    var score = el("div", "ar-score");
    score.appendChild(ring(report.overall));
    var num = el("div", "ar-score-num");
    num.appendChild(el("strong", null, String(report.overall)));
    num.appendChild(el("span", null, "/ 100"));
    num.appendChild(el("em", null, report.grade));
    score.appendChild(num);
    score.setAttribute("role", "img");
    score.setAttribute("aria-label", "Overall score " + report.overall + " out of 100: " + report.grade);
    head.appendChild(score);
    cover.appendChild(head);
    art.appendChild(cover);

    /* Category scores */
    var cats = section("Scores by area", "ar-cats-section");
    var grid = el("div", "ar-cats");
    report.categories.forEach(function (c) {
      var item = el("div", "ar-cat");
      var top = el("div", "ar-cat-top");
      top.appendChild(el("span", "ar-cat-name", c.name));
      top.appendChild(el("span", "ar-cat-score", c.score === null ? "—" : String(c.score)));
      item.appendChild(top);
      item.appendChild(bar(c.score === null ? 0 : c.score, 100));
      item.appendChild(el("span", "ar-cat-counts", c.score === null ? "Nothing to check" :
        [c.fails ? c.fails + " to fix" : "", c.warns ? c.warns + " to review" : "", c.passes + " correct"].filter(Boolean).join(" · ")));
      grid.appendChild(item);
    });
    cats.appendChild(grid);
    art.appendChild(cats);

    /* Strategic read */
    var st = report.strategy;
    var read = section("Strategic read", "ar-strategy");
    if (st) {
      read.appendChild(el("p", "ar-lede", st.summary));
      if (st.firstImpression) {
        read.appendChild(el("h4", "ar-h4", "The first five seconds"));
        read.appendChild(el("p", null, st.firstImpression));
      }
      if (st.clarity && st.clarity.length) {
        read.appendChild(el("h4", "ar-h4", "Message clarity"));
        var cl = el("div", "ar-clarity");
        st.clarity.forEach(function (c) {
          var row = el("div", "ar-clarity-row");
          var t = el("div", "ar-cat-top");
          t.appendChild(el("span", "ar-cat-name", c.dimension));
          t.appendChild(el("span", "ar-cat-score", c.score + " / 5"));
          row.appendChild(t);
          row.appendChild(bar(c.score, 5));
          row.appendChild(el("p", "ar-note", c.note));
          cl.appendChild(row);
        });
        read.appendChild(cl);
      }
      if (st.priorities && st.priorities.length) {
        read.appendChild(el("h4", "ar-h4", "The five priorities"));
        read.appendChild(table(["#", "Action", "Why", "Impact", "Effort", "Where"],
          st.priorities.map(function (p, i) { return [String(i + 1), p.action, p.why, p.impact, p.effort, p.where]; }), "ar-priorities"));
      }
      if (st.plan) {
        read.appendChild(el("h4", "ar-h4", "30-60-90 day plan"));
        var plan = el("div", "ar-plan");
        [["First 30 days", st.plan.days30], ["Days 31–60", st.plan.days60], ["Days 61–90", st.plan.days90]].forEach(function (x) {
          var col = el("div", "ar-plan-col");
          col.appendChild(el("p", "ar-plan-head", x[0]));
          var ul = el("ul");
          (x[1] || []).forEach(function (a) { ul.appendChild(el("li", null, a)); });
          col.appendChild(ul);
          plan.appendChild(col);
        });
        read.appendChild(plan);
      }
    } else {
      read.appendChild(el("p", "ar-note", report.strategyNote || "The strategic read is being written."));
      if (progress.strategy === "retry" && opts.onRetry) read.appendChild(retryButton("Write the strategic read", "strategy", opts));
    }
    art.appendChild(read);

    /* Findings by area */
    var found = section("Findings by area", "ar-findings");
    report.categories.forEach(function (c) {
      var mine = report.checks.filter(function (x) { return x.cat === c.key; });
      if (!mine.length) return;
      var group = el("div", "ar-group");
      group.appendChild(el("h4", "ar-h4", c.name + (c.score === null ? "" : " · " + c.score + " / 100")));
      var open = mine.filter(function (x) { return x.level !== "pass"; });
      var right = mine.filter(function (x) { return x.level === "pass"; });
      var ul = el("ul", "ar-checks");
      open.forEach(function (x) { ul.appendChild(checkItem(x)); });
      group.appendChild(ul);
      if (right.length) {
        var det = el("details", "ar-right");
        det.appendChild(el("summary", null, plural(right.length, "check") + " already correct"));
        var ok = el("ul", "ar-checks");
        right.forEach(function (x) { ok.appendChild(checkItem(x)); });
        det.appendChild(ok);
        group.appendChild(det);
      }
      found.appendChild(group);
    });
    art.appendChild(found);

    /* Pages */
    var pages = section("Pages read", "ar-pages");
    pages.appendChild(table(["Page", "Status", "Title", "Description", "H1", "Words", "Issues"], report.pages.map(function (p) {
      if (!p.ok) return [p.path + (p.extra ? " (listed)" : ""), p.status ? "HTTP " + p.status : "No answer", p.error, "", "", "", "—"];
      return [p.path + (p.extra ? " (listed)" : "") + (p.blocked ? " (robots.txt asks crawlers to skip it)" : ""), String(p.status),
        p.title ? p.title + " (" + p.titleLength + ")" : "Missing", p.description ? p.descriptionLength + " characters" : "Missing",
        p.h1 === 1 ? (p.h1Text || "1") : p.h1 ? p.h1 + " H1s" : "Missing", String(p.words),
        p.issues ? p.fails.concat(p.warns).join(", ") : "None"];
    }), "ar-pages-table"));
    art.appendChild(pages);

    /* Private areas and broken links */
    if (report.privateAreas.length || report.brokenLinks.length || report.robots.disallow.length) {
      var priv = section("Private areas and links", "ar-private");
      if (report.privateAreas.length) {
        priv.appendChild(table(["Address", "Result", "What a visitor gets"], report.privateAreas.map(function (x) {
          return [x.path + (x.listed ? " (listed)" : ""), VERDICT[x.verdict] || x.verdict, x.detail];
        })));
      } else {
        priv.appendChild(el("p", "ar-note", "No sign-in, account, admin or checkout areas are linked from the pages read."));
      }
      if (report.robots.disallow.length) {
        priv.appendChild(el("p", "ar-note", "robots.txt asks crawlers to skip: " + report.robots.disallow.join(", ") +
          ". That keeps them from reading those pages, but a linked page can still appear in search as a bare address."));
      }
      if (report.brokenLinks.length) {
        priv.appendChild(el("h4", "ar-h4", "Broken links"));
        var bl = el("ul", "ar-list");
        report.brokenLinks.forEach(function (l) {
          bl.appendChild(el("li", null, l.path + " (" + (l.status ? "HTTP " + l.status : "no answer") + "), linked from " + l.from.join(", ")));
        });
        priv.appendChild(bl);
      }
      art.appendChild(priv);
    }

    /* Google */
    var lh = report.lighthouse;
    var g = section("Google Lighthouse and real visitors", "ar-google");
    if (lh && lh.ok) {
      var scores = el("div", "ar-lh-scores");
      lh.scores.forEach(function (s) {
        var box = el("div", "ar-lh");
        box.appendChild(el("strong", null, String(s[1])));
        box.appendChild(el("span", null, s[0] === "Seo" ? "SEO" : s[0]));
        scores.appendChild(box);
      });
      g.appendChild(scores);
      g.appendChild(el("p", "ar-note", "Google's lab test of the home page on a mid-range phone, out of 100."));
      if (lh.failures && lh.failures.length) {
        g.appendChild(el("h4", "ar-h4", "What Lighthouse flagged"));
        var lf = el("ul", "ar-list");
        lh.failures.forEach(function (f) { lf.appendChild(el("li", null, f.title + (f.display ? " — " + f.display : ""))); });
        g.appendChild(lf);
      }
    } else {
      g.appendChild(el("p", "ar-note", lh ? lh.reason : "Google Lighthouse runs after the crawl."));
      if (progress.lighthouse === "retry" && opts.onRetry) g.appendChild(retryButton("Try Google Lighthouse again", "lighthouse", opts));
    }
    if (lh && lh.field) {
      g.appendChild(el("h4", "ar-h4", "Real visitors (Chrome, last 28 days)"));
      g.appendChild(table(["Measure", "75% of visits", "Rating"], lh.field.metrics.map(function (m) { return [m.name, m.value, m.rating]; })));
    } else if (lh && lh.ok) {
      g.appendChild(el("p", "ar-note", "Not enough real-visitor data from Chrome for this site yet; the lab scores stand in for it."));
    }
    art.appendChild(g);

    /* Method */
    var method = section("How this audit works", "ar-method");
    method.appendChild(el("p", null, report.scope));
    method.appendChild(el("p", null, report.scoring));
    method.appendChild(el("p", null, plural(report.pagesRead, "page") + " read" +
      (report.pagesFound > report.pagesRead ? " of about " + report.pagesFound + " found (an audit reads up to 25)" : "") +
      (report.extras ? "; " + plural(report.extras, "extra page") + " you listed" : "") +
      "; " + plural(report.linksChecked, "further link") + " checked."));
    art.appendChild(method);

    /* Contact */
    var foot = el("footer", "ar-contact");
    var who = el("div");
    who.appendChild(el("strong", null, "SpeakPower"));
    who.appendChild(el("span", null, "Strategic communication, brand intelligence and digital execution · Kampala"));
    foot.appendChild(who);
    var reach = el("p", "ar-reach");
    [[CONTACT.phone, CONTACT.tel], ["WhatsApp", CONTACT.whatsapp], [CONTACT.email, "mailto:" + CONTACT.email]].forEach(function (x, i) {
      if (i) reach.appendChild(document.createTextNode(" · "));
      var a = el("a", null, x[0]);
      a.href = x[1];
      if (/^https/.test(x[1])) { a.target = "_blank"; a.rel = "noopener"; }
      reach.appendChild(a);
    });
    foot.appendChild(reach);
    var cta = el("a", "btn btn-primary ar-cta", "Book a review call");
    cta.href = "contact.html?service=market-development";
    cta.setAttribute("data-no-print", "");
    foot.appendChild(cta);
    art.appendChild(foot);

    host.appendChild(art);
    return art;
  }

  function checkItem(x) {
    var li = el("li", "ar-check ar-check--" + x.level);
    li.appendChild(chip(x.level));
    var body = el("div", "ar-check-body");
    body.appendChild(el("strong", null, x.label));
    body.appendChild(el("p", null, x.detail));
    if (x.pages && x.pages.length) {
      var ul = el("ul", "ar-where");
      x.pages.forEach(function (p) { ul.appendChild(el("li", null, p)); });
      body.appendChild(ul);
    }
    li.appendChild(body);
    return li;
  }

  /* ------------------------------------------------- the Word document */

  function docOf(report) {
    var st = report.strategy;
    var sections = [{
      heading: "Scores by area",
      table: { head: ["Area", "Score", "To fix", "To review", "Correct"], rows: report.categories.map(function (c) {
        return [c.name, c.score === null ? "—" : String(c.score), String(c.fails), String(c.warns), String(c.passes)];
      }) }
    }];
    if (st) {
      var lines = [st.summary];
      if (st.firstImpression) lines.push("## The first five seconds", st.firstImpression);
      if (st.clarity && st.clarity.length) {
        lines.push("## Message clarity");
        st.clarity.forEach(function (c) { lines.push("- **" + c.dimension + ": " + c.score + " / 5.** " + c.note); });
      }
      sections.push({ heading: "Strategic read", lines: lines });
      sections.push({ heading: "The five priorities", table: { head: ["#", "Action", "Why", "Impact", "Effort", "Where"],
        rows: st.priorities.map(function (p, i) { return [String(i + 1), p.action, p.why, p.impact, p.effort, p.where]; }) } });
      if (st.plan) {
        var plan = [];
        [["First 30 days", st.plan.days30], ["Days 31–60", st.plan.days60], ["Days 61–90", st.plan.days90]].forEach(function (x) {
          plan.push("## " + x[0]);
          (x[1] || []).forEach(function (a) { plan.push("- " + a); });
        });
        sections.push({ heading: "30-60-90 day plan", lines: plan });
      }
    } else if (report.strategyNote) {
      sections.push({ heading: "Strategic read", lines: [report.strategyNote] });
    }
    report.categories.forEach(function (c) {
      var mine = report.checks.filter(function (x) { return x.cat === c.key; });
      if (!mine.length) return;
      var lines = [];
      mine.forEach(function (x) {
        lines.push("- **" + LEVEL[x.level] + ": " + x.label + ".** " + x.detail);
        if (x.pages && x.pages.length) lines.push("  Where: " + x.pages.join("; "));
      });
      sections.push({ heading: c.name + (c.score === null ? "" : " · " + c.score + " / 100"), lines: lines });
    });
    sections.push({ heading: "Pages read", table: { head: ["Page", "Status", "Title", "Description", "Words", "Issues"],
      rows: report.pages.map(function (p) {
        return p.ok ? [p.path, String(p.status), p.title ? p.title + " (" + p.titleLength + ")" : "Missing",
          p.description ? p.descriptionLength + " chars" : "Missing", String(p.words), p.issues ? p.fails.concat(p.warns).join(", ") : "None"]
          : [p.path, p.status ? "HTTP " + p.status : "No answer", p.error, "", "", ""];
      }) } });
    if (report.privateAreas.length) {
      sections.push({ heading: "Private areas", table: { head: ["Address", "Result", "What a visitor gets"],
        rows: report.privateAreas.map(function (x) { return [x.path, VERDICT[x.verdict] || x.verdict, x.detail]; }) } });
    }
    if (report.brokenLinks.length) {
      sections.push({ heading: "Broken links", lines: report.brokenLinks.map(function (l) {
        return "- " + l.path + " (" + (l.status ? "HTTP " + l.status : "no answer") + "), linked from " + l.from.join(", ");
      }) });
    }
    var lh = report.lighthouse;
    var g = [];
    if (lh && lh.ok) {
      g.push(lh.scores.map(function (s) { return (s[0] === "Seo" ? "SEO" : s[0]) + ": " + s[1] + " / 100"; }).join(" · "));
      (lh.failures || []).forEach(function (f) { g.push("- " + f.title + (f.display ? " — " + f.display : "")); });
    } else if (lh) {
      g.push(lh.reason);
    }
    if (lh && lh.field) {
      g.push("## Real visitors (Chrome, last 28 days)");
      lh.field.metrics.forEach(function (m) { g.push("- " + m.name + ": " + m.value + (m.rating ? " (" + m.rating + ")" : "")); });
    }
    if (g.length) sections.push({ heading: "Google Lighthouse and real visitors", lines: g });
    sections.push({ heading: "How this audit works", lines: [report.scope, report.scoring] });
    sections.push({ heading: "Next step", lines: ["Book a review call with SpeakPower: " + CONTACT.phone + " · WhatsApp wa.me/256743482588 · " + CONTACT.email] });

    return {
      title: "Website audit " + report.host,
      footer: "SpeakPower · " + CONTACT.phone + " · speakpower-commits.github.io/SpeakPower",
      logoUrl: "assets/logo-mark.png",
      cover: {
        kicker: "Website SEO & Visibility Audit",
        title: report.host,
        lines: [
          report.preparedFor ? "Prepared for " + report.preparedFor : "",
          longDate(report.createdAt),
          "Overall score: " + report.overall + " / 100 · " + report.grade,
          plural(report.pagesRead, "page") + " read" + (report.pagesFound > report.pagesRead ? " of about " + report.pagesFound + " found" : "")
        ].filter(Boolean)
      },
      sections: sections
    };
  }

  // "Download the report: Word · PDF".
  function downloads(report, article) {
    var wrap = el("span", "sp-download");
    wrap.appendChild(el("span", "sp-download-label", "Download the report:"));
    [["Word", "docx", function () { return window.SPExport.word(docOf(report)); }],
     ["PDF", "pdf", function () { window.SPExport.pdfNode(article, "website-audit-" + report.host); }]].forEach(function (x) {
      var b = el("button", "sp-download-btn sp-download-btn--" + x[1], x[0]);
      b.type = "button";
      b.addEventListener("click", x[2]);
      wrap.appendChild(b);
    });
    return wrap;
  }

  window.SPAudit = { drive: drive, retry: retry, fetchReport: fetchReport, renderProgress: renderProgress, render: render, docOf: docOf, downloads: downloads };
})();
