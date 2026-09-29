(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var key = params.get("product") || "brand-story";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("builderForm");
  var outputHost = $("outputHost");
  var downloadBtn = $("downloadBtn");
  var generateBtn = $("generateBtn");

  var PRODUCTS = {
    "brand-story": {
      title: "Brand Story Builder",
      price: "UGX 100,000",
      lead: "Turn what you do into a story people can understand, remember and repeat.",
      fields: [
        ["brand", "Brand / organisation name", "", "text"],
        ["offer", "What you offer", "Product, service, programme or expertise.", "textarea"],
        ["audience", "Who is it for?", "The people or organisations you most need to reach.", "text"],
        ["problem", "Problem you solve", "What is difficult, costly, confusing or frustrating for the audience?", "textarea"],
        ["result", "Result you create", "What becomes better after someone chooses you?", "textarea"],
        ["proof", "Proof", "Experience, results, partners, location, credentials, products, etc.", "textarea"],
        ["difference", "What makes you different?", "Your method, perspective, story, access or advantage.", "textarea"],
        ["ambition", "Where are you going?", "The future you are trying to create.", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Core story", v.brand + " exists to help " + v.audience + " move from " + lower(v.problem) + " to " + lower(v.result) + " through " + lower(v.offer) + "."],
          ["Positioning statement", v.brand + " helps " + v.audience + " achieve " + lower(v.result) + " by combining " + lower(v.offer) + " with " + lower(v.difference) + "."],
          ["30-second pitch", "We help " + v.audience + " who are dealing with " + lower(v.problem) + ". Through " + lower(v.offer) + ", we help them " + lower(v.result) + ". What makes us different is " + lower(v.difference) + ". Our experience includes " + lower(v.proof) + "."],
          ["2-minute story", v.brand + " was built around a simple observation: " + v.problem + ". We therefore focus on " + v.offer + " for " + v.audience + ". The goal is practical: " + v.result + ". We bring " + v.proof + ", and our distinctive approach is " + v.difference + ". We are building toward " + v.ambition + "."],
          ["Messaging pillar 1", "The problem: " + v.problem],
          ["Messaging pillar 2", "The value: " + v.result],
          ["Messaging pillar 3", "The difference: " + v.difference],
          ["Tagline directions", "Built for " + v.audience + ". | From " + v.problem + " to " + v.result + ". | " + titleCase(v.difference) + "."],
          ["Call to action", "Ready to " + lower(v.result) + "? Start with " + v.brand + "."]
        ];
      }
    },

    "seo-audit": {
      title: "Website SEO & Visibility Audit",
      price: "UGX 75,000",
      lead: "Enter a public website URL and let Google Lighthouse check search fundamentals, performance, accessibility and best practices.",
      fields: [
        ["url", "Website URL", "https://example.com", "url"]
      ],
      mode: "seo"
    },

    "market-plan": {
      title: "Market Development Planner",
      price: "UGX 125,000",
      lead: "Build a practical 30/60/90-day market-development starting point from your own business knowledge.",
      fields: [
        ["business", "Business / organisation", "", "text"],
        ["offer", "Main offer", "What are you trying to grow?", "textarea"],
        ["audience", "Target market", "Who should buy, use or support the offer?", "text"],
        ["geography", "Market / geography", "Kampala, Uganda, East Africa, a sector, etc.", "text"],
        ["problem", "Customer problem", "What real problem does the market have?", "textarea"],
        ["advantage", "Your advantage", "Why can you credibly compete?", "textarea"],
        ["competitors", "Alternatives / competitors", "Who else solves the problem or gets the customer's attention?", "textarea"],
        ["channels", "Current channels", "Website, SEO, LinkedIn, Facebook, referrals, events, partners, etc.", "textarea"],
        ["goal", "90-day goal", "What measurable result do you want?", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Market opportunity", v.business + " is positioned around " + v.offer + " for " + v.audience + " in " + v.geography + "."],
          ["Core market problem", v.problem],
          ["Positioning angle", "Lead with the specific outcome: " + v.goal + ". Support it with the advantage of " + v.advantage + "."],
          ["Competitive lens", "Map " + v.competitors + " against four questions: who they serve, what they promise, how they prove it and where their visibility is strongest."],
          ["Visibility priorities", "1. Strengthen the website story.\n2. Build search-focused content around real customer questions.\n3. Make the offer easy to understand on social and professional channels.\n4. Use partnerships and speaking opportunities to reach trusted audiences."],
          ["30 days", "Clarify the offer, audience and proof. Clean up core website and profile messaging. Establish 3 content themes tied to " + v.problem + "."],
          ["60 days", "Publish consistently, test calls to action, document customer questions and identify the channels producing qualified attention."],
          ["90 days", "Double down on the strongest channel, refine the offer using evidence and build a repeatable acquisition routine around the goal: " + v.goal + "."],
          ["Working KPI set", "Visibility: qualified visits. Engagement: enquiries / conversations. Conversion: offers accepted or next-step actions. Learning: recurring objections and customer questions."]
        ];
      }
    },

    "content-seo": {
      title: "SEO Content Starter",
      price: "UGX 75,000",
      lead: "Turn your expertise and customer questions into an SEO-informed content starter plan.",
      fields: [
        ["business", "Business / brand", "", "text"],
        ["offer", "What you sell", "", "textarea"],
        ["audience", "Audience", "", "text"],
        ["location", "Location / market", "Example: Kampala, Uganda", "text"],
        ["topic1", "Customer topic 1", "A question customers ask.", "text"],
        ["topic2", "Customer topic 2", "A second question or pain point.", "text"],
        ["topic3", "Customer topic 3", "A third question or pain point.", "text"],
        ["proof", "Proof", "One credible thing you can demonstrate regularly.", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Search themes", v.offer + " " + v.location + "\n" + v.topic1 + "\n" + v.topic2 + "\n" + v.topic3],
          ["Content opportunity 1", "Answer: " + v.topic1],
          ["Content opportunity 2", "Explain: " + v.topic2],
          ["Content opportunity 3", "Compare: " + v.topic3],
          ["Content opportunity 4", "How-to guide for " + v.audience + " interested in " + v.offer],
          ["Content opportunity 5", "Local / practical guide for " + v.location + " around " + v.offer],
          ["Content opportunity 6", "Common mistakes " + v.audience + " make before choosing " + v.offer],
          ["Content opportunity 7", "What good " + v.offer + " looks like, using proof: " + v.proof],
          ["Content opportunity 8", "FAQ: " + v.topic1],
          ["Content opportunity 9", "FAQ: " + v.topic2],
          ["Content opportunity 10", "FAQ: " + v.topic3],
          ["CTA bank", "Learn more. | Compare your options. | Request a quote. | Book a consultation. | Start with a quick assessment."],
          ["Publishing rhythm", "Week 1: question answer. Week 2: educational guide. Week 3: proof. Week 4: offer + CTA."]
        ];
      }
    },

    "data-story": {
      title: "Data Story Builder",
      price: "UGX 100,000",
      lead: "Upload a non-sensitive CSV and get a first-pass profile, patterns, gaps and plain-language story in your browser.",
      fields: [
        ["csv", "CSV dataset", "Choose a non-sensitive .csv file", "file"]
      ],
      mode: "data"
    },

    "speaker-ready": {
      title: "Speaker Ready Pack",
      price: "UGX 75,000",
      lead: "Go from topic to a rehearsable talk structure without starting from a blank page.",
      fields: [
        ["speaker", "Speaker name", "", "text"],
        ["topic", "Topic", "What are you speaking about?", "text"],
        ["audience", "Audience", "Who will be in the room?", "text"],
        ["time", "Speaking time", "10 minutes, 30 minutes, 1 hour...", "text"],
        ["goal", "Audience outcome", "What should people understand, feel or do?", "textarea"],
        ["idea1", "Key idea 1", "", "textarea"],
        ["idea2", "Key idea 2", "", "textarea"],
        ["idea3", "Key idea 3", "", "textarea"],
        ["story", "Story / proof", "A case, experience or example.", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Talk title", titleCase(v.topic) + ": What Your Audience Needs to Know"],
          ["Opening hook", "Most people think " + lower(v.topic) + " is mainly about information. The bigger question is what changes for " + v.audience + " when the idea becomes practical."],
          ["Audience promise", "By the end of this " + v.time + " session, the audience should " + lower(v.goal) + "."],
          ["Part 1 — The problem", v.idea1],
          ["Part 2 — The shift", v.idea2],
          ["Part 3 — The action", v.idea3],
          ["Story / proof", v.story],
          ["Transition 1", "Now that we have seen the problem, let's look at what needs to change."],
          ["Transition 2", "The important point is not only understanding this; it is deciding what to do with it."],
          ["Closing", "The challenge is simple: " + lower(v.goal) + ". Start with one action and make it visible."],
          ["Likely Q&A", "What is the biggest obstacle to applying this?\nWhat would you change first?\nCan you give a practical example?\nWhat happens when people disagree?"]
        ];
      }
    }
  };

  var product = PRODUCTS[key] || PRODUCTS["brand-story"];
  $("builderTitle").textContent = product.title;
  $("builderLead").textContent = product.lead;
  $("builderPrice").textContent = product.price;

  function renderForm() {
    form.innerHTML = "";
    product.fields.forEach(function (f) {
      var wrap = document.createElement("div");
      wrap.className = "builder-field";
      var label = document.createElement("label");
      label.htmlFor = "field-" + f[0];
      label.textContent = f[1];
      wrap.appendChild(label);

      if (f[3] === "textarea") {
        var ta = document.createElement("textarea");
        ta.id = "field-" + f[0]; ta.name = f[0]; ta.rows = 4;
        ta.placeholder = f[2] || ""; ta.required = true;
        wrap.appendChild(ta);
      } else if (f[3] === "file") {
        var fi = document.createElement("input");
        fi.type = "file"; fi.accept = ".csv,text/csv";
        fi.id = "field-" + f[0]; fi.name = f[0]; fi.required = true;
        wrap.appendChild(fi);
      } else if (f[3] === "url") {
        var url = document.createElement("input");
        url.type = "url"; url.id = "field-" + f[0]; url.name = f[0];
        url.placeholder = f[2] || ""; url.required = true;
        wrap.appendChild(url);
      } else {
        var input = document.createElement("input");
        input.type = "text"; input.id = "field-" + f[0]; input.name = f[0];
        input.placeholder = f[2] || ""; input.required = true;
        wrap.appendChild(input);
      }
      form.appendChild(wrap);
    });
  }

  function values() {
    var v = {};
    product.fields.forEach(function (f) {
      var el = form.elements[f[0]];
      v[f[0]] = el && el.type === "file" ? el.files[0] : String((el && el.value) || "").trim();
    });
    return v;
  }

  function lower(s) {
    s = String(s || "").trim();
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  }

  function titleCase(s) {
    return String(s || "").replace(/\w\S*/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[m];
    }).replace(/\n/g, "<br>");
  }

  function render(sections) {
    outputHost.innerHTML = sections.map(function (item) {
      return "<article class=\"output-block\"><h3>" + esc(item[0]) + "</h3><div>" + esc(item.slice(1).join("\n\n")) + "</div></article>";
    }).join("");
    $("outputTitle").textContent = product.title + " — generated";
    downloadBtn.disabled = false;
    window.__studioSections = sections;
  }

  function parseCSV(text) {
    var rows = [], row = [], cell = "", quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i], next = text[i + 1];
      if (quoted) {
        if (ch === '"' && next === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else {
        if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else if (ch !== "\r") cell += ch;
      }
    }
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  function numValue(x) {
    var s = String(x == null ? "" : x).trim().replace(/,/g, "");
    if (!s) return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function dataStory(file) {
    return file.text().then(function (text) {
      var rows = parseCSV(text);
      if (rows.length < 2) throw new Error("The CSV needs a header row and at least one data row.");
      var headers = rows[0].map(function (x, i) { return String(x || "").trim() || ("Column " + (i + 1)); });
      var data = rows.slice(1);
      var sections = [];
      sections.push(["Dataset profile", data.length + " data rows across " + headers.length + " columns."]);

      var numeric = [];
      var categorical = [];
      var missing = [];

      headers.forEach(function (h, idx) {
        var vals = data.map(function (r) { return r[idx] == null ? "" : r[idx]; });
        var nonempty = vals.filter(function (v) { return String(v).trim() !== ""; });
        var nums = nonempty.map(numValue).filter(function (v) { return v !== null; });
        var miss = vals.length - nonempty.length;
        missing.push([h, miss, vals.length ? miss / vals.length : 0]);
        if (nonempty.length && nums.length >= Math.max(3, nonempty.length * .7)) {
          var sum = nums.reduce(function (a,b){ return a+b; },0);
          var mean = sum / nums.length;
          var min = Math.min.apply(Math, nums), max = Math.max.apply(Math, nums);
          numeric.push([h, nums.length, mean, min, max]);
        } else {
          var counts = {};
          nonempty.forEach(function (v){ var k=String(v).trim(); counts[k]=(counts[k]||0)+1; });
          var top = Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];}).slice(0,5);
          categorical.push([h, nonempty.length, top.map(function(k){return k+" ("+counts[k]+")";}).join(", ")]);
        }
      });

      var missTop = missing.filter(function(x){return x[1]>0;}).sort(function(a,b){return b[2]-a[2];}).slice(0,5);
      sections.push(["Missing values", missTop.length ? missTop.map(function(x){return x[0]+": "+Math.round(x[2]*100)+"% missing";}).join("\n") : "No missing values found in the inspected columns."]);

      if (numeric.length) {
        sections.push(["Numeric summary", numeric.map(function(x){return x[0]+": mean "+x[2].toFixed(2)+" | min "+x[3].toFixed(2)+" | max "+x[4].toFixed(2);}).join("\n")]);
        var biggest = numeric.slice().sort(function(a,b){return (b[4]-b[3])-(a[4]-a[3]);})[0];
        if (biggest) sections.push(["Largest numeric range", biggest[0]+" spans from "+biggest[3].toFixed(2)+" to "+biggest[4].toFixed(2)+"."]);
      }

      if (categorical.length) {
        sections.push(["Category patterns", categorical.map(function(x){return x[0]+": "+x[2];}).join("\n")]);
      }

      var story = [];
      story.push("The dataset contains "+data.length+" observations and "+headers.length+" variables.");
      if (numeric.length) story.push("The strongest first-pass quantitative story is around "+numeric.map(function(x){return x[0];}).slice(0,4).join(", ")+".");
      if (categorical.length) story.push("The most useful segmentation fields appear to include "+categorical.map(function(x){return x[0];}).slice(0,4).join(", ")+".");
      if (missTop.length) story.push("Data quality needs attention in "+missTop[0][0]+" first because "+Math.round(missTop[0][2]*100)+"% of values are missing.");
      story.push("This is a descriptive first pass, not a causal conclusion. The next analysis should test the questions that matter to the decision behind the dataset.");
      sections.push(["Plain-language data story", story.join(" ")]);
      sections.push(["Next questions", "What changed most?\nWhich groups differ?\nWhich variables move together?\nWhat decision is this dataset supposed to support?"]);
      return sections;
    });
  }

  function seoAudit(url) {
    var endpoint = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=" +
      encodeURIComponent(url) + "&category=seo&category=performance&category=accessibility&category=best-practices";
    return fetch(endpoint).then(function (res) {
      if (!res.ok) throw new Error("Google PageSpeed could not analyse that URL right now.");
      return res.json();
    }).then(function (data) {
      var lh = data.lighthouseResult || {};
      var scores = lh.categories || {};
      var sections = [];
      ["seo","performance","accessibility","best-practices"].forEach(function (key) {
        if (scores[key] && typeof scores[key].score === "number") {
          sections.push([titleCase(key.replace("-", " ")), Math.round(scores[key].score * 100) + " / 100"]);
        }
      });

      var audits = lh.audits || {};
      var failures = Object.keys(audits).map(function (id) {
        var a = audits[id];
        if (!a || !a.title || a.scoreDisplayMode === "informative" || a.score === null) return null;
        return {id:id,title:a.title,score:a.score,display:a.displayValue||""};
      }).filter(Boolean).filter(function(a){return a.score < 1;}).sort(function(a,b){return a.score-b.score;}).slice(0,10);

      sections.push(["Top findings", failures.length ? failures.map(function(a){return a.title + (a.display ? " — "+a.display : "");}).join("\n") : "No failed Lighthouse audits were returned."]);
      sections.push(["What to fix first", "1. Address the highest-impact failed SEO checks.\n2. Improve pages with weak search intent alignment and unclear headings.\n3. Improve performance and accessibility issues that affect user experience.\n4. Re-run the audit after changes."]);
      sections.push(["Important note", "This is an automated technical audit based on the public URL. Search Console data, rankings, backlinks and conversion performance require access to the website's own data and are outside this automated check."]);
      return sections;
    });
  }

  function runProduct(v) {
    if (product.mode === "seo") return seoAudit(v.url);
    if (product.mode === "data") return dataStory(v.csv);
    return Promise.resolve(product.generate(v));
  }

  function download() {
    var sections = window.__studioSections || [];
    if (!sections.length) return;
    var body = sections.map(function (item) {
      return "<section><h2>" + esc(item[0]) + "</h2><p>" + esc(item.slice(1).join("\n\n")) + "</p></section>";
    }).join("");
    var html = "<!doctype html><html><head><meta charset='utf-8'><title>" + esc(product.title) + " — SpeakPower</title><style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;line-height:1.6;color:#182236}h1{font-size:28px}h2{margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:6px}section{page-break-inside:avoid}footer{margin-top:48px;font-size:13px;color:#777}</style></head><body><h1>" + esc(product.title) + "</h1>" + body + "<footer>Generated by SpeakPower Studio.</footer></body></html>";
    var blob = new Blob([html], {type:"text/html;charset=utf-8"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = product.title.toLowerCase().replace(/[^a-z0-9]+/g,"-") + "-speakpower.html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }

  generateBtn.addEventListener("click", function () {
    if (!form.reportValidity()) return;

    if (!window.SpeakPowerStudioAccess || !window.SpeakPowerStudioReady) {
      outputHost.innerHTML = "<p class='output-empty'>Studio access is still loading. Please try again in a moment.</p>";
      return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = "Checking access…";

    var runId = null;

    window.SpeakPowerStudioReady
      .then(function () {
        return window.SpeakPowerStudioAccess.reserveRun();
      })
      .then(function (access) {
        runId = access && access.run_id ? access.run_id : null;
        generateBtn.textContent = product.mode === "seo" ? "Auditing…" : "Generating…";
        return runProduct(values());
      })
      .then(function (sections) {
        render(sections);
        return window.SpeakPowerStudioAccess.finishRun(runId, "completed");
      })
      .then(function () {
        generateBtn.disabled = false;
        generateBtn.textContent = "Generate my pack";
        outputHost.scrollIntoView({behavior:"smooth",block:"start"});
      })
      .catch(function (err) {
        if (err && err.message === "payment_required") {
          generateBtn.disabled = false;
          generateBtn.textContent = "Generate my pack";
          return;
        }

        outputHost.innerHTML = "<p class='output-empty'>" + esc(err && err.message ? err.message : "The product could not generate a result.") + "</p>";
        if (window.SpeakPowerStudioAccess) {
          window.SpeakPowerStudioAccess.finishRun(runId, "failed").catch(function () {});
        }
        generateBtn.disabled = false;
        generateBtn.textContent = "Generate my pack";
      });
  });

  downloadBtn.addEventListener("click", download);
  renderForm();
})();
