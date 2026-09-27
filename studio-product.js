(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var key = params.get("product") || "whatsapp-sales-kit";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("builderForm");
  var outputHost = $("outputHost");
  var downloadBtn = $("downloadBtn");
  var generateBtn = $("generateBtn");

  var PRODUCTS = {
    "whatsapp-sales-kit": {
      title: "WhatsApp Sales Kit",
      price: "UGX 50,000",
      lead: "Turn common WhatsApp questions into consistent, ready-to-use sales responses.",
      fields: [
        ["business", "Business name", "What should customers call the business?", "text"],
        ["offer", "Main product or service", "What are you selling?", "text"],
        ["audience", "Main customer", "Who normally buys from you?", "text"],
        ["location", "Location / service area", "Where do you serve customers?", "text"],
        ["price", "Price or starting price", "What does it cost?", "text"],
        ["hours", "Opening hours / response time", "When are you available?", "text"],
        ["benefit", "Main customer benefit", "What practical result does the customer get?", "textarea"],
        ["proof", "Trust point", "One fact that builds confidence: years, reviews, guarantee, location, certification, etc.", "textarea"],
        ["cta", "Preferred action", "What should a customer do next?", "text"]
      ],
      generate: function (v) {
        return [
          ["Customer greeting", "Hello and welcome to " + v.business + ". Thanks for reaching out. We help " + v.audience + " with " + v.offer + ". How can we help you today?"],
          ["Offer response", "Our " + v.offer + " is available from " + v.price + ". The main benefit is " + v.benefit + ". We serve customers in " + v.location + ". " + v.cta + "."],
          ["Trust response", "A quick confidence point about " + v.business + ": " + v.proof + ". We are available " + v.hours + "."],
          ["Price response", "Thanks for asking about the price. " + v.offer + " starts at " + v.price + ". The right option depends on what you need. " + v.cta + "."],
          ["Follow-up 1", "Hi from " + v.business + ". Just checking whether you would still like help with " + v.offer + ". Reply here and we can take the next step."],
          ["Follow-up 2", "Quick follow-up from " + v.business + ". If you are still comparing options, I can help you choose the right " + v.offer + ". " + v.cta + "."],
          ["Follow-up 3", "Last follow-up for now from " + v.business + ". Whenever you are ready for " + v.offer + ", message us here. We serve " + v.location + "."],
          ["FAQ: What do I get?", "You get " + v.benefit + "."],
          ["FAQ: Where are you?", v.business + " serves customers in " + v.location + "."],
          ["FAQ: When are you available?", "We are available " + v.hours + "."]
        ];
      }
    },

    "offer-builder": {
      title: "Business Offer Builder",
      price: "UGX 75,000",
      lead: "Turn what you already sell into a clearer package a customer can understand in one glance.",
      fields: [
        ["business", "Business / brand name", "", "text"],
        ["service", "What you sell", "Describe the service or product.", "textarea"],
        ["audience", "Target customer", "Who is most likely to buy?", "text"],
        ["problem", "Customer problem", "What problem are they trying to solve?", "textarea"],
        ["result", "Desired result", "What changes after they buy?", "textarea"],
        ["proof", "Proof / credibility", "Experience, results, testimonials, location, partners, credentials, etc.", "textarea"],
        ["price", "Price", "What do you charge?", "text"],
        ["delivery", "How it is delivered", "Examples: WhatsApp, delivery, in-person, online session, 3-day turnaround.", "text"],
        ["difference", "Why you", "What makes this offer different or easier to choose?", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Offer name", titleCase(v.audience) + " " + titleCase(v.service.split(" ").slice(0, 3).join(" "))],
          ["One-line offer", v.business + " helps " + v.audience + " solve " + lower(v.problem) + " through " + lower(v.service) + ", so they can " + lower(v.result) + "."],
          ["Customer promise", "You get a clear path from " + v.problem + " to " + v.result + " without unnecessary complexity."],
          ["What's included", "Core service: " + v.service + ". Delivered through " + v.delivery + ". Price: " + v.price + "."],
          ["Why choose this", v.difference + ". Trust point: " + v.proof + "."],
          ["Sales CTA", "Ready to " + lower(v.result) + "? Contact " + v.business + " to get started at " + v.price + "."],
          ["Short promo", v.business + " | " + titleCase(v.audience) + " | " + titleCase(v.service) + " | " + v.price + ". " + v.difference + "."]
        ];
      }
    },

    "authority-pack": {
      title: "Personal Authority Pack",
      price: "UGX 100,000",
      lead: "Turn your experience into professional positioning you can paste into LinkedIn, speaker profiles and introductions.",
      fields: [
        ["name", "Your name", "", "text"],
        ["role", "Current role / title", "", "text"],
        ["expertise", "What you are known for", "Your strongest area of expertise.", "textarea"],
        ["audience", "Who you help", "Who benefits from your work?", "text"],
        ["proof", "Proof of experience", "Years, projects, organizations, achievements, credentials or notable work.", "textarea"],
        ["perspective", "Your point of view", "What do you believe should be done differently?", "textarea"],
        ["location", "Base / market", "City, country or region.", "text"],
        ["goal", "Main professional goal", "Examples: win clients, get speaking invitations, grow authority, attract partnerships.", "textarea"]
      ],
      generate: function (v) {
        return [
          ["LinkedIn headline — option 1", v.role + " | " + titleCase(v.expertise) + " | Helping " + v.audience],
          ["LinkedIn headline — option 2", v.expertise + " | " + v.role + " | " + v.location],
          ["Positioning statement", v.name + " is a " + lower(v.role) + " focused on " + lower(v.expertise) + ", helping " + v.audience + " achieve practical results through clear strategy and communication."],
          ["LinkedIn About", "I am " + v.name + ", a " + v.role + " focused on " + lower(v.expertise) + ".\n\nI work with " + v.audience + " and bring experience including " + lower(v.proof) + ".\n\nMy perspective is simple: " + v.perspective + "\n\nMy current goal is " + lower(v.goal) + "."],
          ["Short professional bio", v.name + " is a " + v.role + " specialising in " + lower(v.expertise) + ". Based in " + v.location + ", " + v.name + " works with " + v.audience + " and draws on experience including " + lower(v.proof) + "."],
          ["Speaker introduction", "Please welcome " + v.name + ", a " + v.role + " specialising in " + lower(v.expertise) + ". " + v.name + " works with " + v.audience + " and brings practical experience from " + lower(v.proof) + "."],
          ["Authority CTA", "For " + v.goal + ", connect with " + v.name + " about " + lower(v.expertise) + "."]
        ];
      }
    },

    "speaker-ready": {
      title: "Speaker Ready Pack",
      price: "UGX 75,000",
      lead: "Go from topic to a rehearsable talk structure without starting from a blank page.",
      fields: [
        ["speaker", "Speaker name", "", "text"],
        ["topic", "Topic", "What are you speaking about?", "text"],
        ["audience", "Audience", "Who will be in the room?", "text"],
        ["time", "Speaking time", "Examples: 10 minutes, 30 minutes, 1 hour.", "text"],
        ["goal", "Audience outcome", "What should they understand, feel or do afterwards?", "textarea"],
        ["idea1", "Key idea 1", "", "textarea"],
        ["idea2", "Key idea 2", "", "textarea"],
        ["idea3", "Key idea 3", "", "textarea"],
        ["story", "Personal example / proof", "A story, case, experience or example you can use.", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Talk title", titleCase(v.topic) + ": What Your Audience Needs to Know"],
          ["Opening hook", "Most people think " + lower(v.topic) + " is mainly about information. The real question is what changes for " + v.audience + " when they put the idea into practice."],
          ["Audience promise", "By the end of this " + v.time + " session, the audience should " + lower(v.goal) + "."],
          ["Part 1 — The problem", v.idea1],
          ["Part 2 — The shift", v.idea2],
          ["Part 3 — The action", v.idea3],
          ["Story / proof", v.story],
          ["Transition 1", "Now that we have seen the problem, let's look at what needs to change."],
          ["Transition 2", "The important point is not just understanding this; it is deciding what to do with it."],
          ["Closing", "So here is the challenge: " + lower(v.goal) + ". Start with one action, make it visible, and give it enough attention to become a habit."],
          ["Likely Q&A", "What is the biggest obstacle to applying this?", "What would you change first?", "Can you give a practical example?", "What happens when the team disagrees?"]
        ];
      }
    },

    "content-starter": {
      title: "Content Starter Pack",
      price: "UGX 50,000",
      lead: "Turn your business knowledge into a usable starter calendar instead of staring at a blank social post.",
      fields: [
        ["business", "Business / personal brand", "", "text"],
        ["offer", "What you sell", "", "textarea"],
        ["audience", "Audience", "", "text"],
        ["theme1", "Content theme 1", "Example: customer education", "text"],
        ["theme2", "Content theme 2", "Example: behind the scenes", "text"],
        ["theme3", "Content theme 3", "Example: proof / results", "text"],
        ["proof", "Proof / credibility", "One thing you can regularly demonstrate.", "textarea"]
      ],
      generate: function (v) {
        var angles = [
          "The mistake " + v.audience + " should stop making",
          "What nobody tells " + v.audience + " about " + v.offer,
          "3 practical ways to improve " + v.theme1,
          "Behind the scenes: how " + v.business + " handles " + v.theme2,
          "A simple explanation of " + v.theme1,
          "A customer question we hear about " + v.offer,
          "What good " + v.theme3 + " actually looks like",
          "One lesson " + v.business + " has learned",
          "Before you buy " + v.offer + ", check these things",
          "A myth about " + v.theme2 + " worth correcting"
        ];
        var posts = [
          "Here is a simple point for " + v.audience + ": " + v.offer + " is not only about the product. It is about the outcome. At " + v.business + ", we focus on " + v.proof + ".",
          "A common mistake is treating " + v.theme1 + " as complicated. Start with one practical step, measure it, then improve it.",
          "Behind every useful service is a repeatable process. At " + v.business + ", one area we pay attention to is " + v.theme2 + ".",
          "Before choosing " + v.offer + ", ask: What problem does this actually solve? What result should I expect? What evidence supports it?",
          "The best content teaches something before it sells something. This week, we are sharing what we know about " + v.theme3 + "."
        ];
        return [
          ["10 content angles", angles.join("\n\n")],
          ["Ready-to-edit post 1", posts[0]],
          ["Ready-to-edit post 2", posts[1]],
          ["Ready-to-edit post 3", posts[2]],
          ["Ready-to-edit post 4", posts[3]],
          ["Ready-to-edit post 5", posts[4]],
          ["WhatsApp broadcast 1", "New from " + v.business + ": practical guidance for " + v.audience + " around " + v.offer + ". Reply here if you want details."],
          ["WhatsApp broadcast 2", "A useful reminder for " + v.audience + ": ask about the problem, the outcome and the evidence before choosing " + v.offer + "."],
          ["WhatsApp broadcast 3", v.business + " is sharing simple, practical ideas around " + v.theme1 + ", " + v.theme2 + " and " + v.theme3 + ". Follow for the next tip."],
          ["Weekly rhythm", "Mon — teach | Tue — proof | Wed — FAQ | Thu — behind the scenes | Fri — offer / CTA"]
        ];
      }
    },

    "ai-blueprint": {
      title: "AI Communication Blueprint",
      price: "UGX 150,000",
      lead: "Turn one repetitive communication task into a clear AI-assisted workflow your team can start implementing.",
      fields: [
        ["organization", "Organization / team", "", "text"],
        ["task", "Repeated task", "What do you keep doing manually?", "textarea"],
        ["input", "Typical input", "What information goes into the task?", "textarea"],
        ["output", "Desired output", "What should come out?", "textarea"],
        ["frequency", "Frequency", "Daily, weekly, monthly, per campaign, etc.", "text"],
        ["quality", "Quality rules", "What must never be missing or wrong?", "textarea"],
        ["tools", "Tools already used", "Examples: Google Drive, WhatsApp, Sheets, email, CRM.", "text"],
        ["risk", "Main risk", "What could go wrong if the AI gets it wrong?", "textarea"]
      ],
      generate: function (v) {
        return [
          ["Workflow objective", v.organization + " wants to reduce manual work around " + lower(v.task) + " while protecting quality."],
          ["Trigger", "Start when: " + v.frequency + " and a new " + v.input + " is available."],
          ["Step 1 — Input", "Collect: " + v.input],
          ["Step 2 — AI instruction", "Task the AI to produce: " + v.output + ". Context: " + v.task + "."],
          ["Step 3 — Quality control", "Check every output against: " + v.quality],
          ["Step 4 — Human exception", "Escalate when the risk is high or the output fails the quality rules: " + v.risk],
          ["Step 5 — Delivery", "Send or store the approved result using: " + v.tools],
          ["Prompt starter", "You are an assistant for " + v.organization + ". Your task is to " + lower(v.task) + ". Use this input: " + v.input + ". Produce this output: " + v.output + ". Never violate these quality rules: " + v.quality + ". If the information is insufficient or risky, flag it instead of inventing facts."],
          ["Implementation checklist", "1. Define the input source.\n2. Define the AI task.\n3. Store the prompt.\n4. Add quality checks.\n5. Add a human exception path.\n6. Connect the output to " + v.tools + "."]
        ];
      }
    }
  };

  var product = PRODUCTS[key] || PRODUCTS["whatsapp-sales-kit"];
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
        var el = document.createElement("textarea");
        el.id = "field-" + f[0];
        el.name = f[0];
        el.rows = 4;
        el.placeholder = f[2] || "";
        el.required = true;
        wrap.appendChild(el);
      } else {
        var el2 = document.createElement("input");
        el2.type = "text";
        el2.id = "field-" + f[0];
        el2.name = f[0];
        el2.placeholder = f[2] || "";
        el2.required = true;
        wrap.appendChild(el2);
      }
      form.appendChild(wrap);
    });
  }

  function values() {
    var v = {};
    product.fields.forEach(function (f) {
      v[f[0]] = String(form.elements[f[0]].value || "").trim();
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
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", """:"&quot;", "'":"&#39;" }[m];
    }).replace(/\n/g, "<br>");
  }

  function render(sections) {
    outputHost.innerHTML = sections.map(function (item) {
      var title = item[0];
      var body = item.slice(1).join("\n\n");
      return "<article class=\"output-block\"><h3>" + esc(title) + "</h3><div>" + esc(body) + "</div></article>";
    }).join("");
    $("outputTitle").textContent = product.title + " — generated";
    downloadBtn.disabled = false;
    window.__studioSections = sections;
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
    a.href = url;
    a.download = product.title.toLowerCase().replace(/[^a-z0-9]+/g,"-") + "-speakpower.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  generateBtn.addEventListener("click", function () {
    if (!form.reportValidity()) return;
    var v = values();
    render(product.generate(v));
  });

  downloadBtn.addEventListener("click", download);
  renderForm();
})();
